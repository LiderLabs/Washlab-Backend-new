import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";

// Fake Clerk: "valid_<id>" verifies as user <id>.
vi.mock("@clerk/backend", () => ({
  verifyToken: vi.fn(async (token: string) => {
    if (token.startsWith("valid_")) return { sub: token.slice(6) };
    throw new Error("bad token");
  }),
}));

import { db } from "../../platform/db/index.js";
import { admins, attendants } from "../../platform/db/schema/staff.js";
import { orders, orderStatusEvents } from "../../platform/db/schema/orders.js";
import { payments } from "../../platform/db/schema/payments.js";
import { customers } from "../../platform/db/schema/customers.js";
import { loyaltyLedger } from "../../platform/db/schema/loyalty.js";
import { inventoryItems } from "../../platform/db/schema/operations.js";
import { auditLogs } from "../../platform/db/schema/infrastructure.js";
import { buildApp } from "../../app.js";
import { stationService } from "../station/service.js";
import { destroyBranch, makeBranch } from "../cash/test-helpers.js";

let app: Awaited<ReturnType<typeof buildApp>>;
let f: Awaited<ReturnType<typeof makeBranch>>;
let stationToken: string;
let bag = 800;
const run = Date.now().toString(36);
const ids = { admin: `adm_${run}`, plain: `plain_${run}`, att: `att_${run}` };
let adminRowId: string;

const as = (clerkId: string) => ({ authorization: `Bearer valid_${clerkId}` });
const A = () => as(ids.admin);
const call = (method: string, url: string, payload?: unknown, headers = A()) =>
  app.inject({ method: method as any, url: `/v1/admin${url}`, headers, payload: payload as any });

async function newOrder(over: object = {}) {
  const r = await app.inject({
    method: "POST",
    url: "/v1/station/orders/walk-in",
    headers: { "x-station-token": stationToken },
    payload: { attendantId: f.attendantId, customerId: f.customerId, serviceType: "wash_only", weightKg: 5, bagNumber: String(++bag), ...over },
  });
  expect(r.statusCode).toBe(200);
  return r.json() as { id: string; orderNumber: string };
}
const orderRow = async (id: string) => (await db.select().from(orders).where(eq(orders.id, id)))[0]!;
const points = async () => (await db.select().from(customers).where(eq(customers.id, f.customerId)))[0]!.loyaltyPoints;

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  f = await makeBranch("AD");
  stationToken = (await stationService.login({ branchId: f.branchId, deviceId: "ad", stationPin: "1234" }, { ip: "127.0.0.1" })).stationToken;
  [{ id: adminRowId }] = (await db
    .insert(admins)
    .values({ clerkUserId: ids.admin, email: `${ids.admin}@test.local`, name: "Test Admin", role: "super_admin" })
    .returning({ id: admins.id })) as any;
  await db.insert(attendants).values({
    branchId: f.branchId, clerkUserId: ids.att, name: "Clerk Att", email: `${ids.att}@test.local`, phoneNumber: "1", status: "active",
  });
}, 30_000);

afterAll(async () => {
  const os = await db.select({ id: orders.id }).from(orders).where(eq(orders.branchId, f.branchId));
  if (os.length) await db.delete(orderStatusEvents).where(inArray(orderStatusEvents.orderId, os.map((o) => o.id)));
  await db.delete(auditLogs).where(eq(auditLogs.performedByUserId, ids.admin));
  await db.delete(attendants).where(eq(attendants.clerkUserId, ids.att));
  await destroyBranch(f);
  await db.delete(admins).where(eq(admins.clerkUserId, ids.admin));
  await app.close();
});

describe("access control", () => {
  const sample: [string, string][] = [
    ["GET", "/me"],
    ["GET", "/staff"],
    ["GET", "/branches"],
    ["GET", "/orders"],
    ["GET", "/customers"],
    ["GET", "/services"],
  ];

  it("401 without a token or with a bad one", async () => {
    for (const [m, u] of sample) {
      expect((await call(m, u, undefined, {} as any)).statusCode).toBe(401);
      expect((await call(m, u, undefined, { authorization: "Bearer nonsense" })).statusCode).toBe(401);
    }
  });

  it("403 for an attendant and for a customer, on reads and writes", async () => {
    for (const who of [ids.att, ids.plain]) {
      for (const [m, u] of sample.slice(1)) expect((await call(m, u, undefined, as(who))).statusCode).toBe(403);
      expect((await call("POST", "/branches", { name: "x" }, as(who))).statusCode).toBe(403);
      expect((await call("DELETE", `/orders/${f.customerId}`, undefined, as(who))).statusCode).toBe(403);
    }
  });

  it("an admin gets through", async () => {
    const me = await call("GET", "/me");
    expect(me.statusCode).toBe(200);
    for (const [m, u] of sample.slice(1)) {
      const r = await call(m, u);
      expect({ u, status: r.statusCode, body: r.statusCode === 200 ? "" : r.body.slice(0, 300) }).toMatchObject({ status: 200 });
    }
  });
});

