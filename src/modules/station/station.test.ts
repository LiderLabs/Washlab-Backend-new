import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { config } from "../../platform/config/index.js";
import { db } from "../../platform/db/index.js";
import { branches } from "../../platform/db/schema/branches.js";
import { attendanceLogs, attendantBranches, attendants, stationSessions } from "../../platform/db/schema/staff.js";
import { authenticateStation } from "../../platform/auth/station.js";
import { hashPin, toLegacyPinHash } from "../../platform/crypto/pin.js";
import { buildApp } from "../../app.js";
import { stationService } from "./service.js";

if (!config.DATABASE_URL.includes("localhost")) {
  throw new Error("Station tests must only run against a local database");
}

const run = Date.now().toString(36);
const salt = Buffer.from("station-test-salt").toString("base64");
const legacy = (pin: string) =>
  toLegacyPinHash(crypto.createHash("sha256").update(pin + salt).digest("hex"), salt);

const STATION_PIN = "1234";
const ATT_PIN = "4321";

let b1: string; // main branch (legacy station PIN)
let b2: string; // second branch
let b3: string; // lockout branch
let home: string; // attendant with home = b1
let roamer: string; // home = b2, also allowed at b1
let outsider: string; // home = b2 only
let suspended: string;
const branchIds: string[] = [];
const meta = { ip: "127.0.0.1", userAgent: "vitest" };

async function mkBranch(name: string, pinHash: string | null) {
  const [row] = await db
    .insert(branches)
    .values({
      name: `${name} ${run}`,
      code: `${name[0]}${run}${branchIds.length}`.slice(0, 32),
      phoneNumber: "0000000000",
      address: "Test",
      city: "Test",
      pricingPerKgPesewas: 1000n,
      stationPinHash: pinHash,
    })
    .returning({ id: branches.id });
  branchIds.push(row!.id);
  return row!.id;
}

async function mkAttendant(name: string, branchId: string, status: "active" | "suspended" = "active") {
  const [row] = await db
    .insert(attendants)
    .values({
      branchId,
      name,
      email: `${name}-${run}@test.local`,
      phoneNumber: "1",
      status,
      passcodeHash: await hashPin(ATT_PIN),
    })
    .returning({ id: attendants.id });
  return row!.id;
}

async function loginB1(deviceId = "dev-1") {
  return stationService.login({ branchId: b1, deviceId, stationPin: STATION_PIN }, meta);
}

async function stationFor(token: string, branchId: string) {
  const req: any = { headers: { "x-station-token": token } };
  await authenticateStation(req);
  expect(req.station.branchId).toBe(branchId);
  return req.station as import("../../platform/auth/station.js").StationContext;
}

beforeAll(async () => {
  b1 = await mkBranch("Alpha", legacy(STATION_PIN));
  b2 = await mkBranch("Bravo", await hashPin("5555"));
  b3 = await mkBranch("Charlie", await hashPin("7777"));
  home = await mkAttendant("home", b1);
  roamer = await mkAttendant("roamer", b2);
  outsider = await mkAttendant("outsider", b2);
  suspended = await mkAttendant("suspended", b1, "suspended");
  await db.insert(attendantBranches).values({ attendantId: roamer, branchId: b1 });
}, 30_000);

afterAll(async () => {
  const ids = [home, roamer, outsider, suspended];
  await db.delete(attendanceLogs).where(inArray(attendanceLogs.attendantId, ids));
  await db.delete(attendants).where(inArray(attendants.id, ids));
  await db.delete(branches).where(inArray(branches.id, branchIds));
});

