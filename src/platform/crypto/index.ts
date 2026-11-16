import argon2 from "argon2";
import crypto from "node:crypto";

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
export function verifyPaystackSignature(
  payload: string | Buffer,
  signature: string | undefined,
  secretKey: string,
): boolean {
  if (!signature) return false;
  const hmac = crypto.createHmac("sha512", secretKey);
  const expectedSignature = hmac.update(payload).digest("hex");
  return timingSafeEqualStrings(expectedSignature, signature);
}
