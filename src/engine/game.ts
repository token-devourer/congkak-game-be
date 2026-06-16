import { randomBytes } from "node:crypto";
import type {
  Card,
  Color,
  GameLogEntry,
  GameMode,
  GamePhase,
  GameSnapshot,
  LastStandPlacement,
  PauseReason,
  ParticipantRole,
  PendingChallenge,
  PendingStack,
  PublicPlayer,
  PublicViewer,
  RoomSettings,
  RoomSettingsInput
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
const AUTO_PLAY_AFTER_MISSED_TURNS = 2;
const RESUME_TOKEN_BYTES = 24;

export interface PlayerState extends PublicPlayer {
  hand: Card[];
  drawnCardId?: string;
  resumeToken: string;
}

export type ViewerState = PublicViewer;

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
  pauseReason?: PauseReason;
  oneWindow?: { playerId: string; opensAt: number; deadline: number };
  pendingOneCall?: { playerId: string; resolvesAt: number };
  roundNumber: number;
  seq: number;
  actionLog: GameLogEntry[];
  roundWinnerId?: string;
  gameWinnerId?: string;
  lastStandPlacements?: LastStandPlacement[];
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
    actionLog: []
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
    pushLog(state, "room", `${player.nickname} disconnected.`);
    assignHost(state);
    syncPauseState(state);
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
  player.autoPlay = away;
  pushLog(state, "room", away ? `${player.nickname} is away.` : `${player.nickname} returned to the table.`);
  assignHost(state);
  syncPauseState(state);
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
    syncPauseState(state);
  }

  pushLog(state, "room", `${player.nickname} left the room.`);
  assignHost(state);
}

export function setReady(state: GameStateInternal, id: string, ready: boolean): void {
  const player = findPlayer(state, id);
  ensurePlayerInteractive(player);
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

  const nextSettings = mergeRoomSettings({ ...state.settings, ...input });
  if (nextSettings.maxPlayers < state.players.length) {
    throw new GameError("max_players_too_low", "Max players cannot be lower than the current room size.");
  }

  if (nextSettings.deckBoxes < requiredDeckBoxes(state.players.length)) {
    throw new GameError("deck_boxes_too_low", "Deck boxes cannot be lower than the room minimum.");
  }

  state.settings = nextSettings;
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
  if (state.phase === "playing") {
    throw new GameError("game_in_progress", "This round is already in progress.");
  }

  if (state.phase === "gameEnd") {
    throw new GameError("game_finished", "This game has already ended.");
  }

  const mode = getMode(state.settings);

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

  state.phase = "playing";
  state.direction = 1;
  state.settings.deckBoxes = Math.max(state.settings.deckBoxes, requiredDeckBoxes(activePlayers.length));
  state.drawPile = mode.buildDeck(activePlayers.length, state.settings.deckBoxes);
  state.discardPile = [];
  delete state.pendingChallenge;
  delete state.pendingStack;
  delete state.pauseReason;
  delete state.oneWindow;
  delete state.pendingOneCall;
  delete state.roundWinnerId;
  delete state.gameWinnerId;
  delete state.lastStandPlacements;
  state.roundNumber += 1;

  for (const player of state.players) {
    player.hand = [];
    player.cardCount = 0;
    player.calledOne = false;
    player.ready = false;
    delete player.drawnCardId;
    delete player.finishedRank;
  }

  for (let count = 0; count < mode.initialHandSize; count += 1) {
    for (const player of activePlayers) {
      player.hand.push(drawOne(state));
      player.cardCount = player.hand.length;
    }
  }

  let opener = drawOne(state);
  while (opener.value === "wild4") {
    state.drawPile.unshift(opener);
    state.drawPile = shuffleCards(state.drawPile);
    opener = drawOne(state);
  }

  state.discardPile.push(opener);
  state.activeColor = opener.color ?? randomColor();
  state.currentSeat = activePlayers[0]!.seat;
  applyOpeningCard(state, opener);
  setTurnDeadline(state);
  pushLog(state, "round", `Round ${state.roundNumber} started.`);
}

export function playCard(state: GameStateInternal, playerId: string, cardId: string, declaredColor?: Color): void {
  ensurePlaying(state);
  ensureNoPendingOneCall(state);
  ensureNotPaused(state);
  const mode = getMode(state.settings);
  const current = currentPlayer(state);
  let player = current.id === playerId ? current : findPlayer(state, playerId);
  const actingOutOfTurn = current.id !== playerId;
  ensurePlayerInteractive(player);
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
    applyPlayedCard(state, player, card, handBefore, { resetStackFromJumpIn: jumpingIntoStack });
  }

  if (!state.pendingChallenge && !state.pendingStack && player.hand.length === 0) {
    finishPlayerOrCompleteRound(state, player.id);
  }
}

