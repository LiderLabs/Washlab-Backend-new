import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../platform/db/index.js";
import { attendanceLogs, attendants } from "../../platform/db/schema/staff.js";
import { branches } from "../../platform/db/schema/branches.js";
import { auditLogs } from "../../platform/db/schema/infrastructure.js";
import { buildApp } from "../../app.js";
import { stationService } from "./service.js";
import { adminStaffService } from "../admin/service.js";
import { destroyBranch, makeBranch } from "../cash/test-helpers.js";

let app: Awaited<ReturnType<typeof buildApp>>;
let f: Awaited<ReturnType<typeof makeBranch>>;
let n = 0;
const created: string[] = [];

const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const verify = (token: string) => app.inject({ method: "POST", url: "/v1/station/enrollment/verify", payload: { token } });
const complete = (token: string, pin = "4821") => app.inject({ method: "POST", url: "/v1/station/enrollment/complete", payload: { token, pin } });
const row = async (id: string) => (await db.select().from(attendants).where(eq(attendants.id, id)))[0]!;

/** An invite the way the admin side leaves it: status invited, hashed token, expiry in the future. */
async function invite(over: Partial<typeof attendants.$inferInsert> = {}, hoursLeft = 72) {
  const token = crypto.randomBytes(32).toString("hex");
  const [a] = await db
    .insert(attendants)
    .values({
      branchId: f.branchId,
      name: "New Hire",
      email: `enroll-${Date.now()}-${++n}@example.com`,
      phoneNumber: "0240000000",
      status: "invited",
      enrollmentTokenHash: sha(token),
      enrollmentTokenExpiresAt: new Date(Date.now() + hoursLeft * 3_600_000),
      ...over,
    })
    .returning();
  created.push(a!.id);
  return { token, id: a!.id };
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  f = await makeBranch("EN");
}, 30_000);
afterAll(async () => {
  for (const id of created) await db.delete(auditLogs).where(eq(auditLogs.entityId, id));
  for (const id of created) await db.delete(attendanceLogs).where(eq(attendanceLogs.attendantId, id));
  for (const id of created) await db.delete(attendants).where(eq(attendants.id, id));
  await destroyBranch(f);
  await app.close();
});

describe("verify", () => {
  it("shows who the link is for, and never anything secret", async () => {
    const i = await invite();
    const res = await verify(i.token);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ valid: true, attendant: { id: i.id, name: "New Hire", branchId: f.branchId } });
    expect(JSON.stringify(res.json())).not.toContain(sha(i.token));
  });

  it("gives the same answer for unknown, expired-by-state, removed and closed-branch links", async () => {
    expect((await verify(crypto.randomBytes(32).toString("hex"))).json()).toMatchObject({ valid: false });
    const removed = await invite({ deletedAt: new Date() });
    expect((await verify(removed.token)).json().valid).toBe(false);
    const suspended = await invite({ status: "suspended" });
    expect((await verify(suspended.token)).json().valid).toBe(false);
    const active = await invite({ status: "active" });
    expect((await verify(active.token)).json().valid).toBe(false);
  });

  it("says when a link has expired", async () => {
    const i = await invite({}, -1);
    expect((await verify(i.token)).json()).toEqual({ valid: false, error: "Enrollment token has expired" });
  });

  it("rejects a malformed token before touching the database", async () => {
    expect((await verify("short")).statusCode).toBe(400);
    expect((await verify("z".repeat(64))).statusCode).toBe(400);
  });
});

