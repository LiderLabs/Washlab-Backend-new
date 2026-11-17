import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../../platform/db/index.js";
import { branches } from "../../platform/db/schema/branches.js";
import { cashCredits, cashLedger, cashReconAllocations, cashReconTransactions } from "../../platform/db/schema/cash.js";
import { addCollected, addDeduction, applySend, ledgerBalance, ledgerDay } from "./ledger.js";
import { destroyBranch, makeBranch } from "./test-helpers.js";

let f: Awaited<ReturnType<typeof makeBranch>>;
const at = (d: string) => new Date(`${d}T12:00:00.000Z`);

const collect = (d: string, amt: bigint) => db.transaction((tx) => addCollected(tx, f.branchId, at(d), amt));
async function send(amount: bigint, when = "2026-02-01") {
  const [t] = await db
    .insert(cashReconTransactions)
    .values({
      branchId: f.branchId,
      paystackReference: `T-${Math.random().toString(36).slice(2)}`,
      amountSentPesewas: amount,
      senderMomoNumber: "0241234567",
      status: "processing",
    })
    .returning();
  const res = await db.transaction((tx) => applySend(tx, f.branchId, t!.id, amount, at(when)));
  return { t: t!, ...res };
}
const row = async (d: string) => (await db.select().from(cashLedger).where(and(eq(cashLedger.branchId, f.branchId), eq(cashLedger.day, d))))[0];

// each test gets a clean ledger
async function reset() {
  await db.delete(cashReconAllocations).where(eq(cashReconAllocations.branchId, f.branchId));
  await db.delete(cashCredits).where(eq(cashCredits.branchId, f.branchId));
  await db.delete(cashReconTransactions).where(eq(cashReconTransactions.branchId, f.branchId));
  await db.delete(cashLedger).where(eq(cashLedger.branchId, f.branchId));
}

beforeAll(async () => {
  f = await makeBranch("LG");
});
afterAll(() => destroyBranch(f));

describe("ledger", () => {
  it("buckets cash by the day it was paid and computes outstanding in the database", async () => {
    await reset();
    await collect("2026-02-01", 5000n);
    await collect("2026-02-01", 2500n);
    await collect("2026-02-02", 1000n);
    expect((await row("2026-02-01"))).toMatchObject({ collected: 7500n, orderCount: 2, outstanding: 7500n });
    expect((await row("2026-02-02"))!.outstanding).toBe(1000n);
    expect((await ledgerBalance(db, f.branchId)).outstanding).toBe(8500n);
    expect(ledgerDay(new Date("2026-02-01T23:59:59.999Z"))).toBe("2026-02-01");
    expect(ledgerDay(new Date("2026-02-02T00:00:00.000Z"))).toBe("2026-02-02");
  });

  it("a send pays the OLDEST unpaid day first, then the next", async () => {
    await reset();
    await collect("2026-02-01", 5000n);
    await collect("2026-02-02", 4000n);
    await collect("2026-02-03", 3000n);
    const r = await send(7000n);
    expect(r.allocations).toEqual([
      { day: "2026-02-01", amount: 5000n },
      { day: "2026-02-02", amount: 2000n },
    ]);
    expect(r.excess).toBe(0n);
    expect((await row("2026-02-01"))).toMatchObject({ sent: 5000n, outstanding: 0n });
    expect((await row("2026-02-02"))).toMatchObject({ sent: 2000n, outstanding: 2000n });
    expect((await row("2026-02-03"))!.outstanding).toBe(3000n);
    const allocs = await db.select().from(cashReconAllocations).where(eq(cashReconAllocations.transactionId, r.t.id));
    expect(allocs.map((a) => a.amountPesewas).sort()).toEqual([2000n, 5000n]);
  });

  it("an over-send becomes credit instead of vanishing, and covers the next cash collected", async () => {
    await reset();
    await collect("2026-02-01", 3000n);
    const r = await send(5000n);
    expect(r.excess).toBe(2000n);
    expect((await ledgerBalance(db, f.branchId))).toEqual({ outstanding: 0n, credit: 2000n });

    await collect("2026-02-05", 1500n); // fully covered by credit
    expect((await row("2026-02-05"))).toMatchObject({ creditApplied: 1500n, outstanding: 0n });
    await collect("2026-02-06", 1500n); // only 500 credit left
    expect((await row("2026-02-06"))).toMatchObject({ creditApplied: 500n, outstanding: 1000n });
    expect((await ledgerBalance(db, f.branchId))).toEqual({ outstanding: 1000n, credit: 0n });
  });

  it("credit is not auto-applied for a branch under manual audit", async () => {
    await reset();
    await db.update(branches).set({ creditAutoApplyDisabled: true }).where(eq(branches.id, f.branchId));
    await collect("2026-02-01", 1000n);
    await send(3000n);
    await collect("2026-02-02", 1000n);
    expect((await row("2026-02-02"))!.outstanding).toBe(1000n);
    expect((await ledgerBalance(db, f.branchId)).credit).toBe(2000n);
    await db.update(branches).set({ creditAutoApplyDisabled: false }).where(eq(branches.id, f.branchId));
  });

  it("deductions reduce what is owed and never push it below zero", async () => {
    await reset();
    await collect("2026-02-01", 2000n);
    await db.transaction((tx) => addDeduction(tx, f.branchId, at("2026-02-01"), 500n));
    expect((await row("2026-02-01"))!.outstanding).toBe(1500n);
    await db.transaction((tx) => addDeduction(tx, f.branchId, at("2026-02-01"), 9000n));
    expect((await row("2026-02-01"))!.outstanding).toBe(0n);
  });

  it("two sends at the same moment never allocate the same money twice", async () => {
    await reset();
    await collect("2026-02-01", 4000n);
    const [a, b] = await Promise.all([send(3000n), send(3000n)]);
    const allocated = [...a.allocations, ...b.allocations].reduce((s, x) => s + x.amount, 0n);
    expect(allocated).toBe(4000n); // exactly what was owed
    expect(a.excess + b.excess).toBe(2000n); // the rest is credit
    expect((await row("2026-02-01"))).toMatchObject({ sent: 4000n, outstanding: 0n });
    expect((await ledgerBalance(db, f.branchId)).credit).toBe(2000n);
  });

  it("a payment and a send racing each other end up consistent", async () => {
    await reset();
    await collect("2026-02-01", 2000n);
    await Promise.all([collect("2026-02-02", 3000n), send(2000n)]);
    const bal = await ledgerBalance(db, f.branchId);
    // 5000 collected, 2000 sent, nothing lost or counted twice
    expect(bal).toEqual({ outstanding: 3000n, credit: 0n });
  });

  it("the database rejects negative or oversized-credit rows", async () => {
    await reset();
    await expect(db.insert(cashLedger).values({ branchId: f.branchId, day: "2026-03-01", sent: -1n })).rejects.toThrow();
    await expect(
      db.insert(cashCredits).values({ branchId: f.branchId, day: "2026-03-01", amountPesewas: 100n, remainingPesewas: 200n })
    ).rejects.toThrow();
  });
});
