import { and, desc, eq, ilike, isNull, notInArray, or, sql, SQL } from "drizzle-orm";
import { db } from "../../platform/db/index.js";
import { branches } from "../../platform/db/schema/branches.js";
import { branchMachines, branchServices } from "../../platform/db/schema/catalog.js";
import { customers } from "../../platform/db/schema/customers.js";
import { orders, orderStatusEvents, BAG_RELEASING_STATUSES } from "../../platform/db/schema/orders.js";
import { payments } from "../../platform/db/schema/payments.js";
import { attendanceLogs, attendants } from "../../platform/db/schema/staff.js";
import { BadRequestError, ConflictError, NotFoundError } from "../../platform/errors/index.js";
import { writeAudit, DbExecutor } from "../../platform/audit/index.js";
import { broadcastRealtimeEvent } from "../../platform/realtime/index.js";
import type { StationContext } from "../../platform/auth/station.js";
import { calculatePrice, ServicePrices } from "./pricing.js";
import { runCompletionEffects } from "./completion.js";
import { randomBytes } from "node:crypto";
import { stationService } from "./service.js";
import { addCollected } from "../cash/ledger.js";
import { settleOrderPayment } from "../payments/settle.js";
import { vouchers, voucherUsages, loyaltyLedger } from "../../platform/db/schema/loyalty.js";
import { paystack } from "../../platform/paystack/index.js";
import { config } from "../../platform/config/index.js";
import type { StationPaymentInput } from "./schemas.js";
import type {
  CancelOrderInput,
  CheckInInput,
  ListOrdersQuery,
  UpdateOrderInput,
  UpdateStatusInput,
  WalkInOrderInput,
} from "./orders.schemas.js";

type RequestMeta = { ip?: string; userAgent?: string };
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type OrderRow = typeof orders.$inferSelect;
type CustomerRow = typeof customers.$inferSelect;

const TERMINAL = ["completed", "cancelled", "delivered"] as const;

function pgCode(err: unknown): string | undefined {
  const e = err as any;
  return e?.code ?? e?.cause?.code;
}
function pgConstraint(err: unknown): string | undefined {
  const e = err as any;
  return e?.constraint_name ?? e?.cause?.constraint_name;
}

/** Ghana numbers: +233XXXXXXXXX. Accepts 0XXXXXXXXX, 233XXXXXXXXX or XXXXXXXXX. */
export function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.startsWith("233")) return `+233${digits.slice(3)}`;
  if (digits.startsWith("0")) return `+233${digits.slice(1)}`;
  return `+233${digits}`;
}

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

// ---------- shared helpers ----------

/** The attendant doing this action must be clocked in at THIS branch. Returns the open attendance row id. */
async function requireClockedIn(executor: DbExecutor, branchId: string, attendantId: string) {
  const [row] = await executor
    .select({ attendanceId: attendanceLogs.id, name: attendants.name })
    .from(attendanceLogs)
    .innerJoin(attendants, eq(attendants.id, attendanceLogs.attendantId))
    .where(
      and(
        eq(attendanceLogs.attendantId, attendantId),
        eq(attendanceLogs.branchId, branchId),
        isNull(attendanceLogs.clockOutAt),
        isNull(attendants.deletedAt),
        eq(attendants.status, "active")
      )
    )
    .limit(1);
  if (!row) {
    throw new BadRequestError("Attendant is not clocked in at this branch", "ATTENDANT_NOT_CLOCKED_IN");
  }
  return row;
}

async function loadBranchPricing(executor: DbExecutor, branchId: string) {
  const [branch] = await executor
    .select({
      code: branches.code,
      fallback: branches.pricingPerKgPesewas,
      deliveryFee: branches.deliveryFeePesewas,
    })
    .from(branches)
    .where(and(eq(branches.id, branchId), isNull(branches.deletedAt)))
    .limit(1);
  if (!branch) throw new NotFoundError("Branch not found", "BRANCH_UNAVAILABLE");

  const rows = await executor
    .select()
    .from(branchServices)
    .where(and(eq(branchServices.branchId, branchId), isNull(branchServices.deletedAt)));
  const services: Record<string, ServicePrices> = {};
  for (const r of rows) {
    services[r.code] = {
      pricePesewas: r.pricePesewas,
      extraWashPricePesewas: r.extraWashPricePesewas,
      extraDryPricePesewas: r.extraDryPricePesewas,
    };
  }
  return { branch, services };
}

async function machinePrice(executor: DbExecutor, branchId: string, machineId: string | null | undefined) {
  if (!machineId) return null;
  const [m] = await executor
    .select({ price: branchMachines.washPricePesewas, isActive: branchMachines.isActive })
    .from(branchMachines)
    .where(
      and(eq(branchMachines.id, machineId), eq(branchMachines.branchId, branchId), isNull(branchMachines.deletedAt))
    )
    .limit(1);
  if (!m || !m.isActive) throw new BadRequestError("Machine not found at this branch", "MACHINE_NOT_FOUND");
  return m.price;
}

