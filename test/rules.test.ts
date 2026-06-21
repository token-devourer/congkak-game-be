import { describe, expect, it } from "vitest";
import type { Card } from "@congcard/shared";
import { standardMode } from "../src/engine/modes/standard.js";
import { applyFlipSide, flipMode } from "../src/engine/modes/flip.js";
import {
  addPlayer,
  callOne,
  catchOne,
  chooseColorDraw,
  createGame,
  drawCard,
  drawColorCard,
  expireOneWindow,
  handleTurnTimeout,
  playBatch,
  playCard,
  resolveAutomatedTurns,
  resolveChallenge,
  resolvePendingBatchPlay,
  resolvePendingFlip,
  resolvePendingDraw,
  resolvePendingOneCall,
  resolveRoundDeal,
  setPlayerAway,
  setPlayerConnected,
  setReady,
  snapshotFor,
  startRound,
  updateSettings,
  type GameStateInternal
} from "../src/engine/game.js";

function settlePendingDraw(state: GameStateInternal): void {
  if (state.pendingDraw?.mode === "choice") {
    chooseColorDraw(state, state.pendingDraw.playerId, "auto");
  }
  let guard = 0;
  while (state.pendingDraw && guard < 700) {
    if (state.pendingDraw.reveal) state.pendingDraw.reveal.resolvesAt = 0;
    if (state.pendingDraw.settlesAt) state.pendingDraw.settlesAt = 1;
    resolvePendingDraw(state);
    guard += 1;
  }
  if (state.pendingDraw) throw new Error("Pending draw did not settle");
}

function flipCard(deck: Card[], color: Card["color"], value: Card["value"]): Card {
  const index = deck.findIndex((item) => item.color === color && item.value === value);
  if (index < 0) throw new Error(`Missing Flip card ${color} ${value}`);
  return deck.splice(index, 1)[0]!;
}

function controlledFlipGame(): GameStateInternal {
  const state = createGame("FLIP42", { modeId: "flip", turnTimeoutSec: 30 });
  addPlayer(state, "p1", "Ava", "sun");
  addPlayer(state, "p2", "Ben", "moon");
  addPlayer(state, "p3", "Cy", "star");
  const deck = flipMode.buildDeck(3);
  state.phase = "playing";
  state.flipSide = "light";
  state.activeColor = "red";
  state.discardPile = [flipCard(deck, "red", 5)];
  state.drawPile = deck;
  state.currentSeat = 0;
  state.direction = 1;
  state.players.forEach((player) => { player.hand = []; });
  return state;
}

describe("flip mode", () => {
  it("builds 116 paired cards and exposes only the active face", () => {
    const deck = flipMode.buildDeck(4);
    expect(deck).toHaveLength(116);
    expect(deck.filter((item) => item.color === "red" && item.value === "flip")).toHaveLength(2);
    const state = controlledFlipGame();
    state.players[0]!.hand = [flipCard(state.drawPile, "red", "flip")];
    expect(snapshotFor(state, "p1").self?.hand[0]).toEqual(expect.objectContaining({ color: "red", value: "flip" }));
    expect(snapshotFor(state, "p1").self?.hand[0]).not.toHaveProperty("flipFaces");
  });

  it("uses opaque card identifiers and exposes only inactive opponent faces", () => {
    const state = controlledFlipGame();
    const held = flipCard(state.drawPile, "red", 7);
    state.players[0]!.hand = [held];
    const internal = held as Card & { trackingId?: string; flipFaces?: { dark: Pick<Card, "color" | "value"> } };

    expect(held.id).toMatch(/^flip-[A-Za-z0-9_-]{16}$/);
    expect(internal.trackingId).toBeTruthy();
    expect(internal.trackingId).not.toBe(held.id);
    expect(snapshotFor(state, "p1").players[0]!.oppositeHand).toBeUndefined();
    expect(snapshotFor(state, "p2").players[0]!.oppositeHand).toEqual([
      expect.objectContaining({ trackingId: internal.trackingId, ...internal.flipFaces!.dark })
    ]);
    expect(snapshotFor(state, "spectator").players[0]!.oppositeHand).toHaveLength(1);
  });

  it("stages a personalized draw reveal and preserves its public tracking id", () => {
    const state = controlledFlipGame();
    state.players[0]!.hand = [flipCard(state.drawPile, "red", 1)];
    const drawn = flipCard(state.drawPile, "blue", 7);
    const internal = drawn as Card & { trackingId?: string; flipFaces?: { dark: Pick<Card, "color" | "value"> } };
    state.drawPile = [drawn];
    const publicBack = snapshotFor(state, "p2").drawPileBack;

    drawCard(state, "p1");
    expect(state.players[0]!.hand).toHaveLength(1);
    expect(snapshotFor(state, "p1").pendingDraw?.reveal?.visibleCard).toMatchObject({ color: "blue", value: 7, side: "light" });
    expect(snapshotFor(state, "p2").pendingDraw?.reveal?.visibleCard).toMatchObject(internal.flipFaces!.dark);
    expect(snapshotFor(state, "spectator").pendingDraw?.reveal?.visibleCard).toMatchObject(internal.flipFaces!.dark);

    settlePendingDraw(state);
    expect(state.players[0]!.hand).toHaveLength(2);
    expect(snapshotFor(state, "p2").players[0]!.oppositeHand?.at(-1)?.trackingId).toBe(publicBack?.trackingId);
    expect(publicBack?.trackingId).toBe(internal.trackingId);
  });

  it("synchronously flips every card zone and advances after resolution", () => {
    const state = controlledFlipGame();
    state.players[0]!.hand = [flipCard(state.drawPile, "red", "flip"), flipCard(state.drawPile, "blue", 2)];
    state.players[1]!.hand = [flipCard(state.drawPile, "yellow", "draw2")];
    playCard(state, "p1", state.players[0]!.hand[0]!.id);
    expect(state.pendingFlip?.toSide).toBe("dark");
    state.pendingFlip!.resolvesAt = 0;
    expect(resolvePendingFlip(state)).toBe(true);
    expect(state.flipSide).toBe("dark");
    expect(state.players[0]!.hand[0]).toMatchObject({ color: "pink", value: 2 });
    expect(state.players[1]!.hand[0]).toMatchObject({ color: "cyan", value: "draw5" });
    expect(snapshotFor(state).currentPlayerId).toBe("p2");
  });

  it("toggles once per Flip card in a batch", () => {
    const state = controlledFlipGame();
    state.settings.batchEnabled = true;
    state.players[0]!.hand = [
      flipCard(state.drawPile, "red", "flip"),
      flipCard(state.drawPile, "yellow", "flip"),
      flipCard(state.drawPile, "green", 1)
    ];
    playBatch(state, "p1", state.players[0]!.hand.slice(0, 2).map((item) => item.id));
    state.pendingBatchPlay!.resolvesAt = 0;
    resolvePendingBatchPlay(state);
    expect(state.pendingFlip?.transitionTimes).toHaveLength(2);
    expect(state.pendingFlip?.toSide).toBe("light");
    state.pendingFlip!.resolvesAt = 0;
    resolvePendingFlip(state);
    expect(state.flipSide).toBe("light");
  });

  it("uses challengeable light Wild +3 and unchallengeable dark Wild Color", () => {
    const light = controlledFlipGame();
    light.settings.challengeEnabled = true;
    light.players[0]!.hand = [flipCard(light.drawPile, null, "wild3"), flipCard(light.drawPile, "red", 9)];
    playCard(light, "p1", light.players[0]!.hand[0]!.id, "blue");
    expect(light.pendingChallenge).toMatchObject({ kind: "wild3", drawCount: 3, guilty: true });

    const dark = controlledFlipGame();
    dark.flipSide = "dark";
    for (const card of [...dark.drawPile, ...dark.discardPile]) applyFlipSide(card, "dark");
    dark.activeColor = "orange";
    dark.players[0]!.hand = [flipCard(dark.drawPile, null, "wildColor"), flipCard(dark.drawPile, "orange", 1)];
    dark.drawPile = [
      flipCard(dark.drawPile, "pink", 1),
      flipCard(dark.drawPile, "cyan", 2),
      flipCard(dark.drawPile, "purple", 3)
    ];
    playCard(dark, "p1", dark.players[0]!.hand[0]!.id, "cyan");
    expect(dark.pendingChallenge).toBeUndefined();
    expect(dark.pendingDraw).toMatchObject({ playerId: "p2", reason: "colorHunt", mode: "choice", requiredMatches: 1 });
    settlePendingDraw(dark);
    expect(dark.players[1]!.hand).toHaveLength(2);
    expect(snapshotFor(dark).currentPlayerId).toBe("p3");
  });

  it("keeps one deadline while manually revealing Wild Color cards", () => {
    const state = controlledFlipGame();
    state.flipSide = "dark";
    for (const card of [...state.drawPile, ...state.discardPile]) applyFlipSide(card, "dark");
    state.activeColor = "orange";
    state.players[0]!.hand = [flipCard(state.drawPile, null, "wildColor"), flipCard(state.drawPile, "orange", 1)];
    const match = flipCard(state.drawPile, "cyan", 2);
    const miss = flipCard(state.drawPile, "purple", 3);
    state.drawPile = [match, miss];

    playCard(state, "p1", state.players[0]!.hand[0]!.id, "cyan");
    const deadline = state.pendingDraw?.deadline;
    chooseColorDraw(state, "p2", "manual");
    drawColorCard(state, "p2");
    expect(() => drawColorCard(state, "p2")).toThrow("not ready");
    state.pendingDraw!.reveal!.resolvesAt = 0;
    resolvePendingDraw(state);
    expect(state.pendingDraw).toMatchObject({ mode: "manual", drawnCount: 1, matchesFound: 0, deadline });

    drawColorCard(state, "p2");
    state.pendingDraw!.reveal!.resolvesAt = 0;
    resolvePendingDraw(state);
    state.pendingDraw!.settlesAt = 1;
    resolvePendingDraw(state);
    expect(state.pendingDraw).toBeUndefined();
    expect(state.players[1]!.hand).toHaveLength(2);
    expect(snapshotFor(state).currentPlayerId).toBe("p3");
  });

  it("switches an idle Wild Color choice to automatic drawing", () => {
    const state = controlledFlipGame();
    state.flipSide = "dark";
    for (const card of [...state.drawPile, ...state.discardPile]) applyFlipSide(card, "dark");
    state.activeColor = "orange";
    state.players[0]!.hand = [flipCard(state.drawPile, null, "wildColor"), flipCard(state.drawPile, "orange", 1)];
    state.drawPile = [flipCard(state.drawPile, "cyan", 2), flipCard(state.drawPile, "purple", 3)];

    playCard(state, "p1", state.players[0]!.hand[0]!.id, "cyan");
    state.pendingDraw!.deadline = Date.now() - 1;
    expect(resolvePendingDraw(state)).toBe(true);
    expect(state.pendingDraw).toMatchObject({ mode: "auto" });
    settlePendingDraw(state);
    expect(state.players[1]!.hand).toHaveLength(2);
  });

  it("accumulates one dark target color across Batch and Stacking", () => {
    const state = controlledFlipGame();
    state.flipSide = "dark";
    state.settings.batchEnabled = true;
    state.settings.stackingEnabled = true;
    state.settings.callEnabled = false;
    for (const card of [...state.drawPile, ...state.discardPile]) applyFlipSide(card, "dark");
    state.activeColor = "orange";
    state.players[0]!.hand = [
      flipCard(state.drawPile, null, "wildColor"),
      flipCard(state.drawPile, null, "wildColor"),
      flipCard(state.drawPile, "orange", 1)
    ];
    state.players[1]!.hand = [flipCard(state.drawPile, null, "wildColor"), flipCard(state.drawPile, "cyan", 1)];
    state.players[2]!.hand = [flipCard(state.drawPile, null, "wildColor"), flipCard(state.drawPile, "purple", 1)];

    playBatch(state, "p1", state.players[0]!.hand.slice(0, 2).map((item) => item.id), "cyan");
    state.pendingBatchPlay!.resolvesAt = 0;
    resolvePendingBatchPlay(state);
    expect(state.pendingStack).toMatchObject({ kind: "wildColor", totalDraw: 2, targetColor: "cyan", targetPlayerId: "p2" });

    playCard(state, "p2", state.players[1]!.hand[0]!.id, "purple");
    expect(state.pendingChallenge).toBeUndefined();
    expect(state.pendingStack).toMatchObject({ kind: "wildColor", totalDraw: 3, targetColor: "purple", targetPlayerId: "p3" });
  });
});

