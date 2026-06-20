import { randomBytes } from "node:crypto";
import type {
  Card,
  Color,
  GameLogEntry,
  GameMode,
  GamePhase,
  GameSnapshot,
  LastStandPlacement,
  PendingBatchPlay,
  PauseReason,
  ParticipantRole,
  PendingChallenge,
  PendingStack,
  PublicPlayer,
  PublicViewer,
  RoomSettings,
  RoomSettingsInput,
  RoundDealEvent,
  RoundDealState,
  RoundScoreBreakdown
} from "@congcard/shared";
import { COLORS, mergeRoomSettings } from "@congcard/shared";
import { standardMode, shuffleCards, buildSingleDeck } from "./modes/standard.js";

// Network-delay buffer so the One/Catch window opens AFTER every player has had
// a fair chance to receive the snapshot. The delay is calculated dynamically from
// the highest ping among active players (see updateOneWindowAfterPlay). These
// constants anchor the floor and the steady-state window length.
const MIN_ONE_DELAY_MS = 200;
const ONE_DELAY_EXTRA_MS = 150;
const ONE_CALL_WINDOW_MS = 4000;
const ONE_CALL_SETTLE_MS = 250;
const AUTO_ACTION_DELAY_MS = 1400;
const RESUME_TOKEN_BYTES = 24;
const BATCH_SYNC_MIN_LEAD_MS = 350;
const BATCH_SYNC_MAX_LEAD_MS = 1500;
const BATCH_SYNC_EXTRA_MS = 200;
const BATCH_MAX_START_SPAN_MS = 1800;
const BATCH_MAX_CARD_INTERVAL_MS = 180;
const BATCH_MIN_CARD_INTERVAL_MS = 40;
const BATCH_FLIGHT_DURATION_MS = 800;
const DEAL_INACTIVITY_MS = 30_000;
const DEAL_SYNC_MIN_LEAD_MS = 300;
const DEAL_SYNC_EXTRA_MS = 150;
const DEAL_FLIGHT_DURATION_MS = 800;
const SHUFFLE_DURATION_MS = 1_800;
const OPENING_DURATION_MS = 900;
const AUTO_DEAL_MIN_DURATION_MS = 6_000;
const AUTO_DEAL_MAX_DURATION_MS = 10_000;
const AUTO_DEAL_BASE_INTERVAL_MS = 180;

export interface PlayerState extends PublicPlayer {
  hand: Card[];
  drawnCardId?: string;
  resumeToken: string;
}

export type ViewerState = PublicViewer;

interface PendingBatchPlayInternal extends PendingBatchPlay {
  handBefore: Card[];
  activeColorBefore: Color;
}

interface DealQueueInternal {
  cards: Card[];
  targetPlayerIds: string[];
  nextIndex: number;
}

export interface GameStateInternal {
  code: string;
  phase: GamePhase;
  settings: RoomSettings;
  players: PlayerState[];
  viewers: ViewerState[];
  drawPile: Card[];
  discardPile: Card[];
  activeColor?: Color;
  direction: 1 | -1;
  currentSeat: number;
  turnDeadline?: number;
  pendingChallenge?: PendingChallenge;
  pendingStack?: PendingStack;
  pendingBatchPlay?: PendingBatchPlayInternal;
  roundDeal?: RoundDealState;
  dealQueue?: DealQueueInternal;
  pauseReason?: PauseReason;
  oneWindow?: { playerId: string; opensAt: number; deadline: number };
  pendingOneCall?: { playerId: string; resolvesAt: number };
  roundNumber: number;
  seq: number;
  actionLog: GameLogEntry[];
  roundWinnerId?: string;
  gameWinnerId?: string;
  lastStandPlacements?: LastStandPlacement[];
  /** Per-round scoring breakdown shown on the round-end overlay (points modes only). */
  roundScore?: RoundScoreBreakdown;
  /** Timestamp when we first decided an auto-play was needed; cleared after the move fires. */
  autoPlayPendingAt?: number;
  dealEventSeq: number;
}

export class GameError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
  }
}

export function createGame(code: string, settings?: RoomSettingsInput): GameStateInternal {
  return {
    code,
    phase: "lobby",
    settings: mergeRoomSettings(settings),
    players: [],
    viewers: [],
    drawPile: [],
    discardPile: [],
    direction: 1,
    currentSeat: 0,
    roundNumber: 0,
    seq: 0,
    actionLog: [],
    dealEventSeq: 0
  };
}

export function getMode(settings: RoomSettings): GameMode {
  if (settings.modeId !== "standard") {
    throw new GameError("unsupported_mode", "This game mode is not available yet.");
  }

  return standardMode;
}

export function addPlayer(
  state: GameStateInternal,
  id: string,
  nickname: string,
  avatarId: string,
  resumeToken?: string
): ParticipantRole {
  const existing = state.players.find((player) => player.id === id);
  if (existing) {
    connectPlayer(state, existing);
    return "player";
  }

  const existingViewer = state.viewers.find((viewer) => viewer.id === id);
  if (existingViewer) {
    existingViewer.connected = true;
    existingViewer.nickname = nickname;
    existingViewer.avatarId = avatarId;
    pushLog(state, "room", `${existingViewer.nickname} reconnected as ${viewerRoleLabel(existingViewer.role)}.`);
    return existingViewer.role;
  }

  const resumable = resumeToken ? state.players.find((player) => player.resumeToken === resumeToken) : undefined;
  if (resumable) {
    rebindPlayerSession(state, resumable.id, id);
    resumable.nickname = nickname;
    resumable.avatarId = avatarId;
    connectPlayer(state, resumable);
    return "player";
  }

  if (state.phase !== "lobby") {
    const role = state.phase === "gameEnd" || !state.settings.allowMidGameJoin ? "spectator" : "waiting";
    state.viewers.push({
      id,
      nickname,
      avatarId,
      connected: true,
      role
    });
    pushLog(state, "room", `${nickname} joined as ${viewerRoleLabel(role)}.`);
    return role;
  }

  if (state.players.length >= state.settings.maxPlayers) {
    throw new GameError("room_full", "This room is full.");
  }

  const seat = nextOpenSeat(state);
  state.players.push({
    id,
    nickname,
    avatarId,
    seat,
    cardCount: 0,
    score: 0,
    connected: true,
    away: false,
    isHost: state.players.length === 0,
    ready: false,
    calledOne: false,
    autoPlay: false,
    missedDisconnectedTurns: 0,
    ping: 0,
    hand: [],
    resumeToken: createResumeToken(state)
  });
  syncDeckBoxMinimum(state);
  pushLog(state, "room", `${nickname} joined the room.`);
  return "player";
}

export function setPlayerConnected(state: GameStateInternal, id: string, connected: boolean): void {
  const viewer = state.viewers.find((item) => item.id === id);
  if (viewer) {
    viewer.connected = connected;
    pushLog(state, "room", `${viewer.nickname} ${connected ? "reconnected" : "disconnected"}.`);
    return;
  }

  const player = findPlayer(state, id);
  if (!connected) {
    player.connected = false;
    player.away = false;
    player.ready = false;
    player.missedDisconnectedTurns = 0;
    syncAbsentAutomation(state, player);
    pushLog(state, "room", `${player.nickname} disconnected.`);
    assignHost(state);
    syncPauseState(state);
    syncRoundDealer(state);
  } else {
    connectPlayer(state, player);
  }
}

export function setPlayerAway(state: GameStateInternal, id: string, away: boolean): void {
  const player = findPlayer(state, id);
  if (!player.connected) {
    throw new GameError("player_disconnected", "You must be connected to change away status.");
  }

  if (player.away === away) {
    return;
  }

  player.away = away;
  player.ready = away ? false : player.ready;
  player.missedDisconnectedTurns = 0;
  syncAbsentAutomation(state, player);
  pushLog(state, "room", away ? `${player.nickname} is away.` : `${player.nickname} returned to the table.`);
  assignHost(state);
  syncPauseState(state);
  syncRoundDealer(state);
}

export function removePlayer(state: GameStateInternal, id: string): void {
  const viewer = state.viewers.find((item) => item.id === id);
  if (viewer) {
    state.viewers = state.viewers.filter((item) => item.id !== id);
    pushLog(state, "room", `${viewer.nickname} left the room.`);
    return;
  }

  const player = findPlayer(state, id);
  if (state.phase === "lobby") {
    state.players = state.players.filter((item) => item.id !== id);
  } else {
    player.connected = false;
    player.away = false;
    player.ready = false;
    syncAbsentAutomation(state, player);
    syncPauseState(state);
  }

  pushLog(state, "room", `${player.nickname} left the room.`);
  assignHost(state);
  syncRoundDealer(state);
}

export function setReady(state: GameStateInternal, id: string, ready: boolean): void {
  const player = findPlayer(state, id);
  ensurePlayerInteractive(player);
  if (state.phase !== "lobby") {
    throw new GameError("ready_locked", "Ready status can only change in the lobby.");
  }
  player.ready = ready;
  pushLog(state, "room", `${player.nickname} is ${ready ? "ready" : "not ready"}.`);
}

export function updateSettings(state: GameStateInternal, id: string, input: RoomSettingsInput): void {
  const player = findPlayer(state, id);
  ensurePlayerInteractive(player);
  if (!player.isHost) {
    throw new GameError("not_host", "Only the host can change room settings.");
  }

  if (state.phase !== "lobby") {
    throw new GameError("settings_locked", "Room settings are locked after the game starts.");
  }

  const scoreTargetDefault =
    input.scoreTarget !== undefined && input.callEnabled === undefined
      ? { callEnabled: input.scoreTarget !== "lastStand" }
      : {};
  const nextSettings = mergeRoomSettings({ ...state.settings, ...scoreTargetDefault, ...input });
  if (nextSettings.maxPlayers < state.players.length) {
    throw new GameError("max_players_too_low", "Max players cannot be lower than the current room size.");
  }

  if (nextSettings.deckBoxes < requiredDeckBoxes(state.players.length)) {
    throw new GameError("deck_boxes_too_low", "Deck boxes cannot be lower than the room minimum.");
  }

  state.settings = nextSettings;
  for (const item of state.players) {
    syncAbsentAutomation(state, item);
  }
  pushLog(state, "room", "Room settings were updated.");
}