function toOrderDto(o: OrderRow, c: CustomerRow | { id: string; name: string; phoneNumber: string; email: string | null }) {
  return {
    id: o.id,
    orderNumber: o.orderNumber,
    orderType: o.orderType,
    status: o.status,
    serviceType: o.serviceType,
    bagNumber: o.bagNumber,
    weightKg: o.weightKg === null ? null : Number(o.weightKg),
    itemCount: o.itemCount,
    estimatedLoads: o.estimatedLoads,
    extraWashLoads: o.extraWashLoads,
    extraDryLoads: o.extraDryLoads,
    whitesSeparate: o.whitesSeparate,
    notes: o.notes,
    isDelivery: o.isDelivery,
    deliveryAddress: o.deliveryAddress,
    deliveryPhone: o.deliveryPhone,
    deliveryHall: o.deliveryHall,
    deliveryRoom: o.deliveryRoom,
    machineId: o.machineId,
    basePricePesewas: Number(o.basePricePesewas),
    deliveryFeePesewas: Number(o.deliveryFeePesewas),
    discountPesewas: Number(o.discountPesewas),
    finalPricePesewas: Number(o.finalPricePesewas),
    paymentStatus: o.paymentStatus,
    paymentMethod: o.paymentMethod,
    createdByAttendantId: o.createdByAttendantId,
    placedAt: o.placedAt.toISOString(),
    checkedInAt: o.checkedInAt?.toISOString() ?? null,
    completedAt: o.completedAt?.toISOString() ?? null,
    updatedAt: o.updatedAt.toISOString(),
    customer: { id: c.id, name: c.name, phoneNumber: c.phoneNumber, email: c.email },
  };
}

/** Realtime payloads carry ids only; the SSE stream is branch-scoped, but customer data still stays out of events. */
function notifyBranch(branchId: string, event: string, order: { id: string; status: string }) {
  void broadcastRealtimeEvent(`branch:${branchId}`, event, { orderId: order.id, status: order.status });
}

async function fetchOrder(executor: DbExecutor, branchId: string, orderId: string) {
  const [row] = await executor
    .select({ order: orders, customer: customers })
    .from(orders)
    .innerJoin(customers, eq(customers.id, orders.customerId))
    .where(and(eq(orders.id, orderId), eq(orders.branchId, branchId), isNull(orders.deletedAt)))
    .limit(1);
  if (!row) throw new NotFoundError("Order not found", "ORDER_NOT_FOUND");
  return row;
}

/** Locks the order row for the rest of the transaction so concurrent edits and status changes queue up. */
async function lockOrder(tx: Tx, branchId: string, orderId: string) {
  const [locked] = await tx
    .select()
    .from(orders)
    .where(and(eq(orders.id, orderId), eq(orders.branchId, branchId), isNull(orders.deletedAt)))
    .for("update")
    .limit(1);
  if (!locked) throw new NotFoundError("Order not found", "ORDER_NOT_FOUND");
  return locked;
}

function translateBagConflict(err: unknown, bag: string): never | void {
  if (pgCode(err) === "23505" && pgConstraint(err) === "idx_orders_active_bag") {
    throw new ConflictError(`Bag number ${bag} is already assigned to an active order`, "BAG_IN_USE");
  }
}

async function nextOrderNumber(tx: Tx, branchCode: string) {
  const res: any = await tx.execute(sql`SELECT nextval('order_number_seq') AS n`);
  const rows = Array.isArray(res) ? res : res.rows;
  const n = String(rows[0].n).padStart(4, "0");
  return `${branchCode.slice(0, 2).toUpperCase()}${n}`;
}

const audit = (
  tx: DbExecutor,
  station: StationContext,
  attendantId: string,
  meta: RequestMeta,
  action: string,
  orderId: string,
  changes: Record<string, unknown>
) =>
  writeAudit(tx, {
    actorId: attendantId,
    actorRole: "attendant",
    action,
    entityType: "order",
    entityId: orderId,
    changes: { branchId: station.branchId, deviceId: station.deviceId, ...changes },
    ipAddress: meta.ip,
    userAgent: meta.userAgent,
  });

// ---------- customers ----------

async function searchCustomers(q: string, limit: number) {
  const digits = q.replace(/\D/g, "");
  const conds: SQL[] = [ilike(customers.name, `%${likeEscape(q)}%`)];
  if (digits.length >= 4) {
    const national = digits.replace(/^(233|0)/, "");
    conds.push(sql`regexp_replace(${customers.phoneNumber}, '\\D', '', 'g') LIKE ${"%" + national + "%"}`);
  }
  const rows = await db
    .select({
      id: customers.id,
      name: customers.name,
      phoneNumber: customers.phoneNumber,
      email: customers.email,
      orderCount: sql<number>`(SELECT count(*)::int FROM orders o WHERE o.customer_id = ${customers.id} AND o.deleted_at IS NULL)`,
      completedOrderCount: sql<number>`(SELECT count(*)::int FROM orders o WHERE o.customer_id = ${customers.id} AND o.deleted_at IS NULL AND o.status = 'completed')`,
    })
    .from(customers)
    .where(and(isNull(customers.deletedAt), isNull(customers.anonymizedAt), or(...conds)))
    .orderBy(customers.name)
    .limit(limit);
  return rows;
}

