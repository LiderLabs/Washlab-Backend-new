import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { config } from "../../platform/config/index.js";
import { db } from "../../platform/db/index.js";
import { branches } from "../../platform/db/schema/branches.js";
import { branchServices } from "../../platform/db/schema/catalog.js";
import { customers } from "../../platform/db/schema/customers.js";
import { orders, orderStatusEvents } from "../../platform/db/schema/orders.js";
import { attendanceLogs, attendants } from "../../platform/db/schema/staff.js";
import { hashPin } from "../../platform/crypto/pin.js";
import { buildApp } from "../../app.js";
import { stationService } from "./service.js";
import { normalizePhone } from "./orders.service.js";

if (!config.DATABASE_URL.includes("localhost")) {
  throw new Error("Order tests must only run against a local database");
}

const run = Date.now().toString(36);
const rnd = () => String(Math.floor(Math.random() * 1e7)).padStart(7, "0");
const meta = { ip: "127.0.0.1", userAgent: "vitest" };

let app: Awaited<ReturnType<typeof buildApp>>;
let branchA: string;
let branchB: string;
let tokenA: string;
let tokenB: string;
let attA: string; // clocked in at A
let attIdle: string; // not clocked in
let attB: string; // clocked in at B
let cust: string;
const branchIds: string[] = [];
const attendantIds: string[] = [];
const customerIds: string[] = [];

async function mkBranch(tag: string) {
  const [row] = await db
    .insert(branches)
    .values({
      name: `${tag} ${run}`,
      code: `${tag}${run}`.slice(0, 32),
      phoneNumber: "0000000000",
      address: "Test",
      city: "Test",
      pricingPerKgPesewas: 4000n,
      deliveryFeePesewas: 500n,
      stationPinHash: await hashPin("1234"),
    })
    .returning({ id: branches.id });
  branchIds.push(row!.id);
  await db.insert(branchServices).values([
    { branchId: row!.id, name: "Wash", code: "wash_only", pricePesewas: 3000n },
    { branchId: row!.id, name: "Dry", code: "dry_only", pricePesewas: 2000n },
    { branchId: row!.id, name: "Wash & Dry", code: "wash_and_dry", pricePesewas: 5000n },
  ]);
  return row!.id;
}

async function mkAttendant(name: string, branchId: string, clockedIn: boolean) {
  const [a] = await db
    .insert(attendants)
    .values({
      branchId,
      name,
      email: `${name}-${run}@test.local`,
      phoneNumber: "1",
      status: "active",
      passcodeHash: await hashPin("4321"),
    })
    .returning({ id: attendants.id });
  attendantIds.push(a!.id);
  if (clockedIn) await db.insert(attendanceLogs).values({ attendantId: a!.id, branchId });
  return a!.id;
}

async function mkCustomer(name = "Ama") {
  const [c] = await db
    .insert(customers)
    .values({ name, phoneNumber: `+23324${rnd()}` })
    .returning({ id: customers.id });
  customerIds.push(c!.id);
  return c!.id;
}

const hdr = (token: string) => ({ "x-station-token": token });
const call = (token: string, method: "GET" | "POST" | "PATCH", url: string, payload?: object) =>
  app.inject({ method, url: `/v1/station${url}`, headers: hdr(token), payload });

let bagSeq = 100;
const nextBag = () => String(++bagSeq);
const walkIn = (over: Record<string, unknown> = {}) =>
  call(tokenA, "POST", "/orders/walk-in", {
    attendantId: attA,
    customerId: cust,
    serviceType: "wash_and_dry",
    weightKg: 9,
    bagNumber: nextBag(),
    ...over,
  });

async function mkOnlineOrder(over: Partial<typeof orders.$inferInsert> = {}) {
  const [o] = await db
    .insert(orders)
    .values({
      orderNumber: `ON${rnd()}${Math.floor(Math.random() * 1000)}`,
      orderType: "online",
      customerId: cust,
      branchId: branchA,
      status: "pending_dropoff",
      serviceType: "wash_only",
      ...over,
    })
    .returning();
  return o!;
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  branchA = await mkBranch("OA");
  branchB = await mkBranch("OB");
  attA = await mkAttendant("oa", branchA, true);
  attIdle = await mkAttendant("oidle", branchA, false);
  attB = await mkAttendant("ob", branchB, true);
  cust = await mkCustomer();
  tokenA = (await stationService.login({ branchId: branchA, deviceId: "d-a", stationPin: "1234" }, meta)).stationToken;
  tokenB = (await stationService.login({ branchId: branchB, deviceId: "d-b", stationPin: "1234" }, meta)).stationToken;
});

