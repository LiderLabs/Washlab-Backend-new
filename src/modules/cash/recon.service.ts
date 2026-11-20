import { randomBytes } from "node:crypto";
import { and, desc, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import { db } from "../../platform/db/index.js";
import { branches } from "../../platform/db/schema/branches.js";
import { customers } from "../../platform/db/schema/customers.js";
import { orders } from "../../platform/db/schema/orders.js";
import { payments } from "../../platform/db/schema/payments.js";
import {
  cashDeductions,
  cashLedger,
  cashReconAllocations,
  cashReconTransactions,
} from "../../platform/db/schema/cash.js";
import { writeAudit } from "../../platform/audit/index.js";
import { AppError, BadRequestError, ConflictError, NotFoundError } from "../../platform/errors/index.js";
import { logger } from "../../platform/logger/index.js";
import { broadcastRealtimeEvent } from "../../platform/realtime/index.js";
import { detectNetwork, MomoNetwork, paystack, PaystackVerification, toLocalGhanaNumber } from "../../platform/paystack/index.js";
import type { StationContext } from "../../platform/auth/station.js";
import { stationService } from "../station/service.js";
import { addDeduction, applySend, ledgerBalance, ledgerDay, lockBranchLedger } from "./ledger.js";

type RequestMeta = { ip?: string; userAgent?: string };
const FEE_BPS = 195n; // Paystack's 1.95% charge on the send

/** pesewas * 1.95%, rounded to the nearest pesewa. */
export const paystackFee = (amount: bigint) => (amount * FEE_BPS + 5000n) / 10000n;
const num = (b: bigint) => Number(b);

export type SettleReconResult =
  | { result: "completed"; transactionId: string; branchId: string }
  | { result: "already_completed"; transactionId: string; branchId: string }
  | { result: "not_found" }
  | { result: "not_successful"; gatewayStatus: string }
  | { result: "mismatch"; expected: string; received: string };

/** Day window [start, end) in UTC for "today", the same bucketing the ledger uses. */
function utcDayBounds(now = new Date()) {
  const day = ledgerDay(now);
  const start = new Date(`${day}T00:00:00.000Z`);
  return { day, start, end: new Date(start.getTime() + 86_400_000) };
}

// ---------- reads ----------

async function summary(station: StationContext) {
  const now = new Date();
  const { day } = utcDayBounds(now);
  const [branch] = await db
    .select({ name: branches.name, email: branches.email, momoNumber: branches.momoNumber })
    .from(branches)
    .where(eq(branches.id, station.branchId))
    .limit(1);
  if (!branch) throw new NotFoundError("Branch not found", "BRANCH_NOT_FOUND");

  const [today] = await db
    .select()
    .from(cashLedger)
    .where(and(eq(cashLedger.branchId, station.branchId), eq(cashLedger.day, day)))
    .limit(1);
  const [all] = await db
    .select({
      collected: sql<string>`COALESCE(SUM(${cashLedger.collected}), 0)::text`,
      sent: sql<string>`COALESCE(SUM(${cashLedger.sent}), 0)::text`,
      deducted: sql<string>`COALESCE(SUM(${cashLedger.deducted}), 0)::text`,
    })
    .from(cashLedger)
    .where(eq(cashLedger.branchId, station.branchId));
  const bal = await ledgerBalance(db, station.branchId);

  const [lastSend] = await db
    .select({ status: cashReconTransactions.status })
    .from(cashReconTransactions)
    .where(and(eq(cashReconTransactions.branchId, station.branchId), sql`${cashReconTransactions.status} <> 'failed'`))
    .orderBy(desc(cashReconTransactions.createdAt))
    .limit(1);

  const todayOutstanding = today?.outstanding ?? 0n;
  const fee = paystackFee(todayOutstanding);
  return {
    branchId: station.branchId,
    branchName: branch.name,
    branchEmail: branch.email,
    momoNumber: branch.momoNumber,
    date: day,
    totalCashPesewas: num(today?.collected ?? 0n),
    orderCount: today?.orderCount ?? 0,
    todaySentPesewas: num(today?.sent ?? 0n),
    todayDeductedPesewas: num(today?.deducted ?? 0n),
    outstandingCashPesewas: num(todayOutstanding),
    /** Everything the branch still owes across all days: the one number every page shows. */
    allTimeOutstandingPesewas: num(bal.outstanding),
    creditBalancePesewas: num(bal.credit),
    totalEverCollectedPesewas: Number(all!.collected),
    totalEverSentPesewas: Number(all!.sent),
    totalEverDeductedPesewas: Number(all!.deducted),
    paystackFeePesewas: num(fee),
    amountAfterFeePesewas: num(todayOutstanding - fee),
    alreadyReconciled: bal.outstanding === 0n && lastSend?.status === "completed",
    reconciliationStatus: lastSend?.status ?? null,
  };
}

async function todayCashOrders(station: StationContext, query: { limit: number; offset: number }) {
  const { start, end } = utcDayBounds();
  const condition = and(
    eq(payments.branchId, station.branchId),
    eq(payments.method, "cash"),
    eq(payments.status, "paid"),
    gte(payments.paidAt, start),
    lt(payments.paidAt, end)
  );
  const [rows, countRows] = await Promise.all([
    db
    .select({
      id: orders.id,
      orderNumber: orders.orderNumber,
      status: orders.status,
      serviceType: orders.serviceType,
      amount: payments.amountPesewas,
      paidAt: payments.paidAt,
      customerName: customers.name,
      customerPhone: customers.phoneNumber,
    })
    .from(payments)
    .innerJoin(orders, eq(orders.id, payments.orderId))
    .innerJoin(customers, eq(customers.id, orders.customerId))
    .where(condition)
    .orderBy(desc(payments.paidAt))
    .limit(query.limit)
    .offset(query.offset),
    db.select({ count: sql<number>`count(*)::int` }).from(payments)
      .innerJoin(orders, eq(orders.id, payments.orderId))
      .innerJoin(customers, eq(customers.id, orders.customerId))
      .where(condition),
  ]);
  return { items: rows.map((r) => ({
    id: r.id,
    orderNumber: r.orderNumber,
    status: r.status,
    serviceType: r.serviceType,
    amountPesewas: num(r.amount),
    paidAt: r.paidAt!.toISOString(),
    customerName: r.customerName,
    customerPhoneNumber: r.customerPhone,
  })), total: countRows[0]?.count ?? 0 };
}

async function todayDeductions(station: StationContext, query: { limit: number; offset: number }) {
  const { day } = utcDayBounds();
  const condition = and(
    eq(cashDeductions.branchId, station.branchId),
    eq(cashDeductions.day, day),
    isNull(cashDeductions.deletedAt)
  );
  const [rows, countRows] = await Promise.all([
    db
    .select()
    .from(cashDeductions)
    .where(condition)
    .orderBy(desc(cashDeductions.createdAt))
    .limit(query.limit)
    .offset(query.offset),
    db.select({ count: sql<number>`count(*)::int` }).from(cashDeductions).where(condition),
  ]);
  return { items: rows.map((d) => ({
    id: d.id,
    amountPesewas: num(d.amountPesewas),
    reason: d.reason,
    createdAt: d.createdAt.toISOString(),
  })), total: countRows[0]?.count ?? 0 };
}

/** Same ledger the summary reads, so history and the main page can never disagree. */
async function history(station: StationContext, query: { limit: number; offset: number }) {
  const [days, dayCountRows, sends, sendCountRows] = await Promise.all([
    db
    .select()
    .from(cashLedger)
    .where(eq(cashLedger.branchId, station.branchId))
    .orderBy(desc(cashLedger.day))
    .limit(query.limit)
    .offset(query.offset),
    db.select({ count: sql<number>`count(*)::int` }).from(cashLedger)
      .where(eq(cashLedger.branchId, station.branchId)),
    db
    .select()
    .from(cashReconTransactions)
    .where(eq(cashReconTransactions.branchId, station.branchId))
    .orderBy(desc(cashReconTransactions.createdAt))
    .limit(query.limit)
    .offset(query.offset),
    db.select({ count: sql<number>`count(*)::int` }).from(cashReconTransactions)
      .where(eq(cashReconTransactions.branchId, station.branchId)),
  ]);
  const allocs = sends.length
    ? await db.select().from(cashReconAllocations).where(inArray(cashReconAllocations.transactionId, sends.map((s) => s.id)))
    : [];
  return {
    daysTotal: dayCountRows[0]?.count ?? 0,
    sendsTotal: sendCountRows[0]?.count ?? 0,
    days: days.map((d) => ({
      day: d.day,
      collectedPesewas: num(d.collected),
      orderCount: d.orderCount,
      sentPesewas: num(d.sent),
      deductedPesewas: num(d.deducted),
      creditAppliedPesewas: num(d.creditApplied),
      outstandingPesewas: num(d.outstanding),
    })),
    sends: sends.map((s) => ({
      id: s.id,
      reference: s.paystackReference,
      status: s.status,
      amountSentPesewas: num(s.amountSentPesewas),
      excessPesewas: num(s.excessPesewas),
      senderMomoNumber: s.senderMomoNumber,
      network: s.network,
      createdAt: s.createdAt.toISOString(),
      completedAt: s.completedAt?.toISOString() ?? null,
      allocations: allocs
        .filter((a) => a.transactionId === s.id)
        .map((a) => ({ day: a.day, amountPesewas: num(a.amountPesewas) }))
        .sort((a, b) => a.day.localeCompare(b.day)),
    })),
  };
}

// ---------- writes ----------

async function addStationDeduction(
  station: StationContext,
  input: { attendantId: string; pin: string; amountPesewas: number; reason: string },
  meta: RequestMeta
) {
  await stationService.verifyActionPin(station, { attendantId: input.attendantId, pin: input.pin });
  const amount = BigInt(input.amountPesewas);
  const now = new Date();
  const id = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(cashDeductions)
      .values({
        branchId: station.branchId,
        attendantId: input.attendantId,
        amountPesewas: amount,
        reason: input.reason,
        day: ledgerDay(now),
      })
      .returning({ id: cashDeductions.id });
    await addDeduction(tx, station.branchId, now, amount);
    await writeAudit(tx, {
      actorId: input.attendantId,
      actorRole: "attendant",
      action: "cash.deduction_added",
      entityType: "cash_deduction",
      entityId: row!.id,
      changes: { branchId: station.branchId, amountPesewas: amount.toString(), reason: input.reason },
      ipAddress: meta.ip,
      userAgent: meta.userAgent,
    });
    return row!.id;
  });
  return { success: true, id };
}

