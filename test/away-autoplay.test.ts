import { describe, expect, it } from "vitest";
import type { Card } from "@congcard/shared";
import {
  addPlayer,
  catchOne,
  createGame,
  playCard,
  resolveAutomatedTurns,
  resolvePendingDraw,
  setPlayerAway,
  setPlayerConnected,
  snapshotFor,
  type GameStateInternal
} from "../src/engine/game.js";

function card(id: string, color: Card["color"], value: Card["value"]): Card {
  return { id, color, value, deckIndex: 0 };
}

// Pre-seed the auto-play delay so it's already elapsed in unit tests.
function resolveNow(state: GameStateInternal): boolean {
  state.autoPlayPendingAt = Date.now() - 2000;
  const changed = resolveAutomatedTurns(state);
  let guard = 0;
  while (state.pendingDraw && guard < 20) {
    if (state.pendingDraw.reveal) state.pendingDraw.reveal.resolvesAt = 0;
    if (state.pendingDraw.settlesAt) state.pendingDraw.settlesAt = 1;
    resolvePendingDraw(state);
    guard += 1;
  }
  return changed;
}

function controlledGame3(absentPlayerAction: "none" | "draw" | "autoplay" = "autoplay"): GameStateInternal {
  const state = createGame("ABC123", { turnTimeoutSec: 30, absentPlayerAction });
  addPlayer(state, "p1", "Ava", "sun");
  addPlayer(state, "p2", "Ben", "moon");
  addPlayer(state, "p3", "Cy", "star");
  state.phase = "playing";
  state.activeColor = "red";
  state.discardPile = [card("discard-red-5", "red", 5)];
  state.drawPile = Array.from({ length: 40 }, (_, index) => card(`draw-${index}`, "blue", (index % 10) as Card["value"]));
  state.currentSeat = 0;
  state.direction = 1;
  state.players[0]!.hand = [];
  state.players[1]!.hand = [];
  state.players[2]!.hand = [];
  return state;
}

