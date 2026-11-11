import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { inArray, eq } from "drizzle-orm";

// Fake Clerk: "valid_<id>" verifies as user <id>, anything else is rejected.
vi.mock("@clerk/backend", () => ({
    verifyToken: vi.fn(async (token: string) => {
        if (token.startsWith("valid_")) return { sub: token.slice(6) };
        throw new Error("bad token");
    }),
}));

import { config } from "../config/index.js";
import { db } from "../db/index.js";
import { admins, attendants } from "../db/schema/staff.js";
import { branches } from "../db/schema/branches.js";
import { authenticate } from "./index.js";

if (!config.DATABASE_URL.includes("localhost")) {
    throw new Error("Auth tests must only run against a local database");
}

const run = Date.now().toString(36);
const ids = {
    admin: `test_admin_${run}`,
    active: `test_active_${run}`,
    suspended: `test_suspended_${run}`,
    stranger: `test_stranger_${run}`,
};
let branchId: string;

function fakeRequest(authorization?: string) {
    return { headers: { authorization }, log: { warn: () => { } } } as any;
}

beforeAll(async () => {
    const [branch] = await db
        .insert(branches)
        .values({
            name: "Test Branch",
            code: `T${run}`.slice(0, 32),
            phoneNumber: "0000000000",
            address: "Test",
            city: "Test",
            pricingPerKgPesewas: 1000n,
        })
        .returning({ id: branches.id });
    branchId = branch.id;

    await db.insert(admins).values({
        clerkUserId: ids.admin,
        email: `${ids.admin}@test.local`,
        name: "Test Admin",
        role: "super_admin",
    });
    await db.insert(attendants).values([
        { branchId, clerkUserId: ids.active, name: "Active", email: `${ids.active}@test.local`, phoneNumber: "1", status: "active" },
        { branchId, clerkUserId: ids.suspended, name: "Suspended", email: `${ids.suspended}@test.local`, phoneNumber: "2", status: "suspended" },
    ]);
});

afterAll(async () => {
    await db.delete(attendants).where(inArray(attendants.clerkUserId, [ids.active, ids.suspended]));
    await db.delete(admins).where(eq(admins.clerkUserId, ids.admin));
    await db.delete(branches).where(eq(branches.id, branchId));
});

describe("authenticate", () => {
    it("rejects a missing header", async () => {
        await expect(authenticate(fakeRequest())).rejects.toMatchObject({ statusCode: 401 });
    });

    it("rejects a bad token", async () => {
        await expect(authenticate(fakeRequest("Bearer nonsense"))).rejects.toMatchObject({ statusCode: 401 });
    });

    it("loads super_admin role from the database", async () => {
        const req = fakeRequest(`Bearer valid_${ids.admin}`);
        await authenticate(req);
        expect(req.user.role).toBe("super_admin");
    });

    it("loads an active attendant with their branch", async () => {
        const req = fakeRequest(`Bearer valid_${ids.active}`);
        await authenticate(req);
        expect(req.user).toMatchObject({ role: "attendant", branchId });
    });

    it("blocks a suspended attendant even with a valid token", async () => {
        await expect(authenticate(fakeRequest(`Bearer valid_${ids.suspended}`))).rejects.toMatchObject({
            statusCode: 403,
            code: "ACCOUNT_INACTIVE",
        });
    });

    it("treats an unknown user as a customer", async () => {
        const req = fakeRequest(`Bearer valid_${ids.stranger}`);
        await authenticate(req);
        expect(req.user.role).toBe("customer");
    });
});