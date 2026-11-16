import crypto from "node:crypto";
import { hashSecret, timingSafeEqualStrings, verifySecret } from "./index.js";

/**
 * PINs migrated from Convex were stored as SHA-256(pin + saltBase64), hex-encoded.
 * We keep them verifiable so nobody has to reset a PIN, then upgrade to Argon2id
 * the first time the right PIN is entered.
 *
 * Accepted stored formats:
 *   $argon2id$...                       (current)
 *   legacy-sha256$<salt>$<hashHex>      (what the import script writes)
 *   <hashHex>:<salt>                    (raw Convex branch.stationPinHash)
 */
const LEGACY_PREFIX = "legacy-sha256$";

export function toLegacyPinHash(hashHex: string, salt: string): string {
  return `${LEGACY_PREFIX}${salt}$${hashHex}`;
}

function parseLegacy(stored: string): { salt: string; hash: string } | null {
  if (stored.startsWith(LEGACY_PREFIX)) {
    const [salt, hash] = stored.slice(LEGACY_PREFIX.length).split("$");
    return salt && hash ? { salt, hash } : null;
  }
  const m = /^([0-9a-f]{64}):(.+)$/.exec(stored);
  return m ? { hash: m[1]!, salt: m[2]! } : null;
}

export type PinCheck = { valid: boolean; needsRehash: boolean };

export async function verifyPin(stored: string | null | undefined, pin: string): Promise<PinCheck> {
  if (!stored) return { valid: false, needsRehash: false };

  if (stored.startsWith("$argon2")) {
    return { valid: await verifySecret(stored, pin), needsRehash: false };
  }

  const legacy = parseLegacy(stored);
  if (!legacy) return { valid: false, needsRehash: false };
  const computed = crypto.createHash("sha256").update(pin + legacy.salt).digest("hex");
  const valid = timingSafeEqualStrings(computed, legacy.hash);
  return { valid, needsRehash: valid };
}

export function hashPin(pin: string): Promise<string> {
  return hashSecret(pin);
}
