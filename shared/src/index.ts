import { z } from "zod";

export const COLORS = ["red", "yellow", "green", "blue"] as const;
export type Color = (typeof COLORS)[number];

export const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const ROOM_CODE_LENGTH = 6;
export const ROOM_CODE_PATTERN = new RegExp(`^[${ROOM_CODE_ALPHABET}]{${ROOM_CODE_LENGTH}}$`);

export function normalizeRoomCode(code: string): string {
  return code.trim().toUpperCase();
}

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
export type ScoreTarget = 0 | 500 | "lastStand";
export type ParticipantRole = "player" | "waiting" | "spectator";
export type PauseReason = "notEnoughAvailablePlayers";
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
  allowMidGameJoin: boolean;
  jumpInEnabled: boolean;
  stackingEnabled: boolean;
  challengeEnabled: boolean;
  deckBoxes: number;
  modeOptions: Record<string, unknown>;
}

export type RoomSettingsInput = {
  modeId?: RoomSettings["modeId"] | undefined;
  maxPlayers?: RoomSettings["maxPlayers"] | undefined;
  turnTimeoutSec?: RoomSettings["turnTimeoutSec"] | undefined;
  scoreTarget?: RoomSettings["scoreTarget"] | undefined;
  allowMidGameJoin?: RoomSettings["allowMidGameJoin"] | undefined;
  jumpInEnabled?: RoomSettings["jumpInEnabled"] | undefined;
  stackingEnabled?: RoomSettings["stackingEnabled"] | undefined;
  challengeEnabled?: RoomSettings["challengeEnabled"] | undefined;
  deckBoxes?: RoomSettings["deckBoxes"] | undefined;
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
  away: boolean;
  isHost: boolean;
  ready: boolean;
  calledOne: boolean;
  autoPlay: boolean;
  missedDisconnectedTurns: number;
  finishedRank?: number;
  ping: number;
}

export interface PrivatePlayerState {
  id: string;
  role: ParticipantRole;
  hand: Card[];
  drawnCardId?: string;
  resumeToken?: string;
}

export interface PublicViewer {
  id: string;
  nickname: string;
  avatarId: string;
  connected: boolean;
  role: Exclude<ParticipantRole, "player">;
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
  callPending?: boolean;
  callResolvesAt?: number;
}

export interface PendingStack {
  kind: "draw2" | "wild4";
  targetPlayerId: string;
  totalDraw: number;
  challengeable?: boolean;
  offenderId?: string;
  declaredColor?: Color;
  guilty?: boolean;
  roundWinnerId?: string;
}

export interface LastStandPlacement {
  playerId: string;
  rank: number;
  finishedAt: number;
  isLoser?: boolean;
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
  viewers: PublicViewer[];
  self?: PrivatePlayerState;
  discardTop?: Card;
  activeColor?: Color;
  direction: Direction;
  currentPlayerId?: string;
  turnDeadline?: number;
  pendingChallenge?: PendingChallenge;
  pendingStack?: PendingStack;
  pauseReason?: PauseReason;
  oneWindow?: OneWindow;
  roundNumber: number;
  drawPileCount: number;
  actionLog: GameLogEntry[];
  roundWinnerId?: string;
  gameWinnerId?: string;
  lastStandPlacements?: LastStandPlacement[];
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
  buildDeck(playerCount: number, deckBoxes?: number): Card[];
  isPlayable(card: Card, ctx: TurnContext): boolean;
  scoreHand(hand: Card[]): number;
  allowedOutOfTurnActions(ctx: TurnContext): ActionType[];
}

export const DEFAULT_ROOM_SETTINGS: RoomSettings = {
  modeId: "standard",
  maxPlayers: 10,
  turnTimeoutSec: 30,
  scoreTarget: 0,
  allowMidGameJoin: true,
  jumpInEnabled: false,
  stackingEnabled: false,
  challengeEnabled: true,
  deckBoxes: 1,
  modeOptions: {}
};

export const roomSettingsSchema = z.object({
  modeId: z.literal("standard").default("standard"),
  maxPlayers: z.number().int().min(2).max(10).default(10),
  turnTimeoutSec: z.number().int().min(15).max(60).default(30),
  scoreTarget: z.union([z.literal(0), z.literal(500), z.literal("lastStand")]).default(0),
  allowMidGameJoin: z.boolean().default(true),
  jumpInEnabled: z.boolean().default(false),
  stackingEnabled: z.boolean().default(false),
  challengeEnabled: z.boolean().default(true),
  deckBoxes: z.number().int().min(1).max(6).default(1),
  modeOptions: z.record(z.string(), z.unknown()).default({})
});

export const roomSettingsUpdateSchema = z.object({
  modeId: z.literal("standard").optional(),
  maxPlayers: z.number().int().min(2).max(10).optional(),
  turnTimeoutSec: z.number().int().min(15).max(60).optional(),
  scoreTarget: z.union([z.literal(0), z.literal(500), z.literal("lastStand")]).optional(),
  allowMidGameJoin: z.boolean().optional(),
  jumpInEnabled: z.boolean().optional(),
  stackingEnabled: z.boolean().optional(),
  challengeEnabled: z.boolean().optional(),
  deckBoxes: z.number().int().min(1).max(6).optional(),
  modeOptions: z.record(z.string(), z.unknown()).optional()
});

export const roomCodeSchema = z.string().transform(normalizeRoomCode).pipe(z.string().regex(ROOM_CODE_PATTERN));

export const joinOptionsSchema = z.object({
  nickname: z.string().trim().min(1).max(20),
  avatarId: z.enum(AVATARS),
  reconnectToken: z.string().max(512).optional(),
  resumeToken: z.string().max(256).optional()
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

export const setAwaySchema = z.object({
  away: z.boolean()
});

export const kickSchema = z.object({
  playerId: z.string().min(1)
});

export const emoteSchema = z.object({
  emoteId: z.enum(["hello", "nice", "oops", "close", "gg"])
});

export const createRoomRequestSchema = z.object({
  settings: roomSettingsUpdateSchema.optional()
});

export function mergeRoomSettings(input?: RoomSettingsInput): RoomSettings {
  const parsed = roomSettingsUpdateSchema.parse(input ?? {});

  return {
    modeId: parsed.modeId ?? DEFAULT_ROOM_SETTINGS.modeId,
    maxPlayers: parsed.maxPlayers ?? DEFAULT_ROOM_SETTINGS.maxPlayers,
    turnTimeoutSec: parsed.turnTimeoutSec ?? DEFAULT_ROOM_SETTINGS.turnTimeoutSec,
    scoreTarget: parsed.scoreTarget ?? DEFAULT_ROOM_SETTINGS.scoreTarget,
    allowMidGameJoin: parsed.allowMidGameJoin ?? DEFAULT_ROOM_SETTINGS.allowMidGameJoin,
    jumpInEnabled: parsed.jumpInEnabled ?? DEFAULT_ROOM_SETTINGS.jumpInEnabled,
    stackingEnabled: parsed.stackingEnabled ?? DEFAULT_ROOM_SETTINGS.stackingEnabled,
    challengeEnabled: parsed.challengeEnabled ?? DEFAULT_ROOM_SETTINGS.challengeEnabled,
    deckBoxes: parsed.deckBoxes ?? DEFAULT_ROOM_SETTINGS.deckBoxes,
    modeOptions: parsed.modeOptions ?? DEFAULT_ROOM_SETTINGS.modeOptions
  };
}