afterAll(async () => {
  await db.delete(orders).where(inArray(orders.branchId, branchIds));
  await db.delete(attendanceLogs).where(inArray(attendanceLogs.branchId, branchIds));
  await db.delete(attendants).where(inArray(attendants.id, attendantIds));
  await db.delete(customers).where(inArray(customers.id, customerIds));
  await db.delete(branches).where(inArray(branches.id, branchIds));
  await app.close();
});

describe("auth", () => {
  it("rejects requests without a station token", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/station/orders" });
    expect(res.statusCode).toBe(401);
  });
});

describe("walk-in orders", () => {
  it("creates a checked-in order priced per load", async () => {
    const res = await walkIn({ bagNumber: "7" });
    expect(res.statusCode).toBe(200);
    const o = res.json();
    expect(o.status).toBe("checked_in");
    expect(o.orderType).toBe("walk_in");
    expect(o.bagNumber).toBe("007"); // padded like the old app
    expect(o.estimatedLoads).toBe(2); // 9 kg -> 2 loads
    expect(o.finalPricePesewas).toBe(2 * (3000 + 2000)); // wash_and_dry = wash + dry per load
    expect(o.orderNumber).toMatch(/^OA\d{4,}$/);

    const events = await db.select().from(orderStatusEvents).where(eq(orderStatusEvents.orderId, o.id));
    expect(events).toHaveLength(1);
    expect(events[0]!.changedByUserId).toBe(attA);
  });

  it("adds delivery fee and extra loads", async () => {
    const res = await walkIn({
      serviceType: "wash_only",
      weightKg: 5,
      isDelivery: true,
      extraWashLoads: 1,
      extraDryLoads: 2,
    });
    // 1 load x 3000 + delivery 500 + extra wash 3000 + 2 extra dry x 2000
    expect(res.json().finalPricePesewas).toBe(3000 + 500 + 3000 + 4000);
  });

  it("generates unique order numbers", async () => {
    const results = await Promise.all([walkIn(), walkIn(), walkIn(), walkIn()]);
    expect(results.every((r) => r.statusCode === 200)).toBe(true);
    expect(new Set(results.map((r) => r.json().orderNumber)).size).toBe(4);
  });

  it("requires a clocked-in attendant at this branch", async () => {
    const idle = await walkIn({ attendantId: attIdle });
    expect(idle.statusCode).toBe(400);
    expect(idle.json().code).toBe("ATTENDANT_NOT_CLOCKED_IN");

    const otherBranch = await walkIn({ attendantId: attB }); // clocked in, but at branch B
    expect(otherBranch.statusCode).toBe(400);
  });

  it("rejects a bag number that is already on a live order", async () => {
    const bag = nextBag();
    expect((await walkIn({ bagNumber: bag })).statusCode).toBe(200);
    const dup = await walkIn({ bagNumber: bag });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().code).toBe("BAG_IN_USE");
  });

  it("lets only one of two simultaneous requests take the same bag", async () => {
    const bag = nextBag();
    const [r1, r2] = await Promise.all([walkIn({ bagNumber: bag }), walkIn({ bagNumber: bag })]);
    expect([r1.statusCode, r2.statusCode].sort()).toEqual([200, 409]);
  });

  it("frees the bag once the order is completed", async () => {
    const bag = nextBag();
    const o = (await walkIn({ bagNumber: bag })).json();
    expect((await call(tokenA, "GET", "/orders/bag-numbers")).json()).toContain(bag.padStart(3, "0"));
    await call(tokenA, "POST", `/orders/${o.id}/status`, { attendantId: attA, status: "completed" });
    expect((await call(tokenA, "GET", "/orders/bag-numbers")).json()).not.toContain(bag.padStart(3, "0"));
    expect((await walkIn({ bagNumber: bag })).statusCode).toBe(200);
  });

  it("keeps bag numbers separate per branch", async () => {
    const bag = nextBag();
    expect((await walkIn({ bagNumber: bag })).statusCode).toBe(200);
    const b = await call(tokenB, "POST", "/orders/walk-in", {
      attendantId: attB,
      customerId: cust,
      serviceType: "wash_only",
      weightKg: 3,
      bagNumber: bag,
    });
    expect(b.statusCode).toBe(200);
  });
});

