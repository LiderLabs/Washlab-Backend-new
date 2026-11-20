import { z } from "zod";

const uuid = z.string().uuid();

export const subscriptionPlanSchema = z.object({
  id: uuid,
  name: z.string(),
  description: z.string().nullable(),
  pricePesewas: z.union([z.number(), z.string()]),
  loadsIncluded: z.number(),
  validityDays: z.number(),
  applicableBranches: z.array(uuid),
  applicableServiceTypes: z.array(z.string()),
  template: z.string().nullable(),
  headline: z.string().nullable(),
  sortOrder: z.number(),
  isActive: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const adminSubscriptionPlanSchema = subscriptionPlanSchema.extend({ soldCount: z.number() });

export const customerSubscriptionSchema = z.object({
  id: uuid,
  code: z.string(),
  customerName: z.string(),
  phoneNumber: z.string(),
  planId: uuid,
  planName: z.string(),
  planPricePesewas: z.union([z.number(), z.string()]),
  loadsTotal: z.number(),
  loadsUsed: z.number(),
  loadsRemaining: z.number(),
  status: z.enum(["pending_payment", "active", "expired", "exhausted", "cancelled"]),
  purchaseBranchId: uuid.nullable(),
  applicableServiceTypes: z.array(z.string()),
  applicableBranches: z.array(uuid),
  source: z.enum(["online", "admin_grant"]),
  paidAt: z.string().nullable(),
  activatedAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  createdAt: z.string(),
  validAtThisBranch: z.boolean().optional(),
});

export const paginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const subscriptionPlansQuerySchema = z.object({ branchId: uuid.optional() });

export const createSubscriptionPlanSchema = z.object({
  name: z.string().trim().min(1).max(255),
  description: z.string().trim().max(2000).optional(),
  pricePesewas: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  loadsIncluded: z.number().int().min(1).max(10000),
  validityDays: z.number().int().min(1).max(3650),
  applicableBranches: z.array(uuid).max(100).optional(),
  applicableServiceTypes: z.array(z.string().trim().min(1).max(64)).max(50).optional(),
  sortOrder: z.number().int().min(-100000).max(100000).optional(),
  isActive: z.boolean().optional(),
  template: z.string().trim().max(64).optional(),
  headline: z.string().trim().max(255).optional(),
});

export const updateSubscriptionPlanSchema = createSubscriptionPlanSchema.partial().refine(
  (value) => Object.keys(value).length > 0,
  "At least one field must be provided"
);

export const buySubscriptionSchema = z.object({
  planId: uuid,
  purchaseBranchId: uuid.optional(),
});

export const buySubscriptionResponseSchema = z.object({
  subscriptionId: uuid,
  reference: z.string().startsWith("SUB-"),
  amountPesewas: z.union([z.number().int().nonnegative(), z.string().regex(/^\d+$/)]),
  email: z.string().nullable(),
  planName: z.string(),
});

export const stationSubscriptionLookupSchema = z.object({ query: z.string().trim().min(1).max(100) });

export const sendSubscriptionOtpSchema = z.object({
  subscriptionId: uuid,
  attendantId: uuid,
  pin: z.string().min(4).max(32),
});

export const sendSubscriptionOtpResponseSchema = z.object({
  success: z.boolean(),
  otpId: uuid,
  expiresAt: z.string(),
  maskedPhone: z.string(),
});

export const redeemSubscriptionSchema = z.object({
  subscriptionId: uuid,
  orderId: uuid,
  otp: z.string().regex(/^\d{4}$/, "OTP must be 4 digits"),
  attendantId: uuid,
  pin: z.string().min(4).max(32),
});

export const redeemSubscriptionResponseSchema = z.object({
  orderNumber: z.string(),
  tokensUsed: z.number(),
  loadsRemaining: z.number(),
  customerName: z.string(),
  phoneNumber: z.string(),
  planName: z.string(),
});

export const subscriptionSuccessSchema = z.object({ success: z.boolean() });

export type CreateSubscriptionPlanInput = z.infer<typeof createSubscriptionPlanSchema>;
export type UpdateSubscriptionPlanInput = z.infer<typeof updateSubscriptionPlanSchema>;
export type ListSubscriptionsQuery = z.infer<typeof paginationQuerySchema>;
