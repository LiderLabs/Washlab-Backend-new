import { z } from "zod";

export function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.startsWith("233")) return `+233${digits.slice(3)}`;
  if (digits.startsWith("0")) return `+233${digits.slice(1)}`;
  return `+233${digits}`;
}

export const registerCustomerSchema = z.object({
  name: z.string().trim().min(2).max(255),
  phoneNumber: z.string().trim().min(7).max(20),
  email: z.string().trim().email().max(255).optional(),
  branchId: z.string().uuid().optional(),
});

export const updateCustomerProfileSchema = z.object({
  name: z.string().trim().min(2).max(255).optional(),
  phoneNumber: z.string().trim().min(7).max(20).optional(),
  email: z.string().trim().email().max(255).optional(),
  preferredBranchId: z.string().uuid().optional(),
});

export const customerProfileResponseSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  phoneNumber: z.string(),
  email: z.string().nullable(),
  branchId: z.string().uuid().nullable(),
  loyaltyPoints: z.number(),
  isVerified: z.boolean(),
  orderCount: z.number(),
  completedOrderCount: z.number(),
  createdAt: z.string(),
});

export const checkRoleResponseSchema = z.object({
  isAdmin: z.boolean(),
  isAttendant: z.boolean(),
  isCustomer: z.boolean(),
});

export const customerOrderSchema = z.object({
  id: z.string().uuid(),
  orderNumber: z.string(),
  orderType: z.string(),
  serviceType: z.string(),
  status: z.string(),
  paymentStatus: z.string(),
  paymentMethod: z.string().nullable(),
  weightKg: z.number().nullable(),
  itemCount: z.number().nullable(),
  estimatedLoads: z.number().nullable(),
  isDelivery: z.boolean(),
  deliveryAddress: z.string().nullable(),
  deliveryPhone: z.string().nullable(),
  deliveryHall: z.string().nullable(),
  deliveryRoom: z.string().nullable(),
  basePricePesewas: z.number(),
  deliveryFeePesewas: z.number(),
  discountPesewas: z.number(),
  finalPricePesewas: z.number(),
  placedAt: z.string(),
  completedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const customerLoyaltyBalanceSchema = z.object({
  points: z.number(),
  totalEarned: z.number(),
  totalRedeemed: z.number(),
});

export const customerLoyaltyTransactionSchema = z.object({
  id: z.string().uuid(),
  pointsDelta: z.number(),
  balanceAfter: z.number(),
  reason: z.string(),
  orderId: z.string().uuid().nullable(),
  createdAt: z.string(),
});

export const customerNotificationSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  message: z.string(),
  type: z.string(),
  priority: z.string(),
  entityType: z.string().nullable(),
  entityId: z.string().nullable(),
  isRead: z.boolean(),
  readAt: z.string().nullable(),
  createdAt: z.string(),
});

export const customerPaymentSchema = z.object({
  id: z.string().uuid(),
  orderId: z.string().uuid().nullable(),
  orderNumber: z.string().nullable(),
  amountPesewas: z.string(),
  currency: z.string(),
  method: z.string(),
  status: z.string(),
  createdAt: z.string(),
});

export const paginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export type RegisterCustomerInput = z.infer<typeof registerCustomerSchema>;
export type UpdateCustomerProfileInput = z.infer<typeof updateCustomerProfileSchema>;
export type PaginationQuery = z.infer<typeof paginationQuerySchema>;
