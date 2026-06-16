import { describe, expect, it } from "vitest";
import { joinOptionsSchema, roomCodeSchema } from "@congcard/shared";
import {
  addPlayer,
  createGame,
  kickPlayer,
  removePlayer,
  setReady,
  setPlayerConnected,
  snapshotFor,
  startRound,
  updateSettings
} from "../src/engine/game.js";

describe("room lifecycle", () => {
  it("supports settings, ready check, kick, and host migration", () => {
    const state = createGame("ROOM42");
    addPlayer(state, "host", "Host", "sun");
    addPlayer(state, "guest", "Guest", "moon");
    addPlayer(state, "third", "Third", "star");

    updateSettings(state, "host", { maxPlayers: 6, turnTimeoutSec: 45, scoreTarget: 500 });
    setReady(state, "guest", true);
    kickPlayer(state, "host", "third");
    removePlayer(state, "host");

    expect(state.settings.maxPlayers).toBe(6);
    expect(state.settings.turnTimeoutSec).toBe(45);
    expect(state.settings.scoreTarget).toBe(500);
    expect(state.players.some((player) => player.id === "third")).toBe(false);
    expect(state.players.find((player) => player.id === "guest")?.isHost).toBe(true);
  });

  it("preserves independent room toggles across incremental updates", () => {
    const state = createGame("ROOM44");
    addPlayer(state, "host", "Host", "sun");
    addPlayer(state, "guest", "Guest", "moon");

    updateSettings(state, "host", { jumpInEnabled: true });
    updateSettings(state, "host", { stackingEnabled: true });

    expect(state.settings.jumpInEnabled).toBe(true);
    expect(state.settings.stackingEnabled).toBe(true);
    expect(state.settings.challengeEnabled).toBe(true);
  });

  it("defaults One and Catch off for Last Stand and back on for normal scoring", () => {
    const state = createGame("ROOM45");
    addPlayer(state, "host", "Host", "sun");
    addPlayer(state, "guest", "Guest", "moon");

    updateSettings(state, "host", { scoreTarget: "lastStand" });
    expect(state.settings.scoreTarget).toBe("lastStand");
    expect(state.settings.callEnabled).toBe(false);

    updateSettings(state, "host", { scoreTarget: 0 });
    expect(state.settings.scoreTarget).toBe(0);
    expect(state.settings.callEnabled).toBe(true);
  });

  it("rejects invalid room codes and avatar ids at the protocol boundary", () => {
    expect(roomCodeSchema.parse("abc234")).toBe("ABC234");
    expect(() => roomCodeSchema.parse("ABC12!")).toThrow();
    expect(() => joinOptionsSchema.parse({ nickname: "Player", avatarId: "../../evil" })).toThrow();
  });

  it("reclaims a disconnected player with a durable resume token", () => {
    const state = createGame("ROOM42");
    addPlayer(state, "p1", "Ava", "sun");
    addPlayer(state, "p2", "Ben", "moon");
    state.phase = "playing";
    state.currentSeat = 0;
    state.oneWindow = { playerId: "p1", opensAt: Date.now() - 1, deadline: Date.now() + 1000 };
    state.pendingOneCall = { playerId: "p1", resolvesAt: Date.now() + 100 };
    state.pendingChallenge = { offenderId: "p1", challengerId: "p2", declaredColor: "blue", guilty: false };
    state.roundWinnerId = "p1";
    state.gameWinnerId = "p1";

    const resumeToken = state.players[0]!.resumeToken;
    setPlayerConnected(state, "p1", false);
    addPlayer(state, "fresh-session", "Ava", "star", resumeToken);

    expect(state.players.some((player) => player.id === "p1")).toBe(false);
    expect(state.players.find((player) => player.id === "fresh-session")?.connected).toBe(true);
    expect(state.pendingChallenge?.offenderId).toBe("fresh-session");
    expect(state.oneWindow?.playerId).toBe("fresh-session");
    expect(state.pendingOneCall?.playerId).toBe("fresh-session");
    expect(state.roundWinnerId).toBe("fresh-session");
    expect(state.gameWinnerId).toBe("fresh-session");
    expect(snapshotFor(state, "fresh-session").self?.resumeToken).toBe(resumeToken);
  });

  it("places invalid mid-game joins in waiting or spectator roles", () => {
    const waitingState = createGame("ROOM42");
    addPlayer(waitingState, "p1", "Ava", "sun");
    addPlayer(waitingState, "p2", "Ben", "moon");
    waitingState.phase = "playing";

    addPlayer(waitingState, "late", "Late", "bolt", "bad-token");
    expect(snapshotFor(waitingState, "late").self?.role).toBe("waiting");
    expect(waitingState.players.some((player) => player.id === "late")).toBe(false);
    expect(() => setReady(waitingState, "late", true)).toThrow("Player was not found");

    const spectatorState = createGame("ROOM43", { allowMidGameJoin: false });
    addPlayer(spectatorState, "p1", "Ava", "sun");
    addPlayer(spectatorState, "p2", "Ben", "moon");
    spectatorState.phase = "playing";

    addPlayer(spectatorState, "late", "Late", "bolt");
    expect(snapshotFor(spectatorState, "late").self?.role).toBe("spectator");
  });

  it("promotes waiting viewers at the next round when mid-game join is allowed", () => {
    const state = createGame("ROOM42", { allowMidGameJoin: true });
    addPlayer(state, "p1", "Ava", "sun");
    addPlayer(state, "p2", "Ben", "moon");
    state.phase = "roundEnd";

    addPlayer(state, "late", "Late", "bolt");
    expect(snapshotFor(state, "late").self?.role).toBe("waiting");

    startRound(state);

    expect(snapshotFor(state, "late").self?.role).toBe("player");
    expect(state.players.find((player) => player.id === "late")?.hand).toHaveLength(7);
    expect(state.viewers).toHaveLength(0);
  });

  it("keeps spectator-only viewers out of later rounds", () => {
    const state = createGame("ROOM42", { allowMidGameJoin: false });
    addPlayer(state, "p1", "Ava", "sun");
    addPlayer(state, "p2", "Ben", "moon");
    state.phase = "roundEnd";

    addPlayer(state, "late", "Late", "bolt");
    startRound(state);

    expect(snapshotFor(state, "late").self?.role).toBe("spectator");
    expect(state.players.some((player) => player.id === "late")).toBe(false);
  });
});