describe("station login", () => {
  it("rejects a wrong PIN and counts the failure", async () => {
    await expect(stationService.login({ branchId: b1, deviceId: "d", stationPin: "0000" }, meta)).rejects.toMatchObject({
      statusCode: 401,
      code: "INVALID_STATION_PIN",
    });
    const [row] = await db.select().from(branches).where(eq(branches.id, b1));
    expect(row!.stationPinFailedAttempts).toBe(1);
  });

  it("accepts a legacy PIN, resets the counter and upgrades the hash to argon2id", async () => {
    const res = await loginB1();
    expect(res.stationToken.length).toBeGreaterThan(30);
    const [row] = await db.select().from(branches).where(eq(branches.id, b1));
    expect(row!.stationPinFailedAttempts).toBe(0);
    expect(row!.stationPinHash!.startsWith("$argon2id$")).toBe(true);
    // new hash still works
    await expect(loginB1("dev-2")).resolves.toBeTruthy();
  }, 30_000);

  it("stores only a hash of the token and authenticates with the raw token", async () => {
    const res = await loginB1("dev-3");
    const rows = await db.select().from(stationSessions).where(eq(stationSessions.id, res.sessionId));
    expect(rows[0]!.sessionTokenHash).not.toBe(res.stationToken);
    await stationFor(res.stationToken, b1);
  });

  it("replaces the previous session when the same device logs in again", async () => {
    const first = await loginB1("dev-replace");
    const second = await loginB1("dev-replace");
    await expect(stationFor(first.stationToken, b1)).rejects.toMatchObject({ statusCode: 401 });
    await stationFor(second.stationToken, b1);
  });

  it("rejects missing and bogus tokens", async () => {
    await expect(authenticateStation({ headers: {} } as any)).rejects.toMatchObject({ statusCode: 401 });
    await expect(authenticateStation({ headers: { "x-station-token": "nope" } } as any)).rejects.toMatchObject({
      statusCode: 401,
    });
  });

  it("logout revokes the session", async () => {
    const res = await loginB1("dev-logout");
    const station = await stationFor(res.stationToken, b1);
    await stationService.logout(station, meta);
    await expect(stationFor(res.stationToken, b1)).rejects.toMatchObject({ statusCode: 401 });
  });

  it("locks the branch after 10 wrong PINs, even for the right PIN", async () => {
    for (let i = 0; i < 10; i++) {
      await expect(
        stationService.login({ branchId: b3, deviceId: "x", stationPin: "0000" }, meta)
      ).rejects.toMatchObject({ code: "INVALID_STATION_PIN" });
    }
    await expect(
      stationService.login({ branchId: b3, deviceId: "x", stationPin: "7777" }, meta)
    ).rejects.toMatchObject({ statusCode: 429, code: "STATION_LOCKED" });
  }, 60_000);
});

