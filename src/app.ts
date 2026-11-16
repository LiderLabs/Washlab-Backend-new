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
import { orderRoutes } from "./modules/orders/routes.js";
import { paymentRoutes } from "./modules/payments/routes.js";
import { config } from "./platform/config/index.js";

export async function buildApp() {
  const app = fastify({
    loggerInstance: logger,
    disableRequestLogging: false,
    trustProxy: true,
    bodyLimit: 1_048_576,
    requestIdHeader: "x-request-id",
  }).withTypeProvider<ZodTypeProvider>();

  // Set Zod compilers
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // Global plugins
  await app.register(cors, {
    origin: config.CORS_ORIGINS,
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
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

  // Real-time Server-Sent Events stream
  app.get(
    "/v1/events/stream",
    {
      schema: {
        tags: ["Realtime"],
        querystring: {
          type: "object",
          properties: {
            channels: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      const query = request.query as { channels?: string };
      const channels = query.channels ? query.channels.split(",") : ["global"];
      return handleSseConnection(request, reply, channels);
    }
  );

  // Register domain modules under /v1
  await app.register(branchRoutes, { prefix: "/v1/branches" });
  await app.register(orderRoutes, { prefix: "/v1/orders" });
  await app.register(paymentRoutes, { prefix: "/v1/payments" });

  return app;
}
