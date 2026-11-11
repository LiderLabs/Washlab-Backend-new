import argon2 from "argon2";
import crypto from "node:crypto";
import { config } from "../config/index.js";

/**
 * Hash a station PIN or attendant passcode with Argon2id
 */
export async function hashSecret(secret: string): Promise<string> {
  return argon2.hash(secret, {
    type: argon2.argon2id,
    memoryCost: 65536, // 64 MB
    timeCost: 3,
    parallelism: 4,
  });
}

/**
 * Verify a plaintext secret against its Argon2id hash in constant time
 */
export async function verifySecret(hash: string, secret: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, secret);
  } catch {
    return false;
  }
}

/**
 * Constant-time string equality check to prevent timing attacks
 */
export function timingSafeEqualStrings(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Verify Paystack webhook HMAC SHA-512 signature using constant-time comparison
 */
export function verifyPaystackSignature(payload: string, signature: string, secretKey: string): boolean {
  const hmac = crypto.createHmac("sha512", secretKey);
  const expectedSignature = hmac.update(payload).digest("hex");
  return timingSafeEqualStrings(expectedSignature, signature);
}

/**
 * AES-256-GCM Envelope Encryption for Biometric Data
 * Complies with Ghana Data Protection Act 2012 (Act 843)
 */
export function encryptBiometricTemplate(data: unknown): {
  encryptedData: string;
  iv: string;
  authTag: string;
} {
  const key = Buffer.from(config.BIOMETRIC_ENCRYPTION_KEY, "hex");
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);

  const jsonString = JSON.stringify(data);
  let encrypted = cipher.update(jsonString, "utf8", "base64");
  encrypted += cipher.final("base64");

  const authTag = cipher.getAuthTag().toString("base64");

  return {
    encryptedData: encrypted,
    iv: iv.toString("base64"),
    authTag,
  };
}

/**
 * Decrypt AES-256-GCM Biometric Template
 */
export function decryptBiometricTemplate<T = unknown>(encryptedData: string, iv: string, authTag: string): T {
  const key = Buffer.from(config.BIOMETRIC_ENCRYPTION_KEY, "hex");
  const ivBuffer = Buffer.from(iv, "base64");
  const authTagBuffer = Buffer.from(authTag, "base64");

  const decipher = crypto.createDecipheriv("aes-256-gcm", key, ivBuffer);
  decipher.setAuthTag(authTagBuffer);

  let decrypted = decipher.update(encryptedData, "base64", "utf8");
  decrypted += decipher.final("utf8");

  return JSON.parse(decrypted) as T;
}
