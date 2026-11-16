import { z } from "zod";

export const ORDER_STATUSES = [
  "pending_dropoff",
  "checked_in",
  "sorting",
  "washing",
  "drying",
  "folding",
  "ready_for_pickup",
  "out_for_delivery",
  "delivered",
  "completed",
  "cancelled",
] as const;
export const orderStatusSchema = z.enum(ORDER_STATUSES);
export const orderTypeSchema = z.enum(["walk_in", "online"]);

/** Bag cards are numbered; the old app padded to 3 digits ("007"), so "7" and "007" are the same bag. */
export const bagNumberSchema = z
  .string()
  .trim()
  .regex(/^\d{1,6}$/, "Bag number must be digits only")
  .transform((v) => v.padStart(3, "0"));

const attendantId = z.string().uuid();
const loads = z.number().int().min(0).max(50);
const weight = z.number().positive().max(500);

export const customerSearchQuery = z.object({
  q: z.string().trim().min(2).max(64),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const createCustomerSchema = z.object({
  name: z.string().trim().min(1).max(255),
  phoneNumber: z.string().trim().min(7).max(20),
  email: z.string().email().max(255).optional(),
});

export const walkInOrderSchema = z.object({
  attendantId,
  customerId: z.string().uuid(),
  serviceType: z.string().trim().min(1).max(64),
  weightKg: weight,
  bagNumber: bagNumberSchema,
  itemCount: z.number().int().min(1).max(1000).optional(),
  whitesSeparate: z.boolean().optional(),
  notes: z.string().max(1000).optional(),
  isDelivery: z.boolean().optional(),
  deliveryAddress: z.string().max(500).optional(),
  deliveryPhone: z.string().max(32).optional(),
  deliveryHall: z.string().max(100).optional(),
  deliveryRoom: z.string().max(50).optional(),
  extraWashLoads: loads.optional(),
  extraDryLoads: loads.optional(),
  machineId: z.string().uuid().optional(),
});

export const checkInSchema = z.object({
  attendantId,
  weightKg: weight,
  bagNumber: bagNumberSchema,
  itemCount: z.number().int().min(1).max(1000).optional(),
  notes: z.string().max(1000).optional(),
  serviceType: z.string().trim().min(1).max(64).optional(),
  extraWashLoads: loads.optional(),
  extraDryLoads: loads.optional(),
  machineId: z.string().uuid().optional(),
});

export const updateOrderSchema = z.object({
  attendantId,
  serviceType: z.string().trim().min(1).max(64).optional(),
  weightKg: weight.optional(),
  extraWashLoads: loads.optional(),
  extraDryLoads: loads.optional(),
  bagNumber: bagNumberSchema.optional(),
  notes: z.string().max(1000).optional(),
  whitesSeparate: z.boolean().optional(),
});

export const updateStatusSchema = z.object({
  attendantId,
  status: orderStatusSchema,
  notes: z.string().max(500).optional(),
});

export const cancelOrderSchema = z.object({
  attendantId,
  reason: z.string().max(500).optional(),
});

export const listOrdersQuery = z.object({
  status: orderStatusSchema.optional(),
  orderType: orderTypeSchema.optional(),
  search: z.string().trim().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  cursor: z.string().max(200).optional(),
});

export const orderIdParams = z.object({ id: z.string().uuid() });

// ----- responses (money is integer pesewas; safe far beyond any real order total) -----

export const customerRefSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  phoneNumber: z.string(),
  email: z.string().nullable(),
});

export const stationOrderSchema = z.object({
  id: z.string().uuid(),
  orderNumber: z.string(),
  orderType: orderTypeSchema,
  status: orderStatusSchema,
  serviceType: z.string(),
  bagNumber: z.string().nullable(),
  weightKg: z.number().nullable(),
  itemCount: z.number().nullable(),
  estimatedLoads: z.number().nullable(),
  extraWashLoads: z.number(),
  extraDryLoads: z.number(),
  whitesSeparate: z.boolean(),
  notes: z.string().nullable(),
  isDelivery: z.boolean(),
  deliveryAddress: z.string().nullable(),
  deliveryPhone: z.string().nullable(),
  deliveryHall: z.string().nullable(),
  deliveryRoom: z.string().nullable(),
  machineId: z.string().uuid().nullable(),
  basePricePesewas: z.number(),
  deliveryFeePesewas: z.number(),
  discountPesewas: z.number(),
  finalPricePesewas: z.number(),
  paymentStatus: z.string(),
  paymentMethod: z.string().nullable(),
  createdByAttendantId: z.string().uuid().nullable(),
  placedAt: z.string(),
  checkedInAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  updatedAt: z.string(),
  customer: customerRefSchema,
});

export const orderListResponseSchema = z.object({
  items: z.array(stationOrderSchema),
  nextCursor: z.string().nullable(),
});

export const orderDetailSchema = stationOrderSchema.extend({
  history: z.array(
    z.object({
      fromStatus: z.string().nullable(),
      toStatus: z.string(),
      changedBy: z.object({ type: z.string(), name: z.string().nullable() }),
      notes: z.string().nullable(),
      createdAt: z.string(),
    })
  ),
  payments: z.array(
    z.object({
      id: z.string().uuid(),
      method: z.string(),
      status: z.string(),
      amountPesewas: z.number(),
      paidAt: z.string().nullable(),
    })
  ),
});

export const customerResultSchema = customerRefSchema.extend({
  orderCount: z.number(),
  completedOrderCount: z.number(),
});

export type WalkInOrderInput = z.infer<typeof walkInOrderSchema>;
export type CheckInInput = z.infer<typeof checkInSchema>;
export type UpdateOrderInput = z.infer<typeof updateOrderSchema>;
export type UpdateStatusInput = z.infer<typeof updateStatusSchema>;
export type CancelOrderInput = z.infer<typeof cancelOrderSchema>;
export type ListOrdersQuery = z.infer<typeof listOrdersQuery>;