describe("complete", () => {
  it("sets the PIN (Argon2id, not the PIN itself), activates the attendant and spends the token", async () => {
    const i = await invite();
    const res = await complete(i.token, "4821");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true, attendantId: i.id });
    const a = await row(i.id);
    expect(a.status).toBe("active");
    expect(a.enrolledAt).toBeTruthy();
    expect(a.enrollmentTokenHash).toBeNull();
    expect(a.enrollmentTokenExpiresAt).toBeNull();
    expect(a.passcodeHash).toMatch(/^\$argon2id\$/);
    expect(a.passcodeHash).not.toContain("4821");
    const audit = await db.select().from(auditLogs).where(eq(auditLogs.entityId, i.id));
    expect(audit.map((x) => x.action)).toContain("attendant.pin_setup_complete");
  });

  it("works once: the same link can't set a second PIN", async () => {
    const i = await invite();
    expect((await complete(i.token, "1111")).statusCode).toBe(200);
    const again = await complete(i.token, "2222");
    expect(again.statusCode).toBe(400);
    expect((await verify(i.token)).json().valid).toBe(false);
  });

  it("two simultaneous submits of one link make exactly one success", async () => {
    const i = await invite();
    const rs = await Promise.all([complete(i.token, "1357"), complete(i.token, "2468"), complete(i.token, "9753")]);
    expect(rs.map((r) => r.statusCode).sort()).toEqual([200, 400, 400]);
    expect((await row(i.id)).status).toBe("active");
  });

  it("refuses bad PINs, expired links, and attendants who are no longer waiting to enrol", async () => {
    const i = await invite();
    for (const pin of ["123", "12345", "abcd", "12 4", ""]) expect((await complete(i.token, pin)).statusCode).toBe(400);
    expect((await row(i.id)).status).toBe("invited");

    const expired = await invite({}, -1);
    expect((await complete(expired.token)).statusCode).toBe(400);
    expect((await row(expired.id)).passcodeHash).toBeNull();

    const suspended = await invite({ status: "suspended" });
    expect((await complete(suspended.token)).statusCode).toBe(400);
    expect((await row(suspended.id)).status).toBe("suspended");
  });

  it("refuses when the branch has been closed since the invite", async () => {
    const other = await makeBranch("EO");
    const i = await invite({ branchId: other.branchId });
    await db.update(branches).set({ isActive: false }).where(eq(branches.id, other.branchId));
    expect((await complete(i.token)).statusCode).toBe(400);
    expect((await row(i.id)).status).toBe("invited");
    await db.delete(attendants).where(eq(attendants.id, i.id));
    await destroyBranch(other);
  });

  it("the new attendant can then clock in at the station with that PIN, and not with another", async () => {
    const i = await invite();
    await complete(i.token, "7391");
    const login = await stationService.login({ branchId: f.branchId, deviceId: "en", stationPin: "1234" }, { ip: "127.0.0.1" });
    const clock = (pin: string) =>
      app.inject({
        method: "POST",
        url: "/v1/station/attendance/clock-in",
        headers: { "x-station-token": login.stationToken },
        payload: { attendantId: i.id, pin },
      });
    expect((await clock("0000")).statusCode).toBe(401);
    expect((await clock("7391")).statusCode).toBe(200);
  });
});

describe("end to end with the admin invite", () => {
  it("an invite made by the admin service can be redeemed, and the plain token is never stored", async () => {
    const admin = { id: "00000000-0000-4000-8000-0000000000aa", role: "admin" } as any;
    const made: any = await adminStaffService.createAttendantEnrollment(admin, {
      name: "Round Trip",
      email: `rt-${Date.now()}@example.com`,
      phoneNumber: "0241111111",
      branchId: f.branchId,
    });
    const attendantId = made.attendant?.id ?? made.id ?? made.attendantId;
    created.push(attendantId);
    const token: string = made.enrollmentToken;
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    expect((await row(attendantId)).enrollmentTokenHash).toBe(sha(token));
    expect(JSON.stringify(await row(attendantId))).not.toContain(token);

    expect((await verify(token)).json()).toMatchObject({ valid: true, attendant: { name: "Round Trip" } });
    expect((await complete(token, "6024")).statusCode).toBe(200);
    expect((await row(attendantId)).status).toBe("active");
  });
});
