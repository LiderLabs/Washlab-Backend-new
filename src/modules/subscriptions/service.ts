import crypto from "node:crypto";
import { and, asc, desc, eq, gt, isNull, lt, or, sql } from "drizzle-orm";
import { db } from "../../platform/db/index.js";
import { customers } from "../../platform/db/schema/customers.js";
import { orders } from "../../platform/db/schema/orders.js";
import { payments } from "../../platform/db/schema/payments.js";
import { admins } from "../../platform/db/schema/staff.js";
import {
  customerSubscriptions,
  subscriptionOtps,
  subscriptionPlans,
} from "../../platform/db/schema/subscriptions.js";
import { subscriptionUsages } from "../../platform/db/schema/subscription-usages.js";
import { AppError, BadRequestError, ConflictError, NotFoundError } from "../../platform/errors/index.js";
import { hashSecret, verifySecret } from "../../platform/crypto/index.js";
import { writeAudit } from "../../platform/audit/index.js";
import { broadcastRealtimeEvent } from "../../platform/realtime/index.js";
import { normalizePhone } from "../customers/schemas.js";
import type { StationContext } from "../../platform/auth/station.js";
import type {
  CreateSubscriptionPlanInput,
  ListSubscriptionsQuery,
  UpdateSubscriptionPlanInput,
} from "./schemas.js";

const OTP_TTL_MS = 5 * 60 * 1000;
const MAX_OTP_ATTEMPTS = 5;
const MAX_OTP_REQUESTS_PER_HOUR = 5;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

type EffectiveStatus = "pending_payment" | "active" | "expired" | "exhausted" | "cancelled";