function card(id: string, color: Card["color"], value: Card["value"]): Card {
  return { id, color, value, deckIndex: 0 };
}

function drawPile(count = 40): Card[] {
  return Array.from({ length: count }, (_, index) => card(`draw-${index}`, "blue", (index % 10) as Card["value"]));
}

function controlledGame(): GameStateInternal {
  const state = createGame("ABC123", { turnTimeoutSec: 30 });
  addPlayer(state, "p1", "Ava", "sun");
  addPlayer(state, "p2", "Ben", "moon");
  state.phase = "playing";
  state.activeColor = "red";
  state.discardPile = [card("discard-red-5", "red", 5)];
  state.drawPile = drawPile();
  state.currentSeat = 0;
  state.direction = 1;
  state.players[0]!.hand = [];
  state.players[1]!.hand = [];
  return state;
}

function controlledGame3(): GameStateInternal {
  const state = createGame("ABC123", { turnTimeoutSec: 30 });
  addPlayer(state, "p1", "Ava", "sun");
  addPlayer(state, "p2", "Ben", "moon");
  addPlayer(state, "p3", "Cy", "star");
  state.phase = "playing";
  state.activeColor = "red";
  state.discardPile = [card("discard-red-5", "red", 5)];
  state.drawPile = drawPile();
  state.currentSeat = 0;
  state.direction = 1;
  state.players[0]!.hand = [];
  state.players[1]!.hand = [];
  state.players[2]!.hand = [];
  return state;
}

function finishAutomaticDeal(state: GameStateInternal): void {
  for (let index = 0; index < 4 && state.phase === "dealing"; index += 1) {
    const event = state.roundDeal?.event;
    if (event) {
      event.startsAt = 0;
      event.resolvesAt = 0;
    }
    resolveRoundDeal(state);
  }
}