describe("attendants and attendance", () => {
  it("lists active attendants for the branch, including ones assigned via attendant_branches", async () => {
    const list = await stationService.listAttendants(b1, { limit: 50, offset: 0 });
    const ids = list.items.map((a) => a.id);
    expect(ids).toContain(home);
    expect(ids).toContain(roamer);
    expect(ids).not.toContain(outsider);
    expect(ids).not.toContain(suspended);
    expect(list.items.find((a) => a.id === home)!.isHomeBranch).toBe(true);
    expect(list.items.find((a) => a.id === roamer)!.isHomeBranch).toBe(false);
  });

  it("clock-in: wrong PIN fails, right PIN works, second clock-in conflicts", async () => {
    const station = await stationFor((await loginB1("dev-att")).stationToken, b1);

    await expect(stationService.clockIn(station, { attendantId: home, pin: "0000" }, meta)).rejects.toMatchObject({
      code: "INVALID_PIN",
    });
    const ok = await stationService.clockIn(station, { attendantId: home, pin: ATT_PIN }, meta);
    expect(ok.attendant.name).toBe("home");

    await expect(stationService.clockIn(station, { attendantId: home, pin: ATT_PIN }, meta)).rejects.toMatchObject({
      statusCode: 409,
      code: "ALREADY_CLOCKED_IN",
    });

    const active = await stationService.activeAttendances(b1, { limit: 50, offset: 0 });
    expect(active.items.map((a) => a.attendantId)).toContain(home);

    await stationService.clockOut(station, { attendanceId: ok.attendanceId, pin: ATT_PIN }, meta);
    expect((await stationService.activeAttendances(b1, { limit: 50, offset: 0 })).items.map((a) => a.attendantId)).not.toContain(home);
    await expect(
      stationService.clockOut(station, { attendanceId: ok.attendanceId, pin: ATT_PIN }, meta)
    ).rejects.toMatchObject({ code: "ATTENDANCE_NOT_FOUND" });
  }, 30_000);

  it("blocks unassigned and suspended attendants", async () => {
    const station = await stationFor((await loginB1("dev-assign")).stationToken, b1);
    await expect(stationService.clockIn(station, { attendantId: outsider, pin: ATT_PIN }, meta)).rejects.toMatchObject({
      code: "ATTENDANT_NOT_ASSIGNED",
    });
    await expect(stationService.clockIn(station, { attendantId: suspended, pin: ATT_PIN }, meta)).rejects.toMatchObject({
      code: "ATTENDANT_NOT_FOUND",
    });
  });

  it("cannot be clocked in at two branches; clock-out is limited to the same branch", async () => {
    const s1 = await stationFor((await loginB1("dev-multi")).stationToken, b1);
    const s2tok = await stationService.login({ branchId: b2, deviceId: "dev-b2", stationPin: "5555" }, meta);
    const s2 = await stationFor(s2tok.stationToken, b2);

    const inAtB1 = await stationService.clockIn(s1, { attendantId: roamer, pin: ATT_PIN }, meta);
    await expect(stationService.clockIn(s2, { attendantId: roamer, pin: ATT_PIN }, meta)).rejects.toMatchObject({
      code: "ALREADY_CLOCKED_IN",
      message: expect.stringContaining("Alpha"),
    });
    // station at b2 cannot clock out a b1 attendance
    await expect(
      stationService.clockOut(s2, { attendanceId: inAtB1.attendanceId, pin: ATT_PIN }, meta)
    ).rejects.toMatchObject({ code: "ATTENDANCE_NOT_FOUND" });
    await stationService.clockOut(s1, { attendanceId: inAtB1.attendanceId, pin: ATT_PIN }, meta);
  }, 30_000);

  it("locks an attendant after 5 wrong PINs", async () => {
    const station = await stationFor((await loginB1("dev-lock")).stationToken, b1);
    for (let i = 0; i < 5; i++) {
      await expect(stationService.clockIn(station, { attendantId: home, pin: "0000" }, meta)).rejects.toMatchObject({
        code: "INVALID_PIN",
      });
    }
    await expect(stationService.clockIn(station, { attendantId: home, pin: ATT_PIN }, meta)).rejects.toMatchObject({
      statusCode: 429,
      code: "ATTENDANT_LOCKED",
    });
  }, 30_000);
});

describe("HTTP wiring", () => {
  it("login -> session -> attendants works end to end and rejects unauthenticated calls", async () => {
    const app = await buildApp();
    try {
      const login = await app.inject({
        method: "POST",
        url: "/v1/station/login",
        payload: { branchId: b2, deviceId: "http-dev", stationPin: "5555" },
      });
      expect(login.statusCode).toBe(200);
      const { stationToken } = login.json();

      const session = await app.inject({
        method: "GET",
        url: "/v1/station/session",
        headers: { "x-station-token": stationToken },
      });
      expect(session.statusCode).toBe(200);
      expect(session.json().branchId).toBe(b2);

      const list = await app.inject({
        method: "GET",
        url: "/v1/station/attendants",
        headers: { "x-station-token": stationToken },
      });
      expect(list.statusCode).toBe(200);
      expect(list.json().map((a: any) => a.id)).toContain(outsider);

      const anon = await app.inject({ method: "GET", url: "/v1/station/attendants" });
      expect(anon.statusCode).toBe(401);

      const bad = await app.inject({
        method: "POST",
        url: "/v1/station/login",
        payload: { branchId: "not-a-uuid", deviceId: "", stationPin: "1" },
      });
      expect(bad.statusCode).toBeGreaterThanOrEqual(400);
      expect(bad.statusCode).toBeLessThan(500);
    } finally {
      await app.close();
    }
  }, 30_000);
});
