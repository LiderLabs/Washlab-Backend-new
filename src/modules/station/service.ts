import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../../platform/db/index.js";
import { branches } from "../../platform/db/schema/branches.js";
import { attendanceLogs, attendantBranches, attendants, stationSessions } from "../../platform/db/schema/staff.js";
import {
  AppError,
  BadRequestError,
  ConflictError,
  NotFoundError,
  UnauthorizedError,
} from "../../platform/errors/index.js";
import { writeAudit } from "../../platform/audit/index.js";
import { hashPin, verifyPin } from "../../platform/crypto/pin.js";
import {
  generateStationToken,
  hashStationToken,
  STATION_SESSION_HOURS,
  StationContext,
} from "../../platform/auth/station.js";
import type { ClockInInput, ClockOutInput, StationLoginInput } from "./schemas.js";

const STATION_PIN_MAX_ATTEMPTS = 10;
const ATTENDANT_PIN_MAX_ATTEMPTS = 5;
const LOCK_MINUTES = 15;

type RequestMeta = { ip?: string; userAgent?: string };

function pgCode(err: unknown): string | undefined {
  const e = err as any;
  return e?.code ?? e?.cause?.code;
}

function lockedError(code: string, lockedUntil: Date) {
  return new AppError("Too many failed attempts. Try again later.", 429, code, {
    lockedUntil: lockedUntil.toISOString(),
  });
}

// ---------- Station login ----------

async function recordStationPinFailure(branchId: string) {
  // All SET expressions see the old row, so "+ 1 >= MAX" locks on the MAX-th failure.
  await db
    .update(branches)
    .set({
      stationPinFailedAttempts: sql`${branches.stationPinFailedAttempts} + 1`,
      stationPinLockedUntil: sql`CASE WHEN ${branches.stationPinFailedAttempts} + 1 >= ${STATION_PIN_MAX_ATTEMPTS}
        THEN now() + make_interval(mins => ${LOCK_MINUTES}) ELSE NULL END`,
    })
    .where(eq(branches.id, branchId));
}

async function login(input: StationLoginInput, meta: RequestMeta) {
  const [branch] = await db
    .select()
    .from(branches)
    .where(and(eq(branches.id, input.branchId), isNull(branches.deletedAt)))
    .limit(1);

  if (!branch || !branch.isActive) {
    throw new NotFoundError("Branch not found or inactive", "BRANCH_UNAVAILABLE");
  }
  if (!branch.stationPinHash) {
    throw new BadRequestError("Station PIN is not configured for this branch", "STATION_PIN_NOT_SET");
  }

  let needsReset = branch.stationPinFailedAttempts > 0;
  if (branch.stationPinLockedUntil) {
    if (branch.stationPinLockedUntil > new Date()) {
      throw lockedError("STATION_LOCKED", branch.stationPinLockedUntil);
    }
    // Lock expired: start counting from zero again.
    await db
      .update(branches)
      .set({ stationPinFailedAttempts: 0, stationPinLockedUntil: null })
      .where(eq(branches.id, branch.id));
    needsReset = false;
  }

  const check = await verifyPin(branch.stationPinHash, input.stationPin);
  if (!check.valid) {
    await recordStationPinFailure(branch.id);
    throw new UnauthorizedError("Invalid station PIN", "INVALID_STATION_PIN");
  }

  if (needsReset || check.needsRehash) {
    await db
      .update(branches)
      .set({
        stationPinFailedAttempts: 0,
        stationPinLockedUntil: null,
        ...(check.needsRehash ? { stationPinHash: await hashPin(input.stationPin) } : {}),
      })
      .where(eq(branches.id, branch.id));
  }

  const token = generateStationToken();
  const expiresAt = new Date(Date.now() + STATION_SESSION_HOURS * 60 * 60 * 1000);

  try {
    const session = await db.transaction(async (tx) => {
      // Logging in again on the same device replaces its session.
      await tx
        .update(stationSessions)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(stationSessions.branchId, branch.id),
            eq(stationSessions.deviceId, input.deviceId),
            isNull(stationSessions.revokedAt)
          )
        );

      const [row] = await tx
        .insert(stationSessions)
        .values({
          branchId: branch.id,
          deviceId: input.deviceId,
          sessionTokenHash: hashStationToken(token),
          deviceInfo: input.deviceInfo,
          ipAddress: meta.ip,
          expiresAt,
        })
        .returning({ id: stationSessions.id });

      await writeAudit(tx, {
        actorId: `station:${row!.id}`,
        actorRole: "station",
        action: "station.logged_in",
        entityType: "station_session",
        entityId: row!.id,
        changes: { branchId: branch.id, deviceId: input.deviceId },
        ipAddress: meta.ip,
        userAgent: meta.userAgent,
      });
      return row!;
    });

    return {
      stationToken: token,
      sessionId: session.id,
      branchId: branch.id,
      branchName: branch.name,
      expiresAt: expiresAt.toISOString(),
    };
  } catch (err) {
    if (pgCode(err) === "23505") {
      throw new ConflictError("A login is already in progress on this device", "STATION_LOGIN_CONFLICT");
    }
    throw err;
  }
}

