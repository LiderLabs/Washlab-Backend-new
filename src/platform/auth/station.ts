import crypto from "node:crypto";
import { FastifyRequest } from "fastify";
import { and, eq, gt, isNull } from "drizzle-orm";
import { db } from "../db/index.js";
import { branches } from "../db/schema/branches.js";
import { stationSessions } from "../db/schema/staff.js";
import { UnauthorizedError } from "../errors/index.js";

export const STATION_TOKEN_HEADER = "x-station-token";
export const STATION_SESSION_HOURS = 12;

export type StationContext = {
  sessionId: string;
  branchId: string;
  deviceId: string;
  expiresAt: Date;
};

declare module "fastify" {
  interface FastifyRequest {
    station?: StationContext;
  }
}

export function generateStationToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

/** Tokens are 256 bits of randomness, so a plain SHA-256 is enough (no need for a slow hash). */
export function hashStationToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/** preHandler for the attendant app: validates the station session token and loads the branch context. */
export async function authenticateStation(request: FastifyRequest) {
  const token = request.headers[STATION_TOKEN_HEADER];
  if (typeof token !== "string" || token.length === 0) {
    throw new UnauthorizedError("Missing station token", "STATION_TOKEN_MISSING");
  }

  const [row] = await db
    .select({
      sessionId: stationSessions.id,
      branchId: stationSessions.branchId,
      deviceId: stationSessions.deviceId,
      expiresAt: stationSessions.expiresAt,
    })
    .from(stationSessions)
    .innerJoin(branches, eq(branches.id, stationSessions.branchId))
    .where(
      and(
        eq(stationSessions.sessionTokenHash, hashStationToken(token)),
        isNull(stationSessions.revokedAt),
        gt(stationSessions.expiresAt, new Date()),
        isNull(branches.deletedAt),
        eq(branches.isActive, true)
      )
    )
    .limit(1);

  if (!row) {
    throw new UnauthorizedError("Invalid or expired station session", "STATION_SESSION_INVALID");
  }
  request.station = row;
}

export function requireStation(request: FastifyRequest): StationContext {
  if (!request.station) throw new UnauthorizedError("Station is not authenticated", "STATION_SESSION_INVALID");
  return request.station;
}
