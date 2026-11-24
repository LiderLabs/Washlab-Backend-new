import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

vi.mock("@clerk/backend", () => ({
  verifyToken: vi.fn(async (token: string) => {
    if (token.startsWith("valid_")) return { sub: token.slice(6) };
    throw new Error("bad token");
  }),
}));

import { db } from "./db/index.js";
import { admins, attendants } from "./db/schema/staff.js";
import { buildApp } from "../app.js";
import { makeBranch, destroyBranch } from "../modules/cash/test-helpers.js";

/**
 * Every route in the API, found from the live route table, must refuse a caller with no credentials, except the
 * ones listed here. A route added later that forgets its guard fails this test until it is fixed or deliberately
 * added below with a reason.
 */
const PUBLIC: Record<string, string> = {
  "GET /healthz": "liveness probe",
  "GET /readyz": "readiness probe",
  "POST /v1/payments/webhooks/paystack": "Paystack calls it; protected by the HMAC signature",
  "POST /v1/station/login": "a tablet logs in with the branch station PIN (rate limited, lockout)",
  "GET /v1/station/branches": "branch picker on the tablet's login screen",
  "GET /v1/station/branches/by-code/:code": "branch lookup on the tablet's login screen",
  "POST /v1/station/enrollment/verify": "invited attendant opens their link; token is 256 random bits",
  "POST /v1/station/enrollment/complete": "invited attendant sets a PIN with that token",
  "GET /v1/branches": "public branch list for the booking page",
  "GET /v1/branches/": "public branch list for the booking page",
  "GET /v1/branches/by-code/:code": "public branch lookup",
  "GET /v1/branches/:id": "public branch lookup",
  "GET /v1/branches/:id/services": "public price list for a branch",
  "GET /v1/services": "public service catalogue",
  "GET /v1/services/": "public service catalogue",
  "GET /v1/services/branch/:branchId": "public price list for a branch",
  "GET /v1/vouchers/validate": "checkout promo check (rate limited 20/min)",
  "POST /v1/vouchers/validate": "checkout promo check (rate limited 20/min)",
  "POST /v1/orders/online": "guest checkout is allowed (optional auth, rate limited 20/min)",
  "GET /v1/customer/subscriptions/plans": "public plan catalogue",
  "GET /v1/customer/subscriptions/promo-images": "public promo banners",
  "POST /v1/customer/subscriptions/guest-buy": "guest checkout (rate limited 10/min)",
  "POST /v1/customer/subscriptions/verify": "verifies a Paystack reference server-side, idempotent (rate limited 20/min)",
  "GET /v1/orders/track/:orderNumber": "public tracking page (rate limited 30/min)",
};

type R = { method: string; path: string };

function listRoutes(tree: string): R[] {
  const out: R[] = [];
  const stack: string[] = [];
  for (const line of tree.split("\n")) {
    const m = line.match(/^([│ ]*)(?:├|└)── (.+?)(?: \(([A-Z, ]+)\))?$/);
    if (!m) continue;
    const depth = m[1].length / 4;
    stack.length = depth;
    stack[depth] = m[2];
    const path = stack.join("").replace(/\/+/g, "/");
    if (!m[3]) continue;
    for (const method of m[3].split(",").map((x) => x.trim())) {
      if (method === "HEAD" || method === "OPTIONS") continue;
      if (path.startsWith("/docs")) continue;
      out.push({ method, path });
    }
  }
  return out;
}

const concrete = (p: string) =>
  (p === "/v1/events/stream" ? p + "?channels=branch:x" : p).replace(/:(\w*[iI]d|batchId)\b/g, "00000000-0000-4000-8000-000000000000").replace(/:[a-zA-Z]+/g, "x1");

let app: Awaited<ReturnType<typeof buildApp>>;
let routes: R[];
const run = Date.now().toString(36);

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  routes = listRoutes(app.printRoutes({ commonPrefix: false, includeMeta: false }));
}, 30_000);
afterAll(async () => {
  await app.close();
});

