import type {
  Card,
  Color,
  GameLogEntry,
  GameMode,
  GamePhase,
  GameSnapshot,
  PendingChallenge,
  PublicPlayer,
  RoomSettings,
  RoomSettingsInput
} from "@congcard/shared";
import { COLORS, mergeRoomSettings } from "@congcard/shared";
import { standardMode, shuffleCards, buildSingleDeck } from "./modes/standard.js";

const ONE_CALL_DELAY_MS = 1200;
const ONE_CALL_WINDOW_MS = 3000;
const ONE_CALL_SETTLE_MS = 250;

export interface PlayerState extends PublicPlayer {
  hand: Card[];
  drawnCardId?: string;
}

export interface GameStateInternal {
  code: string;
  phase: GamePhase;
  settings: RoomSettings;
  players: PlayerState[];
  drawPile: Card[];
  discardPile: Card[];
  activeColor?: Color;
  direction: 1 | -1;
  currentSeat: number;
  turnDeadline?: number;
  pendingChallenge?: PendingChallenge;
  oneWindow?: { playerId: string; opensAt: number; deadline: number };
  pendingOneCall?: { playerId: string; resolvesAt: number };
  roundNumber: number;
  seq: number;
  actionLog: GameLogEntry[];
  roundWinnerId?: string;
  gameWinnerId?: string;
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

export function addPlayer(state: GameStateInternal, id: string, nickname: string, avatarId: string): void {
  const existing = state.players.find((player) => player.id === id);
  if (existing) {
    existing.connected = true;
    pushLog(state, "room", `${existing.nickname} reconnected.`);
    return;
  }

  if (state.phase !== "lobby") {
    throw new GameError("game_in_progress", "This room is already playing.");
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
    isHost: state.players.length === 0,
    ready: false,
    calledOne: false,
    hand: []
  });
  pushLog(state, "room", `${nickname} joined the room.`);
}

export function setPlayerConnected(state: GameStateInternal, id: string, connected: boolean): void {
  const player = findPlayer(state, id);
  player.connected = connected;
  if (!connected) {
    player.ready = false;
    pushLog(state, "room", `${player.nickname} disconnected.`);
  } else {
    pushLog(state, "room", `${player.nickname} reconnected.`);
  }
}

export function removePlayer(state: GameStateInternal, id: string): void {
  const player = findPlayer(state, id);
  if (state.phase === "lobby") {
    state.players = state.players.filter((item) => item.id !== id);
  } else {
    player.connected = false;
    player.ready = false;
  }

  pushLog(state, "room", `${player.nickname} left the room.`);
  assignHost(state);
}

export function setReady(state: GameStateInternal, id: string, ready: boolean): void {
  const player = findPlayer(state, id);
  player.ready = ready;
  pushLog(state, "room", `${player.nickname} is ${ready ? "ready" : "not ready"}.`);
}

export function updateSettings(state: GameStateInternal, id: string, input: RoomSettingsInput): void {
  const player = findPlayer(state, id);
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

  state.settings = nextSettings;
  pushLog(state, "room", "Room settings were updated.");
}

