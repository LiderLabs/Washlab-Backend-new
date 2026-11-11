import { FastifyInstance } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { config } from "../../platform/config/index.js";
import { verifyPaystackSignature } from "../../platform/crypto/index.js";
import { UnauthorizedError } from "../../platform/errors/index.js";
import { db } from "../../platform/db/index.js";
import { webhookEvents } from "../../platform/db/schema/payments.js";

export async function paymentRoutes(app: FastifyInstance) {
  const server = app.withTypeProvider<ZodTypeProvider>();

  // Paystack Webhook Handler (Zero Lost Payments)
  server.post(
    "/webhooks/paystack",
    {
      schema: {
        tags: ["Payments"],
        summary: "Paystack webhook listener with constant-time HMAC verification",
        response: {
          200: z.object({ received: z.boolean() }),
          500: z.object({ received: z.boolean() }),
        },
      },
    },
    async (request, reply) => {
      const signature = request.headers["x-paystack-signature"] as string | undefined;
      if (!signature) {
        throw new UnauthorizedError("Missing Paystack signature header");
      }

      const rawBody = typeof request.body === "string" ? request.body : JSON.stringify(request.body);
      const isValid = verifyPaystackSignature(rawBody, signature, config.PAYSTACK_SECRET_KEY);

      if (!isValid) {
        request.log.warn("Invalid Paystack webhook signature detected");
        throw new UnauthorizedError("Invalid signature");
      }

      const event = request.body as { event: string; data: { id: string | number; reference?: string } };
      const eventId = String(event.data?.id || event.data?.reference || Date.now());

      // Idempotent insertion
      try {
        await db.insert(webhookEvents).values({
          provider: "paystack",
          eventId,
          eventType: event.event,
          payload: event as unknown as Record<string, unknown>,
          processedAt: new Date(),
        });
      } catch (err: unknown) {
        // If duplicate eventId, acknowledge 200 OK immediately
        if (typeof err === "object" && err !== null && "code" in err && err.code === "23505") {
          request.log.info({ eventId }, "Duplicate Paystack webhook acknowledged");
          return reply.status(200).send({ received: true });
        }
        request.log.error({ err }, "Failed to persist webhook event");
        return reply.status(500).send({ received: false });
      }

      return reply.status(200).send({ received: true });
    }
  );
}
