import { and, eq, or, sql } from "drizzle-orm";
import { db } from "../../platform/db/index.js";
import { orders } from "../../platform/db/schema/orders.js";
import { payments } from "../../platform/db/schema/payments.js";
import { writeAudit } from "../../platform/audit/index.js";
import { broadcastRealtimeEvent } from "../../platform/realtime/index.js";
import { methodFromChannel, PaystackVerification } from "../../platform/paystack/index.js";

export type SettleResult =
  | { result: "paid"; orderId: string; branchId: string }
  | { result: "already_paid"; orderId: string; branchId: string }
  | { result: "not_found" }
  | { result: "not_successful"; gatewayStatus: string }
  | { result: "mismatch"; expected: string; received: string };

/** A payment is found by its current reference, or by an earlier attempt's reference (abandoned popups). */
export async function findPaymentByReference(reference: string) {
  const [p] = await db
    .select({ id: payments.id, orderId: payments.orderId, branchId: payments.branchId })
    .from(payments)
    .where(
      or(
        eq(payments.gatewayReference, reference),
        sql`${payments.metadata} -> 'previousReferences' ? ${reference}`
      )
    )
    .limit(1);
  return p ?? null;
}

/**
 * Settles an order payment from a Paystack-verified transaction. Safe to call any number of times, from the
 * webhook, the finalize endpoint or a recovery job: the first call pays the order, the rest do nothing.
 * `gateway` must come from Paystack (webhook payload checked by signature, or a server-side verify), never the client.
 */
export async function settleOrderPayment(
  reference: string,
  gateway: PaystackVerification,
  source: "webhook" | "finalize" | "recovery"
): Promise<SettleResult> {
  const found = await findPaymentByReference(reference);
  if (!found || !found.orderId) return { result: "not_found" };
  const orderId = found.orderId;
  if (gateway.status !== "success") return { result: "not_successful", gatewayStatus: gateway.status };

  const outcome = await db.transaction(async (tx): Promise<SettleResult> => {
    // Same lock order as the counter payment: order first, then payment.
    const [order] = await tx.select().from(orders).where(eq(orders.id, orderId)).for("update").limit(1);
    const [payment] = await tx.select().from(payments).where(eq(payments.id, found.id)).for("update").limit(1);
    if (!order || !payment) return { result: "not_found" };
    if (payment.status === "paid") return { result: "already_paid", orderId: order.id, branchId: order.branchId };

    if (gateway.currency !== payment.currency || gateway.amountPesewas !== payment.amountPesewas) {
      await writeAudit(tx, {
        actorId: `system:paystack:${source}`,
        actorRole: "system",
        action: "payment.amount_mismatch",
        entityType: "payment",
        entityId: payment.id,
        changes: {
          reference,
          expectedPesewas: payment.amountPesewas.toString(),
          receivedPesewas: gateway.amountPesewas.toString(),
          currency: gateway.currency,
        },
      });
      return {
        result: "mismatch",
        expected: payment.amountPesewas.toString(),
        received: gateway.amountPesewas.toString(),
      };
    }

    const now = new Date();
    const method = methodFromChannel(gateway.channel) ?? (payment.method === "cash" ? "mobile_money" : payment.method);
    // Keep the reference that actually got paid (it may be an earlier attempt's).
    await tx
      .update(payments)
      .set({
        status: "paid",
        method,
        paidAt: gateway.paidAt ?? now,
        gatewayReference: reference,
        gatewayTransactionId: gateway.transactionId,
        updatedAt: now,
        metadata: { ...((payment.metadata as object) ?? {}), settledBy: source, channel: gateway.channel },
      })
      .where(eq(payments.id, payment.id));
    await tx.update(orders).set({ paymentStatus: "paid", paymentMethod: method, updatedAt: now }).where(eq(orders.id, order.id));

    await writeAudit(tx, {
      actorId: `system:paystack:${source}`,
      actorRole: "system",
      action: "payment.settled",
      entityType: "payment",
      entityId: payment.id,
      changes: {
        orderId: order.id,
        orderNumber: order.orderNumber,
        reference,
        method,
        amountPesewas: payment.amountPesewas.toString(),
        orderStatus: order.status,
      },
    });
    return { result: "paid", orderId: order.id, branchId: order.branchId };
  });

  if (outcome.result === "paid") {
    void broadcastRealtimeEvent(`branch:${outcome.branchId}`, "order.updated", { orderId: outcome.orderId, paymentStatus: "paid" });
  }
  return outcome;
}