function randomCode(length: number) {
  return Array.from({ length }, () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join("");
}

function randomReference() {
  return `SUB-${Date.now()}-${randomCode(10)}`;
}

function effectiveStatus(sub: typeof customerSubscriptions.$inferSelect, now: Date): EffectiveStatus {
  if (sub.status !== "active") return sub.status;
  if (sub.expiresAt && sub.expiresAt < now) return "expired";
  if (sub.loadsTotal - sub.loadsUsed <= 0) return "exhausted";
  return "active";
}

function maskPhone(phone: string) {
  if (phone.length < 8) return phone;
  return `${phone.slice(0, 4)}•••••${phone.slice(-3)}`;
}

function moneyValue(amount: bigint): number | string {
  const asNumber = Number(amount);
  return Number.isSafeInteger(asNumber) ? asNumber : amount.toString();
}

function toSubscriptionDto(sub: typeof customerSubscriptions.$inferSelect, now = new Date()) {
  return {
    id: sub.id,
    code: sub.code,
    customerName: sub.customerName,
    phoneNumber: sub.phoneNumber,
    planId: sub.planId,
    planName: sub.planName,
    planPricePesewas: moneyValue(sub.planPricePesewas),
    loadsTotal: sub.loadsTotal,
    loadsUsed: sub.loadsUsed,
    loadsRemaining: Math.max(0, sub.loadsTotal - sub.loadsUsed),
    status: effectiveStatus(sub, now),
    purchaseBranchId: sub.purchaseBranchId,
    applicableServiceTypes: sub.applicableServiceTypes ?? [],
    applicableBranches: sub.applicableBranches ?? [],
    source: sub.source,
    paidAt: sub.paidAt?.toISOString() ?? null,
    activatedAt: sub.activatedAt?.toISOString() ?? null,
    expiresAt: sub.expiresAt?.toISOString() ?? null,
    createdAt: sub.createdAt.toISOString(),
  };
}

function toPlanDto(plan: typeof subscriptionPlans.$inferSelect) {
  return {
    id: plan.id,
    name: plan.name,
    description: plan.description,
    pricePesewas: moneyValue(plan.pricePesewas),
    loadsIncluded: plan.loadsIncluded,
    validityDays: plan.validityDays,
    applicableBranches: plan.applicableBranches ?? [],
    applicableServiceTypes: plan.applicableServiceTypes ?? [],
    template: plan.template,
    headline: plan.headline,
    sortOrder: plan.sortOrder,
    isActive: plan.isActive,
    createdAt: plan.createdAt.toISOString(),
    updatedAt: plan.updatedAt.toISOString(),
  };
}

function validatePlan(input: Partial<CreateSubscriptionPlanInput>) {
  if (input.name !== undefined && !input.name.trim()) {
    throw new BadRequestError("Plan name is required", "INVALID_SUBSCRIPTION_PLAN");
  }
  if (input.pricePesewas !== undefined && !Number.isSafeInteger(input.pricePesewas)) {
    throw new BadRequestError("Price must be a whole number of pesewas", "INVALID_SUBSCRIPTION_PLAN");
  }
  if (input.loadsIncluded !== undefined && (!Number.isInteger(input.loadsIncluded) || input.loadsIncluded < 1)) {
    throw new BadRequestError("Loads included must be a whole number of at least 1", "INVALID_SUBSCRIPTION_PLAN");
  }
  if (input.validityDays !== undefined && (!Number.isInteger(input.validityDays) || input.validityDays < 1)) {
    throw new BadRequestError("Validity must be a whole number of days (at least 1)", "INVALID_SUBSCRIPTION_PLAN");
  }
}

function availableAtBranch(branchIds: string[] | null, branchId?: string | null) {
  return !branchId || !branchIds?.length || branchIds.includes(branchId);
}

function requireActiveSubscription(sub: typeof customerSubscriptions.$inferSelect, now: Date) {
  const status = effectiveStatus(sub, now);
  if (status !== "active") {
    throw new ConflictError(`Subscription is ${status}`, "SUBSCRIPTION_NOT_ACTIVE");
  }
}

async function findCustomer(clerkUserId: string) {
  const [customer] = await db
    .select()
    .from(customers)
    .where(and(eq(customers.clerkUserId, clerkUserId), isNull(customers.deletedAt)))
    .limit(1);
  if (!customer) throw new NotFoundError("Customer profile not found. Please register first.", "CUSTOMER_NOT_FOUND");
  return customer;
}

export const subscriptionService = {
  async listPlans(options: { activeOnly: boolean; branchId?: string }) {
    const conditions = [isNull(subscriptionPlans.deletedAt)];
    if (options.activeOnly) conditions.push(eq(subscriptionPlans.isActive, true));

    const plans = await db
      .select()
      .from(subscriptionPlans)
      .where(and(...conditions))
      .orderBy(asc(subscriptionPlans.sortOrder), asc(subscriptionPlans.pricePesewas), asc(subscriptionPlans.createdAt));

    return plans
      .filter((plan) => availableAtBranch(plan.applicableBranches, options.branchId))
      .map(toPlanDto);
  },

  async createPlan(adminId: string, input: CreateSubscriptionPlanInput, meta: { ip?: string; userAgent?: string }) {
    validatePlan(input);
    const [admin] = await db
      .select({ id: admins.id })
      .from(admins)
      .where(and(eq(admins.id, adminId), isNull(admins.deletedAt)))
      .limit(1);
    if (!admin) throw new NotFoundError("Admin account not found", "ADMIN_NOT_FOUND");

    const now = new Date();
    const [plan] = await db
      .insert(subscriptionPlans)
      .values({
        name: input.name.trim(),
        description: input.description?.trim() || null,
        pricePesewas: BigInt(input.pricePesewas),
        loadsIncluded: input.loadsIncluded,
        validityDays: input.validityDays,
        applicableBranches: input.applicableBranches?.length ? input.applicableBranches : null,
        applicableServiceTypes: input.applicableServiceTypes?.length ? input.applicableServiceTypes : null,
        template: input.template?.trim() || null,
        headline: input.headline?.trim() || null,
        sortOrder: input.sortOrder ?? 0,
        isActive: input.isActive ?? true,
        createdByAdminId: admin.id,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    await writeAudit(db, {
      actorId: admin.id,
      actorRole: "admin",
      action: "subscription_plan.created",
      entityType: "subscription_plan",
      entityId: plan!.id,
      changes: { name: plan!.name, pricePesewas: plan!.pricePesewas.toString(), loadsIncluded: plan!.loadsIncluded },
      ...meta,
    });
    return toPlanDto(plan!);
  },

  async updatePlan(adminId: string, planId: string, input: UpdateSubscriptionPlanInput, meta: { ip?: string; userAgent?: string }) {
    validatePlan(input);
    const [admin] = await db
      .select({ id: admins.id })
      .from(admins)
      .where(and(eq(admins.id, adminId), isNull(admins.deletedAt)))
      .limit(1);
    if (!admin) throw new NotFoundError("Admin account not found", "ADMIN_NOT_FOUND");

    const [existing] = await db
      .select()
      .from(subscriptionPlans)
      .where(and(eq(subscriptionPlans.id, planId), isNull(subscriptionPlans.deletedAt)))
      .limit(1);
    if (!existing) throw new NotFoundError("Subscription plan not found", "SUBSCRIPTION_PLAN_NOT_FOUND");

    const patch: Partial<typeof subscriptionPlans.$inferInsert> = { updatedAt: new Date() };
    if (input.name !== undefined) patch.name = input.name.trim();
    if (input.description !== undefined) patch.description = input.description.trim() || null;
    if (input.pricePesewas !== undefined) patch.pricePesewas = BigInt(input.pricePesewas);
    if (input.loadsIncluded !== undefined) patch.loadsIncluded = input.loadsIncluded;
    if (input.validityDays !== undefined) patch.validityDays = input.validityDays;
    if (input.applicableBranches !== undefined) patch.applicableBranches = input.applicableBranches.length ? input.applicableBranches : null;
    if (input.applicableServiceTypes !== undefined) patch.applicableServiceTypes = input.applicableServiceTypes.length ? input.applicableServiceTypes : null;
    if (input.sortOrder !== undefined) patch.sortOrder = input.sortOrder;
    if (input.isActive !== undefined) patch.isActive = input.isActive;
    if (input.template !== undefined) patch.template = input.template.trim() || null;
    if (input.headline !== undefined) patch.headline = input.headline.trim() || null;

    const [updated] = await db
      .update(subscriptionPlans)
      .set(patch)
      .where(eq(subscriptionPlans.id, planId))
      .returning();
    await writeAudit(db, {
      actorId: admin.id,
      actorRole: "admin",
      action: "subscription_plan.updated",
      entityType: "subscription_plan",
      entityId: planId,
      changes: input as Record<string, unknown>,
      ...meta,
    });
    return toPlanDto(updated!);
  },

  async deletePlan(adminId: string, planId: string, meta: { ip?: string; userAgent?: string }) {
    const [admin] = await db
      .select({ id: admins.id })
      .from(admins)
      .where(and(eq(admins.id, adminId), isNull(admins.deletedAt)))
      .limit(1);
    if (!admin) throw new NotFoundError("Admin account not found", "ADMIN_NOT_FOUND");

    const [plan] = await db
      .select({ id: subscriptionPlans.id })
      .from(subscriptionPlans)
      .where(and(eq(subscriptionPlans.id, planId), isNull(subscriptionPlans.deletedAt)))
      .limit(1);
    if (!plan) throw new NotFoundError("Subscription plan not found", "SUBSCRIPTION_PLAN_NOT_FOUND");

    const now = new Date();
    await db
      .update(subscriptionPlans)
      .set({ isActive: false, deletedAt: now, updatedAt: now })
      .where(eq(subscriptionPlans.id, planId));
    await writeAudit(db, {
      actorId: admin.id,
      actorRole: "admin",
      action: "subscription_plan.deleted",
      entityType: "subscription_plan",
      entityId: planId,
      ...meta,
    });
    return { success: true };
  },

  async adminPlans(adminId: string) {
    const [admin] = await db
      .select({ id: admins.id })
      .from(admins)
      .where(and(eq(admins.id, adminId), isNull(admins.deletedAt)))
      .limit(1);
    if (!admin) throw new NotFoundError("Admin account not found", "ADMIN_NOT_FOUND");

    const rows = await db
      .select({
        plan: subscriptionPlans,
        soldCount: sql<number>`count(${customerSubscriptions.id})::int`,
      })
      .from(subscriptionPlans)
      .leftJoin(
        customerSubscriptions,
        and(
          eq(customerSubscriptions.planId, subscriptionPlans.id),
          eq(customerSubscriptions.status, "active"),
          isNull(customerSubscriptions.deletedAt)
        )
      )
      .where(isNull(subscriptionPlans.deletedAt))
      .groupBy(subscriptionPlans.id)
      .orderBy(asc(subscriptionPlans.sortOrder), asc(subscriptionPlans.createdAt));
    return rows.map(({ plan, soldCount }) => ({ ...toPlanDto(plan), soldCount }));
  },

  async adminActiveSubscriptions(adminId: string, query: ListSubscriptionsQuery) {
    const [admin] = await db
      .select({ id: admins.id })
      .from(admins)
      .where(and(eq(admins.id, adminId), isNull(admins.deletedAt)))
      .limit(1);
    if (!admin) throw new NotFoundError("Admin account not found", "ADMIN_NOT_FOUND");

    const now = new Date();
    const conditions = [
      isNull(customerSubscriptions.deletedAt),
      eq(customerSubscriptions.status, "active"),
      lt(customerSubscriptions.loadsUsed, customerSubscriptions.loadsTotal),
      or(isNull(customerSubscriptions.expiresAt), gt(customerSubscriptions.expiresAt, now))!,
    ];
    const [rows, countRows] = await Promise.all([
      db
        .select()
        .from(customerSubscriptions)
        .where(and(...conditions))
        .orderBy(desc(customerSubscriptions.createdAt))
        .limit(query.limit)
        .offset(query.offset),
      db.select({ count: sql<number>`count(*)::int` }).from(customerSubscriptions).where(and(...conditions)),
    ]);
    return { items: rows.map((sub) => toSubscriptionDto(sub, now)), total: countRows[0]?.count ?? 0 };
  },

  async buy(clerkUserId: string, planId: string, purchaseBranchId?: string) {
    const customer = await findCustomer(clerkUserId);
    const [plan] = await db
      .select()
      .from(subscriptionPlans)
      .where(and(eq(subscriptionPlans.id, planId), eq(subscriptionPlans.isActive, true), isNull(subscriptionPlans.deletedAt)))
      .limit(1);
    if (!plan) throw new NotFoundError("Plan is not available", "SUBSCRIPTION_PLAN_NOT_FOUND");

    const branchId = purchaseBranchId ?? customer.branchId;
    if (!availableAtBranch(plan.applicableBranches, branchId)) {
      throw new BadRequestError("This plan is not available at the selected branch", "SUBSCRIPTION_BRANCH_UNAVAILABLE");
    }

    const now = new Date();
    const reference = randomReference();
    const code = `WL-${randomCode(6)}`;
    const [sub] = await db
      .insert(customerSubscriptions)
      .values({
        customerId: customer.id,
        phoneNumber: normalizePhone(customer.phoneNumber),
        customerName: customer.name,
        planId: plan.id,
        planName: plan.name,
        planPricePesewas: plan.pricePesewas,
        loadsTotal: plan.loadsIncluded,
        loadsUsed: 0,
        validityDays: plan.validityDays,
        applicableServiceTypes: plan.applicableServiceTypes,
        applicableBranches: plan.applicableBranches,
        purchaseBranchId: branchId,
        code,
        status: "pending_payment",
        source: "online",
        paymentReference: reference,
        email: customer.email,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return {
      subscriptionId: sub!.id,
      reference,
      amountPesewas: moneyValue(plan.pricePesewas),
      email: customer.email,
      planName: plan.name,
    };
  },

  async mySubscriptions(clerkUserId: string) {
    const customer = await findCustomer(clerkUserId);
    const rows = await db
      .select()
      .from(customerSubscriptions)
      .where(
        and(
          isNull(customerSubscriptions.deletedAt),
          or(eq(customerSubscriptions.customerId, customer.id), eq(customerSubscriptions.phoneNumber, normalizePhone(customer.phoneNumber)))
        )
      )
      .orderBy(desc(customerSubscriptions.createdAt));
    const now = new Date();
    return rows
      .filter((sub) => sub.status !== "pending_payment")
      .map((sub) => toSubscriptionDto(sub, now));
  },

  async lookup(station: StationContext, rawQuery: string) {
    const raw = rawQuery.trim();
    if (!raw) return [];
    const digits = raw.replace(/\D/g, "");
    const hasLetters = /[a-z]/i.test(raw);
    const conditions = [
      isNull(customerSubscriptions.deletedAt),
      sql`${customerSubscriptions.status} <> 'pending_payment'`,
    ];

    let rows: (typeof customerSubscriptions.$inferSelect)[];
    if (hasLetters || digits.length === 6) {
      const clean = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
      const codeBody = clean.startsWith("WL") ? clean.slice(2) : clean;
      rows = await db
        .select()
        .from(customerSubscriptions)
        .where(and(...conditions, eq(customerSubscriptions.code, `WL-${codeBody}`)))
        .limit(1);
    } else if (digits.length >= 9) {
      rows = await db
        .select()
        .from(customerSubscriptions)
        .where(and(...conditions, eq(customerSubscriptions.phoneNumber, normalizePhone(raw))))
        .orderBy(desc(customerSubscriptions.createdAt))
        .limit(10);
    } else {
      return [];
    }

    const now = new Date();
    return rows.map((sub) => ({
      ...toSubscriptionDto(sub, now),
      phoneNumber: maskPhone(sub.phoneNumber),
      validAtThisBranch: availableAtBranch(sub.applicableBranches, station.branchId),
    }));
  },

  async sendOtp(station: StationContext, subscriptionId: string, attendantId: string) {
    const now = new Date();
    const otpCode = String(crypto.randomInt(1000, 10000));
    const codeHash = await hashSecret(otpCode);

    const result = await db.transaction(async (tx) => {
      const [sub] = await tx
        .select()
        .from(customerSubscriptions)
        .where(and(eq(customerSubscriptions.id, subscriptionId), isNull(customerSubscriptions.deletedAt)))
        .for("update")
        .limit(1);
      if (!sub) throw new NotFoundError("Subscription not found", "SUBSCRIPTION_NOT_FOUND");
      requireActiveSubscription(sub, now);
      if (!availableAtBranch(sub.applicableBranches, station.branchId)) {
        throw new BadRequestError("This subscription is not valid at this branch", "SUBSCRIPTION_BRANCH_UNAVAILABLE");
      }

      const [requestCount] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(subscriptionOtps)
        .where(
          and(
            eq(subscriptionOtps.subscriptionId, sub.id),
            gt(subscriptionOtps.createdAt, new Date(now.getTime() - 60 * 60 * 1000))
          )
        );
      if ((requestCount?.count ?? 0) >= MAX_OTP_REQUESTS_PER_HOUR) {
        throw new AppError("Too many verification requests. Try again later.", 429, "SUBSCRIPTION_OTP_RATE_LIMIT");
      }

      await tx
        .update(subscriptionOtps)
        .set({ status: "expired" })
        .where(and(eq(subscriptionOtps.subscriptionId, sub.id), eq(subscriptionOtps.status, "pending")));
      const expiresAt = new Date(now.getTime() + OTP_TTL_MS);
      const [otp] = await tx
        .insert(subscriptionOtps)
        .values({
          subscriptionId: sub.id,
          phoneNumber: sub.phoneNumber,
          branchId: station.branchId,
          requestedByAttendantId: attendantId,
          codeHash,
          attempts: 0,
          status: "pending",
          expiresAt,
          createdAt: now,
        })
        .returning({ id: subscriptionOtps.id });
      await writeAudit(tx, {
        actorId: attendantId,
        actorRole: "attendant",
        action: "subscription.otp_requested",
        entityType: "customer_subscription",
        entityId: sub.id,
        changes: { branchId: station.branchId, otpId: otp!.id },
      });
      return {
        otpId: otp!.id,
        expiresAt: expiresAt.toISOString(),
        maskedPhone: maskPhone(sub.phoneNumber),
      };
    });

    return { ...result, otpCode };
  },

  async redeem(
    station: StationContext,
    input: { subscriptionId: string; orderId: string; otp: string; attendantId: string }
  ) {
    const now = new Date();
    const outcome = await db.transaction(async (tx) => {
      const [sub] = await tx
        .select()
        .from(customerSubscriptions)
        .where(and(eq(customerSubscriptions.id, input.subscriptionId), isNull(customerSubscriptions.deletedAt)))
        .for("update")
        .limit(1);
      if (!sub) throw new NotFoundError("Subscription not found", "SUBSCRIPTION_NOT_FOUND");

      const [otp] = await tx
        .select()
        .from(subscriptionOtps)
        .where(
          and(
            eq(subscriptionOtps.subscriptionId, sub.id),
            eq(subscriptionOtps.branchId, station.branchId),
            eq(subscriptionOtps.status, "pending")
          )
        )
        .orderBy(desc(subscriptionOtps.createdAt))
        .for("update")
        .limit(1);
      if (!otp) return { error: "OTP_NOT_FOUND" as const };
      if (otp.expiresAt <= now) {
        await tx.update(subscriptionOtps).set({ status: "expired" }).where(eq(subscriptionOtps.id, otp.id));
        return { error: "OTP_EXPIRED" as const };
      }
      if (otp.attempts >= MAX_OTP_ATTEMPTS) {
        await tx.update(subscriptionOtps).set({ status: "locked" }).where(eq(subscriptionOtps.id, otp.id));
        return { error: "OTP_LOCKED" as const };
      }
      if (!(await verifySecret(otp.codeHash, input.otp.trim()))) {
        const attempts = otp.attempts + 1;
        await tx
          .update(subscriptionOtps)
          .set({ attempts, status: attempts >= MAX_OTP_ATTEMPTS ? "locked" : "pending" })
          .where(eq(subscriptionOtps.id, otp.id));
        return { error: attempts >= MAX_OTP_ATTEMPTS ? ("OTP_LOCKED" as const) : ("OTP_INVALID" as const) };
      }

      requireActiveSubscription(sub, now);
      if (!availableAtBranch(sub.applicableBranches, station.branchId)) {
        throw new BadRequestError("This subscription is not valid at this branch", "SUBSCRIPTION_BRANCH_UNAVAILABLE");
      }

      const [order] = await tx
        .select()
        .from(orders)
        .where(and(eq(orders.id, input.orderId), isNull(orders.deletedAt)))
        .for("update")
        .limit(1);
      if (!order) throw new NotFoundError("Order not found", "ORDER_NOT_FOUND");
      if (order.branchId !== station.branchId) {
        throw new BadRequestError("Order belongs to another branch", "ORDER_BRANCH_MISMATCH");
      }
      if (order.paymentStatus === "paid") throw new ConflictError("Order is already paid", "ORDER_ALREADY_PAID");
      if (order.status === "cancelled") throw new ConflictError("Order is cancelled", "ORDER_CANCELLED");

      const [orderCustomer] = await tx
        .select({ phoneNumber: customers.phoneNumber })
        .from(customers)
        .where(eq(customers.id, order.customerId))
        .limit(1);
      if (!orderCustomer || normalizePhone(orderCustomer.phoneNumber) !== normalizePhone(sub.phoneNumber)) {
        throw new BadRequestError("This order does not belong to the subscription holder", "SUBSCRIPTION_ORDER_MISMATCH");
      }
      if (sub.applicableServiceTypes?.length && !sub.applicableServiceTypes.includes(order.serviceType)) {
        throw new BadRequestError("This subscription does not cover that service", "SUBSCRIPTION_SERVICE_MISMATCH");
      }

      const baseLoads = order.estimatedLoads ?? 1;
      const extraWash = order.extraWashLoads;
      const extraDry = order.extraDryLoads;
      if (baseLoads < 1 || extraWash < 0 || extraDry < 0) {
        throw new BadRequestError("Invalid order load quantities", "INVALID_ORDER_LOADS");
      }
      const tokens = baseLoads + extraWash + extraDry;
      const remaining = sub.loadsTotal - sub.loadsUsed;
      if (tokens > remaining) {
        throw new ConflictError(`This needs ${tokens} load(s) but only ${remaining} remain`, "INSUFFICIENT_SUBSCRIPTION_LOADS");
      }

      const loadsRemainingAfter = remaining - tokens;
      await tx
        .update(customerSubscriptions)
        .set({ loadsUsed: sub.loadsUsed + tokens, updatedAt: now })
        .where(eq(customerSubscriptions.id, sub.id));
      await tx
        .update(subscriptionOtps)
        .set({ status: "used", usedAt: now })
        .where(eq(subscriptionOtps.id, otp.id));
      await tx
        .update(payments)
        .set({ status: "failed", updatedAt: now })
        .where(and(eq(payments.orderId, order.id), eq(payments.status, "pending")));
      await tx
        .update(orders)
        .set({
          finalPricePesewas: 0n,
          paymentStatus: "paid",
          paymentMethod: "subscription",
          subscriptionId: sub.id,
          subscriptionLoadsUsed: tokens,
          updatedAt: now,
        })
        .where(eq(orders.id, order.id));
      await tx.insert(payments).values({
        orderId: order.id,
        branchId: order.branchId,
        customerId: order.customerId,
        amountPesewas: 0n,
        currency: "GHS",
        method: "subscription",
        status: "paid",
        processedByAttendantId: input.attendantId,
        paidAt: now,
        createdAt: now,
        updatedAt: now,
        metadata: { subscriptionId: sub.id, loadsUsed: tokens },
      });
      await tx.insert(subscriptionUsages).values({
        subscriptionId: sub.id,
        orderId: order.id,
        branchId: station.branchId,
        attendantId: input.attendantId,
        loadsUsed: tokens,
        extraWash,
        extraDry,
        loadsRemainingAfter,
        usedAt: now,
      });
      await writeAudit(tx, {
        actorId: input.attendantId,
        actorRole: "attendant",
        action: "subscription.redeemed",
        entityType: "subscription",
        entityId: sub.id,
        changes: {
          orderId: order.id,
          orderNumber: order.orderNumber,
          loadsUsed: tokens,
          loadsRemainingAfter,
        },
      });

      return {
        orderId: order.id,
        orderNumber: order.orderNumber,
        branchId: order.branchId,
        tokensUsed: tokens,
        loadsRemaining: loadsRemainingAfter,
        customerName: sub.customerName,
        phoneNumber: sub.phoneNumber,
        planName: sub.planName,
      };
    });

    if ("error" in outcome) {
      if (outcome.error === "OTP_EXPIRED") throw new ConflictError("OTP has expired", "SUBSCRIPTION_OTP_EXPIRED");
      if (outcome.error === "OTP_LOCKED") throw new ConflictError("OTP is locked", "SUBSCRIPTION_OTP_LOCKED");
      if (outcome.error === "OTP_INVALID") throw new BadRequestError("OTP is invalid", "SUBSCRIPTION_OTP_INVALID");
      throw new NotFoundError("No pending OTP was found for this subscription at this branch", "SUBSCRIPTION_OTP_NOT_FOUND");
    }

    void broadcastRealtimeEvent(`branch:${outcome.branchId}`, "order.updated", {
      orderId: outcome.orderId,
      paymentStatus: "paid",
    });
    return {
      orderNumber: outcome.orderNumber,
      tokensUsed: outcome.tokensUsed,
      loadsRemaining: outcome.loadsRemaining,
      customerName: outcome.customerName,
      phoneNumber: outcome.phoneNumber,
      planName: outcome.planName,
    };
  },

};