describe("smart away autoplay", () => {
  it("plays a matching card instead of drawing", () => {
    const state = controlledGame3();
    state.players[0]!.hand = [card("p1-red-9", "red", 9), card("p1-blue-2", "blue", 2)];
    setPlayerAway(state, "p1", true);

    expect(resolveNow(state)).toBe(true);

    expect(state.discardPile.at(-1)?.id).toBe("p1-red-9");
    expect(state.players[0]!.hand.map((c) => c.id)).toEqual(["p1-blue-2"]);
    expect(snapshotFor(state).currentPlayerId).toBe("p2");
  });

  it("conserves wilds, preferring a colored match", () => {
    const state = controlledGame3();
    state.players[0]!.hand = [card("p1-wild", null, "wild"), card("p1-red-9", "red", 9)];
    setPlayerAway(state, "p1", true);

    resolveNow(state);

    expect(state.discardPile.at(-1)?.id).toBe("p1-red-9");
    expect(state.players[0]!.hand.map((c) => c.id)).toEqual(["p1-wild"]);
  });

  it("draws then plays the drawn card when it is playable", () => {
    const state = controlledGame3();
    state.players[0]!.hand = [card("p1-green-8", "green", 8), card("p1-yellow-3", "yellow", 3)];
    // takeCard pops the tail, so the drawn card is a playable red.
    state.drawPile = [card("filler", "blue", 2), card("drawn-red-7", "red", 7)];
    setPlayerAway(state, "p1", true);

    expect(resolveNow(state)).toBe(true);

    expect(state.discardPile.at(-1)?.id).toBe("discard-red-5");
    expect(state.players[0]!.drawnCardId).toBe("drawn-red-7");
    expect(snapshotFor(state).currentPlayerId).toBe("p1");

    expect(resolveNow(state)).toBe(true);

    expect(state.discardPile.at(-1)?.id).toBe("drawn-red-7");
    expect(state.players[0]!.hand.map((c) => c.id).sort()).toEqual(["p1-green-8", "p1-yellow-3"]);
    expect(snapshotFor(state).currentPlayerId).toBe("p2");
  });

  it("draws and passes only when nothing is playable", () => {
    const state = controlledGame3();
    state.players[0]!.hand = [card("p1-green-8", "green", 8), card("p1-yellow-3", "yellow", 3)];
    state.drawPile = [card("filler", "blue", 1), card("drawn-blue-9", "blue", 9)];
    setPlayerAway(state, "p1", true);

    expect(resolveNow(state)).toBe(true);

    expect(state.players[0]!.drawnCardId).toBe("drawn-blue-9");
    expect(snapshotFor(state).currentPlayerId).toBe("p1");

    expect(resolveNow(state)).toBe(true);

    expect(state.discardPile.at(-1)?.id).toBe("discard-red-5");
    expect(state.players[0]!.hand).toHaveLength(3);
    expect(snapshotFor(state).currentPlayerId).toBe("p2");
  });

  it("auto-stacks a Draw Two when targeted", () => {
    const state = controlledGame3();
    state.settings.stackingEnabled = true;
    // p1 keeps two cards after playing, so dropping to one card does not open a
    // One window that would (correctly) pause autoplay before p2 can stack.
    state.players[0]!.hand = [card("p1-red-draw2", "red", "draw2"), card("p1-blue-1", "blue", 1), card("p1-green-2", "green", 2)];
    state.players[1]!.hand = [card("p2-blue-draw2", "blue", "draw2"), card("p2-yellow-1", "yellow", 1)];
    state.players[2]!.hand = [card("p3-green-8", "green", 8)];
    setPlayerAway(state, "p2", true);

    playCard(state, "p1", "p1-red-draw2");
    expect(state.pendingStack).toMatchObject({ targetPlayerId: "p2", totalDraw: 2 });

    resolveNow(state);

    expect(state.discardPile.at(-1)?.id).toBe("p2-blue-draw2");
    expect(state.pendingStack).toMatchObject({ targetPlayerId: "p3", totalDraw: 4 });
    expect(state.players[1]!.hand.map((c) => c.id)).toEqual(["p2-yellow-1"]);
  });

  it("auto-calls One at one card so an away player cannot be caught", () => {
    const state = controlledGame3();
    state.settings.autoPlayCallOne = true;
    state.players[0]!.hand = [card("p1-red-9", "red", 9), card("p1-blue-2", "blue", 2)];
    setPlayerAway(state, "p1", true);

    // First pass plays down to one card and opens the (not-yet-open) window.
    resolveNow(state);
    expect(state.oneWindow?.playerId).toBe("p1");
    expect(state.players[0]!.calledOne).toBe(false);

    // Once the window is open, the next auto pass calls One and closes it.
    state.oneWindow!.opensAt = Date.now() - 1;
    resolveAutomatedTurns(state);

    expect(state.players[0]!.calledOne).toBe(true);
    expect(state.oneWindow).toBeUndefined();
    expect(() => catchOne(state, "p2", "p1")).toThrow("cannot be caught");
  });

  it("leaves an away autoplay player catchable when automatic One is disabled", () => {
    const state = controlledGame3();
    state.players[0]!.hand = [card("p1-red-9", "red", 9), card("p1-blue-2", "blue", 2)];
    setPlayerAway(state, "p1", true);

    resolveNow(state);
    expect(state.oneWindow?.playerId).toBe("p1");
    state.oneWindow!.opensAt = Date.now() - 1;
    resolveAutomatedTurns(state);

    expect(state.players[0]!.calledOne).toBe(false);
    expect(state.oneWindow?.playerId).toBe("p1");
  });

  it("draw mode always draws and passes even when a held card is playable", () => {
    const state = controlledGame3("draw");
    state.players[0]!.hand = [card("p1-red-9", "red", 9)];
    state.drawPile = [card("filler", "blue", 1), card("drawn-red-7", "red", 7)];
    setPlayerAway(state, "p1", true);

    expect(resolveNow(state)).toBe(true);
    expect(state.discardPile.at(-1)?.id).toBe("discard-red-5");
    expect(state.players[0]!.drawnCardId).toBe("drawn-red-7");
    expect(snapshotFor(state).currentPlayerId).toBe("p1");

    expect(resolveNow(state)).toBe(true);
    expect(state.discardPile.at(-1)?.id).toBe("discard-red-5");
    expect(state.players[0]!.hand).toHaveLength(2);
    expect(snapshotFor(state).currentPlayerId).toBe("p2");
  });

  it("applies draw mode to disconnected players", () => {
    const state = controlledGame3("draw");
    state.players[0]!.hand = [card("p1-red-9", "red", 9)];
    state.drawPile = [card("filler", "blue", 1), card("drawn-blue-7", "blue", 7)];
    setPlayerConnected(state, "p1", false);

    expect(state.players[0]!.autoPlay).toBe(true);
    expect(resolveNow(state)).toBe(true);
    expect(state.players[0]!.drawnCardId).toBe("drawn-blue-7");
    expect(resolveNow(state)).toBe(true);
    expect(snapshotFor(state).currentPlayerId).toBe("p2");
  });

  it("does nothing proactively when absent behavior is disabled", () => {
    const state = controlledGame3("none");
    state.players[0]!.hand = [card("p1-red-9", "red", 9)];
    setPlayerAway(state, "p1", true);

    expect(state.players[0]!.autoPlay).toBe(false);
    expect(resolveAutomatedTurns(state)).toBe(false);
    expect(state.discardPile.at(-1)?.id).toBe("discard-red-5");
    expect(snapshotFor(state).currentPlayerId).toBe("p1");
  });
});
