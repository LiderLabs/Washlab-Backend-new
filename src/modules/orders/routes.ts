import { FastifyInstance } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { authenticate, optionalAuthenticate } from "../../platform/auth/index.js";
import { orderService } from "./service.js";
import {
  createOnlineOrderSchema,
  orderListQuerySchema,
  orderListResponseSchema,
  trackOrderResponseSchema,
} from "./schemas.js";

export async function orderRoutes(app: FastifyInstance) {
  const server = app.withTypeProvider<ZodTypeProvider>();

  // 1. Create online order (guests or logged-in customers)
  server.post(
    "/online",
    {
      preHandler: [optionalAuthenticate],
      schema: {
        tags: ["Orders"],
        summary: "Create an online laundry order (guest or authenticated customer)",
        body: createOnlineOrderSchema,
      },
    },
    async (request) => {
      return orderService.createOnlineOrder(request.user, request.body, {
        ip: request.ip,
        userAgent: request.headers["user-agent"],
      });
    }
  );

  // 2. Track order by order number (public tracking page)
  server.get(
    "/track/:orderNumber",
    {
      schema: {
        tags: ["Orders"],
        summary: "Track order status and history by public order number",
        params: z.object({
          orderNumber: z.string().trim().min(1),
        }),
        response: {
          200: trackOrderResponseSchema,
        },
      },
    },
    async (request) => {
      return orderService.trackOrderByNumber(request.params.orderNumber);
    }
  );

  // 3. List orders with pagination (customer sees their orders; attendant/admin sees branch/all)
  server.get(
    "/",
    {
      preHandler: [authenticate],
      schema: {
        tags: ["Orders"],
        summary: "List orders with keyset pagination",
        security: [{ bearerAuth: [] }],
        querystring: orderListQuerySchema,
        response: {
          200: orderListResponseSchema,
        },
      },
    },
    async (request) => {
      return orderService.listOrders(request.user!, request.query);
    }
  );

  // 4. Get order details by ID
  server.get(
    "/:id",
    {
      preHandler: [authenticate],
      schema: {
        tags: ["Orders"],
        summary: "Get order details and history by order ID",
        security: [{ bearerAuth: [] }],
        params: z.object({
          id: z.string().uuid(),
        }),
      },
    },
    async (request) => {
      return orderService.getOrderById(request.user!, request.params.id);
    }
  );
}
