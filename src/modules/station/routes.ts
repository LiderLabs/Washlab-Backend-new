import { FastifyInstance, FastifyRequest } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { authenticateStation, requireStation, STATION_TOKEN_HEADER } from "../../platform/auth/station.js";
import { stationService } from "./service.js";
import {
  activeAttendanceSchema,
  attendanceResultSchema,
  clockInSchema,
  clockOutSchema,
  createInventoryItemSchema,
  inventoryItemSchema,
  orderInventorySchema,
  requestInventoryOrderSchema,
  successSchema,
  activeBranchSchema,
  branchByCodeSchema,
  receiveInventorySchema,
  stationActivityLogSchema,
  stationActivityQuerySchema,
  stationAttendanceHistoryItemSchema,
  stationAttendanceHistoryQuerySchema,
  stationAttendantSchema,
  stationInfoResponseSchema,
  stationLoginResponseSchema,
  stationLoginSchema,
  stationMachineSchema,
  stationNotificationSchema,
  stationServiceSchema,
  stationSessionResponseSchema,
  stationStatsQuerySchema,
  stationStatsResponseSchema,
  stationTransactionsQuerySchema,
  stationTransactionSchema,
  stationUnreadCountResponseSchema,
  updateStockSchema,
  verifyAttendantPinResponseSchema,
  verifyAttendantPinSchema,
} from "./schemas.js";

const meta = (req: FastifyRequest) => ({ ip: req.ip, userAgent: req.headers["user-agent"] });

// Every attendant at a branch shares one IP, so limit station traffic per session token instead of per IP.
const perStationLimit = {
  rateLimit: {
    max: 300,
    timeWindow: "1 minute",
    keyGenerator: (req: FastifyRequest) => String(req.headers[STATION_TOKEN_HEADER] ?? req.ip),
  },
};
const security = [{ stationToken: [] }];
const base = { onRequest: [authenticateStation], config: perStationLimit };
const idParam = z.object({ id: z.string().uuid() });