export function kickPlayer(state: GameStateInternal, hostId: string, targetId: string): void {
  const host = findPlayer(state, hostId);
  ensurePlayerInteractive(host);
  if (!host.isHost) {
    throw new GameError("not_host", "Only the host can kick players.");
  }

  if (hostId === targetId) {
    throw new GameError("invalid_kick", "The host cannot kick themselves.");
  }

  if (state.phase === "dealing") {
    throw new GameError("round_setup_active", "Players cannot be kicked while cards are being dealt.");
  }

  const target = findPlayer(state, targetId);

  if (state.phase === "playing") {
    if (
      state.pendingChallenge &&
      (state.pendingChallenge.offenderId === targetId || state.pendingChallenge.challengerId === targetId)
    ) {
      delete state.pendingChallenge;
    }

    if (state.oneWindow?.playerId === targetId) {
      delete state.oneWindow;
    }

    if (state.pendingOneCall?.playerId === targetId) {
      delete state.pendingOneCall;
    }

    if (
      state.pendingStack?.targetPlayerId === targetId ||
      state.pendingStack?.roundWinnerId === targetId ||
      state.pendingStack?.offenderId === targetId
    ) {
      delete state.pendingStack;
    }

    if (state.pendingBatchPlay?.playerId === targetId) {
      delete state.pendingBatchPlay;
    }

    // Resolve the next seat while the target still exists, then fold their
    // cards back into the draw pile so the deck never silently shrinks.
    const wasCurrent = state.currentSeat === target.seat;
    const nextSeat = wasCurrent ? seatAfter(state, target.seat) : state.currentSeat;
    state.players = state.players.filter((player) => player.id !== targetId);
    state.drawPile = shuffleCards([...state.drawPile, ...target.hand]);
    state.currentSeat = nextSeat;
    if (wasCurrent) {
      setTurnDeadline(state);
    }

    pushLog(state, "room", `${target.nickname} was kicked from the room.`);

    const remaining = state.players[0];
    if (state.players.length === 1 && remaining) {
      if (isLastStand(state)) {
        state.roundWinnerId ??= remaining.id;
        maybeCompleteLastStandRound(state);
      } else {
        completeRound(state, remaining.id);
      }
    }

    return;
  }

  state.players = state.players.filter((player) => player.id !== targetId);
  pushLog(state, "room", `${target.nickname} was kicked from the room.`);
}

export function startRound(state: GameStateInternal): void {
  if (state.phase === "dealing" || state.phase === "playing") {
    throw new GameError("game_in_progress", "This round is already in progress.");
  }

  if (state.phase === "gameEnd") {
    throw new GameError("game_finished", "This game has already ended.");
  }

  const mode = getMode(state.settings);
  const previousPlacements = state.lastStandPlacements ? [...state.lastStandPlacements] : undefined;

  if (state.phase === "roundEnd") {
    promoteWaitingPlayers(state);
  }

  let activePlayers = sortedPlayers(state);
  if (state.phase === "lobby") {
    activePlayers = activePlayers.filter((player) => player.connected);

    if (activePlayers.some((player) => !player.ready && !player.isHost)) {
      throw new GameError("players_not_ready", "All non-host players must be ready.");
    }

    if (activePlayers.length !== state.players.length) {
      state.players = activePlayers;
      assignHost(state);
      pushLog(state, "room", "Disconnected lobby players were removed before the round started.");
    }
  }

  if (activePlayers.length < 2) {
    throw new GameError("not_enough_players", "At least two player seats are required.");
  }

  state.phase = "dealing";
  state.direction = 1;
  state.settings.deckBoxes = Math.max(state.settings.deckBoxes, requiredDeckBoxes(activePlayers.length));
  state.drawPile = mode.buildDeck(activePlayers.length, state.settings.deckBoxes);
  state.discardPile = [];
  delete state.pendingChallenge;
  delete state.pendingStack;
  delete state.pendingBatchPlay;
  delete state.roundDeal;
  delete state.dealQueue;
  delete state.pauseReason;
  delete state.oneWindow;
  delete state.pendingOneCall;
  delete state.roundWinnerId;
  delete state.gameWinnerId;
  delete state.lastStandPlacements;
  delete state.roundScore;
  state.roundNumber += 1;

  for (const player of state.players) {
    player.hand = [];
    player.cardCount = 0;
    player.calledOne = false;
    player.ready = false;
    delete player.drawnCardId;
    delete player.finishedRank;
  }

  const host = activePlayers.find((player) => player.isHost) ?? activePlayers[0]!;
  const previousWinnerId = previousPlacements?.find((placement) => placement.rank === 1)?.playerId;
  const previousLoserId = previousPlacements?.find((placement) => placement.isLoser)?.playerId;
  const firstPlayer = previousPlacements
    ? activePlayers.find((player) => player.id === previousWinnerId) ?? activePlayers[0]!
    : host;
  const preferredDealer = activePlayers.find((player) => player.id === previousLoserId) ?? host;
  const dealer = isAvailablePlayer(preferredDealer)
    ? preferredDealer
    : activePlayers.find((player) => player.isHost && isAvailablePlayer(player)) ?? activePlayers.find(isAvailablePlayer);

  state.currentSeat = firstPlayer.seat;
  state.roundDeal = {
    ...(isLastStand(state) && dealer ? { dealerPlayerId: dealer.id } : {}),
    firstPlayerId: firstPlayer.id,
    stage: isLastStand(state) ? "shuffleChoice" : "auto",
    cardsPerPlayer: mode.initialHandSize,
    readyPlayerCount: 0,
    totalPlayerCount: activePlayers.length,
    ...(isLastStand(state) ? { inactivityDeadline: Date.now() + DEAL_INACTIVITY_MS } : {})
  };

  pushLog(state, "deal", `Round ${state.roundNumber} dealing started.`);
  if (!isLastStand(state)) {
    scheduleAutoDeal(state);
  }
}

export function reshuffleRoundDeck(state: GameStateInternal, playerId: string): void {
  const deal = ensureRoundDealer(state, playerId);
  if (deal.stage !== "shuffleChoice" || deal.event || state.players.some((player) => player.hand.length > 0)) {
    throw new GameError("shuffle_unavailable", "The deck can only be reshuffled before dealing starts.");
  }

  const startsAt = Date.now() + dealSyncLead(state);
  deal.event = {
    id: nextDealEventId(state),
    kind: "shuffle",
    playerId,
    startsAt,
    resolvesAt: startsAt + SHUFFLE_DURATION_MS
  };
  delete deal.inactivityDeadline;
}

export function beginManualDeal(state: GameStateInternal, playerId: string): void {
  const deal = ensureRoundDealer(state, playerId);
  if (deal.stage !== "shuffleChoice" || deal.event) {
    throw new GameError("deal_unavailable", "Manual dealing cannot begin right now.");
  }

  deal.stage = "manual";
  deal.inactivityDeadline = Date.now() + DEAL_INACTIVITY_MS;
  pushLog(state, "deal", `${findPlayer(state, playerId).nickname} began dealing.`);
}

export function dealRoundCard(state: GameStateInternal, playerId: string, targetPlayerId: string): void {
  const deal = ensureRoundDealer(state, playerId);
  if (deal.stage !== "manual" || deal.event || state.dealQueue) {
    throw new GameError("deal_unavailable", "Wait for the current card to land.");
  }

  const target = findPlayer(state, targetPlayerId);
  if (target.hand.length >= deal.cardsPerPlayer) {
    throw new GameError("hand_ready", "That player already has enough cards.");
  }

  scheduleDealSequence(state, [target.id], false);
}

export function autoDealRound(state: GameStateInternal, playerId?: string): void {
  const deal = ensureDealing(state);
  if (playerId !== undefined) {
    ensureRoundDealer(state, playerId);
  }
  if (deal.event || state.dealQueue) {
    throw new GameError("deal_unavailable", "Wait for the current setup animation to finish.");
  }
  if (playerId !== undefined && deal.stage !== "manual") {
    throw new GameError("deal_unavailable", "Choose Deal Cards before using Auto Deal.");
  }

  scheduleAutoDeal(state);
}

export function resolveRoundDeal(state: GameStateInternal): boolean {
  if (state.phase !== "dealing" || !state.roundDeal) {
    return false;
  }

  let changed = syncRoundDealer(state);
  const deal = state.roundDeal;
  const now = Date.now();

  if (!deal.event && deal.inactivityDeadline && now >= deal.inactivityDeadline) {
    scheduleAutoDeal(state);
    return true;
  }

  const event = deal.event;
  if (!event) {
    return changed;
  }

  if (event.kind === "shuffle") {
    if (now < event.resolvesAt) {
      return changed;
    }
    state.drawPile = shuffleCards(state.drawPile);
    delete deal.event;
    deal.inactivityDeadline = now + DEAL_INACTIVITY_MS;
    pushLog(state, "deal", `${findPlayer(state, event.playerId).nickname} reshuffled the deck.`);
    return true;
  }

  if (event.kind === "deal") {
    const queue = state.dealQueue;
    if (!queue) {
      delete deal.event;
      return true;
    }

    while (queue.nextIndex < queue.cards.length) {
      const landingAt = event.startsAt + queue.nextIndex * event.cardIntervalMs + DEAL_FLIGHT_DURATION_MS;
      if (now < landingAt) {
        break;
      }

      const target = findPlayer(state, queue.targetPlayerIds[queue.nextIndex]!);
      target.hand.push(queue.cards[queue.nextIndex]!);
      target.cardCount = target.hand.length;
      target.ready = target.hand.length >= deal.cardsPerPlayer;
      queue.nextIndex += 1;
      changed = true;
    }

    if (changed) {
      syncDealProgress(state);
    }

    if (queue.nextIndex < queue.cards.length || now < event.resolvesAt) {
      return changed;
    }

    delete state.dealQueue;
    delete deal.event;
    syncDealProgress(state);
    if (deal.readyPlayerCount === deal.totalPlayerCount) {
      scheduleOpeningCard(state);
    } else if (deal.stage === "auto") {
      scheduleAutoDeal(state);
    } else {
      deal.inactivityDeadline = now + DEAL_INACTIVITY_MS;
    }
    return true;
  }

  if (now < event.resolvesAt) {
    return changed;
  }

  state.discardPile.push(event.card);
  state.activeColor = event.card.color ?? randomColor();
  const starter = state.players.find((player) => player.id === deal.firstPlayerId) ?? sortedPlayers(state)[0]!;
  state.currentSeat = starter.seat;
  delete state.roundDeal;
  delete state.dealQueue;
  state.phase = "playing";
  applyOpeningCard(state, event.card);
  setTurnDeadline(state);
  pushLog(state, "round", `Round ${state.roundNumber} started.`);
  return true;
}

