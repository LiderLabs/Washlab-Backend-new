import { z } from "zod";

export const adminUserResponseSchema = z.object({
  id: z.string().uuid(),
  _id: z.string(),
  name: z.string(),
  email: z.string(),
  role: z.string(),
  createdAt: z.string(),
});

export const attendantStatusEnum = z.enum(["invited", "active", "suspended", "locked"]);

export const listAttendantsQuerySchema = z.object({
  branchId: z.string().uuid().optional(),
  status: attendantStatusEnum.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const attendantDetailSchema = z.object({
  id: z.string().uuid(),
  _id: z.string(),
  name: z.string(),
  email: z.string(),
  phoneNumber: z.string(),
  branchId: z.string().uuid(),
  branchName: z.string(),
  branchIds: z.array(z.string().uuid()),
  enrollmentStatus: attendantStatusEnum,
  status: attendantStatusEnum,
  consecutiveFailures: z.number(),
  failedAttempts: z.number(),
  lockedUntil: z.string().nullable(),
  enrolledAt: z.string().nullable(),
  enrollmentTokenExpiresAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const createAttendantEnrollmentSchema = z.object({
  name: z.string().trim().min(1).max(255),
  email: z.string().trim().email().max(255),
  phoneNumber: z.string().trim().min(7).max(32),
  branchId: z.string().uuid(),
  branchIds: z.array(z.string().uuid()).optional(),
  expiresInHours: z.number().int().min(1).max(720).default(72),
});

export const enrollmentResultSchema = z.object({
  attendantId: z.string().uuid(),
  enrollmentToken: z.string(),
  enrollmentLink: z.string(),
  expiresAt: z.string(),
});

export const updateAttendantSchema = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  email: z.string().trim().email().max(255).optional(),
  phoneNumber: z.string().trim().min(7).max(32).optional(),
  branchId: z.string().uuid().optional(),
  branchIds: z.array(z.string().uuid()).optional(),
});

export const updateAttendantBranchAccessSchema = z.object({
  branchIds: z.array(z.string().uuid()),
});

export const lockAttendantSchema = z.object({
  lockedUntilMinutes: z.number().int().positive().default(1440), // default 24h
  reason: z.string().max(500).optional(),
});

// --- Branches Schemas ---
export const adminBranchDtoSchema = z.object({
  id: z.string().uuid(),
  _id: z.string(),
  name: z.string(),
  code: z.string(),
  terminalId: z.string().nullable(),
  phoneNumber: z.string(),
  email: z.string().nullable(),
  address: z.string(),
  city: z.string(),
  pricingPerKg: z.number(),
  pricingPerKgPesewas: z.string(),
  deliveryFee: z.number(),
  deliveryFeePesewas: z.string(),
  deliveryFees: z.any().nullable().optional(),
  requireStationLogin: z.boolean(),
  weeklyOrderTarget: z.number().nullable(),
  momoNumber: z.string().nullable(),
  isActive: z.boolean(),
  createdAt: z.string(),
  stats: z.object({
    activeAttendantsCount: z.number(),
    todayOrdersCount: z.number(),
    machinesCount: z.number(),
  }).optional(),
});

export const listBranchesQuerySchema = z.object({
  includeInactive: z.preprocess((val) => val === "true" || val === true, z.boolean()).optional().default(false),
});

export const adminCreateBranchSchema = z.object({
  name: z.string().trim().min(2).max(255),
  code: z.string().trim().min(2).max(10).toUpperCase(),
  terminalId: z.string().trim().max(16).optional(),
  phoneNumber: z.string().trim().min(7).max(32),
  email: z.string().trim().email().max(255).optional(),
  address: z.string().trim().min(2),
  city: z.string().trim().min(2),
  pricingPerKg: z.number().nonnegative().optional(),
  pricingPerKgPesewas: z.number().nonnegative().optional(),
  deliveryFee: z.number().nonnegative().optional(),
  deliveryFeePesewas: z.number().nonnegative().optional(),
  stationPin: z.string().min(4).max(16),
  weeklyOrderTarget: z.number().int().nonnegative().optional(),
  momoNumber: z.string().optional(),
});

export const adminUpdateBranchSchema = z.object({
  name: z.string().trim().min(2).max(255).optional(),
  code: z.string().trim().min(2).max(10).toUpperCase().optional(),
  terminalId: z.string().trim().max(16).optional(),
  phoneNumber: z.string().trim().min(7).max(32).optional(),
  email: z.string().trim().email().max(255).optional(),
  address: z.string().trim().min(2).optional(),
  city: z.string().trim().min(2).optional(),
  pricingPerKg: z.number().nonnegative().optional(),
  pricingPerKgPesewas: z.number().nonnegative().optional(),
  deliveryFee: z.number().nonnegative().optional(),
  deliveryFeePesewas: z.number().nonnegative().optional(),
  stationPin: z.string().min(4).max(16).optional(),
  weeklyOrderTarget: z.number().int().nonnegative().optional(),
  momoNumber: z.string().optional(),
  isActive: z.boolean().optional(),
});

export const updateBranchDeliveryFeesSchema = z.object({
  deliveryFees: z.object({
    dropoff_self: z.number().nonnegative(),
    dropoff_delivery: z.number().nonnegative(),
    pickup_self: z.number().nonnegative(),
    full_service: z.number().nonnegative(),
  }),
});

// --- Machines Schemas ---
export const branchMachineDtoSchema = z.object({
  id: z.string().uuid(),
  _id: z.string(),
  branchId: z.string().uuid(),
  name: z.string(),
  displayName: z.string().nullable(),
  serialNumber: z.string().nullable(),
  otherDetails: z.string().nullable(),
  washPrice: z.number(),
  washPricePesewas: z.string(),
  isActive: z.boolean(),
  createdAt: z.string(),
});

export const createBranchMachineSchema = z.object({
  branchId: z.string().uuid(),
  name: z.string().trim().min(1).max(100),
  displayName: z.string().trim().min(1).max(100),
  serialNumber: z.string().trim().optional(),
  otherDetails: z.string().trim().optional(),
  washPrice: z.number().nonnegative().optional(),
  washPricePesewas: z.number().nonnegative().optional(),
});

export const updateBranchMachineSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  displayName: z.string().trim().min(1).max(100).optional(),
  serialNumber: z.string().trim().optional(),
  otherDetails: z.string().trim().optional(),
  washPrice: z.number().nonnegative().optional(),
  washPricePesewas: z.number().nonnegative().optional(),
  isActive: z.boolean().optional(),
});

