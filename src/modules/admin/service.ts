import crypto from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../../platform/db/index.js";
import { admins, attendantBranches, attendants, stationSessions } from "../../platform/db/schema/staff.js";
import { branches } from "../../platform/db/schema/branches.js";
import { auditLogs } from "../../platform/db/schema/infrastructure.js";
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from "../../platform/errors/index.js";
import { config } from "../../platform/config/index.js";
import type { AuthenticatedUser } from "../../platform/auth/index.js";

type RequestMeta = { ip?: string; userAgent?: string };

async function writeAudit(
  tx: any,
  actor: { id: string; role: string },
  action: string,
  entityId: string,
  changes: Record<string, unknown>,
  meta?: RequestMeta
) {
  await tx.insert(auditLogs).values({
    action,
    entityType: "attendant",
    entityId,
    performedByUserId: actor.id,
    performedByRole: actor.role,
    changes,
    ipAddress: meta?.ip,
    userAgent: meta?.userAgent,
  });
}

function generateToken() {
  const plainToken = crypto.randomBytes(32).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(plainToken).digest("hex");
  return { plainToken, tokenHash };
}

export const adminStaffService = {
  async getCurrentAdmin(clerkUserId: string) {
    const [admin] = await db
      .select({
        id: admins.id,
        name: admins.name,
        email: admins.email,
        role: admins.role,
        createdAt: admins.createdAt,
      })
      .from(admins)
      .where(and(eq(admins.clerkUserId, clerkUserId), isNull(admins.deletedAt)))
      .limit(1);

    if (!admin) {
      throw new NotFoundError("Admin account not found", "ADMIN_NOT_FOUND");
    }

    return {
      _id: admin.id,
      id: admin.id,
      name: admin.name,
      email: admin.email,
      role: admin.role,
      createdAt: admin.createdAt.toISOString(),
    };
  },

  async listAttendants(query: { branchId?: string; status?: "invited" | "active" | "suspended" | "locked"; limit?: number; offset?: number }) {
    const conds = [isNull(attendants.deletedAt)];
    if (query.branchId) {
      conds.push(eq(attendants.branchId, query.branchId));
    }
    if (query.status) {
      conds.push(eq(attendants.status, query.status));
    }

    const [rows, countRows] = await Promise.all([
      db
      .select({
        attendant: attendants,
        branch: branches,
      })
      .from(attendants)
      .innerJoin(branches, eq(branches.id, attendants.branchId))
      .where(and(...conds))
      .orderBy(asc(attendants.name))
      .limit(query.limit ?? 50)
      .offset(query.offset ?? 0),
      db.select({ count: sql<number>`count(*)::int` })
        .from(attendants).innerJoin(branches, eq(branches.id, attendants.branchId)).where(and(...conds)),
    ]);

    if (rows.length === 0) return { items: [], total: countRows[0]?.count ?? 0 };

    const attendantIds = rows.map((r) => r.attendant.id);
    const extraBranches = await db
      .select({
        attendantId: attendantBranches.attendantId,
        branchId: attendantBranches.branchId,
      })
      .from(attendantBranches)
      .where(inArray(attendantBranches.attendantId, attendantIds));

    const extraMap = new Map<string, string[]>();
    for (const eb of extraBranches) {
      const list = extraMap.get(eb.attendantId) ?? [];
      list.push(eb.branchId);
      extraMap.set(eb.attendantId, list);
    }

    const items = rows.map((r) => {
      const allBranchIds = Array.from(new Set([r.attendant.branchId, ...(extraMap.get(r.attendant.id) ?? [])]));
      return {
        _id: r.attendant.id,
        id: r.attendant.id,
        name: r.attendant.name,
        email: r.attendant.email,
        phoneNumber: r.attendant.phoneNumber,
        branchId: r.attendant.branchId,
        branchName: r.branch.name,
        branchIds: allBranchIds,
        enrollmentStatus: r.attendant.status,
        status: r.attendant.status,
        consecutiveFailures: r.attendant.failedAttempts,
        failedAttempts: r.attendant.failedAttempts,
        lockedUntil: r.attendant.lockedUntil ? r.attendant.lockedUntil.toISOString() : null,
        enrolledAt: r.attendant.enrolledAt ? r.attendant.enrolledAt.toISOString() : null,
        enrollmentTokenExpiresAt: r.attendant.enrollmentTokenExpiresAt ? r.attendant.enrollmentTokenExpiresAt.toISOString() : null,
        createdAt: r.attendant.createdAt.toISOString(),
        updatedAt: r.attendant.updatedAt.toISOString(),
      };
    });
    return { items, total: countRows[0]?.count ?? 0 };
  },

  async createAttendantEnrollment(
    actor: AuthenticatedUser,
    input: {
      name: string;
      email: string;
      phoneNumber: string;
      branchId: string;
      branchIds?: string[];
      expiresInHours?: number;
    },
    meta?: RequestMeta
  ) {
    const normalizedEmail = input.email.toLowerCase().trim();

    const [branch] = await db
      .select({ id: branches.id, name: branches.name, isActive: branches.isActive })
      .from(branches)
      .where(and(eq(branches.id, input.branchId), isNull(branches.deletedAt)))
      .limit(1);

    if (!branch) {
      throw new NotFoundError("Branch not found", "BRANCH_NOT_FOUND");
    }

    const { plainToken, tokenHash } = generateToken();
    const expiresInHours = input.expiresInHours ?? 72;
    const expiresAt = new Date(Date.now() + expiresInHours * 3600 * 1000);

    const attendant = await db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(attendants)
        .where(eq(attendants.email, normalizedEmail))
        .limit(1);

      let attendantId: string;

      if (existing) {
        if (!existing.deletedAt) {
          throw new ConflictError("An attendant with this email already exists", "ATTENDANT_EXISTS");
        }
        // Reactivate soft-deleted attendant
        const [updated] = await tx
          .update(attendants)
          .set({
            name: input.name.trim(),
            phoneNumber: input.phoneNumber.trim(),
            branchId: input.branchId,
            status: "invited",
            enrollmentTokenHash: tokenHash,
            enrollmentTokenExpiresAt: expiresAt,
            deletedAt: null,
            failedAttempts: 0,
            lockedUntil: null,
            updatedAt: new Date(),
          })
          .where(eq(attendants.id, existing.id))
          .returning();
        attendantId = updated!.id;
      } else {
        const [created] = await tx
          .insert(attendants)
          .values({
            name: input.name.trim(),
            email: normalizedEmail,
            phoneNumber: input.phoneNumber.trim(),
            branchId: input.branchId,
            status: "invited",
            enrollmentTokenHash: tokenHash,
            enrollmentTokenExpiresAt: expiresAt,
            failedAttempts: 0,
          })
          .returning();
        attendantId = created!.id;
      }

      // Additional branch assignments
      if (input.branchIds && input.branchIds.length > 0) {
        await tx.delete(attendantBranches).where(eq(attendantBranches.attendantId, attendantId));
        const toInsert = input.branchIds
          .filter((bId) => bId !== input.branchId)
          .map((bId) => ({ attendantId, branchId: bId }));
        if (toInsert.length > 0) {
          await tx.insert(attendantBranches).values(toInsert);
        }
      }

      await writeAudit(
        tx,
        actor,
        "attendant.enrollment_created",
        attendantId,
        { email: normalizedEmail, name: input.name.trim(), branchId: input.branchId, expiresAt: expiresAt.toISOString() },
        meta
      );

      return attendantId;
    });

    const enrollmentBaseUrl = process.env.ENROLLMENT_BASE_URL || "https://attendant.washlab.app";
    const enrollmentLink = `${enrollmentBaseUrl}/enroll?token=${plainToken}`;

    return {
      attendantId: attendant,
      enrollmentToken: plainToken,
      enrollmentLink,
      expiresAt: expiresAt.toISOString(),
    };
  },

  async resendEnrollmentLink(
    actor: AuthenticatedUser,
    attendantId: string,
    expiresInHours: number = 72,
    meta?: RequestMeta
  ) {
    const [attendant] = await db
      .select()
      .from(attendants)
      .where(and(eq(attendants.id, attendantId), isNull(attendants.deletedAt)))
      .limit(1);

    if (!attendant) {
      throw new NotFoundError("Attendant not found", "ATTENDANT_NOT_FOUND");
    }

    const { plainToken, tokenHash } = generateToken();
    const expiresAt = new Date(Date.now() + expiresInHours * 3600 * 1000);

    await db.transaction(async (tx) => {
      await tx
        .update(attendants)
        .set({
          enrollmentTokenHash: tokenHash,
          enrollmentTokenExpiresAt: expiresAt,
          updatedAt: new Date(),
        })
        .where(eq(attendants.id, attendantId));

      await writeAudit(
        tx,
        actor,
        "attendant.enrollment_link_resent",
        attendantId,
        { email: attendant.email, expiresAt: expiresAt.toISOString() },
        meta
      );
    });

    const enrollmentBaseUrl = process.env.ENROLLMENT_BASE_URL || "https://attendant.washlab.app";
    const enrollmentLink = `${enrollmentBaseUrl}/enroll?token=${plainToken}`;

    return {
      attendantId,
      enrollmentToken: plainToken,
      enrollmentLink,
      expiresAt: expiresAt.toISOString(),
    };
  },

  async updateAttendant(
    actor: AuthenticatedUser,
    attendantId: string,
    input: {
      name?: string;
      email?: string;
      phoneNumber?: string;
      branchId?: string;
      branchIds?: string[];
    },
    meta?: RequestMeta
  ) {
    const [attendant] = await db
      .select()
      .from(attendants)
      .where(and(eq(attendants.id, attendantId), isNull(attendants.deletedAt)))
      .limit(1);

    if (!attendant) {
      throw new NotFoundError("Attendant not found", "ATTENDANT_NOT_FOUND");
    }

    const updates: Partial<typeof attendants.$inferInsert> = { updatedAt: new Date() };
    if (input.name) updates.name = input.name.trim();
    if (input.email) updates.email = input.email.toLowerCase().trim();
    if (input.phoneNumber) updates.phoneNumber = input.phoneNumber.trim();
    if (input.branchId) updates.branchId = input.branchId;

    await db.transaction(async (tx) => {
      await tx.update(attendants).set(updates).where(eq(attendants.id, attendantId));

      if (input.branchIds) {
        await tx.delete(attendantBranches).where(eq(attendantBranches.attendantId, attendantId));
        const effectiveHomeBranch = input.branchId || attendant.branchId;
        const toInsert = input.branchIds
          .filter((bId) => bId !== effectiveHomeBranch)
          .map((bId) => ({ attendantId, branchId: bId }));
        if (toInsert.length > 0) {
          await tx.insert(attendantBranches).values(toInsert);
        }
      }

      await writeAudit(tx, actor, "attendant.updated", attendantId, input, meta);
    });

    return { success: true };
  },

  async updateBranchAccess(
    actor: AuthenticatedUser,
    attendantId: string,
    branchIds: string[],
    meta?: RequestMeta
  ) {
    const [attendant] = await db
      .select()
      .from(attendants)
      .where(and(eq(attendants.id, attendantId), isNull(attendants.deletedAt)))
      .limit(1);

    if (!attendant) {
      throw new NotFoundError("Attendant not found", "ATTENDANT_NOT_FOUND");
    }

    await db.transaction(async (tx) => {
      await tx.delete(attendantBranches).where(eq(attendantBranches.attendantId, attendantId));
      const toInsert = branchIds
        .filter((bId) => bId !== attendant.branchId)
        .map((bId) => ({ attendantId, branchId: bId }));
      if (toInsert.length > 0) {
        await tx.insert(attendantBranches).values(toInsert);
      }

      await writeAudit(tx, actor, "attendant.branch_access_updated", attendantId, { branchIds }, meta);
    });

    return { success: true };
  },

  async activateAttendant(actor: AuthenticatedUser, attendantId: string, meta?: RequestMeta) {
    await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(attendants)
        .set({
          status: "active",
          lockedUntil: null,
          failedAttempts: 0,
          updatedAt: new Date(),
        })
        .where(and(eq(attendants.id, attendantId), isNull(attendants.deletedAt)))
        .returning();

      if (!updated) throw new NotFoundError("Attendant not found", "ATTENDANT_NOT_FOUND");
      await writeAudit(tx, actor, "attendant.activated", attendantId, { status: "active" }, meta);
    });

    return { success: true };
  },

  async suspendAttendant(actor: AuthenticatedUser, attendantId: string, meta?: RequestMeta) {
    await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(attendants)
        .set({
          status: "suspended",
          updatedAt: new Date(),
        })
        .where(and(eq(attendants.id, attendantId), isNull(attendants.deletedAt)))
        .returning();

      if (!updated) throw new NotFoundError("Attendant not found", "ATTENDANT_NOT_FOUND");

      // Revoke all live station sessions for this attendant
      await tx
        .update(stationSessions)
        .set({ revokedAt: new Date() })
        .where(and(eq(stationSessions.attendantId, attendantId), isNull(stationSessions.revokedAt)));

      await writeAudit(tx, actor, "attendant.suspended", attendantId, { status: "suspended" }, meta);
    });

    return { success: true };
  },

  async lockAttendant(actor: AuthenticatedUser, attendantId: string, minutes: number = 1440, reason?: string, meta?: RequestMeta) {
    const lockedUntil = new Date(Date.now() + minutes * 60 * 1000);

    await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(attendants)
        .set({
          status: "locked",
          lockedUntil,
          updatedAt: new Date(),
        })
        .where(and(eq(attendants.id, attendantId), isNull(attendants.deletedAt)))
        .returning();

      if (!updated) throw new NotFoundError("Attendant not found", "ATTENDANT_NOT_FOUND");

      await tx
        .update(stationSessions)
        .set({ revokedAt: new Date() })
        .where(and(eq(stationSessions.attendantId, attendantId), isNull(stationSessions.revokedAt)));

      await writeAudit(tx, actor, "attendant.locked", attendantId, { status: "locked", lockedUntil: lockedUntil.toISOString(), reason }, meta);
    });

    return { success: true };
  },

  async unlockAttendant(actor: AuthenticatedUser, attendantId: string, meta?: RequestMeta) {
    await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(attendants)
        .set({
          status: "active",
          lockedUntil: null,
          failedAttempts: 0,
          updatedAt: new Date(),
        })
        .where(and(eq(attendants.id, attendantId), isNull(attendants.deletedAt)))
        .returning();

      if (!updated) throw new NotFoundError("Attendant not found", "ATTENDANT_NOT_FOUND");
      await writeAudit(tx, actor, "attendant.unlocked", attendantId, { status: "active" }, meta);
    });

    return { success: true };
  },

  async resetAttendantFailures(actor: AuthenticatedUser, attendantId: string, meta?: RequestMeta) {
    await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(attendants)
        .set({
          failedAttempts: 0,
          lockedUntil: null,
          updatedAt: new Date(),
        })
        .where(and(eq(attendants.id, attendantId), isNull(attendants.deletedAt)))
        .returning();

      if (!updated) throw new NotFoundError("Attendant not found", "ATTENDANT_NOT_FOUND");
      await writeAudit(tx, actor, "attendant.failures_reset", attendantId, { failedAttempts: 0 }, meta);
    });

    return { success: true };
  },

  async revokeAttendantSessions(actor: AuthenticatedUser, attendantId: string, meta?: RequestMeta) {
    await db.transaction(async (tx) => {
      await tx
        .update(stationSessions)
        .set({ revokedAt: new Date() })
        .where(and(eq(stationSessions.attendantId, attendantId), isNull(stationSessions.revokedAt)));

      await writeAudit(tx, actor, "attendant.sessions_revoked", attendantId, {}, meta);
    });

    return { success: true };
  },

  async deleteAttendant(actor: AuthenticatedUser, attendantId: string, meta?: RequestMeta) {
    await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(attendants)
        .set({
          deletedAt: new Date(),
          status: "suspended",
          updatedAt: new Date(),
        })
        .where(and(eq(attendants.id, attendantId), isNull(attendants.deletedAt)))
        .returning();

      if (!updated) throw new NotFoundError("Attendant not found", "ATTENDANT_NOT_FOUND");

      await tx
        .update(stationSessions)
        .set({ revokedAt: new Date() })
        .where(and(eq(stationSessions.attendantId, attendantId), isNull(stationSessions.revokedAt)));

      await writeAudit(tx, actor, "attendant.deleted", attendantId, {}, meta);
    });

    return { success: true };
  },
};