export function playCard(
  state: GameStateInternal,
  playerId: string,
  cardId: string,
  declaredColor?: Color,
  automated = false
): void {
  ensurePlaying(state);
  ensureNoPendingOneCall(state);
  ensureNoPendingBatchPlay(state);
  ensureNotPaused(state);
  const mode = getMode(state.settings);
  const current = currentPlayer(state);
  let player = current.id === playerId ? current : findPlayer(state, playerId);
  const actingOutOfTurn = current.id !== playerId;
  if (!automated) {
    ensurePlayerInteractive(player);
  }
  const jumpingIn = actingOutOfTurn && canJumpIn(state, player, cardId);
  const jumpingIntoStack = Boolean(jumpingIn && state.pendingStack);

  if (actingOutOfTurn && !jumpingIn) {
    throw new GameError("not_your_turn", "It is not your turn.");
  }

  if (actingOutOfTurn) {
    state.currentSeat = player.seat;
    player = currentPlayer(state);
  }

  ensurePlayerInRound(player);

  if (player.drawnCardId && player.drawnCardId !== cardId) {
    throw new GameError("drawn_card_only", "You can only play the card you just drew.");
  }

  const cardIndex = player.hand.findIndex((card) => card.id === cardId);
  if (cardIndex < 0) {
    throw new GameError("card_not_found", "That card is not in your hand.");
  }

  const card = player.hand[cardIndex]!;
  const activeColor = state.activeColor;
  const discardTop = topDiscard(state);
  if (!activeColor) {
    throw new GameError("missing_color", "The active color is missing.");
  }

  const handBefore = [...player.hand];
  const stacking = jumpingIntoStack ? undefined : state.pendingStack;
  const challengeStackResponse = Boolean(
    state.pendingChallenge && stacking?.challengeable && stacking.targetPlayerId === player.id && canStackCard(card, stacking)
  );
  if (state.pendingChallenge && !challengeStackResponse) {
    throw new GameError("pending_challenge", "Resolve the Wild Draw Four challenge first.");
  }

  if (stacking) {
    if (stacking.targetPlayerId !== player.id || !canStackCard(card, stacking)) {
      throw new GameError("invalid_card", "Only a matching draw card can be stacked.");
    }
  } else if (!mode.isPlayable(card, { playerId, activeColor, discardTop, hand: player.hand, playerCount: activePlayers(state).length })) {
    throw new GameError("invalid_card", "That card cannot be played now.");
  }

  if ((card.value === "wild" || card.value === "wild4") && !declaredColor) {
    throw new GameError("color_required", "Choose a color for this Wild card.");
  }

  ensureNoActiveOneWindow(state);

  if (jumpingIntoStack) {
    delete state.pendingStack;
    delete state.pendingChallenge;
  }

  player.hand.splice(cardIndex, 1);
  player.cardCount = player.hand.length;
  delete player.drawnCardId;
  state.discardPile.push(card);

  if (card.color) {
    state.activeColor = card.color;
  }

  if (declaredColor) {
    state.activeColor = declaredColor;
  }

  updateOneWindowAfterPlay(state, player);
  pushLog(state, "play", `${player.nickname} played ${cardLabel(card)}.`);
  if (stacking) {
    applyStackedCard(state, player, card);
  } else {
    applyPlayedCard(state, player, card, handBefore, { resetStackFromJumpIn: jumpingIntoStack, prevColor: activeColor });
  }

  if (!state.pendingChallenge && !state.pendingStack && player.hand.length === 0) {
    finishPlayerOrCompleteRound(state, player.id);
  }
}

export function playBatch(
  state: GameStateInternal,
  playerId: string,
  cardIds: string[],
  declaredColor?: Color
): void {
  ensurePlaying(state);
  ensureNoPendingOneCall(state);
  ensureNoPendingBatchPlay(state);
  ensureNotPaused(state);

  if (!state.settings.batchEnabled) {
    throw new GameError("batch_disabled", "Batch Cards are disabled for this room.");
  }

  const player = currentPlayer(state);
  if (player.id !== playerId) {
    throw new GameError("not_your_turn", "It is not your turn.");
  }

  ensurePlayerInteractive(player);
  ensurePlayerInRound(player);
  ensureNoActiveOneWindow(state);

  // After drawing, the player committed to the drawn card: a batch is allowed
  // only when it includes that card (the FE forces it to be the starter).
  if (player.drawnCardId && !cardIds.includes(player.drawnCardId)) {
    throw new GameError("drawn_card_only", "You can only play the card you just drew.");
  }

  if (cardIds.length < 2 || new Set(cardIds).size !== cardIds.length) {
    throw new GameError("invalid_batch", "Choose at least two different cards for a batch.");
  }

  const cards = cardIds.map((cardId) => player.hand.find((card) => card.id === cardId));
  if (cards.some((card) => !card)) {
    throw new GameError("card_not_found", "A selected batch card is not in your hand.");
  }

  const orderedCards = cards as Card[];
  const value = orderedCards[0]!.value;
  if (orderedCards.some((card) => card.value !== value)) {
    throw new GameError("invalid_batch", "Every card in a batch must have the same value.");
  }

  const needsColor = value === "wild" || value === "wild4";
  if (needsColor && !declaredColor) {
    throw new GameError("color_required", "Choose a color for this Wild batch.");
  }

  if (!needsColor && declaredColor) {
    throw new GameError("invalid_batch", "Only Wild batches may declare a color.");
  }

  const stack = state.pendingStack;
  if (stack) {
    if (stack.targetPlayerId !== player.id || orderedCards.some((card) => !canStackCard(card, stack))) {
      throw new GameError("invalid_card", "Only matching draw cards can be batched onto this stack.");
    }
  } else {
    if (state.pendingChallenge) {
      throw new GameError("pending_challenge", "Resolve the Wild Draw Four challenge first.");
    }

    const activeColor = state.activeColor;
    if (!activeColor) {
      throw new GameError("missing_color", "The active color is missing.");
    }

    const mode = getMode(state.settings);
    if (!mode.isPlayable(orderedCards[0]!, {
      playerId,
      activeColor,
      discardTop: topDiscard(state),
      hand: player.hand,
      playerCount: activePlayers(state).length
    })) {
      throw new GameError("invalid_card", "The first card in that batch cannot be played now.");
    }
  }

  const now = Date.now();
  const highestPing = activePlayers(state).reduce((highest, item) => Math.max(highest, item.connected ? item.ping : 0), 0);
  const leadMs = Math.max(BATCH_SYNC_MIN_LEAD_MS, Math.min(BATCH_SYNC_MAX_LEAD_MS, highestPing + BATCH_SYNC_EXTRA_MS));
  const intervalMs = Math.min(
    BATCH_MAX_CARD_INTERVAL_MS,
    Math.max(BATCH_MIN_CARD_INTERVAL_MS, Math.floor(BATCH_MAX_START_SPAN_MS / Math.max(1, orderedCards.length - 1)))
  );
  const startsAt = now + leadMs;

  state.seq += 1;
  state.pendingBatchPlay = {
    id: state.seq,
    playerId,
    cards: orderedCards,
    ...(declaredColor ? { declaredColor } : {}),
    startsAt,
    cardIntervalMs: intervalMs,
    resolvesAt: startsAt + intervalMs * (orderedCards.length - 1) + BATCH_FLIGHT_DURATION_MS,
    handBefore: [...player.hand],
    activeColorBefore: state.activeColor ?? "red"
  };
  delete player.drawnCardId;
  delete state.turnDeadline;
  delete state.autoPlayPendingAt;
}

export function resolvePendingBatchPlay(state: GameStateInternal): boolean {
  const pending = state.pendingBatchPlay;
  if (!pending || Date.now() < pending.resolvesAt) {
    return false;
  }

  delete state.pendingBatchPlay;
  const player = findPlayer(state, pending.playerId);
  if (state.phase !== "playing" || player.finishedRank || currentPlayer(state).id !== player.id) {
    return false;
  }

  const selectedIds = new Set(pending.cards.map((card) => card.id));
  if (pending.cards.some((card) => !player.hand.some((held) => held.id === card.id))) {
    setTurnDeadline(state);
    return false;
  }

  player.hand = player.hand.filter((card) => !selectedIds.has(card.id));
  player.cardCount = player.hand.length;
  player.calledOne = false;
  state.discardPile.push(...pending.cards);

  const finalCard = pending.cards.at(-1)!;
  const finalColor = pending.declaredColor ?? finalCard.color ?? state.activeColor;
  if (finalColor) {
    state.activeColor = finalColor;
  }
  updateOneWindowAfterPlay(state, player);
  pushLog(state, "batch", `${player.nickname} played a batch of ${pending.cards.length} ${batchValueLabel(finalCard)} cards.`);
  applyBatchCards(state, player, pending.cards, pending.handBefore, pending.activeColorBefore);

  if (!state.pendingChallenge && !state.pendingStack && player.hand.length === 0) {
    finishPlayerOrCompleteRound(state, player.id);
  }

  return true;
}

export function drawCard(state: GameStateInternal, playerId: string, automated = false): void {
  ensurePlaying(state);
  ensureNoPendingOneCall(state);
  ensureNoPendingBatchPlay(state);
  ensureNotPaused(state);
  ensureNoPendingChallenge(state);
  const mode = getMode(state.settings);
  const player = currentPlayer(state);

  if (player.id !== playerId) {
    throw new GameError("not_your_turn", "It is not your turn.");
  }

  if (!automated) {
    ensurePlayerInteractive(player);
  }

  if (player.drawnCardId) {
    throw new GameError("already_drew", "You already drew a card this turn.");
  }

  ensureNoActiveOneWindow(state);

  if (state.pendingStack) {
    resolveStackDraw(state, player);
    return;
  }

  const card = takeCard(state);
  if (!card) {
    pushLog(state, "draw", `${player.nickname} passed because no cards were left.`);
    advanceTurn(state);
    return;
  }

  player.hand.push(card);
  syncPlayerHandChange(state, player);
  player.drawnCardId = card.id;
  player.calledOne = false;
  pushLog(state, "draw", `${player.nickname} drew one card.`);

  const activeColor = state.activeColor;
  if (!activeColor || !mode.isPlayable(card, { playerId, activeColor, discardTop: topDiscard(state), hand: player.hand, playerCount: activePlayers(state).length })) {
    if (automated) {
      return;
    }
    delete player.drawnCardId;
    advanceTurn(state);
  }
}

export function playDrawn(state: GameStateInternal, playerId: string, play: boolean, declaredColor?: Color): void {
  ensurePlaying(state);
  ensureNoPendingOneCall(state);
  ensureNoPendingBatchPlay(state);
  ensureNotPaused(state);
  ensureNoPendingChallenge(state);
  const player = currentPlayer(state);

  if (player.id !== playerId) {
    throw new GameError("not_your_turn", "It is not your turn.");
  }

  ensurePlayerInteractive(player);

  if (!player.drawnCardId) {
    throw new GameError("no_drawn_card", "There is no drawn card to resolve.");
  }

  if (play) {
    playCard(state, playerId, player.drawnCardId, declaredColor);
    return;
  }

  ensureNoActiveOneWindow(state);

  delete player.drawnCardId;
  pushLog(state, "draw", `${player.nickname} passed after drawing.`);
  advanceTurn(state);
}

export function callOne(state: GameStateInternal, playerId: string, automated = false): void {
  ensurePlaying(state);
  ensureNoPendingBatchPlay(state);
  ensureNotPaused(state);
  const player = findPlayer(state, playerId);
  if (!automated) {
    ensurePlayerInteractive(player);
  }
  const oneWindow = state.oneWindow;
  const now = Date.now();

  if (state.pendingOneCall?.playerId === playerId) {
    return;
  }

  if (
    player.finishedRank ||
    player.hand.length !== 1 ||
    !oneWindow ||
    oneWindow.playerId !== playerId ||
    now < oneWindow.opensAt ||
    now > oneWindow.deadline
  ) {
    throw new GameError("cannot_call_one", "You can only call One while your One window is open.");
  }

  // Auto-called One (away/disconnected): finalize immediately and close the
  // window so an absent player cannot be caught while the bot covers for them.
  if (automated) {
    player.calledOne = true;
    delete state.oneWindow;
    delete state.pendingOneCall;
    pushLog(state, "one", `${player.nickname} called One.`);
    return;
  }

  // Do not finalize instantly: give catch packets that were already in flight
  // a short server-side arbitration buffer, so host/low-latency clients do not
  // win purely because their message reached the room first.
  state.pendingOneCall = {
    playerId,
    resolvesAt: now + ONE_CALL_SETTLE_MS
  };
}