// --- Services & Branch Services Schemas ---
export const catalogServiceDtoSchema = z.object({
  id: z.string().uuid(),
  _id: z.string(),
  name: z.string(),
  code: z.string(),
  description: z.string().nullable(),
  imageUrl: z.string().nullable(),
  basePrice: z.number(),
  basePricePesewas: z.string(),
  pricingType: z.string(),
  isActive: z.boolean(),
  createdAt: z.string(),
});

export const createCatalogServiceSchema = z.object({
  name: z.string().trim().min(1).max(100),
  code: z.string().trim().min(1).max(64),
  description: z.string().trim().optional(),
  imageUrl: z.string().trim().optional(),
  basePrice: z.number().nonnegative().optional(),
  basePricePesewas: z.number().nonnegative().optional(),
  pricingType: z.enum(["per_kg", "per_load"]).default("per_load"),
});

export const updateCatalogServiceSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  description: z.string().trim().optional(),
  imageUrl: z.string().trim().optional(),
  basePrice: z.number().nonnegative().optional(),
  basePricePesewas: z.number().nonnegative().optional(),
  pricingType: z.enum(["per_kg", "per_load"]).optional(),
  isActive: z.boolean().optional(),
});

export const adminBranchServiceDtoSchema = z.object({
  id: z.string().uuid(),
  _id: z.string(),
  branchId: z.string().uuid(),
  name: z.string(),
  code: z.string(),
  price: z.number(),
  pricePesewas: z.string(),
  extraWashPrice: z.number().nullable(),
  extraDryPrice: z.number().nullable(),
  extraWashPricePesewas: z.string().nullable(),
  extraDryPricePesewas: z.string().nullable(),
  description: z.string().nullable(),
  imageUrl: z.string().nullable(),
  isActive: z.boolean(),
  showOnCustomerSide: z.boolean(),
  createdAt: z.string(),
});

