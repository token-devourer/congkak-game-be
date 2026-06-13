import { describe, expect, it } from "vitest";
import { joinOptionsSchema, roomCodeSchema } from "@congcard/shared";
import {
  addPlayer,
  createGame,
  kickPlayer,
  removePlayer,
  setReady,
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

  it("lets an accidentally disconnected player reclaim their seat mid-game by clientId", () => {
    const state = createGame("ROOM99");
    addPlayer(state, "host-session", "Host", "sun", "client-host");
    addPlayer(state, "guest-session", "Guest", "moon", "client-guest");
    setReady(state, "guest-session", true);
    startRound(state);
    expect(state.phase).toBe("playing");

    const before = state.players.find((player) => player.clientId === "client-guest");
    const seat = before?.seat;
    const handSize = before?.hand.length ?? 0;
    expect(handSize).toBeGreaterThan(0);

    // Accidental disconnect: in a non-lobby phase the record is kept, just
    // flagged disconnected (this is what removePlayer does after the Colyseus
    // reconnection grace window lapses).
    removePlayer(state, "guest-session");
    const dropped = state.players.find((player) => player.clientId === "client-guest");
    expect(dropped?.connected).toBe(false);
    expect(state.players).toHaveLength(2);

    // Returning with a brand-new sessionId but the same clientId reclaims the
    // existing seat instead of being rejected as a new joiner.
    expect(() => addPlayer(state, "guest-session-2", "Guest", "moon", "client-guest")).not.toThrow();
    const reclaimed = state.players.find((player) => player.clientId === "client-guest");
    expect(state.players).toHaveLength(2);
    expect(reclaimed?.id).toBe("guest-session-2");
    expect(reclaimed?.connected).toBe(true);
    expect(reclaimed?.seat).toBe(seat);
    expect(reclaimed?.hand.length).toBe(handSize);
  });

  it("still rejects a genuinely new player who joins a game in progress", () => {
    const state = createGame("ROOM98");
    addPlayer(state, "host-session", "Host", "sun", "client-host");
    addPlayer(state, "guest-session", "Guest", "moon", "client-guest");
    setReady(state, "guest-session", true);
    startRound(state);

    expect(() => addPlayer(state, "stranger-session", "Stranger", "star", "client-stranger")).toThrow(
      "This room is already playing."
    );
    expect(() => addPlayer(state, "anon-session", "Anon", "star")).toThrow("This room is already playing.");
    expect(state.players).toHaveLength(2);
  });

  it("rejects invalid room codes and avatar ids at the protocol boundary", () => {
    expect(roomCodeSchema.parse("abc234")).toBe("ABC234");
    expect(() => roomCodeSchema.parse("ABC12!")).toThrow();
    expect(() => joinOptionsSchema.parse({ nickname: "Player", avatarId: "../../evil" })).toThrow();
  });
});
