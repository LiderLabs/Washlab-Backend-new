import { FastifyInstance, FastifyRequest } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { authenticate, requirePermission, requireRole } from "../../platform/auth/index.js";
import { adminStaffService } from "./service.js";
import { adminBranchesService } from "./branches.service.js";
import { adminOrdersService } from "./orders.service.js";
import { adminAnalyticsService } from "./analytics.service.js";
import { adminReconciliationService } from "./reconciliation.service.js";
import { adminLoyaltyService } from "./loyalty.service.js";
import { adminOperationsService } from "./operations.service.js";
import {
  adminAdjustPointsSchema,
  adminAnalyticsOverviewDtoSchema,
  adminAnalyticsOverviewQuerySchema,
  adminAuditLogDtoSchema,
  adminBranchCashSummaryDtoSchema,
  adminBranchDtoSchema,
  adminBranchServiceDtoSchema,
  adminCreateBranchSchema,
  adminCreateHeadlineSchema,
  adminCreateInventoryItemSchema,
  adminCreateNotificationSchema,
  adminCreateVoucherBatchSchema,
  adminCreateVoucherSchema,
  adminCustomerDtoSchema,
  adminCustomerStatsDtoSchema,
  adminDailyReportDtoSchema,
  adminDeductionDtoSchema,
  adminHeadlineDtoSchema,
  adminInventoryItemDtoSchema,
  adminListCustomersQuerySchema,
  adminListOrdersQuerySchema,
  adminLoyaltyStatsDtoSchema,
  adminLoyaltyTransactionDtoSchema,
  adminMaintenanceTicketDtoSchema,
  adminNotificationDtoSchema,
  adminOrderDetailDtoSchema,
  adminOrderSummaryDtoSchema,
  adminPaymentStatsDtoSchema,
  adminPaymentStatsQuerySchema,
  adminReconciliationDtoSchema,
  adminSystemSettingsDtoSchema,
  adminUpdateBranchSchema,
  adminUpdateInventoryItemSchema,
  adminUpdateOrderStatusSchema,
  adminUpdateSystemSettingsSchema,
  adminUpdateVoucherSchema,
  adminUserResponseSchema,
  adminVoucherBatchDtoSchema,
  adminVoucherDtoSchema,
  adminWeeklyBranchStatDtoSchema,
  adminWeeklyOrderStatsQuerySchema,
  attendantDetailSchema,
  branchMachineDtoSchema,
  catalogServiceDtoSchema,
  changeCustomerStatusSchema,
  createAdminBranchServiceSchema,
  createAttendantEnrollmentSchema,
  createBranchMachineSchema,
  createCatalogServiceSchema,
  enrollmentResultSchema,
  listAttendantsQuerySchema,
  listBranchesQuerySchema,
  lockAttendantSchema,
  updateAdminBranchServiceSchema,
  updateAttendantBranchAccessSchema,
  updateAttendantSchema,
  updateBranchDeliveryFeesSchema,
  updateBranchMachineSchema,
  updateCatalogServiceSchema,
} from "./schemas.js";

const security = [{ bearerAuth: [] }];
const baseAdmin = {
  onRequest: [authenticate, requireRole("super_admin", "admin")],
};
const baseStaffManage = {
  onRequest: [authenticate, requireRole("super_admin", "admin"), requirePermission("attendant.manage")],
};
const idParam = z.object({ id: z.string().uuid() });
const successResponse = { 200: z.object({ success: z.boolean() }) };

const meta = (req: FastifyRequest) => ({ ip: req.ip, userAgent: req.headers["user-agent"] });