describe("status changes", () => {
  it("moves through the flow and records history", async () => {
    const o = (await walkIn()).json();
    for (const status of ["sorting", "washing", "drying", "folding", "ready_for_pickup", "completed"]) {
      const r = await call(tokenA, "POST", `/orders/${o.id}/status`, { attendantId: attA, status, notes: `to ${status}` });
      expect(r.statusCode).toBe(200);
    }
    const detail = (await call(tokenA, "GET", `/orders/${o.id}`)).json();
    expect(detail.status).toBe("completed");
    expect(detail.completedAt).not.toBeNull();
    expect(detail.history.map((h: any) => h.toStatus)).toEqual([
      "checked_in",
      "sorting",
      "washing",
      "drying",
      "folding",
      "ready_for_pickup",
      "completed",
    ]);
    expect(detail.history[1].changedBy).toEqual({ type: "attendant", name: expect.stringContaining("oa") });
  });

  it("refuses to reopen a closed order or repeat a status", async () => {
    const o = (await walkIn()).json();
    await call(tokenA, "POST", `/orders/${o.id}/status`, { attendantId: attA, status: "completed" });
    const reopen = await call(tokenA, "POST", `/orders/${o.id}/status`, { attendantId: attA, status: "washing" });
    expect(reopen.statusCode).toBe(409);
    expect(reopen.json().code).toBe("ORDER_CLOSED");

    const o2 = (await walkIn()).json();
    await call(tokenA, "POST", `/orders/${o2.id}/status`, { attendantId: attA, status: "washing" });
    const same = await call(tokenA, "POST", `/orders/${o2.id}/status`, { attendantId: attA, status: "washing" });
    expect(same.json().code).toBe("STATUS_UNCHANGED");
  });

  it("serialises simultaneous changes to the same order", async () => {
    const o = (await walkIn()).json();
    const rs = await Promise.all([
      call(tokenA, "POST", `/orders/${o.id}/status`, { attendantId: attA, status: "washing" }),
      call(tokenA, "POST", `/orders/${o.id}/status`, { attendantId: attA, status: "washing" }),
    ]);
    expect(rs.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    const events = await db.select().from(orderStatusEvents).where(eq(orderStatusEvents.orderId, o.id));
    expect(events.filter((e) => e.toStatus === "washing")).toHaveLength(1);
  });

  it("cannot touch another branch's order", async () => {
    const o = (await walkIn()).json();
    const r = await call(tokenB, "POST", `/orders/${o.id}/status`, { attendantId: attB, status: "washing" });
    expect(r.statusCode).toBe(404);
    expect((await call(tokenB, "GET", `/orders/${o.id}`)).statusCode).toBe(404);
  });
});

describe("editing", () => {
  it("reprices when weight or extras change", async () => {
    const o = (await walkIn({ serviceType: "wash_only", weightKg: 5 })).json();
    expect(o.finalPricePesewas).toBe(3000);
    const r = await call(tokenA, "PATCH", `/orders/${o.id}`, { attendantId: attA, weightKg: 17, extraDryLoads: 1 });
    expect(r.statusCode).toBe(200);
    expect(r.json().estimatedLoads).toBe(3);
    expect(r.json().finalPricePesewas).toBe(3 * 3000 + 2000);
  });

  it("refuses to edit a paid order", async () => {
    const o = (await walkIn()).json();
    await db.update(orders).set({ paymentStatus: "successful" }).where(eq(orders.id, o.id));
    const r = await call(tokenA, "PATCH", `/orders/${o.id}`, { attendantId: attA, weightKg: 3 });
    expect(r.statusCode).toBe(409);
    expect(r.json().code).toBe("ORDER_PAID");
  });

  it("rejects moving to a bag that is taken", async () => {
    const a = (await walkIn()).json();
    const b = (await walkIn()).json();
    const r = await call(tokenA, "PATCH", `/orders/${b.id}`, { attendantId: attA, bagNumber: a.bagNumber });
    expect(r.statusCode).toBe(409);
    expect(r.json().code).toBe("BAG_IN_USE");
  });
});

describe("online orders", () => {
  it("checks in, weighs and prices a pending order", async () => {
    const o = await mkOnlineOrder({ serviceType: "wash_only", isDelivery: true });
    const bag = nextBag();
    const r = await call(tokenA, "POST", `/orders/${o.id}/check-in`, {
      attendantId: attA,
      weightKg: 9,
      bagNumber: bag,
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().status).toBe("checked_in");
    expect(r.json().finalPricePesewas).toBe(2 * 3000 + 500);
    expect(r.json().checkedInAt).not.toBeNull();

    const again = await call(tokenA, "POST", `/orders/${o.id}/check-in`, { attendantId: attA, weightKg: 9, bagNumber: nextBag() });
    expect(again.statusCode).toBe(409);
  });

  it("cancels only pending orders", async () => {
    const pending = await mkOnlineOrder();
    const ok = await call(tokenA, "POST", `/orders/${pending.id}/cancel`, { attendantId: attA, reason: "no show" });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().status).toBe("cancelled");

    const walk = (await walkIn()).json();
    const no = await call(tokenA, "POST", `/orders/${walk.id}/cancel`, { attendantId: attA });
    expect(no.statusCode).toBe(409);
  });

  it("will not process a pending order before check-in", async () => {
    const o = await mkOnlineOrder();
    const r = await call(tokenA, "POST", `/orders/${o.id}/status`, { attendantId: attA, status: "washing" });
    expect(r.json().code).toBe("ORDER_NOT_CHECKED_IN");
  });
});

describe("listing and customers", () => {
  it("paginates with a cursor without repeats", async () => {
    for (let i = 0; i < 5; i++) await walkIn();
    const seen = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;
    do {
      const url: string = `/orders?limit=4${cursor ? `&cursor=${cursor}` : ""}`;
      const body: any = (await call(tokenA, "GET", url)).json();
      for (const o of body.items) {
        expect(seen.has(o.id)).toBe(false);
        seen.add(o.id);
      }
      cursor = body.nextCursor;
      pages++;
    } while (cursor && pages < 20);
    expect(pages).toBeGreaterThan(1);
    // only this branch's orders
    const all = await db.select({ b: orders.branchId }).from(orders).where(inArray(orders.id, [...seen]));
    expect(all.every((r) => r.b === branchA)).toBe(true);
  });

  it("filters by status and searches by bag, order number and phone", async () => {
    const bag = nextBag();
    const o = (await walkIn({ bagNumber: bag })).json();
    await call(tokenA, "POST", `/orders/${o.id}/status`, { attendantId: attA, status: "folding" });

    const byStatus = (await call(tokenA, "GET", "/orders?status=folding&limit=100")).json();
    expect(byStatus.items.some((x: any) => x.id === o.id)).toBe(true);
    expect(byStatus.items.every((x: any) => x.status === "folding")).toBe(true);

    for (const term of [bag, o.orderNumber, o.customer.phoneNumber.slice(-7)]) {
      const res = (await call(tokenA, "GET", `/orders?search=${encodeURIComponent(term)}`)).json();
      expect(res.items.some((x: any) => x.id === o.id)).toBe(true);
    }
    const none = (await call(tokenA, "GET", "/orders?search=zzzznope")).json();
    expect(none.items).toHaveLength(0);
  });

  it("rejects a malformed cursor", async () => {
    const r = await call(tokenA, "GET", "/orders?cursor=garbage");
    expect(r.statusCode).toBe(400);
  });

  it("normalises phone numbers and finds an existing customer instead of duplicating", async () => {
    expect(normalizePhone("0241234567")).toBe("+233241234567");
    expect(normalizePhone("233241234567")).toBe("+233241234567");
    expect(normalizePhone("+233 24 123 4567")).toBe("+233241234567");

    const tail = rnd();
    const first = await call(tokenA, "POST", "/customers", { name: "Kofi Test", phoneNumber: `024${tail}` });
    expect(first.statusCode).toBe(200);
    customerIds.push(first.json().customer.id);
    expect(first.json().created).toBe(true);
    const second = await call(tokenA, "POST", "/customers", { name: "Kofi Again", phoneNumber: `+23324${tail}` });
    expect(second.json().created).toBe(false);
    expect(second.json().customer.id).toBe(first.json().customer.id);

    const found = (await call(tokenA, "GET", `/customers/search?q=${tail}`)).json();
    expect(found.some((c: any) => c.id === first.json().customer.id)).toBe(true);
  });
});
