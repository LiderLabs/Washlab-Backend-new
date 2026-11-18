import { describe, expect, it } from "vitest";
import { buildApp } from "../app.js";

describe("client IP behind the reverse proxy", () => {
  it("uses the address the proxy added, and ignores one the client made up", async () => {
    const app = await buildApp();
    try {
      app.get("/__ip", async (req) => ({ ip: req.ip }));
      // A client sends its own X-Forwarded-For; the single trusted proxy appends the client's real address after it.
      const res = await app.inject({
        method: "GET",
        url: "/__ip",
        remoteAddress: "10.0.0.5", // the proxy
        headers: { "x-forwarded-for": "6.6.6.6, 203.0.113.9" },
      });
      expect(res.json().ip).toBe("203.0.113.9");
    } finally {
      await app.close();
    }
  });
});
