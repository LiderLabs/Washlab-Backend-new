import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Don't let a developer's local .env refill the variables these tests deliberately remove.
vi.mock("dotenv", () => ({ default: { config: () => ({}) } }));

const KEYS = [
  "NODE_ENV", "DATABASE_URL", "REDIS_URL", "CLERK_SECRET_KEY", "CLERK_PUBLISHABLE_KEY", "CLERK_WEBHOOK_SECRET",
  "PAYSTACK_SECRET_KEY", "JWT_SECRET", "CORS_ORIGINS", "TRUST_PROXY_HOPS",
];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  vi.resetModules();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.restoreAllMocks();
  vi.resetModules();
});

const load = () => import("./index.js");

describe("config", () => {
  it("refuses to start when NODE_ENV is missing, instead of quietly using dev secrets", async () => {
    await expect(load()).rejects.toThrow("Invalid application configuration");
  });

  it("production gets no dev fallbacks: a missing variable fails startup", async () => {
    process.env.NODE_ENV = "production";
    await expect(load()).rejects.toThrow("Invalid application configuration");
  });

  it("development and test use the local fallbacks", async () => {
    for (const env of ["development", "test"]) {
      vi.resetModules();
      process.env.NODE_ENV = env;
      const { config } = await load();
      expect(config.DATABASE_URL).toContain("localhost");
      expect(config.PAYSTACK_SECRET_KEY).toContain("mock");
    }
  });

  it("an unknown NODE_ENV is rejected, not treated as development", async () => {
    process.env.NODE_ENV = "staging";
    await expect(load()).rejects.toThrow("Invalid application configuration");
  });

  it("trusts exactly one proxy hop by default, and TRUST_PROXY_HOPS overrides it", async () => {
    process.env.NODE_ENV = "test";
    expect((await load()).config.TRUST_PROXY_HOPS).toBe(1);
    vi.resetModules();
    process.env.TRUST_PROXY_HOPS = "2";
    expect((await load()).config.TRUST_PROXY_HOPS).toBe(2);
  });
});
