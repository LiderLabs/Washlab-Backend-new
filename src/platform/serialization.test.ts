import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { buildApp } from "../app.js";

let app: Awaited<ReturnType<typeof buildApp>>;
beforeAll(async () => {
  app = await buildApp();
  app.get("/__t/bigint", async () => ({ pesewas: 12345n, nested: [{ v: 5000000000n }], huge: 2n ** 70n }));
  app.get("/__t/schema", { schema: { response: { 200: z.object({ n: z.number() }) } } }, async () => ({ n: 21, secret: "x" }) as any);
  await app.ready();
});
afterAll(async () => {
  await app.close();
});

describe("serialization", () => {
  it("a raw bigint never crashes a response: number when safe, string when it would lose precision", async () => {
    const res = await app.inject({ method: "GET", url: "/__t/bigint" });
    expect(res.statusCode).toBe(200);
    const b = res.json();
    expect(b.pesewas).toBe(12345);
    expect(b.nested[0].v).toBe(5000000000);
    expect(b.huge).toBe((2n ** 70n).toString());
  });

  it("a route's Zod response schema still strips fields it does not declare", async () => {
    const res = await app.inject({ method: "GET", url: "/__t/schema" });
    expect(res.json()).toEqual({ n: 21 });
  });
});
