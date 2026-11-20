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
  offset: z.coerce.number().int().min(0).default(0),
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
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
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

// --- Admin Reconciliation & Reports Schemas ---
export const adminBranchCashSummaryDtoSchema = z.object({
  branchId: z.string().uuid(),
  branchName: z.string(),
  code: z.string(),
  terminalId: z.string().nullable(),
  collectedGhs: z.number(),
  sentGhs: z.number(),
  deductedGhs: z.number(),
  creditAppliedGhs: z.number(),
  outstandingGhs: z.number(),
  collectedPesewas: z.string(),
  sentPesewas: z.string(),
  deductedPesewas: z.string(),
  outstandingPesewas: z.string(),
});

export const adminReconciliationDtoSchema = z.object({
  id: z.string().uuid(),
  _id: z.string(),
  branchId: z.string().uuid(),
  branchName: z.string(),
  attendantId: z.string().uuid().nullable(),
  attendantName: z.string(),
  paystackReference: z.string(),
  paystackTransactionId: z.string().nullable(),
  amountSentGhs: z.number(),
  amountSentPesewas: z.string(),
  senderMomoNumber: z.string(),
  network: z.string().nullable(),
  status: z.string(),
  excessGhs: z.number(),
  excessPesewas: z.string(),
  displayText: z.string().nullable(),
  notes: z.string().nullable(),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
});

export const adminDeductionDtoSchema = z.object({
  id: z.string().uuid(),
  _id: z.string(),
  branchId: z.string().uuid(),
  branchName: z.string(),
  attendantId: z.string().uuid().nullable(),
  attendantName: z.string(),
  amountGhs: z.number(),
  amountPesewas: z.string(),
  reason: z.string(),
  day: z.string(),
  createdAt: z.string(),
});

export const adminDailyReportDtoSchema = z.object({
  id: z.string().uuid(),
  _id: z.string(),
  branchId: z.string().uuid(),
  branchName: z.string(),
  attendantId: z.string().uuid().nullable(),
  attendantName: z.string(),
  reportDate: z.string(),
  attendantsOnShift: z.array(z.string()),
  washerTokensUsed: z.number(),
  dryerTokensUsed: z.number(),
  totalTokensUsed: z.number(),
  serviceBreakdown: z.any(),
  voucherBreakdown: z.any(),
  cashGhs: z.number(),
  mobileMoneyGhs: z.number(),
  cardGhs: z.number(),
  totalRevenueGhs: z.number(),
  soapUnitsUsed: z.number(),
  freeWashCount: z.number(),
  technicalFaultCount: z.number(),
  technicalFaultNotes: z.string().nullable(),
  outstandingAmountGhs: z.number(),
  outstandingOrderCount: z.number(),
  status: z.string(),
  submittedAt: z.string().nullable(),
  notes: z.string().nullable(),
  createdAt: z.string(),
});

// --- Admin Loyalty & Vouchers Schemas ---
export const adminLoyaltyStatsDtoSchema = z.object({
  totalPointsCirculating: z.number(),
  totalPointsEarned: z.number(),
  totalPointsRedeemed: z.number(),
  customerCount: z.number(),
  topCustomers: z.array(
    z.object({
      customerId: z.string().uuid(),
      _id: z.string(),
      name: z.string(),
      phoneNumber: z.string(),
      points: z.number(),
    })
  ),
});

export const adminLoyaltyTransactionDtoSchema = z.object({
  id: z.string().uuid(),
  _id: z.string(),
  customerId: z.string().uuid(),
  customerName: z.string(),
  customerPhone: z.string(),
  orderId: z.string().uuid().nullable(),
  pointsDelta: z.number(),
  balanceAfter: z.number(),
  reason: z.string(),
  createdAt: z.string(),
});

export const adminAdjustPointsSchema = z.object({
  customerId: z.string().uuid(),
  pointsDelta: z.number().int(),
  reason: z.string().trim().min(3).max(255),
});

