import { and, asc, eq, gt, sql } from "drizzle-orm";
import { db } from "../../platform/db/index.js";
import { branches } from "../../platform/db/schema/branches.js";
import { cashCredits, cashLedger, cashReconAllocations } from "../../platform/db/schema/cash.js";
import type { DbExecutor } from "../../platform/audit/index.js";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** The ledger day is the UTC date the cash was paid (payments.paid_at). Never the order's created date. */
export function ledgerDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/**
 * Every ledger write takes this per-branch lock first (released at commit), so two payments, two sends,
 * or a send racing a payment can never interleave and double-allocate. It is taken BEFORE any ledger row
 * is touched, and no ledger code locks order rows, so there is no lock-order cycle.
 */
export async function lockBranchLedger(tx: Tx, branchId: string) {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${"cash-ledger:" + branchId}, 0))`);
}

/** Draws down the oldest credit first. Returns how much of `amount` was covered. */
async function consumeCredit(tx: Tx, branchId: string, amount: bigint): Promise<bigint> {
  let left = amount;
  let covered = 0n;
  const rows = await tx
    .select()
    .from(cashCredits)
    .where(and(eq(cashCredits.branchId, branchId), gt(cashCredits.remainingPesewas, 0n)))
    .orderBy(asc(cashCredits.day), asc(cashCredits.createdAt))
    .for("update");
  for (const c of rows) {
    if (left <= 0n) break;
    const draw = c.remainingPesewas < left ? c.remainingPesewas : left;
    await tx
      .update(cashCredits)
      .set({ remainingPesewas: c.remainingPesewas - draw, updatedAt: new Date() })
      .where(eq(cashCredits.id, c.id));
    left -= draw;
    covered += draw;
  }
  return covered;
}

/** Cash taken at the counter. Call inside the same transaction that marks the payment paid. */
export async function addCollected(tx: Tx, branchId: string, paidAt: Date, amount: bigint) {
  if (amount <= 0n) return;
  await lockBranchLedger(tx, branchId);
  const day = ledgerDay(paidAt);
  const [row] = await tx
    .insert(cashLedger)
    .values({ branchId, day, collected: amount, orderCount: 1 })
    .onConflictDoUpdate({
      target: [cashLedger.branchId, cashLedger.day],
      set: {
        collected: sql`${cashLedger.collected} + ${amount}`,
        orderCount: sql`${cashLedger.orderCount} + 1`,
        updatedAt: new Date(),
      },
    })
    .returning();

  // New debt is offset by any earlier over-send credit, unless the branch is under manual audit.
  if (row!.outstanding > 0n) {
    const [branch] = await tx
      .select({ off: branches.creditAutoApplyDisabled })
      .from(branches)
      .where(eq(branches.id, branchId))
      .limit(1);
    if (!branch?.off) {
      const covered = await consumeCredit(tx, branchId, row!.outstanding);
      if (covered > 0n) {
        await tx
          .update(cashLedger)
          .set({ creditApplied: sql`${cashLedger.creditApplied} + ${covered}` })
          .where(eq(cashLedger.id, row!.id));
      }
    }
  }
}

/** A deduction (money the branch spent that is taken off what it owes). Booked on the day it was made, as before. */
export async function addDeduction(tx: Tx, branchId: string, at: Date, amount: bigint) {
  if (amount <= 0n) return;
  await lockBranchLedger(tx, branchId);
  await tx
    .insert(cashLedger)
    .values({ branchId, day: ledgerDay(at), deducted: amount })
    .onConflictDoUpdate({
      target: [cashLedger.branchId, cashLedger.day],
      set: { deducted: sql`${cashLedger.deducted} + ${amount}`, updatedAt: new Date() },
    });
}

/**
 * Applies a completed MoMo send: split across unpaid days OLDEST first, and anything beyond what is owed
 * becomes credit. Runs under the branch lock, and only once per transaction (the caller guards that).
 */
export async function applySend(tx: Tx, branchId: string, transactionId: string, amount: bigint, at: Date) {
  await lockBranchLedger(tx, branchId);
  const days = await tx
    .select({ id: cashLedger.id, day: cashLedger.day, outstanding: cashLedger.outstanding })
    .from(cashLedger)
    .where(and(eq(cashLedger.branchId, branchId), gt(cashLedger.outstanding, 0n)))
    .orderBy(asc(cashLedger.day))
    .for("update");

  let remaining = amount;
  const allocations: { day: string; amount: bigint }[] = [];
  for (const d of days) {
    if (remaining <= 0n) break;
    const give = d.outstanding < remaining ? d.outstanding : remaining;
    await tx
      .update(cashLedger)
      .set({ sent: sql`${cashLedger.sent} + ${give}`, updatedAt: new Date() })
      .where(eq(cashLedger.id, d.id));
    await tx.insert(cashReconAllocations).values({ transactionId, branchId, day: d.day, amountPesewas: give });
    allocations.push({ day: d.day, amount: give });
    remaining -= give;
  }

  if (remaining > 0n) {
    await tx.insert(cashCredits).values({
      branchId,
      day: ledgerDay(at),
      amountPesewas: remaining,
      remainingPesewas: remaining,
      transactionId,
    });
  }
  return { allocations, excess: remaining };
}

/** What the branch owes and what credit it holds: the numbers every page shows. */
export async function ledgerBalance(executor: DbExecutor, branchId: string) {
  const [o] = await executor
    .select({ outstanding: sql<string>`COALESCE(SUM(${cashLedger.outstanding}), 0)::text` })
    .from(cashLedger)
    .where(eq(cashLedger.branchId, branchId));
  const [c] = await executor
    .select({ credit: sql<string>`COALESCE(SUM(${cashCredits.remainingPesewas}), 0)::text` })
    .from(cashCredits)
    .where(eq(cashCredits.branchId, branchId));
  return { outstanding: BigInt(o!.outstanding), credit: BigInt(c!.credit) };
}
