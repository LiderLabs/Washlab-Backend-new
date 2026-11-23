import { FastifyInstance, FastifyRequest } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { authenticate, requireRole } from "../../platform/auth/index.js";
import { authenticateStation, requireStation } from "../../platform/auth/station.js";
import { stationService } from "../station/service.js";
import { subscriptionService } from "./service.js";
import { subscriptionPromoImagesService } from "./promo-images.service.js";
import {
  adminSubscriptionPlanSchema,
  buySubscriptionResponseSchema,
  buySubscriptionSchema,
  guestBuySubscriptionSchema,
  promoImageCreateSchema,
  promoImageReorderSchema,
  promoImageSchema,
  promoImageUpdateSchema,
  subscriptionPurchaseStatusSchema,
  createSubscriptionPlanSchema,
  customerSubscriptionSchema,
  paginationQuerySchema,
  redeemSubscriptionResponseSchema,
  redeemSubscriptionSchema,
  sendSubscriptionOtpResponseSchema,
  sendSubscriptionOtpSchema,
  subscriptionPlanSchema,
  subscriptionPlansQuerySchema,
  verifySubscriptionPurchaseSchema,
  stationSubscriptionLookupSchema,
  subscriptionSuccessSchema,
  updateSubscriptionPlanSchema,
} from "./schemas.js";

const bearerSecurity = [{ bearerAuth: [] }];
const stationSecurity = [{ stationToken: [] }];
const customerBase = { onRequest: [authenticate, requireRole("customer")] };
const adminBase = { onRequest: [authenticate, requireRole("super_admin", "admin")] };
const stationBase = {
  onRequest: [authenticateStation],
  config: {
    rateLimit: {
      max: 60,
      timeWindow: "1 minute",
      keyGenerator: (request: FastifyRequest) => String(request.headers["x-station-token"] ?? request.ip),
    },
  },
};
const idParam = z.object({ id: z.string().uuid() });

const meta = (request: FastifyRequest) => ({ ip: request.ip, userAgent: request.headers["user-agent"] });

export async function customerSubscriptionRoutes(app: FastifyInstance) {
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.get(
    "/subscriptions/plans",
    {
      schema: {
        tags: ["Customer Subscriptions"],
        summary: "List active subscription plans",
        querystring: subscriptionPlansQuerySchema,
        response: { 200: z.array(subscriptionPlanSchema) },
      },
    },
    async (request) => subscriptionService.listPlans({ activeOnly: true, branchId: request.query.branchId })
  );

  server.get(
    "/subscriptions/promo-images",
    {
      schema: {
        tags: ["Customer Subscriptions"],
        summary: "List active subscription promotion images",
        response: { 200: z.array(promoImageSchema) },
      },
    },
    async () => (await subscriptionPromoImagesService.listActive()).map(promoImageDto)
  );

  server.post(
    "/subscriptions/guest-buy",
    {
      schema: {
        tags: ["Customer Subscriptions"],
        summary: "Create a pending subscription purchase for a guest",
        body: guestBuySubscriptionSchema,
        response: { 200: buySubscriptionResponseSchema },
      },
    },
    async (request) => subscriptionService.guestBuy(request.body)
  );

  server.post(
    "/subscriptions/verify",
    {
      schema: {
        tags: ["Customer Subscriptions"],
        summary: "Verify a Paystack subscription purchase and activate it if paid",
        body: verifySubscriptionPurchaseSchema,
        response: { 200: subscriptionPurchaseStatusSchema },
      },
    },
    async (request) => subscriptionService.verifyPurchase(request.body.reference)
  );

  server.post(
    "/subscriptions/buy",
    {
      ...customerBase,
      schema: {
        tags: ["Customer Subscriptions"],
        summary: "Create a pending subscription purchase and Paystack reference",
        security: bearerSecurity,
        body: buySubscriptionSchema,
        response: { 200: buySubscriptionResponseSchema },
      },
    },
    async (request) =>
      subscriptionService.buy(request.user!.id, request.body.planId, request.body.purchaseBranchId)
  );

  server.get(
    "/subscriptions/me",
    {
      ...customerBase,
      schema: {
        tags: ["Customer Subscriptions"],
        summary: "List the authenticated customer's subscriptions and remaining loads",
        security: bearerSecurity,
        response: { 200: z.array(customerSubscriptionSchema) },
      },
    },
    async (request) => subscriptionService.mySubscriptions(request.user!.id)
  );
}

export async function stationSubscriptionRoutes(app: FastifyInstance) {
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.get(
    "/subscriptions/lookup",
    {
      ...stationBase,
      schema: {
        tags: ["Station Subscriptions"],
        summary: "Find subscriptions by customer phone number or subscription code",
        security: stationSecurity,
        querystring: stationSubscriptionLookupSchema,
        response: { 200: z.array(customerSubscriptionSchema) },
      },
    },
    async (request) => subscriptionService.lookup(requireStation(request), request.query.query)
  );

  server.post(
    "/subscriptions/send-otp",
    {
      ...stationBase,
      schema: {
        tags: ["Station Subscriptions"],
        summary: "Send a one-time subscription redemption code (mock delivery)",
        security: stationSecurity,
        body: sendSubscriptionOtpSchema,
        response: { 200: sendSubscriptionOtpResponseSchema },
      },
    },
    async (request) => {
      const station = requireStation(request);
      await stationService.verifyActionPin(station, {
        attendantId: request.body.attendantId,
        pin: request.body.pin,
      });
      const { otpCode, ...result } = await subscriptionService.sendOtp(
        station,
        request.body.subscriptionId,
        request.body.attendantId
      );
      request.log.info({ subscriptionId: request.body.subscriptionId, otp: otpCode }, "Mock subscription OTP delivery");
      return { success: true, ...result };
    }
  );

  server.post(
    "/subscriptions/redeem",
    {
      ...stationBase,
      schema: {
        tags: ["Station Subscriptions"],
        summary: "Redeem subscription loads against an unpaid order",
        security: stationSecurity,
        body: redeemSubscriptionSchema,
        response: { 200: redeemSubscriptionResponseSchema },
      },
    },
    async (request) => {
      const station = requireStation(request);
      await stationService.verifyActionPin(station, {
        attendantId: request.body.attendantId,
        pin: request.body.pin,
      });
      return subscriptionService.redeem(station, request.body);
    }
  );
}

