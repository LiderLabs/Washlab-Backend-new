import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../platform/db/index.js";
import { orders } from "../../platform/db/schema/orders.js";
import { setPaystackClient } from "../../platform/paystack/index.js";
import { buildApp } from "../../app.js";
import { stationService } from "./service.js";
import { stationOrdersService as svc } from "./orders.service.js";
import { cleanExtras } from "./pricing.js";
import { destroyBranch, FakePaystack, makeBranch } from "../cash/test-helpers.js";

let app: Awaited<ReturnType<typeof buildApp>>;
let f: Awaited<ReturnType<typeof makeBranch>>;
let token: string;
let bag = 700;
let k = 0;
const hdr = () => ({ "x-station-token": token });
const walkIn = (extra: object = {}) =>
  app.inject({
    method: "POST",
    url: "/v1/station/orders/walk-in",
    headers: hdr(),
    payload: { attendantId: f.attendantId, customerId: f.customerId, serviceType: "wash_only", weightKg: 5, bagNumber: String(++bag), ...extra },
  });
const key = () => `key-${Date.now()}-${++k}-abcdef`;
const countOrders = async () => (await db.select({ id: orders.id }).from(orders).where(eq(orders.branchId, f.branchId))).length;
const station = () => ({ branchId: f.branchId, stationSessionId: "x" }) as any;

beforeAll(async () => {
  setPaystackClient(new FakePaystack());
  app = await buildApp();
  await app.ready();
  f = await makeBranch("OI");
  token = (await stationService.login({ branchId: f.branchId, deviceId: "oi", stationPin: "1234" }, { ip: "127.0.0.1" })).stationToken;
}, 30_000);
afterAll(async () => {
  setPaystackClient(null);
  await destroyBranch(f);
  await app.close();
});

describe("cleanExtras", () => {
  it("drops extras that don't belong to the service", () => {
    expect(cleanExtras("wash_only", 2, 3)).toEqual({ extraWashLoads: 2, extraDryLoads: 0 });
    expect(cleanExtras("dry_only", 2, 3)).toEqual({ extraWashLoads: 0, extraDryLoads: 3 });
    expect(cleanExtras("wash_and_dry", 2, 3)).toEqual({ extraWashLoads: 2, extraDryLoads: 3 });
    expect(cleanExtras("custom_service", 1, 1)).toEqual({ extraWashLoads: 1, extraDryLoads: 1 });
    expect(cleanExtras("wash_only")).toEqual({ extraWashLoads: 0, extraDryLoads: 0 });
  });
});

describe("extra loads on the wrong service", () => {
  it("is rejected at the API for wash_only with dry extras, and dry_only with wash extras", async () => {
    const before = await countOrders();
    const a = await walkIn({ serviceType: "wash_only", extraDryLoads: 1 });
    expect(a.statusCode).toBe(400);
    const b = await walkIn({ serviceType: "dry_only", extraWashLoads: 1 });
    expect(b.statusCode).toBe(400);
    expect(await countOrders()).toBe(before);
  });

  it("still accepts matching extras and custom services", async () => {
    expect((await walkIn({ serviceType: "wash_only", extraWashLoads: 1 })).statusCode).toBe(200);
    expect((await walkIn({ serviceType: "dry_only", extraDryLoads: 1 })).statusCode).toBe(200);
    expect((await walkIn({ serviceType: "wash_and_dry", extraWashLoads: 1, extraDryLoads: 1 })).statusCode).toBe(200);
  });

  it("the service layer cleans them too, so a caller that skips the API can't inflate the price", async () => {
    const clean = (await walkIn({ serviceType: "wash_only" })).json();
    const sneaky: any = await svc.createWalkIn(
      station(),
      { attendantId: f.attendantId, customerId: f.customerId, serviceType: "wash_only", weightKg: 5, bagNumber: String(++bag), extraDryLoads: 4 } as any,
      { ip: "127.0.0.1" } as any
    );
    expect(sneaky.extraDryLoads).toBe(0);
    expect(sneaky.finalPricePesewas).toBe(clean.finalPricePesewas);
  });

  it("an edit that switches the service drops the extras it no longer has", async () => {
    const o = (await walkIn({ serviceType: "wash_and_dry", extraDryLoads: 2 })).json();
    expect(o.extraDryLoads).toBe(2);
    const r = await app.inject({
      method: "PATCH",
      url: `/v1/station/orders/${o.id}`,
      headers: hdr(),
      payload: { attendantId: f.attendantId, serviceType: "wash_only" },
    });
    expect(r.statusCode).toBe(200);
    const row = (await db.select().from(orders).where(eq(orders.id, o.id)))[0]!;
    expect(row.extraDryLoads).toBe(0);
    // and the edit itself is refused if it asks for the impossible combination
    const bad = await app.inject({
      method: "PATCH",
      url: `/v1/station/orders/${o.id}`,
      headers: hdr(),
      payload: { attendantId: f.attendantId, serviceType: "wash_only", extraDryLoads: 1 },
    });
    expect(bad.statusCode).toBe(400);
  });
});

describe("idempotency key", () => {
  it("a repeated submit returns the same order and creates no second one", async () => {
    const idempotencyKey = key();
    const payload = { idempotencyKey, bagNumber: String(++bag) };
    const before = await countOrders();
    const a = (await walkIn(payload)).json();
    const bRes = await walkIn(payload);
    expect(bRes.statusCode).toBe(200);
    expect(bRes.json().id).toBe(a.id);
    expect(bRes.json().orderNumber).toBe(a.orderNumber);
    expect(await countOrders()).toBe(before + 1);
  });

  it("a double tap fired at the same instant still makes exactly one order", async () => {
    const idempotencyKey = key();
    const payload = { idempotencyKey, bagNumber: String(++bag) };
    const before = await countOrders();
    const rs = await Promise.all([walkIn(payload), walkIn(payload), walkIn(payload), walkIn(payload)]);
    expect(rs.map((r) => r.statusCode)).toEqual([200, 200, 200, 200]);
    expect(new Set(rs.map((r) => r.json().id)).size).toBe(1);
    expect(await countOrders()).toBe(before + 1);
  });

  it("without a key, two submits for the same bag are still caught by the bag rule", async () => {
    const payload = { bagNumber: String(++bag) };
    const rs = await Promise.all([walkIn(payload), walkIn(payload)]);
    expect(rs.map((r) => r.statusCode).sort()).toEqual([200, 409]);
  });

  it("reusing a key for a different customer or service is refused, not silently merged", async () => {
    const idempotencyKey = key();
    await walkIn({ idempotencyKey, serviceType: "wash_only" });
    const r = await walkIn({ idempotencyKey, serviceType: "dry_only" });
    expect(r.statusCode).toBe(409);
  });

  it("keys are per branch", async () => {
    const other = await makeBranch("OJ");
    const otherToken = (await stationService.login({ branchId: other.branchId, deviceId: "oj", stationPin: "1234" }, { ip: "127.0.0.1" })).stationToken;
    const idempotencyKey = key();
    const a = (await walkIn({ idempotencyKey })).json();
    const r = await app.inject({
      method: "POST",
      url: "/v1/station/orders/walk-in",
      headers: { "x-station-token": otherToken },
      payload: { attendantId: other.attendantId, customerId: other.customerId, serviceType: "wash_only", weightKg: 5, bagNumber: "001", idempotencyKey },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().id).not.toBe(a.id);
    await destroyBranch(other);
  });
});