export function drawCard(state: GameStateInternal, playerId: string): void {
  ensurePlaying(state);
  ensureNoPendingOneCall(state);
  ensureNotPaused(state);
  ensureNoPendingChallenge(state);
  const mode = getMode(state.settings);
  const player = currentPlayer(state);

  if (player.id !== playerId) {
    throw new GameError("not_your_turn", "It is not your turn.");
  }

  ensurePlayerInteractive(player);

  if (player.drawnCardId) {
    throw new GameError("already_drew", "You already drew a card this turn.");
  }

  ensureNoActiveOneWindow(state);

  if (state.pendingStack) {
    const stack = state.pendingStack;
    if (canPlayerStack(player, stack)) {
      throw new GameError("stack_required", "You must stack a matching draw card.");
    }

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
    delete player.drawnCardId;
    advanceTurn(state);
  }
}

export function playDrawn(state: GameStateInternal, playerId: string, play: boolean, declaredColor?: Color): void {
  ensurePlaying(state);
  ensureNoPendingOneCall(state);
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

export function callOne(state: GameStateInternal, playerId: string): void {
  ensurePlaying(state);
  ensureNotPaused(state);
  const player = findPlayer(state, playerId);
  ensurePlayerInteractive(player);
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
    const totalDraw = challengeableStack?.totalDraw ?? 4;
    drawMany(state, challenger, totalDraw);
    state.currentSeat = seatAfter(state, challenger.seat);
    pushLog(state, "challenge", totalDraw === 4 ? `${challenger.nickname} took four cards.` : `${challenger.nickname} took ${totalDraw} cards.`);
  } else if (pending.guilty) {
    drawMany(state, offender, 4);
    state.currentSeat = challenger.seat;
    pushLog(state, "challenge", `${challenger.nickname} won the challenge.`);
  } else {
    drawMany(state, challenger, 6);
    state.currentSeat = seatAfter(state, challenger.seat);
    pushLog(state, "challenge", `${challenger.nickname} lost the challenge and drew six.`);
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
    drawPileCount: state.drawPile.length,
    actionLog: state.actionLog.slice(-30)
  };

  if (self) {
    snapshot.self = {
      id: self.id,
      role: "player",
      hand: self.hand,
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
  const limit = state.players.length + 5;

  for (let count = 0; count < limit; count += 1) {
    if (state.phase !== "playing" || state.pendingOneCall) {
      return changed;
    }

    if (hasActiveOneWindow(state)) {
      return changed;
    }

    const pending = state.pendingChallenge;
    if (pending) {
      const challenger = findPlayer(state, pending.challengerId);
      if (isAutoControllable(challenger)) {
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

      if (!isAutoControllable(player)) {
        return changed;
      }

      resolveStackDraw(state, player);
      changed = true;
      continue;
    }

    if (!isAutoControllable(player)) {
      return changed;
    }

    autoDrawAndPass(state, player);
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

function applyPlayedCard(
  state: GameStateInternal,
  player: PlayerState,
  card: Card,
  handBefore: Card[],
  options: { resetStackFromJumpIn?: boolean } = {}
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
      const previousColor = colorBeforeWild(state);
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
    const previousColor = colorBeforeWild(state);
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
      guilty: challenge.guilty
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

function completeRound(state: GameStateInternal, winnerId: string): void {
  const mode = getMode(state.settings);
  const winner = findPlayer(state, winnerId);
  const score = state.players
    .filter((player) => player.id !== winnerId)
    .reduce((total, player) => total + mode.scoreHand(player.hand), 0);

  winner.score += score;
  state.phase = state.settings.scoreTarget === 500 && winner.score >= 500 ? "gameEnd" : "roundEnd";
  state.roundWinnerId = winner.id;
  if (state.phase === "gameEnd") {
    state.gameWinnerId = winner.id;
  }

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
  if (!player.autoPlay && player.missedDisconnectedTurns >= AUTO_PLAY_AFTER_MISSED_TURNS) {
    player.autoPlay = true;
    pushLog(state, "room", `${player.nickname} is on auto play until they reconnect.`);
  }
}

function isAutoControllable(player: PlayerState): boolean {
  return player.autoPlay && !player.finishedRank && (!player.connected || player.away);
}

function autoDrawAndPass(state: GameStateInternal, player: PlayerState): void {
  if (player.finishedRank) {
    advanceTurn(state);
    return;
  }

  if (player.drawnCardId) {
    delete player.drawnCardId;
    pushLog(state, "draw", `${player.nickname} auto-passed ${autoPlayReason(player)}.`);
  } else {
    drawMany(state, player, 1);
    delete player.drawnCardId;
    pushLog(state, "draw", `${player.nickname} auto-drew one card ${autoPlayReason(player)}.`);
  }

  advanceTurn(state);
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

function colorBeforeWild(state: GameStateInternal): Color | undefined {
  for (let index = state.discardPile.length - 2; index >= 0; index -= 1) {
    const card = state.discardPile[index];
    if (card?.color) {
      return card.color;
    }
  }

  return state.activeColor;
}

function randomColor(): Color {
  return COLORS[Math.floor(Math.random() * COLORS.length)]!;
}

function setTurnDeadline(state: GameStateInternal): void {
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

function cardLabel(card: Card): string {
  const color = card.color ? `${card.color} ` : "";
  return `${color}${card.value}`;
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
