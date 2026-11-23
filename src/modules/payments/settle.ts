import { and, eq, or, sql } from "drizzle-orm";
import { db } from "../../platform/db/index.js";
import { orders } from "../../platform/db/schema/orders.js";
import { payments } from "../../platform/db/schema/payments.js";
import { customerSubscriptions } from "../../platform/db/schema/subscriptions.js";
import { writeAudit } from "../../platform/audit/index.js";
import { broadcastRealtimeEvent } from "../../platform/realtime/index.js";
import { methodFromChannel, PaystackVerification } from "../../platform/paystack/index.js";

export type SettleResult =
  | { result: "paid"; orderId: string; branchId: string }
  | { result: "already_paid"; orderId: string; branchId: string }
  | { result: "not_found" }
  | { result: "not_successful"; gatewayStatus: string }
  | { result: "mismatch"; expected: string; received: string };

function formatPesewas(amount: bigint) {
  const digits = amount.toString().replace("-", "");
  const padded = digits.padStart(3, "0");
  return `${amount < 0n ? "-" : ""}${padded.slice(0, -2)}.${padded.slice(-2)}`;
}

/** Activates a pending subscription from a signature-verified Paystack charge. */
export async function settleSubscriptionPayment(
  reference: string,
  gateway: PaystackVerification,
  source: "webhook" | "finalize"
) {
  if (gateway.status !== "success") return { result: "not_successful" as const };

  return db.transaction(async (tx) => {
    const [sub] = await tx
      .select()
      .from(customerSubscriptions)
      .where(eq(customerSubscriptions.paymentReference, reference))
      .for("update")
      .limit(1);
    if (!sub || sub.deletedAt) return { result: "not_found" as const };
    if (sub.status === "active") return { result: "already_active" as const };
    if (sub.status !== "pending_payment") return { result: "ignored" as const };

    const expected = sub.planPricePesewas;
    if (gateway.currency !== "GHS" || gateway.amountPesewas < expected) {
      const received = gateway.currency === "GHS" ? `GHS ${formatPesewas(gateway.amountPesewas)}` : gateway.currency;
      const note =
        `PAYMENT AMOUNT MISMATCH: Paystack received ${received}; ` +
        `plan costs GHS ${formatPesewas(expected)}.`;
      await tx
        .update(customerSubscriptions)
        .set({ note, updatedAt: new Date() })
        .where(eq(customerSubscriptions.id, sub.id));
      await writeAudit(tx, {
        actorId: `system:paystack:${source}`,
        actorRole: "system",
        action: "subscription.payment_amount_mismatch",
        entityType: "customer_subscription",
        entityId: sub.id,
        changes: {
          reference,
          expectedPesewas: expected.toString(),
          receivedPesewas: gateway.amountPesewas.toString(),
          currency: gateway.currency,
        },
      });
      return { result: "mismatch" as const };
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + sub.validityDays * 24 * 60 * 60 * 1000);
    await tx
      .update(customerSubscriptions)
      .set({
        status: "active",
        loadsUsed: 0,
        paidAt: gateway.paidAt ?? now,
        activatedAt: now,
        expiresAt,
        updatedAt: now,
        note: null,
      })
      .where(eq(customerSubscriptions.id, sub.id));
    await writeAudit(tx, {
      actorId: `system:paystack:${source}`,
      actorRole: "system",
      action: "subscription.activated",
      entityType: "customer_subscription",
      entityId: sub.id,
      changes: {
        reference,
        planId: sub.planId,
        planPricePesewas: expected.toString(),
        loadsTotal: sub.loadsTotal,
        expiresAt: expiresAt.toISOString(),
      },
    });
    return { result: "activated" as const, subscriptionId: sub.id };
  });
}

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
    if (order.paymentStatus === "paid") {
      await writeAudit(tx, {
        actorId: `system:paystack:${source}`,
        actorRole: "system",
        action: "payment.late_success_after_order_paid",
        entityType: "payment",
        entityId: payment.id,
        changes: {
          reference,
          orderId: order.id,
          orderNumber: order.orderNumber,
          gatewayTransactionId: gateway.transactionId,
          receivedPesewas: gateway.amountPesewas.toString(),
          note: "Paystack reported success after the order had already been paid by another method",
        },
      });
      return { result: "already_paid", orderId: order.id, branchId: order.branchId };
    }

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