export function catchOne(state: GameStateInternal, catcherId: string, targetId: string): void {
  ensurePlaying(state);
  ensureNoPendingBatchPlay(state);
  ensureNotPaused(state);
  const catcher = findPlayer(state, catcherId);
  ensurePlayerInteractive(catcher);
  const target = findPlayer(state, targetId);
  const oneWindow = state.oneWindow;
  const pendingCall = state.pendingOneCall?.playerId === targetId;
  const catchDeadline = oneWindow ? Math.max(oneWindow.deadline, pendingCall ? state.pendingOneCall!.resolvesAt : oneWindow.deadline) : 0;
  const now = Date.now();

  if (catcherId === targetId) {
    throw new GameError("catch_failed", "You cannot catch yourself.");
  }

  if (
    catcher.finishedRank ||
    target.finishedRank ||
    target.calledOne ||
    target.hand.length !== 1 ||
    !oneWindow ||
    oneWindow.playerId !== targetId ||
    now < oneWindow.opensAt ||
    now > catchDeadline
  ) {
    throw new GameError("catch_failed", "That player cannot be caught now.");
  }

  // Closing the window is the double-catch guard; the caught player must NOT
  // be credited with a One call they never made.
  drawMany(state, target, 2);
  closeOneWindowForPlayer(state, target.id);
  pushLog(state, "one", `${catcher.nickname} caught ${target.nickname}.`);
}

export function resolvePendingOneCall(state: GameStateInternal): boolean {
  const pending = state.pendingOneCall;
  if (!pending || Date.now() < pending.resolvesAt) {
    return false;
  }

  finalizePendingOneCall(state);
  settlePendingStackIfUnstackable(state);
  return true;
}

// Lets the room ticker close stale windows and broadcast, so every client
// hides its One/Catch buttons in sync with the server instead of guessing
// from its own clock. Expiring is silent: missing the call only costs cards
// when another player actually catches it.
export function expireOneWindow(state: GameStateInternal): boolean {
  if (!state.oneWindow || Date.now() <= state.oneWindow.deadline || state.pendingOneCall?.playerId === state.oneWindow.playerId) {
    return false;
  }

  closeOneWindowForPlayer(state, state.oneWindow.playerId);
  settlePendingStackIfUnstackable(state);
  return true;
}

export function resolveChallenge(state: GameStateInternal, playerId: string, accept: boolean, automated = false): void {
  ensurePlaying(state);
  ensureNoPendingOneCall(state);
  ensureNoPendingBatchPlay(state);
  ensureNotPaused(state);
  const pending = state.pendingChallenge;
  if (!pending) {
    throw new GameError("no_challenge", "There is no Wild Draw Four to challenge.");
  }

  if (pending.challengerId !== playerId) {
    throw new GameError("not_challenger", "Only the affected player can resolve this challenge.");
  }

  ensureNoActiveOneWindow(state);

  const offender = findPlayer(state, pending.offenderId);
  const challenger = findPlayer(state, pending.challengerId);
  if (!automated) {
    ensurePlayerInteractive(challenger);
  }
  const challengeableStack =
    state.pendingStack?.challengeable &&
    state.pendingStack.targetPlayerId === pending.challengerId &&
    state.pendingStack.offenderId === pending.offenderId
      ? state.pendingStack
      : undefined;
  delete state.pendingChallenge;
  if (challengeableStack) {
    delete state.pendingStack;
  }

  if (!accept) {
    const totalDraw = challengeableStack?.totalDraw ?? pending.drawCount ?? 4;
    drawMany(state, challenger, totalDraw);
    state.currentSeat = seatAfter(state, challenger.seat);
    pushLog(state, "challenge", totalDraw === 4 ? `${challenger.nickname} took four cards.` : `${challenger.nickname} took ${totalDraw} cards.`);
  } else if (pending.guilty) {
    drawMany(state, offender, pending.drawCount ?? 4);
    state.currentSeat = challenger.seat;
    pushLog(state, "challenge", `${challenger.nickname} won the challenge.`);
  } else {
    drawMany(state, challenger, (pending.drawCount ?? 4) + 2);
    state.currentSeat = seatAfter(state, challenger.seat);
    pushLog(state, "challenge", `${challenger.nickname} lost the challenge and drew ${(pending.drawCount ?? 4) + 2} cards.`);
  }

  setTurnDeadline(state);

  if (offender.hand.length === 0) {
    finishPlayerOrCompleteRound(state, offender.id);
  }
}

export function handleTurnTimeout(state: GameStateInternal): boolean {
  const pause = syncPauseState(state);
  if (pause.paused) {
    return pause.changed;
  }

  if (state.pendingBatchPlay) {
    return false;
  }

  if (state.phase !== "playing" || !state.turnDeadline || Date.now() < state.turnDeadline) {
    return false;
  }

  if (state.pendingOneCall) {
    if (Date.now() >= state.pendingOneCall.resolvesAt) {
      finalizePendingOneCall(state);
      return true;
    }

    return false;
  }

  if (hasActiveOneWindow(state)) {
    return false;
  }

  const pending = state.pendingChallenge;
  if (pending) {
    // An unanswered Wild Draw Four must not stall the game forever: when the
    // turn timer lapses, resolve it as if the challenger declined.
    const challenger = findPlayer(state, pending.challengerId);
    markMissedDisconnectedTurn(state, challenger);
    resolveChallenge(state, challenger.id, false, true);
    return true;
  }

  if (state.pendingStack) {
    const player = currentPlayer(state);
    markMissedDisconnectedTurn(state, player);
    resolveStackDraw(state, player);
    return true;
  }

  const player = currentPlayer(state);
  markMissedDisconnectedTurn(state, player);
  if (player.drawnCardId) {
    delete player.drawnCardId;
    pushLog(state, "draw", `${player.nickname} passed after drawing.`);
  } else {
    drawMany(state, player, 1);
    pushLog(state, "draw", `${player.nickname} timed out and drew one card.`);
  }

  advanceTurn(state);
  return true;
}

export function snapshotFor(state: GameStateInternal, playerId?: string): GameSnapshot {
  const self = playerId ? state.players.find((player) => player.id === playerId) : undefined;
  const viewerSelf = !self && playerId ? state.viewers.find((viewer) => viewer.id === playerId) : undefined;
  const snapshot: GameSnapshot = {
    seq: state.seq,
    serverNow: Date.now(),
    code: state.code,
    phase: state.phase,
    settings: state.settings,
    players: sortedPlayers(state).map(toPublicPlayer),
    viewers: sortedViewers(state),
    direction: state.direction,
    roundNumber: state.roundNumber,
    drawPileCount: state.drawPile.length + Math.max(0, (state.dealQueue?.cards.length ?? 0) - (state.dealQueue?.nextIndex ?? 0)),
    actionLog: state.actionLog.slice(-30)
  };

  if (self) {
    snapshot.self = {
      id: self.id,
      role: "player",
      hand: state.phase === "dealing" ? [] : self.hand,
      resumeToken: self.resumeToken,
      ...(self.drawnCardId ? { drawnCardId: self.drawnCardId } : {})
    };
  } else if (viewerSelf) {
    snapshot.self = {
      id: viewerSelf.id,
      role: viewerSelf.role,
      hand: []
    };
  }

  const discardTop = state.discardPile.at(-1);
  if (discardTop) {
    snapshot.discardTop = discardTop;
  }

  if (state.activeColor) {
    snapshot.activeColor = state.activeColor;
  }

  if (state.phase === "playing" && activePlayers(state).length > 0) {
    snapshot.currentPlayerId = currentPlayer(state).id;
  }

  if (state.turnDeadline) {
    snapshot.turnDeadline = state.turnDeadline;
  }

  if (state.pendingChallenge) {
    snapshot.pendingChallenge = state.pendingChallenge;
  }

  if (state.pendingStack) {
    snapshot.pendingStack = state.pendingStack;
  }

  if (state.pendingBatchPlay) {
    const pending = state.pendingBatchPlay;
    snapshot.pendingBatchPlay = {
      id: pending.id,
      playerId: pending.playerId,
      cards: pending.cards,
      ...(pending.declaredColor ? { declaredColor: pending.declaredColor } : {}),
      startsAt: pending.startsAt,
      cardIntervalMs: pending.cardIntervalMs,
      resolvesAt: pending.resolvesAt
    };
  }

  if (state.roundDeal) {
    snapshot.roundDeal = state.roundDeal;
  }

  if (state.pauseReason) {
    snapshot.pauseReason = state.pauseReason;
  }

  if (state.lastStandPlacements) {
    snapshot.lastStandPlacements = state.lastStandPlacements;
  }

  if (state.oneWindow) {
    snapshot.oneWindow = {
      ...state.oneWindow,
      ...(state.pendingOneCall?.playerId === state.oneWindow.playerId
        ? { callPending: true, callResolvesAt: state.pendingOneCall.resolvesAt }
        : {})
    };
  }

  if (state.roundWinnerId) {
    snapshot.roundWinnerId = state.roundWinnerId;
  }

  if (state.gameWinnerId) {
    snapshot.gameWinnerId = state.gameWinnerId;
  }

  if (state.roundScore) {
    snapshot.roundScore = state.roundScore;
  }

  return snapshot;
}

export function sendEmote(state: GameStateInternal, playerId: string, emoteId: string): void {
  const player = findPlayer(state, playerId);
  ensurePlayerInteractive(player);
  pushLog(state, "room", `${player.nickname}: ${emoteText(emoteId)}`);
}

export function resolveAutomatedTurns(state: GameStateInternal): boolean {
  const pause = syncPauseState(state);
  if (pause.paused) {
    return pause.changed;
  }

  let changed = false;
  if (state.pendingBatchPlay) {
    return changed;
  }
  // Allow extra iterations beyond one-per-player so a chain of auto turns can
  // also fit the auto-One call and auto-stack steps without stalling a tick.
  const limit = state.players.length * 2 + 5;

  for (let count = 0; count < limit; count += 1) {
    if (state.phase !== "playing" || state.pendingOneCall) {
      return changed;
    }

    // Auto-call One for an away/disconnected auto player once their window is
    // open, so they are not left catchable while the bot covers their hand.
    const ow = state.oneWindow;
    if (ow) {
      const owner = state.players.find((item) => item.id === ow.playerId);
      const nowTs = Date.now();
      if (
        owner &&
        state.settings.absentPlayerAction === "autoplay" &&
        state.settings.autoPlayCallOne &&
        isAutoControllable(state, owner) &&
        !owner.calledOne &&
        owner.hand.length === 1 &&
        nowTs >= ow.opensAt &&
        nowTs <= ow.deadline
      ) {
        callOne(state, owner.id, true);
        changed = true;
        continue;
      }
    }

    if (hasActiveOneWindow(state)) {
      return changed;
    }

    const pending = state.pendingChallenge;
    if (pending) {
      const challenger = findPlayer(state, pending.challengerId);
      if (isAutoControllable(state, challenger)) {
        if (!autoActionDelayElapsed(state)) {
          return true;
        }
        resolveChallenge(state, challenger.id, false, true);
        changed = true;
        continue;
      }

      return changed;
    }

    const player = currentPlayer(state);
    if (state.pendingStack) {
      if (settlePendingStackIfUnstackable(state)) {
        changed = true;
        continue;
      }

      if (!isAutoControllable(state, player)) {
        return changed;
      }

      if (!autoActionDelayElapsed(state)) {
        return true;
      }

      const stackCardId = state.settings.absentPlayerAction === "autoplay" ? autoStackCardId(player, state.pendingStack) : undefined;
      if (stackCardId && state.settings.absentPlayerAction === "autoplay") {
        const stackCard = player.hand.find((item) => item.id === stackCardId)!;
        const declaredColor = needsDeclaredColor(stackCard) ? chooseAutoColor(player, stackCardId) : undefined;
        playCard(state, player.id, stackCardId, declaredColor, true);
      } else {
        resolveStackDraw(state, player);
      }
      changed = true;
      continue;
    }

    if (!isAutoControllable(state, player)) {
      delete state.autoPlayPendingAt;
      return changed;
    }

    if (!autoActionDelayElapsed(state)) {
      return true;
    }

    if (state.settings.absentPlayerAction === "draw") {
      autoDrawTurn(state, player);
    } else {
      autoPlayTurn(state, player);
    }
    changed = true;
  }

  return changed;
}

