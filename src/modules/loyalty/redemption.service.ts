import { and, eq, isNull } from "drizzle-orm";
import { db } from "../../platform/db/index.js";
import { branchServices } from "../../platform/db/schema/catalog.js";
import { customers } from "../../platform/db/schema/customers.js";
import { loyaltyLedger } from "../../platform/db/schema/loyalty.js";
import { orders } from "../../platform/db/schema/orders.js";
import { payments } from "../../platform/db/schema/payments.js";
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from "../../platform/errors/index.js";

type RedemptionAccess =
  | { kind: "customer"; clerkUserId: string }
  | { kind: "station"; branchId: string };

function serialized(amount: bigint): number | string {
  const value = Number(amount);
  return Number.isSafeInteger(value) ? value : amount.toString();
}

export const loyaltyRedemptionService = {
  async redeemForOrder(
    access: RedemptionAccess,
    orderId: string,
    pointsToRedeem: number,
  ) {
    if (!Number.isInteger(pointsToRedeem) || pointsToRedeem < 10 || pointsToRedeem % 10 !== 0) {
      throw new BadRequestError("Points must be redeemed in multiples of 10", "INVALID_LOYALTY_MULTIPLE");
    }

    return db.transaction(async (tx) => {
      const [order] = await tx
        .select()
        .from(orders)
        .where(and(eq(orders.id, orderId), isNull(orders.deletedAt)))
        .for("update")
        .limit(1);
      if (!order) throw new NotFoundError("Order not found", "ORDER_NOT_FOUND");
      if (order.paymentStatus !== "pending") {
        throw new ConflictError("Loyalty can only be redeemed against an unpaid order", "ORDER_ALREADY_PAID");
      }
      const [pendingPayment] = await tx
        .select({ id: payments.id })
        .from(payments)
        .where(and(eq(payments.orderId, order.id), eq(payments.status, "pending")))
        .for("update")
        .limit(1);
      if (pendingPayment) {
        throw new ConflictError("Cancel the pending payment attempt before redeeming loyalty points", "PAYMENT_ATTEMPT_PENDING");
      }

      let customerId = order.customerId;
      if (access.kind === "customer") {
        const [customer] = await tx
          .select({ id: customers.id })
          .from(customers)
          .where(and(eq(customers.clerkUserId, access.clerkUserId), isNull(customers.deletedAt)))
          .limit(1);
        if (!customer) throw new NotFoundError("Customer profile not found", "CUSTOMER_NOT_FOUND");
        customerId = customer.id;
        if (order.customerId !== customerId) throw new ForbiddenError("This order does not belong to you", "ORDER_ACCESS_DENIED");
      } else if (order.branchId !== access.branchId) {
        throw new ForbiddenError("This order does not belong to this station", "ORDER_ACCESS_DENIED");
      }

      const [existingRedemption] = await tx
        .select({ id: loyaltyLedger.id })
        .from(loyaltyLedger)
        .where(and(eq(loyaltyLedger.orderId, order.id), eq(loyaltyLedger.reason, "reward_redemption")))
        .limit(1);
      if (existingRedemption) throw new ConflictError("Loyalty points were already redeemed for this order", "LOYALTY_ALREADY_REDEEMED");

      const [customer] = await tx
        .select()
        .from(customers)
        .where(and(eq(customers.id, customerId), isNull(customers.deletedAt)))
        .for("update")
        .limit(1);
      if (!customer) throw new NotFoundError("Customer not found", "CUSTOMER_NOT_FOUND");
      if (customer.loyaltyPoints < pointsToRedeem) {
        throw new BadRequestError("Insufficient loyalty points", "INSUFFICIENT_POINTS");
      }

      const [service] = await tx
        .select({ pricePesewas: branchServices.pricePesewas })
        .from(branchServices)
        .where(
          and(
            eq(branchServices.branchId, order.branchId),
            eq(branchServices.code, order.serviceType),
            isNull(branchServices.deletedAt),
          ),
        )
        .limit(1);
      const loadPricePesewas = service?.pricePesewas ?? 2500n;
      const wantedDiscount = BigInt(pointsToRedeem / 10) * loadPricePesewas;
      const discountPesewas =
        wantedDiscount > order.finalPricePesewas ? order.finalPricePesewas : wantedDiscount;
      const pointsRemaining = customer.loyaltyPoints - pointsToRedeem;
      const amountDue = order.finalPricePesewas - discountPesewas;

      await tx
        .update(customers)
        .set({ loyaltyPoints: pointsRemaining, updatedAt: new Date() })
        .where(eq(customers.id, customer.id));
      await tx.insert(loyaltyLedger).values({
        customerId: customer.id,
        orderId: order.id,
        pointsDelta: -pointsToRedeem,
        balanceAfter: pointsRemaining,
        reason: "reward_redemption",
        description: `Redeemed ${pointsToRedeem} points on order ${order.orderNumber}`,
      });
      await tx
        .update(orders)
        .set({
          discountPesewas: order.discountPesewas + discountPesewas,
          finalPricePesewas: amountDue,
          updatedAt: new Date(),
        })
        .where(eq(orders.id, order.id));

      return {
        orderId: order.id,
        pointsRedeemed: pointsToRedeem,
        pointsRemaining,
        discountPesewas: serialized(discountPesewas),
        amountDuePesewas: serialized(amountDue),
      };
    });
  },
};
