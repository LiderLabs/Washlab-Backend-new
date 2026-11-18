import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { config } from "../../platform/config/index.js";
import { db } from "../../platform/db/index.js";
import { branches } from "../../platform/db/schema/branches.js";
import { customers } from "../../platform/db/schema/customers.js";
import { loyaltyLedger } from "../../platform/db/schema/loyalty.js";
import { auditLogs } from "../../platform/db/schema/infrastructure.js";
import { inventoryItems, notifications } from "../../platform/db/schema/operations.js";
import { attendanceLogs, attendants } from "../../platform/db/schema/staff.js";
import type { StationContext } from "../../platform/auth/station.js";
import { hashPin } from "../../platform/crypto/pin.js";
import { buildApp } from "../../app.js";
import { stationService } from "./service.js";
import { stationOrdersService } from "./orders.service.js";

if (!config.DATABASE_URL.includes("localhost")) throw new Error("Tests must only run against a local database");

const run = Date.now().toString(36).toUpperCase();
const branchIds: string[] = [];
let branchId: string;
let station: StationContext;
let attId: string;
let idleAttId: string;
let customerId: string;
const itemIds: string[] = [];

async function mkBranch(suffix: string, over: Partial<typeof branches.$inferInsert> = {}) {
  const [b] = await db
    .insert(branches)
    .values({
      name: `Left ${suffix} ${run}`,
      code: `L${suffix}${run}`.slice(0, 32),
      phoneNumber: "0000000000",
      address: "Test street",
      city: "Test",
      pricingPerKgPesewas: 4000n,
      stationPinHash: await hashPin("1234"),
      ...over,
    })
    .returning({ id: branches.id });
  branchIds.push(b!.id);
  return b!.id;
}

async function mkItem(over: Partial<typeof inventoryItems.$inferInsert> = {}) {
  const [i] = await db
    .insert(inventoryItems)
    .values({
      branchId,
      name: `Detergent ${crypto.randomUUID().slice(0, 6)}`,
      category: "cleaning_supplies",
      unit: "kg",
      currentStock: 4,
      maxStock: 100,
      minStock: 5,
      reorderPoint: 20,
      status: "critical",
      ...over,
    })
    .returning();
  itemIds.push(i!.id);
  return i!;
}
const reload = async (id: string) => (await db.select().from(inventoryItems).where(eq(inventoryItems.id, id)))[0]!;
const auditFor = (entityId: string, action: string) =>
  db.select().from(auditLogs).where(and(eq(auditLogs.entityId, entityId), eq(auditLogs.action, action)));

beforeAll(async () => {
  branchId = await mkBranch("A");
  station = {
    sessionId: crypto.randomUUID(),
    branchId,
    deviceId: "left-test",
    expiresAt: new Date(Date.now() + 3_600_000),
    loggedInAt: new Date(),
  };
  const mkAtt = async (name: string) =>
    (
      await db
        .insert(attendants)
        .values({ branchId, name, email: `${name}-${run}@t.local`, phoneNumber: "1", status: "active", passcodeHash: await hashPin("4321") })
        .returning({ id: attendants.id })
    )[0]!.id;
  attId = await mkAtt("clocked");
  idleAttId = await mkAtt("idle");
  await db.insert(attendanceLogs).values({ attendantId: attId, branchId, deviceId: "left-test" });
  const [c] = await db
    .insert(customers)
    .values({ name: "Loyal Customer", phoneNumber: `+2332${Math.floor(Math.random() * 1e8)}`, loyaltyPoints: 7 })
    .returning({ id: customers.id });
  customerId = c!.id;
  await db.insert(loyaltyLedger).values([
    { customerId, pointsDelta: 10, balanceAfter: 10, reason: "order_completed" },
    { customerId, pointsDelta: -3, balanceAfter: 7, reason: "reward_redemption" },
  ]);
}, 30_000);

afterAll(async () => {
  await db.delete(notifications).where(inArray(notifications.branchId, branchIds));
  if (itemIds.length) await db.delete(inventoryItems).where(inArray(inventoryItems.id, itemIds));
  await db.delete(loyaltyLedger).where(eq(loyaltyLedger.customerId, customerId));
  await db.delete(customers).where(eq(customers.id, customerId));
  await db.delete(attendanceLogs).where(inArray(attendanceLogs.branchId, branchIds));
  await db.delete(attendants).where(inArray(attendants.branchId, branchIds));
  await db.delete(branches).where(inArray(branches.id, branchIds));
});