/**
 * Starts a send of collected cash to the company over MoMo. The record is created FIRST, then Paystack is
 * charged, so a dropped connection can never leave money moving with nothing on file: the webhook finds the row.
 */
async function initiate(
  station: StationContext,
  input: { attendantId: string; pin: string; senderMomoNumber: string; network?: MomoNetwork; amountPesewas: number },
  meta: RequestMeta
) {
  await stationService.verifyActionPin(station, { attendantId: input.attendantId, pin: input.pin });

  const [branch] = await db
    .select({ email: branches.email, code: branches.code })
    .from(branches)
    .where(eq(branches.id, station.branchId))
    .limit(1);
  const amount = BigInt(input.amountPesewas);
  const phone = toLocalGhanaNumber(input.senderMomoNumber);
  if (!/^0\d{9}$/.test(phone)) throw new BadRequestError("Enter a valid MoMo number", "INVALID_MOMO_NUMBER");
  const network = input.network ?? detectNetwork(phone);
  const reference = `RECON-${Date.now()}-${randomBytes(4).toString("hex")}`;

  const [row] = await db
    .insert(cashReconTransactions)
    .values({
      branchId: station.branchId,
      attendantId: input.attendantId,
      paystackReference: reference,
      amountSentPesewas: amount,
      senderMomoNumber: phone,
      network,
      status: "pending",
    })
    .returning();

  let charge;
  try {
    charge = await paystack().chargeMobileMoney({
      reference,
      amountPesewas: amount,
      email: branch?.email || "recon@washlab.app",
      phone,
      network,
    });
  } catch (err) {
    await db
      .update(cashReconTransactions)
      .set({ status: "failed", notes: (err instanceof Error ? err.message : "charge failed").slice(0, 500) })
      .where(eq(cashReconTransactions.id, row!.id));
    throw err;
  }

  await db
    .update(cashReconTransactions)
    .set({ status: "processing", displayText: charge.displayText })
    .where(eq(cashReconTransactions.id, row!.id));
  await writeAudit(db, {
    actorId: input.attendantId,
    actorRole: "attendant",
    action: "cash.recon_initiated",
    entityType: "cash_recon",
    entityId: row!.id,
    changes: { branchId: station.branchId, reference, amountPesewas: amount.toString(), network },
    ipAddress: meta.ip,
    userAgent: meta.userAgent,
  });
  return {
    success: true,
    reference,
    status: charge.status,
    displayText: charge.displayText,
    network,
    needsOtp: charge.status === "send_otp",
  };
}

