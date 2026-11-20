import { FastifyInstance, FastifyRequest } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { authenticateStation, requireStation, STATION_TOKEN_HEADER } from "../../platform/auth/station.js";
import { stationOrdersService as svc } from "./orders.service.js";
import { finalizeBody, finalizeResponse } from "./cash.schemas.js";
import { stationService } from "./service.js";
import {
  customerLoyaltySchema,
  stationPaymentInputSchema,
  stationPaymentResponseSchema,
  stationVoucherValidateInputSchema,
  stationVoucherValidateResponseSchema,
} from "./schemas.js";
import {
  cancelOrderSchema,
  checkInSchema,
  createCustomerSchema,
  customerRefSchema,
  customerResultSchema,
  customerSearchQuery,
  listOrdersQuery,
  orderDetailSchema,
  orderIdParams,
  orderListResponseSchema,
  stationOrderSchema,
  updateOrderSchema,
  updateStatusSchema,
  walkInOrderSchema,
} from "./orders.schemas.js";

const meta = (req: FastifyRequest) => ({ ip: req.ip, userAgent: req.headers["user-agent"] });
const security = [{ stationToken: [] }];
const paginationQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
const perStationLimit = {
  rateLimit: {
    max: 300,
    timeWindow: "1 minute",
    keyGenerator: (req: FastifyRequest) => String(req.headers[STATION_TOKEN_HEADER] ?? req.ip),
  },
};
const base = { onRequest: [authenticateStation], config: perStationLimit };

