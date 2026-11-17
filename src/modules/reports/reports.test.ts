import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../platform/db/index.js";
import { branchServices } from "../../platform/db/schema/catalog.js";
import { orders } from "../../platform/db/schema/orders.js";
import { payments } from "../../platform/db/schema/payments.js";
import { loyaltyLedger, voucherUsages, vouchers } from "../../platform/db/schema/loyalty.js";
import { dailyReports } from "../../platform/db/schema/reports.js";
import { attendants } from "../../platform/db/schema/staff.js";
import { buildApp } from "../../app.js";
import { stationService } from "../station/service.js";
import { destroyBranch, makeBranch } from "../cash/test-helpers.js";

let app: Awaited<ReturnType<typeof buildApp>>;
let f: Awaited<ReturnType<typeof makeBranch>>;
let g: Awaited<ReturnType<typeof makeBranch>>;
let token: string;
let otherToken: string;
const meta = { ip: "127.0.0.1", userAgent: "vitest" };
const hdr = (t: string) => ({ "x-station-token": t });
const get = (url: string, t = token) => app.inject({ method: "GET", url: `/v1/station/reports${url}`, headers: hdr(t) });
const put = (url: string, payload: object, t = token) =>
  app.inject({ method: "PUT", url: `/v1/station/reports${url}`, headers: hdr(t), payload });
const post = (url: string, payload: object, t = token) =>
  app.inject({ method: "POST", url: `/v1/station/reports${url}`, headers: hdr(t), payload });

// A fixed past day keeps the numbers deterministic.
const DAY = "2026-03-10";
const at = (iso: string) => new Date(iso);
const D0 = at("2026-03-10T12:00:00Z");
const D_BEFORE = at("2026-03-09T12:00:00Z");
const LONG_AGO = at("2026-03-05T12:00:00Z");

let n = 0;
async function mkOrder(o: Partial<typeof orders.$inferInsert> & { final: bigint }) {
  const { final, ...rest } = o;
  const [row] = await db
    .insert(orders)
    .values({
      orderNumber: `RP${f.run}${++n}`,
      customerId: f.customerId,
      branchId: f.branchId,
      orderType: "walk_in",
      serviceType: "wash_only",
      estimatedLoads: 1,
      status: "washing",
      createdAt: D0,
      finalPricePesewas: final,
      ...rest,
    })
    .returning();
  return row!;
}
async function mkPay(orderId: string, method: "cash" | "mobile_money" | "card", amount: bigint, paidAt: Date) {
  await db.insert(payments).values({
    orderId,
    branchId: f.branchId,
    customerId: f.customerId,
    amountPesewas: amount,
    method,
    status: "paid",
    paidAt,
    gatewayReference: method === "cash" ? undefined : `WL-${f.run}-${++n}`,
  });
  await db.update(orders).set({ paymentStatus: "paid" }).where(eq(orders.id, orderId));
}