function applyOpeningCard(state: GameStateInternal, card: Card): void {
  if (card.value === "skip") {
    state.currentSeat = seatAfter(state, state.currentSeat);
  } else if (card.value === "reverse") {
    state.direction = -1;
    if (activePlayers(state).length === 2) {
      state.currentSeat = seatAfter(state, state.currentSeat);
    }
  } else if (card.value === "draw2") {
    const target = findPlayerBySeat(state, state.currentSeat);
    drawMany(state, target, 2);
    state.currentSeat = seatAfter(state, target.seat);
  }
}

function applyBatchCards(
  state: GameStateInternal,
  player: PlayerState,
  cards: Card[],
  handBefore: Card[],
  activeColorBefore: Color
): void {
  const value = cards[0]!.value;
  const count = cards.length;
  const existingStack = state.pendingStack;

  if (value === "skip") {
    let skippedSeat = player.seat;
    for (let index = 0; index < count; index += 1) {
      skippedSeat = nextOpponentSeat(state, skippedSeat, player.id);
    }
    state.currentSeat = seatAfter(state, skippedSeat);
    setTurnDeadline(state);
    pushLog(state, "skip", `${count} players were skipped by the batch.`);
    return;
  }

  if (value === "reverse") {
    if (count % 2 === 1) {
      state.direction = state.direction === 1 ? -1 : 1;
    }
    state.currentSeat = activePlayers(state).length === 2 ? player.seat : seatAfter(state, player.seat);
    setTurnDeadline(state);
    pushLog(state, "reverse", `Turn direction changed ${count} times.`);
    return;
  }

  if (value === "draw2") {
    const totalDraw = count * 2;
    if (existingStack) {
      applyStackedBatch(state, player, totalDraw);
      return;
    }

    if (state.settings.stackingEnabled) {
      startStack(state, player, "draw2", totalDraw);
      return;
    }

    const target = findPlayerBySeat(state, seatAfter(state, player.seat));
    drawMany(state, target, totalDraw);
    state.currentSeat = seatAfter(state, target.seat);
    setTurnDeadline(state);
    pushLog(state, "draw", `${target.nickname} drew ${totalDraw} cards.`);
    return;
  }

  if (value === "wild4") {
    const totalDraw = count * 4;
    if (existingStack) {
      applyStackedBatch(state, player, totalDraw);
      return;
    }

    const guilty = handBefore.some((item) => !cards.some((batchCard) => batchCard.id === item.id) && item.color === activeColorBefore);
    if (state.settings.stackingEnabled) {
      startStack(
        state,
        player,
        "wild4",
        totalDraw,
        state.settings.challengeEnabled
          ? { declaredColor: state.activeColor ?? "red", guilty }
          : undefined
      );
      return;
    }

    const target = findPlayerBySeat(state, seatAfter(state, player.seat));
    if (!state.settings.challengeEnabled) {
      drawMany(state, target, totalDraw);
      state.currentSeat = seatAfter(state, target.seat);
      setTurnDeadline(state);
      pushLog(state, "challenge", `${target.nickname} took ${totalDraw} cards.`);
      return;
    }

    state.pendingChallenge = {
      offenderId: player.id,
      challengerId: target.id,
      declaredColor: state.activeColor ?? "red",
      guilty,
      drawCount: totalDraw
    };
    state.currentSeat = target.seat;
    setTurnDeadline(state);
    pushLog(state, "wild", `${target.nickname} must choose whether to challenge.`);
    return;
  }

  if (value === "wild") {
    pushLog(state, "wild", `Active color is ${state.activeColor}.`);
  }

  advanceTurn(state);
}

function applyStackedBatch(state: GameStateInternal, player: PlayerState, amount: number): void {
  const stack = state.pendingStack;
  if (!stack) {
    throw new GameError("invalid_batch", "There is no draw stack for this batch.");
  }

  const stackedOut = player.hand.length === 0;
  if (stackedOut && isLastStand(state)) {
    finishLastStandPlayer(state, player.id);
  }

  const target = findPlayerBySeat(state, seatAfter(state, player.seat));
  const roundWinnerId = stack.roundWinnerId ?? (!isLastStand(state) && stackedOut ? player.id : undefined);
  if (stack.challengeable) {
    delete state.pendingChallenge;
  }
  state.pendingStack = {
    kind: stack.kind,
    targetPlayerId: target.id,
    totalDraw: stack.totalDraw + amount,
    challengeable: false,
    ...(roundWinnerId ? { roundWinnerId } : {})
  };
  state.currentSeat = target.seat;
  setTurnDeadline(state);
  pushLog(state, "draw", `${target.nickname} must stack or draw ${stack.totalDraw + amount} cards.`);
  settlePendingStackIfUnstackable(state);
}

function nextOpponentSeat(state: GameStateInternal, fromSeat: number, actorId: string): number {
  let seat = seatAfter(state, fromSeat);
  while (findPlayerBySeat(state, seat).id === actorId) {
    seat = seatAfter(state, seat);
  }
  return seat;
}

function applyPlayedCard(
  state: GameStateInternal,
  player: PlayerState,
  card: Card,
  handBefore: Card[],
  options: { resetStackFromJumpIn?: boolean; prevColor?: Color } = {}
): void {
  if (card.value === "skip") {
    const skipped = findPlayerBySeat(state, seatAfter(state, player.seat));
    pushLog(state, "skip", `${skipped.nickname} was skipped.`);
    advanceTurn(state, 1);
    return;
  }

  if (card.value === "reverse") {
    state.direction = state.direction === 1 ? -1 : 1;
    pushLog(state, "reverse", "Turn direction changed.");
    advanceTurn(state, activePlayers(state).length === 2 ? 1 : 0);
    return;
  }

  if (card.value === "draw2") {
    if (state.settings.stackingEnabled) {
      startStack(state, player, "draw2", 2);
      return;
    }

    const target = findPlayerBySeat(state, seatAfter(state, player.seat));
    drawMany(state, target, 2);
    state.currentSeat = seatAfter(state, target.seat);
    setTurnDeadline(state);
    pushLog(state, "draw", `${target.nickname} drew two cards.`);
    return;
  }

  if (card.value === "wild4") {
    if (state.settings.stackingEnabled) {
      const previousColor = options.prevColor;
      startStack(
        state,
        player,
        "wild4",
        4,
        state.settings.challengeEnabled && !options.resetStackFromJumpIn
          ? {
              declaredColor: state.activeColor ?? "red",
              guilty: previousColor ? handBefore.some((item) => item.color === previousColor) : false
            }
          : undefined
      );
      return;
    }

    const target = findPlayerBySeat(state, seatAfter(state, player.seat));
    const previousColor = options.prevColor;
    if (!state.settings.challengeEnabled) {
      drawMany(state, target, 4);
      state.currentSeat = seatAfter(state, target.seat);
      setTurnDeadline(state);
      pushLog(state, "challenge", `${target.nickname} took four cards.`);
      return;
    }

    state.pendingChallenge = {
      offenderId: player.id,
      challengerId: target.id,
      declaredColor: state.activeColor ?? "red",
      guilty: previousColor ? handBefore.some((item) => item.color === previousColor) : false
    };
    state.currentSeat = target.seat;
    setTurnDeadline(state);
    pushLog(state, "wild", `${target.nickname} must choose whether to challenge.`);
    return;
  }

  if (card.value === "wild") {
    pushLog(state, "wild", `Active color is ${state.activeColor}.`);
  }

  advanceTurn(state);
}

function startStack(
  state: GameStateInternal,
  player: PlayerState,
  kind: PendingStack["kind"],
  amount: number,
  challenge?: { declaredColor: Color; guilty: boolean }
): void {
  const stackedOut = player.hand.length === 0;
  if (stackedOut && isLastStand(state)) {
    finishLastStandPlayer(state, player.id);
  }

  const target = findPlayerBySeat(state, seatAfter(state, player.seat));
  state.pendingStack = {
    kind,
    targetPlayerId: target.id,
    totalDraw: amount,
    ...(challenge
      ? {
          challengeable: true,
          offenderId: player.id,
          declaredColor: challenge.declaredColor,
          guilty: challenge.guilty
        }
      : {}),
    ...(!isLastStand(state) && stackedOut ? { roundWinnerId: player.id } : {})
  };
  if (challenge) {
    state.pendingChallenge = {
      offenderId: player.id,
      challengerId: target.id,
      declaredColor: challenge.declaredColor,
      guilty: challenge.guilty,
      drawCount: amount
    };
  }
  state.currentSeat = target.seat;
  setTurnDeadline(state);
  pushLog(state, challenge ? "wild" : "draw", `${target.nickname} must ${challenge ? "choose: challenge, stack, or accept" : "stack or draw"} ${amount} cards.`);
  if (!challenge) {
    settlePendingStackIfUnstackable(state);
  }
}

function applyStackedCard(state: GameStateInternal, player: PlayerState, card: Card): void {
  const stack = state.pendingStack;
  const amount = stackDrawAmount(card);
  if (!stack || !amount) {
    throw new GameError("invalid_card", "Only a matching draw card can be stacked.");
  }

  const stackedOut = player.hand.length === 0;
  if (stackedOut && isLastStand(state)) {
    finishLastStandPlayer(state, player.id);
  }

  const target = findPlayerBySeat(state, seatAfter(state, player.seat));
  const roundWinnerId = stack.roundWinnerId ?? (!isLastStand(state) && stackedOut ? player.id : undefined);
  if (stack.challengeable) {
    delete state.pendingChallenge;
  }
  state.pendingStack = {
    kind: stack.kind,
    targetPlayerId: target.id,
    totalDraw: stack.totalDraw + amount,
    challengeable: false,
    ...(roundWinnerId ? { roundWinnerId } : {})
  };
  state.currentSeat = target.seat;
  setTurnDeadline(state);
  pushLog(state, "draw", `${target.nickname} must stack or draw ${stack.totalDraw + amount} cards.`);
  settlePendingStackIfUnstackable(state);
}