async function ownTransaction(station: StationContext, reference: string) {
  const [tx] = await db
    .select()
    .from(cashReconTransactions)
    .where(and(eq(cashReconTransactions.paystackReference, reference), eq(cashReconTransactions.branchId, station.branchId)))
    .limit(1);
  if (!tx) throw new NotFoundError("Reconciliation not found", "RECON_NOT_FOUND");
  return tx;
}

/**
 * Settles a send from a Paystack-verified transaction. Idempotent: the first call splits the amount across
 * unpaid days (oldest first) under the branch lock, later calls do nothing. Used by the webhook, OTP and verify.
 */
export async function settleRecon(reference: string, gateway: PaystackVerification): Promise<SettleReconResult> {
  const [found] = await db
    .select({ id: cashReconTransactions.id, branchId: cashReconTransactions.branchId })
    .from(cashReconTransactions)
    .where(eq(cashReconTransactions.paystackReference, reference))
    .limit(1);
  if (!found) return { result: "not_found" };
  if (gateway.status !== "success") return { result: "not_successful", gatewayStatus: gateway.status };

  const outcome = await db.transaction(async (tx): Promise<SettleReconResult> => {
    await lockBranchLedger(tx, found.branchId);
    const [t] = await tx.select().from(cashReconTransactions).where(eq(cashReconTransactions.id, found.id)).for("update").limit(1);
    if (!t) return { result: "not_found" };
    if (t.status === "completed") return { result: "already_completed", transactionId: t.id, branchId: t.branchId };

    if (gateway.amountPesewas !== t.amountSentPesewas || gateway.currency !== "GHS") {
      await writeAudit(tx, {
        actorId: "system:paystack",
        actorRole: "system",
        action: "cash.recon_amount_mismatch",
        entityType: "cash_recon",
        entityId: t.id,
        changes: { reference, expectedPesewas: t.amountSentPesewas.toString(), receivedPesewas: gateway.amountPesewas.toString() },
      });
      return { result: "mismatch", expected: t.amountSentPesewas.toString(), received: gateway.amountPesewas.toString() };
    }

    const now = gateway.paidAt ?? new Date();
    const { allocations, excess } = await applySend(tx, t.branchId, t.id, t.amountSentPesewas, now);
    await tx
      .update(cashReconTransactions)
      .set({
        status: "completed",
        completedAt: new Date(),
        paystackTransactionId: gateway.transactionId,
        excessPesewas: excess,
      })
      .where(eq(cashReconTransactions.id, t.id));
    await writeAudit(tx, {
      actorId: "system:paystack",
      actorRole: "system",
      action: "cash.recon_completed",
      entityType: "cash_recon",
      entityId: t.id,
      changes: {
        branchId: t.branchId,
        reference,
        amountPesewas: t.amountSentPesewas.toString(),
        excessPesewas: excess.toString(),
        days: allocations.map((a) => a.day),
      },
    });
    return { result: "completed", transactionId: t.id, branchId: t.branchId };
  });

  if (outcome.result === "completed") {
    void broadcastRealtimeEvent(`branch:${outcome.branchId}`, "cash.updated", { reference });
  }
  return outcome;
}

