import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../platform/db/index.js";
import { orders } from "../../platform/db/schema/orders.js";
import { customers } from "../../platform/db/schema/customers.js";
import { loyaltyLedger, voucherUsages, vouchers } from "../../platform/db/schema/loyalty.js";
import { setPaystackClient } from "../../platform/paystack/index.js";
import { buildApp } from "../../app.js";
import { stationService } from "./service.js";
import { destroyBranch, FakePaystack, makeBranch } from "../cash/test-helpers.js";

let app: Awaited<ReturnType<typeof buildApp>>;
let f: Awaited<ReturnType<typeof makeBranch>>;
let token: string;
let bag = 600;
let n = 0;
const hdr = () => ({ "x-station-token": token });
const creds = () => ({ attendantId: f.attendantId, pin: f.pin });

async function newOrder() {
  const r = await app.inject({
    method: "POST",
    url: "/v1/station/orders/walk-in",
    headers: hdr(),
    payload: { attendantId: f.attendantId, customerId: f.customerId, serviceType: "wash_only", weightKg: 5, bagNumber: String(++bag) },
  });
  expect(r.statusCode).toBe(200);
  return r.json() as { id: string; finalPricePesewas: number };
}
const pay = (id: string, extra: object = {}) =>
  app.inject({ method: "POST", url: `/v1/station/orders/${id}/payment`, headers: hdr(), payload: { ...creds(), paymentMethod: "cash", ...extra } });
const dbOrder = async (id: string) => (await db.select().from(orders).where(eq(orders.id, id)))[0]!;
const voucher = async (v: Partial<typeof vouchers.$inferInsert> = {}) =>
  (
    await db
      .insert(vouchers)
      .values({ code: `T${Date.now().toString(36)}${++n}`.toUpperCase(), discountType: "fixed", discountValue: 500n, branchId: f.branchId, maxUsageCount: 5, ...v })
      .returning()
  )[0]!;
const usages = (voucherId: string) => db.select().from(voucherUsages).where(eq(voucherUsages.voucherId, voucherId));
const points = async () => (await db.select().from(customers).where(eq(customers.id, f.customerId)))[0]!.loyaltyPoints;
const setPoints = (p: number) => db.update(customers).set({ loyaltyPoints: p }).where(eq(customers.id, f.customerId));

beforeAll(async () => {
  setPaystackClient(new FakePaystack());
  app = await buildApp();
  await app.ready();
  f = await makeBranch("DS");
  token = (await stationService.login({ branchId: f.branchId, deviceId: "ds", stationPin: "1234" }, { ip: "127.0.0.1" })).stationToken;
}, 30_000);
afterAll(async () => {
  setPaystackClient(null);
  await destroyBranch(f);
  await app.close();
});

