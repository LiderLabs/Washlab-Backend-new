import fastify from "fastify";
import cors from "@fastify/cors";
import sensible from "@fastify/sensible";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";
import { logger } from "./platform/logger/index.js";
import { globalErrorHandler } from "./platform/errors/index.js";
import { checkDbConnection } from "./platform/db/index.js";
import { handleSseConnection } from "./platform/realtime/index.js";
import { branchRoutes } from "./modules/branches/routes.js";
import { customerRoutes } from "./modules/customers/routes.js";
import { catalogRoutes } from "./modules/catalog/routes.js";
import { voucherRoutes } from "./modules/vouchers/routes.js";
import { orderRoutes } from "./modules/orders/routes.js";
import { adminRoutes } from "./modules/admin/routes.js";
import { paymentRoutes } from "./modules/payments/routes.js";
import { stationRoutes } from "./modules/station/routes.js";
import { stationOrderRoutes } from "./modules/station/orders.routes.js";
import { stationCashRoutes } from "./modules/station/cash.routes.js";
import { stationReportRoutes } from "./modules/station/reports.routes.js";
import { stationBoardRoutes } from "./modules/station/board.routes.js";
import {
  adminSubscriptionRoutes,
  customerSubscriptionRoutes,
  stationSubscriptionRoutes,
} from "./modules/subscriptions/routes.js";
import { stationEnrollmentRoutes } from "./modules/station/enrollment.routes.js";
import { config } from "./platform/config/index.js";
import { authenticate } from "./platform/auth/index.js";
import { authenticateStation, STATION_TOKEN_HEADER } from "./platform/auth/station.js";
import { ForbiddenError } from "./platform/errors/index.js";

export async function buildApp() {
  const app = fastify({
    loggerInstance: logger,
    disableRequestLogging: false,
    // Trust exactly N proxy hops, never "true": with true a client can send its own X-Forwarded-For and dodge rate limits.
    trustProxy: (_address: string, hop: number) => hop < config.TRUST_PROXY_HOPS,
    bodyLimit: 1_048_576,
    requestIdHeader: "x-request-id",
  }).withTypeProvider<ZodTypeProvider>();

  // Set Zod compilers
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const bigIntJsonReplacer = (_key: string, value: unknown) => {
    if (typeof value !== "bigint") return value;
    const asNumber = Number(value);
    return Number.isSafeInteger(asNumber) ? asNumber : value.toString();
  };
  app.setReplySerializer((payload) => JSON.stringify(payload, bigIntJsonReplacer));
  app.addHook("preSerialization", async (_request, _reply, payload) =>
    JSON.parse(JSON.stringify(payload, bigIntJsonReplacer))
  );

  // Global plugins
  await app.register(cors, {
    origin: config.CORS_ORIGINS,
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    exposedHeaders: ["X-Total-Count", "X-Days-Total-Count", "X-Sends-Total-Count"],
  });

  await app.register(sensible);

  await app.register(rateLimit, {
    max: 100,
    timeWindow: "1 minute",
  });

  // Swagger OpenAPI 3.1 Documentation
  await app.register(swagger, {
    openapi: {
      info: {
        title: "WashLab Core API",
        description: "High-performance, scalable backend API for WashLab Laundry Operations",
        version: "2.0.0",
      },
      servers: [{ url: "/" }],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: "http",
            scheme: "bearer",
            bearerFormat: "JWT",
          },
          stationToken: {
            type: "apiKey",
            in: "header",
            name: "x-station-token",
          },
        },
      },
    },
  });

  await app.register(swaggerUi, {
    routePrefix: "/docs",
    uiConfig: {
      docExpansion: "list",
      deepLinking: true,
    },
  });

  // Global Error Handler
  app.setErrorHandler(globalErrorHandler);

  // Health & Readiness probes for Kubernetes / ECS / ALB
  app.get("/healthz", { config: { rateLimit: false }, schema: { tags: ["System"] } }, async () => {
    return { status: "ok", timestamp: new Date().toISOString() };
  });

  app.get("/readyz", { config: { rateLimit: false }, schema: { tags: ["System"] } }, async (_req, reply) => {
    const isDbConnected = await checkDbConnection();
    if (!isDbConnected) {
      return reply.status(503).send({
        status: "unhealthy",
        database: "disconnected",
        timestamp: new Date().toISOString(),
      });
    }

    return {
      status: "ready",
      database: "connected",
      timestamp: new Date().toISOString(),
    };
  });

  // Real-time Server-Sent Events stream. Authenticated: send x-station-token (attendant app) or a Clerk
  // Authorization header. Native EventSource can't set headers, so clients use fetch streaming instead.
  app.get(
    "/v1/events/stream",
    {
      schema: {
        tags: ["Realtime"],
        security: [{ stationToken: [] }, { bearerAuth: [] }],
        querystring: {
          type: "object",
          properties: {
            channels: { type: "string" },
          },
        },
      },
      onRequest: async (request) => {
        const q = request.query as { channels?: string };
        const channels = q.channels ? q.channels.split(",").map((c) => c.trim()).filter(Boolean) : [];
        if (channels.length === 0 || channels.length > 20) {
          throw new ForbiddenError("Choose 1-20 channels", "CHANNELS_REQUIRED");
        }
        if (request.headers[STATION_TOKEN_HEADER]) {
          await authenticateStation(request);
          const allowed = `branch:${request.station!.branchId}`;
          if (channels.some((c) => c !== allowed)) {
            throw new ForbiddenError("A station can only listen to its own branch", "CHANNEL_FORBIDDEN");
          }
          return;
        }
        await authenticate(request);
        const user = request.user!;
        if (user.role === "admin" || user.role === "super_admin") return;
        if (user.role === "attendant" && channels.every((c) => c === `branch:${user.branchId}`)) return;
        throw new ForbiddenError("Not allowed to listen to these channels", "CHANNEL_FORBIDDEN");
      },
    },
    async (request, reply) => {
      const query = request.query as { channels?: string };
      const channels = query.channels!.split(",").map((c) => c.trim()).filter(Boolean);
      return handleSseConnection(request, reply, channels);
    }
  );

  // Register domain modules under /v1
  await app.register(adminRoutes, { prefix: "/v1/admin" });
  await app.register(branchRoutes, { prefix: "/v1/branches" });
  await app.register(customerRoutes, { prefix: "/v1/customers" });
  await app.register(catalogRoutes, { prefix: "/v1/services" });
  await app.register(voucherRoutes, { prefix: "/v1/vouchers" });
  await app.register(orderRoutes, { prefix: "/v1/orders" });
  await app.register(paymentRoutes, { prefix: "/v1/payments" });
  await app.register(stationRoutes, { prefix: "/v1/station" });
  await app.register(stationOrderRoutes, { prefix: "/v1/station" });
  await app.register(stationCashRoutes, { prefix: "/v1/station/cash" });
  await app.register(stationReportRoutes, { prefix: "/v1/station/reports" });
  await app.register(stationBoardRoutes, { prefix: "/v1/station" });
  await app.register(customerSubscriptionRoutes, { prefix: "/v1/customer" });
  await app.register(stationSubscriptionRoutes, { prefix: "/v1/station" });
  await app.register(adminSubscriptionRoutes, { prefix: "/v1/admin" });
  await app.register(stationEnrollmentRoutes, { prefix: "/v1/station/enrollment" });

  return app;
}
