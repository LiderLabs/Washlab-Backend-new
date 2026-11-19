import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../platform/db/index.js";
import { branchMachines } from "../../platform/db/schema/catalog.js";
import { headlines, maintenanceTickets } from "../../platform/db/schema/maintenance.js";
import { attendanceLogs } from "../../platform/db/schema/staff.js";
import { buildApp } from "../../app.js";
import { stationService } from "./service.js";
import { destroyBranch, makeBranch } from "../cash/test-helpers.js";

let app: Awaited<ReturnType<typeof buildApp>>;
let f: Awaited<ReturnType<typeof makeBranch>>;
let other: Awaited<ReturnType<typeof makeBranch>>;
let token: string;
let otherToken: string;
let machineId: string;
let otherMachineId: string;
const hdr = (t = token) => ({ "x-station-token": t });
const report = (payload: object, t = token) =>
  app.inject({ method: "POST", url: "/v1/station/maintenance", headers: hdr(t), payload: { attendantId: f.attendantId, ...payload } });
const list = (q = "", t = token) => app.inject({ method: "GET", url: `/v1/station/maintenance${q}`, headers: hdr(t) });

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  f = await makeBranch("MT");
  other = await makeBranch("MU");
  token = (await stationService.login({ branchId: f.branchId, deviceId: "mt", stationPin: "1234" }, { ip: "127.0.0.1" })).stationToken;
  otherToken = (await stationService.login({ branchId: other.branchId, deviceId: "mu", stationPin: "1234" }, { ip: "127.0.0.1" })).stationToken;
  [{ id: machineId }] = await db
    .insert(branchMachines)
    .values({ branchId: f.branchId, name: "Washer 1 (internal)", displayName: "Washer 1", serialNumber: "SN-42", otherDetails: "LG 12kg", washPricePesewas: 3000n })
    .returning({ id: branchMachines.id }) as any;
  [{ id: otherMachineId }] = await db
    .insert(branchMachines)
    .values({ branchId: other.branchId, name: "Elsewhere", washPricePesewas: 3000n })
    .returning({ id: branchMachines.id }) as any;
}, 30_000);
afterAll(async () => {
  await db.delete(maintenanceTickets).where(eq(maintenanceTickets.branchId, f.branchId));
  await db.delete(branchMachines).where(eq(branchMachines.branchId, f.branchId));
  await db.delete(branchMachines).where(eq(branchMachines.branchId, other.branchId));
  await destroyBranch(other);
  await destroyBranch(f);
  await app.close();
});

describe("reporting a fault", () => {
  it("copies the machine's details from our own table, not from the request", async () => {
    const res = await report({ machineId, machineName: "client says something else", faultTypes: ["not_heating", "noise"], description: "loud" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      machineName: "Washer 1 (internal)",
      displayName: "Washer 1",
      serialNumber: "SN-42",
      otherDetails: "LG 12kg",
      faultTypes: ["noise", "not_heating"],
      status: "open",
      duplicate: false,
    });
    expect(res.json().reportedBy).toBeTruthy();
  });

  it("accepts a free-text machine when no machine is picked, and needs one or the other", async () => {
    expect((await report({ machineName: "Generator", faultTypes: ["no_power"] })).statusCode).toBe(200);
    expect((await report({ faultTypes: ["no_power"] })).statusCode).toBe(400);
    expect((await report({ machineName: "X", faultTypes: [] })).statusCode).toBe(400);
  });

  it("refuses another branch's machine, an unknown attendant, and an attendant who is clocked out", async () => {
    expect((await report({ machineId: otherMachineId, faultTypes: ["leak"] })).statusCode).toBe(404);
    expect((await report({ attendantId: "00000000-0000-4000-8000-000000000000", machineName: "X", faultTypes: ["leak"] })).statusCode).toBe(409);
    await db.update(attendanceLogs).set({ clockOutAt: new Date() }).where(eq(attendanceLogs.attendantId, f.attendantId));
    expect((await report({ machineName: "X", faultTypes: ["leak"] })).statusCode).toBe(409);
    await db.update(attendanceLogs).set({ clockOutAt: null }).where(eq(attendanceLogs.attendantId, f.attendantId));
  });

  it("a double tap makes one ticket, even when sent at the same instant", async () => {
    const payload = { machineName: "Dryer 3", faultTypes: ["overheating"] };
    const rs = await Promise.all([report(payload), report(payload), report(payload)]);
    expect(rs.every((r) => r.statusCode === 200)).toBe(true);
    expect(new Set(rs.map((r) => r.json().id)).size).toBe(1);
    expect(rs.filter((r) => !r.json().duplicate)).toHaveLength(1);
    const tickets = (await list()).json().filter((t: any) => t.machineName === "Dryer 3");
    expect(tickets).toHaveLength(1);
  });

  it("a different fault on the same machine is its own ticket", async () => {
    const a = (await report({ machineName: "Dryer 4", faultTypes: ["overheating"] })).json();
    const b = (await report({ machineName: "Dryer 4", faultTypes: ["door_stuck"] })).json();
    expect(a.id).not.toBe(b.id);
  });
});

describe("listing tickets", () => {
  it("shows only this branch's tickets, newest first, and filters by status", async () => {
    const mine = (await list()).json();
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((t: any) => t.branchId === f.branchId)).toBe(true);
    const times = mine.map((t: any) => t.reportedAt);
    expect([...times].sort().reverse()).toEqual(times);
    expect((await list("", otherToken)).json()).toHaveLength(0);

    await db.update(maintenanceTickets).set({ status: "fixed", fixedAt: new Date() }).where(eq(maintenanceTickets.id, mine[0].id));
    expect((await list("?status=fixed")).json().map((t: any) => t.id)).toEqual([mine[0].id]);
    expect((await list("?status=open")).json().find((t: any) => t.id === mine[0].id)).toBeUndefined();
  });

  it("needs a station token", async () => {
    expect((await app.inject({ method: "GET", url: "/v1/station/maintenance" })).statusCode).toBe(401);
  });
});

describe("notices", () => {
  const notices = (t = token) => app.inject({ method: "GET", url: "/v1/station/notices", headers: hdr(t) });
  const future = new Date(Date.now() + 86_400_000);

  it("shows global and this branch's notices, hides expired, deleted and other branches'", async () => {
    const mk = (title: string, v: Partial<typeof headlines.$inferInsert>) =>
      db.insert(headlines).values({ title, expiresAt: future, ...v });
    await mk("MINE", { branchId: f.branchId, priority: "urgent" });
    await mk("OTHER", { branchId: other.branchId });
    await mk("EXPIRED", { branchId: f.branchId, expiresAt: new Date(Date.now() - 1000) });
    await mk("DELETED", { branchId: f.branchId, deletedAt: new Date() });
    const [g] = await db.insert(headlines).values({ title: "GLOBAL_MT", expiresAt: future }).returning();

    const titles = (await notices()).json().map((n: any) => n.title);
    expect(titles).toContain("MINE");
    expect(titles).toContain("GLOBAL_MT");
    for (const hidden of ["OTHER", "EXPIRED", "DELETED"]) expect(titles).not.toContain(hidden);
    expect((await notices()).json().find((n: any) => n.title === "MINE").priority).toBe("urgent");

    const otherTitles = (await notices(otherToken)).json().map((n: any) => n.title);
    expect(otherTitles).toContain("OTHER");
    expect(otherTitles).not.toContain("MINE");
    await db.delete(headlines).where(eq(headlines.id, g!.id));
  });
});