describe("vouchers", () => {
  it("a fixed voucher lowers the price, is counted once, and the payment is for the discounted amount", async () => {
    const o = await newOrder();
    const v = await voucher({ discountValue: 500n });
    const res = await pay(o.id, { voucherCode: v.code });
    expect(res.statusCode).toBe(200);
    expect(res.json().amountPesewas).toBe(String(o.finalPricePesewas - 500));
    const row = await dbOrder(o.id);
    expect(row.finalPricePesewas).toBe(BigInt(o.finalPricePesewas - 500));
    expect(row.discountPesewas).toBe(500n);
    expect(await usages(v.id)).toHaveLength(1);
    expect((await db.select().from(vouchers).where(eq(vouchers.id, v.id)))[0]!.currentUsageCount).toBe(1);
  });

  it("percentage and free_wash vouchers", async () => {
    const o1 = await newOrder();
    const pct = await voucher({ discountType: "percentage", discountValue: 10n });
    const r1 = await pay(o1.id, { voucherCode: pct.code });
    expect(r1.json().amountPesewas).toBe(String(o1.finalPricePesewas - Math.floor(o1.finalPricePesewas / 10)));

    const o2 = await newOrder();
    const free = await voucher({ discountType: "free_wash", discountValue: 0n });
    const r2 = await pay(o2.id, { voucherCode: free.code });
    expect(r2.json().amountPesewas).toBe("0");
  });

  it("never discounts below zero", async () => {
    const o = await newOrder();
    const v = await voucher({ discountValue: 99_999_999n });
    expect((await pay(o.id, { voucherCode: v.code })).json().amountPesewas).toBe("0");
  });

  it("rejects an unknown, expired, used-up, wrong-branch or too-small voucher and records nothing", async () => {
    const cases: [string, string, Partial<typeof vouchers.$inferInsert>][] = [
      ["VOUCHER_EXPIRED", "expired", { expiresAt: new Date(Date.now() - 60_000) }],
      ["VOUCHER_LIMIT", "used up", { maxUsageCount: 1, currentUsageCount: 1 }],
      ["VOUCHER_MIN_ORDER", "minimum", { minOrderAmountPesewas: 99_999_999n }],
    ];
    for (const [code, , extra] of cases) {
      const o = await newOrder();
      const v = await voucher(extra);
      const res = await pay(o.id, { voucherCode: v.code });
      expect(res.statusCode).toBe(400);
      expect(res.json().code ?? res.json().error?.code).toBe(code);
      expect((await dbOrder(o.id)).paymentStatus).toBe("pending");
      expect(await usages(v.id)).toHaveLength(0);
    }
    const o = await newOrder();
    expect((await pay(o.id, { voucherCode: "NOPE" })).statusCode).toBe(400);
    const other = await makeBranch("DX");
    const foreign = await voucher({ branchId: other.branchId });
    expect((await pay(o.id, { voucherCode: foreign.code })).statusCode).toBe(400);
    await destroyBranch(other);
  });

  it("a voucher with one use left is spent once even when two payments race", async () => {
    const v = await voucher({ maxUsageCount: 1 });
    const [o1, o2] = [await newOrder(), await newOrder()];
    const rs = await Promise.all([pay(o1.id, { voucherCode: v.code }), pay(o2.id, { voucherCode: v.code })]);
    expect(rs.map((r) => r.statusCode).sort()).toEqual([200, 400]);
    expect(await usages(v.id)).toHaveLength(1);
    expect((await db.select().from(vouchers).where(eq(vouchers.id, v.id)))[0]!.currentUsageCount).toBe(1);
  });

  it("a mobile-money retry with the same voucher is not charged or counted twice; a different one is refused", async () => {
    const o = await newOrder();
    const v = await voucher({ discountValue: 500n });
    const first = await pay(o.id, { paymentMethod: "mobile_money", voucherCode: v.code });
    expect(first.statusCode).toBe(200);
    const retry = await pay(o.id, { paymentMethod: "mobile_money", voucherCode: v.code });
    expect(retry.statusCode).toBe(200);
    expect(retry.json().amountPesewas).toBe(first.json().amountPesewas);
    expect(await usages(v.id)).toHaveLength(1);
    expect((await dbOrder(o.id)).discountPesewas).toBe(500n);
    const other = await voucher();
    expect((await pay(o.id, { paymentMethod: "mobile_money", voucherCode: other.code })).statusCode).toBe(409);
  });
});

describe("loyalty", () => {
  it("redeems whole points (1 point = GH₵1), writes the ledger and the balance together", async () => {
    await setPoints(5);
    const o = await newOrder();
    const res = await pay(o.id, { loyaltyPointsToRedeem: 3 });
    expect(res.statusCode).toBe(200);
    expect(res.json().amountPesewas).toBe(String(o.finalPricePesewas - 300));
    expect(await points()).toBe(2);
    const rows = await db.select().from(loyaltyLedger).where(eq(loyaltyLedger.orderId, o.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ pointsDelta: -3, balanceAfter: 2, reason: "reward_redemption" });
  });

  it("refuses more points than the customer has and takes nothing", async () => {
    await setPoints(1);
    const o = await newOrder();
    expect((await pay(o.id, { loyaltyPointsToRedeem: 4 })).statusCode).toBe(400);
    expect(await points()).toBe(1);
    expect((await dbOrder(o.id)).paymentStatus).toBe("pending");
  });

  it("takes only the points needed to cover what is owed", async () => {
    await setPoints(10_000);
    const o = await newOrder();
    const res = await pay(o.id, { loyaltyPointsToRedeem: 10_000 });
    expect(res.json().amountPesewas).toBe("0");
    expect(await points()).toBe(10_000 - Math.floor(o.finalPricePesewas / 100));
  });

  it("voucher and points stack, and a payment that fails rolls both back", async () => {
    await setPoints(2);
    const o = await newOrder();
    const v = await voucher({ discountValue: 100n });
    const bad = await pay(o.id, { voucherCode: v.code, loyaltyPointsToRedeem: 2, pin: "0000" });
    expect(bad.statusCode).toBe(401);
    expect(await usages(v.id)).toHaveLength(0);
    expect(await points()).toBe(2);
    const ok = await pay(o.id, { voucherCode: v.code, loyaltyPointsToRedeem: 2 });
    expect(ok.json().amountPesewas).toBe(String(o.finalPricePesewas - 100 - 200));
  });

  it("completing an order awards one point to the balance, once", async () => {
    await setPoints(0);
    const o = await newOrder();
    await pay(o.id);
    for (const status of ["sorting", "washing", "drying", "folding", "ready_for_pickup", "completed"]) {
      const r = await app.inject({ method: "POST", url: `/v1/station/orders/${o.id}/status`, headers: hdr(), payload: { attendantId: f.attendantId, status } });
      expect(r.statusCode).toBe(200);
    }
    expect(await points()).toBe(1);
  });
});
