import { randomInt } from "node:crypto";
import cors from "cors";
import express from "express";
import pino from "pino";
import { matchMaker, Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { createRoomRequestSchema, mergeRoomSettings, ROOM_CODE_ALPHABET, roomCodeSchema } from "@congcard/shared";
import { config } from "./config.js";
import { GameRoom } from "./rooms/GameRoom.js";
import { activeRoomCount, hasRoomCode, registerRoomCode, resolveRoomCode } from "./rooms/directory.js";

const logger = pino({ level: config.logLevel });
const RATE_LIMIT_WINDOW_MS = 60_000;
const CREATE_ROOM_LIMIT = 20;
const RESOLVE_ROOM_LIMIT = 180;

const gameServer = new Server({
  transport: new WebSocketTransport(),
  express: (app) => {
    configureHttp(app);
  }
});

gameServer.define("game", GameRoom);

interface RateLimitBucket {
  count: number;
  resetAt: number;
}

const rateLimitBuckets = new Map<string, RateLimitBucket>();

function sweepExpiredRateLimitBuckets(now: number): void {
  for (const [key, bucket] of rateLimitBuckets) {
    if (now >= bucket.resetAt) {
      rateLimitBuckets.delete(key);
    }
  }
}

function clientIp(request: express.Request): string {
  return request.ip || request.socket.remoteAddress || "unknown";
}

function rateLimit(scope: string, maxRequests: number, windowMs: number): express.RequestHandler {
  return (request, response, next) => {
    const now = Date.now();
    if (rateLimitBuckets.size > 10_000) {
      sweepExpiredRateLimitBuckets(now);
    }

    const key = `${scope}:${clientIp(request)}`;
    const bucket = rateLimitBuckets.get(key);

    if (!bucket || now >= bucket.resetAt) {
      rateLimitBuckets.set(key, { count: 1, resetAt: now + windowMs });
      next();
      return;
    }

    if (bucket.count >= maxRequests) {
      response.status(429).json({ code: "rate_limited", message: "Too many requests. Try again shortly." });
      return;
    }

    bucket.count += 1;
    next();
  };
}

function jsonErrorHandler(
  error: unknown,
  _request: express.Request,
  response: express.Response,
  next: express.NextFunction
): void {
  const typed = error as { type?: string; status?: number } | undefined;
  if (typed?.type === "entity.too.large" || typed?.status === 413) {
    response.status(413).json({ code: "payload_too_large", message: "Request payload is too large." });
    return;
  }

  if (error instanceof SyntaxError) {
    response.status(400).json({ code: "invalid_json", message: "Request body must be valid JSON." });
    return;
  }

  next(error);
}

function corsErrorHandler(
  error: unknown,
  _request: express.Request,
  response: express.Response,
  next: express.NextFunction
): void {
  if (error instanceof Error && error.message === "Origin is not allowed.") {
    response.status(403).json({ code: "origin_not_allowed", message: "Origin is not allowed." });
    return;
  }

  next(error);
}

function configureHttp(app: express.Application): void {
  app.set("trust proxy", 1);
  app.use(express.json({ limit: "16kb" }));
  app.use(jsonErrorHandler);
  app.use(
    cors({
      origin(origin, callback) {
        if (!origin || config.corsOrigins.includes(origin) || config.corsOrigins.includes("*")) {
          callback(null, true);
          return;
        }

        callback(new Error("Origin is not allowed."));
      }
    })
  );
  app.use(corsErrorHandler);

  app.get("/healthz", (_request, response) => {
    response.json({
      ok: true,
      rooms: activeRoomCount()
    });
  });

  app.post("/rooms", rateLimit("create_room", CREATE_ROOM_LIMIT, RATE_LIMIT_WINDOW_MS), async (request, response) => {
    try {
      if (activeRoomCount() >= config.maxRooms) {
        response.status(503).json({ code: "room_limit", message: "The server is at room capacity." });
        return;
      }

      const payload = createRoomRequestSchema.parse(request.body ?? {});
      const settings = mergeRoomSettings({
        turnTimeoutSec: config.turnTimeoutDefault,
        ...payload.settings
      });
      const code = generateRoomCode();
      const room = await matchMaker.createRoom("game", { code, settings });
      registerRoomCode(code, room.roomId);

      response.status(201).json({
        code,
        roomId: room.roomId
      });
    } catch (error) {
      logger.error({ error }, "room_create_failed");
      response.status(400).json({ code: "room_create_failed", message: "Room could not be created." });
    }
  });

  app.get("/rooms/:code", rateLimit("resolve_room", RESOLVE_ROOM_LIMIT, RATE_LIMIT_WINDOW_MS), (request, response) => {
    const parsed = roomCodeSchema.safeParse(request.params.code ?? "");
    if (!parsed.success) {
      response.status(400).json({ code: "invalid_room_code", message: "Room code is invalid." });
      return;
    }

    const code = parsed.data;
    const roomId = resolveRoomCode(code);

    if (!roomId) {
      response.status(404).json({ code: "room_not_found", message: "Room was not found." });
      return;
    }

    response.json({ code, roomId });
  });
}

await gameServer.listen(config.port, undefined, undefined, () => {
  logger.info({ port: config.port }, "congcard_server_ready");
});

function generateRoomCode(): string {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    let code = "";
    for (let index = 0; index < 6; index += 1) {
      code += ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)];
    }

    if (!hasRoomCode(code)) {
      return code;
    }
  }

  throw new Error("Could not generate a unique room code.");
}

async function shutdown(): Promise<void> {
  logger.info("shutting_down");
  await gameServer.gracefullyShutdown(false);
}

process.on("SIGINT", () => {
  void shutdown().then(() => process.exit(0));
});

process.on("SIGTERM", () => {
  void shutdown().then(() => process.exit(0));
});
