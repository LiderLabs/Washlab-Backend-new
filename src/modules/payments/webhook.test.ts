import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { config } from "../../platform/config/index.js";
import { db } from "../../platform/db/index.js";
import { orders } from "../../platform/db/schema/orders.js";
import { payments, webhookEvents } from "../../platform/db/schema/payments.js";
import { cashReconTransactions } from "../../platform/db/schema/cash.js";
import { buildApp } from "../../app.js";
import { addCollected } from "../cash/ledger.js";
import { destroyBranch, makeBranch, wipeWebhookEvents } from "../cash/test-helpers.js";

let app: Awaited<ReturnType<typeof buildApp>>;
let f: Awaited<ReturnType<typeof makeBranch>>;
const eventIds: string[] = [];
let seq = 0;

const sign = (raw: string) => crypto.createHmac("sha512", config.PAYSTACK_SECRET_KEY).update(raw).digest("hex");
function hook(raw: string, signature: string | null = sign(raw)) {
  return app.inject({
    method: "POST",
    url: "/v1/payments/webhooks/paystack",
    headers: { "content-type": "application/json", ...(signature ? { "x-paystack-signature": signature } : {}) },
    payload: raw,
  });
}
const chargeSuccess = (reference: string, amount: number, extra: Record<string, unknown> = {}) => {
  const id = 9_000_000 + ++seq + Math.floor(Math.random() * 1e6);
  eventIds.push(`charge.success:${id}`);
  // deliberately pretty-printed with odd spacing: the signature must be checked against these exact bytes
  return JSON.stringify(
    { event: "charge.success", data: { id, reference, status: "success", amount, currency: "GHS", channel: "mobile_money", paid_at: new Date().toISOString(), ...extra } },
    null,
    3
  );
};

async function momoOrder(amount: bigint, reference: string, extraMeta: object = {}) {
  const [o] = await db
    .insert(orders)
    .values({
      orderNumber: `WH${Math.floor(Math.random() * 1e9)}`,
      orderType: "walk_in",
      customerId: f.customerId,
      branchId: f.branchId,
      status: "checked_in",
      serviceType: "wash_only",
      finalPricePesewas: amount,
      paymentMethod: "mobile_money",
    })
    .returning();
  const [p] = await db
    .insert(payments)
    .values({ orderId: o!.id, branchId: f.branchId, customerId: f.customerId, amountPesewas: amount, method: "mobile_money", status: "pending", gatewayReference: reference, metadata: extraMeta })
    .returning();
  return { order: o!, payment: p! };
}
const reload = async (orderId: string) => ({
  order: (await db.select().from(orders).where(eq(orders.id, orderId)))[0]!,
  payment: (await db.select().from(payments).where(eq(payments.orderId, orderId)))[0]!,
});

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  f = await makeBranch("WH");
}, 30_000);
afterAll(async () => {
  await wipeWebhookEvents(eventIds);
  await destroyBranch(f);
  await app.close();
});

describe("signature", () => {
  it("accepts a correctly signed body even when it is formatted differently from JSON.stringify", async () => {
    const { order } = await momoOrder(2500n, "WL-sig-1");
    const res = await hook(chargeSuccess("WL-sig-1", 2500));
    expect(res.statusCode).toBe(200);
    expect((await reload(order.id)).payment.status).toBe("paid");
  });

  it("rejects a missing, wrong, or tampered signature", async () => {
    const { order } = await momoOrder(2500n, "WL-sig-2");
    const raw = chargeSuccess("WL-sig-2", 2500);
    expect((await hook(raw, null)).statusCode).toBe(401);
    expect((await hook(raw, "deadbeef")).statusCode).toBe(401);
    expect((await hook(raw.replace("2500", "1"), sign(raw))).statusCode).toBe(401);
    expect((await reload(order.id)).payment.status).toBe("pending");
  });
});

