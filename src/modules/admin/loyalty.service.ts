import crypto from "node:crypto";
import { and, asc, desc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { db } from "../../platform/db/index.js";
import { customers } from "../../platform/db/schema/customers.js";
import { loyaltyLedger, vouchers, voucherUsages } from "../../platform/db/schema/loyalty.js";
import { branches } from "../../platform/db/schema/branches.js";
import { auditLogs } from "../../platform/db/schema/infrastructure.js";
import { BadRequestError, ConflictError, NotFoundError } from "../../platform/errors/index.js";
import type { AuthenticatedUser } from "../../platform/auth/index.js";

type RequestMeta = { ip?: string; userAgent?: string };

async function writeAudit(
  tx: any,
  actor: { id: string; role: string },
  action: string,
  entityType: string,
  entityId: string,
  changes: Record<string, unknown>,
  meta?: RequestMeta
) {
  await tx.insert(auditLogs).values({
    action,
    entityType,
    entityId,
    performedByUserId: actor.id,
    performedByRole: actor.role,
    changes,
    ipAddress: meta?.ip,
    userAgent: meta?.userAgent,
  });
}

function generateVoucherCode(): string {
  return "WL" + crypto.randomBytes(3).toString("hex").toUpperCase();
}

export const adminLoyaltyService = {
  // --- Loyalty Points & Ledger ---
  async getLoyaltyStats() {
    const [totalCust] = await db
      .select({
        totalPoints: sql<string>`sum(${customers.loyaltyPoints})::text`,
        count: sql<number>`count(*)::int`,
      })
      .from(customers)
      .where(isNull(customers.deletedAt));

    const [earnedRows] = await db
      .select({
        totalEarned: sql<string>`sum(case when ${loyaltyLedger.pointsDelta} > 0 then ${loyaltyLedger.pointsDelta} else 0 end)::text`,
        totalRedeemed: sql<string>`sum(case when ${loyaltyLedger.pointsDelta} < 0 then abs(${loyaltyLedger.pointsDelta}) else 0 end)::text`,
      })
      .from(loyaltyLedger);

    const topCustomers = await db
      .select({
        id: customers.id,
        name: customers.name,
        phoneNumber: customers.phoneNumber,
        loyaltyPoints: customers.loyaltyPoints,
      })
      .from(customers)
      .where(isNull(customers.deletedAt))
      .orderBy(desc(customers.loyaltyPoints))
      .limit(10);

    return {
      totalPointsCirculating: Number(totalCust?.totalPoints || 0),
      totalPointsEarned: Number(earnedRows?.totalEarned || 0),
      totalPointsRedeemed: Number(earnedRows?.totalRedeemed || 0),
      customerCount: totalCust?.count ?? 0,
      topCustomers: topCustomers.map((c) => ({
        customerId: c.id,
        _id: c.id,
        name: c.name,
        phoneNumber: c.phoneNumber,
        points: c.loyaltyPoints,
      })),
    };
  },

  async getLoyaltyTransactions(query?: { customerId?: string; limit?: number; offset?: number }) {
    const conditions = [];
    if (query?.customerId) {
      conditions.push(eq(loyaltyLedger.customerId, query.customerId));
    }

    const limit = query?.limit ?? 50;
    const offset = query?.offset ?? 0;

    const rows = await db
      .select({
        id: loyaltyLedger.id,
        customerId: loyaltyLedger.customerId,
        customerName: customers.name,
        customerPhone: customers.phoneNumber,
        orderId: loyaltyLedger.orderId,
        pointsDelta: loyaltyLedger.pointsDelta,
        balanceAfter: loyaltyLedger.balanceAfter,
        reason: loyaltyLedger.reason,
        createdAt: loyaltyLedger.createdAt,
      })
      .from(loyaltyLedger)
      .leftJoin(customers, eq(loyaltyLedger.customerId, customers.id))
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(loyaltyLedger.createdAt))
      .limit(limit)
      .offset(offset);

    return rows.map((r) => ({
      id: r.id,
      _id: r.id,
      customerId: r.customerId,
      customerName: r.customerName ?? "Unknown Customer",
      customerPhone: r.customerPhone ?? "",
      orderId: r.orderId,
      pointsDelta: r.pointsDelta,
      balanceAfter: r.balanceAfter,
      reason: r.reason,
      createdAt: r.createdAt.toISOString(),
    }));
  },

  async adjustLoyaltyPoints(
    actor: AuthenticatedUser,
    input: {
      customerId: string;
      pointsDelta: number;
      reason: string;
    },
    meta?: RequestMeta
  ) {
    const [customer] = await db
      .select()
      .from(customers)
      .where(and(eq(customers.id, input.customerId), isNull(customers.deletedAt)))
      .limit(1);

    if (!customer) throw new NotFoundError("Customer not found", "CUSTOMER_NOT_FOUND");

    const newBalance = customer.loyaltyPoints + input.pointsDelta;
    if (newBalance < 0) {
      throw new BadRequestError("Customer points balance cannot be negative");
    }

    const now = new Date();

    return await db.transaction(async (tx) => {
      await tx
        .update(customers)
        .set({
          loyaltyPoints: newBalance,
          updatedAt: now,
        })
        .where(eq(customers.id, input.customerId));

      const [entry] = await tx
        .insert(loyaltyLedger)
        .values({
          customerId: input.customerId,
          pointsDelta: input.pointsDelta,
          balanceAfter: newBalance,
          reason: input.reason.trim() || "manual_adjustment",
          createdAt: now,
        })
        .returning();

      await writeAudit(
        tx,
        actor,
        "loyalty.points_adjusted",
        "customer",
        input.customerId,
        {
          previousBalance: customer.loyaltyPoints,
          delta: input.pointsDelta,
          newBalance,
          reason: input.reason,
        },
        meta
      );

      return {
        success: true,
        customerId: input.customerId,
        pointsDelta: input.pointsDelta,
        newBalance,
        ledgerId: entry.id,
      };
    });
  },

  // --- Vouchers ---
  async listVouchers(query?: {
    branchId?: string;
    isActive?: boolean;
    search?: string;
    limit?: number;
    offset?: number;
  }) {
    const conditions = [isNull(vouchers.deletedAt)];

    if (query?.branchId) {
      conditions.push(eq(vouchers.branchId, query.branchId));
    }

    if (query?.isActive !== undefined) {
      conditions.push(eq(vouchers.isActive, query.isActive));
    }

    if (query?.search) {
      const s = `%${query.search.trim()}%`;
      conditions.push(sql`${vouchers.code} ILIKE ${s} OR ${vouchers.name} ILIKE ${s}`);
    }

    const limit = query?.limit ?? 100;
    const offset = query?.offset ?? 0;

    const rows = await db
      .select({
        id: vouchers.id,
        code: vouchers.code,
        name: vouchers.name,
        branchId: vouchers.branchId,
        branchName: branches.name,
        discountType: vouchers.discountType,
        discountValue: vouchers.discountValue,
        minOrderAmountPesewas: vouchers.minOrderAmountPesewas,
        maxUsageCount: vouchers.maxUsageCount,
        currentUsageCount: vouchers.currentUsageCount,
        maxUsesPerCustomer: vouchers.maxUsesPerCustomer,
        validFrom: vouchers.validFrom,
        applicableServices: vouchers.applicableServices,
        batchId: vouchers.batchId,
        expiresAt: vouchers.expiresAt,
        isActive: vouchers.isActive,
        createdAt: vouchers.createdAt,
      })
      .from(vouchers)
      .leftJoin(branches, eq(vouchers.branchId, branches.id))
      .where(and(...conditions))
      .orderBy(desc(vouchers.createdAt))
      .limit(limit)
      .offset(offset);

    return rows.map((r) => ({
      id: r.id,
      _id: r.id,
      code: r.code,
      name: r.name,
      branchId: r.branchId,
      branchName: r.branchName ?? "All Branches",
      discountType: r.discountType,
      discountValue:
        r.discountType === "fixed" ? Number(r.discountValue) / 100 : Number(r.discountValue),
      discountValuePesewas: r.discountValue.toString(),
      minOrderAmountGhs: Number(r.minOrderAmountPesewas) / 100,
      minOrderAmountPesewas: r.minOrderAmountPesewas.toString(),
      maxUsageCount: r.maxUsageCount,
      currentUsageCount: r.currentUsageCount,
      maxUsesPerCustomer: r.maxUsesPerCustomer,
      validFrom: r.validFrom ? r.validFrom.toISOString() : null,
      applicableServices: r.applicableServices,
      batchId: r.batchId,
      expiresAt: r.expiresAt ? r.expiresAt.toISOString() : null,
      isActive: r.isActive,
      createdAt: r.createdAt.toISOString(),
    }));
  },

  async createVoucher(
    actor: AuthenticatedUser,
    input: {
      code?: string;
      name?: string;
      branchId?: string;
      discountType: "percentage" | "fixed" | "free_wash";
      discountValue: number;
      minOrderAmount?: number;
      minOrderAmountPesewas?: number;
      maxUsageCount?: number;
      maxUsesPerCustomer?: number;
      validFrom?: string;
      expiresAt?: string;
      applicableServices?: string[];
    },
    meta?: RequestMeta
  ) {
    const code = (input.code?.trim() || generateVoucherCode()).toUpperCase();

    const [existing] = await db
      .select({ id: vouchers.id })
      .from(vouchers)
      .where(and(eq(vouchers.code, code), isNull(vouchers.deletedAt)))
      .limit(1);

    if (existing) throw new ConflictError(`Voucher code "${code}" already exists`, "VOUCHER_CODE_EXISTS");

    const discountValue =
      input.discountType === "fixed"
        ? BigInt(Math.round(input.discountValue * 100))
        : BigInt(input.discountValue);

    const minOrderAmountPesewas = BigInt(
      input.minOrderAmountPesewas ?? (input.minOrderAmount ? Math.round(input.minOrderAmount * 100) : 0)
    );

    return await db.transaction(async (tx) => {
      const [voucher] = await tx
        .insert(vouchers)
        .values({
          code,
          name: input.name?.trim() || null,
          branchId: input.branchId || null,
          discountType: input.discountType,
          discountValue,
          minOrderAmountPesewas,
          maxUsageCount: input.maxUsageCount ?? 1,
          maxUsesPerCustomer: input.maxUsesPerCustomer || null,
          validFrom: input.validFrom ? new Date(input.validFrom) : null,
          expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
          applicableServices: input.applicableServices || null,
          isActive: true,
        })
        .returning();

      await writeAudit(
        tx,
        actor,
        "voucher.created",
        "voucher",
        voucher.id,
        { code: voucher.code, name: voucher.name },
        meta
      );

      return {
        id: voucher.id,
        _id: voucher.id,
        code: voucher.code,
        name: voucher.name,
        branchId: voucher.branchId,
        discountType: voucher.discountType,
        discountValue:
          voucher.discountType === "fixed" ? Number(voucher.discountValue) / 100 : Number(voucher.discountValue),
        discountValuePesewas: voucher.discountValue.toString(),
        minOrderAmountGhs: Number(voucher.minOrderAmountPesewas) / 100,
        maxUsageCount: voucher.maxUsageCount,
        currentUsageCount: voucher.currentUsageCount,
        maxUsesPerCustomer: voucher.maxUsesPerCustomer,
        validFrom: voucher.validFrom ? voucher.validFrom.toISOString() : null,
        expiresAt: voucher.expiresAt ? voucher.expiresAt.toISOString() : null,
        applicableServices: voucher.applicableServices,
        isActive: voucher.isActive,
        createdAt: voucher.createdAt.toISOString(),
      };
    });
  },

  async updateVoucher(
    actor: AuthenticatedUser,
    id: string,
    input: {
      name?: string;
      discountType?: "percentage" | "fixed" | "free_wash";
      discountValue?: number;
      minOrderAmount?: number;
      minOrderAmountPesewas?: number;
      maxUsageCount?: number;
      maxUsesPerCustomer?: number;
      validFrom?: string;
      expiresAt?: string;
      applicableServices?: string[];
      isActive?: boolean;
    },
    meta?: RequestMeta
  ) {
    const [existing] = await db
      .select()
      .from(vouchers)
      .where(and(eq(vouchers.id, id), isNull(vouchers.deletedAt)))
      .limit(1);

    if (!existing) throw new NotFoundError("Voucher not found", "VOUCHER_NOT_FOUND");

    const updates: Partial<typeof vouchers.$inferInsert> = {};
    if (input.name !== undefined) updates.name = input.name.trim();
    if (input.isActive !== undefined) updates.isActive = input.isActive;
    if (input.maxUsageCount !== undefined) updates.maxUsageCount = input.maxUsageCount;
    if (input.maxUsesPerCustomer !== undefined) updates.maxUsesPerCustomer = input.maxUsesPerCustomer;
    if (input.validFrom !== undefined) updates.validFrom = input.validFrom ? new Date(input.validFrom) : null;
    if (input.expiresAt !== undefined) updates.expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
    if (input.applicableServices !== undefined) updates.applicableServices = input.applicableServices;

    if (input.discountValue !== undefined) {
      const type = input.discountType ?? existing.discountType;
      updates.discountValue =
        type === "fixed" ? BigInt(Math.round(input.discountValue * 100)) : BigInt(input.discountValue);
    }
    if (input.discountType !== undefined) updates.discountType = input.discountType;

    if (input.minOrderAmountPesewas !== undefined) {
      updates.minOrderAmountPesewas = BigInt(input.minOrderAmountPesewas);
    } else if (input.minOrderAmount !== undefined) {
      updates.minOrderAmountPesewas = BigInt(Math.round(input.minOrderAmount * 100));
    }

    return await db.transaction(async (tx) => {
      const [updated] = await tx.update(vouchers).set(updates).where(eq(vouchers.id, id)).returning();

      await writeAudit(
        tx,
        actor,
        "voucher.updated",
        "voucher",
        id,
        { previous: existing, updated },
        meta
      );

      return {
        id: updated.id,
        _id: updated.id,
        code: updated.code,
        name: updated.name,
        branchId: updated.branchId,
        discountType: updated.discountType,
        discountValue:
          updated.discountType === "fixed" ? Number(updated.discountValue) / 100 : Number(updated.discountValue),
        discountValuePesewas: updated.discountValue.toString(),
        minOrderAmountGhs: Number(updated.minOrderAmountPesewas) / 100,
        maxUsageCount: updated.maxUsageCount,
        currentUsageCount: updated.currentUsageCount,
        maxUsesPerCustomer: updated.maxUsesPerCustomer,
        validFrom: updated.validFrom ? updated.validFrom.toISOString() : null,
        expiresAt: updated.expiresAt ? updated.expiresAt.toISOString() : null,
        applicableServices: updated.applicableServices,
        isActive: updated.isActive,
        createdAt: updated.createdAt.toISOString(),
      };
    });
  },

  async deleteVoucher(actor: AuthenticatedUser, id: string, meta?: RequestMeta) {
    const [existing] = await db
      .select()
      .from(vouchers)
      .where(and(eq(vouchers.id, id), isNull(vouchers.deletedAt)))
      .limit(1);

    if (!existing) throw new NotFoundError("Voucher not found", "VOUCHER_NOT_FOUND");

    return await db.transaction(async (tx) => {
      await tx.update(vouchers).set({ deletedAt: new Date(), isActive: false }).where(eq(vouchers.id, id));

      await writeAudit(
        tx,
        actor,
        "voucher.deleted",
        "voucher",
        id,
        { code: existing.code },
        meta
      );

      return { success: true, id };
    });
  },

  // --- Voucher Batches ---
  async createVoucherBatch(
    actor: AuthenticatedUser,
    input: {
      count: number;
      value: number; // in GHS
      name?: string;
      validUntil?: string;
      branchId?: string;
      applicableServices?: string[];
    },
    meta?: RequestMeta
  ) {
    if (input.count < 1 || input.count > 200) {
      throw new BadRequestError("Count must be between 1 and 200");
    }
    if (input.value <= 0 || input.value > 1000) {
      throw new BadRequestError("Value must be between 1 and 1000");
    }

    const batchId = "B" + Date.now().toString(36).toUpperCase() + crypto.randomBytes(2).toString("hex").toUpperCase();
    const discountValuePesewas = BigInt(Math.round(input.value * 100));
    const expiresAt = input.validUntil ? new Date(input.validUntil) : null;
    const name = input.name?.trim() || "Gift Voucher";

    const codes: string[] = [];
    const rowsToInsert: (typeof vouchers.$inferInsert)[] = [];

    for (let i = 0; i < input.count; i++) {
      const code = generateVoucherCode();
      codes.push(code);
      rowsToInsert.push({
        code,
        name,
        branchId: input.branchId || null,
        discountType: "fixed",
        discountValue: discountValuePesewas,
        minOrderAmountPesewas: 0n,
        maxUsageCount: 1,
        currentUsageCount: 0,
        maxUsesPerCustomer: 1,
        validFrom: new Date(),
        expiresAt,
        applicableServices: input.applicableServices || ["wash_and_dry"],
        batchId,
        isActive: true,
      });
    }

    return await db.transaction(async (tx) => {
      await tx.insert(vouchers).values(rowsToInsert);

      await writeAudit(
        tx,
        actor,
        "voucher.batch_created",
        "voucher_batch",
        batchId,
        { count: input.count, value: input.value, batchId },
        meta
      );

      return { batchId, count: input.count, codes };
    });
  },

  async listVoucherBatches() {
    const batchRows = await db
      .select({
        batchId: vouchers.batchId,
        name: vouchers.name,
        discountValue: vouchers.discountValue,
        expiresAt: vouchers.expiresAt,
        createdAt: vouchers.createdAt,
        total: sql<number>`count(*)::int`,
        used: sql<number>`sum(case when ${vouchers.currentUsageCount} >= ${vouchers.maxUsageCount} then 1 else 0 end)::int`,
        available: sql<number>`sum(case when ${vouchers.isActive} = true and ${vouchers.currentUsageCount} < ${vouchers.maxUsageCount} then 1 else 0 end)::int`,
      })
      .from(vouchers)
      .where(and(sql`${vouchers.batchId} IS NOT NULL`, isNull(vouchers.deletedAt)))
      .groupBy(vouchers.batchId, vouchers.name, vouchers.discountValue, vouchers.expiresAt, vouchers.createdAt)
      .orderBy(desc(vouchers.createdAt))
      .limit(50);

    return batchRows.map((b) => ({
      batchId: b.batchId!,
      name: b.name ?? "Gift Voucher",
      value: Number(b.discountValue) / 100,
      validUntil: b.expiresAt ? b.expiresAt.toISOString() : null,
      createdAt: b.createdAt.toISOString(),
      total: b.total,
      used: b.used,
      available: b.available,
    }));
  },

  async deactivateVoucherBatch(actor: AuthenticatedUser, batchId: string, meta?: RequestMeta) {
    return await db.transaction(async (tx) => {
      const result = await tx
        .update(vouchers)
        .set({ isActive: false })
        .where(
          and(
            eq(vouchers.batchId, batchId),
            eq(vouchers.isActive, true),
            isNull(vouchers.deletedAt),
            sql`${vouchers.currentUsageCount} < ${vouchers.maxUsageCount}`
          )
        );

      await writeAudit(
        tx,
        actor,
        "voucher.batch_deactivated",
        "voucher_batch",
        batchId,
        { batchId },
        meta
      );

      return { success: true, batchId };
    });
  },
};
