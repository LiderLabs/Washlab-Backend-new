import { FastifyInstance } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { authenticate } from "../../platform/auth/index.js";
import { customerService } from "./service.js";
import { loyaltyRedemptionService } from "../loyalty/redemption.service.js";
import {
  checkRoleResponseSchema,
  customerLoyaltyBalanceSchema,
  customerLoyaltyTransactionSchema,
  customerNotificationSchema,
  customerOrderSchema,
  customerPaymentSchema,
  customerProfileResponseSchema,
  paginationQuerySchema,
  registerCustomerSchema,
  updateCustomerProfileSchema,
} from "./schemas.js";

const security = [{ bearerAuth: [] }];
const base = { onRequest: [authenticate] };
const idParam = z.object({ id: z.string().uuid() });
const redeemLoyaltyBody = z.object({ pointsToRedeem: z.number().int().min(10).multipleOf(10) });
const redeemLoyaltyResponse = z.object({
  orderId: z.string().uuid(),
  pointsRedeemed: z.number().int(),
  pointsRemaining: z.number().int(),
  discountPesewas: z.union([z.number(), z.string()]),
  amountDuePesewas: z.union([z.number(), z.string()]),
});

export async function customerRoutes(app: FastifyInstance) {
  const server = app.withTypeProvider<ZodTypeProvider>();

  // Profile & Registration
  server.get(
    "/profile",
    {
      ...base,
      schema: {
        tags: ["Customers"],
        summary: "Get current customer profile with order counts and loyalty balance",
        security,
        response: { 200: customerProfileResponseSchema },
      },
    },
    async (request) => customerService.getProfile(request.user!.id)
  );

  server.post(
    "/orders/:id/loyalty/redeem",
    {
      ...base,
      schema: {
        tags: ["Customer Loyalty"],
        summary: "Redeem loyalty points against one of the customer's unpaid orders",
        security,
        params: idParam,
        body: redeemLoyaltyBody,
        response: { 200: redeemLoyaltyResponse },
      },
    },
    async (request) =>
      loyaltyRedemptionService.redeemForOrder(
        { kind: "customer", clerkUserId: request.user!.id },
        request.params.id,
        request.body.pointsToRedeem,
      )
  );

  server.post(
    "/register",
    {
      ...base,
      schema: {
        tags: ["Customers"],
        summary: "Register customer profile for authenticated Clerk user",
        security,
        body: registerCustomerSchema,
        response: { 200: customerProfileResponseSchema },
      },
    },
    async (request) => customerService.register(request.user!.id, request.body)
  );

  server.patch(
    "/profile",
    {
      ...base,
      schema: {
        tags: ["Customers"],
        summary: "Update current customer profile details",
        security,
        body: updateCustomerProfileSchema,
        response: { 200: customerProfileResponseSchema },
      },
    },
    async (request) => customerService.updateProfile(request.user!.id, request.body)
  );

  server.get(
    "/check-role",
    {
      ...base,
      schema: {
        tags: ["Customers"],
        summary: "Check if authenticated user is admin, attendant, or customer",
        security,
        response: { 200: checkRoleResponseSchema },
      },
    },
    async (request) => customerService.checkRole(request.user!.id)
  );

  // Customer Orders
  server.get(
    "/orders",
    {
      ...base,
      schema: {
        tags: ["Customers"],
        summary: "Get customer order history",
        security,
        querystring: paginationQuerySchema,
        response: { 200: z.array(customerOrderSchema) },
      },
    },
    async (request, reply) => {
      const result = await customerService.getOrders(request.user!.id, request.query);
      reply.header("X-Total-Count", result.total);
      return result.items;
    }
  );

  server.get(
    "/orders/active",
    {
      ...base,
      schema: {
        tags: ["Customers"],
        summary: "Get customer active in-progress orders (not completed or cancelled)",
        security,
        querystring: paginationQuerySchema,
        response: { 200: z.array(customerOrderSchema) },
      },
    },
    async (request, reply) => {
      const result = await customerService.getActiveOrders(request.user!.id, request.query);
      reply.header("X-Total-Count", result.total);
      return result.items;
    }
  );

  // Loyalty
  server.get(
    "/loyalty",
    {
      ...base,
      schema: {
        tags: ["Customers"],
        summary: "Get customer loyalty balance and points earned/redeemed",
        security,
        response: { 200: customerLoyaltyBalanceSchema },
      },
    },
    async (request) => customerService.getLoyaltyBalance(request.user!.id)
  );

  server.get(
    "/loyalty/transactions",
    {
      ...base,
      schema: {
        tags: ["Customers"],
        summary: "Get customer loyalty ledger transactions history",
        security,
        querystring: paginationQuerySchema,
        response: { 200: z.array(customerLoyaltyTransactionSchema) },
      },
    },
    async (request, reply) => {
      const result = await customerService.getLoyaltyTransactions(request.user!.id, request.query);
      reply.header("X-Total-Count", result.total);
      return result.items;
    }
  );

  // Notifications
  server.get(
    "/notifications",
    {
      ...base,
      schema: {
        tags: ["Customers"],
        summary: "Get customer notifications",
        security,
        querystring: paginationQuerySchema,
        response: { 200: z.array(customerNotificationSchema) },
      },
    },
    async (request, reply) => {
      const result = await customerService.getNotifications(request.user!.id, request.query);
      reply.header("X-Total-Count", result.total);
      return result.items;
    }
  );

  server.get(
    "/notifications/unread-count",
    {
      ...base,
      schema: {
        tags: ["Customers"],
        summary: "Get customer unread notifications count",
        security,
        response: { 200: z.object({ unreadCount: z.number() }) },
      },
    },
    async (request) => customerService.getUnreadNotificationsCount(request.user!.id)
  );

  server.post(
    "/notifications/:id/read",
    {
      ...base,
      schema: {
        tags: ["Customers"],
        summary: "Mark customer notification as read",
        security,
        params: idParam,
        response: { 200: z.object({ success: z.boolean() }) },
      },
    },
    async (request) => customerService.markNotificationRead(request.user!.id, request.params.id)
  );

  server.post(
    "/notifications/read-all",
    {
      ...base,
      schema: {
        tags: ["Customers"],
        summary: "Mark all customer notifications as read",
        security,
        response: { 200: z.object({ success: z.boolean() }) },
      },
    },
    async (request) => customerService.markAllNotificationsRead(request.user!.id)
  );

  server.delete(
    "/notifications/:id",
    {
      ...base,
      schema: {
        tags: ["Customers"],
        summary: "Delete customer notification",
        security,
        params: idParam,
        response: { 200: z.object({ success: z.boolean() }) },
      },
    },
    async (request) => customerService.deleteNotification(request.user!.id, request.params.id)
  );

  // Payments
  server.get(
    "/payments",
    {
      ...base,
      schema: {
        tags: ["Customers"],
        summary: "Get customer payment history",
        security,
        querystring: paginationQuerySchema,
        response: { 200: z.array(customerPaymentSchema) },
      },
    },
    async (request, reply) => {
      const result = await customerService.getPayments(request.user!.id, request.query);
      reply.header("X-Total-Count", result.total);
      return result.items;
    }
  );
}