/** Find a customer by phone or create one (walk-in customers have no app account yet). */
async function findOrCreateCustomer(
  station: StationContext,
  input: { name: string; phoneNumber: string; email?: string },
  meta: RequestMeta
) {
  const phone = normalizePhone(input.phoneNumber);
  if (phone.length < 12) throw new BadRequestError("Invalid phone number", "INVALID_PHONE");

  const find = async () => {
    const [c] = await db
      .select()
      .from(customers)
      .where(and(eq(customers.phoneNumber, phone), isNull(customers.deletedAt)))
      .limit(1);
    return c;
  };
  const existing = await find();
  if (existing) return { customer: existing, created: false };

  try {
    const customer = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(customers)
        .values({ name: input.name, phoneNumber: phone, email: input.email, branchId: station.branchId })
        .returning();
      await writeAudit(tx, {
        actorId: `station:${station.sessionId}`,
        actorRole: "station",
        action: "customer.created_at_station",
        entityType: "customer",
        entityId: row!.id,
        changes: { branchId: station.branchId },
        ipAddress: meta.ip,
        userAgent: meta.userAgent,
      });
      return row!;
    });
    return { customer, created: true };
  } catch (err) {
    // Two tablets registered the same number at once: return the winner.
    if (pgCode(err) === "23505") {
      const winner = await find();
      if (winner) return { customer: winner, created: false };
    }
    throw err;
  }
}

// ---------- reads ----------

async function listOrders(station: StationContext, q: ListOrdersQuery) {
  const conds: (SQL | undefined)[] = [eq(orders.branchId, station.branchId), isNull(orders.deletedAt)];
  if (q.status) conds.push(eq(orders.status, q.status));
  if (q.orderType) conds.push(eq(orders.orderType, q.orderType));

  if (q.search) {
    const like = `%${likeEscape(q.search)}%`;
    const digits = q.search.replace(/\D/g, "");
    const parts: SQL[] = [ilike(orders.orderNumber, like), ilike(orders.bagNumber, like), ilike(customers.name, like)];
    if (digits.length >= 4) {
      parts.push(
        sql`regexp_replace(${customers.phoneNumber}, '\\D', '', 'g') LIKE ${"%" + digits.replace(/^(233|0)/, "") + "%"}`
      );
    }
    conds.push(or(...parts));
  }

  if (q.cursor) {
    const [ts, id] = Buffer.from(q.cursor, "base64url").toString().split("|");
    if (!ts || !id || Number.isNaN(Date.parse(ts))) throw new BadRequestError("Invalid cursor", "INVALID_CURSOR");
    conds.push(
      sql`(${orders.placedAt}, ${orders.id}) < (${new Date(ts).toISOString()}::timestamptz, ${id}::uuid)`
    );
  }

  const rows = await db
    .select({ order: orders, customer: customers })
    .from(orders)
    .innerJoin(customers, eq(customers.id, orders.customerId))
    .where(and(...conds))
    .orderBy(desc(orders.placedAt), desc(orders.id))
    .limit(q.limit + 1);

  const page = rows.slice(0, q.limit);
  const last = page[page.length - 1];
  const nextCursor =
    rows.length > q.limit && last
      ? Buffer.from(`${last.order.placedAt.toISOString()}|${last.order.id}`).toString("base64url")
      : null;
  return { items: page.map((r) => toOrderDto(r.order, r.customer)), nextCursor };
}

async function getOrder(station: StationContext, orderId: string) {
  const { order, customer } = await fetchOrder(db, station.branchId, orderId);

  const history = await db
    .select({
      fromStatus: orderStatusEvents.fromStatus,
      toStatus: orderStatusEvents.toStatus,
      role: orderStatusEvents.changedByRole,
      userId: orderStatusEvents.changedByUserId,
      notes: orderStatusEvents.notes,
      createdAt: orderStatusEvents.createdAt,
      attendantName: attendants.name,
    })
    .from(orderStatusEvents)
    .leftJoin(
      attendants,
      sql`${attendants.id}::text = ${orderStatusEvents.changedByUserId}`
    )
    .where(eq(orderStatusEvents.orderId, orderId))
    .orderBy(orderStatusEvents.createdAt);

  const pay = await db
    .select({
      id: payments.id,
      method: payments.method,
      status: payments.status,
      amount: payments.amountPesewas,
      paidAt: payments.paidAt,
    })
    .from(payments)
    .where(eq(payments.orderId, orderId))
    .orderBy(payments.createdAt);

  return {
    ...toOrderDto(order, customer),
    history: history.map((h) => ({
      fromStatus: h.fromStatus,
      toStatus: h.toStatus,
      changedBy: { type: h.role, name: h.attendantName },
      notes: h.notes,
      createdAt: h.createdAt.toISOString(),
    })),
    payments: pay.map((p) => ({
      id: p.id,
      method: p.method,
      status: p.status,
      amountPesewas: Number(p.amount),
      paidAt: p.paidAt?.toISOString() ?? null,
    })),
  };
}