describe("public branch lookup (station login screen)", () => {
  it("lists active branches only, sorted by code", async () => {
    const inactive = await mkBranch("I", { isActive: false });
    const deleted = await mkBranch("D", { deletedAt: new Date() });
    const list = await stationService.listActiveBranches();
    const codes = list.map((b) => b.code);
    expect(codes).toContain(`LA${run}`);
    expect(codes).not.toContain(`LI${run}`);
    expect(codes).not.toContain(`LD${run}`);
    expect([...codes].sort()).toEqual(codes);
    expect(inactive).not.toBe(deleted);
  });

  it("finds a branch by code, ignoring case and spaces, and says whether it has a station PIN", async () => {
    const b = await stationService.getBranchByCode(`  la${run.toLowerCase()} `);
    expect(b.id).toBe(branchId);
    expect(b.hasStationPin).toBe(true);
    expect(b).not.toHaveProperty("stationPinHash");
  });

  it("404s for unknown and inactive branches", async () => {
    await expect(stationService.getBranchByCode("NOPE-NOPE")).rejects.toMatchObject({ statusCode: 404 });
    await expect(stationService.getBranchByCode(`LI${run}`)).rejects.toMatchObject({ statusCode: 404 });
  });

  it("works over HTTP with no station token", async () => {
    const app = await buildApp();
    try {
      const list = await app.inject({ method: "GET", url: "/v1/station/branches" });
      expect(list.statusCode).toBe(200);
      expect(list.json().some((b: any) => b.code === `LA${run}`)).toBe(true);
      const one = await app.inject({ method: "GET", url: `/v1/station/branches/by-code/la${run}` });
      expect(one.statusCode).toBe(200);
      expect(one.json()).toMatchObject({ id: branchId, hasStationPin: true });
      expect((await app.inject({ method: "GET", url: "/v1/station/branches/by-code/ZZZZ" })).statusCode).toBe(404);
    } finally {
      await app.close();
    }
  }, 30_000);
});