function resolveStackDraw(state: GameStateInternal, player: PlayerState): void {
  const stack = state.pendingStack;
  if (!stack || stack.targetPlayerId !== player.id) {
    return;
  }

  drawMany(state, player, stack.totalDraw);
  pushLog(state, "draw", `${player.nickname} drew ${stack.totalDraw} stacked cards.`);
  const winnerId = stack.roundWinnerId;
  delete state.pendingStack;
  if (winnerId) {
    finishPlayerOrCompleteRound(state, winnerId);
    return;
  }

  if (maybeCompleteLastStandRound(state)) {
    return;
  }

  state.currentSeat = seatAfter(state, player.seat);
  setTurnDeadline(state);
}

function canStackCard(card: Card, stack: PendingStack): boolean {
  return stack.kind === "draw2" ? card.value === "draw2" : card.value === "wild4";
}

function canPlayerStack(player: PlayerState, stack: PendingStack): boolean {
  return !player.finishedRank && player.hand.some((card) => canStackCard(card, stack));
}

function settlePendingStackIfUnstackable(state: GameStateInternal): boolean {
  const stack = state.pendingStack;
  if (!stack || stack.challengeable || state.pendingOneCall || hasActiveOneWindow(state)) {
    return false;
  }

  const target = findPlayer(state, stack.targetPlayerId);
  if (canPlayerStack(target, stack)) {
    return false;
  }

  resolveStackDraw(state, target);
  return true;
}

function stackDrawAmount(card: Card): number | null {
  if (card.value === "draw2") return 2;
  if (card.value === "wild4") return 4;
  return null;
}

function canJumpIn(state: GameStateInternal, player: PlayerState, cardId: string): boolean {
  if (!state.settings.jumpInEnabled || state.pendingChallenge || player.drawnCardId || player.finishedRank) {
    return false;
  }

  const discardTop = topDiscard(state);
  const card = player.hand.find((item) => item.id === cardId);
  const exactMatch = Boolean(card && discardTop && card.value === discardTop.value && card.color === discardTop.color);
  if (!exactMatch || !card) {
    return false;
  }

  return state.pendingStack ? stackDrawAmount(card) !== null : true;
}

function updateOneWindowAfterPlay(state: GameStateInternal, player: PlayerState): void {
  if (!state.settings.callEnabled) {
    player.calledOne = false;
    closeOneWindowForPlayer(state, player.id);
    return;
  }

  if (player.finishedRank) {
    closeOneWindowForPlayer(state, player.id);
    return;
  }

  if (player.hand.length === 1) {
    // Compute a per-round delay so the highest-ping player still receives the
    // snapshot before the window opens. Using RTT/2 (one-way latency) + buffer
    // ensures every client has the data in hand when opensAt fires.
    const activePings = state.players
      .filter((p) => p.connected && !p.away && p.id !== player.id)
      .map((p) => p.ping);
    const maxPing = Math.max(...activePings, 0);
    const networkDelay = Math.max(Math.ceil(maxPing / 2) + ONE_DELAY_EXTRA_MS, MIN_ONE_DELAY_MS);

    const opensAt = Date.now() + networkDelay;
    finalizePendingOneCall(state);
    player.calledOne = false;
    state.oneWindow = {
      playerId: player.id,
      opensAt,
      deadline: opensAt + ONE_CALL_WINDOW_MS
    };
  } else {
    player.calledOne = false;
    closeOneWindowForPlayer(state, player.id);
  }
}

function finishPlayerOrCompleteRound(state: GameStateInternal, winnerId: string): void {
  if (!isLastStand(state)) {
    completeRound(state, winnerId);
    return;
  }

  finishLastStandPlayer(state, winnerId);
  maybeCompleteLastStandRound(state);
}

function finishLastStandPlayer(state: GameStateInternal, playerId: string): void {
  const player = findPlayer(state, playerId);
  if (player.finishedRank) {
    return;
  }

  const placements = state.lastStandPlacements ?? [];
  const rank = placements.length + 1;
  player.finishedRank = rank;
  player.cardCount = 0;
  player.calledOne = false;
  delete player.drawnCardId;
  closeOneWindowForPlayer(state, player.id);

  state.lastStandPlacements = [
    ...placements,
    {
      playerId: player.id,
      rank,
      finishedAt: Date.now()
    }
  ];

  if (!state.roundWinnerId) {
    state.roundWinnerId = player.id;
  }

  pushLog(state, "round", `${player.nickname} finished in place ${rank}.`);
}

function maybeCompleteLastStandRound(state: GameStateInternal): boolean {
  if (!isLastStand(state) || state.phase !== "playing" || state.pendingChallenge || state.pendingStack) {
    return false;
  }

  const remaining = activePlayers(state);
  if (remaining.length > 1) {
    return false;
  }

  const loser = remaining[0];
  if (loser && !loser.finishedRank) {
    const placements = state.lastStandPlacements ?? [];
    const rank = placements.length + 1;
    loser.finishedRank = rank;
    loser.cardCount = loser.hand.length;
    loser.calledOne = false;
    closeOneWindowForPlayer(state, loser.id);
    state.lastStandPlacements = [
      ...placements,
      {
        playerId: loser.id,
        rank,
        finishedAt: Date.now(),
        isLoser: true
      }
    ];
    pushLog(state, "round", `${loser.nickname} finished last in Last Stand.`);
  }

  state.phase = "roundEnd";
  delete state.turnDeadline;
  delete state.pendingChallenge;
  delete state.pendingStack;
  delete state.oneWindow;
  delete state.pendingOneCall;
  return true;
}

function scoreHandBreakdown(hand: Card[]): { numberPoints: number; actionPoints: number; wildPoints: number; handValue: number } {
  let numberPoints = 0;
  let actionPoints = 0;
  let wildPoints = 0;

  for (const card of hand) {
    if (typeof card.value === "number") {
      numberPoints += card.value;
    } else if (card.value === "wild" || card.value === "wild4") {
      wildPoints += 50;
    } else {
      actionPoints += 20;
    }
  }

  return { numberPoints, actionPoints, wildPoints, handValue: numberPoints + actionPoints + wildPoints };
}

function completeRound(state: GameStateInternal, winnerId: string): void {
  const winner = findPlayer(state, winnerId);
  const losers = state.players.filter((player) => player.id !== winnerId);
  const breakdownPlayers = losers.map((player) => {
    const parts = scoreHandBreakdown(player.hand);
    return {
      playerId: player.id,
      cardCount: player.hand.length,
      handValue: parts.handValue,
      numberPoints: parts.numberPoints,
      actionPoints: parts.actionPoints,
      wildPoints: parts.wildPoints
    };
  });
  const score = breakdownPlayers.reduce((total, player) => total + player.handValue, 0);

  winner.score += score;
  state.phase = state.settings.scoreTarget === 500 && winner.score >= 500 ? "gameEnd" : "roundEnd";
  state.roundWinnerId = winner.id;
  if (state.phase === "gameEnd") {
    state.gameWinnerId = winner.id;
  }

  state.roundScore = {
    winnerId: winner.id,
    total: score,
    isGameEnd: state.phase === "gameEnd",
    players: breakdownPlayers
  };

  delete state.turnDeadline;
  delete state.pendingChallenge;
  delete state.pendingStack;
  delete state.oneWindow;
  delete state.pendingOneCall;
  pushLog(state, "round", `${winner.nickname} won the round with ${score} points.`);
}

function finalizePendingOneCall(state: GameStateInternal): void {
  const pending = state.pendingOneCall;
  if (!pending) {
    return;
  }

  delete state.pendingOneCall;

  const player = state.players.find((item) => item.id === pending.playerId);
  if (state.phase !== "playing" || !player || player.finishedRank || player.hand.length !== 1 || state.oneWindow?.playerId !== pending.playerId) {
    return;
  }

  player.calledOne = true;
  delete state.oneWindow;
  pushLog(state, "one", `${player.nickname} called One.`);
}

function closeOneWindowForPlayer(state: GameStateInternal, playerId: string): void {
  if (state.oneWindow?.playerId === playerId) {
    delete state.oneWindow;
  }

  if (state.pendingOneCall?.playerId === playerId) {
    delete state.pendingOneCall;
  }
}

function ensureNoActiveOneWindow(state: GameStateInternal): void {
  if (!hasActiveOneWindow(state)) {
    return;
  }

  throw new GameError("one_window_active", "Resolve the One window first.");
}

function hasActiveOneWindow(state: GameStateInternal): boolean {
  const active = state.oneWindow;
  if (!active) {
    return false;
  }

  if (Date.now() > active.deadline && state.pendingOneCall?.playerId !== active.playerId) {
    closeOneWindowForPlayer(state, active.playerId);
    return false;
  }

  return true;
}

function syncPlayerHandChange(state: GameStateInternal, player: PlayerState): void {
  player.cardCount = player.hand.length;

  if (player.hand.length !== 1) {
    player.calledOne = false;
    closeOneWindowForPlayer(state, player.id);
  }
}

// Penalty draws degrade gracefully when every card is already in players'
// hands: take what is available instead of throwing mid-mutation.
function drawMany(state: GameStateInternal, player: PlayerState, count: number): void {
  if (player.finishedRank) {
    return;
  }

  for (let index = 0; index < count; index += 1) {
    const card = takeCard(state);
    if (!card) {
      pushLog(state, "round", "The draw pile ran out of cards.");
      break;
    }

    player.hand.push(card);
  }

  syncPlayerHandChange(state, player);
}

function takeCard(state: GameStateInternal): Card | undefined {
  if (state.drawPile.length === 0) {
    reshuffleDiscard(state);
  }

  if (state.drawPile.length === 0) {
    addFreshDeck(state);
  }

  return state.drawPile.pop();
}

// Every card can end up in players' hands with nothing left to recycle from
// the discard pile. Open a brand-new 108-card deck (with an unused deckIndex
// so card ids stay unique) instead of stalling the game.
function addFreshDeck(state: GameStateInternal): void {
  const inPlay = [...state.drawPile, ...state.discardPile, ...state.players.flatMap((player) => player.hand)];
  const nextDeckIndex = inPlay.reduce((max, item) => Math.max(max, item.deckIndex), -1) + 1;

  state.drawPile = shuffleCards(buildSingleDeck(nextDeckIndex));
  pushLog(state, "round", "A fresh deck of 108 cards was added to the draw pile.");
}

// Only used while dealing, where the deck can never run dry (10 × 7 + 1 < 108).
function drawOne(state: GameStateInternal): Card {
  const card = takeCard(state);
  if (!card) {
    throw new GameError("empty_deck", "No cards are available to draw.");
  }

  return card;
}

function ensureDealing(state: GameStateInternal): RoundDealState {
  if (state.phase !== "dealing" || !state.roundDeal) {
    throw new GameError("not_dealing", "The round is not currently being dealt.");
  }
  return state.roundDeal;
}

function ensureRoundDealer(state: GameStateInternal, playerId: string): RoundDealState {
  const deal = ensureDealing(state);
  syncRoundDealer(state);
  if (!deal.dealerPlayerId || deal.dealerPlayerId !== playerId) {
    throw new GameError("not_dealer", "Only the assigned dealer can do that.");
  }
  const dealer = findPlayer(state, playerId);
  ensurePlayerInteractive(dealer);
  return deal;
}

