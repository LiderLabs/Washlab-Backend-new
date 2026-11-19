import { FastifyInstance, FastifyRequest } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { authenticate, requirePermission, requireRole } from "../../platform/auth/index.js";
import { adminStaffService } from "./service.js";
import { adminBranchesService } from "./branches.service.js";
import { adminOrdersService } from "./orders.service.js";
import {
  adminBranchDtoSchema,
  adminBranchServiceDtoSchema,
  adminCreateBranchSchema,
  adminCustomerDtoSchema,
  adminCustomerStatsDtoSchema,
  adminListCustomersQuerySchema,
  adminListOrdersQuerySchema,
  adminOrderDetailDtoSchema,
  adminOrderSummaryDtoSchema,
  adminUpdateBranchSchema,
  adminUpdateOrderStatusSchema,
  adminUserResponseSchema,
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
    async (request) => adminStaffService.listAttendants(request.query)
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
    async (request) => adminBranchesService.listBranches(request.query.includeInactive)
  );

  server.get(
    "/branches/active",
    {
      ...baseAdmin,
      schema: {
        tags: ["Admin Branches"],
        summary: "List all active branches",
        security,
        response: { 200: z.array(adminBranchDtoSchema) },
      },
    },
    async () => adminBranchesService.listBranches(false)
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
        querystring: z.object({ onlyActive: z.preprocess((v) => v === "true" || v === true, z.boolean()).optional() }),
        response: { 200: z.array(branchMachineDtoSchema) },
      },
    },
    async (request) => adminBranchesService.listMachinesByBranch(request.params.id, request.query.onlyActive)
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
        response: { 200: z.array(branchMachineDtoSchema) },
      },
    },
    async (request) => adminBranchesService.listMachinesByBranch(request.params.id, true)
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
        response: { 200: z.array(catalogServiceDtoSchema) },
      },
    },
    async () => adminBranchesService.listCatalogServices()
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
        response: { 200: z.array(adminBranchServiceDtoSchema) },
      },
    },
    async (request) => adminBranchesService.listBranchServices(request.params.id)
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
    async (request) => adminOrdersService.listOrders(request.query)
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
    async (request) => adminOrdersService.listCustomers(request.query)
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
}