async function activeBagNumbers(branchId: string) {
  const rows = await db
    .select({ bag: orders.bagNumber })
    .from(orders)
    .where(
      and(
        eq(orders.branchId, branchId),
        isNull(orders.deletedAt),
        sql`${orders.bagNumber} IS NOT NULL`,
        notInArray(orders.status, [...BAG_RELEASING_STATUSES])
      )
    );
  return rows.map((r) => r.bag!).sort();
}

// ---------- writes ----------

async function createWalkIn(station: StationContext, input: WalkInOrderInput, meta: RequestMeta) {
  let created: OrderRow;
  let customer: CustomerRow;
  try {
    ({ created, customer } = await db.transaction(async (tx) => {
      const att = await requireClockedIn(tx, station.branchId, input.attendantId);

      const [cust] = await tx
        .select()
        .from(customers)
        .where(and(eq(customers.id, input.customerId), isNull(customers.deletedAt)))
        .limit(1);
      if (!cust) throw new NotFoundError("Customer not found", "CUSTOMER_NOT_FOUND");

      const { branch, services } = await loadBranchPricing(tx, station.branchId);
      const machinePesewas = await machinePrice(tx, station.branchId, input.machineId);
      const price = calculatePrice({
        mode: "walk_in",
        serviceType: input.serviceType,
        weightKg: input.weightKg,
        services,
        machineWashPricePesewas: machinePesewas,
        branchFallbackPerLoadPesewas: branch.fallback,
        isDelivery: input.isDelivery ?? false,
        branchDeliveryFeePesewas: branch.deliveryFee,
        extraWashLoads: input.extraWashLoads ?? 0,
        extraDryLoads: input.extraDryLoads ?? 0,
      });

      const orderNumber = await nextOrderNumber(tx, branch.code);
      const now = new Date();
      const [row] = await tx
        .insert(orders)
        .values({
          orderNumber,
          orderType: "walk_in",
          customerId: cust.id,
          branchId: station.branchId,
          status: "checked_in",
          serviceType: input.serviceType,
          bagNumber: input.bagNumber,
          weightKg: input.weightKg.toFixed(2),
          itemCount: input.itemCount ?? 1,
          estimatedLoads: price.loads,
          extraWashLoads: input.extraWashLoads ?? 0,
          extraDryLoads: input.extraDryLoads ?? 0,
          machineId: input.machineId,
          whitesSeparate: input.whitesSeparate ?? false,
          notes: input.notes,
          isDelivery: input.isDelivery ?? false,
          deliveryAddress: input.deliveryAddress,
          deliveryPhone: input.deliveryPhone,
          deliveryHall: input.deliveryHall,
          deliveryRoom: input.deliveryRoom,
          basePricePesewas: price.basePricePesewas + price.extrasPesewas,
          deliveryFeePesewas: price.deliveryFeePesewas,
          finalPricePesewas: price.totalPesewas,
          createdByAttendantId: input.attendantId,
          checkedInAt: now,
        })
        .returning();

      await tx.insert(orderStatusEvents).values({
        orderId: row!.id,
        fromStatus: null,
        toStatus: "checked_in",
        attendanceId: att.attendanceId,
        changedByUserId: input.attendantId,
        changedByRole: "attendant",
        notes: "Walk-in order created",
      });
      await audit(tx, station, input.attendantId, meta, "order.walk_in_created", row!.id, {
        orderNumber,
        bagNumber: input.bagNumber,
        serviceType: input.serviceType,
        weightKg: input.weightKg,
        totalPesewas: Number(price.totalPesewas),
      });
      return { created: row!, customer: cust };
    }));
  } catch (err) {
    translateBagConflict(err, input.bagNumber);
    throw err;
  }
  notifyBranch(station.branchId, "order.created", created);
  return toOrderDto(created, customer);
}

