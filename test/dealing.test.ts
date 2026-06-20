import { describe, expect, it } from "vitest";
import {
  addPlayer,
  autoDealRound,
  beginManualDeal,
  createGame,
  dealRoundCard,
  playCard,
  reshuffleRoundDeck,
  resolveRoundDeal,
  setPlayerAway,
  setReady,
  snapshotFor,
  startRound,
  type GameStateInternal
} from "../src/engine/game.js";

function lobby(scoreTarget: 0 | 500 | "lastStand" = 0): GameStateInternal {
  const state = createGame("DEAL42", { scoreTarget });
  addPlayer(state, "host", "Host", "sun");
  addPlayer(state, "p2", "Second", "moon");
  addPlayer(state, "p3", "Third", "star");
  setReady(state, "p2", true);
  setReady(state, "p3", true);
  return state;
}

function resolveCurrentEvent(state: GameStateInternal): void {
  const event = state.roundDeal?.event;
  if (!event) return;
  event.startsAt = 0;
  event.resolvesAt = 0;
  resolveRoundDeal(state);
}

function finishAutomaticDeal(state: GameStateInternal): void {
  for (let index = 0; index < 5 && state.phase === "dealing"; index += 1) {
    resolveCurrentEvent(state);
  }
}

describe("synchronized round dealing", () => {
  it("automatically deals standard rounds and conceals hands until play begins", () => {
    const state = lobby();
    startRound(state);

    expect(state.phase).toBe("dealing");
    expect(state.roundDeal?.stage).toBe("auto");
    expect(snapshotFor(state, "host").self?.hand).toEqual([]);
    expect(snapshotFor(state).roundDeal?.event?.kind).toBe("deal");

    finishAutomaticDeal(state);

    expect(state.phase).toBe("playing");
    expect(state.players.every((player) => player.hand.length >= 7)).toBe(true);
    expect(snapshotFor(state, "host").self?.hand.length).toBeGreaterThanOrEqual(7);
    expect(state.discardPile).toHaveLength(1);
  });

  it("assigns the host for the first Last Stand round", () => {
    const state = lobby("lastStand");
    startRound(state);

    expect(state.roundDeal).toMatchObject({
      dealerPlayerId: "host",
      firstPlayerId: "host",
      stage: "shuffleChoice",
      readyPlayerCount: 0,
      totalPlayerCount: 3
    });
  });

  it("assigns the prior loser as dealer and first finisher as starter", () => {
    const state = lobby("lastStand");
    state.phase = "roundEnd";
    state.lastStandPlacements = [
      { playerId: "p2", rank: 1, finishedAt: 1 },
      { playerId: "host", rank: 2, finishedAt: 2 },
      { playerId: "p3", rank: 3, finishedAt: 3, isLoser: true }
    ];

    startRound(state);

    expect(state.roundDeal?.dealerPlayerId).toBe("p3");
    expect(state.roundDeal?.firstPlayerId).toBe("p2");
  });

  it("supports reshuffle, arbitrary manual targets, and partial auto completion", () => {
    const state = lobby("lastStand");
    startRound(state);
    reshuffleRoundDeck(state, "host");
    expect(state.roundDeal?.event?.kind).toBe("shuffle");
    expect(() => beginManualDeal(state, "host")).toThrow("cannot begin");
    resolveCurrentEvent(state);

    beginManualDeal(state, "host");
    dealRoundCard(state, "host", "p3");
    resolveCurrentEvent(state);
    dealRoundCard(state, "host", "host");
    resolveCurrentEvent(state);

    expect(state.players.find((player) => player.id === "p3")?.hand).toHaveLength(1);
    expect(state.players.find((player) => player.id === "host")?.hand).toHaveLength(1);
    autoDealRound(state, "host");
    finishAutomaticDeal(state);

    expect(state.phase).toBe("playing");
    expect(state.players.every((player) => player.hand.length >= 7)).toBe(true);
  });

  it("rejects non-dealers, full targets, and gameplay actions during setup", () => {
    const state = lobby("lastStand");
    startRound(state);
    expect(() => beginManualDeal(state, "p2")).toThrow("assigned dealer");
    beginManualDeal(state, "host");
    state.players[1]!.hand = state.drawPile.splice(-7);
    expect(() => dealRoundCard(state, "host", "p2")).toThrow("enough cards");
    expect(() => playCard(state, "host", "missing")).toThrow("not currently playing");
  });

  it("reassigns an unavailable dealer and auto-deals after inactivity", () => {
    const state = lobby("lastStand");
    startRound(state);
    setPlayerAway(state, "host", true);
    expect(state.roundDeal?.dealerPlayerId).toBe("p2");

    state.roundDeal!.inactivityDeadline = 1;
    expect(resolveRoundDeal(state)).toBe(true);
    expect(state.roundDeal?.stage).toBe("auto");
    expect(state.roundDeal?.event?.kind).toBe("deal");
  });

  it("uses adaptive automatic timing and conserves every card", () => {
    const state = lobby();
    startRound(state);
    const event = state.roundDeal?.event;
    expect(event?.kind).toBe("deal");
    if (event?.kind === "deal") {
      const sequenceSpan = (event.targetPlayerIds.length - 1) * event.cardIntervalMs;
      expect(sequenceSpan).toBeGreaterThanOrEqual(5_000);
      expect(sequenceSpan).toBeLessThanOrEqual(10_000);
    }
    finishAutomaticDeal(state);

    const total = state.drawPile.length + state.discardPile.length + state.players.reduce((sum, player) => sum + player.hand.length, 0);
    expect(total).toBe(108);
  });
});
