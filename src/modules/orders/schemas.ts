import { z } from "zod";

export const deliveryOptionEnum = z.enum([
  "dropoff_self",
  "dropoff_delivery",
  "pickup_self",
  "full_service",
]);

export const createOnlineOrderSchema = z.object({
  branchId: z.string().uuid(),
  serviceType: z.string().trim().min(1).max(64),
  estimatedWeight: z.number().positive().max(500),
  itemCount: z.number().int().min(1).max(1000).optional(),
  estimatedLoads: z.number().int().min(1).max(50).optional(),
  whitesSeparate: z.boolean().optional(),
  notes: z.string().max(1000).optional(),
  isDelivery: z.boolean().default(false),
  deliveryOption: deliveryOptionEnum.optional(),
  deliveryAddress: z.string().max(500).optional(),
  deliveryPhone: z.string().max(32).optional(),
  deliveryHall: z.string().max(100).optional(),
  deliveryRoom: z.string().max(50).optional(),
  voucherCode: z.string().max(32).optional(),
  // Customer details (required if guest; used as override/update if authenticated)
  customerName: z.string().trim().min(1).max(255),
  customerPhoneNumber: z.string().trim().min(7).max(20),
  customerEmail: z.string().trim().email().max(255).optional(),
});

export const trackOrderResponseSchema = z.object({
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
  branch: z.object({
    id: z.string().uuid(),
    name: z.string(),
    code: z.string(),
    phoneNumber: z.string(),
    address: z.string(),
    city: z.string(),
  }),
  customer: z.object({
    id: z.string().uuid(),
    name: z.string(),
    phoneNumber: z.string(),
  }),
  history: z.array(
    z.object({
      fromStatus: z.string().nullable(),
      toStatus: z.string(),
      notes: z.string().nullable(),
      createdAt: z.string(),
    })
  ),
});

export const orderListQuerySchema = z.object({
  branchId: z.string().uuid().optional(),
  status: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
});

export const orderListResponseSchema = z.object({
  items: z.array(
    z.object({
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
      finalPricePesewas: z.number(),
      placedAt: z.string(),
      customer: z.object({
        id: z.string().uuid(),
        name: z.string(),
        phoneNumber: z.string(),
      }),
    })
  ),
  nextCursor: z.string().nullable(),
  limit: z.number(),
});

export type CreateOnlineOrderInput = z.infer<typeof createOnlineOrderSchema>;
export type OrderListQuery = z.infer<typeof orderListQuerySchema>;