async function checkInOnline(station: StationContext, orderId: string, input: CheckInInput, meta: RequestMeta) {
  let updated: OrderRow;
  let customer: CustomerRow;
  try {
    ({ updated, customer } = await db.transaction(async (tx) => {
      const att = await requireClockedIn(tx, station.branchId, input.attendantId);
      const order = await lockOrder(tx, station.branchId, orderId);
      if (order.orderType !== "online") throw new BadRequestError("Only online orders are checked in", "NOT_ONLINE_ORDER");
      if (order.status !== "pending_dropoff") {
        throw new ConflictError("Order is not waiting for drop-off", "ORDER_NOT_PENDING");
      }

      const serviceType = input.serviceType ?? order.serviceType;
      const { branch, services } = await loadBranchPricing(tx, station.branchId);
      const machinePesewas = await machinePrice(tx, station.branchId, input.machineId ?? order.machineId);
      const price = calculatePrice({
        mode: "service",
        serviceType,
        weightKg: input.weightKg,
        services,
        machineWashPricePesewas: machinePesewas,
        branchFallbackPerLoadPesewas: branch.fallback,
        isDelivery: order.isDelivery,
        branchDeliveryFeePesewas: branch.deliveryFee,
        extraWashLoads: input.extraWashLoads ?? 0,
        extraDryLoads: input.extraDryLoads ?? 0,
      });

      const [row] = await tx
        .update(orders)
        .set({
          status: "checked_in",
          serviceType,
          bagNumber: input.bagNumber,
          weightKg: input.weightKg.toFixed(2),
          itemCount: input.itemCount ?? 1,
          estimatedLoads: price.loads,
          extraWashLoads: input.extraWashLoads ?? 0,
          extraDryLoads: input.extraDryLoads ?? 0,
          machineId: input.machineId ?? order.machineId,
          notes: input.notes ?? order.notes,
          basePricePesewas: price.basePricePesewas + price.extrasPesewas,
          deliveryFeePesewas: price.deliveryFeePesewas,
          finalPricePesewas: price.totalPesewas,
          fulfilledByAttendantId: input.attendantId,
          checkedInAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(orders.id, order.id))
        .returning();

      await tx.insert(orderStatusEvents).values({
        orderId: order.id,
        fromStatus: order.status,
        toStatus: "checked_in",
        attendanceId: att.attendanceId,
        changedByUserId: input.attendantId,
        changedByRole: "attendant",
        notes: input.notes,
      });
      // Create (or re-price) the pending MoMo payment so the payment flow has a row to settle.
      await tx
        .insert(payments)
        .values({
          orderId: order.id,
          branchId: station.branchId,
          customerId: order.customerId,
          amountPesewas: price.totalPesewas,
          method: "mobile_money",
          status: "pending",
          idempotencyKey: `order:${order.id}:checkin`,
        })
        .onConflictDoUpdate({
          target: payments.idempotencyKey,
          set: { amountPesewas: price.totalPesewas, updatedAt: new Date() },
          setWhere: eq(payments.status, "pending"),
        });
      await audit(tx, station, input.attendantId, meta, "order.checked_in", order.id, {
        bagNumber: input.bagNumber,
        weightKg: input.weightKg,
        totalPesewas: Number(price.totalPesewas),
      });
      const { customer: cust } = await fetchOrder(tx, station.branchId, order.id);
      return { updated: row!, customer: cust };
    }));
  } catch (err) {
    translateBagConflict(err, input.bagNumber);
    throw err;
  }
  notifyBranch(station.branchId, "order.updated", updated);
  return toOrderDto(updated, customer);
}

async function updateDetails(station: StationContext, orderId: string, input: UpdateOrderInput, meta: RequestMeta) {
  let updated: OrderRow;
  let customer: CustomerRow;
  try {
    ({ updated, customer } = await db.transaction(async (tx) => {
      await requireClockedIn(tx, station.branchId, input.attendantId);
      const order = await lockOrder(tx, station.branchId, orderId);
      if (order.paymentStatus === "paid") throw new ConflictError("Cannot edit a paid order", "ORDER_PAID");
      if (TERMINAL.includes(order.status as any)) throw new ConflictError("Order is closed", "ORDER_CLOSED");
      if (order.status === "pending_dropoff") {
        throw new ConflictError("Check the order in before editing it", "ORDER_NOT_CHECKED_IN");
      }

      const serviceType = input.serviceType ?? order.serviceType;
      const weightKg = input.weightKg ?? Number(order.weightKg ?? 0);
      if (weightKg <= 0) throw new BadRequestError("Order has no weight yet", "NO_WEIGHT");
      const extraWash = input.extraWashLoads ?? order.extraWashLoads;
      const extraDry = input.extraDryLoads ?? order.extraDryLoads;

      const { branch, services } = await loadBranchPricing(tx, station.branchId);
      const machinePesewas = await machinePrice(tx, station.branchId, order.machineId);
      const price = calculatePrice({
        mode: "service",
        serviceType,
        weightKg,
        services,
        machineWashPricePesewas: machinePesewas,
        branchFallbackPerLoadPesewas: branch.fallback,
        isDelivery: order.isDelivery,
        branchDeliveryFeePesewas: branch.deliveryFee,
        extraWashLoads: extraWash,
        extraDryLoads: extraDry,
      });

      const [row] = await tx
        .update(orders)
        .set({
          serviceType,
          weightKg: weightKg.toFixed(2),
          estimatedLoads: price.loads,
          extraWashLoads: extraWash,
          extraDryLoads: extraDry,
          bagNumber: input.bagNumber ?? order.bagNumber,
          notes: input.notes ?? order.notes,
          whitesSeparate: input.whitesSeparate ?? order.whitesSeparate,
          basePricePesewas: price.basePricePesewas + price.extrasPesewas,
          deliveryFeePesewas: price.deliveryFeePesewas,
          finalPricePesewas: price.totalPesewas,
          updatedAt: new Date(),
        })
        .where(eq(orders.id, order.id))
        .returning();

      // Keep any unpaid payment attempt in step with the new price.
      await tx
        .update(payments)
        .set({ amountPesewas: price.totalPesewas, updatedAt: new Date() })
        .where(and(eq(payments.orderId, order.id), eq(payments.status, "pending")));

      await audit(tx, station, input.attendantId, meta, "order.updated", order.id, {
        serviceType,
        weightKg,
        extraWashLoads: extraWash,
        extraDryLoads: extraDry,
        bagNumber: input.bagNumber,
        totalPesewas: Number(price.totalPesewas),
      });
      const { customer: cust } = await fetchOrder(tx, station.branchId, order.id);
      return { updated: row!, customer: cust };
    }));
  } catch (err) {
    if (input.bagNumber) translateBagConflict(err, input.bagNumber);
    throw err;
  }
  notifyBranch(station.branchId, "order.updated", updated);
  return toOrderDto(updated, customer);
}

async function updateStatus(station: StationContext, orderId: string, input: UpdateStatusInput, meta: RequestMeta) {
  const { updated, customer } = await db.transaction(async (tx) => {
    const att = await requireClockedIn(tx, station.branchId, input.attendantId);
    const order = await lockOrder(tx, station.branchId, orderId);

    if (order.status === input.status) throw new ConflictError("Order is already in that status", "STATUS_UNCHANGED");
    if (TERMINAL.includes(order.status as any)) {
      throw new ConflictError(`Order is ${order.status} and cannot change status`, "ORDER_CLOSED");
    }
    if (order.status === "pending_dropoff" && input.status !== "cancelled") {
      throw new ConflictError("Check the order in before processing it", "ORDER_NOT_CHECKED_IN");
    }
    if (input.status === "pending_dropoff") {
      throw new BadRequestError("An order cannot go back to pending drop-off", "INVALID_TRANSITION");
    }

    const now = new Date();
    const [row] = await tx
      .update(orders)
      .set({
        status: input.status,
        updatedAt: now,
        completedAt: input.status === "completed" ? now : order.completedAt,
        fulfilledByAttendantId: input.attendantId,
      })
      .where(eq(orders.id, order.id))
      .returning();

    await tx.insert(orderStatusEvents).values({
      orderId: order.id,
      fromStatus: order.status,
      toStatus: input.status,
      attendanceId: att.attendanceId,
      changedByUserId: input.attendantId,
      changedByRole: "attendant",
      notes: input.notes,
    });
    await audit(tx, station, input.attendantId, meta, "order.status.updated", order.id, {
      from: order.status,
      to: input.status,
    });
    if (input.status === "completed") await runCompletionEffects(tx, row!);
    const { customer: cust } = await fetchOrder(tx, station.branchId, order.id);
    return { updated: row!, customer: cust };
  });
  notifyBranch(station.branchId, "order.updated", updated);
  return toOrderDto(updated, customer);
}

async function cancelOnline(station: StationContext, orderId: string, input: CancelOrderInput, meta: RequestMeta) {
  const { updated, customer } = await db.transaction(async (tx) => {
    const att = await requireClockedIn(tx, station.branchId, input.attendantId);
    const order = await lockOrder(tx, station.branchId, orderId);
    if (order.status !== "pending_dropoff") {
      throw new ConflictError("Only orders waiting for drop-off can be cancelled here", "ORDER_NOT_PENDING");
    }
    const [row] = await tx
      .update(orders)
      .set({ status: "cancelled", updatedAt: new Date() })
      .where(eq(orders.id, order.id))
      .returning();
    await tx.insert(orderStatusEvents).values({
      orderId: order.id,
      fromStatus: order.status,
      toStatus: "cancelled",
      attendanceId: att.attendanceId,
      changedByUserId: input.attendantId,
      changedByRole: "attendant",
      notes: input.reason ?? "Order cancelled by attendant",
    });
    await audit(tx, station, input.attendantId, meta, "order.cancelled", order.id, { reason: input.reason });
    const { customer: cust } = await fetchOrder(tx, station.branchId, order.id);
    return { updated: row!, customer: cust };
  });
  notifyBranch(station.branchId, "order.updated", updated);
  return toOrderDto(updated, customer);
}

/**
 * Take payment for a walk-in order at the counter.
 *  - cash is recorded as paid straight away (optionally with the amount tendered, which returns change)
 *  - mobile money leaves the payment pending until the gateway confirms it
 * The order row is locked, so two taps (or two devices) can never record two payments, and an existing
 * pending payment row for the order is reused rather than duplicated.
 */
async function recordPayment(station: StationContext, orderId: string, input: StationPaymentInput, meta: RequestMeta) {
  // The attendant's PIN is checked first, outside the transaction, so a wrong PIN still counts toward the lockout.
  await stationService.verifyActionPin(station, { attendantId: input.attendantId, pin: input.pin });

  const out = await db.transaction(async (tx) => {
    const att = await requireClockedIn(tx, station.branchId, input.attendantId);
    const order = await lockOrder(tx, station.branchId, orderId);

    if (order.orderType !== "walk_in") {
      throw new ConflictError("Online orders are paid through the customer app", "ORDER_NOT_WALK_IN");
    }
    if (order.status === "cancelled") {
      throw new ConflictError("Cannot take payment for a cancelled order", "ORDER_CANCELLED");
    }
    if (order.paymentStatus === "paid") {
      throw new ConflictError("Order is already paid", "ORDER_ALREADY_PAID");
    }

    // ── Voucher and loyalty discounts ──
    // Both are applied inside this transaction, on top of the order's locked row, so a double tap cannot
    // spend a voucher use or a point twice.
    let amount = order.finalPricePesewas;
    let discountApplied = 0n;

    if (input.voucherCode) {
      const [voucher] = await tx
        .select()
        .from(vouchers)
        .where(and(eq(vouchers.code, input.voucherCode.trim().toUpperCase()), eq(vouchers.isActive, true)))
        .for("update");

      if (!voucher) throw new BadRequestError("Invalid voucher", "INVALID_VOUCHER");
      if (voucher.expiresAt && voucher.expiresAt.getTime() < Date.now()) {
        throw new BadRequestError("This voucher has expired", "VOUCHER_EXPIRED");
      }
      if (voucher.maxUsageCount !== null && voucher.currentUsageCount >= voucher.maxUsageCount) {
        throw new BadRequestError("Voucher usage limit reached", "VOUCHER_LIMIT");
      }
      if (voucher.branchId && voucher.branchId !== station.branchId) {
        throw new BadRequestError("Voucher not valid for this branch", "VOUCHER_WRONG_BRANCH");
      }
      if (amount < voucher.minOrderAmountPesewas) {
        throw new BadRequestError("Order is below the voucher's minimum", "VOUCHER_MIN_ORDER");
      }
      const [already] = await tx
        .select({ id: voucherUsages.id })
        .from(voucherUsages)
        .where(eq(voucherUsages.orderId, order.id))
        .limit(1);
      if (already) throw new ConflictError("A voucher is already applied to this order", "VOUCHER_ALREADY_APPLIED");

      let vDiscount = 0n;
      if (voucher.discountType === "fixed") vDiscount = voucher.discountValue;
      else if (voucher.discountType === "percentage") vDiscount = (amount * voucher.discountValue) / 100n;
      else if (voucher.discountType === "free_wash") vDiscount = amount;
      if (vDiscount > amount) vDiscount = amount;

      discountApplied += vDiscount;
      amount -= vDiscount;

      await tx
        .update(vouchers)
        .set({ currentUsageCount: sql`${vouchers.currentUsageCount} + 1` })
        .where(eq(vouchers.id, voucher.id));
      await tx.insert(voucherUsages).values({
        voucherId: voucher.id,
        orderId: order.id,
        customerId: order.customerId,
        discountAppliedPesewas: vDiscount,
      });
    }

    if (input.loyaltyPointsToRedeem && input.loyaltyPointsToRedeem > 0) {
      if (!order.customerId) throw new BadRequestError("Cannot redeem loyalty for guest orders", "NO_CUSTOMER");

      const [customer] = await tx.select().from(customers).where(eq(customers.id, order.customerId)).for("update");
      if (!customer || customer.loyaltyPoints < input.loyaltyPointsToRedeem) {
        throw new BadRequestError("Insufficient loyalty points", "INSUFFICIENT_POINTS");
      }

      // 1 point = GH₵1 = 100 pesewas. Never take more than what is still owed, and only whole points.
      const wanted = BigInt(input.loyaltyPointsToRedeem) * 100n;
      const loyaltyDiscount = ((wanted > amount ? amount : wanted) / 100n) * 100n;
      const pointsToDeduct = Number(loyaltyDiscount / 100n);

      if (pointsToDeduct > 0) {
        discountApplied += loyaltyDiscount;
        amount -= loyaltyDiscount;

        const newBalance = customer.loyaltyPoints - pointsToDeduct;
        await tx.update(customers).set({ loyaltyPoints: newBalance }).where(eq(customers.id, customer.id));
        await tx.insert(loyaltyLedger).values({
          customerId: customer.id,
          orderId: order.id,
          pointsDelta: -pointsToDeduct,
          balanceAfter: newBalance,
          reason: "reward_redemption",
        });
      }
    }

    if (discountApplied > 0n) {
      await tx
        .update(orders)
        .set({
          discountPesewas: order.discountPesewas + discountApplied,
          finalPricePesewas: amount,
          updatedAt: new Date(),
        })
        .where(eq(orders.id, order.id));
    }

    const isCash = input.paymentMethod === "cash";
    const status = isCash ? "paid" : "pending";

    let tendered: bigint | undefined;
    let change: bigint | undefined;
    if (isCash && input.amountTenderedPesewas !== undefined) {
      tendered = BigInt(input.amountTenderedPesewas);
      if (tendered < amount) {
        throw new BadRequestError("Amount tendered is less than the amount due", "INSUFFICIENT_TENDER");
      }
      change = tendered - amount;
    }

    const now = new Date();
    // Mobile money is paid in the Paystack popup. Each attempt gets its own reference, and the earlier ones
    // are kept so a late confirmation for an abandoned attempt can still be matched.
    const reference = isCash ? null : `WL-${order.orderNumber}-${randomBytes(4).toString("hex")}`;
    const metadata: Record<string, unknown> = {
      attendantId: input.attendantId,
      attendanceId: att.attendanceId,
      ...(tendered !== undefined ? { tenderedPesewas: tendered.toString(), changePesewas: change!.toString() } : {}),
      ...(discountApplied > 0n ? { discountPesewas: discountApplied.toString() } : {}),
    };

    const [pending] = await tx
      .select({ id: payments.id, gatewayReference: payments.gatewayReference, metadata: payments.metadata })
      .from(payments)
      .where(and(eq(payments.orderId, order.id), eq(payments.status, "pending")))
      .for("update")
      .limit(1);

    let paymentId: string;
    if (pending) {
      const prior = (((pending.metadata as any)?.previousReferences as string[] | undefined) ?? []).slice();
      if (pending.gatewayReference && pending.gatewayReference !== reference) prior.push(pending.gatewayReference);
      if (prior.length) metadata.previousReferences = prior;
      await tx
        .update(payments)
        .set({
          method: input.paymentMethod,
          status,
          amountPesewas: amount,
          paidAt: isCash ? now : null,
          gatewayReference: reference ?? pending.gatewayReference,
          processedByAttendantId: input.attendantId,
          metadata,
          updatedAt: now,
        })
        .where(eq(payments.id, pending.id));
      paymentId = pending.id;
    } else {
      const [row] = await tx
        .insert(payments)
        .values({
          orderId: order.id,
          branchId: station.branchId,
          customerId: order.customerId,
          amountPesewas: amount,
          currency: "GHS",
          method: input.paymentMethod,
          status,
          paidAt: isCash ? now : null,
          gatewayReference: reference,
          processedByAttendantId: input.attendantId,
          metadata,
        })
        .returning({ id: payments.id });
      paymentId = row!.id;
    }

    // Cash goes on the ledger in this same transaction, bucketed by the day it was paid.
    if (isCash) await addCollected(tx, station.branchId, now, amount);

    await tx
      .update(orders)
      .set({ paymentStatus: status, paymentMethod: input.paymentMethod, updatedAt: now })
      .where(eq(orders.id, order.id));

    await audit(tx, station, input.attendantId, meta, "order.payment_recorded", order.id, {
      paymentId,
      orderNumber: order.orderNumber,
      method: input.paymentMethod,
      status,
      amountPesewas: amount.toString(),
      ...(tendered !== undefined ? { tenderedPesewas: tendered.toString(), changePesewas: change!.toString() } : {}),
      ...(discountApplied > 0n ? { discountPesewas: discountApplied.toString() } : {}),
    });

    return { paymentId, order, status, amount, change, reference };
  });

  notifyBranch(station.branchId, "order.updated", { id: out.order.id, status: out.order.status });

  return {
    success: true,
    paymentId: out.paymentId,
    orderId: out.order.id,
    orderNumber: out.order.orderNumber,
    status: out.status,
    amountPesewas: out.amount.toString(),
    ...(out.change !== undefined ? { changePesewas: out.change.toString() } : {}),
    ...(out.reference
      ? { reference: out.reference, publicKey: config.PAYSTACK_PUBLIC_KEY ?? null }
      : {}),
  };
}

/**
 * The popup said it worked. Don't take its word: ask Paystack, then settle. If the popup was closed
 * or the network dropped, the attendant can call this again and the webhook is only a backup.
 */
async function finalizePayment(station: StationContext, orderId: string, reference: string) {
  const [row] = await db
    .select({ id: payments.id, status: payments.status, orderId: payments.orderId })
    .from(payments)
    .where(and(eq(payments.orderId, orderId), eq(payments.branchId, station.branchId), eq(payments.gatewayReference, reference)))
    .limit(1);
  // An earlier attempt's reference is also accepted, so a late confirmation of an abandoned popup still lands.
  const found =
    row ??
    (
      await db
        .select({ id: payments.id, status: payments.status, orderId: payments.orderId })
        .from(payments)
        .where(
          and(
            eq(payments.orderId, orderId),
            eq(payments.branchId, station.branchId),
            sql`${payments.metadata} -> 'previousReferences' ? ${reference}`
          )
        )
        .limit(1)
    )[0];
  if (!found) throw new NotFoundError("No payment with that reference for this order", "PAYMENT_NOT_FOUND");
  if (found.status === "paid") return { status: "success", orderId, paymentStatus: "paid" };

  const gateway = await paystack().verify(reference);
  const res = await settleOrderPayment(reference, gateway, "finalize");
  if (res.result === "mismatch") {
    throw new ConflictError("Paystack amount does not match the order. It has been flagged for review.", "AMOUNT_MISMATCH");
  }
  if (res.result === "paid" || res.result === "already_paid") return { status: "success", orderId, paymentStatus: "paid" };
  return { status: res.result === "not_successful" ? res.gatewayStatus : "unknown", orderId, paymentStatus: "pending" };
}

export const stationOrdersService = {
  finalizePayment,
  searchCustomers,
  findOrCreateCustomer,
  listOrders,
  getOrder,
  activeBagNumbers,
  createWalkIn,
  checkInOnline,
  updateDetails,
  updateStatus,
  cancelOnline,
  recordPayment,
};
