import crypto from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../../platform/db/index.js";
import { attendants } from "../../platform/db/schema/staff.js";
import { branches } from "../../platform/db/schema/branches.js";
import { writeAudit } from "../../platform/audit/index.js";
import { hashPin } from "../../platform/crypto/pin.js";
import { BadRequestError } from "../../platform/errors/index.js";

type RequestMeta = { ip?: string; userAgent?: string };

const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

/**
 * The invite an admin created. Anything wrong with it (unknown, used, expired, attendant removed or no longer
 * waiting to enrol, branch closed) comes back as the same kind of answer so a guesser learns nothing.
 */
async function findInvite(token: string, tx: Pick<typeof db, "select"> = db, lock = false) {
  const q = tx
    .select({ attendant: attendants, branchName: branches.name, branchActive: branches.isActive, branchDeleted: branches.deletedAt })
    .from(attendants)
    .innerJoin(branches, eq(branches.id, attendants.branchId))
    .where(and(eq(attendants.enrollmentTokenHash, sha256(token)), isNull(attendants.deletedAt)))
    .limit(1);
  const [row] = lock ? await q.for("update", { of: attendants }) : await q;
  if (!row) return { ok: false as const, error: "Invalid or expired enrollment token" };
  const { attendant } = row;
  if (attendant.status !== "invited") return { ok: false as const, error: "Invalid or expired enrollment token" };
  if (!attendant.enrollmentTokenExpiresAt || attendant.enrollmentTokenExpiresAt.getTime() < Date.now()) {
    return { ok: false as const, error: "Enrollment token has expired" };
  }
  if (!row.branchActive || row.branchDeleted) return { ok: false as const, error: "Branch not found or inactive" };
  return { ok: true as const, attendant, branchName: row.branchName };
}

async function verify(token: string) {
  const r = await findInvite(token);
  if (!r.ok) return { valid: false as const, error: r.error };
  return {
    valid: true as const,
    attendant: {
      id: r.attendant.id,
      name: r.attendant.name,
      email: r.attendant.email,
      branchId: r.attendant.branchId,
      branchName: r.branchName,
    },
    expiresAt: r.attendant.enrollmentTokenExpiresAt!.toISOString(),
  };
}

/** Sets the attendant's PIN and activates them. The token is spent in the same transaction, so it works once. */
async function complete(token: string, pin: string, meta: RequestMeta) {
  const pinHash = await hashPin(pin); // slow, so done before the row lock is taken

  return db.transaction(async (tx) => {
    const r = await findInvite(token, tx, true);
    if (!r.ok) throw new BadRequestError(r.error, "INVALID_ENROLLMENT_TOKEN");

    await tx
      .update(attendants)
      .set({
        passcodeHash: pinHash,
        status: "active",
        enrolledAt: new Date(),
        enrollmentTokenHash: null,
        enrollmentTokenExpiresAt: null,
        failedAttempts: 0,
        lockedUntil: null,
        updatedAt: new Date(),
      })
      .where(eq(attendants.id, r.attendant.id));

    await writeAudit(tx, {
      actorId: r.attendant.id,
      actorRole: "attendant",
      action: "attendant.pin_setup_complete",
      entityType: "attendant",
      entityId: r.attendant.id,
      changes: { branchId: r.attendant.branchId, enrollmentComplete: true },
      ipAddress: meta.ip,
      userAgent: meta.userAgent,
    });

    return { success: true as const, attendantId: r.attendant.id };
  });
}

export const enrollmentService = { verify, complete };
