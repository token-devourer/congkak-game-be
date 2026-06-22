import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(2567),
  CORS_ORIGINS: z.string().min(1).default("http://localhost:3000"),
  MAX_ROOMS: z.coerce.number().int().min(1).max(100_000).default(100),
  TURN_TIMEOUT_DEFAULT: z.coerce.number().int().min(10).max(120).default(30),
  RECONNECT_GRACE_SEC: z.coerce.number().int().min(0).max(600).default(60),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info")
  ,RANDOMIZE_FLIP_PAIRS: z.enum(["0", "1"]).default("0")
});

export interface AppConfig {
  nodeEnv: "development" | "test" | "production";
  port: number;
  corsOrigins: string[];
  maxRooms: number;
  turnTimeoutDefault: number;
  reconnectGraceSec: number;
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
  randomizeFlipPairs: boolean;
}

export function parseConfig(environment: NodeJS.ProcessEnv): AppConfig {
  const parsed = envSchema.parse(environment);
  const corsOrigins = parsed.CORS_ORIGINS.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  if (corsOrigins.length === 0) {
    throw new Error("CORS_ORIGINS must contain at least one origin.");
  }

  return {
    nodeEnv: parsed.NODE_ENV,
    port: parsed.PORT,
    corsOrigins,
    maxRooms: parsed.MAX_ROOMS,
    turnTimeoutDefault: parsed.TURN_TIMEOUT_DEFAULT,
    reconnectGraceSec: parsed.RECONNECT_GRACE_SEC,
    logLevel: parsed.LOG_LEVEL,
    randomizeFlipPairs: parsed.RANDOMIZE_FLIP_PAIRS === "1"
  };
}

export const config = parseConfig(process.env);

// Emit a small runtime hint so operators can verify randomization setting.
if (config.nodeEnv !== "test") {
  // eslint-disable-next-line no-console
  console.info(`config: nodeEnv=${config.nodeEnv}, randomizeFlipPairs=${config.randomizeFlipPairs}`);
}
