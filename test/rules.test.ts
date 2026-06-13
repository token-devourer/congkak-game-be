import { describe, expect, it } from "vitest";
import type { Card } from "@congcard/shared";
import { standardMode } from "../src/engine/modes/standard.js";
import {
  addPlayer,
  callOne,
  catchOne,
  createGame,
  drawCard,
  expireOneWindow,
  handleTurnTimeout,
  playCard,
  resolveChallenge,
  resolvePendingOneCall,
  setPlayerConnected,
  setReady,
  snapshotFor,
  startRound,
  updateSettings,
  type GameStateInternal
} from "../src/engine/game.js";

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

describe("standard mode", () => {
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

    resolveChallenge(state, "p2", true);

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

  it("rejects One calls before the shared window opens", () => {
    const state = controlledGame();
    state.players[0]!.hand = [card("red-1", "red", 1), card("blue-2", "blue", 2)];

    playCard(state, "p1", "red-1");

    expect(() => callOne(state, "p1")).toThrow("One window is open");
  });

  it("rejects catches before the shared window opens", () => {
    const state = controlledGame();
    state.players[0]!.hand = [card("red-1", "red", 1), card("blue-2", "blue", 2)];

    playCard(state, "p1", "red-1");

    expect(() => catchOne(state, "p2", "p1")).toThrow("cannot be caught");
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

    playCard(state, "p2", "red-draw2");

    expect(state.players[0]!.hand).toHaveLength(3);
    expect(state.oneWindow).toBeUndefined();
  });

  it("opens a fresh 108-card deck when there is nothing left to draw", () => {
    const state = controlledGame();
    state.players[0]!.hand = [card("green-9", "green", 9)];
    state.players[1]!.hand = [card("green-8", "green", 8)];
    state.drawPile = [];
    state.discardPile = [card("top", "red", 5)];

    drawCard(state, "p1");

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
    expect(handleTurnTimeout(state)).toBe(true);

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
  });

  it("starts a round from lobby with ready players", () => {
    const state = createGame("ABC123");
    addPlayer(state, "p1", "Ava", "sun");
    addPlayer(state, "p2", "Ben", "moon");
    setReady(state, "p2", true);

    startRound(state);

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
      card("p1-catch-blue-9", "blue", 9),
      card("p1-catch-red-7", "red", 7),
      card("p3-draw2-blue-1", "blue", 1),
      card("p3-draw2-blue-2", "blue", 2)
    ];

    playCard(state, "p1", "p1-red-1");
    expect(snapshotFor(state).currentPlayerId).toBe("p2");
    expect(state.oneWindow?.playerId).toBe("p1");

    playCard(state, "p2", "p2-red-draw2");
    expect(state.players[2]!.hand).toHaveLength(5);
    expect(snapshotFor(state).currentPlayerId).toBe("p1");
    expect(state.oneWindow?.playerId).toBe("p1");

    state.oneWindow!.opensAt = Date.now() - 1;
    state.oneWindow!.deadline = Date.now() + 1000;
    catchOne(state, "p2", "p1");
    expect(state.players[0]!.hand.map((item) => item.id)).toContain("p1-catch-red-7");
    expect(state.oneWindow).toBeUndefined();

    playCard(state, "p1", "p1-catch-red-7");
    expect(snapshotFor(state).currentPlayerId).toBe("p2");

    playCard(state, "p2", "p2-wild4", "blue");
    expect(state.pendingChallenge).toMatchObject({ offenderId: "p2", challengerId: "p3", guilty: false });
    expect(state.oneWindow?.playerId).toBe("p2");

    resolveChallenge(state, "p3", true);
    expect(state.pendingChallenge).toBeUndefined();
    expect(state.players[2]!.hand).toHaveLength(11);
    expect(snapshotFor(state).currentPlayerId).toBe("p1");

    state.oneWindow!.opensAt = Date.now() - 1;
    state.oneWindow!.deadline = Date.now() + 1000;
    callOne(state, "p2");
    state.pendingOneCall!.resolvesAt = Date.now() - 1;
    expect(resolvePendingOneCall(state)).toBe(true);

    expect(state.players[1]!.calledOne).toBe(true);
    expect(state.oneWindow).toBeUndefined();
  });
});