export async function adminRoutes(app: FastifyInstance) {
  const server = app.withTypeProvider<ZodTypeProvider>();

  // ---------- 1. Admin Current User Profile ----------
  server.get(
    "/me",
    {
      ...baseAdmin,
      schema: {
        tags: ["Admin"],
        summary: "Get current authenticated admin user profile",
        security,
        response: { 200: adminUserResponseSchema },
      },
    },
    async (request) => adminStaffService.getCurrentAdmin(request.user!.id)
  );

  // ---------- 2. Staff / Attendant Management ----------
  server.get(
    "/staff",
    {
      ...baseAdmin,
      schema: {
        tags: ["Admin Staff"],
        summary: "List all attendants across branches or filter by branch/status",
        security,
        querystring: listAttendantsQuerySchema,
        response: { 200: z.array(attendantDetailSchema) },
      },
    },
    async (request, reply) => {
      const result = await adminStaffService.listAttendants(request.query);
      reply.header("X-Total-Count", result.total);
      return result.items;
    }
  );

  server.post(
    "/staff/enroll",
    {
      ...baseStaffManage,
      schema: {
        tags: ["Admin Staff"],
        summary: "Invite and generate an enrollment link for a new or rejoining attendant",
        security,
        body: createAttendantEnrollmentSchema,
        response: { 200: enrollmentResultSchema },
      },
    },
    async (request) => adminStaffService.createAttendantEnrollment(request.user!, request.body, meta(request))
  );

  server.post(
    "/staff/:id/resend-enrollment",
    {
      ...baseStaffManage,
      schema: {
        tags: ["Admin Staff"],
        summary: "Generate and resend a fresh enrollment link for an attendant",
        security,
        params: idParam,
        body: z.object({ expiresInHours: z.number().int().min(1).max(720).default(72) }).optional(),
        response: { 200: enrollmentResultSchema },
      },
    },
    async (request) =>
      adminStaffService.resendEnrollmentLink(request.user!, request.params.id, request.body?.expiresInHours, meta(request))
  );

  server.patch(
    "/staff/:id",
    {
      ...baseStaffManage,
      schema: {
        tags: ["Admin Staff"],
        summary: "Update attendant basic info or home branch",
        security,
        params: idParam,
        body: updateAttendantSchema,
        response: successResponse,
      },
    },
    async (request) => adminStaffService.updateAttendant(request.user!, request.params.id, request.body, meta(request))
  );

  server.put(
    "/staff/:id/branches",
    {
      ...baseStaffManage,
      schema: {
        tags: ["Admin Staff"],
        summary: "Update attendant multi-branch access permissions",
        security,
        params: idParam,
        body: updateAttendantBranchAccessSchema,
        response: successResponse,
      },
    },
    async (request) =>
      adminStaffService.updateBranchAccess(request.user!, request.params.id, request.body.branchIds, meta(request))
  );

  server.post(
    "/staff/:id/activate",
    {
      ...baseStaffManage,
      schema: {
        tags: ["Admin Staff"],
        summary: "Activate an attendant account",
        security,
        params: idParam,
        response: successResponse,
      },
    },
    async (request) => adminStaffService.activateAttendant(request.user!, request.params.id, meta(request))
  );

  server.post(
    "/staff/:id/suspend",
    {
      ...baseStaffManage,
      schema: {
        tags: ["Admin Staff"],
        summary: "Suspend an attendant account and revoke all station sessions",
        security,
        params: idParam,
        response: successResponse,
      },
    },
    async (request) => adminStaffService.suspendAttendant(request.user!, request.params.id, meta(request))
  );

  server.post(
    "/staff/:id/lock",
    {
      ...baseStaffManage,
      schema: {
        tags: ["Admin Staff"],
        summary: "Lock an attendant account for a duration (default 24h) and revoke sessions",
        security,
        params: idParam,
        body: lockAttendantSchema,
        response: successResponse,
      },
    },
    async (request) =>
      adminStaffService.lockAttendant(
        request.user!,
        request.params.id,
        request.body.lockedUntilMinutes,
        request.body.reason,
        meta(request)
      )
  );

  server.post(
    "/staff/:id/unlock",
    {
      ...baseStaffManage,
      schema: {
        tags: ["Admin Staff"],
        summary: "Unlock an attendant account and clear failed attempt counters",
        security,
        params: idParam,
        response: successResponse,
      },
    },
    async (request) => adminStaffService.unlockAttendant(request.user!, request.params.id, meta(request))
  );

  server.post(
    "/staff/:id/reset-failures",
    {
      ...baseStaffManage,
      schema: {
        tags: ["Admin Staff"],
        summary: "Reset consecutive failed login/PIN attempts for an attendant",
        security,
        params: idParam,
        response: successResponse,
      },
    },
    async (request) => adminStaffService.resetAttendantFailures(request.user!, request.params.id, meta(request))
  );

  server.post(
    "/staff/:id/revoke-sessions",
    {
      ...baseStaffManage,
      schema: {
        tags: ["Admin Staff"],
        summary: "Revoke all active tablet/station sessions for this attendant",
        security,
        params: idParam,
        response: successResponse,
      },
    },
    async (request) => adminStaffService.revokeAttendantSessions(request.user!, request.params.id, meta(request))
  );

  server.delete(
    "/staff/:id",
    {
      ...baseStaffManage,
      schema: {
        tags: ["Admin Staff"],
        summary: "Soft-delete an attendant account and revoke all sessions",
        security,
        params: idParam,
        response: successResponse,
      },
    },
    async (request) => adminStaffService.deleteAttendant(request.user!, request.params.id, meta(request))
  );

  // ---------- 3. Admin Branches Management ----------
  server.get(
    "/branches",
    {
      ...baseAdmin,
      schema: {
        tags: ["Admin Branches"],
        summary: "List branches with operational metrics (active attendants, today orders, machines)",
        security,
        querystring: listBranchesQuerySchema,
        response: { 200: z.array(adminBranchDtoSchema) },
      },
    },
    async (request, reply) => {
      const result = await adminBranchesService.listBranches(request.query.includeInactive, request.query);
      reply.header("X-Total-Count", result.total);
      return result.items;
    }
  );

  server.get(
    "/branches/active",
    {
      ...baseAdmin,
      schema: {
        tags: ["Admin Branches"],
        summary: "List all active branches",
        security,
        querystring: z.object({
          limit: z.coerce.number().int().min(1).max(200).default(50),
          offset: z.coerce.number().int().min(0).default(0),
        }),
        response: { 200: z.array(adminBranchDtoSchema) },
      },
    },
    async (request, reply) => {
      const result = await adminBranchesService.listBranches(false, request.query);
      reply.header("X-Total-Count", result.total);
      return result.items;
    }
  );

  server.get(
    "/branches/attendance-summary",
    {
      ...baseAdmin,
      schema: {
        tags: ["Admin Branches"],
        summary: "Get active attendance and clock-ins breakdown across branches",
        security,
      },
    },
    async () => adminBranchesService.getBranchAttendanceSummary()
  );

  server.get(
    "/branches/by-code/:code",
    {
      ...baseAdmin,
      schema: {
        tags: ["Admin Branches"],
        summary: "Get branch details by branch code",
        security,
        params: z.object({ code: z.string().min(1).max(32) }),
        response: { 200: adminBranchDtoSchema },
      },
    },
    async (request) => adminBranchesService.getBranchByCode(request.params.code)
  );

  server.get(
    "/branches/:id",
    {
      ...baseAdmin,
      schema: {
        tags: ["Admin Branches"],
        summary: "Get single branch details by ID",
        security,
        params: idParam,
        response: { 200: adminBranchDtoSchema },
      },
    },
    async (request) => adminBranchesService.getBranchById(request.params.id)
  );

  server.post(
    "/branches",
    {
      ...baseAdmin,
      schema: {
        tags: ["Admin Branches"],
        summary: "Create a new branch",
        security,
        body: adminCreateBranchSchema,
        response: { 201: adminBranchDtoSchema },
      },
    },
    async (request, reply) => {
      const branch = await adminBranchesService.createBranch(request.user!, request.body, meta(request));
      return reply.status(201).send(branch);
    }
  );

  server.patch(
    "/branches/:id",
    {
      ...baseAdmin,
      schema: {
        tags: ["Admin Branches"],
        summary: "Update branch details",
        security,
        params: idParam,
        body: adminUpdateBranchSchema,
        response: { 200: adminBranchDtoSchema },
      },
    },
    async (request) => adminBranchesService.updateBranch(request.user!, request.params.id, request.body, meta(request))
  );

  server.post(
    "/branches/:id/toggle",
    {
      ...baseAdmin,
      schema: {
        tags: ["Admin Branches"],
        summary: "Toggle branch active status",
        security,
        params: idParam,
        response: { 200: z.object({ branchId: z.string().uuid(), isActive: z.boolean() }) },
      },
    },
    async (request) => adminBranchesService.toggleBranchStatus(request.user!, request.params.id, meta(request))
  );

  server.delete(
    "/branches/:id",
    {
      ...baseAdmin,
      schema: {
        tags: ["Admin Branches"],
        summary: "Soft-delete a branch (requires no active orders)",
        security,
        params: idParam,
        response: { 200: z.object({ branchId: z.string().uuid(), success: z.boolean() }) },
      },
    },
    async (request) => adminBranchesService.deleteBranch(request.user!, request.params.id, meta(request))
  );

  server.patch(
    "/branches/:id/delivery-fees",
    {
      ...baseAdmin,
      schema: {
        tags: ["Admin Branches"],
        summary: "Update delivery fee structure for a branch",
        security,
        params: idParam,
        body: updateBranchDeliveryFeesSchema,
      },
    },
    async (request) =>
      adminBranchesService.updateBranchDeliveryFees(request.user!, request.params.id, request.body.deliveryFees, meta(request))
  );

  // ---------- 4. Branch Machines Management ----------
  server.get(
    "/branches/:id/machines",
    {
      ...baseAdmin,
      schema: {
        tags: ["Admin Machines"],
        summary: "List all machines in a branch",
        security,
        params: idParam,
        querystring: z.object({
          onlyActive: z.preprocess((v) => v === "true" || v === true, z.boolean()).optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
          offset: z.coerce.number().int().min(0).default(0),
        }),
        response: { 200: z.array(branchMachineDtoSchema) },
      },
    },
    async (request, reply) => {
      const result = await adminBranchesService.listMachinesByBranch(request.params.id, request.query.onlyActive, request.query);
      reply.header("X-Total-Count", result.total);
      return result.items;
    }
  );

  server.get(
    "/branches/:id/machines/active",
    {
      ...baseAdmin,
      schema: {
        tags: ["Admin Machines"],
        summary: "List active machines in a branch",
        security,
        params: idParam,
        querystring: z.object({
          limit: z.coerce.number().int().min(1).max(200).default(50),
          offset: z.coerce.number().int().min(0).default(0),
        }),
        response: { 200: z.array(branchMachineDtoSchema) },
      },
    },
    async (request, reply) => {
      const result = await adminBranchesService.listMachinesByBranch(request.params.id, true, request.query);
      reply.header("X-Total-Count", result.total);
      return result.items;
    }
  );

  server.post(
    "/branches/:id/machines",
    {
      ...baseAdmin,
      schema: {
        tags: ["Admin Machines"],
        summary: "Add a new machine to a branch",
        security,
        params: idParam,
        body: createBranchMachineSchema.omit({ branchId: true }),
        response: { 201: branchMachineDtoSchema },
      },
    },
    async (request, reply) => {
      const machine = await adminBranchesService.createMachine(
        request.user!,
        { ...request.body, branchId: request.params.id },
        meta(request)
      );
      return reply.status(201).send(machine);
    }
  );

  server.patch(
    "/machines/:id",
    {
      ...baseAdmin,
      schema: {
        tags: ["Admin Machines"],
        summary: "Update a machine",
        security,
        params: idParam,
        body: updateBranchMachineSchema,
        response: { 200: branchMachineDtoSchema },
      },
    },
    async (request) => adminBranchesService.updateMachine(request.user!, request.params.id, request.body, meta(request))
  );

  server.delete(
    "/machines/:id",
    {
      ...baseAdmin,
      schema: {
        tags: ["Admin Machines"],
        summary: "Soft-delete a machine",
        security,
        params: idParam,
        response: successResponse,
      },
    },
    async (request) => adminBranchesService.deleteMachine(request.user!, request.params.id, meta(request))
  );

  // ---------- 5. Catalog Template Services ----------
  server.get(
    "/services",
    {
      ...baseAdmin,
      schema: {
        tags: ["Admin Services"],
        summary: "List global catalog services",
        security,
        querystring: z.object({
          limit: z.coerce.number().int().min(1).max(200).default(50),
          offset: z.coerce.number().int().min(0).default(0),
        }),
        response: { 200: z.array(catalogServiceDtoSchema) },
      },
    },
    async (request, reply) => {
      const result = await adminBranchesService.listCatalogServices(request.query);
      reply.header("X-Total-Count", result.total);
      return result.items;
    }
  );

  server.post(
    "/services",
    {
      ...baseAdmin,
      schema: {
        tags: ["Admin Services"],
        summary: "Create a new catalog service",
        security,
        body: createCatalogServiceSchema,
        response: { 201: catalogServiceDtoSchema },
      },
    },
    async (request, reply) => {
      const service = await adminBranchesService.createCatalogService(request.user!, request.body, meta(request));
      return reply.status(201).send(service);
    }
  );

  server.patch(
    "/services/:id",
    {
      ...baseAdmin,
      schema: {
        tags: ["Admin Services"],
        summary: "Update a catalog service",
        security,
        params: idParam,
        body: updateCatalogServiceSchema,
        response: { 200: catalogServiceDtoSchema },
      },
    },
    async (request) =>
      adminBranchesService.updateCatalogService(request.user!, request.params.id, request.body, meta(request))
  );

  server.delete(
    "/services/:id",
    {
      ...baseAdmin,
      schema: {
        tags: ["Admin Services"],
        summary: "Soft-delete a catalog service",
        security,
        params: idParam,
        response: successResponse,
      },
    },
    async (request) => adminBranchesService.deleteCatalogService(request.user!, request.params.id, meta(request))
  );

  // ---------- 6. Branch Services (Per-Branch Pricing) ----------
  server.get(
    "/branches/:id/services",
    {
      ...baseAdmin,
      schema: {
        tags: ["Admin Services"],
        summary: "List configured services for a branch",
        security,
        params: idParam,
        querystring: z.object({
          limit: z.coerce.number().int().min(1).max(200).default(50),
          offset: z.coerce.number().int().min(0).default(0),
        }),
        response: { 200: z.array(adminBranchServiceDtoSchema) },
      },
    },
    async (request, reply) => {
      const result = await adminBranchesService.listBranchServices(request.params.id, request.query);
      reply.header("X-Total-Count", result.total);
      return result.items;
    }
  );

  server.post(
    "/branches/:id/services",
    {
      ...baseAdmin,
      schema: {
        tags: ["Admin Services"],
        summary: "Configure/add a service to a branch",
        security,
        params: idParam,
        body: createAdminBranchServiceSchema.omit({ branchId: true }),
        response: { 201: adminBranchServiceDtoSchema },
      },
    },
    async (request, reply) => {
      const service = await adminBranchesService.createBranchService(
        request.user!,
        { ...request.body, branchId: request.params.id },
        meta(request)
      );
      return reply.status(201).send(service);
    }
  );

  server.patch(
    "/branch-services/:id",
    {
      ...baseAdmin,
      schema: {
        tags: ["Admin Services"],
        summary: "Update a branch service configuration",
        security,
        params: idParam,
        body: updateAdminBranchServiceSchema,
        response: { 200: adminBranchServiceDtoSchema },
      },
    },
    async (request) =>
      adminBranchesService.updateBranchService(request.user!, request.params.id, request.body, meta(request))
  );

  server.delete(
    "/branch-services/:id",
    {
      ...baseAdmin,
      schema: {
        tags: ["Admin Services"],
        summary: "Soft-delete a branch service",
        security,
        params: idParam,
        response: successResponse,
      },
    },
    async (request) => adminBranchesService.deleteBranchService(request.user!, request.params.id, meta(request))
  );

  // ---------- 7. Admin Orders Management ----------
  server.get(
    "/orders",
    {
      ...baseAdmin,
      schema: {
        tags: ["Admin Orders"],
        summary: "List all orders across branches with filtering, search, and pagination",
        security,
        querystring: adminListOrdersQuerySchema,
        response: { 200: z.array(adminOrderSummaryDtoSchema) },
      },
    },
    async (request, reply) => {
      const result = await adminOrdersService.listOrders(request.query);
      reply.header("X-Total-Count", result.total);
      return result.items;
    }
  );

  server.get(
    "/orders/:id",
    {
      ...baseAdmin,
      schema: {
        tags: ["Admin Orders"],
        summary: "Get comprehensive order details with customer, branch, and status history",
        security,
        params: idParam,
        response: { 200: adminOrderDetailDtoSchema },
      },
    },
    async (request) => adminOrdersService.getOrderDetails(request.params.id)
  );

  server.patch(
    "/orders/:id/status",
    {
      ...baseAdmin,
      schema: {
        tags: ["Admin Orders"],
        summary: "Update order status as an admin (triggers status event and loyalty on complete)",
        security,
        params: idParam,
        body: adminUpdateOrderStatusSchema,
        response: { 200: z.object({ success: z.boolean(), orderId: z.string().uuid(), status: z.string() }) },
      },
    },
    async (request) =>
      adminOrdersService.updateOrderStatus(
        request.user!,
        request.params.id,
        request.body.newStatus,
        request.body.notes,
        meta(request)
      )
  );

  server.delete(
    "/orders/:id",
    {
      ...baseAdmin,
      schema: {
        tags: ["Admin Orders"],
        summary: "Soft-delete an order as an admin",
        security,
        params: idParam,
        response: successResponse,
      },
    },
    async (request) => adminOrdersService.deleteOrder(request.user!, request.params.id, meta(request))
  );

  // ---------- 8. Admin Customers Management ----------
  server.get(
    "/customers",
    {
      ...baseAdmin,
      schema: {
        tags: ["Admin Customers"],
        summary: "List customers with search, order aggregations, branch details, and pagination",
        security,
        querystring: adminListCustomersQuerySchema,
        response: { 200: z.array(adminCustomerDtoSchema) },
      },
    },
    async (request, reply) => {
      const result = await adminOrdersService.listCustomers(request.query);
      reply.header("X-Total-Count", result.total);
      return result.items;
    }
  );

  server.get(
    "/customers/stats",
    {
      ...baseAdmin,
      schema: {
        tags: ["Admin Customers"],
        summary: "Get overall customer counts, activity stats, and per-branch distribution",
        security,
        querystring: z.object({ branchId: z.string().uuid().optional() }),
        response: { 200: adminCustomerStatsDtoSchema },
      },
    },
    async (request) => adminOrdersService.getCustomerStats(request.query.branchId)
  );

  server.patch(
    "/customers/:id/status",
    {
      ...baseAdmin,
      schema: {
        tags: ["Admin Customers"],
        summary: "Change customer status (active, blocked, suspended, restricted)",
        security,
        params: idParam,
        body: changeCustomerStatusSchema,
        response: { 200: z.object({ success: z.boolean(), customerId: z.string().uuid(), status: z.string() }) },
      },
    },
    async (request) =>
      adminOrdersService.changeCustomerStatus(
        request.user!,
        request.params.id,
        request.body.status,
        request.body.note,
        meta(request)
      )
  );

  server.delete(
    "/customers/:id",
    {
      ...baseAdmin,
      schema: {
        tags: ["Admin Customers"],
        summary: "Soft-delete a customer (requires no active orders)",
        security,
        params: idParam,
        response: successResponse,
      },
    },
    async (request) => adminOrdersService.deleteCustomer(request.user!, request.params.id, meta(request))
  );

  // ---------- 9. Admin Analytics & Finance ----------
  server.get(
    "/analytics/overview",
    {
      ...baseAdmin,
      schema: {
        tags: ["Admin Analytics"],
        summary: "Get overall system analytics (revenue, order counts, status distribution, top customers)",
        security,
        querystring: adminAnalyticsOverviewQuerySchema,
        response: { 200: adminAnalyticsOverviewDtoSchema },
      },
    },
    async (request) => adminAnalyticsService.getOverview(request.query)
  );

  server.get(
    "/analytics/payments",
    {
      ...baseAdmin,
      schema: {
        tags: ["Admin Analytics"],
        summary: "Get payment method breakdown, revenue by channel, and daily trends",
        security,
        querystring: adminPaymentStatsQuerySchema,
        response: { 200: adminPaymentStatsDtoSchema },
      },
    },
    async (request) => adminAnalyticsService.getPaymentStats(request.query)
  );

  server.get(
    "/analytics/weekly",
    {
      ...baseAdmin,
      schema: {
        tags: ["Admin Analytics"],
        summary: "Get weekly order progress and target comparisons across branches",
        security,
        querystring: adminWeeklyOrderStatsQuerySchema,
        response: { 200: z.array(adminWeeklyBranchStatDtoSchema) },
      },
    },
    async (request) => adminAnalyticsService.getWeeklyOrderStats(request.query)
  );

  // ---------- 10. Admin Cash Reconciliation & Daily Reports ----------
  server.get(
    "/reconciliation/summaries",
    {
      ...baseAdmin,
      schema: {
        tags: ["Admin Reconciliation"],
        summary: "Get branch cash summaries (collected, sent, deducted, outstanding)",
        security,
        querystring: z.object({ sinceTs: z.coerce.number().optional(), untilTs: z.coerce.number().optional() }),
        response: { 200: z.array(adminBranchCashSummaryDtoSchema) },
      },
    },
    async (request) => adminReconciliationService.getBranchCashSummaries(request.query.sinceTs, request.query.untilTs)
  );

  server.get(
    "/reconciliation/history",
    {
      ...baseAdmin,
      schema: {
        tags: ["Admin Reconciliation"],
        summary: "Get all cash reconciliation transactions across branches",
        security,
        querystring: z.object({
          limit: z.coerce.number().int().min(1).max(200).default(50),
          offset: z.coerce.number().int().min(0).default(0),
        }),
        response: { 200: z.array(adminReconciliationDtoSchema) },
      },
    },
    async (request, reply) => {
      const result = await adminReconciliationService.getAllReconciliations(request.query);
      reply.header("X-Total-Count", result.total);
      return result.items;
    }
  );

  server.get(
    "/reconciliation/deductions",
    {
      ...baseAdmin,
      schema: {
        tags: ["Admin Reconciliation"],
        summary: "Get all cash deductions recorded across branches",
        security,
        querystring: z.object({
          limit: z.coerce.number().int().min(1).max(200).default(50),
          offset: z.coerce.number().int().min(0).default(0),
        }),
        response: { 200: z.array(adminDeductionDtoSchema) },
      },
    },
    async (request, reply) => {
      const result = await adminReconciliationService.getAllDeductions(request.query);
      reply.header("X-Total-Count", result.total);
      return result.items;
    }
  );

  server.get(
    "/reports",
    {
      ...baseAdmin,
      schema: {
        tags: ["Admin Reports"],
        summary: "Get all submitted daily reports across branches",
        security,
        querystring: z.object({
          branchId: z.string().uuid().optional(),
          startDate: z.string().optional(),
          endDate: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
          offset: z.coerce.number().int().min(0).default(0),
        }),
        response: { 200: z.array(adminDailyReportDtoSchema) },
      },
    },
    async (request, reply) => {
      const result = await adminReconciliationService.getAllDailyReports(request.query);
      reply.header("X-Total-Count", result.total);
      return result.items;
    }
  );

  server.get(
    "/reports/:id",
    {
      ...baseAdmin,
      schema: {
        tags: ["Admin Reports"],
        summary: "Get single daily report details",
        security,
        params: idParam,
        response: { 200: adminDailyReportDtoSchema },
      },
    },
    async (request) => adminReconciliationService.getDailyReportById(request.params.id)
  );

  // ---------- 11. Admin Loyalty & Vouchers ----------
  server.get(
    "/loyalty/stats",
    {
      ...baseAdmin,
      schema: {
        tags: ["Admin Loyalty"],
        summary: "Get overall loyalty points statistics and top loyalty customers",
        security,
        response: { 200: adminLoyaltyStatsDtoSchema },
      },
    },
    async () => adminLoyaltyService.getLoyaltyStats()
  );

  server.get(
    "/loyalty/transactions",
    {
      ...baseAdmin,
      schema: {
        tags: ["Admin Loyalty"],
        summary: "Get loyalty points transaction ledger",
        security,
        querystring: z.object({
          customerId: z.string().uuid().optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
          offset: z.coerce.number().int().min(0).default(0),
        }),
        response: { 200: z.array(adminLoyaltyTransactionDtoSchema) },
      },
    },
    async (request, reply) => {
      const result = await adminLoyaltyService.getLoyaltyTransactions(request.query);
      reply.header("X-Total-Count", result.total);
      return result.items;
    }
  );

  server.post(
    "/loyalty/adjust",
    {
      ...baseAdmin,
      schema: {
        tags: ["Admin Loyalty"],
        summary: "Manually adjust customer loyalty points balance",
        security,
        body: adminAdjustPointsSchema,
        response: {
          200: z.object({
            success: z.boolean(),
            customerId: z.string().uuid(),
            pointsDelta: z.number(),
            newBalance: z.number(),
            ledgerId: z.string().uuid(),
          }),
        },
      },
    },
    async (request) => adminLoyaltyService.adjustLoyaltyPoints(request.user!, request.body, meta(request))
  );

  server.get(
    "/vouchers",
    {
      ...baseAdmin,
      schema: {
        tags: ["Admin Vouchers"],
        summary: "List all vouchers with usage and validity stats",
        security,
        querystring: z.object({
          branchId: z.string().uuid().optional(),
          isActive: z.preprocess((v) => v === "true" || v === true, z.boolean()).optional(),
          search: z.string().trim().optional(),
          limit: z.coerce.number().int().min(1).max(200).default(100),
          offset: z.coerce.number().int().min(0).default(0),
        }),
        response: { 200: z.array(adminVoucherDtoSchema) },
      },
    },
    async (request, reply) => {
      const result = await adminLoyaltyService.listVouchers(request.query);
      reply.header("X-Total-Count", result.total);
      return result.items;
    }
  );

  server.post(
    "/vouchers",
    {
      ...baseAdmin,
      schema: {
        tags: ["Admin Vouchers"],
        summary: "Create a new voucher",
        security,
        body: adminCreateVoucherSchema,
        response: { 201: adminVoucherDtoSchema },
      },
    },
    async (request, reply) => {
      const voucher = await adminLoyaltyService.createVoucher(request.user!, request.body, meta(request));
      return reply.status(201).send(voucher);
    }
  );

  server.patch(
    "/vouchers/:id",
    {
      ...baseAdmin,
      schema: {
        tags: ["Admin Vouchers"],
        summary: "Update an existing voucher",
        security,
        params: idParam,
        body: adminUpdateVoucherSchema,
        response: { 200: adminVoucherDtoSchema },
      },
    },
    async (request) => adminLoyaltyService.updateVoucher(request.user!, request.params.id, request.body, meta(request))
  );

  server.delete(
    "/vouchers/:id",
    {
      ...baseAdmin,
      schema: {
        tags: ["Admin Vouchers"],
        summary: "Soft-delete a voucher",
        security,
        params: idParam,
        response: successResponse,
      },
    },
    async (request) => adminLoyaltyService.deleteVoucher(request.user!, request.params.id, meta(request))
  );

  server.get(
    "/vouchers/batches",
    {
      ...baseAdmin,
      schema: {
        tags: ["Admin Vouchers"],
        summary: "List voucher batches with total, used, and available counts",
        security,
        querystring: z.object({
          limit: z.coerce.number().int().min(1).max(200).default(50),
          offset: z.coerce.number().int().min(0).default(0),
        }),
        response: { 200: z.array(adminVoucherBatchDtoSchema) },
      },
    },
    async (request, reply) => {
      const result = await adminLoyaltyService.listVoucherBatches(request.query);
      reply.header("X-Total-Count", result.total);
      return result.items;
    }
  );

  server.post(
    "/vouchers/batches",
    {
      ...baseAdmin,
      schema: {
        tags: ["Admin Vouchers"],
        summary: "Generate a batch of unique single-use gift vouchers",
        security,
        body: adminCreateVoucherBatchSchema,
        response: {
          201: z.object({
            batchId: z.string(),
            count: z.number(),
            codes: z.array(z.string()),
          }),
        },
      },
    },
    async (request, reply) => {
      const batch = await adminLoyaltyService.createVoucherBatch(request.user!, request.body, meta(request));
      return reply.status(201).send(batch);
    }
  );

  server.post(
    "/vouchers/batches/:batchId/deactivate",
    {
      ...baseAdmin,
      schema: {
        tags: ["Admin Vouchers"],
        summary: "Deactivate all unredeemed vouchers in a batch",
        security,
        params: z.object({ batchId: z.string() }),
        response: successResponse,
      },
    },
    async (request) => adminLoyaltyService.deactivateVoucherBatch(request.user!, request.params.batchId, meta(request))
  );

  // ---------- 12. Admin Inventory & Maintenance ----------
  server.get(
    "/inventory",
    {
      ...baseAdmin,
      schema: {
        tags: ["Admin Inventory"],
        summary: "List inventory items across branches or filter by branch",
        security,
        querystring: z.object({
          branchId: z.string().uuid().optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
          offset: z.coerce.number().int().min(0).default(0),
        }),
        response: { 200: z.array(adminInventoryItemDtoSchema) },
      },
    },
    async (request, reply) => {
      const result = await adminOperationsService.listInventory(request.query);
      reply.header("X-Total-Count", result.total);
      return result.items;
    }
  );

  server.post(
    "/inventory",
    {
      ...baseAdmin,
      schema: {
        tags: ["Admin Inventory"],
        summary: "Create a new inventory item",
        security,
        body: adminCreateInventoryItemSchema,
        response: successResponse,
      },
    },
    async (request) => adminOperationsService.createInventoryItem(request.user!, request.body, meta(request))
  );

  server.patch(
    "/inventory/:id",
    {
      ...baseAdmin,
      schema: {
        tags: ["Admin Inventory"],
        summary: "Update stock levels or details for an inventory item",
        security,
        params: idParam,
        body: adminUpdateInventoryItemSchema,
        response: successResponse,
      },
    },
    async (request) =>
      adminOperationsService.updateInventoryItem(request.user!, request.params.id, request.body, meta(request))
  );

  server.delete(
    "/inventory/:id",
    {
      ...baseAdmin,
      schema: {
        tags: ["Admin Inventory"],
        summary: "Soft-delete an inventory item",
        security,
        params: idParam,
        response: successResponse,
      },
    },
    async (request) => adminOperationsService.deleteInventoryItem(request.user!, request.params.id, meta(request))
  );

  server.get(
    "/maintenance/tickets",
    {
      ...baseAdmin,
      schema: {
        tags: ["Admin Maintenance"],
        summary: "List machine maintenance tickets",
        security,
        querystring: z.object({
          branchId: z.string().uuid().optional(),
          status: z.enum(["open", "fixed"]).optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
          offset: z.coerce.number().int().min(0).default(0),
        }),
        response: { 200: z.array(adminMaintenanceTicketDtoSchema) },
      },
    },
    async (request, reply) => {
      const result = await adminOperationsService.listMaintenanceTickets(request.query);
      reply.header("X-Total-Count", result.total);
      return result.items;
    }
  );

  server.post(
    "/maintenance/tickets/:id/resolve",
    {
      ...baseAdmin,
      schema: {
        tags: ["Admin Maintenance"],
        summary: "Mark a maintenance ticket as fixed/resolved",
        security,
        params: idParam,
        response: { 200: z.object({ success: z.boolean(), ticketId: z.string().uuid(), status: z.string() }) },
      },
    },
    async (request) => adminOperationsService.markMaintenanceTicketFixed(request.user!, request.params.id, meta(request))
  );

  server.delete(
    "/maintenance/tickets/:id",
    {
      ...baseAdmin,
      schema: {
        tags: ["Admin Maintenance"],
        summary: "Delete a maintenance ticket",
        security,
        params: idParam,
        response: successResponse,
      },
    },
    async (request) => adminOperationsService.deleteMaintenanceTicket(request.user!, request.params.id, meta(request))
  );

  // ---------- 13. Admin Notifications, Settings, Headlines & Audit Logs ----------
  server.get(
    "/notifications",
    {
      ...baseAdmin,
      schema: {
        tags: ["Admin Notifications"],
        summary: "Get notifications feed",
        security,
        querystring: z.object({
          recipientType: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
          offset: z.coerce.number().int().min(0).default(0),
        }),
        response: { 200: z.array(adminNotificationDtoSchema) },
      },
    },
    async (request, reply) => {
      const result = await adminOperationsService.listNotifications(request.query);
      reply.header("X-Total-Count", result.total);
      return result.items;
    }
  );

  server.post(
    "/notifications",
    {
      ...baseAdmin,
      schema: {
        tags: ["Admin Notifications"],
        summary: "Broadcast or send a notification",
        security,
        body: adminCreateNotificationSchema,
        response: successResponse,
      },
    },
    async (request) => adminOperationsService.createNotification(request.user!, request.body, meta(request))
  );

  server.post(
    "/notifications/mark-all-read",
    {
      ...baseAdmin,
      schema: {
        tags: ["Admin Notifications"],
        summary: "Mark all notifications as read",
        security,
        response: successResponse,
      },
    },
    async (request) => adminOperationsService.markAllNotificationsRead(request.user!)
  );

  server.delete(
    "/notifications/:id",
    {
      ...baseAdmin,
      schema: {
        tags: ["Admin Notifications"],
        summary: "Delete a notification",
        security,
        params: idParam,
        response: successResponse,
      },
    },
    async (request) => adminOperationsService.deleteNotification(request.user!, request.params.id, meta(request))
  );

  server.get(
    "/settings",
    {
      ...baseAdmin,
      schema: {
        tags: ["Admin Settings"],
        summary: "Get system configuration settings",
        security,
        response: { 200: adminSystemSettingsDtoSchema },
      },
    },
    async () => adminOperationsService.getSystemSettings()
  );

  server.patch(
    "/settings",
    {
      ...baseAdmin,
      schema: {
        tags: ["Admin Settings"],
        summary: "Update system configuration settings",
        security,
        body: adminUpdateSystemSettingsSchema,
        response: successResponse,
      },
    },
    async (request) => adminOperationsService.updateSystemSettings(request.user!, request.body, meta(request))
  );

  server.get(
    "/headlines",
    {
      ...baseAdmin,
      schema: {
        tags: ["Admin Headlines"],
        summary: "List banner headlines/announcements",
        security,
        querystring: z.object({
          branchId: z.string().uuid().optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
          offset: z.coerce.number().int().min(0).default(0),
        }),
        response: { 200: z.array(adminHeadlineDtoSchema) },
      },
    },
    async (request, reply) => {
      const result = await adminOperationsService.listHeadlines(request.query);
      reply.header("X-Total-Count", result.total);
      return result.items;
    }
  );

  server.post(
    "/headlines",
    {
      ...baseAdmin,
      schema: {
        tags: ["Admin Headlines"],
        summary: "Create a new announcement headline",
        security,
        body: adminCreateHeadlineSchema,
        response: successResponse,
      },
    },
    async (request) => adminOperationsService.createHeadline(request.user!, request.body, meta(request))
  );

  server.delete(
    "/headlines/:id",
    {
      ...baseAdmin,
      schema: {
        tags: ["Admin Headlines"],
        summary: "Remove an announcement headline",
        security,
        params: idParam,
        response: successResponse,
      },
    },
    async (request) => adminOperationsService.deleteHeadline(request.user!, request.params.id, meta(request))
  );

  server.get(
    "/audit-logs",
    {
      ...baseAdmin,
      schema: {
        tags: ["Admin Audit"],
        summary: "Query system audit logs by entity, actor, or date range",
        security,
        querystring: z.object({
          entityType: z.string().optional(),
          entityId: z.string().optional(),
          actorId: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(200).default(100),
          offset: z.coerce.number().int().min(0).default(0),
        }),
        response: { 200: z.array(adminAuditLogDtoSchema) },
      },
    },
    async (request, reply) => {
      const result = await adminOperationsService.listAuditLogs(request.query);
      reply.header("X-Total-Count", result.total);
      return result.items;
    }
  );
}
