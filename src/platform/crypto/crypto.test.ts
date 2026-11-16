
import { describe, expect, it } from "vitest";
import crypto from "node:crypto";
import {
  decryptBiometricTemplate,
  encryptBiometricTemplate,
  hashSecret,
  timingSafeEqualStrings,
  verifyPaystackSignature,
  verifySecret,
} from "./index.js";

describe("hashSecret / verifySecret", () => {
  it("produces an argon2id hash that verifies with the right secret", async () => {
    const hash = await hashSecret("123456");
    expect(hash.startsWith("$argon2id$")).toBe(true);
    expect(await verifySecret(hash, "123456")).toBe(true);
  });

  it("rejects a wrong secret", async () => {
    const hash = await hashSecret("123456");
    expect(await verifySecret(hash, "654321")).toBe(false);
  });

  it("returns false for a malformed hash instead of throwing", async () => {
    expect(await verifySecret("not-a-hash", "123456")).toBe(false);
  });

  it("salts: same secret gives different hashes", async () => {
    const a = await hashSecret("123456");
    const b = await hashSecret("123456");
    expect(a).not.toBe(b);
  });
});

describe("timingSafeEqualStrings", () => {
  it("matches equal strings", () => {
    expect(timingSafeEqualStrings("abc", "abc")).toBe(true);
  });

  it("rejects different strings and different lengths", () => {
    expect(timingSafeEqualStrings("abc", "abd")).toBe(false);
    expect(timingSafeEqualStrings("abc", "abcd")).toBe(false);
  });
});

describe("verifyPaystackSignature", () => {
  const secret = "sk_test_mock_paystack";
  const body = JSON.stringify({
    event: "charge.success",
    data: { amount: 5000 },
  });

  const sign = (p: string | Buffer, s = secret) =>
    crypto.createHmac("sha512", s).update(p).digest("hex");

  it("accepts a valid signature over a string body", () => {
    expect(verifyPaystackSignature(body, sign(body), secret)).toBe(true);
  });

  it("accepts a valid signature over a raw Buffer body", () => {
    const raw = Buffer.from(body, "utf8");
    expect(verifyPaystackSignature(raw, sign(raw), secret)).toBe(true);
  });

  it("rejects a missing signature", () => {
    expect(verifyPaystackSignature(body, undefined, secret)).toBe(false);
    expect(verifyPaystackSignature(body, "", secret)).toBe(false);
  });

  it("rejects a tampered body", () => {
    const sig = sign(body);
    expect(
      verifyPaystackSignature(body.replace("5000", "9999"), sig, secret)
    ).toBe(false);
  });

  it("rejects a signature made with the wrong secret", () => {
    expect(
      verifyPaystackSignature(body, sign(body, "other_secret"), secret)
    ).toBe(false);
  });

  it("rejects a garbage signature of the wrong length", () => {
    expect(verifyPaystackSignature(body, "deadbeef", secret)).toBe(false);
  });
});

describe("biometric encryption (AES-256-GCM)", () => {
  const template = { fingerprint: [1, 2, 3], label: "right-index" };

  it("round-trips data", () => {
    const { encryptedData, iv, authTag } = encryptBiometricTemplate(template);
    expect(decryptBiometricTemplate(encryptedData, iv, authTag)).toEqual(template);
  });

  it("uses a fresh IV each time", () => {
    const a = encryptBiometricTemplate(template);
    const b = encryptBiometricTemplate(template);
    expect(a.iv).not.toBe(b.iv);
    expect(a.encryptedData).not.toBe(b.encryptedData);
  });

  it("fails when the ciphertext is tampered with", () => {
    const { encryptedData, iv, authTag } = encryptBiometricTemplate(template);
    const buf = Buffer.from(encryptedData, "base64");
    buf[0] = buf[0]! ^ 0xff;

    expect(() =>
      decryptBiometricTemplate(buf.toString("base64"), iv, authTag)
    ).toThrow();
  });

  it("fails when the auth tag is tampered with", () => {
    const { encryptedData, iv, authTag } = encryptBiometricTemplate(template);
    const tag = Buffer.from(authTag, "base64");
    tag[0] = tag[0]! ^ 0xff;

    expect(() =>
      decryptBiometricTemplate(encryptedData, iv, tag.toString("base64"))
    ).toThrow();
  });
});
