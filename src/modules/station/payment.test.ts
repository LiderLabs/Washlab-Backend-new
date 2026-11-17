import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { config } from "../../platform/config/index.js";
import { db } from "../../platform/db/index.js";
import { branches } from "../../platform/db/schema/branches.js";
import { customers } from "../../platform/db/schema/customers.js";
import { orders } from "../../platform/db/schema/orders.js";
import { payments } from "../../platform/db/schema/payments.js";
import { attendanceLogs, attendants } from "../../platform/db/schema/staff.js";
import type { StationContext } from "../../platform/auth/station.js";
import { hashPin } from "../../platform/crypto/pin.js";
import { buildApp } from "../../app.js";
import { stationOrdersService as svc } from "./orders.service.js";

if (!config.DATABASE_URL.includes("localhost")) {
  throw new Error("Payment tests must only run against a local database");
}

const run = Date.now().toString(36);
const meta = { ip: "127.0.0.1", userAgent: "vitest" };
let station: StationContext;
let branchId: string;
let customerId: string;
let attId: string; // clocked in
let idleAttId: string; // not clocked in
let bag = 100;

async function newOrder() {
  const o: any = await svc.createWalkIn(
    station,
    { attendantId: attId, customerId, serviceType: "wash_and_dry", weightKg: 6, bagNumber: String(++bag) },
    meta
  );
  const id: string = o.id ?? o.orderId;
  const [row] = await db.select().from(orders).where(eq(orders.id, id));
  return row!;
}
const paymentsFor = (orderId: string) => db.select().from(payments).where(eq(payments.orderId, orderId));

beforeAll(async () => {
  const [b] = await db
    .insert(branches)
    .values({
      name: `Pay ${run}`,
      code: `PY${run}`.slice(0, 32),
      phoneNumber: "0000000000",
      address: "Test",
      city: "Test",
      pricingPerKgPesewas: 4000n,
      deliveryFeePesewas: 500n,
      stationPinHash: await hashPin("1234"),
    })
    .returning({ id: branches.id });
  branchId = b!.id;
  station = {
    sessionId: crypto.randomUUID(),
    branchId,
    deviceId: "pay-test",
    expiresAt: new Date(Date.now() + 3600_000),
    loggedInAt: new Date(),
  };
  const [c] = await db
    .insert(customers)
    .values({ name: "Pay Customer", phoneNumber: `+2332${Math.floor(Math.random() * 1e8)}` })
    .returning({ id: customers.id });
  customerId = c!.id;
  const mkAtt = async (name: string) => {
    const [a] = await db
      .insert(attendants)
      .values({ branchId, name, email: `${name}-${run}@t.local`, phoneNumber: "1", status: "active", passcodeHash: await hashPin("4321") })
      .returning({ id: attendants.id });
    return a!.id;
  };
  attId = await mkAtt("payer");
  idleAttId = await mkAtt("idle");
  await db.insert(attendanceLogs).values({ attendantId: attId, branchId, deviceId: "pay-test" });
}, 30_000);

afterAll(async () => {
  const os = await db.select({ id: orders.id }).from(orders).where(eq(orders.branchId, branchId));
  const ids = os.map((o) => o.id);
  if (ids.length) await db.delete(payments).where(inArray(payments.orderId, ids));
  await db.delete(orders).where(eq(orders.branchId, branchId));
  await db.delete(attendanceLogs).where(eq(attendanceLogs.branchId, branchId));
  await db.delete(attendants).where(eq(attendants.branchId, branchId));
  await db.delete(customers).where(eq(customers.id, customerId));
  await db.delete(branches).where(eq(branches.id, branchId));
});