function mapSettle(r: SettleReconResult) {
  if (r.result === "mismatch") {
    throw new ConflictError("Paystack amount does not match this send. It has been flagged for review.", "AMOUNT_MISMATCH");
  }
  if (r.result === "completed" || r.result === "already_completed") return { status: "completed" as const };
  if (r.result === "not_successful") return { status: r.gatewayStatus };
  return { status: "unknown" as const };
}

async function submitOtp(station: StationContext, reference: string, otp: string) {
  const t = await ownTransaction(station, reference);
  if (t.status === "completed") return { status: "completed", displayText: "" };
  if (t.status === "failed") throw new ConflictError("This send has failed. Start a new one.", "RECON_FAILED");

  const res = await paystack().submitOtp({ reference, otp });
  if (res.status === "success") {
    // Don't trust the OTP reply alone: confirm with Paystack, then settle.
    const verified = await paystack().verify(reference);
    return { ...mapSettle(await settleRecon(reference, verified)), displayText: res.displayText };
  }
  return { status: res.status, displayText: res.displayText };
}

/** Asks Paystack where the send stands (recovery after a dropped connection) and settles if it went through. */
async function verify(station: StationContext, reference: string) {
  const t = await ownTransaction(station, reference);
  if (t.status === "completed") return { status: "completed" };

  const verified = await paystack().verify(reference);
  if (["failed", "abandoned", "reversed"].includes(verified.status)) {
    await db
      .update(cashReconTransactions)
      .set({ status: "failed" })
      .where(and(eq(cashReconTransactions.id, t.id), sql`${cashReconTransactions.status} <> 'completed'`));
    return { status: verified.status };
  }
  return mapSettle(await settleRecon(reference, verified));
}

export const cashService = {
  summary,
  todayCashOrders,
  todayDeductions,
  history,
  addStationDeduction,
  initiate,
  submitOtp,
  verify,
};

void logger;
void AppError;