let ids: Record<string, string> = {};
const created: string[] = [];

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  f = await makeBranch("RP");
  g = await makeBranch("RQ");
  token = (await stationService.login({ branchId: f.branchId, deviceId: "rp", stationPin: "1234" }, meta)).stationToken;
  otherToken = (await stationService.login({ branchId: g.branchId, deviceId: "rq", stationPin: "1234" }, meta)).stationToken;

  await db.insert(branchServices).values([
    { branchId: f.branchId, name: "Wash", code: "wash_only", pricePesewas: 3000n },
    { branchId: f.branchId, name: "Dry", code: "dry_only", pricePesewas: 2000n },
    { branchId: f.branchId, name: "Wash & Dry", code: "wash_and_dry", pricePesewas: 5000n },
  ]);

  // A: wash_and_dry, 2 loads + 1 extra wash, paid cash today
  const A = await mkOrder({ serviceType: "wash_and_dry", estimatedLoads: 2, extraWashLoads: 1, final: 10000n, discountPesewas: 1000n });
  await mkPay(A.id, "cash", 10000n, D0);
  // B: wash_only, paid MoMo today. The payment row is larger than the order (Paystack fee) but revenue is the order price.
  const B = await mkOrder({ final: 3000n, discountPesewas: 500n });
  await mkPay(B.id, "mobile_money", 3060n, D0);
  // C: dry_only, still unpaid
  const C = await mkOrder({ serviceType: "dry_only", final: 2000n });
  // D: handled yesterday, paid today by card -> outstanding recovered, not today's card revenue
  const D = await mkOrder({ createdAt: D_BEFORE, status: "completed", final: 4000n });
  await mkPay(D.id, "card", 4000n, D0);
  // E: online order created long ago, checked in today, paid cash today -> counts for today
  const E = await mkOrder({
    orderType: "online",
    serviceType: "wash_and_dry",
    createdAt: LONG_AGO,
    checkedInAt: D0,
    status: "checked_in",
    final: 1500n,
  });
  await mkPay(E.id, "cash", 1500n, D0);
  // F: cancelled today -> ignored
  const F = await mkOrder({ status: "cancelled", final: 9999n });
  // G: online order still waiting for drop-off -> not active
  const G = await mkOrder({ orderType: "online", status: "pending_dropoff", final: 7777n });
  // H: free wash (voucher/loyalty covered), settled with a zero payment
  const H = await mkOrder({ final: 0n });
  await mkPay(H.id, "cash", 0n, D0);
  ids = { A: A.id, B: B.id, C: C.id, D: D.id, E: E.id, F: F.id, G: G.id, H: H.id };

  // voucher on A, loyalty redemption on B
  const [v] = await db
    .insert(vouchers)
    .values({ code: `RV${f.run}`, discountType: "fixed", discountValue: 1000n })
    .returning();
  created.push(v!.id);
  await db.insert(voucherUsages).values({
    voucherId: v!.id,
    customerId: f.customerId,
    orderId: A.id,
    discountAppliedPesewas: 1000n,
  });
  await db.insert(loyaltyLedger).values({
    customerId: f.customerId,
    orderId: B.id,
    pointsDelta: -10,
    reason: "reward_redemption",
  });
}, 60_000);

afterAll(async () => {
  const ordIds = Object.values(ids);
  for (const id of ordIds) {
    await db.delete(voucherUsages).where(eq(voucherUsages.orderId, id));
    await db.delete(loyaltyLedger).where(eq(loyaltyLedger.orderId, id));
  }
  for (const id of created) await db.delete(vouchers).where(eq(vouchers.id, id));
  await destroyBranch(f);
  await destroyBranch(g);
  await app.close();
});

describe("auto report (same rules as the Convex getAutoData)", () => {
  it("counts the right orders, tokens and payments for the day", async () => {
    const res = await get(`/auto?date=${DAY}`);
    expect(res.statusCode).toBe(200);
    const r = res.json();
    // handled today: A B C E F G H (D was yesterday)
    expect(r.totalOrders).toBe(7);
    // active = not cancelled / pending_dropoff: A B C E H
    expect(r.washerTokensUsed).toBe(3 + 1 + 1 + 1); // A(2+1) B(1) E(1) H(1)
    expect(r.dryerTokensUsed).toBe(2 + 1 + 1); // A(2) C(1) E(1)
    expect(r.cashPesewas).toBe(10000 + 1500); // A + E; the free wash is counted separately
    expect(r.mobileMoneyPesewas).toBe(3000); // order price, not the 3060 charged
    expect(r.cardPesewas).toBe(0); // D belongs to yesterday
    expect(r.totalRevenuePesewas).toBe(14500);
    expect(r.freeWashCount).toBe(1);
    expect(r.outstandingRecoveredPesewas).toBe(4000);
    expect(r.outstandingOrderCount).toBe(1);
    expect(r.outstandingAmountPesewas).toBe(2000);
    expect(r.expectedRevenuePesewas).toBe(10000 + 3000 + 1500); // paid orders handled today (incl. free)
  });

  it("breaks down services, vouchers and loyalty", async () => {
    const r = (await get(`/auto?date=${DAY}`)).json();
    const wd = r.serviceBreakdown.find((s: any) => s.serviceType === "wash_and_dry");
    expect(wd).toMatchObject({ label: "Wash & Dry", count: 2, tokensUsed: 5 + 2 });
    const v = r.voucherBreakdown.find((x: any) => x.discountType === "fixed");
    expect(v).toMatchObject({ count: 1, totalDiscountPesewas: 1000 });
    const loyalty = r.voucherBreakdown.find((x: any) => x.voucherId === "__loyalty__");
    expect(loyalty).toMatchObject({ count: 1, totalDiscountPesewas: 500 });
  });

  it("is empty for a day with no activity, and refuses future dates", async () => {
    const quiet = (await get(`/auto?date=2026-01-02`)).json();
    expect(quiet.totalOrders).toBe(0);
    expect(quiet.totalRevenuePesewas).toBe(0);
    const future = await get(`/auto?date=2999-01-01`);
    expect(future.statusCode).toBe(400);
    expect((await get(`/auto?date=2026-02-31`)).statusCode).toBe(400);
  });

  it("lists attendants who clocked in that day", async () => {
    const today = (await get(`/auto`)).json();
    expect(today.todayAttendantNames.length).toBeGreaterThan(0);
  });

  it("only sees its own branch", async () => {
    const r = (await get(`/auto?date=${DAY}`, otherToken)).json();
    expect(r.totalOrders).toBe(0);
  });
});