describe("settling order payments", () => {
  it("marks BOTH the payment and the order paid, using the channel Paystack reports", async () => {
    const { order } = await momoOrder(4000n, "WL-ok-1");
    const txId = 8_000_000 + Math.floor(Math.random() * 1e6);
    eventIds.push(`charge.success:${txId}`);
    const res = await hook(chargeSuccess("WL-ok-1", 4000, { channel: "card", id: txId }));
    expect(res.statusCode).toBe(200);
    const r = await reload(order.id);
    expect(r.payment).toMatchObject({ status: "paid", method: "card", gatewayTransactionId: String(txId) });
    expect(r.payment.paidAt).not.toBeNull();
    expect(r.order).toMatchObject({ paymentStatus: "paid", paymentMethod: "card" });
  });

  it("is idempotent: the same event twice settles once", async () => {
    const { order } = await momoOrder(4000n, "WL-dup-1");
    const raw = chargeSuccess("WL-dup-1", 4000);
    expect((await hook(raw)).statusCode).toBe(200);
    const first = (await reload(order.id)).payment.paidAt;
    expect((await hook(raw)).statusCode).toBe(200);
    expect((await reload(order.id)).payment.paidAt).toEqual(first);
    const ev = await db.select().from(webhookEvents).where(eq(webhookEvents.eventId, JSON.parse(raw).event + ":" + JSON.parse(raw).data.id));
    expect(ev).toHaveLength(1);
    expect(ev[0]!.processedAt).not.toBeNull();
  });

  it("a different event for an already-paid reference does nothing", async () => {
    const { order } = await momoOrder(4000n, "WL-dup-2");
    await hook(chargeSuccess("WL-dup-2", 4000));
    const first = (await reload(order.id)).payment.paidAt;
    expect((await hook(chargeSuccess("WL-dup-2", 4000))).statusCode).toBe(200);
    expect((await reload(order.id)).payment.paidAt).toEqual(first);
  });

  it("does not settle when the amount differs, and leaves the event unprocessed for review", async () => {
    const { order } = await momoOrder(4000n, "WL-mm-1");
    const raw = chargeSuccess("WL-mm-1", 100);
    expect((await hook(raw)).statusCode).toBe(200); // retrying won't fix it
    expect((await reload(order.id)).payment.status).toBe("pending");
    const id = JSON.parse(raw).data.id;
    const [ev] = await db.select().from(webhookEvents).where(eq(webhookEvents.eventId, `charge.success:${id}`));
    expect(ev).toMatchObject({ processedAt: null, errorMessage: "AMOUNT_MISMATCH" });
  });

  it("matches a late confirmation of an abandoned earlier attempt", async () => {
    const { order } = await momoOrder(4000n, "WL-new-ref", { previousReferences: ["WL-old-ref"] });
    expect((await hook(chargeSuccess("WL-old-ref", 4000))).statusCode).toBe(200);
    const r = await reload(order.id);
    expect(r.payment).toMatchObject({ status: "paid", gatewayReference: "WL-old-ref" });
  });

  it("asks Paystack to retry a WashLab reference it can't find yet, but ignores foreign ones", async () => {
    expect((await hook(chargeSuccess("WL-nope", 100))).statusCode).toBe(500);
    expect((await hook(chargeSuccess("someone-elses-ref", 100))).statusCode).toBe(200);
  });

  it("acknowledges event types it does not act on", async () => {
    const id = 7_000_000 + ++seq;
    eventIds.push(`transfer.success:${id}`);
    const raw = JSON.stringify({ event: "transfer.success", data: { id, reference: "x" } });
    expect((await hook(raw)).statusCode).toBe(200);
  });

  it("rejects a malformed event", async () => {
    expect((await hook(JSON.stringify({ hello: "world" }))).statusCode).toBe(400);
  });
});

describe("cash sends", () => {
  it("settles a RECON- reference from the webhook and applies it to the ledger", async () => {
    await db.transaction((tx) => addCollected(tx, f.branchId, new Date(), 6000n));
    const ref = `RECON-wh-${Date.now()}`;
    await db.insert(cashReconTransactions).values({ branchId: f.branchId, paystackReference: ref, amountSentPesewas: 6000n, senderMomoNumber: "0241234567", status: "processing" });
    expect((await hook(chargeSuccess(ref, 6000))).statusCode).toBe(200);
    const [t] = await db.select().from(cashReconTransactions).where(eq(cashReconTransactions.paystackReference, ref));
    expect(t).toMatchObject({ status: "completed", excessPesewas: 0n });
  });
});