function syncRoundDealer(state: GameStateInternal): boolean {
  const deal = state.roundDeal;
  if (state.phase !== "dealing" || !deal || !isLastStand(state)) {
    return false;
  }

  const current = deal.dealerPlayerId ? state.players.find((player) => player.id === deal.dealerPlayerId) : undefined;
  if (current && isAvailablePlayer(current)) {
    return false;
  }

  const replacement =
    state.players.find((player) => player.isHost && isAvailablePlayer(player)) ??
    sortedPlayers(state).find(isAvailablePlayer);
  const nextId = replacement?.id;
  if (nextId === deal.dealerPlayerId) {
    return false;
  }

  if (nextId) {
    deal.dealerPlayerId = nextId;
  } else {
    delete deal.dealerPlayerId;
  }
  if (!deal.event) {
    if (nextId) {
      deal.inactivityDeadline = Date.now() + DEAL_INACTIVITY_MS;
    } else {
      delete deal.inactivityDeadline;
    }
  }
  if (replacement) {
    pushLog(state, "deal", `${replacement.nickname} is now the dealer.`);
  }
  return true;
}

function scheduleAutoDeal(state: GameStateInternal): void {
  const deal = ensureDealing(state);
  if (deal.event || state.dealQueue) {
    return;
  }

  const players = sortedPlayers(state);
  const starterIndex = Math.max(0, players.findIndex((player) => player.id === deal.firstPlayerId));
  const ordered = players.map((_, index) => players[(starterIndex + index) % players.length]!);
  const counts = new Map(players.map((player) => [player.id, player.hand.length]));
  const targets: string[] = [];

  while ([...counts.values()].some((count) => count < deal.cardsPerPlayer)) {
    for (const player of ordered) {
      const count = counts.get(player.id) ?? 0;
      if (count >= deal.cardsPerPlayer) {
        continue;
      }
      targets.push(player.id);
      counts.set(player.id, count + 1);
    }
  }

  if (targets.length === 0) {
    scheduleOpeningCard(state);
    return;
  }

  deal.stage = "auto";
  scheduleDealSequence(state, targets, true);
}

function scheduleDealSequence(state: GameStateInternal, targetPlayerIds: string[], adaptive: boolean): void {
  const deal = ensureDealing(state);
  const cards = targetPlayerIds.map(() => drawOne(state));
  const startsAt = Date.now() + dealSyncLead(state);
  const targetDuration = Math.min(
    AUTO_DEAL_MAX_DURATION_MS,
    Math.max(AUTO_DEAL_MIN_DURATION_MS, targetPlayerIds.length * AUTO_DEAL_BASE_INTERVAL_MS)
  );
  const cardIntervalMs = adaptive && targetPlayerIds.length > 1
    ? Math.max(80, Math.round(targetDuration / targetPlayerIds.length))
    : 0;
  const resolvesAt = startsAt + (targetPlayerIds.length - 1) * cardIntervalMs + DEAL_FLIGHT_DURATION_MS;
  const event: RoundDealEvent = {
    id: nextDealEventId(state),
    kind: "deal",
    targetPlayerIds,
    startsAt,
    cardIntervalMs,
    resolvesAt
  };

  state.dealQueue = { cards, targetPlayerIds, nextIndex: 0 };
  deal.event = event;
  delete deal.inactivityDeadline;
}

function scheduleOpeningCard(state: GameStateInternal): void {
  const deal = ensureDealing(state);
  let opener = drawOne(state);
  while (opener.value === "wild4") {
    state.drawPile.unshift(opener);
    state.drawPile = shuffleCards(state.drawPile);
    opener = drawOne(state);
  }

  deal.stage = "opening";
  delete deal.inactivityDeadline;
  const startsAt = Date.now() + dealSyncLead(state);
  deal.event = {
    id: nextDealEventId(state),
    kind: "opening",
    card: opener,
    startsAt,
    resolvesAt: startsAt + OPENING_DURATION_MS
  };
}

function syncDealProgress(state: GameStateInternal): void {
  const deal = ensureDealing(state);
  deal.readyPlayerCount = state.players.filter((player) => player.hand.length >= deal.cardsPerPlayer).length;
}

function dealSyncLead(state: GameStateInternal): number {
  const maxPing = Math.max(...state.players.filter(isAvailablePlayer).map((player) => player.ping), 0);
  return Math.max(DEAL_SYNC_MIN_LEAD_MS, Math.ceil(maxPing / 2) + DEAL_SYNC_EXTRA_MS);
}

function nextDealEventId(state: GameStateInternal): number {
  state.dealEventSeq += 1;
  return state.dealEventSeq;
}

function reshuffleDiscard(state: GameStateInternal): void {
  if (state.discardPile.length <= 1) {
    return;
  }

  const top = state.discardPile.pop()!;
  state.drawPile = shuffleCards(state.discardPile);
  state.discardPile = [top];
  pushLog(state, "round", "Discard pile was shuffled into the draw pile.");
}

function advanceTurn(state: GameStateInternal, skippedPlayers = 0): void {
  state.currentSeat = seatAfter(state, state.currentSeat, skippedPlayers + 1);
  delete state.autoPlayPendingAt;
  setTurnDeadline(state);
}

function seatAfter(state: GameStateInternal, seat: number, steps = 1): number {
  const players = activePlayers(state);
  if (players.length === 0) {
    return sortedPlayers(state)[0]?.seat ?? 0;
  }

  const index = players.findIndex((player) => player.seat === seat);
  if (index < 0) {
    const ordered = state.direction === 1 ? players : [...players].reverse();
    const next = ordered.find((player) => (state.direction === 1 ? player.seat > seat : player.seat < seat));
    return (next ?? ordered[0])?.seat ?? 0;
  }

  const nextIndex = (index + state.direction * steps + players.length * steps) % players.length;
  return players[nextIndex]!.seat;
}

function sortedPlayers(state: GameStateInternal): PlayerState[] {
  return [...state.players].sort((a, b) => a.seat - b.seat);
}

function activePlayers(state: GameStateInternal): PlayerState[] {
  const players = sortedPlayers(state);
  if (!isLastStand(state) || state.phase !== "playing") {
    return players;
  }

  return players.filter((player) => !player.finishedRank);
}

function isLastStand(state: GameStateInternal): boolean {
  return state.settings.scoreTarget === "lastStand";
}

function sortedViewers(state: GameStateInternal): ViewerState[] {
  return [...state.viewers].sort((a, b) => a.nickname.localeCompare(b.nickname));
}

function toPublicPlayer(player: PlayerState): PublicPlayer {
  return {
    id: player.id,
    nickname: player.nickname,
    avatarId: player.avatarId,
    seat: player.seat,
    cardCount: player.hand.length,
    score: player.score,
    connected: player.connected,
    away: player.away,
    isHost: player.isHost,
    ready: player.ready,
    calledOne: player.calledOne,
    autoPlay: player.autoPlay,
    missedDisconnectedTurns: player.missedDisconnectedTurns,
    ping: player.ping,
    ...(player.finishedRank ? { finishedRank: player.finishedRank } : {})
  };
}

function connectPlayer(state: GameStateInternal, player: PlayerState): void {
  const wasConnected = player.connected;
  player.connected = true;
  player.away = false;
  player.missedDisconnectedTurns = 0;
  player.autoPlay = false;
  assignHost(state);
  syncPauseState(state);
  syncRoundDealer(state);
  if (!wasConnected) {
    pushLog(state, "room", `${player.nickname} reconnected.`);
  }
}

function promoteWaitingPlayers(state: GameStateInternal): void {
  if (!state.settings.allowMidGameJoin) {
    return;
  }

  const waiting = state.viewers.filter((viewer) => viewer.role === "waiting" && viewer.connected);
  for (const viewer of waiting) {
    if (state.players.length >= state.settings.maxPlayers) {
      return;
    }

    state.players.push({
      id: viewer.id,
      nickname: viewer.nickname,
      avatarId: viewer.avatarId,
      seat: nextOpenSeat(state),
      cardCount: 0,
      score: 0,
      connected: true,
      away: false,
      isHost: false,
      ready: false,
      calledOne: false,
      autoPlay: false,
      missedDisconnectedTurns: 0,
      ping: 0,
      hand: [],
      resumeToken: createResumeToken(state)
    });
    state.viewers = state.viewers.filter((item) => item.id !== viewer.id);
    pushLog(state, "room", `${viewer.nickname} joined the next round.`);
  }

  syncDeckBoxMinimum(state);
  assignHost(state);
}

function rebindPlayerSession(state: GameStateInternal, oldId: string, newId: string): void {
  if (oldId === newId) {
    return;
  }

  const player = findPlayer(state, oldId);
  player.id = newId;
  state.viewers = state.viewers.filter((viewer) => viewer.id !== newId);

  if (state.pendingChallenge?.offenderId === oldId) {
    state.pendingChallenge.offenderId = newId;
  }

  if (state.pendingChallenge?.challengerId === oldId) {
    state.pendingChallenge.challengerId = newId;
  }

  if (state.oneWindow?.playerId === oldId) {
    state.oneWindow.playerId = newId;
  }

  if (state.pendingOneCall?.playerId === oldId) {
    state.pendingOneCall.playerId = newId;
  }

  if (state.pendingStack?.targetPlayerId === oldId) {
    state.pendingStack.targetPlayerId = newId;
  }

  if (state.pendingStack?.offenderId === oldId) {
    state.pendingStack.offenderId = newId;
  }

  if (state.pendingStack?.roundWinnerId === oldId) {
    state.pendingStack.roundWinnerId = newId;
  }

  if (state.pendingBatchPlay?.playerId === oldId) {
    state.pendingBatchPlay.playerId = newId;
  }

  if (state.roundDeal?.dealerPlayerId === oldId) {
    state.roundDeal.dealerPlayerId = newId;
  }

  if (state.roundDeal?.firstPlayerId === oldId) {
    state.roundDeal.firstPlayerId = newId;
  }

  if (state.roundDeal?.event?.kind === "shuffle" && state.roundDeal.event.playerId === oldId) {
    state.roundDeal.event.playerId = newId;
  }

  if (state.roundDeal?.event?.kind === "deal") {
    state.roundDeal.event.targetPlayerIds = state.roundDeal.event.targetPlayerIds.map((id) => id === oldId ? newId : id);
  }

  if (state.dealQueue) {
    state.dealQueue.targetPlayerIds = state.dealQueue.targetPlayerIds.map((id) => id === oldId ? newId : id);
  }

  if (state.roundWinnerId === oldId) {
    state.roundWinnerId = newId;
  }

  if (state.gameWinnerId === oldId) {
    state.gameWinnerId = newId;
  }

  if (state.lastStandPlacements) {
    state.lastStandPlacements = state.lastStandPlacements.map((placement) =>
      placement.playerId === oldId ? { ...placement, playerId: newId } : placement
    );
  }
}

function createResumeToken(state: GameStateInternal): string {
  let token = randomBytes(RESUME_TOKEN_BYTES).toString("base64url");
  const existing = new Set(state.players.map((player) => player.resumeToken));

  while (existing.has(token)) {
    token = randomBytes(RESUME_TOKEN_BYTES).toString("base64url");
  }

  return token;
}