describe("draft, submit and resubmit", () => {
  it("a draft keeps the attendant's own entries but takes money from the server", async () => {
    const res = await put("/draft", {
      date: DAY,
      soapUnitsUsed: 4,
      technicalFaultCount: 1,
      technicalFaultNotes: "Dryer 2 door",
      notes: "busy day",
      washerTokensUsed: 9,
      cashPesewas: 999999, // not an accepted field: ignored
    });
    expect(res.statusCode).toBe(200);
    const r = res.json();
    expect(r).toMatchObject({ status: "draft", soapUnitsUsed: 4, washerTokensUsed: 9, cashPesewas: 11500, totalTokensUsed: 9 + 4 });
    const again = (await get(`/draft?date=${DAY}`)).json();
    expect(again.id).toBe(r.id);
    expect((await get(`/draft?date=2026-01-02`)).json()).toBeNull();
  });

  it("simultaneous saves make one row", async () => {
    const day = "2026-02-02";
    const rs = await Promise.all([1, 2, 3].map((i) => put("/draft", { date: day, soapUnitsUsed: i })));
    expect(rs.every((r) => r.statusCode === 200)).toBe(true);
    const rows = await db.select().from(dailyReports).where(eq(dailyReports.branchId, f.branchId));
    expect(rows.filter((r) => r.reportDate === day)).toHaveLength(1);
  });

  it("needs the attendant's PIN, and a wrong PIN counts toward the lockout", async () => {
    const bad = await post("/submit", { date: DAY, attendantId: f.attendantId, pin: "0000" });
    expect(bad.statusCode).toBe(401);
    const [a] = await db.select().from(attendants).where(eq(attendants.id, f.attendantId));
    expect(a!.failedAttempts).toBeGreaterThan(0);
    const [saved] = await db.select().from(dailyReports).where(eq(dailyReports.reportDate, DAY));
    expect(saved!.status).toBe("draft");
  });

  it("submits with outstanding orders, then can be sent again once they are paid", async () => {
    const first = await post("/submit", { date: DAY, attendantId: f.attendantId, pin: f.pin, soapUnitsUsed: 4 });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      status: "submitted_with_outstanding",
      outstandingOrderCount: 1,
      outstandingAmountPesewas: 2000,
      attendantId: f.attendantId,
    });
    expect(first.json().submittedAt).toBeTruthy();

    // A draft save can't pull a submitted report back to draft.
    const d = await put("/draft", { date: DAY, soapUnitsUsed: 1 });
    expect(d.json().status).toBe("submitted_with_outstanding");

    await mkPay(ids.C!, "cash", 2000n, D0);
    const second = await post("/submit", { date: DAY, attendantId: f.attendantId, pin: f.pin });
    expect(second.statusCode).toBe(200);
    // C was handled today and paid today: now counted as cash, nothing outstanding.
    expect(second.json()).toMatchObject({ status: "submitted", outstandingOrderCount: 0, cashPesewas: 13500 });

    const third = await post("/submit", { date: DAY, attendantId: f.attendantId, pin: f.pin });
    expect(third.statusCode).toBe(409);
    expect(third.json().error?.code ?? third.json().code).toBe("REPORT_ALREADY_SUBMITTED");
  });

  it("lists reports newest first with unit prices", async () => {
    const list = (await get(`/?limit=10`)).json();
    expect(list.length).toBeGreaterThanOrEqual(2);
    expect(list[0].date >= list[list.length - 1].date).toBe(true);
    expect(list[0]).toMatchObject({ washerPricePesewas: 3000, dryerPricePesewas: 2000 });
    expect((await get(`/?limit=10`, otherToken)).json()).toHaveLength(0);
  });

  it("rejects an attendant from another branch", async () => {
    const r = await post("/submit", { date: DAY, attendantId: g.attendantId, pin: g.pin });
    expect(r.statusCode).toBeGreaterThanOrEqual(400);
  });
});
