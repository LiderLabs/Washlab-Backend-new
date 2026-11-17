import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../platform/db/index.js";
import { orders } from "../../platform/db/schema/orders.js";
import { payments } from "../../platform/db/schema/payments.js";
import { attendants } from "../../platform/db/schema/staff.js";
import { cashLedger } from "../../platform/db/schema/cash.js";
import { setPaystackClient, detectNetwork, toLocalGhanaNumber } from "../../platform/paystack/index.js";
import { buildApp } from "../../app.js";
import { stationService } from "./service.js";
import { destroyBranch, FakePaystack, makeBranch } from "../cash/test-helpers.js";

let app: Awaited<ReturnType<typeof buildApp>>;
let f: Awaited<ReturnType<typeof makeBranch>>;
let token: string;
const fake = new FakePaystack();
const hdr = () => ({ "x-station-token": token });
let bag = 300;

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
const pay = (id: string, payload: object) =>
  app.inject({ method: "POST", url: `/v1/station/orders/${id}/payment`, headers: hdr(), payload });
const finalize = (id: string, reference: string) =>
  app.inject({ method: "POST", url: `/v1/station/orders/${id}/payment/finalize`, headers: hdr(), payload: { reference } });
const dbOrder = async (id: string) => (await db.select().from(orders).where(eq(orders.id, id)))[0]!;
const dbPayments = (id: string) => db.select().from(payments).where(eq(payments.orderId, id));
const ledgerTotal = async () =>
  (await db.select().from(cashLedger).where(eq(cashLedger.branchId, f.branchId))).reduce((s, r) => s + r.collected, 0n);

beforeAll(async () => {
  setPaystackClient(fake);
  app = await buildApp();
  await app.ready();
  f = await makeBranch("PF");
  token = (await stationService.login({ branchId: f.branchId, deviceId: "pf", stationPin: "1234" }, { ip: "127.0.0.1" })).stationToken;
}, 30_000);
beforeEach(() => {
  fake.verifyFor.clear();
});
afterAll(async () => {
  setPaystackClient(null);
  await destroyBranch(f);
  await app.close();
});

describe("PIN on payments", () => {
  it("is required, checked server-side, and a wrong PIN records nothing", async () => {
    const o = await newOrder();
    expect((await pay(o.id, { paymentMethod: "cash", attendantId: f.attendantId })).statusCode).toBe(400); // no pin
    const bad = await pay(o.id, { paymentMethod: "cash", attendantId: f.attendantId, pin: "0000" });
    expect(bad.statusCode).toBe(401);
    expect(await dbPayments(o.id)).toHaveLength(0);
    expect((await dbOrder(o.id)).paymentStatus).toBe("pending");
    await db.update(attendants).set({ failedAttempts: 0, lockedUntil: null }).where(eq(attendants.id, f.attendantId));
  });
});

