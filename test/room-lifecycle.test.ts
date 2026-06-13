import { describe, expect, it } from "vitest";
import { joinOptionsSchema, roomCodeSchema } from "@congcard/shared";
import {
  addPlayer,
  createGame,
  kickPlayer,
  removePlayer,
  setReady,
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

  it("rejects invalid room codes and avatar ids at the protocol boundary", () => {
    expect(roomCodeSchema.parse("abc234")).toBe("ABC234");
    expect(() => roomCodeSchema.parse("ABC12!")).toThrow();
    expect(() => joinOptionsSchema.parse({ nickname: "Player", avatarId: "../../evil" })).toThrow();
  });
});