describe("standard mode", () => {
  it("reveals a staged normal draw only to its recipient", () => {
    const state = controlledGame();
    const top = state.drawPile.at(-1)!;

    drawCard(state, "p1");

    expect(snapshotFor(state, "p1").pendingDraw?.reveal?.visibleCard).toMatchObject({ color: top.color, value: top.value });
    expect(snapshotFor(state, "p2").pendingDraw?.reveal?.visibleCard).toBeUndefined();
    expect(state.players[0]!.hand).toHaveLength(0);
    settlePendingDraw(state);
    expect(state.players[0]!.hand).toHaveLength(1);
  });

  it("opens the offender One window only after a draw penalty lands", () => {
    const state = controlledGame();
    state.players[0]!.hand = [card("red-draw2", "red", "draw2"), card("blue-1", "blue", 1)];
    state.players[1]!.hand = [card("green-8", "green", 8)];

    playCard(state, "p1", "red-draw2");
    expect(state.pendingDraw).toBeDefined();
    expect(state.oneWindow).toBeUndefined();

    settlePendingDraw(state);
    expect(state.oneWindow?.playerId).toBe("p1");
  });

  it("streams multi-card draws quickly and settles once after the final card", () => {
    const state = controlledGame();
    state.players[0]!.hand = [card("red-draw2", "red", "draw2"), card("blue-1", "blue", 1)];
    state.players[1]!.hand = [card("green-8", "green", 8)];

    playCard(state, "p1", "red-draw2");
    state.pendingDraw!.reveal!.resolvesAt = 0;
    resolvePendingDraw(state);
    expect(state.pendingDraw?.revealedCards).toHaveLength(1);
    expect(state.pendingDraw!.reveal!.startsAt - Date.now()).toBeLessThanOrEqual(150);

    state.pendingDraw!.reveal!.resolvesAt = 0;
    const settledAt = Date.now();
    resolvePendingDraw(state);
    expect(state.pendingDraw?.revealedCards).toHaveLength(2);
    expect(state.pendingDraw!.settlesAt! - settledAt).toBeGreaterThanOrEqual(650);
    expect(snapshotFor(state, "p2").pendingDraw?.revealedCards).toHaveLength(2);
    expect(snapshotFor(state, "p1").pendingDraw?.revealedCards).toBeUndefined();

    state.pendingDraw!.settlesAt = 1;
    resolvePendingDraw(state);
    expect(state.pendingDraw).toBeUndefined();
  });

  it("builds a 108 card deck for standard player counts", () => {
    const deck = standardMode.buildDeck(10);
    const wilds = deck.filter((item) => item.color === null);

    expect(deck).toHaveLength(108);
    expect(wilds).toHaveLength(8);
    expect(deck.filter((item) => item.color === "red" && item.value === 0)).toHaveLength(1);
    expect(deck.filter((item) => item.color === "red" && item.value === 9)).toHaveLength(2);
    expect(deck.filter((item) => item.color === "red" && item.value === "skip")).toHaveLength(2);
  });

  it("validates playable cards by color, value, and wild status", () => {
    const ctx = {
      playerId: "p1",
      activeColor: "red" as const,
      discardTop: card("top", "green", 7),
      hand: [],
      playerCount: 3
    };

    expect(standardMode.isPlayable(card("red-1", "red", 1), ctx)).toBe(true);
    expect(standardMode.isPlayable(card("blue-7", "blue", 7), ctx)).toBe(true);
    expect(standardMode.isPlayable(card("wild", null, "wild"), ctx)).toBe(true);
    expect(standardMode.isPlayable(card("blue-2", "blue", 2), ctx)).toBe(false);
  });

  it("treats reverse as skip with two players", () => {
    const state = controlledGame();
    state.players[0]!.hand = [card("reverse", "red", "reverse"), card("blue-2", "blue", 2)];

    playCard(state, "p1", "reverse");

    expect(snapshotFor(state).currentPlayerId).toBe("p1");
    expect(state.direction).toBe(-1);
  });

  it("handles Wild Draw Four challenge success", () => {
    const state = controlledGame();
    state.players[0]!.hand = [card("wild4", null, "wild4"), card("red-9", "red", 9)];

    playCard(state, "p1", "wild4", "blue");
    expect(state.pendingChallenge?.guilty).toBe(true);

    state.oneWindow!.opensAt = Date.now() - 1;
    state.oneWindow!.deadline = Date.now() + 1000;
    callOne(state, "p1");
    state.pendingOneCall!.resolvesAt = Date.now() - 1;
    expect(resolvePendingOneCall(state)).toBe(true);

    resolveChallenge(state, "p2", true);
    settlePendingDraw(state);

    expect(state.players[0]!.hand).toHaveLength(5);
    expect(snapshotFor(state).currentPlayerId).toBe("p2");
  });

  it("penalizes missed One calls", () => {
    const state = controlledGame();
    state.players[0]!.hand = [card("red-1", "red", 1), card("blue-2", "blue", 2)];

    playCard(state, "p1", "red-1");
    expect(state.oneWindow?.playerId).toBe("p1");
    state.oneWindow!.opensAt = Date.now() - 1;
    state.oneWindow!.deadline = Date.now() + 1000;

    catchOne(state, "p2", "p1");
    settlePendingDraw(state);

    expect(state.players[0]!.hand).toHaveLength(3);
    expect(state.oneWindow).toBeUndefined();
  });

  it("allows a valid One call after the server arbitration buffer", () => {
    const state = controlledGame();
    state.players[0]!.hand = [card("red-1", "red", 1), card("blue-2", "blue", 2)];

    playCard(state, "p1", "red-1");
    state.oneWindow!.opensAt = Date.now() - 1;
    state.oneWindow!.deadline = Date.now() + 1000;
    callOne(state, "p1");

    expect(state.players[0]!.calledOne).toBe(false);
    expect(snapshotFor(state, "p1").oneWindow?.callPending).toBe(true);

    state.pendingOneCall!.resolvesAt = Date.now() - 1;
    expect(resolvePendingOneCall(state)).toBe(true);

    expect(state.players[0]!.calledOne).toBe(true);
    expect(state.oneWindow).toBeUndefined();
  });

  it("lets a catch beat a pending One call during arbitration", () => {
    const state = controlledGame();
    state.players[0]!.hand = [card("red-1", "red", 1), card("blue-2", "blue", 2)];

    playCard(state, "p1", "red-1");
    state.oneWindow!.opensAt = Date.now() - 1;
    state.oneWindow!.deadline = Date.now() + 1000;
    callOne(state, "p1");
    catchOne(state, "p2", "p1");
    settlePendingDraw(state);

    expect(state.players[0]!.hand).toHaveLength(3);
    expect(state.players[0]!.calledOne).toBe(false);
    expect(state.pendingOneCall).toBeUndefined();
    expect(state.oneWindow).toBeUndefined();
  });

  it("blocks turn actions while a One call is still being arbitrated", () => {
    const state = controlledGame();
    state.players[0]!.hand = [card("red-1", "red", 1), card("blue-2", "blue", 2)];
    state.players[1]!.hand = [card("red-3", "red", 3), card("green-8", "green", 8)];

    playCard(state, "p1", "red-1");
    state.oneWindow!.opensAt = Date.now() - 1;
    state.oneWindow!.deadline = Date.now() + 1000;
    callOne(state, "p1");

    expect(() => playCard(state, "p2", "red-3")).toThrow("One call is still being resolved");

    state.pendingOneCall!.resolvesAt = Date.now() - 1;
    playCard(state, "p2", "red-3");

    expect(state.players[0]!.calledOne).toBe(true);
    expect(snapshotFor(state).currentPlayerId).toBe("p1");
  });

  it("pauses turn timeout while a One call is still being arbitrated", () => {
    const state = controlledGame();
    state.players[0]!.hand = [card("red-1", "red", 1), card("blue-2", "blue", 2)];
    state.players[1]!.hand = [card("red-3", "red", 3), card("green-8", "green", 8)];

    playCard(state, "p1", "red-1");
    state.oneWindow!.opensAt = Date.now() - 1;
    state.oneWindow!.deadline = Date.now() + 1000;
    callOne(state, "p1");
    state.turnDeadline = Date.now() - 1;

    expect(handleTurnTimeout(state)).toBe(false);
    expect(snapshotFor(state).currentPlayerId).toBe("p2");

    state.pendingOneCall!.resolvesAt = Date.now() - 1;
    expect(handleTurnTimeout(state)).toBe(true);
    expect(state.players[0]!.calledOne).toBe(true);
    expect(snapshotFor(state).currentPlayerId).toBe("p2");
  });

  it("opens the One window after a ping-based network delay", () => {
    const state = controlledGame();
    state.players[0]!.hand = [card("red-1", "red", 1), card("blue-2", "blue", 2)];

    playCard(state, "p1", "red-1");

    // The window now opens after a dynamic delay (MIN_ONE_DELAY_MS at minimum)
    // so every client has fair time to receive the snapshot.
    expect(state.oneWindow!.opensAt).toBeGreaterThan(Date.now() + 150);
    // Fast-forward past the buffer:
    state.oneWindow!.opensAt = Date.now() - 1;
    expect(() => callOne(state, "p1")).not.toThrow();
    expect(state.pendingOneCall?.playerId).toBe("p1");
  });

  it("does not open the One window when calls are disabled", () => {
    const state = controlledGame();
    state.settings.callEnabled = false;
    state.players[0]!.hand = [card("red-1", "red", 1), card("blue-2", "blue", 2)];

    playCard(state, "p1", "red-1");

    expect(state.oneWindow).toBeUndefined();
    expect(state.players[0]!.calledOne).toBe(false);
  });

  it("opens the catch window after a ping-based network delay", () => {
    const state = controlledGame();
    state.players[0]!.hand = [card("red-1", "red", 1), card("blue-2", "blue", 2)];

    playCard(state, "p1", "red-1");

    // The window is not immediately actionable; fast-forward past the delay:
    state.oneWindow!.opensAt = Date.now() - 1;
    state.oneWindow!.deadline = Date.now() + 1000;
    expect(() => catchOne(state, "p2", "p1")).not.toThrow();
    settlePendingDraw(state);
    expect(state.players[0]!.hand).toHaveLength(3);
    expect(state.oneWindow).toBeUndefined();
  });

  it("rejects One actions after the window expires", () => {
    const state = controlledGame();
    state.players[0]!.hand = [card("red-1", "red", 1), card("blue-2", "blue", 2)];

    playCard(state, "p1", "red-1");
    state.oneWindow!.opensAt = Date.now() - 2000;
    state.oneWindow!.deadline = Date.now() - 1;

    expect(() => callOne(state, "p1")).toThrow("One window is open");
    expect(() => catchOne(state, "p2", "p1")).toThrow("cannot be caught");
  });

  it("reshuffles discard cards into the draw pile", () => {
    const state = controlledGame();
    state.players[0]!.hand = [card("green-9", "green", 9)];
    state.drawPile = [];
    state.discardPile = [card("old-1", "yellow", 3), card("old-2", "blue", 4), card("top", "red", 5)];

    drawCard(state, "p1");

    expect(state.discardPile).toHaveLength(1);
    expect(state.discardPile[0]!.id).toBe("top");
  });

  it("does not credit a caught player with a One call", () => {
    const state = controlledGame();
    state.players[0]!.hand = [card("red-1", "red", 1), card("blue-2", "blue", 2)];

    playCard(state, "p1", "red-1");
    state.oneWindow!.opensAt = Date.now() - 1;
    state.oneWindow!.deadline = Date.now() + 1000;
    catchOne(state, "p2", "p1");
    settlePendingDraw(state);

    expect(state.players[0]!.hand).toHaveLength(3);
    expect(state.players[0]!.calledOne).toBe(false);
    expect(() => catchOne(state, "p2", "p1")).toThrow("cannot be caught");
  });

  it("rejects catching yourself", () => {
    const state = controlledGame();
    state.players[0]!.hand = [card("red-1", "red", 1), card("blue-2", "blue", 2)];

    playCard(state, "p1", "red-1");
    state.oneWindow!.opensAt = Date.now() - 1;
    state.oneWindow!.deadline = Date.now() + 1000;

    expect(() => catchOne(state, "p1", "p1")).toThrow("catch yourself");
    expect(state.players[0]!.hand).toHaveLength(1);
  });

  it("expires the One window silently without a penalty", () => {
    const state = controlledGame();
    state.players[0]!.hand = [card("red-1", "red", 1), card("blue-2", "blue", 2)];

    playCard(state, "p1", "red-1");
    expect(expireOneWindow(state)).toBe(false);

    state.oneWindow!.deadline = Date.now() - 1;

    expect(expireOneWindow(state)).toBe(true);
    expect(state.oneWindow).toBeUndefined();
    expect(state.players[0]!.hand).toHaveLength(1);
  });

  it("closes a stale One window when the target no longer has one card", () => {
    const state = controlledGame();
    state.players[0]!.hand = [card("red-1", "red", 1), card("blue-2", "blue", 2)];
    state.players[1]!.hand = [card("red-draw2", "red", "draw2"), card("green-8", "green", 8), card("blue-9", "blue", 9)];

    playCard(state, "p1", "red-1");
    expect(state.oneWindow?.playerId).toBe("p1");
    state.oneWindow!.deadline = Date.now() - 1;

    playCard(state, "p2", "red-draw2");
    settlePendingDraw(state);

    expect(state.players[0]!.hand).toHaveLength(3);
    expect(state.oneWindow).toBeUndefined();
  });

  it("blocks turn actions until the One window is resolved or expires", () => {
    const state = controlledGame();
    state.players[0]!.hand = [card("red-1", "red", 1), card("green-2", "green", 2)];
    state.players[1]!.hand = [card("red-3", "red", 3), card("blue-4", "blue", 4), card("yellow-5", "yellow", 5)];

    playCard(state, "p1", "red-1");
    expect(state.oneWindow?.playerId).toBe("p1");

    expect(() => playCard(state, "p2", "red-3")).toThrow("One window");

    state.oneWindow!.deadline = Date.now() - 1;
    playCard(state, "p2", "red-3");

    expect(state.oneWindow).toBeUndefined();
    expect(snapshotFor(state).currentPlayerId).toBe("p1");
  });

  it("keeps the One window open after an invalid next-player action", () => {
    const state = controlledGame();
    state.players[0]!.hand = [card("red-1", "red", 1), card("green-2", "green", 2)];
    state.players[1]!.hand = [card("blue-4", "blue", 4), card("yellow-5", "yellow", 5)];

    playCard(state, "p1", "red-1");

    expect(() => playCard(state, "p2", "blue-4")).toThrow("cannot be played");
    expect(state.oneWindow?.playerId).toBe("p1");
  });

  it("opens a fresh 108-card deck when there is nothing left to draw", () => {
    const state = controlledGame();
    state.players[0]!.hand = [card("green-9", "green", 9)];
    state.players[1]!.hand = [card("green-8", "green", 8)];
    state.drawPile = [];
    state.discardPile = [card("top", "red", 5)];

    drawCard(state, "p1");
    settlePendingDraw(state);

    expect(state.players[0]!.hand).toHaveLength(2);
    expect(state.drawPile).toHaveLength(107);
    expect(state.actionLog.some((entry) => entry.message.includes("fresh deck"))).toBe(true);
  });

  it("keeps fresh-deck card ids unique by bumping the deckIndex", () => {
    const state = controlledGame();
    state.players[0]!.hand = [card("green-9", "green", 9)];
    state.players[1]!.hand = [card("green-8", "green", 8)];
    state.drawPile = [];
    state.discardPile = [card("top", "red", 5)];

    drawCard(state, "p1");
    settlePendingDraw(state);

    const drawn = state.players[0]!.hand[1]!;
    expect(drawn.deckIndex).toBe(1);
    expect(state.drawPile.every((item) => item.deckIndex === 1)).toBe(true);
  });

  it("completes a penalty from a fresh deck when the pile runs dry", () => {
    const state = controlledGame();
    state.players[0]!.hand = [card("draw2", "red", "draw2"), card("blue-2", "blue", 2)];
    state.players[1]!.hand = [card("green-8", "green", 8)];
    state.drawPile = [];
    state.discardPile = [card("top", "red", 5)];

    // Only one card is recoverable (the buried "top"); the second penalty
    // card must come from a freshly opened deck instead of being dropped.
    playCard(state, "p1", "draw2");
    settlePendingDraw(state);

    expect(state.players[1]!.hand).toHaveLength(3);
    expect(snapshotFor(state).currentPlayerId).toBe("p1");
  });

  it("auto-resolves an unanswered Wild Draw Four when the timer lapses", () => {
    const state = controlledGame();
    state.players[0]!.hand = [card("wild4", null, "wild4"), card("red-9", "red", 9)];
    state.players[1]!.hand = [card("green-8", "green", 8)];

    playCard(state, "p1", "wild4", "blue");
    expect(state.pendingChallenge).toBeDefined();

    state.turnDeadline = Date.now() - 1;
    expect(handleTurnTimeout(state)).toBe(false);

    state.oneWindow!.deadline = Date.now() - 1;
    expect(handleTurnTimeout(state)).toBe(true);
    settlePendingDraw(state);

    expect(state.pendingChallenge).toBeUndefined();
    expect(state.players[1]!.hand).toHaveLength(5);
    expect(snapshotFor(state).currentPlayerId).toBe("p1");
  });

  it("enables configured draw automation immediately after disconnect", () => {
    const state = controlledGame3();
    state.players[0]!.hand = [card("green-8", "green", 8)];
    state.players[1]!.hand = [card("blue-8", "blue", 8)];
    state.players[2]!.hand = [card("green-7", "green", 7)];
    setPlayerConnected(state, "p1", false);

    expect(state.players[0]!.autoPlay).toBe(true);
    const handSize = state.players[0]!.hand.length;

    state.autoPlayPendingAt = Date.now() - 2000;
    expect(resolveAutomatedTurns(state)).toBe(true);
    settlePendingDraw(state);
    expect(state.players[0]!.hand).toHaveLength(handSize + 1);
    expect(snapshotFor(state).currentPlayerId).toBe("p1");

    state.autoPlayPendingAt = Date.now() - 2000;
    expect(resolveAutomatedTurns(state)).toBe(true);
    settlePendingDraw(state);
    expect(snapshotFor(state).currentPlayerId).toBe("p2");
  });

  it("auto-accepts a disconnected challenge turn in Autoplay mode", () => {
    const state = controlledGame3();
    state.settings.absentPlayerAction = "autoplay";
    state.players[0]!.hand = [card("red-9", "red", 9)];
    state.players[1]!.hand = [card("green-8", "green", 8)];
    state.players[2]!.hand = [card("blue-7", "blue", 7)];
    setPlayerConnected(state, "p2", false);
    state.pendingChallenge = { offenderId: "p1", challengerId: "p2", declaredColor: "blue", guilty: false };
    state.currentSeat = 1;
    state.autoPlayPendingAt = Date.now() - 2000;

    expect(resolveAutomatedTurns(state)).toBe(true);
    settlePendingDraw(state);

    expect(state.pendingChallenge).toBeUndefined();
    expect(state.players[1]!.hand).toHaveLength(5);
    expect(snapshotFor(state).currentPlayerId).toBe("p3");
  });

  it("auto draws after a delay for away players while keeping them connected", () => {
    const state = controlledGame3();
    // Unplayable hand so the away auto turn draws (covered by away-autoplay
    // tests for the play-a-match path).
    state.players[0]!.hand = [card("green-8", "green", 8)];
    state.players[1]!.hand = [card("blue-8", "blue", 8)];
    state.players[2]!.hand = [card("green-7", "green", 7)];
    setPlayerAway(state, "p1", true);

    expect(state.players[0]!).toMatchObject({ connected: true, away: true, autoPlay: true });
    state.autoPlayPendingAt = Date.now() - 2000;
    expect(resolveAutomatedTurns(state)).toBe(true);
    settlePendingDraw(state);
    expect(state.players[0]!.hand).toHaveLength(2);
    expect(snapshotFor(state).currentPlayerId).toBe("p1");

    state.autoPlayPendingAt = Date.now() - 2000;
    expect(resolveAutomatedTurns(state)).toBe(true);
    settlePendingDraw(state);
    expect(snapshotFor(state).currentPlayerId).toBe("p2");

    setPlayerAway(state, "p1", false);
    expect(state.players[0]!).toMatchObject({ away: false, autoPlay: false, missedDisconnectedTurns: 0 });
  });

  it("auto-accepts an away challenge turn", () => {
    const state = controlledGame3();
    state.settings.absentPlayerAction = "autoplay";
    state.players[0]!.hand = [card("red-9", "red", 9)];
    state.players[1]!.hand = [card("green-8", "green", 8)];
    state.players[2]!.hand = [card("blue-7", "blue", 7)];
    setPlayerAway(state, "p2", true);
    state.pendingChallenge = { offenderId: "p1", challengerId: "p2", declaredColor: "blue", guilty: false };
    state.currentSeat = 1;
    state.autoPlayPendingAt = Date.now() - 2000;

    expect(resolveAutomatedTurns(state)).toBe(true);
    settlePendingDraw(state);

    expect(state.pendingChallenge).toBeUndefined();
    expect(state.players[1]!.hand).toHaveLength(5);
    expect(snapshotFor(state).currentPlayerId).toBe("p3");
  });

  it("resolves Wild Draw Four without challenge when disabled", () => {
    const state = controlledGame();
    state.settings.challengeEnabled = false;
    state.players[0]!.hand = [card("wild4", null, "wild4"), card("red-9", "red", 9)];
    state.players[1]!.hand = [card("blue-8", "blue", 8)];

    playCard(state, "p1", "wild4", "green");
    settlePendingDraw(state);

    expect(state.pendingChallenge).toBeUndefined();
    expect(state.players[1]!.hand).toHaveLength(5);
    expect(snapshotFor(state).currentPlayerId).toBe("p1");
  });

  it("scores a finished round", () => {
    const state = controlledGame();
    state.players[0]!.hand = [card("red-1", "red", 1)];
    state.players[1]!.hand = [card("skip", "green", "skip"), card("wild", null, "wild")];
    state.players[1]!.cardCount = 2;

    playCard(state, "p1", "red-1");

    expect(state.phase).toBe("roundEnd");
    expect(state.players[0]!.score).toBe(70);
    expect(state.roundWinnerId).toBe("p1");

    expect(state.roundScore).toBeDefined();
    expect(state.roundScore!.winnerId).toBe("p1");
    expect(state.roundScore!.total).toBe(70);
    expect(state.roundScore!.isGameEnd).toBe(false);
    expect(state.roundScore!.players).toHaveLength(1);
    const loserScore = state.roundScore!.players[0]!;
    expect(loserScore.playerId).toBe("p2");
    expect(loserScore.cardCount).toBe(2);
    expect(loserScore.handValue).toBe(70);
    expect(loserScore.numberPoints).toBe(0);
    expect(loserScore.actionPoints).toBe(20);
    expect(loserScore.wildPoints).toBe(50);
    expect(snapshotFor(state, "p1").roundScore).toEqual(state.roundScore);
  });

  it("keeps a Last Stand round active after the first finisher", () => {
    const state = controlledGame3();
    state.settings.scoreTarget = "lastStand";
    state.players[0]!.hand = [card("p1-red-1", "red", 1)];
    state.players[1]!.hand = [card("p2-red-2", "red", 2)];
    state.players[2]!.hand = [card("p3-blue-7", "blue", 7)];

    playCard(state, "p1", "p1-red-1");

    expect(state.phase).toBe("playing");
    expect(state.roundWinnerId).toBe("p1");
    expect(state.lastStandPlacements).toMatchObject([{ playerId: "p1", rank: 1 }]);
    expect(snapshotFor(state).players.find((player) => player.id === "p1")?.finishedRank).toBe(1);
    expect(snapshotFor(state).currentPlayerId).toBe("p2");
  });

  it("ends Last Stand when one player remains and marks the loser last", () => {
    const state = controlledGame3();
    state.settings.scoreTarget = "lastStand";
    state.players[0]!.hand = [card("p1-red-1", "red", 1)];
    state.players[1]!.hand = [card("p2-red-2", "red", 2)];
    state.players[2]!.hand = [card("p3-blue-7", "blue", 7)];

    playCard(state, "p1", "p1-red-1");
    playCard(state, "p2", "p2-red-2");

    expect(state.phase).toBe("roundEnd");
    expect(state.players[0]!.score).toBe(0);
    expect(state.lastStandPlacements).toMatchObject([
      { playerId: "p1", rank: 1 },
      { playerId: "p2", rank: 2 },
      { playerId: "p3", rank: 3, isLoser: true }
    ]);
  });

  it("skips finished Last Stand players when choosing penalty targets", () => {
    const state = controlledGame3();
    state.settings.scoreTarget = "lastStand";
    state.players[0]!.hand = [card("p1-red-1", "red", 1)];
    state.players[1]!.hand = [card("p2-red-draw2", "red", "draw2"), card("p2-green-8", "green", 8)];
    state.players[2]!.hand = [card("p3-blue-7", "blue", 7)];

    playCard(state, "p1", "p1-red-1");
    playCard(state, "p2", "p2-red-draw2");
    settlePendingDraw(state);

    expect(state.players[0]!.hand).toHaveLength(0);
    expect(state.players[2]!.hand).toHaveLength(3);
    expect(snapshotFor(state).currentPlayerId).toBe("p2");
  });

  it("finalizes a Last Stand Wild Draw Four finisher only after challenge resolution", () => {
    const state = controlledGame3();
    state.settings.scoreTarget = "lastStand";
    state.players[0]!.hand = [card("p1-wild4", null, "wild4")];
    state.players[1]!.hand = [card("p2-yellow-7", "yellow", 7)];
    state.players[2]!.hand = [card("p3-blue-7", "blue", 7)];

    playCard(state, "p1", "p1-wild4", "blue");

    expect(state.pendingChallenge).toBeDefined();
    expect(state.players[0]!.finishedRank).toBeUndefined();

    resolveChallenge(state, "p2", true);
    settlePendingDraw(state);

    expect(state.pendingChallenge).toBeUndefined();
    expect(state.players[0]!.finishedRank).toBe(1);
    expect(state.phase).toBe("playing");
  });

  it("lets a Last Stand stack continue after finishers leave active rotation", () => {
    const state = controlledGame3();
    state.settings.scoreTarget = "lastStand";
    state.settings.stackingEnabled = true;
    state.players[0]!.hand = [card("p1-red-draw2", "red", "draw2")];
    state.players[1]!.hand = [card("p2-blue-draw2", "blue", "draw2")];
    state.players[2]!.hand = [card("p3-green-7", "green", 7)];

    playCard(state, "p1", "p1-red-draw2");

    expect(state.players[0]!.finishedRank).toBe(1);
    expect(state.pendingStack).toMatchObject({ targetPlayerId: "p2", totalDraw: 2 });

    playCard(state, "p2", "p2-blue-draw2");
    settlePendingDraw(state);

    expect(state.players[1]!.finishedRank).toBe(2);
    expect(state.phase).toBe("roundEnd");
    expect(state.players[2]!.hand).toHaveLength(5);
    expect(state.lastStandPlacements).toMatchObject([
      { playerId: "p1", rank: 1 },
      { playerId: "p2", rank: 2 },
      { playerId: "p3", rank: 3, isLoser: true }
    ]);
  });

  it("allows Jump In to create a Last Stand finisher", () => {
    const state = controlledGame3();
    state.settings.scoreTarget = "lastStand";
    state.settings.jumpInEnabled = true;
    state.players[0]!.hand = [card("p1-red-5", "red", 5), card("p1-blue-1", "blue", 1), card("p1-green-2", "green", 2)];
    state.players[1]!.hand = [card("p2-yellow-7", "yellow", 7)];
    state.players[2]!.hand = [card("p3-red-5", "red", 5)];

    playCard(state, "p1", "p1-red-5");
    playCard(state, "p3", "p3-red-5");

    expect(state.players[2]!.finishedRank).toBe(1);
    expect(state.phase).toBe("playing");
    expect(state.roundWinnerId).toBe("p3");
  });

  it("clears Last Stand placements when the next round starts", () => {
    const state = controlledGame3();
    state.settings.scoreTarget = "lastStand";
    state.players[0]!.hand = [card("p1-red-1", "red", 1)];
    state.players[1]!.hand = [card("p2-red-2", "red", 2)];
    state.players[2]!.hand = [card("p3-blue-7", "blue", 7)];

    playCard(state, "p1", "p1-red-1");
    playCard(state, "p2", "p2-red-2");
    startRound(state);

    expect(state.phase).toBe("dealing");
    expect(state.lastStandPlacements).toBeUndefined();
    expect(state.players.every((player) => player.finishedRank === undefined)).toBe(true);
  });

  it("starts a round from lobby with ready players", () => {
    const state = createGame("ABC123");
    addPlayer(state, "p1", "Ava", "sun");
    addPlayer(state, "p2", "Ben", "moon");
    setReady(state, "p2", true);

    startRound(state);
    finishAutomaticDeal(state);

    expect(state.phase).toBe("playing");
    expect([7, 9]).toContain(state.players[0]!.hand.length);
    expect(state.players[1]!.hand).toHaveLength(7);
    expect(state.discardPile).toHaveLength(1);
  });

  it("rejects a malicious round restart while playing", () => {
    const state = controlledGame();

    expect(() => startRound(state)).toThrow("already in progress");
    expect(state.phase).toBe("playing");
  });

  it("removes disconnected lobby players before dealing", () => {
    const state = createGame("ABC123");
    addPlayer(state, "p1", "Ava", "sun");
    addPlayer(state, "p2", "Ben", "moon");
    addPlayer(state, "p3", "Cy", "star");
    setReady(state, "p2", true);
    setReady(state, "p3", true);

    setPlayerConnected(state, "p3", false);
    startRound(state);
    finishAutomaticDeal(state);

    expect(state.players.map((player) => player.id)).toEqual(["p1", "p2"]);
    expect(state.players.every((player) => player.hand.length >= 7)).toBe(true);
  });

  it("rejects reducing max players below the occupied seats", () => {
    const state = createGame("ABC123", { maxPlayers: 4 });
    addPlayer(state, "p1", "Ava", "sun");
    addPlayer(state, "p2", "Ben", "moon");
    addPlayer(state, "p3", "Cy", "star");

    expect(() => updateSettings(state, "p1", { maxPlayers: 2 })).toThrow("current room size");
    expect(state.settings.maxPlayers).toBe(4);
  });

  it("keeps deck boxes at the current lobby minimum", () => {
    const state = createGame("ABC123", { maxPlayers: 6 });
    addPlayer(state, "p1", "Ava", "sun");
    addPlayer(state, "p2", "Ben", "moon");
    addPlayer(state, "p3", "Cy", "star");
    addPlayer(state, "p4", "Di", "bolt");
    addPlayer(state, "p5", "Eli", "leaf");

    expect(state.settings.deckBoxes).toBe(2);
    expect(() => updateSettings(state, "p1", { deckBoxes: 1 })).toThrow("room minimum");

    for (const player of state.players) {
      if (!player.isHost) {
        setReady(state, player.id, true);
      }
    }

    startRound(state);
    finishAutomaticDeal(state);

    // Two deck boxes = 216 cards. Assert conservation rather than an exact
    // draw-pile size, since a Draw Two opener legitimately deals two extra cards.
    const totalCards =
      state.drawPile.length +
      state.discardPile.length +
      state.players.reduce((sum, player) => sum + player.hand.length, 0) +
      (state.pendingDraw?.reveal ? 1 : 0);
    expect(totalCards).toBe(216);
    expect(state.players.every((player) => player.hand.length >= 7)).toBe(true);
  });

  it("allows jump in with an exact matching card when enabled", () => {
    const state = controlledGame3();
    state.settings.jumpInEnabled = true;
    state.players[0]!.hand = [card("p1-red-5", "red", 5), card("p1-blue-1", "blue", 1), card("p1-green-2", "green", 2)];
    state.players[1]!.hand = [card("p2-yellow-7", "yellow", 7)];
    state.players[2]!.hand = [card("p3-red-5", "red", 5), card("p3-blue-9", "blue", 9)];

    playCard(state, "p1", "p1-red-5");
    expect(snapshotFor(state).currentPlayerId).toBe("p2");

    playCard(state, "p3", "p3-red-5");

    expect(snapshotFor(state).currentPlayerId).toBe("p1");
  });

  it("stacks draw cards until the target draws the total", () => {
    const state = controlledGame3();
    state.settings.stackingEnabled = true;
    state.players[0]!.hand = [card("p1-red-draw2", "red", "draw2"), card("p1-blue-1", "blue", 1), card("p1-green-2", "green", 2)];
    state.players[1]!.hand = [card("p2-blue-draw2", "blue", "draw2"), card("p2-yellow-7", "yellow", 7)];
    state.players[2]!.hand = [card("p3-green-8", "green", 8)];

    playCard(state, "p1", "p1-red-draw2");
    expect(state.pendingStack).toMatchObject({ kind: "draw2", targetPlayerId: "p2", totalDraw: 2 });

    playCard(state, "p2", "p2-blue-draw2");
    expect(state.pendingStack).toMatchObject({ kind: "draw2", targetPlayerId: "p3", totalDraw: 4 });

    state.oneWindow!.opensAt = Date.now() - 1;
    state.oneWindow!.deadline = Date.now() + 1000;
    callOne(state, "p2");
    state.pendingOneCall!.resolvesAt = Date.now() - 1;
    expect(resolvePendingOneCall(state)).toBe(true);
    settlePendingDraw(state);

    expect(state.pendingStack).toBeUndefined();
    expect(state.players[2]!.hand).toHaveLength(5);
    expect(snapshotFor(state).currentPlayerId).toBe("p1");
  });

  it("opens a challengeable stack for the first Wild Draw Four", () => {
    const state = controlledGame3();
    state.settings.stackingEnabled = true;
    state.settings.challengeEnabled = true;
    state.players[0]!.hand = [card("p1-wild4", null, "wild4"), card("p1-red-9", "red", 9), card("p1-blue-1", "blue", 1)];
    state.players[1]!.hand = [card("p2-wild4", null, "wild4"), card("p2-blue-1", "blue", 1)];
    state.players[2]!.hand = [card("p3-green-8", "green", 8)];

    playCard(state, "p1", "p1-wild4", "blue");

    expect(state.pendingStack).toMatchObject({
      kind: "wild4",
      targetPlayerId: "p2",
      totalDraw: 4,
      challengeable: true,
      offenderId: "p1",
      declaredColor: "blue",
      guilty: true
    });
    expect(state.pendingChallenge).toMatchObject({ offenderId: "p1", challengerId: "p2", guilty: true });
  });

  it("lets the affected player challenge the first Wild Draw Four while stacking is enabled", () => {
    const state = controlledGame3();
    state.settings.stackingEnabled = true;
    state.settings.challengeEnabled = true;
    state.players[0]!.hand = [card("p1-wild4", null, "wild4"), card("p1-red-9", "red", 9), card("p1-blue-1", "blue", 1)];
    state.players[1]!.hand = [card("p2-blue-1", "blue", 1)];
    state.players[2]!.hand = [card("p3-green-8", "green", 8)];

    playCard(state, "p1", "p1-wild4", "blue");
    resolveChallenge(state, "p2", true);
    settlePendingDraw(state);

    expect(state.pendingChallenge).toBeUndefined();
    expect(state.pendingStack).toBeUndefined();
    expect(state.players[0]!.hand).toHaveLength(6);
    expect(snapshotFor(state).currentPlayerId).toBe("p2");
  });

  it("lets stacking replace the first Wild Draw Four challenge choice", () => {
    const state = controlledGame3();
    state.settings.stackingEnabled = true;
    state.settings.challengeEnabled = true;
    state.players[0]!.hand = [card("p1-wild4", null, "wild4"), card("p1-red-9", "red", 9), card("p1-blue-1", "blue", 1)];
    state.players[1]!.hand = [card("p2-wild4", null, "wild4"), card("p2-blue-1", "blue", 1), card("p2-yellow-2", "yellow", 2)];
    state.players[2]!.hand = [card("p3-wild4", null, "wild4"), card("p3-green-8", "green", 8)];

    playCard(state, "p1", "p1-wild4", "blue");
    playCard(state, "p2", "p2-wild4", "green");

    expect(state.pendingChallenge).toBeUndefined();
    expect(state.pendingStack).toMatchObject({ kind: "wild4", targetPlayerId: "p3", totalDraw: 8, challengeable: false });
    expect(() => resolveChallenge(state, "p3", true)).toThrow("There is no Wild Draw Four");
  });

  it("lets Jump In reset a Draw Two stack", () => {
    const state = controlledGame3();
    state.settings.stackingEnabled = true;
    state.settings.jumpInEnabled = true;
    state.players[0]!.hand = [card("p1-red-draw2", "red", "draw2"), card("p1-blue-draw2", "blue", "draw2"), card("p1-red-9", "red", 9)];
    state.players[1]!.hand = [card("p2-blue-draw2", "blue", "draw2"), card("p2-yellow-draw2", "yellow", "draw2"), card("p2-blue-1", "blue", 1)];
    state.players[2]!.hand = [card("p3-green-draw2", "green", "draw2")];

    playCard(state, "p1", "p1-red-draw2");
    settlePendingDraw(state);
    playCard(state, "p2", "p2-blue-draw2");
    expect(state.pendingStack).toMatchObject({ targetPlayerId: "p3", totalDraw: 4 });

    playCard(state, "p1", "p1-blue-draw2");

    expect(state.pendingStack).toMatchObject({ kind: "draw2", targetPlayerId: "p2", totalDraw: 2 });
  });

  it("lets Jump In reset a Wild Draw Four stack without reopening challenge", () => {
    const state = controlledGame3();
    state.settings.stackingEnabled = true;
    state.settings.challengeEnabled = true;
    state.settings.jumpInEnabled = true;
    state.players[0]!.hand = [card("p1-wild4-a", null, "wild4"), card("p1-wild4-b", null, "wild4"), card("p1-red-9", "red", 9), card("p1-blue-1", "blue", 1)];
    state.players[1]!.hand = [card("p2-wild4-a", null, "wild4"), card("p2-wild4-b", null, "wild4"), card("p2-blue-1", "blue", 1)];
    state.players[2]!.hand = [card("p3-wild4", null, "wild4"), card("p3-green-8", "green", 8)];

    playCard(state, "p1", "p1-wild4-a", "blue");
    playCard(state, "p2", "p2-wild4-a", "green");
    expect(state.pendingStack).toMatchObject({ targetPlayerId: "p3", totalDraw: 8, challengeable: false });

    playCard(state, "p1", "p1-wild4-b", "red");

    expect(state.pendingChallenge).toBeUndefined();
    expect(state.pendingStack).toMatchObject({ kind: "wild4", targetPlayerId: "p2", totalDraw: 4 });
    expect(state.pendingStack?.challengeable).not.toBe(true);
  });

  it("auto-applies a stack when the target has no matching draw card", () => {
    const state = controlledGame3();
    state.settings.stackingEnabled = true;
    state.players[0]!.hand = [card("p1-red-draw2", "red", "draw2"), card("p1-blue-1", "blue", 1), card("p1-green-2", "green", 2)];
    state.players[1]!.hand = [card("p2-yellow-7", "yellow", 7)];
    state.players[2]!.hand = [card("p3-green-8", "green", 8)];

    playCard(state, "p1", "p1-red-draw2");
    settlePendingDraw(state);

    expect(state.pendingStack).toBeUndefined();
    expect(state.players[1]!.hand).toHaveLength(3);
    expect(snapshotFor(state).currentPlayerId).toBe("p3");
  });

  it("lets the stack target take the accumulated penalty even when they can stack", () => {
    const state = controlledGame3();
    state.settings.stackingEnabled = true;
    state.players[0]!.hand = [card("p1-red-draw2", "red", "draw2"), card("p1-blue-1", "blue", 1), card("p1-green-2", "green", 2)];
    state.players[1]!.hand = [card("p2-blue-draw2", "blue", "draw2"), card("p2-yellow-7", "yellow", 7)];
    state.players[2]!.hand = [card("p3-green-8", "green", 8)];

    playCard(state, "p1", "p1-red-draw2");

    expect(state.pendingStack).toMatchObject({ targetPlayerId: "p2", totalDraw: 2 });
    drawCard(state, "p2");
    settlePendingDraw(state);
    expect(state.pendingStack).toBeUndefined();
    expect(state.players[1]!.hand).toHaveLength(4);
    expect(snapshotFor(state).currentPlayerId).toBe("p3");
  });

  it("plays an ordered mixed-color number batch after the synchronized lock", () => {
    const state = controlledGame3();
    state.settings.batchEnabled = true;
    state.players[0]!.hand = [
      card("p1-red-5", "red", 5),
      card("p1-blue-5", "blue", 5),
      card("p1-green-9", "green", 9)
    ];

    playBatch(state, "p1", ["p1-red-5", "p1-blue-5"]);

    expect(state.pendingBatchPlay).toMatchObject({ playerId: "p1", cards: [{ id: "p1-red-5" }, { id: "p1-blue-5" }] });
    expect(state.turnDeadline).toBeUndefined();
    expect(() => drawCard(state, "p1")).toThrow("current batch");
    state.pendingBatchPlay!.resolvesAt = Date.now() - 1;
    expect(resolvePendingBatchPlay(state)).toBe(true);

    expect(state.discardPile.at(-1)?.id).toBe("p1-blue-5");
    expect(state.activeColor).toBe("blue");
    expect(state.players[0]!.hand.map((item) => item.id)).toEqual(["p1-green-9"]);
    expect(snapshotFor(state).currentPlayerId).toBe("p2");
    expect(state.oneWindow?.playerId).toBe("p1");
  });

  it("rejects invalid batches and post-draw batches that omit the drawn card", () => {
    const state = controlledGame3();
    state.settings.batchEnabled = true;
    state.players[0]!.hand = [
      card("p1-red-5", "red", 5),
      card("p1-green-5", "green", 5),
      card("p1-yellow-5", "yellow", 5),
      card("p1-blue-6", "blue", 6)
    ];
    const before = state.players[0]!.hand.map((item) => item.id);

    expect(() => playBatch(state, "p1", ["p1-red-5", "p1-blue-6"])).toThrow("same value");
    expect(state.players[0]!.hand.map((item) => item.id)).toEqual(before);

    // After drawing you commit to the drawn card: a batch that omits it is rejected.
    state.players[0]!.drawnCardId = "p1-red-5";
    expect(() => playBatch(state, "p1", ["p1-green-5", "p1-yellow-5"])).toThrow("just drew");
    expect(state.pendingBatchPlay).toBeUndefined();
    expect(state.players[0]!.hand.map((item) => item.id)).toEqual(before);
  });

  it("allows a post-draw batch that includes the drawn card", () => {
    const state = controlledGame3();
    state.settings.batchEnabled = true;
    state.players[0]!.hand = [card("p1-red-5", "red", 5), card("p1-green-5", "green", 5), card("p1-green-9", "green", 9)];
    state.players[0]!.drawnCardId = "p1-red-5";

    playBatch(state, "p1", ["p1-red-5", "p1-green-5"]);

    expect(state.pendingBatchPlay).toMatchObject({ playerId: "p1", cards: [{ id: "p1-red-5" }, { id: "p1-green-5" }] });
    expect(state.players[0]!.drawnCardId).toBeUndefined();
  });

  it("applies wrapped batch skips without counting the actor", () => {
    const state = createGame("ABC123", { turnTimeoutSec: 30, batchEnabled: true });
    addPlayer(state, "p1", "Ava", "sun");
    addPlayer(state, "p2", "Ben", "moon");
    addPlayer(state, "p3", "Cy", "star");
    addPlayer(state, "p4", "Dee", "bolt");
    state.phase = "playing";
    state.activeColor = "red";
    state.discardPile = [card("discard-red-5", "red", 5)];
    state.drawPile = drawPile();
    state.currentSeat = 0;
    state.direction = 1;
    state.players[0]!.hand = [
      card("skip-r", "red", "skip"),
      card("skip-y", "yellow", "skip"),
      card("skip-g", "green", "skip"),
      card("skip-b", "blue", "skip"),
      card("keep", "red", 1)
    ];
    state.players[1]!.hand = [card("p2-card", "blue", 1)];
    state.players[2]!.hand = [card("p3-card", "green", 2)];
    state.players[3]!.hand = [card("p4-card", "yellow", 3)];

    playBatch(state, "p1", ["skip-r", "skip-y", "skip-g", "skip-b"]);
    state.pendingBatchPlay!.resolvesAt = Date.now() - 1;
    resolvePendingBatchPlay(state);

    expect(snapshotFor(state).currentPlayerId).toBe("p3");
  });

  it("applies every Reverse in odd and even batches", () => {
    const odd = controlledGame3();
    odd.settings.batchEnabled = true;
    odd.players[0]!.hand = [
      card("odd-r", "red", "reverse"),
      card("odd-y", "yellow", "reverse"),
      card("odd-b", "blue", "reverse"),
      card("odd-keep", "green", 1)
    ];
    playBatch(odd, "p1", ["odd-r", "odd-y", "odd-b"]);
    odd.pendingBatchPlay!.resolvesAt = Date.now() - 1;
    resolvePendingBatchPlay(odd);
    expect(odd.direction).toBe(-1);
    expect(snapshotFor(odd).currentPlayerId).toBe("p3");

    const even = controlledGame3();
    even.settings.batchEnabled = true;
    even.players[0]!.hand = [card("even-r", "red", "reverse"), card("even-y", "yellow", "reverse"), card("even-keep", "green", 1)];
    playBatch(even, "p1", ["even-r", "even-y"]);
    even.pendingBatchPlay!.resolvesAt = Date.now() - 1;
    resolvePendingBatchPlay(even);
    expect(even.direction).toBe(1);
    expect(snapshotFor(even).currentPlayerId).toBe("p2");
  });

  it("multiplies draw batches and extends an active stack", () => {
    const state = controlledGame3();
    state.settings.batchEnabled = true;
    state.settings.stackingEnabled = true;
    state.players[0]!.hand = [
      card("p1-r2", "red", "draw2"),
      card("p1-b2", "blue", "draw2"),
      card("keep-a", "red", 1),
      card("keep-a2", "green", 3)
    ];
    state.players[1]!.hand = [card("p2-y2", "yellow", "draw2"), card("p2-g2", "green", "draw2"), card("keep-b", "blue", 1)];

    playBatch(state, "p1", ["p1-r2", "p1-b2"]);
    state.pendingBatchPlay!.resolvesAt = Date.now() - 1;
    resolvePendingBatchPlay(state);
    expect(state.pendingStack).toMatchObject({ targetPlayerId: "p2", totalDraw: 4 });

    playBatch(state, "p2", ["p2-y2", "p2-g2"]);
    state.pendingBatchPlay!.resolvesAt = Date.now() - 1;
    resolvePendingBatchPlay(state);
    expect(state.pendingStack).toMatchObject({ targetPlayerId: "p3", totalDraw: 8, challengeable: false });
  });

  it("challenges a Wild Draw Four batch as one multiplied penalty", () => {
    const state = controlledGame3();
    state.settings.batchEnabled = true;
    state.settings.challengeEnabled = true;
    state.players[0]!.hand = [
      card("wild4-a", null, "wild4"),
      card("wild4-b", null, "wild4"),
      card("red-9", "red", 9),
      card("blue-1", "blue", 1)
    ];

    playBatch(state, "p1", ["wild4-a", "wild4-b"], "blue");
    state.pendingBatchPlay!.resolvesAt = Date.now() - 1;
    resolvePendingBatchPlay(state);

    expect(state.pendingChallenge).toMatchObject({ offenderId: "p1", challengerId: "p2", guilty: true, drawCount: 8 });
    const before = state.players[0]!.hand.length;
    resolveChallenge(state, "p2", true);
    settlePendingDraw(state);
    expect(state.players[0]!.hand).toHaveLength(before + 8);
    expect(snapshotFor(state).currentPlayerId).toBe("p2");
  });

  it("lets a Wild Draw Four batch answer and close the first challengeable stack", () => {
    const state = controlledGame3();
    state.settings.batchEnabled = true;
    state.settings.stackingEnabled = true;
    state.settings.challengeEnabled = true;
    state.players[0]!.hand = [card("p1-wild4", null, "wild4"), card("p1-red-9", "red", 9), card("p1-blue-1", "blue", 1)];
    state.players[1]!.hand = [
      card("p2-wild4-a", null, "wild4"),
      card("p2-wild4-b", null, "wild4"),
      card("p2-green-1", "green", 1)
    ];
    state.players[2]!.hand = [card("p3-yellow-8", "yellow", 8)];

    playCard(state, "p1", "p1-wild4", "blue");
    expect(state.pendingChallenge).toMatchObject({ offenderId: "p1", challengerId: "p2" });
    expect(state.pendingStack).toMatchObject({ targetPlayerId: "p2", totalDraw: 4, challengeable: true });

    playBatch(state, "p2", ["p2-wild4-a", "p2-wild4-b"], "green");
    state.pendingBatchPlay!.resolvesAt = Date.now() - 1;
    resolvePendingBatchPlay(state);

    expect(state.pendingChallenge).toBeUndefined();
    expect(state.pendingStack).toMatchObject({
      kind: "wild4",
      targetPlayerId: "p3",
      totalDraw: 12,
      challengeable: false
    });
    expect(() => resolveChallenge(state, "p3", true)).toThrow("There is no Wild Draw Four");
  });

  it("pauses auto turns when fewer than two active players are available and resumes when one returns", () => {
    const state = controlledGame3();
    state.turnDeadline = Date.now() + 30_000;
    state.players[0]!.hand = [card("p1-red-9", "red", 9)];
    state.players[1]!.hand = [card("p2-blue-8", "blue", 8)];
    state.players[2]!.hand = [card("p3-green-7", "green", 7)];

    setPlayerAway(state, "p2", true);
    expect(state.pauseReason).toBeUndefined();

    setPlayerAway(state, "p3", true);
    expect(state.pauseReason).toBe("notEnoughAvailablePlayers");
    expect(state.turnDeadline).toBeUndefined();
    expect(resolveAutomatedTurns(state)).toBe(false);
    expect(state.players[1]!.hand).toHaveLength(1);
    expect(state.players[2]!.hand).toHaveLength(1);

    setPlayerAway(state, "p2", false);
    expect(state.pauseReason).toBeUndefined();
    expect(state.turnDeadline).toBeDefined();
  });

  it("plays a deterministic action-card sequence without stale One/Catch state", () => {
    const state = controlledGame3();
    state.players[0]!.hand = [card("p1-red-1", "red", 1), card("p1-green-1", "green", 1)];
    state.players[1]!.hand = [card("p2-red-draw2", "red", "draw2"), card("p2-wild4", null, "wild4"), card("p2-blue-4", "blue", 4)];
    state.players[2]!.hand = [card("p3-green-8", "green", 8), card("p3-blue-8", "blue", 8), card("p3-yellow-8", "yellow", 8)];
    state.drawPile = [
      card("challenge-1", "yellow", 1),
      card("challenge-2", "yellow", 2),
      card("challenge-3", "yellow", 3),
      card("challenge-4", "yellow", 4),
      card("challenge-5", "yellow", 5),
      card("challenge-6", "yellow", 6),
      card("p3-draw2-blue-1", "blue", 1),
      card("p3-draw2-blue-2", "blue", 2),
      card("p1-catch-blue-9", "blue", 9),
      card("p1-catch-red-7", "red", 7)
    ];

    playCard(state, "p1", "p1-red-1");
    expect(snapshotFor(state).currentPlayerId).toBe("p2");
    expect(state.oneWindow?.playerId).toBe("p1");

    state.oneWindow!.opensAt = Date.now() - 1;
    state.oneWindow!.deadline = Date.now() + 1000;
    catchOne(state, "p2", "p1");
    settlePendingDraw(state);
    expect(state.players[0]!.hand.map((item) => item.id)).toContain("p1-catch-red-7");
    expect(state.oneWindow).toBeUndefined();

    playCard(state, "p2", "p2-red-draw2");
    settlePendingDraw(state);
    expect(state.players[2]!.hand).toHaveLength(5);
    expect(snapshotFor(state).currentPlayerId).toBe("p1");
    expect(state.oneWindow).toBeUndefined();

    playCard(state, "p1", "p1-catch-red-7");
    expect(snapshotFor(state).currentPlayerId).toBe("p2");

    playCard(state, "p2", "p2-wild4", "blue");
    expect(state.pendingChallenge).toMatchObject({ offenderId: "p2", challengerId: "p3", guilty: false });
    expect(state.oneWindow?.playerId).toBe("p2");

    expect(() => resolveChallenge(state, "p3", true)).toThrow("One window");
    state.oneWindow!.opensAt = Date.now() - 1;
    state.oneWindow!.deadline = Date.now() + 1000;
    callOne(state, "p2");
    state.pendingOneCall!.resolvesAt = Date.now() - 1;
    expect(resolvePendingOneCall(state)).toBe(true);

    resolveChallenge(state, "p3", true);
    settlePendingDraw(state);
    expect(state.pendingChallenge).toBeUndefined();
    expect(state.players[2]!.hand).toHaveLength(11);
    expect(snapshotFor(state).currentPlayerId).toBe("p1");
    expect(state.oneWindow?.playerId).toBe("p2");
  });

  it("judges a Wild Draw Four played over a declared color by that color, not a buried card", () => {
    const state = controlledGame();
    // A previous Wild declared blue on top of a buried red card. The discard
    // card itself stays colorless; the active color lives only in state.
    state.discardPile = [card("buried-red-5", "red", 5), card("prev-wild", null, "wild")];
    state.activeColor = "blue";
    // p1 holds a red card (matches the BURIED color) but NO blue (the real
    // active color), so the Wild Draw Four is legal.
    state.players[0]!.hand = [card("p1-wild4", null, "wild4"), card("p1-red-9", "red", 9), card("p1-green-2", "green", 2)];
    state.players[1]!.hand = [card("p2-yellow-7", "yellow", 7)];

    playCard(state, "p1", "p1-wild4", "green");

    expect(state.pendingChallenge).toMatchObject({ offenderId: "p1", challengerId: "p2", guilty: false });
  });

  it("flags a Wild Draw Four guilty when the player holds the declared active color", () => {
    const state = controlledGame();
    state.discardPile = [card("buried-red-5", "red", 5), card("prev-wild", null, "wild")];
    state.activeColor = "blue";
    // p1 holds a blue card (the real active color) → illegal Wild Draw Four.
    state.players[0]!.hand = [card("p1-wild4", null, "wild4"), card("p1-blue-1", "blue", 1), card("p1-green-2", "green", 2)];
    state.players[1]!.hand = [card("p2-yellow-7", "yellow", 7)];

    playCard(state, "p1", "p1-wild4", "green");

    expect(state.pendingChallenge).toMatchObject({ offenderId: "p1", challengerId: "p2", guilty: true });
  });

  it("computes stack guilt from the active color when the first Wild Draw Four lands on a declared color", () => {
    const state = controlledGame3();
    state.settings.stackingEnabled = true;
    state.settings.challengeEnabled = true;
    state.discardPile = [card("buried-red-5", "red", 5), card("prev-wild", null, "wild")];
    state.activeColor = "blue";
    state.players[0]!.hand = [card("p1-wild4", null, "wild4"), card("p1-red-9", "red", 9), card("p1-green-2", "green", 2)];
    state.players[1]!.hand = [card("p2-wild4", null, "wild4"), card("p2-blue-1", "blue", 1)];
    state.players[2]!.hand = [card("p3-green-8", "green", 8)];

    playCard(state, "p1", "p1-wild4", "green");

    expect(state.pendingStack).toMatchObject({ challengeable: true, offenderId: "p1", guilty: false });
    expect(state.pendingChallenge).toMatchObject({ offenderId: "p1", challengerId: "p2", guilty: false });
  });
});