describe("cash", () => {
  it("marks the order paid and puts the cash on the ledger in the same step", async () => {
    const before = await ledgerTotal();
    const o = await newOrder();
    const res = await pay(o.id, { ...creds(), paymentMethod: "cash" });
    expect(res.statusCode).toBe(200);
    expect((await dbOrder(o.id)).paymentStatus).toBe("paid");
    expect((await ledgerTotal()) - before).toBe(BigInt(o.finalPricePesewas));
    const [p] = await dbPayments(o.id);
    expect(p!.processedByAttendantId).toBe(f.attendantId);
  });

  it("books the ledger by the day it was PAID, not when the order was created", async () => {
    const o = await newOrder();
    await db.update(orders).set({ placedAt: new Date("2025-01-01T10:00:00Z") }).where(eq(orders.id, o.id));
    await pay(o.id, { ...creds(), paymentMethod: "cash" });
    const today = new Date().toISOString().slice(0, 10);
    const rows = await db.select().from(cashLedger).where(eq(cashLedger.branchId, f.branchId));
    expect(rows.some((r) => r.day === today)).toBe(true);
    expect(rows.some((r) => r.day === "2025-01-01")).toBe(false);
  });

  it("a double tap puts the cash on the ledger once", async () => {
    const o = await newOrder();
    const before = await ledgerTotal();
    const rs = await Promise.all([pay(o.id, { ...creds(), paymentMethod: "cash" }), pay(o.id, { ...creds(), paymentMethod: "cash" })]);
    expect(rs.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect((await ledgerTotal()) - before).toBe(BigInt(o.finalPricePesewas));
  });

  it("mobile money does not touch the cash ledger", async () => {
    const o = await newOrder();
    const before = await ledgerTotal();
    await pay(o.id, { ...creds(), paymentMethod: "mobile_money" });
    expect(await ledgerTotal()).toBe(before);
  });
});

describe("mobile money: popup then finalize", () => {
  it("returns a reference and amount for the popup and leaves the order unpaid", async () => {
    const o = await newOrder();
    const res = await pay(o.id, { ...creds(), paymentMethod: "mobile_money" });
    const body = res.json();
    expect(body.status).toBe("pending");
    expect(body.reference).toMatch(/^WL-/);
    expect(body.amountPesewas).toBe(String(o.finalPricePesewas));
    expect((await dbOrder(o.id)).paymentStatus).toBe("pending");
  });

  it("finalize verifies with Paystack and then pays the order", async () => {
    const o = await newOrder();
    const { reference } = (await pay(o.id, { ...creds(), paymentMethod: "mobile_money" })).json();
    fake.verifyFor.set(reference, { status: "success", amountPesewas: BigInt(o.finalPricePesewas) });
    const res = await finalize(o.id, reference);
    expect(res.json()).toMatchObject({ status: "success", paymentStatus: "paid" });
    expect((await dbOrder(o.id)).paymentStatus).toBe("paid");
    const [p] = await dbPayments(o.id);
    expect(p).toMatchObject({ status: "paid", method: "mobile_money", gatewayReference: reference });
    // calling again is harmless
    expect((await finalize(o.id, reference)).json().paymentStatus).toBe("paid");
  });

  it("finalize does NOT trust the client: if Paystack says not paid, the order stays unpaid", async () => {
    const o = await newOrder();
    const { reference } = (await pay(o.id, { ...creds(), paymentMethod: "mobile_money" })).json();
    fake.verifyFor.set(reference, { status: "abandoned" });
    const res = await finalize(o.id, reference);
    expect(res.json()).toMatchObject({ status: "abandoned", paymentStatus: "pending" });
    expect((await dbOrder(o.id)).paymentStatus).toBe("pending");
  });

  it("finalize refuses a payment for a different amount", async () => {
    const o = await newOrder();
    const { reference } = (await pay(o.id, { ...creds(), paymentMethod: "mobile_money" })).json();
    fake.verifyFor.set(reference, { status: "success", amountPesewas: 1n });
    const res = await finalize(o.id, reference);
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("AMOUNT_MISMATCH");
    expect((await dbOrder(o.id)).paymentStatus).toBe("pending");
  });

  it("a reference from another order cannot pay this one", async () => {
    const a = await newOrder();
    const b = await newOrder();
    const { reference } = (await pay(a.id, { ...creds(), paymentMethod: "mobile_money" })).json();
    fake.verifyFor.set(reference, { status: "success", amountPesewas: BigInt(a.finalPricePesewas) });
    const res = await finalize(b.id, reference);
    expect(res.statusCode).toBe(404);
    expect((await dbOrder(b.id)).paymentStatus).toBe("pending");
  });

  it("retrying the popup gives a new reference but the abandoned one still settles the order", async () => {
    const o = await newOrder();
    const first = (await pay(o.id, { ...creds(), paymentMethod: "mobile_money" })).json().reference;
    const second = (await pay(o.id, { ...creds(), paymentMethod: "mobile_money" })).json().reference;
    expect(second).not.toBe(first);
    expect(await dbPayments(o.id)).toHaveLength(1);
    fake.verifyFor.set(first, { status: "success", amountPesewas: BigInt(o.finalPricePesewas) });
    expect((await finalize(o.id, first)).json().paymentStatus).toBe("paid");
  });
});

describe("database safety nets", () => {
  it("rejects a paid mobile-money payment with no gateway reference", async () => {
    const o = await newOrder();
    await expect(
      db.insert(payments).values({ orderId: o.id, branchId: f.branchId, customerId: f.customerId, amountPesewas: 100n, method: "mobile_money", status: "paid" })
    ).rejects.toThrow();
  });
});

describe("Ghana phone/network helpers", () => {
  it("normalises and detects networks", () => {
    expect(toLocalGhanaNumber("+233 24 123 4567")).toBe("0241234567");
    expect(toLocalGhanaNumber("233201234567")).toBe("0201234567");
    expect(detectNetwork("+233241234567")).toBe("mtn");
    expect(detectNetwork("0201234567")).toBe("vodafone");
    expect(detectNetwork("+233271234567")).toBe("airteltigo");
    expect(detectNetwork("0991234567")).toBe("mtn"); // unknown prefix falls back to MTN, as before
  });
});