describe("customer loyalty lookup", () => {
  it("returns the balance and lifetime totals", async () => {
    expect(await stationOrdersService.getCustomerLoyalty(customerId)).toEqual({ points: 7, totalEarned: 10, totalRedeemed: 3 });
  });
  it("404s for an unknown customer", async () => {
    await expect(stationOrdersService.getCustomerLoyalty(crypto.randomUUID())).rejects.toMatchObject({ statusCode: 404 });
  });
  it("needs a station token over HTTP", async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({ method: "GET", url: `/v1/station/customers/${customerId}/loyalty` });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});

describe("inventory ordering", () => {
  it("place order: stores quantity and expected arrival, marks ordered, audits the attendant", async () => {
    const item = await mkItem();
    const eta = new Date(Date.now() + 3 * 86_400_000).toISOString();
    const res = await stationService.orderInventory(station, item.id, { orderQuantity: 25, expectedArrivalDate: eta, attendantId: attId });
    expect(res).toMatchObject({ status: "ordered", orderQuantity: 25 });
    expect(new Date(res.expectedArrivalDate!).toISOString()).toBe(eta);
    expect(res.orderedAt).not.toBeNull();

    const [log] = await auditFor(item.id, "inventory.order_placed");
    expect(log!.performedByUserId).toBe(attId);
    expect(log!.performedByRole).toBe("attendant");
  });

  it("rejects an attendant who is not clocked in", async () => {
    const item = await mkItem();
    await expect(stationService.orderInventory(station, item.id, { orderQuantity: 5, attendantId: idleAttId })).rejects.toMatchObject({
      code: "ATTENDANT_NOT_CLOCKED_IN",
    });
    expect((await reload(item.id)).status).toBe("critical");
  });

  it("without an attendant, the action is attributed to the station", async () => {
    const item = await mkItem();
    await stationService.orderInventory(station, item.id, { orderQuantity: 5 });
    const [log] = await auditFor(item.id, "inventory.order_placed");
    expect(log!.performedByRole).toBe("station");
  });

  it("request order: notifies admins, marks ordered, priority follows stock level", async () => {
    const critical = await mkItem({ status: "critical" });
    const low = await mkItem({ status: "low", currentStock: 15 });
    expect(await stationService.requestInventoryOrder(station, critical.id, { notes: "Running out fast", attendantId: attId })).toEqual({ success: true });
    await stationService.requestInventoryOrder(station, low.id, {});

    const note = (await db.select().from(notifications).where(eq(notifications.entityId, critical.id)))[0]!;
    expect(note).toMatchObject({ recipientType: "admin", branchId, priority: "high", type: "warning" });
    expect(note.message).toContain("Running out fast");
    expect(note.message).toContain("clocked");
    expect((await db.select().from(notifications).where(eq(notifications.entityId, low.id)))[0]!.priority).toBe("normal");
    expect((await reload(critical.id)).status).toBe("ordered");
  });

  it("receive: defaults to the ordered quantity, recomputes status, clears the open order", async () => {
    const item = await mkItem();
    await stationService.orderInventory(station, item.id, { orderQuantity: 30, expectedArrivalDate: new Date(Date.now() + 86_400_000).toISOString() });
    const res = await stationService.receiveInventory(station, item.id, { attendantId: attId });
    expect(res).toMatchObject({ currentStock: 34, status: "ok", orderQuantity: null, expectedArrivalDate: null, orderedAt: null });
    expect(res.lastRestockedAt).not.toBeNull();
    expect(res.arrivalDate).not.toBeNull();
    expect((await auditFor(item.id, "inventory.order_received"))[0]!.changes).toMatchObject({ receivedQuantity: 30, newStock: 34 });
  });

  it("receive: an explicit quantity wins, and a request-only order needs one", async () => {
    const item = await mkItem();
    await stationService.requestInventoryOrder(station, item.id, {});
    await expect(stationService.receiveInventory(station, item.id, {})).rejects.toMatchObject({ code: "QUANTITY_REQUIRED" });
    const res = await stationService.receiveInventory(station, item.id, { receivedQuantity: 10 });
    expect(res.currentStock).toBe(14);
    expect(res.status).toBe("low");
  });

  it("receive: refuses items that are not on order, and a double delivery adds stock only once", async () => {
    const idle = await mkItem({ status: "ok", currentStock: 50 });
    await expect(stationService.receiveInventory(station, idle.id, { receivedQuantity: 5 })).rejects.toMatchObject({
      statusCode: 409,
      code: "ITEM_NOT_ORDERED",
    });

    const item = await mkItem();
    await stationService.orderInventory(station, item.id, { orderQuantity: 20 });
    const results = await Promise.allSettled([
      stationService.receiveInventory(station, item.id, {}),
      stationService.receiveInventory(station, item.id, {}),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await reload(item.id)).currentStock).toBe(24);
  });

  it("cannot touch another branch's item", async () => {
    const otherBranch = await mkBranch("O");
    const [foreign] = await db
      .insert(inventoryItems)
      .values({ branchId: otherBranch, name: "Foreign", category: "facility", unit: "pcs", currentStock: 1, minStock: 1, reorderPoint: 2, maxStock: 9 })
      .returning();
    itemIds.push(foreign!.id);
    await expect(stationService.orderInventory(station, foreign!.id, { orderQuantity: 1 })).rejects.toMatchObject({ statusCode: 404 });
  });

  it("HTTP: validates the body and lists the new fields", async () => {
    const app = await buildApp();
    try {
      const login = await app.inject({ method: "POST", url: "/v1/station/login", payload: { branchId, deviceId: "left-http", stationPin: "1234" } });
      expect(login.statusCode).toBe(200);
      const headers = { "x-station-token": login.json().stationToken };
      const item = await mkItem();

      const bad = await app.inject({ method: "POST", url: `/v1/station/inventory/${item.id}/order`, headers, payload: { orderQuantity: 0 } });
      expect(bad.statusCode).toBe(400);

      const ok = await app.inject({ method: "POST", url: `/v1/station/inventory/${item.id}/order`, headers, payload: { orderQuantity: 12 } });
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toMatchObject({ status: "ordered", orderQuantity: 12 });

      const list = await app.inject({ method: "GET", url: "/v1/station/inventory", headers });
      const row = list.json().find((i: any) => i.id === item.id);
      expect(row).toMatchObject({ orderQuantity: 12, status: "ordered" });
      expect(row).toHaveProperty("expectedArrivalDate");

      const req = await app.inject({ method: "POST", url: `/v1/station/inventory/${item.id}/request-order`, headers, payload: { notes: "urgent" } });
      expect(req.statusCode).toBe(200);
      expect(req.json()).toEqual({ success: true });
    } finally {
      await app.close();
    }
  }, 30_000);
});