describe("route guards", () => {
  it("finds the routes (sanity: parser works and covers every module)", () => {
    expect(routes.length).toBeGreaterThan(150);
    for (const prefix of ["/v1/admin/", "/v1/station/", "/v1/customers/", "/v1/orders", "/v1/branches", "/v1/vouchers", "/v1/services"]) {
      expect(routes.some((r) => r.path.startsWith(prefix))).toBe(true);
    }
  });

  it("every route refuses a caller with no credentials, except the reviewed public list", async () => {
    const open: string[] = [];
    for (const r of routes) {
      const key = `${r.method} ${r.path}`;
      const res = await app.inject({ method: r.method as any, url: concrete(r.path) });
      if (res.statusCode !== 401 && !(key in PUBLIC)) open.push(`${key} -> ${res.statusCode}`);
    }
    expect(open).toEqual([]);
  }, 60_000);

  it("the public list only names routes that exist (no stale entries)", () => {
    const keys = new Set(routes.map((r) => `${r.method} ${r.path}`));
    expect(Object.keys(PUBLIC).filter((k) => !keys.has(k) && !k.includes("/healthz") && !k.includes("/readyz"))).toEqual([]);
  });

  it("a garbage bearer token or station token is refused everywhere that needs one", async () => {
    const bad: string[] = [];
    for (const r of routes) {
      const key = `${r.method} ${r.path}`;
      if (key in PUBLIC) continue;
      for (const headers of [{ authorization: "Bearer nonsense" }, { "x-station-token": "nonsense" }]) {
        const res = await app.inject({ method: r.method as any, url: concrete(r.path), headers });
        if (res.statusCode !== 401) bad.push(`${key} ${Object.keys(headers)[0]} -> ${res.statusCode}`);
      }
    }
    expect(bad).toEqual([]);
  }, 120_000);
});

describe("role boundaries", () => {
  let f: Awaited<ReturnType<typeof makeBranch>>;
  const ids = { customer: `cust_${run}`, att: `att_${run}`, admin: `adm_${run}` };
  const as = (id: string) => ({ authorization: `Bearer valid_${id}` });

  beforeAll(async () => {
    f = await makeBranch("RB");
    await db.insert(attendants).values({ branchId: f.branchId, clerkUserId: ids.att, name: "RB Att", email: `${ids.att}@t.local`, phoneNumber: "1", status: "active" });
    await db.insert(admins).values({ clerkUserId: ids.admin, email: `${ids.admin}@t.local`, name: "RB Admin", role: "admin" });
  }, 30_000);
  afterAll(async () => {
    await db.delete(attendants).where(eq(attendants.clerkUserId, ids.att));
    await db.delete(admins).where(eq(admins.clerkUserId, ids.admin));
    await destroyBranch(f);
  });

  it("no admin route is reachable by a customer or an attendant (403, never data)", async () => {
    const leaks: string[] = [];
    for (const r of routes.filter((x) => x.path.startsWith("/v1/admin/"))) {
      for (const who of [ids.customer, ids.att]) {
        const res = await app.inject({ method: r.method as any, url: concrete(r.path), headers: as(who) });
        if (res.statusCode !== 403) leaks.push(`${r.method} ${r.path} as ${who.split("_")[0]} -> ${res.statusCode}`);
      }
    }
    expect(leaks).toEqual([]);
  }, 120_000);

  it("branch create/update/delete refuse a customer and an attendant", async () => {
    const leaks: string[] = [];
    for (const r of routes.filter((x) => x.path.startsWith("/v1/branches") && x.method !== "GET")) {
      for (const who of [ids.customer, ids.att]) {
        const res = await app.inject({ method: r.method as any, url: concrete(r.path), headers: as(who), payload: {} });
        if (res.statusCode !== 403) leaks.push(`${r.method} ${r.path} as ${who.split("_")[0]} -> ${res.statusCode}`);
      }
    }
    expect(leaks).toEqual([]);
  });

  it("a Clerk bearer token is not accepted on station routes, and a station token is not accepted on admin or customer routes", async () => {
    const wrong: string[] = [];
    for (const r of routes.filter((x) => x.path.startsWith("/v1/station/") && !(`${x.method} ${x.path}` in PUBLIC))) {
      const res = await app.inject({ method: r.method as any, url: concrete(r.path), headers: as(ids.admin) });
      if (res.statusCode !== 401) wrong.push(`${r.method} ${r.path} with admin bearer -> ${res.statusCode}`);
    }
    for (const r of routes.filter((x) => x.path.startsWith("/v1/admin/") || x.path.startsWith("/v1/customers/"))) {
      const res = await app.inject({ method: r.method as any, url: concrete(r.path), headers: { "x-station-token": "a".repeat(64) } });
      if (res.statusCode !== 401) wrong.push(`${r.method} ${r.path} with station token -> ${res.statusCode}`);
    }
    expect(wrong).toEqual([]);
  }, 120_000);
});