export async function stationRoutes(app: FastifyInstance) {
  const server = app.withTypeProvider<ZodTypeProvider>();

  // The tablet needs these BEFORE it can log in (pick a branch, or type its code), so they are public.
  // Only non-sensitive branch details are returned, and they are rate limited per IP.
  const publicLimit = { rateLimit: { max: 60, timeWindow: "1 minute" } };

  server.get(
    "/branches",
    {
      config: publicLimit,
      schema: {
        tags: ["Station"],
        summary: "Active branches (code and name) for the station login screen",
        response: { 200: z.array(activeBranchSchema) },
      },
    },
    async () => stationService.listActiveBranches()
  );

  server.get(
    "/branches/by-code/:code",
    {
      config: publicLimit,
      schema: {
        tags: ["Station"],
        summary: "Look up a branch by its code (case-insensitive) to start station login",
        params: z.object({ code: z.string().trim().min(1).max(32) }),
        response: { 200: branchByCodeSchema },
      },
    },
    async (request) => stationService.getBranchByCode(request.params.code)
  );

  server.post(
    "/login",
    {
      // PIN guessing: tight per-IP limit here, plus a DB lockout per branch in the service.
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: {
        tags: ["Station"],
        summary: "Log a device in to a branch with the station PIN",
        body: stationLoginSchema,
        response: { 200: stationLoginResponseSchema },
      },
    },
    async (request) => stationService.login(request.body, meta(request))
  );

  server.post(
    "/logout",
    {
      ...base,
      schema: {
        tags: ["Station"],
        summary: "End this station session",
        security,
        response: { 200: z.object({ success: z.boolean() }) },
      },
    },
    async (request) => stationService.logout(requireStation(request), meta(request))
  );

  server.get(
    "/session",
    {
      ...base,
      schema: {
        tags: ["Station"],
        summary: "Current station session and branch",
        security,
        response: { 200: stationSessionResponseSchema },
      },
    },
    async (request) => stationService.getSession(requireStation(request))
  );

  server.get(
    "/info",
    {
      ...base,
      schema: {
        tags: ["Station"],
        summary: "Station branch details, settings, and device info",
        security,
        response: { 200: stationInfoResponseSchema },
      },
    },
    async (request) => stationService.getInfo(requireStation(request))
  );

  server.get(
    "/stats",
    {
      ...base,
      schema: {
        tags: ["Station"],
        summary: "Station analytics and order metrics for the shift/date range",
        security,
        querystring: stationStatsQuerySchema,
        response: { 200: stationStatsResponseSchema },
      },
    },
    async (request) => stationService.getStats(requireStation(request), request.query)
  );

  server.get(
    "/transactions",
    {
      ...base,
      schema: {
        tags: ["Station"],
        summary: "Recent payment transactions at this station",
        security,
        querystring: stationTransactionsQuerySchema,
        response: { 200: z.array(stationTransactionSchema) },
      },
    },
    async (request) => stationService.getTransactions(requireStation(request), request.query)
  );

  server.get(
    "/activity",
    {
      ...base,
      schema: {
        tags: ["Station"],
        summary: "Recent activity audit logs for this station",
        security,
        querystring: stationActivityQuerySchema,
        response: { 200: z.array(stationActivityLogSchema) },
      },
    },
    async (request) => stationService.getActivity(requireStation(request), request.query)
  );

  server.get(
    "/attendants",
    {
      ...base,
      schema: {
        tags: ["Station"],
        summary: "Attendants who can clock in at this branch",
        security,
        response: { 200: z.array(stationAttendantSchema) },
      },
    },
    async (request) => stationService.listAttendants(requireStation(request).branchId)
  );

  server.get(
    "/attendance/active",
    {
      ...base,
      schema: {
        tags: ["Station"],
        summary: "Attendants currently clocked in at this branch",
        security,
        response: { 200: z.array(activeAttendanceSchema) },
      },
    },
    async (request) => stationService.activeAttendances(requireStation(request).branchId)
  );

  server.get(
    "/attendance/history",
    {
      ...base,
      schema: {
        tags: ["Station"],
        summary: "Station attendance history logs",
        security,
        querystring: stationAttendanceHistoryQuerySchema,
        response: { 200: z.array(stationAttendanceHistoryItemSchema) },
      },
    },
    async (request) => stationService.getAttendanceHistory(requireStation(request), request.query)
  );

  server.post(
    "/attendance/clock-in",
    {
      ...base,
      schema: {
        tags: ["Station"],
        summary: "Clock an attendant in with their PIN",
        security,
        body: clockInSchema,
        response: { 200: attendanceResultSchema },
      },
    },
    async (request) => stationService.clockIn(requireStation(request), request.body, meta(request))
  );

  server.post(
    "/attendance/clock-out",
    {
      ...base,
      schema: {
        tags: ["Station"],
        summary: "Clock an attendant out with their PIN",
        security,
        body: clockOutSchema,
        response: { 200: attendanceResultSchema },
      },
    },
    async (request) => stationService.clockOut(requireStation(request), request.body, meta(request))
  );

  server.post(
    "/verify-pin",
    {
      ...base,
      schema: {
        tags: ["Station"],
        summary: "Verify an attendant PIN before critical action",
        security,
        body: verifyAttendantPinSchema,
        response: { 200: verifyAttendantPinResponseSchema },
      },
    },
    async (request) => stationService.verifyActionPin(requireStation(request), request.body)
  );

  // ---------- Inventory ----------

  server.get(
    "/inventory",
    {
      ...base,
      schema: {
        tags: ["Station"],
        summary: "List inventory items for this branch",
        security,
        response: { 200: z.array(inventoryItemSchema) },
      },
    },
    async (request) => stationService.listInventory(requireStation(request))
  );

  server.post(
    "/inventory",
    {
      ...base,
      schema: {
        tags: ["Station"],
        summary: "Create a new inventory item",
        security,
        body: createInventoryItemSchema,
        response: { 200: inventoryItemSchema },
      },
    },
    async (request) => stationService.createInventory(requireStation(request), request.body)
  );

  server.patch(
    "/inventory/:id/stock",
    {
      ...base,
      schema: {
        tags: ["Station"],
        summary: "Update current stock level for an inventory item",
        security,
        params: idParam,
        body: updateStockSchema,
        response: { 200: inventoryItemSchema },
      },
    },
    async (request) => stationService.updateStock(requireStation(request), request.params.id, request.body)
  );

  server.post(
    "/inventory/:id/order",
    {
      ...base,
      schema: {
        tags: ["Station"],
        summary: "Record reorder for an inventory item",
        security,
        params: idParam,
        body: orderInventorySchema,
        response: { 200: inventoryItemSchema },
      },
    },
    async (request) => stationService.orderInventory(requireStation(request), request.params.id, request.body)
  );

  server.post(
    "/inventory/:id/request-order",
    {
      ...base,
      schema: {
        tags: ["Station"],
        summary: "Ask head office to reorder an item (notifies admins and marks it ordered)",
        security,
        params: idParam,
        body: requestInventoryOrderSchema,
        response: { 200: successSchema },
      },
    },
    async (request) => stationService.requestInventoryOrder(requireStation(request), request.params.id, request.body)
  );

  server.post(
    "/inventory/:id/receive",
    {
      ...base,
      schema: {
        tags: ["Station"],
        summary: "Receive ordered stock for an inventory item",
        security,
        params: idParam,
        body: receiveInventorySchema,
        response: { 200: inventoryItemSchema },
      },
    },
    async (request) => stationService.receiveInventory(requireStation(request), request.params.id, request.body)
  );

  // ---------- Notifications ----------

  server.get(
    "/notifications",
    {
      ...base,
      schema: {
        tags: ["Station"],
        summary: "List notifications for this station",
        security,
        response: { 200: z.array(stationNotificationSchema) },
      },
    },
    async (request) => stationService.listNotifications(requireStation(request))
  );

  server.get(
    "/notifications/unread-count",
    {
      ...base,
      schema: {
        tags: ["Station"],
        summary: "Get unread notifications count for this station",
        security,
        response: { 200: stationUnreadCountResponseSchema },
      },
    },
    async (request) => stationService.getUnreadNotificationCount(requireStation(request))
  );

  server.post(
    "/notifications/:id/read",
    {
      ...base,
      schema: {
        tags: ["Station"],
        summary: "Mark notification as read",
        security,
        params: idParam,
        response: { 200: z.object({ success: z.boolean() }) },
      },
    },
    async (request) => stationService.markNotificationRead(requireStation(request), request.params.id)
  );

  server.post(
    "/notifications/read-all",
    {
      ...base,
      schema: {
        tags: ["Station"],
        summary: "Mark all notifications as read",
        security,
        response: { 200: z.object({ success: z.boolean() }) },
      },
    },
    async (request) => stationService.markAllNotificationsRead(requireStation(request))
  );

  // ---------- Catalog (Machines & Services) ----------

  server.get(
    "/machines",
    {
      ...base,
      schema: {
        tags: ["Station"],
        summary: "List active machines for this branch",
        security,
        response: { 200: z.array(stationMachineSchema) },
      },
    },
    async (request) => stationService.listMachines(requireStation(request))
  );

  server.get(
    "/services",
    {
      ...base,
      schema: {
        tags: ["Station"],
        summary: "List active services for this branch",
        security,
        response: { 200: z.array(stationServiceSchema) },
      },
    },
    async (request) => stationService.listServices(requireStation(request))
  );
}