/** Attendant-app order endpoints. Mounted under /v1/station. All require the x-station-token header. */
export async function stationOrderRoutes(app: FastifyInstance) {
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.get(
    "/customers/:id/loyalty",
    {
      ...base,
      schema: {
        tags: ["Station orders"],
        summary: "A customer's loyalty points (balance, earned, redeemed)",
        security,
        params: z.object({ id: z.string().uuid() }),
        response: { 200: customerLoyaltySchema },
      },
    },
    async (request) => svc.getCustomerLoyalty(request.params.id)
  );

  server.post(
    "/vouchers/validate",
    {
      ...base,
      schema: {
        tags: ["Station orders"],
        summary: "Validate a voucher code for station order payment",
        security,
        body: stationVoucherValidateInputSchema,
        response: { 200: stationVoucherValidateResponseSchema },
      },
    },
    async (request) => svc.validateVoucher(requireStation(request), request.body)
  );

  server.get(
    "/vouchers/active",
    {
      ...base,
      schema: {
        tags: ["Station orders"],
        summary: "Get active vouchers for station datalist autocomplete",
        security,
        querystring: paginationQuery,
      },
    },
    async (request, reply) => {
      const result = await svc.listActiveVouchers(requireStation(request), request.query);
      reply.header("X-Total-Count", result.total);
      return result.items;
    }
  );

  server.get(
    "/customers/search",
    {
      ...base,
      schema: {
        tags: ["Station orders"],
        summary: "Search customers by name or phone",
        security,
        querystring: customerSearchQuery,
        response: { 200: z.array(customerResultSchema) },
      },
    },
    async (request, reply) => {
      const result = await svc.searchCustomers(request.query.q, request.query.limit, request.query.offset);
      reply.header("X-Total-Count", result.total);
      return result.items;
    }
  );

  server.post(
    "/customers",
    {
      ...base,
      schema: {
        tags: ["Station orders"],
        summary: "Find a customer by phone or register a new walk-in customer",
        security,
        body: createCustomerSchema,
        response: { 200: z.object({ created: z.boolean(), customer: customerRefSchema }) },
      },
    },
    async (request) => {
      const { customer, created } = await svc.findOrCreateCustomer(requireStation(request), request.body, meta(request));
      return {
        created,
        customer: { id: customer.id, name: customer.name, phoneNumber: customer.phoneNumber, email: customer.email },
      };
    }
  );

  server.get(
    "/orders",
    {
      ...base,
      schema: {
        tags: ["Station orders"],
        summary: "Orders at this branch, newest first (keyset pagination)",
        security,
        querystring: listOrdersQuery,
        response: { 200: orderListResponseSchema },
      },
    },
    async (request) => svc.listOrders(requireStation(request), request.query)
  );

  server.get(
    "/orders/bag-numbers",
    {
      ...base,
      schema: {
        tags: ["Station orders"],
        summary: "Bag numbers currently in use at this branch",
        security,
        querystring: paginationQuery,
        response: { 200: z.array(z.string()) },
      },
    },
    async (request, reply) => {
      const result = await svc.activeBagNumbers(requireStation(request).branchId, request.query);
      reply.header("X-Total-Count", result.total);
      return result.items;
    }
  );

  server.get(
    "/orders/:id",
    {
      ...base,
      schema: {
        tags: ["Station orders"],
        summary: "Order detail with status history and payments",
        security,
        params: orderIdParams,
        response: { 200: orderDetailSchema },
      },
    },
    async (request) => svc.getOrder(requireStation(request), request.params.id)
  );

  server.post(
    "/orders/walk-in",
    {
      ...base,
      schema: {
        tags: ["Station orders"],
        summary: "Create a walk-in order (weighed and bagged at the counter)",
        security,
        body: walkInOrderSchema,
        response: { 200: stationOrderSchema },
      },
    },
    async (request) => svc.createWalkIn(requireStation(request), request.body, meta(request))
  );

  server.post(
    "/orders/:id/check-in",
    {
      ...base,
      schema: {
        tags: ["Station orders"],
        summary: "Check in an online order when the laundry arrives (weigh, bag, price)",
        security,
        params: orderIdParams,
        body: checkInSchema,
        response: { 200: stationOrderSchema },
      },
    },
    async (request) => svc.checkInOnline(requireStation(request), request.params.id, request.body, meta(request))
  );

  server.patch(
    "/orders/:id",
    {
      ...base,
      schema: {
        tags: ["Station orders"],
        summary: "Edit an unpaid order (service, weight, extra loads, bag, notes); reprices",
        security,
        params: orderIdParams,
        body: updateOrderSchema,
        response: { 200: stationOrderSchema },
      },
    },
    async (request) => svc.updateDetails(requireStation(request), request.params.id, request.body, meta(request))
  );

  server.post(
    "/orders/:id/status",
    {
      ...base,
      schema: {
        tags: ["Station orders"],
        summary: "Move an order to a new status",
        security,
        params: orderIdParams,
        body: updateStatusSchema,
        response: { 200: stationOrderSchema },
      },
    },
    async (request) => svc.updateStatus(requireStation(request), request.params.id, request.body, meta(request))
  );

  server.post(
    "/orders/:id/cancel",
    {
      ...base,
      schema: {
        tags: ["Station orders"],
        summary: "Cancel an online order that is still waiting for drop-off",
        security,
        params: orderIdParams,
        body: cancelOrderSchema,
        response: { 200: stationOrderSchema },
      },
    },
    async (request) => svc.cancelOnline(requireStation(request), request.params.id, request.body, meta(request))
  );

  server.post(
    "/orders/:id/payment",
    {
      ...base,
      schema: {
        tags: ["Station orders"],
        summary: "Record payment for an order at the station (cash or mobile money)",
        security,
        params: orderIdParams,
        body: stationPaymentInputSchema,
        response: { 200: stationPaymentResponseSchema },
      },
    },
    async (request) =>
      svc.recordPayment(requireStation(request), request.params.id, request.body, meta(request))
  );

  server.post(
    "/orders/:id/payment/finalize",
    {
      ...base,
      schema: {
        tags: ["Station orders"],
        summary: "After the Paystack popup: verify the reference with Paystack server-side and mark the order paid",
        security,
        params: orderIdParams,
        body: finalizeBody,
        response: { 200: finalizeResponse },
      },
    },
    async (request) => svc.finalizePayment(requireStation(request), request.params.id, request.body.reference)
  );
}
