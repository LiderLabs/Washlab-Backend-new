import { z } from "zod";

const pin = z.string().min(4).max(32);

export const stationLoginSchema = z.object({
  branchId: z.string().uuid(),
  deviceId: z.string().min(1).max(128),
  stationPin: pin,
  deviceInfo: z.string().max(255).optional(),
});

export const stationLoginResponseSchema = z.object({
  stationToken: z.string(),
  sessionId: z.string().uuid(),
  branchId: z.string().uuid(),
  branchName: z.string(),
  expiresAt: z.string(),
});

export const stationSessionResponseSchema = z.object({
  sessionId: z.string().uuid(),
  branchId: z.string().uuid(),
  branchName: z.string(),
  deviceId: z.string(),
  expiresAt: z.string(),
});

export const stationAttendantSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  isHomeBranch: z.boolean(),
  activeAttendance: z
    .object({
      id: z.string().uuid(),
      branchId: z.string().uuid(),
      branchName: z.string(),
      clockInAt: z.string(),
    })
    .nullable(),
});

export const activeAttendanceSchema = z.object({
  attendanceId: z.string().uuid(),
  attendantId: z.string().uuid(),
  attendantName: z.string(),
  clockInAt: z.string(),
});

export const clockInSchema = z.object({
  attendantId: z.string().uuid(),
  pin,
});

export const clockOutSchema = z.object({
  attendanceId: z.string().uuid(),
  pin,
});

export const attendanceResultSchema = z.object({
  success: z.boolean(),
  attendant: z.object({ name: z.string() }),
  attendanceId: z.string().uuid(),
});

export const stationInfoResponseSchema = z.object({
  branchId: z.string().uuid(),
  branchName: z.string(),
  code: z.string(),
  address: z.string(),
  city: z.string(),
  phoneNumber: z.string(),
  email: z.string().nullable(),
  pricingPerKgPesewas: z.string(),
  deliveryFeePesewas: z.string(),
  terminalId: z.string().nullable(),
  deviceId: z.string(),
  loggedInAt: z.string(),
});

export const stationStatsQuerySchema = z.object({
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
});

export const stationStatsResponseSchema = z.object({
  totalOrders: z.number(),
  totalRevenuePesewas: z.string(),
  todayOrdersCount: z.number(),
  todayRevenuePesewas: z.string(),
  activeAttendantsCount: z.number(),
  ordersByStatus: z.object({
    pending: z.number(),
    in_progress: z.number(),
    ready_for_pickup: z.number(),
    delivered: z.number(),
    completed: z.number(),
    cancelled: z.number(),
  }),
});

export const stationTransactionsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().optional(),
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
});

export const stationTransactionSchema = z.object({
  id: z.string().uuid(),
  orderId: z.string().uuid().nullable(),
  orderNumber: z.string().nullable(),
  customerName: z.string().nullable(),
  customerPhoneNumber: z.string().nullable(),
  amountPesewas: z.string(),
  currency: z.string(),
  method: z.string(),
  status: z.string(),
  createdAt: z.string(),
});

export const stationActivityQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const stationActivityLogSchema = z.object({
  id: z.string().uuid(),
  action: z.string(),
  actorId: z.string(),
  actorRole: z.string(),
  entityType: z.string(),
  entityId: z.string(),
  changes: z.unknown().nullable(),
  createdAt: z.string(),
});

export const stationAttendanceHistoryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  attendantId: z.string().uuid().optional(),
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
});

export const stationAttendanceHistoryItemSchema = z.object({
  id: z.string().uuid(),
  attendantId: z.string().uuid(),
  attendantName: z.string(),
  clockInAt: z.string(),
  clockOutAt: z.string().nullable(),
  durationMinutes: z.number().nullable(),
  deviceId: z.string().nullable(),
});

export const verifyAttendantPinSchema = z.object({
  attendantId: z.string().uuid(),
  pin,
});

export const verifyAttendantPinResponseSchema = z.object({
  success: z.boolean(),
  attendant: z.object({
    id: z.string().uuid(),
    name: z.string(),
    email: z.string(),
  }),
});

export const inventoryItemSchema = z.object({
  id: z.string().uuid(),
  branchId: z.string().uuid(),
  name: z.string(),
  category: z.string(),
  unit: z.string(),
  description: z.string().nullable(),
  currentStock: z.number(),
  maxStock: z.number(),
  minStock: z.number(),
  reorderPoint: z.number(),
  status: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const updateStockSchema = z.object({
  currentStock: z.number().int().min(0),
});

export const createInventoryItemSchema = z.object({
  name: z.string().trim().min(1).max(255),
  category: z.enum([
    "cleaning_supplies",
    "add_ons",
    "facility",
    "retail",
    "operational",
    "washing_supplies",
  ]),
  unit: z.string().trim().min(1).max(32),
  description: z.string().max(1000).optional(),
  currentStock: z.number().int().min(0).default(0),
  maxStock: z.number().int().min(0).default(100),
  minStock: z.number().int().min(0).default(10),
  reorderPoint: z.number().int().min(0).default(20),
});

export const orderInventorySchema = z.object({
  orderQuantity: z.number().int().min(1),
});

export const receiveInventorySchema = z.object({
  receivedQuantity: z.number().int().min(1),
});

export const stationNotificationSchema = z.object({
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

export const stationUnreadCountResponseSchema = z.object({
  unreadCount: z.number(),
});

export const stationMachineSchema = z.object({
  id: z.string().uuid(),
  branchId: z.string().uuid(),
  name: z.string(),
  displayName: z.string().nullable(),
  serialNumber: z.string().nullable(),
  otherDetails: z.string().nullable(),
  washPricePesewas: z.string(),
  isActive: z.boolean(),
});

export const stationServiceSchema = z.object({
  id: z.string().uuid(),
  branchId: z.string().uuid(),
  name: z.string(),
  code: z.string(),
  description: z.string().nullable(),
  imageUrl: z.string().nullable(),
  pricePesewas: z.string(),
  extraWashPricePesewas: z.string().nullable(),
  extraDryPricePesewas: z.string().nullable(),
  isActive: z.boolean(),
});

export const stationPaymentInputSchema = z.object({
  paymentMethod: z.enum(["cash", "mobile_money"]),
  amountTenderedPesewas: z.string().optional(),
  attendantId: z.string().uuid().optional(),
});

export const stationPaymentResponseSchema = z.object({
  success: z.boolean(),
  paymentId: z.string().uuid(),
  orderId: z.string().uuid(),
  orderNumber: z.string(),
  status: z.string(),
  amountPesewas: z.string(),
});

export type StationLoginInput = z.infer<typeof stationLoginSchema>;
export type ClockInInput = z.infer<typeof clockInSchema>;
export type ClockOutInput = z.infer<typeof clockOutSchema>;
export type StationStatsQuery = z.infer<typeof stationStatsQuerySchema>;
export type StationTransactionsQuery = z.infer<typeof stationTransactionsQuerySchema>;
export type StationActivityQuery = z.infer<typeof stationActivityQuerySchema>;
export type StationAttendanceHistoryQuery = z.infer<typeof stationAttendanceHistoryQuerySchema>;
export type VerifyAttendantPinInput = z.infer<typeof verifyAttendantPinSchema>;
export type UpdateStockInput = z.infer<typeof updateStockSchema>;
export type CreateInventoryItemInput = z.infer<typeof createInventoryItemSchema>;
export type OrderInventoryInput = z.infer<typeof orderInventorySchema>;
export type ReceiveInventoryInput = z.infer<typeof receiveInventorySchema>;
export type StationPaymentInput = z.infer<typeof stationPaymentInputSchema>;