describe("recordPayment", () => {
  it("cash with tender: marks the order paid and returns change", async () => {
    const order = await newOrder();
    const due = order.finalPricePesewas;
    const res = await svc.recordPayment(
      station,
      order.id,
      { paymentMethod: "cash", attendantId: attId, amountTenderedPesewas: (due + 700n).toString() },
      meta
    );
    expect(res).toMatchObject({ success: true, status: "successful", amountPesewas: due.toString(), changePesewas: "700" });

    const [o] = await db.select().from(orders).where(eq(orders.id, order.id));
    expect(o!.paymentStatus).toBe("successful");
    expect(o!.paymentMethod).toBe("cash");
    const rows = await paymentsFor(order.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("successful");
    expect(rows[0]!.paidAt).not.toBeNull();
    expect(rows[0]!.amountPesewas).toBe(due);
  });

  it("rejects a tender below the amount due and records nothing", async () => {
    const order = await newOrder();
    await expect(
      svc.recordPayment(
        station,
        order.id,
        { paymentMethod: "cash", attendantId: attId, amountTenderedPesewas: "1" },
        meta
      )
    ).rejects.toMatchObject({ code: "INSUFFICIENT_TENDER" });
    expect(await paymentsFor(order.id)).toHaveLength(0);
    const [o] = await db.select().from(orders).where(eq(orders.id, order.id));
    expect(o!.paymentStatus).toBe("pending");
  });

  it("two simultaneous cash payments record exactly one", async () => {
    const order = await newOrder();
    const attempt = () => svc.recordPayment(station, order.id, { paymentMethod: "cash", attendantId: attId }, meta);
    const results = await Promise.allSettled([attempt(), attempt()]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const failed = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(failed.reason).toMatchObject({ code: "ORDER_ALREADY_PAID" });
    expect(await paymentsFor(order.id)).toHaveLength(1);
  });

  it("refuses to pay an order twice", async () => {
    const order = await newOrder();
    await svc.recordPayment(station, order.id, { paymentMethod: "cash", attendantId: attId }, meta);
    await expect(
      svc.recordPayment(station, order.id, { paymentMethod: "cash", attendantId: attId }, meta)
    ).rejects.toMatchObject({ statusCode: 409, code: "ORDER_ALREADY_PAID" });
  });

  it("mobile money stays pending, and retrying reuses the same payment row", async () => {
    const order = await newOrder();
    const first = await svc.recordPayment(station, order.id, { paymentMethod: "mobile_money", attendantId: attId }, meta);
    expect(first.status).toBe("pending");
    const again = await svc.recordPayment(station, order.id, { paymentMethod: "mobile_money", attendantId: attId }, meta);
    expect(again.paymentId).toBe(first.paymentId);
    expect(await paymentsFor(order.id)).toHaveLength(1);
    const [o] = await db.select().from(orders).where(eq(orders.id, order.id));
    expect(o!.paymentStatus).toBe("pending");
  });

  it("converts an existing pending payment row instead of adding a second one", async () => {
    const order = await newOrder();
    await db.insert(payments).values({
      orderId: order.id,
      branchId,
      customerId,
      amountPesewas: order.finalPricePesewas,
      method: "mobile_money",
      status: "pending",
    });
    await svc.recordPayment(station, order.id, { paymentMethod: "cash", attendantId: attId }, meta);
    const rows = await paymentsFor(order.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ method: "cash", status: "successful" });
  });

  it("rejects cancelled orders, online orders, and attendants who are not clocked in", async () => {
    const cancelled = await newOrder();
    await db.update(orders).set({ status: "cancelled" }).where(eq(orders.id, cancelled.id));
    await expect(
      svc.recordPayment(station, cancelled.id, { paymentMethod: "cash", attendantId: attId }, meta)
    ).rejects.toMatchObject({ code: "ORDER_CANCELLED" });

    const online = await newOrder();
    await db.update(orders).set({ orderType: "online" }).where(eq(orders.id, online.id));
    await expect(
      svc.recordPayment(station, online.id, { paymentMethod: "cash", attendantId: attId }, meta)
    ).rejects.toMatchObject({ code: "ORDER_NOT_WALK_IN" });

    const plain = await newOrder();
    await expect(
      svc.recordPayment(station, plain.id, { paymentMethod: "cash", attendantId: idleAttId }, meta)
    ).rejects.toMatchObject({ code: "ATTENDANT_NOT_CLOCKED_IN" });
    expect(await paymentsFor(plain.id)).toHaveLength(0);
  });
});

describe("HTTP", () => {
  it("login -> /info works (loggedInAt) and /orders/:id/payment validates and returns change", async () => {
    const app = await buildApp();
    try {
      const login = await app.inject({
        method: "POST",
        url: "/v1/station/login",
        payload: { branchId, deviceId: "http-pay", stationPin: "1234" },
      });
      expect(login.statusCode).toBe(200);
      const headers = { "x-station-token": login.json().stationToken };

      const info = await app.inject({ method: "GET", url: "/v1/station/info", headers });
      expect(info.statusCode).toBe(200);
      expect(new Date(info.json().loggedInAt).getTime()).toBeGreaterThan(0);

      const order = await newOrder();
      const noAttendant = await app.inject({
        method: "POST",
        url: `/v1/station/orders/${order.id}/payment`,
        headers,
        payload: { paymentMethod: "cash" },
      });
      expect(noAttendant.statusCode).toBe(400);

      const ok = await app.inject({
        method: "POST",
        url: `/v1/station/orders/${order.id}/payment`,
        headers,
        payload: {
          paymentMethod: "cash",
          attendantId: attId,
          amountTenderedPesewas: (order.finalPricePesewas + 100n).toString(),
        },
      });
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toMatchObject({ success: true, status: "successful", changePesewas: "100" });
    } finally {
      await app.close();
    }
  }, 30_000);
});