async function logout(station: StationContext, meta: RequestMeta) {
  await db.transaction(async (tx) => {
    await tx
      .update(stationSessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(stationSessions.id, station.sessionId), isNull(stationSessions.revokedAt)));
    await writeAudit(tx, {
      actorId: `station:${station.sessionId}`,
      actorRole: "station",
      action: "station.logged_out",
      entityType: "station_session",
      entityId: station.sessionId,
      changes: { branchId: station.branchId, deviceId: station.deviceId },
      ipAddress: meta.ip,
      userAgent: meta.userAgent,
    });
  });
  return { success: true };
}

async function getSession(station: StationContext) {
  const [branch] = await db
    .select({ name: branches.name })
    .from(branches)
    .where(eq(branches.id, station.branchId))
    .limit(1);
  return {
    sessionId: station.sessionId,
    branchId: station.branchId,
    branchName: branch?.name ?? "",
    deviceId: station.deviceId,
    expiresAt: station.expiresAt.toISOString(),
  };
}

// ---------- Attendants & attendance ----------

async function listAttendants(branchId: string) {
  const rows = await db
    .select({
      id: attendants.id,
      name: attendants.name,
      homeBranchId: attendants.branchId,
      attendanceId: attendanceLogs.id,
      attendanceBranchId: attendanceLogs.branchId,
      attendanceBranchName: branches.name,
      clockInAt: attendanceLogs.clockInAt,
    })
    .from(attendants)
    .leftJoin(
      attendanceLogs,
      and(eq(attendanceLogs.attendantId, attendants.id), isNull(attendanceLogs.clockOutAt))
    )
    .leftJoin(branches, eq(branches.id, attendanceLogs.branchId))
    .where(
      and(
        isNull(attendants.deletedAt),
        eq(attendants.status, "active"),
        sql`(${attendants.branchId} = ${branchId} OR ${attendants.id} IN (
          SELECT ${attendantBranches.attendantId} FROM ${attendantBranches}
          WHERE ${attendantBranches.branchId} = ${branchId}))`
      )
    )
    .orderBy(asc(attendants.name));

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    isHomeBranch: r.homeBranchId === branchId,
    activeAttendance: r.attendanceId
      ? {
          id: r.attendanceId,
          branchId: r.attendanceBranchId!,
          branchName: r.attendanceBranchName ?? "",
          clockInAt: r.clockInAt!.toISOString(),
        }
      : null,
  }));
}

async function activeAttendances(branchId: string) {
  const rows = await db
    .select({
      attendanceId: attendanceLogs.id,
      attendantId: attendants.id,
      attendantName: attendants.name,
      clockInAt: attendanceLogs.clockInAt,
    })
    .from(attendanceLogs)
    .innerJoin(attendants, eq(attendants.id, attendanceLogs.attendantId))
    .where(and(eq(attendanceLogs.branchId, branchId), isNull(attendanceLogs.clockOutAt)))
    .orderBy(asc(attendanceLogs.clockInAt));

  return rows.map((r) => ({ ...r, clockInAt: r.clockInAt.toISOString() }));
}

type AttendantRow = typeof attendants.$inferSelect;

/** Checks lockout, verifies the PIN, counts failures, upgrades legacy hashes. Throws on any failure. */
async function verifyAttendantPin(attendant: AttendantRow, pin: string) {
  if (!attendant.passcodeHash) {
    throw new BadRequestError("No PIN set for this attendant", "ATTENDANT_PIN_NOT_SET");
  }

  let needsReset = attendant.failedAttempts > 0;
  if (attendant.lockedUntil) {
    if (attendant.lockedUntil > new Date()) throw lockedError("ATTENDANT_LOCKED", attendant.lockedUntil);
    await db
      .update(attendants)
      .set({ failedAttempts: 0, lockedUntil: null })
      .where(eq(attendants.id, attendant.id));
    needsReset = false;
  }

  const check = await verifyPin(attendant.passcodeHash, pin);
  if (!check.valid) {
    await db
      .update(attendants)
      .set({
        failedAttempts: sql`${attendants.failedAttempts} + 1`,
        lockedUntil: sql`CASE WHEN ${attendants.failedAttempts} + 1 >= ${ATTENDANT_PIN_MAX_ATTEMPTS}
          THEN now() + make_interval(mins => ${LOCK_MINUTES}) ELSE NULL END`,
      })
      .where(eq(attendants.id, attendant.id));
    throw new UnauthorizedError("Invalid PIN", "INVALID_PIN");
  }

  if (needsReset || check.needsRehash) {
    await db
      .update(attendants)
      .set({
        failedAttempts: 0,
        lockedUntil: null,
        ...(check.needsRehash ? { passcodeHash: await hashPin(pin) } : {}),
      })
      .where(eq(attendants.id, attendant.id));
  }
}