function requiredDeckBoxes(playerCount: number): number {
  return Math.max(1, Math.ceil(playerCount / 4));
}

function syncDeckBoxMinimum(state: GameStateInternal): void {
  state.settings.deckBoxes = Math.max(state.settings.deckBoxes, requiredDeckBoxes(state.players.length));
}

function markMissedDisconnectedTurn(state: GameStateInternal, player: PlayerState): void {
  if (player.connected || player.finishedRank) {
    return;
  }

  player.missedDisconnectedTurns += 1;
}

function syncAbsentAutomation(state: GameStateInternal, player: PlayerState): void {
  player.autoPlay = (!player.connected || player.away) && state.settings.absentPlayerAction !== "none";
}

function isAutoControllable(state: GameStateInternal, player: PlayerState): boolean {
  return state.settings.absentPlayerAction !== "none" && player.autoPlay && !player.finishedRank && (!player.connected || player.away);
}

function autoActionDelayElapsed(state: GameStateInternal): boolean {
  const now = Date.now();
  if (state.autoPlayPendingAt === undefined) {
    state.autoPlayPendingAt = now;
    return false;
  }

  if (now - state.autoPlayPendingAt < AUTO_ACTION_DELAY_MS) {
    return false;
  }

  delete state.autoPlayPendingAt;
  return true;
}

function autoDrawTurn(state: GameStateInternal, player: PlayerState): void {
  if (!player.drawnCardId) {
    drawCard(state, player.id, true);
    if (player.drawnCardId) {
      state.autoPlayPendingAt = Date.now();
    }
    return;
  }

  delete player.drawnCardId;
  pushLog(state, "draw", `${player.nickname} auto-passed ${autoPlayReason(player)}.`);
  advanceTurn(state);
}

function autoPlayTurn(state: GameStateInternal, player: PlayerState): void {
  if (player.finishedRank) {
    advanceTurn(state);
    return;
  }

  // Normal turn: play the best matching card if one exists.
  if (!player.drawnCardId) {
    const pick = pickAutoPlay(state, player);
    if (pick) {
      playCard(state, player.id, pick.cardId, pick.declaredColor, true);
      return;
    }

    // Nothing playable: pull one card and leave it pending so every client can
    // show the draw before the follow-up play or pass.
    drawCard(state, player.id, true);
    if (player.drawnCardId) {
      state.autoPlayPendingAt = Date.now();
    }
    return;
  }

  const drawn = player.hand.find((item) => item.id === player.drawnCardId);
  if (drawn && autoCardPlayable(state, player, drawn)) {
    const declaredColor = needsDeclaredColor(drawn) ? chooseAutoColor(player, drawn.id) : undefined;
    playCard(state, player.id, player.drawnCardId, declaredColor, true);
    return;
  }

  delete player.drawnCardId;
  pushLog(state, "draw", `${player.nickname} auto-passed ${autoPlayReason(player)}.`);
  advanceTurn(state);
}

function pickAutoPlay(
  state: GameStateInternal,
  player: PlayerState
): { cardId: string; declaredColor?: Color } | undefined {
  const playable = player.hand.filter((card) => autoCardPlayable(state, player, card));
  if (playable.length === 0) {
    return undefined;
  }

  // Conserve wilds: prefer colored matches, then Wild, then Wild Draw Four.
  const rank = (card: Card): number => (card.value === "wild4" ? 2 : card.value === "wild" ? 1 : 0);
  const chosen = [...playable].sort((a, b) => rank(a) - rank(b))[0]!;
  return {
    cardId: chosen.id,
    ...(needsDeclaredColor(chosen) ? { declaredColor: chooseAutoColor(player, chosen.id) } : {})
  };
}

function autoCardPlayable(state: GameStateInternal, player: PlayerState, card: Card): boolean {
  const activeColor = state.activeColor;
  if (!activeColor) {
    return false;
  }

  return getMode(state.settings).isPlayable(card, {
    playerId: player.id,
    activeColor,
    discardTop: topDiscard(state),
    hand: player.hand,
    playerCount: activePlayers(state).length
  });
}

function autoStackCardId(player: PlayerState, stack: PendingStack): string | undefined {
  return player.hand.find((card) => canStackCard(card, stack))?.id;
}

function needsDeclaredColor(card: Card): boolean {
  return card.value === "wild" || card.value === "wild4";
}

function chooseAutoColor(player: PlayerState, excludeCardId?: string): Color {
  const counts = new Map<Color, number>();
  for (const card of player.hand) {
    if (card.id === excludeCardId || !card.color) {
      continue;
    }
    counts.set(card.color, (counts.get(card.color) ?? 0) + 1);
  }

  let best: Color | undefined;
  let bestCount = 0;
  for (const color of COLORS) {
    const count = counts.get(color) ?? 0;
    if (count > bestCount) {
      bestCount = count;
      best = color;
    }
  }

  return best ?? randomColor();
}

function autoPlayReason(player: PlayerState): string {
  return player.away ? "while away" : "while disconnected";
}

function viewerRoleLabel(role: Exclude<ParticipantRole, "player">): string {
  return role === "waiting" ? "a waiting player" : "a spectator";
}

function findPlayer(state: GameStateInternal, id: string): PlayerState {
  const player = state.players.find((item) => item.id === id);
  if (!player) {
    throw new GameError("player_not_found", "Player was not found.");
  }

  return player;
}

function findPlayerBySeat(state: GameStateInternal, seat: number): PlayerState {
  const player = state.players.find((item) => item.seat === seat);
  if (!player) {
    throw new GameError("player_not_found", "Player was not found.");
  }

  return player;
}

function currentPlayer(state: GameStateInternal): PlayerState {
  const player = findPlayerBySeat(state, state.currentSeat);
  if (!player.finishedRank) {
    return player;
  }

  state.currentSeat = seatAfter(state, player.seat);
  return findPlayerBySeat(state, state.currentSeat);
}

function assignHost(state: GameStateInternal): void {
  if (state.players.some((player) => player.isHost && player.connected && !player.away)) {
    return;
  }

  for (const player of state.players) {
    player.isHost = false;
  }

  const nextHost = state.players.find((player) => player.connected && !player.away) ?? state.players.find((player) => player.connected) ?? state.players[0];
  if (nextHost) {
    nextHost.isHost = true;
    pushLog(state, "room", `${nextHost.nickname} is now the host.`);
  }
}

function nextOpenSeat(state: GameStateInternal): number {
  const taken = new Set(state.players.map((player) => player.seat));
  for (let seat = 0; seat < state.settings.maxPlayers; seat += 1) {
    if (!taken.has(seat)) {
      return seat;
    }
  }

  return state.players.length;
}

function topDiscard(state: GameStateInternal): Card {
  const card = state.discardPile.at(-1);
  if (!card) {
    throw new GameError("missing_discard", "Discard pile is empty.");
  }

  return card;
}

function randomColor(): Color {
  return COLORS[Math.floor(Math.random() * COLORS.length)]!;
}

function setTurnDeadline(state: GameStateInternal): void {
  if (state.pendingBatchPlay) {
    delete state.turnDeadline;
    return;
  }

  const pause = syncPauseState(state);
  if (pause.paused) {
    return;
  }

  state.turnDeadline = Date.now() + state.settings.turnTimeoutSec * 1000;
}

function syncPauseState(state: GameStateInternal): { paused: boolean; changed: boolean } {
  if (state.phase !== "playing") {
    const changed = Boolean(state.pauseReason);
    delete state.pauseReason;
    return { paused: false, changed };
  }

  if (availablePlayers(state).length < 2) {
    const changed = state.pauseReason !== "notEnoughAvailablePlayers" || state.turnDeadline !== undefined;
    if (!state.pauseReason) {
      pushLog(state, "room", "Game paused until at least two active players return.");
    }
    state.pauseReason = "notEnoughAvailablePlayers";
    delete state.turnDeadline;
    return { paused: true, changed };
  }

  if (state.pauseReason) {
    delete state.pauseReason;
    if (!isAvailablePlayer(currentPlayer(state))) {
      state.currentSeat = nextAvailableSeatAfter(state, state.currentSeat);
    }
    state.turnDeadline = Date.now() + state.settings.turnTimeoutSec * 1000;
    pushLog(state, "room", "Game resumed.");
    return { paused: false, changed: true };
  }

  return { paused: false, changed: false };
}

function availablePlayers(state: GameStateInternal): PlayerState[] {
  return activePlayers(state).filter(isAvailablePlayer);
}

function isAvailablePlayer(player: PlayerState): boolean {
  return player.connected && !player.away && !player.finishedRank;
}

function nextAvailableSeatAfter(state: GameStateInternal, seat: number): number {
  const players = availablePlayers(state);
  if (players.length === 0) {
    return seat;
  }

  const ordered = state.direction === 1 ? players : [...players].reverse();
  const next = ordered.find((player) => (state.direction === 1 ? player.seat > seat : player.seat < seat));
  return (next ?? ordered[0])!.seat;
}

function ensurePlaying(state: GameStateInternal): void {
  if (state.phase !== "playing") {
    throw new GameError("not_playing", "The game is not currently playing.");
  }
}

function ensureNotPaused(state: GameStateInternal): void {
  if (syncPauseState(state).paused) {
    throw new GameError("game_paused", "The game is paused until at least two active players return.");
  }
}

function ensurePlayerInRound(player: PlayerState): void {
  if (player.finishedRank) {
    throw new GameError("round_finished", "You have already finished this round.");
  }
}

function ensurePlayerInteractive(player: PlayerState): void {
  if (!player.connected || player.away) {
    throw new GameError("player_away", "You are away from the table.");
  }
}

function ensureNoPendingChallenge(state: GameStateInternal): void {
  if (state.pendingChallenge) {
    throw new GameError("pending_challenge", "Resolve the Wild Draw Four challenge first.");
  }
}

function ensureNoPendingOneCall(state: GameStateInternal): void {
  const pending = state.pendingOneCall;
  if (!pending) {
    return;
  }

  if (Date.now() >= pending.resolvesAt) {
    finalizePendingOneCall(state);
    return;
  }

  throw new GameError("one_call_pending", "A One call is still being resolved.");
}

function ensureNoPendingBatchPlay(state: GameStateInternal): void {
  if (state.pendingBatchPlay) {
    throw new GameError("batch_in_progress", "Wait for the current batch to finish.");
  }
}

function cardLabel(card: Card): string {
  const color = card.color ? `${card.color} ` : "";
  return `${color}${card.value}`;
}

function batchValueLabel(card: Card): string {
  return String(card.value);
}

function emoteText(emoteId: string): string {
  const map: Record<string, string> = {
    hello: "Hello!",
    nice: "Nice play.",
    oops: "Oops.",
    close: "That was close.",
    gg: "Good game."
  };

  return map[emoteId] ?? "Hello!";
}

function pushLog(state: GameStateInternal, type: GameLogEntry["type"], message: string): void {
  state.seq += 1;
  state.actionLog.push({
    seq: state.seq,
    type,
    message,
    at: Date.now()
  });

  if (state.actionLog.length > 60) {
    state.actionLog = state.actionLog.slice(-60);
  }
}
