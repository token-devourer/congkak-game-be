import { describe, expect, it } from "vitest";
import type { Card } from "@congcard/shared";
import { addPlayer, createGame, playCard, snapshotFor } from "../src/engine/game.js";

function card(id: string, color: Card["color"], value: Card["value"]): Card {
  return { id, color, value, deckIndex: 0 };
}

describe("presentation events", () => {
  it("publishes reconnect-safe card events with authoritative timing", () => {
    const state = createGame("EVENT1");
    addPlayer(state, "p1", "Ava", "sun");
    addPlayer(state, "p2", "Ben", "moon");
    state.phase = "playing";
    state.activeColor = "red";
    state.currentSeat = state.players[0]!.seat;
    state.discardPile = [card("discard", "red", 5)];
    state.drawPile = [card("draw", "blue", 2)];
    state.players[0]!.hand = [card("play", "red", 7), card("keep", "green", 4)];
    state.players[0]!.cardCount = 2;
    state.players[1]!.hand = [card("other", "yellow", 1)];
    state.players[1]!.cardCount = 1;

    playCard(state, "p1", "play");

    const event = snapshotFor(state, "p2").presentationEvents?.at(-1);
    expect(event).toEqual(expect.objectContaining({
      kind: "cardPlayed",
      actorId: "p1",
      cardValue: 7,
      color: "red",
      level: 1
    }));
    expect(event!.id).toBe(event!.seq);
    expect(event!.resolvesAt).toBeGreaterThan(event!.startsAt);
    expect(snapshotFor(state, "p1").presentationEvents).toEqual(snapshotFor(state, "p2").presentationEvents);
  });
});