export const createAdminBranchServiceSchema = z.object({
  branchId: z.string().uuid(),
  name: z.string().trim().min(1).max(100),
  code: z.string().trim().min(1).max(64),
  price: z.number().nonnegative().optional(),
  pricePesewas: z.number().nonnegative().optional(),
  extraWashPrice: z.number().nonnegative().optional(),
  extraDryPrice: z.number().nonnegative().optional(),
  extraWashPricePesewas: z.number().nonnegative().optional(),
  extraDryPricePesewas: z.number().nonnegative().optional(),
  description: z.string().trim().optional(),
  imageUrl: z.string().trim().optional(),
  showOnCustomerSide: z.boolean().optional().default(false),
});

export const updateAdminBranchServiceSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  price: z.number().nonnegative().optional(),
  pricePesewas: z.number().nonnegative().optional(),
  extraWashPrice: z.number().nonnegative().optional(),
  extraDryPrice: z.number().nonnegative().optional(),
  extraWashPricePesewas: z.number().nonnegative().optional(),
  extraDryPricePesewas: z.number().nonnegative().optional(),
  description: z.string().trim().optional(),
  imageUrl: z.string().trim().optional(),
  isActive: z.boolean().optional(),
  showOnCustomerSide: z.boolean().optional(),
});

// --- Admin Orders & Customers Schemas ---
export const adminListOrdersQuerySchema = z.object({
  branchId: z.string().uuid().optional(),
  status: z.string().optional(),
  startDate: z.coerce.number().optional(),
  endDate: z.coerce.number().optional(),
  search: z.string().trim().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const adminOrderSummaryDtoSchema = z.object({
  id: z.string().uuid(),
  _id: z.string(),
  orderNumber: z.string(),
  customerId: z.string().uuid().nullable(),
  customerName: z.string().nullable(),
  branchId: z.string().uuid(),
  branchName: z.string().nullable(),
  status: z.string(),
  paymentStatus: z.string(),
  paymentMethod: z.string().nullable(),
  totalAmount: z.number(),
  totalAmountPesewas: z.string(),
  finalPrice: z.number(),
  weightKg: z.number().nullable(),
  serviceType: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const adminOrderDetailDtoSchema = z.object({
  id: z.string().uuid(),
  _id: z.string(),
  orderNumber: z.string(),
  customerId: z.string().uuid().nullable(),
  customer: z
    .object({
      _id: z.string(),
      id: z.string(),
      name: z.string(),
      phoneNumber: z.string(),
      email: z.string().nullable(),
    })
    .nullable(),
  branchId: z.string().uuid(),
  branch: z
    .object({
      _id: z.string(),
      id: z.string(),
      name: z.string(),
      code: z.string(),
      address: z.string(),
      city: z.string(),
    })
    .nullable(),
  orderType: z.string(),
  serviceType: z.string(),
  bagNumber: z.string().nullable(),
  itemCount: z.number().nullable(),
  estimatedLoads: z.number().nullable(),
  extraWashLoads: z.number(),
  extraDryLoads: z.number(),
  whitesSeparate: z.boolean(),
  notes: z.string().nullable(),
  isDelivery: z.boolean(),
  deliveryAddress: z.string().nullable(),
  deliveryPhone: z.string().nullable(),
  status: z.string(),
  weightKg: z.number().nullable(),
  basePrice: z.number(),
  servicePrice: z.number(),
  deliveryFee: z.number(),
  discount: z.number(),
  finalPrice: z.number(),
  paymentStatus: z.string(),
  paymentMethod: z.string().nullable(),
  statusHistory: z.array(
    z.object({
      status: z.string(),
      changedAt: z.string(),
      changedByRole: z.string(),
      notes: z.string().nullable(),
    })
  ),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const adminUpdateOrderStatusSchema = z.object({
  newStatus: z.enum([
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
  ]),
  notes: z.string().max(500).optional(),
});

export const adminListCustomersQuerySchema = z.object({
  search: z.string().trim().optional(),
  status: z.enum(["active", "blocked", "suspended", "restricted"]).optional(),
  isRegistered: z.preprocess((v) => v === "true" || v === true, z.boolean()).optional(),
  branchId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const adminCustomerDtoSchema = z.object({
  id: z.string().uuid(),
  _id: z.string(),
  name: z.string(),
  phoneNumber: z.string(),
  email: z.string().nullable(),
  branchId: z.string().uuid().nullable(),
  branchName: z.string().nullable(),
  allBranches: z.string().nullable(),
  status: z.string(),
  statusNote: z.string().nullable(),
  isRegistered: z.boolean(),
  isVerified: z.boolean(),
  loyaltyPoints: z.number(),
  orderCount: z.number(),
  completedOrderCount: z.number(),
  totalSpent: z.number(),
  lastOrderDate: z.string().nullable(),
  lastOrderNumber: z.string().nullable(),
  createdAt: z.string(),
});

export const adminCustomerStatsDtoSchema = z.object({
  totalCustomers: z.number(),
  registeredCustomers: z.number(),
  walkInCustomers: z.number(),
  activeCustomers: z.number(),
  blockedCustomers: z.number(),
  suspendedCustomers: z.number(),
  restrictedCustomers: z.number(),
  verifiedCustomers: z.number(),
  customersWithActiveOrders: z.number(),
  totalRevenue: z.number(),
  branchCustomerCounts: z.array(
    z.object({
      branchId: z.string().uuid(),
      branchName: z.string(),
      customerCount: z.number(),
    })
  ),
});

export const changeCustomerStatusSchema = z.object({
  status: z.enum(["active", "blocked", "suspended", "restricted"]),
  note: z.string().min(3).max(500),
});

// --- Admin Analytics & Finance Schemas ---
export const adminAnalyticsOverviewQuerySchema = z.object({
  branchId: z.string().uuid().optional(),
  startDate: z.coerce.number().optional(),
  endDate: z.coerce.number().optional(),
});

export const adminAnalyticsOverviewDtoSchema = z.object({
  totalOrders: z.number(),
  totalRevenue: z.number(),
  averageOrderValue: z.number(),
  ordersByStatus: z.record(z.string(), z.number()),
  ordersByDay: z.record(z.string(), z.number()),
  topCustomers: z.array(
    z.object({
      customerId: z.string().uuid(),
      name: z.string(),
      phoneNumber: z.string(),
      orderCount: z.number(),
    })
  ),
  dateRange: z.object({
    start: z.number().optional(),
    end: z.number().optional(),
  }),
});

export const adminPaymentStatsQuerySchema = z.object({
  startDate: z.string(),
  endDate: z.string(),
  branchId: z.string().uuid().optional(),
});

export const adminPaymentStatsDtoSchema = z.object({
  totalRevenue: z.number(),
  cashAmount: z.number(),
  mobileMoneyAmount: z.number(),
  cardAmount: z.number(),
  paystackAmount: z.number(),
  byDay: z.record(z.string(), z.number()),
  byDayByMethod: z.record(
    z.string(),
    z.object({
      cash: z.number(),
      mobile_money: z.number(),
      card: z.number(),
    })
  ),
});

export const adminWeeklyOrderStatsQuerySchema = z.object({
  weekStart: z.coerce.number().optional(),
  weekEnd: z.coerce.number().optional(),
});

export const adminWeeklyBranchStatDtoSchema = z.object({
  branchId: z.string().uuid(),
  branchName: z.string(),
  weeklyOrders: z.number(),
  weeklyTarget: z.number(),
});
