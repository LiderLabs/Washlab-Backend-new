import { and, asc, desc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { db } from "../../platform/db/index.js";
import { branches } from "../../platform/db/schema/branches.js";
import { attendanceLogs, attendantBranches, attendants, stationSessions } from "../../platform/db/schema/staff.js";
import { orders } from "../../platform/db/schema/orders.js";
import { payments } from "../../platform/db/schema/payments.js";
import { inventoryItems, notifications } from "../../platform/db/schema/operations.js";
import { branchMachines, branchServices } from "../../platform/db/schema/catalog.js";
import { auditLogs } from "../../platform/db/schema/infrastructure.js";
import { customers } from "../../platform/db/schema/customers.js";
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
import type {
  ClockInInput,
  ClockOutInput,
  CreateInventoryItemInput,
  OrderInventoryInput,
  RequestInventoryOrderInput,
  ReceiveInventoryInput,
  StationActivityQuery,
  StationAttendanceHistoryQuery,
  StationLoginInput,
  StationStatsQuery,
  StationTransactionsQuery,
  UpdateStockInput,
  VerifyAttendantPinInput,
} from "./schemas.js";

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

async function listAttendants(branchId: string, query: { limit: number; offset: number }) {
  const condition = and(
    isNull(attendants.deletedAt),
    eq(attendants.status, "active"),
    sql`(${attendants.branchId} = ${branchId} OR ${attendants.id} IN (
      SELECT ${attendantBranches.attendantId} FROM ${attendantBranches}
      WHERE ${attendantBranches.branchId} = ${branchId}))`
  );
  const [rows, countRows] = await Promise.all([
    db
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
    .where(condition)
    .orderBy(asc(attendants.name))
    .limit(query.limit)
    .offset(query.offset),
    db.select({ count: sql<number>`count(*)::int` }).from(attendants).where(condition),
  ]);

  const items = rows.map((r) => ({
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
  return { items, total: countRows[0]?.count ?? 0 };
}

async function activeAttendances(branchId: string, query: { limit: number; offset: number }) {
  const condition = and(eq(attendanceLogs.branchId, branchId), isNull(attendanceLogs.clockOutAt));
  const [rows, countRows] = await Promise.all([
    db
    .select({
      attendanceId: attendanceLogs.id,
      attendantId: attendants.id,
      attendantName: attendants.name,
      clockInAt: attendanceLogs.clockInAt,
    })
    .from(attendanceLogs)
    .innerJoin(attendants, eq(attendants.id, attendanceLogs.attendantId))
    .where(condition)
    .orderBy(asc(attendanceLogs.clockInAt))
    .limit(query.limit)
    .offset(query.offset),
    db.select({ count: sql<number>`count(*)::int` }).from(attendanceLogs).where(condition),
  ]);

  return {
    items: rows.map((r) => ({ ...r, clockInAt: r.clockInAt.toISOString() })),
    total: countRows[0]?.count ?? 0,
  };
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

// ---------- Station Info & Stats ----------

async function getInfo(station: StationContext) {
  const [b] = await db
    .select()
    .from(branches)
    .where(and(eq(branches.id, station.branchId), isNull(branches.deletedAt)))
    .limit(1);

  if (!b) throw new NotFoundError("Branch not found", "BRANCH_NOT_FOUND");

  return {
    branchId: b.id,
    branchName: b.name,
    code: b.code,
    address: b.address,
    city: b.city,
    phoneNumber: b.phoneNumber,
    email: b.email,
    pricingPerKgPesewas: b.pricingPerKgPesewas.toString(),
    deliveryFeePesewas: b.deliveryFeePesewas.toString(),
    terminalId: b.terminalId,
    deviceId: station.deviceId,
    loggedInAt: station.loggedInAt.toISOString(),
  };
}

async function getStats(station: StationContext, query: StationStatsQuery) {
  const start = query.startDate ? new Date(query.startDate) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const end = query.endDate ? new Date(query.endDate) : new Date();
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const conditions = [
    eq(orders.branchId, station.branchId),
    isNull(orders.deletedAt),
    gte(orders.placedAt, start),
    lte(orders.placedAt, end),
  ];
  const [[summary], [todaySummary], statusRows, [activeAttendantCount]] = await Promise.all([
    db
    .select({
      totalOrders: sql<number>`count(*)::int`,
      totalRevenuePesewas: sql<string>`coalesce(sum(${orders.finalPricePesewas}) filter (where ${orders.paymentStatus} = 'paid'), 0)::text`,
    })
    .from(orders)
    .where(and(...conditions)),
    db.select({
      count: sql<number>`count(*)::int`,
      revenuePesewas: sql<string>`coalesce(sum(${orders.finalPricePesewas}) filter (where ${orders.paymentStatus} = 'paid'), 0)::text`,
    }).from(orders).where(and(...conditions, gte(orders.placedAt, todayStart))),
    db.select({ status: orders.status, count: sql<number>`count(*)::int` })
      .from(orders).where(and(...conditions)).groupBy(orders.status),
    db.select({ count: sql<number>`count(*)::int` }).from(attendanceLogs)
      .where(and(eq(attendanceLogs.branchId, station.branchId), isNull(attendanceLogs.clockOutAt))),
  ]);

  const statusCounts = {
    pending: 0,
    in_progress: 0,
    ready_for_pickup: 0,
    delivered: 0,
    completed: 0,
    cancelled: 0,
  };

  for (const row of statusRows) {
    if (row.status === "pending_dropoff") statusCounts.pending += row.count;
    else if (["checked_in", "sorting", "washing", "drying", "folding"].includes(row.status)) statusCounts.in_progress += row.count;
    else if (row.status === "ready_for_pickup") statusCounts.ready_for_pickup += row.count;
    else if (["out_for_delivery", "delivered"].includes(row.status)) statusCounts.delivered += row.count;
    else if (row.status === "completed") statusCounts.completed += row.count;
    else if (row.status === "cancelled") statusCounts.cancelled += row.count;
  }

  return {
    totalOrders: summary?.totalOrders ?? 0,
    totalRevenuePesewas: summary?.totalRevenuePesewas ?? "0",
    todayOrdersCount: todaySummary?.count ?? 0,
    todayRevenuePesewas: todaySummary?.revenuePesewas ?? "0",
    activeAttendantsCount: activeAttendantCount?.count ?? 0,
    ordersByStatus: statusCounts,
  };
}

async function getTransactions(station: StationContext, query: StationTransactionsQuery) {
  const conditions = [eq(payments.branchId, station.branchId)];
  if (query.startDate) conditions.push(gte(payments.createdAt, new Date(query.startDate)));
  if (query.endDate) conditions.push(lte(payments.createdAt, new Date(query.endDate)));

  const [rows, countRows] = await Promise.all([
    db
    .select({
      payment: payments,
      orderNumber: orders.orderNumber,
      customerName: customers.name,
      customerPhone: customers.phoneNumber,
    })
    .from(payments)
    .leftJoin(orders, eq(orders.id, payments.orderId))
    .leftJoin(customers, eq(customers.id, payments.customerId))
    .where(and(...conditions))
    .orderBy(desc(payments.createdAt))
    .limit(query.limit)
    .offset(query.offset),
    db.select({ count: sql<number>`count(*)::int` }).from(payments).where(and(...conditions)),
  ]);

  return { items: rows.map((r) => ({
    id: r.payment.id,
    orderId: r.payment.orderId,
    orderNumber: r.orderNumber,
    customerName: r.customerName,
    customerPhoneNumber: r.customerPhone,
    amountPesewas: r.payment.amountPesewas.toString(),
    currency: r.payment.currency,
    method: r.payment.method,
    status: r.payment.status,
    createdAt: r.payment.createdAt.toISOString(),
  })), total: countRows[0]?.count ?? 0 };
}

async function getActivity(station: StationContext, query: StationActivityQuery) {
  const condition = sql`${auditLogs.changes}->>'branchId' = ${station.branchId} OR ${auditLogs.entityId} = ${station.branchId}`;
  const [rows, countRows] = await Promise.all([
    db
    .select()
    .from(auditLogs)
    .where(condition)
    .orderBy(desc(auditLogs.createdAt))
    .limit(query.limit)
    .offset(query.offset),
    db.select({ count: sql<number>`count(*)::int` }).from(auditLogs).where(condition),
  ]);

  return { items: rows.map((r) => ({
    id: r.id,
    action: r.action,
    actorId: r.performedByUserId,
    actorRole: r.performedByRole,
    entityType: r.entityType,
    entityId: r.entityId,
    changes: r.changes,
    createdAt: r.createdAt.toISOString(),
  })), total: countRows[0]?.count ?? 0 };
}

async function getAttendanceHistory(station: StationContext, query: StationAttendanceHistoryQuery) {
  const conditions = [eq(attendanceLogs.branchId, station.branchId)];
  if (query.attendantId) conditions.push(eq(attendanceLogs.attendantId, query.attendantId));
  if (query.startDate) conditions.push(gte(attendanceLogs.clockInAt, new Date(query.startDate)));
  if (query.endDate) conditions.push(lte(attendanceLogs.clockInAt, new Date(query.endDate)));

  const [rows, countRows] = await Promise.all([
    db
    .select({
      log: attendanceLogs,
      attendantName: attendants.name,
    })
    .from(attendanceLogs)
    .innerJoin(attendants, eq(attendants.id, attendanceLogs.attendantId))
    .where(and(...conditions))
    .orderBy(desc(attendanceLogs.clockInAt))
    .limit(query.limit)
    .offset(query.offset),
    db.select({ count: sql<number>`count(*)::int` }).from(attendanceLogs).where(and(...conditions)),
  ]);

  const items = rows.map((r) => {
    const inTime = r.log.clockInAt.getTime();
    const outTime = r.log.clockOutAt?.getTime();
    const durationMinutes = outTime ? Math.round((outTime - inTime) / 60000) : null;
    return {
      id: r.log.id,
      attendantId: r.log.attendantId,
      attendantName: r.attendantName,
      clockInAt: r.log.clockInAt.toISOString(),
      clockOutAt: r.log.clockOutAt ? r.log.clockOutAt.toISOString() : null,
      durationMinutes,
      deviceId: r.log.deviceId,
    };
  });
  return { items, total: countRows[0]?.count ?? 0 };
}

async function verifyActionPin(station: StationContext, input: VerifyAttendantPinInput) {
  const [attendant] = await db
    .select()
    .from(attendants)
    .where(and(eq(attendants.id, input.attendantId), isNull(attendants.deletedAt)))
    .limit(1);

  if (!attendant || attendant.status !== "active") {
    throw new NotFoundError("Attendant not found or inactive", "ATTENDANT_NOT_FOUND");
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

  return {
    success: true,
    attendant: { id: attendant.id, name: attendant.name, email: attendant.email },
  };
}

// ---------- Inventory ----------


type InventoryRow = typeof inventoryItems.$inferSelect;
const iso = (d: Date | null) => (d ? d.toISOString() : null);

function toInventoryDto(i: InventoryRow) {
  return {
    id: i.id,
    branchId: i.branchId,
    name: i.name,
    category: i.category,
    unit: i.unit,
    description: i.description,
    currentStock: i.currentStock,
    maxStock: i.maxStock,
    minStock: i.minStock,
    reorderPoint: i.reorderPoint,
    status: i.status,
    orderedAt: iso(i.orderedAt),
    orderQuantity: i.orderQuantity,
    expectedArrivalDate: iso(i.expectedArrivalDate),
    arrivalDate: iso(i.arrivalDate),
    lastRestockedAt: iso(i.lastRestockedAt),
    createdAt: i.createdAt.toISOString(),
    updatedAt: i.updatedAt.toISOString(),
  };
}

/**
 * Who is doing an inventory action. With an attendantId they must be clocked in at this branch;
 * without one the action is attributed to the station device (the old app allowed both).
 */
async function resolveInventoryActor(station: StationContext, attendantId?: string) {
  if (!attendantId) return { actorId: `station:${station.sessionId}`, actorRole: "station", name: "An attendant" };
  const [row] = await db
    .select({ id: attendants.id, name: attendants.name })
    .from(attendanceLogs)
    .innerJoin(attendants, eq(attendants.id, attendanceLogs.attendantId))
    .where(
      and(
        eq(attendanceLogs.attendantId, attendantId),
        eq(attendanceLogs.branchId, station.branchId),
        isNull(attendanceLogs.clockOutAt)
      )
    )
    .limit(1);
  if (!row) throw new BadRequestError("Attendant is not clocked in at this branch", "ATTENDANT_NOT_CLOCKED_IN");
  return { actorId: row.id, actorRole: "attendant", name: row.name };
}

async function findBranchItem(station: StationContext, itemId: string) {
  const [item] = await db
    .select()
    .from(inventoryItems)
    .where(
      and(eq(inventoryItems.id, itemId), eq(inventoryItems.branchId, station.branchId), isNull(inventoryItems.deletedAt))
    )
    .limit(1);
  if (!item) throw new NotFoundError("Inventory item not found", "ITEM_NOT_FOUND");
  return item;
}

function stockStatus(stock: number, min: number, reorder: number): "critical" | "low" | "ok" {
  return stock <= min ? "critical" : stock <= reorder ? "low" : "ok";
}

async function listInventory(station: StationContext) {
  const items = await db
    .select()
    .from(inventoryItems)
    .where(and(eq(inventoryItems.branchId, station.branchId), isNull(inventoryItems.deletedAt)))
    .orderBy(asc(inventoryItems.name));

  return items.map((i) => (toInventoryDto(i)));
}

async function createInventory(station: StationContext, input: CreateInventoryItemInput) {
  const status =
    input.currentStock <= input.minStock
      ? "critical"
      : input.currentStock <= input.reorderPoint
        ? "low"
        : "ok";

  const [item] = await db
    .insert(inventoryItems)
    .values({
      branchId: station.branchId,
      name: input.name,
      category: input.category,
      unit: input.unit,
      description: input.description,
      currentStock: input.currentStock,
      maxStock: input.maxStock,
      minStock: input.minStock,
      reorderPoint: input.reorderPoint,
      status,
    })
    .returning();

  return toInventoryDto(item!);
}

async function updateStock(station: StationContext, itemId: string, input: UpdateStockInput) {
  const [item] = await db
    .select()
    .from(inventoryItems)
    .where(
      and(
        eq(inventoryItems.id, itemId),
        eq(inventoryItems.branchId, station.branchId),
        isNull(inventoryItems.deletedAt)
      )
    )
    .limit(1);

  if (!item) throw new NotFoundError("Inventory item not found", "ITEM_NOT_FOUND");

  const newStatus =
    input.currentStock <= item.minStock
      ? "critical"
      : input.currentStock <= item.reorderPoint
        ? "low"
        : "ok";

  const [updated] = await db
    .update(inventoryItems)
    .set({
      currentStock: input.currentStock,
      status: item.status === "ordered" && input.currentStock <= item.reorderPoint ? "ordered" : newStatus,
      updatedAt: new Date(),
    })
    .where(eq(inventoryItems.id, itemId))
    .returning();

  return toInventoryDto(updated!);
}

async function orderInventory(station: StationContext, itemId: string, input: OrderInventoryInput) {
  const item = await findBranchItem(station, itemId);
  const actor = await resolveInventoryActor(station, input.attendantId);
  const now = new Date();

  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(inventoryItems)
      .set({
        status: "ordered",
        orderedAt: now,
        orderQuantity: input.orderQuantity,
        expectedArrivalDate: input.expectedArrivalDate ? new Date(input.expectedArrivalDate) : null,
        updatedAt: now,
      })
      .where(eq(inventoryItems.id, item.id))
      .returning();
    await writeAudit(tx, {
      actorId: actor.actorId,
      actorRole: actor.actorRole,
      action: "inventory.order_placed",
      entityType: "inventory_item",
      entityId: item.id,
      changes: {
        branchId: station.branchId,
        itemName: item.name,
        orderQuantity: input.orderQuantity,
        expectedArrivalDate: input.expectedArrivalDate ?? null,
      },
    });
    return row!;
  });
  return toInventoryDto(updated);
}

async function requestInventoryOrder(station: StationContext, itemId: string, input: RequestInventoryOrderInput) {
  const item = await findBranchItem(station, itemId);
  const actor = await resolveInventoryActor(station, input.attendantId);
  const [branch] = await db.select({ name: branches.name }).from(branches).where(eq(branches.id, station.branchId)).limit(1);
  const now = new Date();

  await db.transaction(async (tx) => {
    await tx.insert(notifications).values({
      recipientType: "admin",
      recipientId: null,
      branchId: station.branchId,
      title: "Inventory Order Request",
      message:
        `${actor.name} at ${branch?.name ?? "a branch"} has requested an order for "${item.name}". ` +
        `Current stock: ${item.currentStock} ${item.unit}.` +
        (input.notes ? ` Notes: ${input.notes}` : ""),
      type: "warning",
      priority: item.status === "critical" ? "high" : "normal",
      entityType: "inventory_item",
      entityId: item.id,
    });
    await tx
      .update(inventoryItems)
      .set({ status: "ordered", orderedAt: now, updatedAt: now })
      .where(eq(inventoryItems.id, item.id));
    await writeAudit(tx, {
      actorId: actor.actorId,
      actorRole: actor.actorRole,
      action: "inventory.order_requested",
      entityType: "inventory_item",
      entityId: item.id,
      changes: { branchId: station.branchId, itemName: item.name, notes: input.notes ?? null },
    });
  });
  return { success: true };
}

async function receiveInventory(station: StationContext, itemId: string, input: ReceiveInventoryInput) {
  const actor = await resolveInventoryActor(station, input.attendantId);

  const updated = await db.transaction(async (tx) => {
    // Lock the item so two deliveries can't both add stock for the same order.
    const [item] = await tx
      .select()
      .from(inventoryItems)
      .where(
        and(eq(inventoryItems.id, itemId), eq(inventoryItems.branchId, station.branchId), isNull(inventoryItems.deletedAt))
      )
      .for("update")
      .limit(1);
    if (!item) throw new NotFoundError("Inventory item not found", "ITEM_NOT_FOUND");
    if (item.status !== "ordered") throw new ConflictError("Item is not in ordered status", "ITEM_NOT_ORDERED");

    const quantity = input.receivedQuantity ?? item.orderQuantity ?? 0;
    if (quantity <= 0) throw new BadRequestError("Enter the quantity received", "QUANTITY_REQUIRED");

    const now = new Date();
    const newStock = item.currentStock + quantity;
    const [row] = await tx
      .update(inventoryItems)
      .set({
        currentStock: newStock,
        status: stockStatus(newStock, item.minStock, item.reorderPoint),
        arrivalDate: now,
        lastRestockedAt: now,
        orderedAt: null,
        orderQuantity: null,
        expectedArrivalDate: null,
        updatedAt: now,
      })
      .where(eq(inventoryItems.id, item.id))
      .returning();
    await writeAudit(tx, {
      actorId: actor.actorId,
      actorRole: actor.actorRole,
      action: "inventory.order_received",
      entityType: "inventory_item",
      entityId: item.id,
      changes: { branchId: station.branchId, itemName: item.name, receivedQuantity: quantity, newStock },
    });
    return row!;
  });
  return toInventoryDto(updated);
}

async function listNotifications(station: StationContext, query: { limit: number; offset: number }) {
  const condition = and(
    eq(notifications.branchId, station.branchId),
    eq(notifications.recipientType, "station")
  );
  const [rows, countRows] = await Promise.all([
    db
    .select()
    .from(notifications)
    .where(condition)
    .orderBy(desc(notifications.createdAt))
    .limit(query.limit)
    .offset(query.offset),
    db.select({ count: sql<number>`count(*)::int` }).from(notifications).where(condition),
  ]);

  return { items: rows.map((n) => ({
    id: n.id,
    title: n.title,
    message: n.message,
    type: n.type,
    priority: n.priority,
    entityType: n.entityType,
    entityId: n.entityId,
    isRead: n.isRead,
    readAt: n.readAt ? n.readAt.toISOString() : null,
    createdAt: n.createdAt.toISOString(),
  })), total: countRows[0]?.count ?? 0 };
}

async function getUnreadNotificationCount(station: StationContext) {
  const [result] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(notifications)
    .where(
      and(
        eq(notifications.branchId, station.branchId),
        eq(notifications.recipientType, "station"),
        eq(notifications.isRead, false)
      )
    );

  return { unreadCount: result?.count ?? 0 };
}

async function markNotificationRead(station: StationContext, id: string) {
  await db
    .update(notifications)
    .set({ isRead: true, readAt: new Date() })
    .where(and(eq(notifications.id, id), eq(notifications.branchId, station.branchId)));

  return { success: true };
}

async function markAllNotificationsRead(station: StationContext) {
  await db
    .update(notifications)
    .set({ isRead: true, readAt: new Date() })
    .where(
      and(
        eq(notifications.branchId, station.branchId),
        eq(notifications.recipientType, "station"),
        eq(notifications.isRead, false)
      )
    );

  return { success: true };
}

// ---------- Machines & Services ----------

async function listMachines(station: StationContext, query: { limit: number; offset: number }) {
  const condition = and(eq(branchMachines.branchId, station.branchId), isNull(branchMachines.deletedAt));
  const [rows, countRows] = await Promise.all([
    db
    .select()
    .from(branchMachines)
    .where(condition)
    .orderBy(asc(branchMachines.name))
    .limit(query.limit)
    .offset(query.offset),
    db.select({ count: sql<number>`count(*)::int` }).from(branchMachines).where(condition),
  ]);

  return { items: rows.map((m) => ({
    id: m.id,
    branchId: m.branchId,
    name: m.name,
    displayName: m.displayName,
    serialNumber: m.serialNumber,
    otherDetails: m.otherDetails,
    washPricePesewas: m.washPricePesewas.toString(),
    isActive: m.isActive,
  })), total: countRows[0]?.count ?? 0 };
}

async function listServices(station: StationContext, query: { limit: number; offset: number }) {
  const condition = and(eq(branchServices.branchId, station.branchId), isNull(branchServices.deletedAt));
  const [rows, countRows] = await Promise.all([
    db
    .select()
    .from(branchServices)
    .where(condition)
    .orderBy(asc(branchServices.name))
    .limit(query.limit)
    .offset(query.offset),
    db.select({ count: sql<number>`count(*)::int` }).from(branchServices).where(condition),
  ]);

  return { items: rows.map((s) => ({
    id: s.id,
    branchId: s.branchId,
    name: s.name,
    code: s.code,
    description: s.description,
    imageUrl: s.imageUrl,
    pricePesewas: s.pricePesewas.toString(),
    extraWashPricePesewas: s.extraWashPricePesewas ? s.extraWashPricePesewas.toString() : null,
    extraDryPricePesewas: s.extraDryPricePesewas ? s.extraDryPricePesewas.toString() : null,
    isActive: s.isActive,
  })), total: countRows[0]?.count ?? 0 };
}


// ---------- Public branch lookup (the tablet's first screen, before any login) ----------

async function listActiveBranches(query: { limit: number; offset: number }) {
  const condition = and(isNull(branches.deletedAt), eq(branches.isActive, true));
  const [rows, countRows] = await Promise.all([
    db
    .select({ code: branches.code, name: branches.name })
    .from(branches)
    .where(condition)
    .orderBy(asc(branches.code))
    .limit(query.limit)
    .offset(query.offset),
    db.select({ count: sql<number>`count(*)::int` }).from(branches).where(condition),
  ]);
  return { items: rows, total: countRows[0]?.count ?? 0 };
}

async function getBranchByCode(rawCode: string) {
  const code = rawCode.trim().toUpperCase();
  const [b] = await db
    .select()
    .from(branches)
    .where(and(eq(branches.code, code), isNull(branches.deletedAt), eq(branches.isActive, true)))
    .limit(1);
  if (!b) throw new NotFoundError("Branch not found", "BRANCH_NOT_FOUND");
  return {
    id: b.id,
    name: b.name,
    code: b.code,
    address: b.address,
    city: b.city,
    phoneNumber: b.phoneNumber,
    email: b.email,
    requireStationLogin: b.requireStationLogin,
    hasStationPin: !!b.stationPinHash,
  };
}

export const stationService = {
  login,
  logout,
  getSession,
  listAttendants,
  activeAttendances,
  clockIn,
  clockOut,
  getInfo,
  getStats,
  getTransactions,
  getActivity,
  getAttendanceHistory,
  verifyActionPin,
  listInventory,
  createInventory,
  updateStock,
  orderInventory,
  requestInventoryOrder,
  listActiveBranches,
  getBranchByCode,
  receiveInventory,
  listNotifications,
  getUnreadNotificationCount,
  markNotificationRead,
  markAllNotificationsRead,
  listMachines,
  listServices,
};