async function clockIn(station: StationContext, input: ClockInInput, meta: RequestMeta) {
  const [attendant] = await db
    .select()
    .from(attendants)
    .where(and(eq(attendants.id, input.attendantId), isNull(attendants.deletedAt)))
    .limit(1);

  if (!attendant || attendant.status !== "active") {
    throw new NotFoundError("Attendant not found", "ATTENDANT_NOT_FOUND");
  }

  if (attendant.branchId !== station.branchId) {
    const [extra] = await db
      .select({ branchId: attendantBranches.branchId })
      .from(attendantBranches)
      .where(
        and(eq(attendantBranches.attendantId, attendant.id), eq(attendantBranches.branchId, station.branchId))
      )
      .limit(1);
    if (!extra) throw new BadRequestError("Attendant not assigned to this branch", "ATTENDANT_NOT_ASSIGNED");
  }

  await verifyAttendantPin(attendant, input.pin);

  try {
    const attendanceId = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(attendanceLogs)
        .values({ attendantId: attendant.id, branchId: station.branchId, deviceId: station.deviceId })
        .returning({ id: attendanceLogs.id });
      await writeAudit(tx, {
        actorId: attendant.id,
        actorRole: "attendant",
        action: "attendance.clock_in",
        entityType: "attendance_log",
        entityId: row!.id,
        changes: { branchId: station.branchId, deviceId: station.deviceId },
        ipAddress: meta.ip,
        userAgent: meta.userAgent,
      });
      return row!.id;
    });
    return { success: true, attendant: { name: attendant.name }, attendanceId };
  } catch (err) {
    if (pgCode(err) !== "23505") throw err;
    const [open] = await db
      .select({ branchName: branches.name })
      .from(attendanceLogs)
      .innerJoin(branches, eq(branches.id, attendanceLogs.branchId))
      .where(and(eq(attendanceLogs.attendantId, attendant.id), isNull(attendanceLogs.clockOutAt)))
      .limit(1);
    throw new ConflictError(
      `You are already clocked in at ${open?.branchName ?? "another branch"}. Please clock out first.`,
      "ALREADY_CLOCKED_IN"
    );
  }
}

async function clockOut(station: StationContext, input: ClockOutInput, meta: RequestMeta) {
  const [log] = await db
    .select()
    .from(attendanceLogs)
    .where(
      and(
        eq(attendanceLogs.id, input.attendanceId),
        eq(attendanceLogs.branchId, station.branchId),
        isNull(attendanceLogs.clockOutAt)
      )
    )
    .limit(1);
  if (!log) throw new NotFoundError("Attendance record not found", "ATTENDANCE_NOT_FOUND");

  const [attendant] = await db
    .select()
    .from(attendants)
    .where(and(eq(attendants.id, log.attendantId), isNull(attendants.deletedAt)))
    .limit(1);
  if (!attendant) throw new NotFoundError("Attendant not found", "ATTENDANT_NOT_FOUND");

  await verifyAttendantPin(attendant, input.pin);

  await db.transaction(async (tx) => {
    const closed = await tx
      .update(attendanceLogs)
      .set({ clockOutAt: new Date() })
      .where(and(eq(attendanceLogs.id, log.id), isNull(attendanceLogs.clockOutAt)))
      .returning({ id: attendanceLogs.id });
    if (closed.length === 0) throw new NotFoundError("Attendance record not found", "ATTENDANCE_NOT_FOUND");

    await writeAudit(tx, {
      actorId: attendant.id,
      actorRole: "attendant",
      action: "attendance.clock_out",
      entityType: "attendance_log",
      entityId: log.id,
      changes: { branchId: station.branchId, deviceId: station.deviceId },
      ipAddress: meta.ip,
      userAgent: meta.userAgent,
    });
  });

  return { success: true, attendant: { name: attendant.name }, attendanceId: log.id };
}

export const stationService = {
  login,
  logout,
  getSession,
  listAttendants,
  activeAttendances,
  clockIn,
  clockOut,
};
