import { FastifyInstance } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { config } from "../../platform/config/index.js";
import { verifyPaystackSignature } from "../../platform/crypto/index.js";
import { UnauthorizedError, BadRequestError } from "../../platform/errors/index.js";
import { db } from "../../platform/db/index.js";
import { webhookEvents } from "../../platform/db/schema/payments.js";
import type { PaystackVerification } from "../../platform/paystack/index.js";
import { settleOrderPayment, settleSubscriptionPayment } from "./settle.js";
import { settleRecon } from "../cash/recon.service.js";

type ChargeData = {
  id?: number | string;
  reference?: string;
  status?: string;
  amount?: number | string;
  currency?: string;
  channel?: string;
  paid_at?: string;
};

/** Turns the (signature-verified) webhook payload into the same shape a server-side verify returns. */
function toVerification(d: ChargeData): PaystackVerification {
  return {
    status: String(d.status ?? ""),
    reference: String(d.reference ?? ""),
    transactionId: d.id !== undefined ? String(d.id) : null,
    amountPesewas: BigInt(d.amount ?? 0),
    currency: String(d.currency ?? "GHS"),
    channel: d.channel ?? null,
    paidAt: d.paid_at ? new Date(d.paid_at) : null,
  };
}

type Outcome = { done: true } | { done: false; reason: string; retry: boolean };

async function processChargeSuccess(d: ChargeData): Promise<Outcome> {
  const reference = d.reference;
  if (!reference) return { done: false, reason: "NO_REFERENCE", retry: false };
  const gateway = toVerification(d);

  if (reference.startsWith("RECON-")) {
    const r = await settleRecon(reference, gateway);
    if (r.result === "completed" || r.result === "already_completed") return { done: true };
    if (r.result === "mismatch") return { done: false, reason: "AMOUNT_MISMATCH", retry: false };
    // A send we haven't recorded yet can be a race with our own insert: let Paystack retry.
    return { done: false, reason: r.result === "not_found" ? "UNMATCHED_REFERENCE" : "NOT_SUCCESSFUL", retry: r.result === "not_found" };
  }

  if (reference.startsWith("SUB-")) {
    const r = await settleSubscriptionPayment(reference, gateway, "webhook");
    if (r.result === "activated" || r.result === "already_active") return { done: true };
    if (r.result === "mismatch") return { done: false, reason: "AMOUNT_MISMATCH", retry: false };
    if (r.result === "not_found") return { done: false, reason: "UNMATCHED_SUBSCRIPTION_REFERENCE", retry: false };
    return { done: false, reason: "NOT_SUCCESSFUL", retry: false };
  }

  const r = await settleOrderPayment(reference, gateway, "webhook");
  if (r.result === "paid" || r.result === "already_paid") return { done: true };
  if (r.result === "mismatch") return { done: false, reason: "AMOUNT_MISMATCH", retry: false };
  // Our own references: the row may not be saved yet, so ask Paystack to try again. Foreign references: give up.
  return { done: false, reason: "UNMATCHED_REFERENCE", retry: reference.startsWith("WL-") };
}

export async function paymentRoutes(app: FastifyInstance) {
  // The signature is an HMAC of the exact bytes Paystack sent, so keep the raw body. Re-serialising parsed JSON
  // changes the bytes and would reject real events. This only applies inside this plugin.
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
    (req as any).rawBody = body as string;
    try {
      done(null, (body as string).length ? JSON.parse(body as string) : {});
    } catch (err) {
      (err as any).statusCode = 400;
      done(err as Error, undefined);
    }
  });

  const server = app.withTypeProvider<ZodTypeProvider>();

  server.post(
    "/webhooks/paystack",
    {
      config: { rateLimit: { max: 600, timeWindow: "1 minute" } },
      schema: {
        tags: ["Payments"],
        summary: "Paystack webhook: verified against the raw body, idempotent, settles payments and cash sends",
        response: { 200: z.object({ received: z.boolean() }), 500: z.object({ received: z.boolean() }) },
      },
    },
    async (request, reply) => {
      const signature = request.headers["x-paystack-signature"] as string | undefined;
      const rawBody = (request as any).rawBody as string | undefined;
      if (!signature) throw new UnauthorizedError("Missing Paystack signature header");
      if (!rawBody || !verifyPaystackSignature(rawBody, signature, config.PAYSTACK_SECRET_KEY)) {
        request.log.warn("Invalid Paystack webhook signature");
        throw new UnauthorizedError("Invalid signature");
      }

      const event = request.body as { event?: string; data?: ChargeData };
      const key = event.data?.id ?? event.data?.reference;
      if (!event.event || key === undefined) throw new BadRequestError("Malformed event", "MALFORMED_EVENT");
      const eventId = `${event.event}:${key}`;

      // Record the event first. A repeat of one we already finished is acknowledged and ignored;
      // a repeat of one that failed or is unfinished is processed again.
      const inserted = await db
        .insert(webhookEvents)
        .values({ provider: "paystack", eventId, eventType: event.event, payload: event as unknown as Record<string, unknown> })
        .onConflictDoNothing()
        .returning({ id: webhookEvents.id });
      const [row] = inserted.length
        ? inserted
        : await db
            .select({ id: webhookEvents.id, processedAt: webhookEvents.processedAt })
            .from(webhookEvents)
            .where(eq(webhookEvents.eventId, eventId))
            .limit(1);
      if (inserted.length === 0 && (row as { processedAt?: Date | null }).processedAt) {
        return { received: true };
      }

      if (event.event !== "charge.success") {
        await db.update(webhookEvents).set({ processedAt: new Date() }).where(eq(webhookEvents.id, row!.id));
        return { received: true };
      }

      try {
        const outcome = await processChargeSuccess(event.data ?? {});
        if (outcome.done) {
          await db.update(webhookEvents).set({ processedAt: new Date(), errorMessage: null }).where(eq(webhookEvents.id, row!.id));
          return { received: true };
        }
        await db.update(webhookEvents).set({ errorMessage: outcome.reason }).where(eq(webhookEvents.id, row!.id));
        request.log.warn({ eventId, reason: outcome.reason }, "Paystack event not settled");
        return reply.status(outcome.retry ? 500 : 200).send({ received: !outcome.retry });
      } catch (err) {
        request.log.error({ err, eventId }, "Paystack webhook processing failed");
        await db
          .update(webhookEvents)
          .set({ errorMessage: (err instanceof Error ? err.message : "error").slice(0, 500) })
          .where(eq(webhookEvents.id, row!.id));
        return reply.status(500).send({ received: false });
      }
    }
  );
}
