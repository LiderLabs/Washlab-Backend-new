import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { hashPin, toLegacyPinHash, verifyPin } from "./pin.js";

// Same recipe the Convex backend used: SHA-256(pin + saltBase64), hex.
const salt = Buffer.from("0123456789abcdef").toString("base64");
const legacyHex = (pin: string) => crypto.createHash("sha256").update(pin + salt).digest("hex");

describe("verifyPin", () => {
  it("verifies an argon2id hash and does not ask for a rehash", async () => {
    const stored = await hashPin("4321");
    expect(await verifyPin(stored, "4321")).toEqual({ valid: true, needsRehash: false });
    expect((await verifyPin(stored, "0000")).valid).toBe(false);
  });

  it("verifies the legacy-sha256 format and asks for a rehash", async () => {
    const stored = toLegacyPinHash(legacyHex("1234"), salt);
    expect(await verifyPin(stored, "1234")).toEqual({ valid: true, needsRehash: true });
    expect(await verifyPin(stored, "1235")).toEqual({ valid: false, needsRehash: false });
  });

  it("verifies the raw Convex hash:salt format (branch station PINs)", async () => {
    const stored = `${legacyHex("9999")}:${salt}`;
    expect((await verifyPin(stored, "9999")).valid).toBe(true);
    expect((await verifyPin(stored, "9998")).valid).toBe(false);
  });

  it("rejects missing or malformed hashes without throwing", async () => {
    expect((await verifyPin(null, "1234")).valid).toBe(false);
    expect((await verifyPin("", "1234")).valid).toBe(false);
    expect((await verifyPin("garbage", "1234")).valid).toBe(false);
    expect((await verifyPin("legacy-sha256$onlysalt", "1234")).valid).toBe(false);
  });
});
