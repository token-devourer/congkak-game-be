import { z } from "zod";

export const COLORS = ["red", "yellow", "green", "blue"] as const;
export type Color = (typeof COLORS)[number];

export const CARD_VALUES = [
  0,
  1,
  2,
  3,
  4,
  5,
  6,
  7,
  8,
  9,
  "skip",
  "reverse",
  "draw2",
  "wild",
  "wild4"
] as const;

export type CardValue = (typeof CARD_VALUES)[number];
export type GamePhase = "lobby" | "playing" | "roundEnd" | "gameEnd";
export type Direction = 1 | -1;
export type ScoreTarget = 0 | 500;
export type ActionType =
  | "playCard"
  | "drawCard"
  | "playDrawn"
  | "callOne"
  | "catchOne"
  | "challenge";

export interface Card {
  id: string;
  color: Color | null;
  value: CardValue;
  deckIndex: number;
}

export interface RoomSettings {
  modeId: "standard";
  maxPlayers: number;
  turnTimeoutSec: number;
  scoreTarget: ScoreTarget;
  modeOptions: Record<string, unknown>;
}

export type RoomSettingsInput = {
  modeId?: RoomSettings["modeId"] | undefined;
  maxPlayers?: RoomSettings["maxPlayers"] | undefined;
  turnTimeoutSec?: RoomSettings["turnTimeoutSec"] | undefined;
  scoreTarget?: RoomSettings["scoreTarget"] | undefined;
  modeOptions?: RoomSettings["modeOptions"] | undefined;
};

export interface PublicPlayer {
  id: string;
  nickname: string;
  avatarId: string;
  seat: number;
  cardCount: number;
  score: number;
  connected: boolean;
  isHost: boolean;
  ready: boolean;
  calledOne: boolean;
}

export interface PrivatePlayerState {
  id: string;
  hand: Card[];
  drawnCardId?: string;
}

export interface PendingChallenge {
  offenderId: string;
  challengerId: string;
  declaredColor: Color;
  guilty: boolean;
}

export interface OneWindow {
  playerId: string;
  opensAt: number;
  deadline: number;
}

export interface GameLogEntry {
  seq: number;
  type:
    | "room"
    | "play"
    | "draw"
    | "skip"
    | "reverse"
    | "wild"
    | "challenge"
    | "one"
    | "round"
    | "error";
  message: string;
  at: number;
}

export interface GameSnapshot {
  seq: number;
  /** Server wall-clock at snapshot time; clients use it to offset their own
   * clock so deadlines/windows count down in sync with the server. */
  serverNow?: number;
  code: string;
  phase: GamePhase;
  settings: RoomSettings;
  players: PublicPlayer[];
  self?: PrivatePlayerState;
  discardTop?: Card;
  activeColor?: Color;
  direction: Direction;
  currentPlayerId?: string;
  turnDeadline?: number;
  pendingChallenge?: PendingChallenge;
  oneWindow?: OneWindow;
  roundNumber: number;
  drawPileCount: number;
  actionLog: GameLogEntry[];
  roundWinnerId?: string;
  gameWinnerId?: string;
}

export interface RoundResult {
  winnerId: string;
  score: number;
  gameWinnerId?: string;
}

export interface TurnContext {
  playerId: string;
  activeColor: Color;
  discardTop: Card;
  hand: Card[];
  playerCount: number;
}

export interface GameMode {
  id: "standard";
  initialHandSize: number;
  buildDeck(playerCount: number): Card[];
  isPlayable(card: Card, ctx: TurnContext): boolean;
  scoreHand(hand: Card[]): number;
  allowedOutOfTurnActions(ctx: TurnContext): ActionType[];
}

export const DEFAULT_ROOM_SETTINGS: RoomSettings = {
  modeId: "standard",
  maxPlayers: 10,
  turnTimeoutSec: 30,
  scoreTarget: 0,
  modeOptions: {}
};

export const roomSettingsSchema = z.object({
  modeId: z.literal("standard").default("standard"),
  maxPlayers: z.number().int().min(2).max(10).default(10),
  turnTimeoutSec: z.number().int().min(15).max(60).default(30),
  scoreTarget: z.union([z.literal(0), z.literal(500)]).default(0),
  modeOptions: z.record(z.string(), z.unknown()).default({})
});

export const joinOptionsSchema = z.object({
  nickname: z.string().trim().min(1).max(20),
  avatarId: z.string().trim().min(1).max(40),
  reconnectToken: z.string().optional()
});

export const playCardSchema = z.object({
  cardId: z.string().min(1),
  declaredColor: z.enum(COLORS).optional()
});

export const playDrawnSchema = z.object({
  play: z.boolean(),
  declaredColor: z.enum(COLORS).optional()
});

export const catchOneSchema = z.object({
  targetId: z.string().min(1)
});

export const challengeSchema = z.object({
  accept: z.boolean()
});

export const kickSchema = z.object({
  playerId: z.string().min(1)
});

export const emoteSchema = z.object({
  emoteId: z.enum(["hello", "nice", "oops", "close", "gg"])
});

export const createRoomRequestSchema = z.object({
  settings: roomSettingsSchema.partial().optional()
});

export const AVATARS = [
  "sun",
  "moon",
  "star",
  "bolt",
  "leaf",
  "wave",
  "flame",
  "stone",
  "comet",
  "spark",
  "cloud",
  "gem"
] as const;

export function mergeRoomSettings(input?: RoomSettingsInput): RoomSettings {
  const parsed = roomSettingsSchema.partial().parse(input ?? {});

  return {
    modeId: parsed.modeId ?? DEFAULT_ROOM_SETTINGS.modeId,
    maxPlayers: parsed.maxPlayers ?? DEFAULT_ROOM_SETTINGS.maxPlayers,
    turnTimeoutSec: parsed.turnTimeoutSec ?? DEFAULT_ROOM_SETTINGS.turnTimeoutSec,
    scoreTarget: parsed.scoreTarget ?? DEFAULT_ROOM_SETTINGS.scoreTarget,
    modeOptions: parsed.modeOptions ?? DEFAULT_ROOM_SETTINGS.modeOptions
  };
}