export const adminVoucherDtoSchema = z.object({
  id: z.string().uuid(),
  _id: z.string(),
  code: z.string(),
  name: z.string().nullable(),
  branchId: z.string().uuid().nullable(),
  branchName: z.string().nullable().optional(),
  discountType: z.string(),
  discountValue: z.number(),
  discountValuePesewas: z.string(),
  minOrderAmountGhs: z.number(),
  maxUsageCount: z.number().nullable(),
  currentUsageCount: z.number(),
  maxUsesPerCustomer: z.number().nullable(),
  validFrom: z.string().nullable(),
  applicableServices: z.array(z.string()).nullable(),
  batchId: z.string().nullable().optional(),
  expiresAt: z.string().nullable(),
  isActive: z.boolean(),
  createdAt: z.string(),
});

export const adminCreateVoucherSchema = z.object({
  code: z.string().trim().toUpperCase().optional(),
  name: z.string().trim().optional(),
  branchId: z.string().uuid().optional(),
  discountType: z.enum(["percentage", "fixed", "free_wash"]),
  discountValue: z.number().positive(),
  minOrderAmount: z.number().nonnegative().optional(),
  minOrderAmountPesewas: z.number().nonnegative().optional(),
  maxUsageCount: z.number().int().positive().optional(),
  maxUsesPerCustomer: z.number().int().positive().optional(),
  validFrom: z.string().optional(),
  expiresAt: z.string().optional(),
  applicableServices: z.array(z.string()).optional(),
});

export const adminUpdateVoucherSchema = z.object({
  name: z.string().trim().optional(),
  discountType: z.enum(["percentage", "fixed", "free_wash"]).optional(),
  discountValue: z.number().positive().optional(),
  minOrderAmount: z.number().nonnegative().optional(),
  minOrderAmountPesewas: z.number().nonnegative().optional(),
  maxUsageCount: z.number().int().positive().optional(),
  maxUsesPerCustomer: z.number().int().positive().optional(),
  validFrom: z.string().optional(),
  expiresAt: z.string().optional(),
  applicableServices: z.array(z.string()).optional(),
  isActive: z.boolean().optional(),
});

export const adminCreateVoucherBatchSchema = z.object({
  count: z.number().int().min(1).max(200),
  value: z.number().positive().max(1000),
  name: z.string().trim().optional(),
  validUntil: z.string().optional(),
  branchId: z.string().uuid().optional(),
  applicableServices: z.array(z.string()).optional(),
});

export const adminVoucherBatchDtoSchema = z.object({
  batchId: z.string(),
  name: z.string(),
  value: z.number(),
  validUntil: z.string().nullable(),
  createdAt: z.string(),
  total: z.number(),
  used: z.number(),
  available: z.number(),
});

// --- Admin Operations Schemas ---
export const adminInventoryItemDtoSchema = z.object({
  id: z.string().uuid(),
  _id: z.string(),
  branchId: z.string().uuid(),
  branchName: z.string(),
  name: z.string(),
  category: z.string(),
  unit: z.string(),
  description: z.string().nullable(),
  currentStock: z.number(),
  maxStock: z.number(),
  minStock: z.number(),
  reorderPoint: z.number(),
  status: z.string(),
  orderedAt: z.string().nullable(),
  orderQuantity: z.number().nullable(),
  expectedArrivalDate: z.string().nullable(),
  lastRestockedAt: z.string().nullable(),
  createdAt: z.string(),
});

export const adminCreateInventoryItemSchema = z.object({
  branchId: z.string().uuid(),
  name: z.string().trim().min(1).max(255),
  category: z.enum(["cleaning_supplies", "add_ons", "facility", "retail", "operational", "washing_supplies"]),
  unit: z.string().trim().min(1).max(32),
  description: z.string().trim().optional(),
  currentStock: z.number().int().nonnegative(),
  minStock: z.number().int().nonnegative().optional(),
  maxStock: z.number().int().positive().optional(),
  reorderPoint: z.number().int().nonnegative().optional(),
});