export function kickPlayer(state: GameStateInternal, hostId: string, targetId: string): void {
  const host = findPlayer(state, hostId);
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
      completeRound(state, remaining.id);
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
  const activePlayers = sortedPlayers(state).filter((player) => player.connected);

  if (activePlayers.length < 2) {
    throw new GameError("not_enough_players", "At least two connected players are required.");
  }

  if (state.phase === "lobby" && activePlayers.some((player) => !player.ready && !player.isHost)) {
    throw new GameError("players_not_ready", "All non-host players must be ready.");
  }

  if (activePlayers.length !== state.players.length) {
    state.players = activePlayers;
    assignHost(state);
    pushLog(state, "room", "Disconnected players were removed before the round started.");
  }

  state.phase = "playing";
  state.direction = 1;
  state.drawPile = mode.buildDeck(activePlayers.length);
  state.discardPile = [];
  delete state.pendingChallenge;
  delete state.oneWindow;
  delete state.pendingOneCall;
  delete state.roundWinnerId;
  delete state.gameWinnerId;
  state.roundNumber += 1;

  for (const player of state.players) {
    player.hand = [];
    player.cardCount = 0;
    player.calledOne = false;
    player.ready = false;
    delete player.drawnCardId;
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
  ensureNoPendingChallenge(state);
  const mode = getMode(state.settings);
  const player = currentPlayer(state);

  if (player.id !== playerId) {
    throw new GameError("not_your_turn", "It is not your turn.");
  }

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
  if (!mode.isPlayable(card, { playerId, activeColor, discardTop, hand: player.hand, playerCount: state.players.length })) {
    throw new GameError("invalid_card", "That card cannot be played now.");
  }

  if ((card.value === "wild" || card.value === "wild4") && !declaredColor) {
    throw new GameError("color_required", "Choose a color for this Wild card.");
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
  applyPlayedCard(state, player, card, handBefore);

  if (!state.pendingChallenge && player.hand.length === 0) {
    completeRound(state, player.id);
  }
}

export function drawCard(state: GameStateInternal, playerId: string): void {
  ensurePlaying(state);
  ensureNoPendingOneCall(state);
  ensureNoPendingChallenge(state);
  const mode = getMode(state.settings);
  const player = currentPlayer(state);

  if (player.id !== playerId) {
    throw new GameError("not_your_turn", "It is not your turn.");
  }

  if (player.drawnCardId) {
    throw new GameError("already_drew", "You already drew a card this turn.");
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
  if (!activeColor || !mode.isPlayable(card, { playerId, activeColor, discardTop: topDiscard(state), hand: player.hand, playerCount: state.players.length })) {
    delete player.drawnCardId;
    advanceTurn(state);
  }
}

export function playDrawn(state: GameStateInternal, playerId: string, play: boolean, declaredColor?: Color): void {
  ensurePlaying(state);
  ensureNoPendingOneCall(state);
  ensureNoPendingChallenge(state);
  const player = currentPlayer(state);

  if (player.id !== playerId) {
    throw new GameError("not_your_turn", "It is not your turn.");
  }

  if (!player.drawnCardId) {
    throw new GameError("no_drawn_card", "There is no drawn card to resolve.");
  }

  if (play) {
    playCard(state, playerId, player.drawnCardId, declaredColor);
    return;
  }

  delete player.drawnCardId;
  pushLog(state, "draw", `${player.nickname} passed after drawing.`);
  advanceTurn(state);
}

export function callOne(state: GameStateInternal, playerId: string): void {
  ensurePlaying(state);
  const player = findPlayer(state, playerId);
  const oneWindow = state.oneWindow;
  const now = Date.now();

  if (state.pendingOneCall?.playerId === playerId) {
    return;
  }

  if (
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
  const catcher = findPlayer(state, catcherId);
  const target = findPlayer(state, targetId);
  const oneWindow = state.oneWindow;
  const pendingCall = state.pendingOneCall?.playerId === targetId;
  const catchDeadline = oneWindow ? Math.max(oneWindow.deadline, pendingCall ? state.pendingOneCall!.resolvesAt : oneWindow.deadline) : 0;
  const now = Date.now();

  if (catcherId === targetId) {
    throw new GameError("catch_failed", "You cannot catch yourself.");
  }

  if (
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
  return true;
}

export function resolveChallenge(state: GameStateInternal, playerId: string, accept: boolean): void {
  ensurePlaying(state);
  ensureNoPendingOneCall(state);
  const pending = state.pendingChallenge;
  if (!pending) {
    throw new GameError("no_challenge", "There is no Wild Draw Four to challenge.");
  }

  if (pending.challengerId !== playerId) {
    throw new GameError("not_challenger", "Only the affected player can resolve this challenge.");
  }

  const offender = findPlayer(state, pending.offenderId);
  const challenger = findPlayer(state, pending.challengerId);
  delete state.pendingChallenge;

  if (!accept) {
    drawMany(state, challenger, 4);
    state.currentSeat = seatAfter(state, challenger.seat);
    pushLog(state, "challenge", `${challenger.nickname} took four cards.`);
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
    completeRound(state, offender.id);
  }
}

export function handleTurnTimeout(state: GameStateInternal): boolean {
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

  const pending = state.pendingChallenge;
  if (pending) {
    // An unanswered Wild Draw Four must not stall the game forever: when the
    // turn timer lapses, resolve it as if the challenger declined.
    const challenger = findPlayer(state, pending.challengerId);
    const offender = findPlayer(state, pending.offenderId);
    delete state.pendingChallenge;
    drawMany(state, challenger, 4);
    state.currentSeat = seatAfter(state, challenger.seat);
    pushLog(state, "challenge", `${challenger.nickname} took four cards.`);
    setTurnDeadline(state);

    if (offender.hand.length === 0) {
      completeRound(state, offender.id);
    }

    return true;
  }

  const player = currentPlayer(state);
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
  const snapshot: GameSnapshot = {
    seq: state.seq,
    serverNow: Date.now(),
    code: state.code,
    phase: state.phase,
    settings: state.settings,
    players: sortedPlayers(state).map(toPublicPlayer),
    direction: state.direction,
    roundNumber: state.roundNumber,
    drawPileCount: state.drawPile.length,
    actionLog: state.actionLog.slice(-30)
  };

  if (self) {
    snapshot.self = {
      id: self.id,
      hand: self.hand,
      ...(self.drawnCardId ? { drawnCardId: self.drawnCardId } : {})
    };
  }

  const discardTop = state.discardPile.at(-1);
  if (discardTop) {
    snapshot.discardTop = discardTop;
  }

  if (state.activeColor) {
    snapshot.activeColor = state.activeColor;
  }

  const current = state.players.find((player) => player.seat === state.currentSeat);
  if (current && state.phase === "playing") {
    snapshot.currentPlayerId = current.id;
  }

  if (state.turnDeadline) {
    snapshot.turnDeadline = state.turnDeadline;
  }

  if (state.pendingChallenge) {
    snapshot.pendingChallenge = state.pendingChallenge;
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
  pushLog(state, "room", `${player.nickname}: ${emoteText(emoteId)}`);
}

function applyOpeningCard(state: GameStateInternal, card: Card): void {
  if (card.value === "skip") {
    state.currentSeat = seatAfter(state, state.currentSeat);
  } else if (card.value === "reverse") {
    state.direction = -1;
    if (state.players.length === 2) {
      state.currentSeat = seatAfter(state, state.currentSeat);
    }
  } else if (card.value === "draw2") {
    const target = findPlayerBySeat(state, state.currentSeat);
    drawMany(state, target, 2);
    state.currentSeat = seatAfter(state, target.seat);
  }
}

function applyPlayedCard(state: GameStateInternal, player: PlayerState, card: Card, handBefore: Card[]): void {
  if (card.value === "skip") {
    const skipped = findPlayerBySeat(state, seatAfter(state, player.seat));
    pushLog(state, "skip", `${skipped.nickname} was skipped.`);
    advanceTurn(state, 1);
    return;
  }

  if (card.value === "reverse") {
    state.direction = state.direction === 1 ? -1 : 1;
    pushLog(state, "reverse", "Turn direction changed.");
    advanceTurn(state, state.players.length === 2 ? 1 : 0);
    return;
  }

  if (card.value === "draw2") {
    const target = findPlayerBySeat(state, seatAfter(state, player.seat));
    drawMany(state, target, 2);
    state.currentSeat = seatAfter(state, target.seat);
    setTurnDeadline(state);
    pushLog(state, "draw", `${target.nickname} drew two cards.`);
    return;
  }

  if (card.value === "wild4") {
    const target = findPlayerBySeat(state, seatAfter(state, player.seat));
    const previousColor = colorBeforeWild(state);
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

function updateOneWindowAfterPlay(state: GameStateInternal, player: PlayerState): void {
  if (player.hand.length === 1) {
    const opensAt = Date.now() + ONE_CALL_DELAY_MS;
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
  if (state.phase !== "playing" || !player || player.hand.length !== 1 || state.oneWindow?.playerId !== pending.playerId) {
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
  const players = sortedPlayers(state);
  const index = players.findIndex((player) => player.seat === seat);
  if (index < 0) {
    return players[0]?.seat ?? 0;
  }

  const nextIndex = (index + state.direction * steps + players.length * steps) % players.length;
  return players[nextIndex]!.seat;
}

function sortedPlayers(state: GameStateInternal): PlayerState[] {
  return [...state.players].sort((a, b) => a.seat - b.seat);
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
    isHost: player.isHost,
    ready: player.ready,
    calledOne: player.calledOne
  };
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
  return findPlayerBySeat(state, state.currentSeat);
}

function assignHost(state: GameStateInternal): void {
  if (state.players.some((player) => player.isHost && player.connected)) {
    return;
  }

  for (const player of state.players) {
    player.isHost = false;
  }

  const nextHost = state.players.find((player) => player.connected) ?? state.players[0];
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
  state.turnDeadline = Date.now() + state.settings.turnTimeoutSec * 1000;
}

function ensurePlaying(state: GameStateInternal): void {
  if (state.phase !== "playing") {
    throw new GameError("not_playing", "The game is not currently playing.");
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