export async function adminSubscriptionRoutes(app: FastifyInstance) {
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.get(
    "/subscriptions/promo-images",
    {
      ...adminBase,
      schema: {
        tags: ["Admin Subscriptions"],
        summary: "List all subscription promotion images",
        security: bearerSecurity,
        response: { 200: z.array(promoImageSchema) },
      },
    },
    async () => (await subscriptionPromoImagesService.listAll()).map(promoImageDto)
  );

  server.post(
    "/subscriptions/promo-images",
    {
      ...adminBase,
      schema: {
        tags: ["Admin Subscriptions"],
        summary: "Create a subscription promotion image",
        security: bearerSecurity,
        body: promoImageCreateSchema,
        response: { 201: promoImageSchema },
      },
    },
    async (request, reply) => reply.status(201).send(promoImageDto(await subscriptionPromoImagesService.create(request.body)))
  );

  server.put(
    "/subscriptions/promo-images/order",
    {
      ...adminBase,
      schema: {
        tags: ["Admin Subscriptions"],
        summary: "Reorder subscription promotion images",
        security: bearerSecurity,
        body: promoImageReorderSchema,
        response: { 200: z.object({ success: z.boolean() }) },
      },
    },
    async (request) => subscriptionPromoImagesService.reorder(request.body.ids)
  );

  server.patch(
    "/subscriptions/promo-images/:id",
    {
      ...adminBase,
      schema: {
        tags: ["Admin Subscriptions"],
        summary: "Update a subscription promotion image",
        security: bearerSecurity,
        params: idParam,
        body: promoImageUpdateSchema,
        response: { 200: promoImageSchema },
      },
    },
    async (request) => promoImageDto(await subscriptionPromoImagesService.update(request.params.id, request.body))
  );

  server.delete(
    "/subscriptions/promo-images/:id",
    {
      ...adminBase,
      schema: {
        tags: ["Admin Subscriptions"],
        summary: "Delete a subscription promotion image",
        security: bearerSecurity,
        params: idParam,
        response: { 200: subscriptionSuccessSchema },
      },
    },
    async (request) => subscriptionPromoImagesService.remove(request.params.id)
  );

  server.get(
    "/subscriptions/plans",
    {
      ...adminBase,
      schema: {
        tags: ["Admin Subscriptions"],
        summary: "List subscription plans and active sales counts",
        security: bearerSecurity,
        response: { 200: z.array(adminSubscriptionPlanSchema) },
      },
    },
    async (request) => subscriptionService.adminPlans(request.user!.staffId ?? "")
  );

  server.post(
    "/subscriptions/plans",
    {
      ...adminBase,
      schema: {
        tags: ["Admin Subscriptions"],
        summary: "Create a subscription plan",
        security: bearerSecurity,
        body: createSubscriptionPlanSchema,
        response: { 200: subscriptionPlanSchema },
      },
    },
    async (request) =>
      subscriptionService.createPlan(request.user!.staffId ?? "", request.body, meta(request))
  );

  server.patch(
    "/subscriptions/plans/:id",
    {
      ...adminBase,
      schema: {
        tags: ["Admin Subscriptions"],
        summary: "Update a subscription plan",
        security: bearerSecurity,
        params: idParam,
        body: updateSubscriptionPlanSchema,
        response: { 200: subscriptionPlanSchema },
      },
    },
    async (request) =>
      subscriptionService.updatePlan(request.user!.staffId ?? "", request.params.id, request.body, meta(request))
  );

  server.get(
    "/subscriptions/active",
    {
      ...adminBase,
      schema: {
        tags: ["Admin Subscriptions"],
        summary: "List active customer subscriptions",
        security: bearerSecurity,
        querystring: paginationQuerySchema,
        response: { 200: z.array(customerSubscriptionSchema) },
      },
    },
    async (request, reply) => {
      const result = await subscriptionService.adminActiveSubscriptions(request.user!.staffId ?? "", request.query);
      reply.header("X-Total-Count", result.total);
      return result.items;
    }
  );

  server.delete(
    "/subscriptions/plans/:id",
    {
      ...adminBase,
      schema: {
        tags: ["Admin Subscriptions"],
        summary: "Deactivate a subscription plan",
        security: bearerSecurity,
        params: idParam,
        response: { 200: subscriptionSuccessSchema },
      },
    },
    async (request) =>
      subscriptionService.deletePlan(request.user!.staffId ?? "", request.params.id, meta(request))
  );
}

function promoImageDto(image: {
  id: string;
  title: string;
  imageUrl: string;
  isActive: boolean;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    ...image,
    createdAt: image.createdAt.toISOString(),
    updatedAt: image.updatedAt.toISOString(),
  };
}