export const adminUpdateInventoryItemSchema = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  category: z.enum(["cleaning_supplies", "add_ons", "facility", "retail", "operational", "washing_supplies"]).optional(),
  unit: z.string().trim().min(1).max(32).optional(),
  description: z.string().trim().optional(),
  currentStock: z.number().int().nonnegative().optional(),
  minStock: z.number().int().nonnegative().optional(),
  maxStock: z.number().int().positive().optional(),
  reorderPoint: z.number().int().nonnegative().optional(),
  status: z.enum(["critical", "low", "ok", "ordered"]).optional(),
});

export const adminMaintenanceTicketDtoSchema = z.object({
  id: z.string().uuid(),
  _id: z.string(),
  branchId: z.string().uuid(),
  branchName: z.string(),
  machineId: z.string().uuid().nullable(),
  machineName: z.string(),
  displayName: z.string().nullable(),
  serialNumber: z.string().nullable(),
  otherDetails: z.string().nullable(),
  faultTypes: z.array(z.string()),
  description: z.string().nullable(),
  status: z.string(),
  reportedAt: z.string(),
  reportedBy: z.string().nullable(),
  fixedAt: z.string().nullable(),
  fixedBy: z.string().nullable(),
  createdAt: z.string(),
});

export const adminNotificationDtoSchema = z.object({
  id: z.string().uuid(),
  _id: z.string(),
  recipientType: z.string(),
  recipientId: z.string().nullable(),
  branchId: z.string().uuid().nullable(),
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

export const adminCreateNotificationSchema = z.object({
  recipientType: z.enum(["customer", "attendant", "admin", "station", "all"]),
  recipientId: z.string().optional(),
  branchId: z.string().uuid().optional(),
  title: z.string().trim().min(1).max(255),
  message: z.string().trim().min(1),
  type: z.string().default("info"),
  priority: z.string().default("normal"),
  entityType: z.string().optional(),
  entityId: z.string().optional(),
});

export const adminSystemSettingsDtoSchema = z.object({
  id: z.number(),
  taxRatePercent: z.number(),
  pointsPerGhs: z.number(),
  minRedemptionPoints: z.number(),
  autoLogoutMinutes: z.number(),
  deliveryPricing: z.object({
    dropoff_self: z.number(),
    dropoff_delivery: z.number(),
    pickup_self: z.number(),
    full_service: z.number(),
  }).optional(),
  updatedBy: z.string().nullable(),
  updatedAt: z.string(),
});

export const adminUpdateSystemSettingsSchema = z.object({
  taxRatePercent: z.number().nonnegative().optional(),
  pointsPerGhs: z.number().int().positive().optional(),
  minRedemptionPoints: z.number().int().nonnegative().optional(),
  autoLogoutMinutes: z.number().int().positive().optional(),
});

export const adminHeadlineDtoSchema = z.object({
  id: z.string().uuid(),
  _id: z.string(),
  branchId: z.string().uuid().nullable(),
  title: z.string(),
  body: z.string().nullable(),
  priority: z.string(),
  expiresAt: z.string().nullable(),
  createdAt: z.string(),
});

export const adminCreateHeadlineSchema = z.object({
  title: z.string().trim().min(1).max(255),
  body: z.string().trim().optional(),
  branchId: z.string().uuid().optional(),
  priority: z.enum(["info", "notice", "urgent"]).default("info"),
  expiresAt: z.string().optional(),
});

export const adminAuditLogDtoSchema = z.object({
  id: z.string().uuid(),
  _id: z.string(),
  action: z.string(),
  entityType: z.string(),
  entityId: z.string(),
  performedByUserId: z.string(),
  performedByRole: z.string(),
  changes: z.any().nullable(),
  ipAddress: z.string().nullable(),
  userAgent: z.string().nullable(),
  createdAt: z.string(),
});