describe("order status (admin override)", () => {
  it("sets any status, records the event and the audit, and refuses a no-op", async () => {
    const o = await newOrder();
    const r = await call("PATCH", `/orders/${o.id}/status`, { newStatus: "washing", notes: "fixing a mistake" });
    expect(r.statusCode).toBe(200);
    expect((await orderRow(o.id)).status).toBe("washing");
    const ev = await db.select().from(orderStatusEvents).where(eq(orderStatusEvents.orderId, o.id));
    expect(ev.at(-1)).toMatchObject({ toStatus: "washing", changedByRole: "super_admin", notes: "fixing a mistake" });
    expect((await call("PATCH", `/orders/${o.id}/status`, { newStatus: "washing" })).statusCode).toBe(409);
    expect((await call("PATCH", `/orders/${o.id}/status`, { newStatus: "bogus" })).statusCode).toBe(400);
    expect((await call("PATCH", `/orders/00000000-0000-4000-8000-000000000000/status`, { newStatus: "washing" })).statusCode).toBe(404);
  });

  it("completing runs the same effects as the station, exactly once even if reopened and completed again", async () => {
    await db.update(customers).set({ loyaltyPoints: 0 }).where(eq(customers.id, f.customerId));
    const o = await newOrder();
    expect((await call("PATCH", `/orders/${o.id}/status`, { newStatus: "completed" })).statusCode).toBe(200);
    expect(await points()).toBe(1);
    const completedAt = (await orderRow(o.id)).completedAt;
    expect(completedAt).toBeTruthy();

    expect((await call("PATCH", `/orders/${o.id}/status`, { newStatus: "folding" })).statusCode).toBe(200);
    expect((await call("PATCH", `/orders/${o.id}/status`, { newStatus: "completed" })).statusCode).toBe(200);
    expect(await points()).toBe(1);
    expect((await orderRow(o.id)).completedAt).toEqual(completedAt);
    expect(await db.select().from(loyaltyLedger).where(eq(loyaltyLedger.orderId, o.id))).toHaveLength(1);
  });

  it("two admins changing the same order at once: one wins, the other is told it's already there", async () => {
    const o = await newOrder();
    const rs = await Promise.all([
      call("PATCH", `/orders/${o.id}/status`, { newStatus: "drying" }),
      call("PATCH", `/orders/${o.id}/status`, { newStatus: "drying" }),
    ]);
    expect(rs.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect((await db.select().from(orderStatusEvents).where(eq(orderStatusEvents.orderId, o.id))).filter((e) => e.toStatus === "drying")).toHaveLength(1);
  });
});

describe("deleting orders", () => {
  it("soft-deletes an unpaid order and it disappears from the list", async () => {
    const o = await newOrder();
    expect((await call("DELETE", `/orders/${o.id}`)).statusCode).toBe(200);
    expect((await orderRow(o.id)).deletedAt).toBeTruthy();
    const list = (await call("GET", `/orders?branchId=${f.branchId}&limit=200`)).json();
    expect(JSON.stringify(list)).not.toContain(o.id);
    expect((await call("DELETE", `/orders/${o.id}`)).statusCode).toBe(404);
  });

  it("refuses to delete an order that has been paid, and leaves it untouched", async () => {
    const o = await newOrder();
    const pay = await app.inject({
      method: "POST",
      url: `/v1/station/orders/${o.id}/payment`,
      headers: { "x-station-token": stationToken },
      payload: { attendantId: f.attendantId, pin: f.pin, paymentMethod: "cash" },
    });
    expect(pay.statusCode).toBe(200);
    const res = await call("DELETE", `/orders/${o.id}`);
    expect(res.statusCode).toBe(409);
    expect((await orderRow(o.id)).deletedAt).toBeNull();
    expect(await db.select().from(payments).where(eq(payments.orderId, o.id))).toHaveLength(1);
  });
});

describe("listing orders", () => {
  it("filters by branch, status and search, and pages", async () => {
    const a = await newOrder();
    await newOrder();
    await call("PATCH", `/orders/${a.id}/status`, { newStatus: "sorting" });
    const all = (await call("GET", `/orders?branchId=${f.branchId}&limit=200`)).json();
    expect(all.length).toBeGreaterThanOrEqual(2);
    const sorting = (await call("GET", `/orders?branchId=${f.branchId}&status=sorting`)).json();
    expect(sorting.every((x: any) => x.status === "sorting")).toBe(true);
    expect(sorting.map((x: any) => x.id)).toContain(a.id);
    const one = (await call("GET", `/orders?branchId=${f.branchId}&limit=1`)).json();
    const two = (await call("GET", `/orders?branchId=${f.branchId}&limit=1&offset=1`)).json();
    expect(one).toHaveLength(1);
    expect(two[0].id).not.toBe(one[0].id);
    expect((await call("GET", `/orders?limit=9999`)).statusCode).toBe(400);
    const detail = await call("GET", `/orders/${a.id}`);
    expect(detail.statusCode).toBe(200);
    expect(detail.json().id).toBe(a.id);
  });
});

describe("staff", () => {
  const email = () => `staff-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.com`;
  const enroll = (over: object = {}) =>
    call("POST", "/staff/enroll", { name: "Kofi Test", email: email(), phoneNumber: "0241234567", branchId: f.branchId, ...over });
  const att = async (id: string) => (await db.select().from(attendants).where(eq(attendants.id, id)))[0]!;
  const made: string[] = [];
  afterAll(async () => {
    for (const id of made) await db.delete(auditLogs).where(eq(auditLogs.entityId, id));
    if (made.length) await db.delete(attendants).where(inArray(attendants.id, made));
  });

  it("invites an attendant: status invited, link returned once, only a hash stored", async () => {
    const r = await enroll();
    expect(r.statusCode).toBe(200);
    const body = r.json();
    made.push(body.attendantId);
    expect(body.enrollmentToken).toMatch(/^[a-f0-9]{64}$/);
    expect(body.enrollmentLink).toContain(body.enrollmentToken);
    const row = await att(body.attendantId);
    expect(row.status).toBe("invited");
    expect(row.enrollmentTokenHash).not.toBe(body.enrollmentToken);
    expect(row.passcodeHash).toBeNull();
  });

  it("refuses a duplicate email, an unknown branch and bad input", async () => {
    const e = email();
    const first = await enroll({ email: e });
    made.push(first.json().attendantId);
    expect((await enroll({ email: e })).statusCode).toBe(409);
    expect((await enroll({ email: e.toUpperCase() })).statusCode).toBe(409);
    expect((await enroll({ branchId: "00000000-0000-4000-8000-000000000000" })).statusCode).toBe(404);
    expect((await enroll({ email: "nope" })).statusCode).toBe(400);
  });

  it("resending an invite replaces the old link", async () => {
    const first = (await enroll()).json();
    made.push(first.attendantId);
    const resent = await call("POST", `/staff/${first.attendantId}/resend-enrollment`);
    expect({ status: resent.statusCode, body: resent.statusCode === 200 ? "" : resent.body.slice(0, 400) }).toMatchObject({ status: 200 });
    const again = resent.json();
    expect(again.enrollmentToken).not.toBe(first.enrollmentToken);
    const old = await app.inject({ method: "POST", url: "/v1/station/enrollment/verify", payload: { token: first.enrollmentToken } });
    expect(old.json().valid).toBe(false);
    const fresh = await app.inject({ method: "POST", url: "/v1/station/enrollment/verify", payload: { token: again.enrollmentToken } });
    expect(fresh.json().valid).toBe(true);
  });

  it("suspend, activate, lock, unlock and reset failures change the right fields, and each is audited", async () => {
    const id = (await enroll()).json().attendantId as string;
    made.push(id);
    await db.update(attendants).set({ status: "active", passcodeHash: "x" }).where(eq(attendants.id, id));

    expect((await call("POST", `/staff/${id}/suspend`)).statusCode).toBe(200);
    expect((await att(id)).status).toBe("suspended");
    expect((await call("POST", `/staff/${id}/activate`)).statusCode).toBe(200);
    expect((await att(id)).status).toBe("active");

    expect((await call("POST", `/staff/${id}/lock`, { lockedUntilMinutes: 60, reason: "test" })).statusCode).toBe(200);
    const locked = await att(id);
    expect(locked.lockedUntil!.getTime()).toBeGreaterThan(Date.now() + 50 * 60_000);
    expect((await call("POST", `/staff/${id}/unlock`)).statusCode).toBe(200);
    expect((await att(id)).lockedUntil).toBeNull();

    await db.update(attendants).set({ failedAttempts: 4 }).where(eq(attendants.id, id));
    expect((await call("POST", `/staff/${id}/reset-failures`)).statusCode).toBe(200);
    expect((await att(id)).failedAttempts).toBe(0);

    const actions = (await db.select().from(auditLogs).where(eq(auditLogs.entityId, id))).map((a) => a.action);
    expect(actions.length).toBeGreaterThanOrEqual(5);
  });

  it("a suspended attendant can't clock in at the station", async () => {
    const id = (await enroll()).json().attendantId as string;
    made.push(id);
    await db.update(attendants).set({ status: "active" }).where(eq(attendants.id, id));
    await call("POST", `/staff/${id}/suspend`);
    const r = await app.inject({
      method: "POST",
      url: "/v1/station/attendance/clock-in",
      headers: { "x-station-token": stationToken },
      payload: { attendantId: id, pin: "1234" },
    });
    expect([401, 403, 404, 409]).toContain(r.statusCode);
  });

  it("deleting is soft, takes them out of the list, and 404s afterwards", async () => {
    const id = (await enroll()).json().attendantId as string;
    made.push(id);
    expect((await call("DELETE", `/staff/${id}`)).statusCode).toBe(200);
    expect((await att(id)).deletedAt).toBeTruthy();
    expect(JSON.stringify((await call("GET", "/staff")).json())).not.toContain(id);
    expect((await call("POST", `/staff/${id}/suspend`)).statusCode).toBe(404);
  });
});
