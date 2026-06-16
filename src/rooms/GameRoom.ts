import { Client, Room } from "@colyseus/core";
import {
  challengeSchema,
  catchOneSchema,
  emoteSchema,
  joinOptionsSchema,
  kickSchema,
  playCardSchema,
  playDrawnSchema,
  roomSettingsSchema,
  setAwaySchema
} from "@congcard/shared";
import { config } from "../config.js";
import {
  addPlayer,
  callOne,
  catchOne,
  createGame,
  drawCard,
  expireOneWindow,
  GameError,
  handleTurnTimeout,
  kickPlayer,
  playCard,
  playDrawn,
  removePlayer,
  resolveChallenge,
  resolveAutomatedTurns,
  resolvePendingOneCall,
  sendEmote,
  setPlayerConnected,
  setPlayerAway,
  setReady,
  snapshotFor,
  startRound,
  updateSettings,
  type GameStateInternal
} from "../engine/game.js";
import { unregisterRoom } from "./directory.js";

interface GameRoomOptions {
  code: string;
  settings?: unknown;
}

interface ClientRateBucket {
  count: number;
  resetAt: number;
}

const CLIENT_MESSAGE_WINDOW_MS = 10_000;
const CLIENT_MESSAGE_LIMIT = 80;

export class GameRoom extends Room {
  maxClients = 40;
  private game!: GameStateInternal;
  private readonly clientRateBuckets = new Map<string, ClientRateBucket>();

  onCreate(options: GameRoomOptions): void {
    const settings = roomSettingsSchema.partial().parse(options.settings ?? {});
    this.game = createGame(options.code, settings);
    this.maxClients = Math.max(40, this.game.settings.maxPlayers + 20);
    this.setPrivate(true);
    this.clock.setInterval(() => {
      try {
        const oneCallResolved = resolvePendingOneCall(this.game);
        const windowClosed = expireOneWindow(this.game);
        const autoPlayedBeforeTimeout = resolveAutomatedTurns(this.game);
        const timedOut = handleTurnTimeout(this.game);
        const autoPlayedAfterTimeout = resolveAutomatedTurns(this.game);
        if (oneCallResolved || windowClosed || autoPlayedBeforeTimeout || timedOut || autoPlayedAfterTimeout) {
          this.broadcastState();
        }
      } catch {
        // The ticker must never take the room down; the next tick retries.
      }
    }, 100);

    this.onMessage("room.ready", (client, message) => this.safe(client, () => {
      setReady(this.game, client.sessionId, Boolean(message?.ready ?? true));
      this.broadcastState();
    }));

    this.onMessage("room.updateSettings", (client, message) => this.safe(client, () => {
      const settingsUpdate = roomSettingsSchema.partial().parse(message ?? {});
      updateSettings(this.game, client.sessionId, settingsUpdate);
      this.maxClients = Math.max(40, this.game.settings.maxPlayers + 20);
      this.broadcastState();
    }));

    this.onMessage("room.setAway", (client, message) => this.safe(client, () => {
      const payload = setAwaySchema.parse(message ?? {});
      setPlayerAway(this.game, client.sessionId, payload.away);
      this.broadcastState();
    }));

    this.onMessage("room.kick", (client, message) => this.safe(client, () => {
      const payload = kickSchema.parse(message);
      kickPlayer(this.game, client.sessionId, payload.playerId);
      this.broadcastState();
    }));

    this.onMessage("game.start", (client) => this.safe(client, () => {
      const player = this.game.players.find((item) => item.id === client.sessionId);
      if (!player?.isHost) {
        throw new GameError("not_host", "Only the host can start the game.");
      }

      startRound(this.game);
      this.broadcastState();
    }));

    this.onMessage("game.playCard", (client, message) => this.safe(client, () => {
      const payload = playCardSchema.parse(message);
      playCard(this.game, client.sessionId, payload.cardId, payload.declaredColor);
      this.broadcastState();
    }));

    this.onMessage("game.drawCard", (client) => this.safe(client, () => {
      drawCard(this.game, client.sessionId);
      this.broadcastState();
    }));

    this.onMessage("game.playDrawn", (client, message) => this.safe(client, () => {
      const payload = playDrawnSchema.parse(message);
      playDrawn(this.game, client.sessionId, payload.play, payload.declaredColor);
      this.broadcastState();
    }));

    this.onMessage("game.callOne", (client) => this.safe(client, () => {
      callOne(this.game, client.sessionId);
      this.broadcastState();
    }));

    this.onMessage("game.catchOne", (client, message) => this.safe(client, () => {
      const payload = catchOneSchema.parse(message);
      catchOne(this.game, client.sessionId, payload.targetId);
      this.broadcastState();
    }));

    this.onMessage("game.challenge", (client, message) => this.safe(client, () => {
      const payload = challengeSchema.parse(message);
      resolveChallenge(this.game, client.sessionId, payload.accept);
      this.broadcastState();
    }));

    this.onMessage("chat.emote", (client, message) => this.safe(client, () => {
      const payload = emoteSchema.parse(message);
      sendEmote(this.game, client.sessionId, payload.emoteId);
      this.broadcastState();
    }));
  }

  onJoin(client: Client, options: unknown): void {
    const payload = joinOptionsSchema.parse(options);
    addPlayer(this.game, client.sessionId, payload.nickname, payload.avatarId, payload.resumeToken);
    this.broadcastState();
  }

  async onDrop(client: Client): Promise<void> {
    const participant =
      this.game.players.find((item) => item.id === client.sessionId) ??
      this.game.viewers.find((item) => item.id === client.sessionId);
    if (!participant) {
      return;
    }

    setPlayerConnected(this.game, client.sessionId, false);
    this.broadcastState();
    await this.allowReconnection(client, config.reconnectGraceSec);
  }

  onReconnect(client: Client): void {
    setPlayerConnected(this.game, client.sessionId, true);
    this.broadcastState();
  }

  onLeave(client: Client): void {
    this.clientRateBuckets.delete(client.sessionId);
    if (this.game.viewers.some((item) => item.id === client.sessionId)) {
      removePlayer(this.game, client.sessionId);
      this.broadcastState();
      return;
    }

    const player = this.game.players.find((item) => item.id === client.sessionId);
    if (player?.connected) {
      setPlayerConnected(this.game, client.sessionId, false);
      this.broadcastState();
    }
  }

  onDispose(): void {
    unregisterRoom(this.roomId);
  }

  private broadcastState(): void {
    for (const client of this.clients) {
      client.send("state", snapshotFor(this.game, client.sessionId));
    }
  }

  private safe(client: Client, handler: () => void): void {
    if (!this.allowClientMessage(client)) {
      client.send("error", {
        code: "rate_limited",
        message: "Too many actions. Slow down."
      });
      return;
    }

    try {
      handler();
    } catch (error) {
      const gameError = error instanceof GameError ? error : new GameError("invalid_action", "That action is not allowed.");
      client.send("error", {
        code: gameError.code,
        message: gameError.message
      });
      client.send("state", snapshotFor(this.game, client.sessionId));
    }
  }

  private allowClientMessage(client: Client): boolean {
    const now = Date.now();
    const bucket = this.clientRateBuckets.get(client.sessionId);

    if (!bucket || now >= bucket.resetAt) {
      this.clientRateBuckets.set(client.sessionId, { count: 1, resetAt: now + CLIENT_MESSAGE_WINDOW_MS });
      return true;
    }

    if (bucket.count >= CLIENT_MESSAGE_LIMIT) {
      return false;
    }

    bucket.count += 1;
    return true;
  }
}
