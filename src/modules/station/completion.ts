import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "../../platform/db/index.js";
import { branches } from "../../platform/db/schema/branches.js";
import { inventoryItems, notifications } from "../../platform/db/schema/operations.js";
import { loyaltyLedger } from "../../platform/db/schema/loyalty.js";
import { orders } from "../../platform/db/schema/orders.js";
import { customers } from "../../platform/db/schema/customers.js";
import { logger } from "../../platform/logger/index.js";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type OrderRow = typeof orders.$inferSelect;

export const MILESTONE_EVERY = 10;

/** Washer / dryer tokens an order uses (same rules as the Convex backend). */
export function tokensUsed(o: Pick<OrderRow, "serviceType" | "estimatedLoads" | "extraWashLoads" | "extraDryLoads">) {
  const base = o.estimatedLoads ?? 1;
  const washExtra = o.extraWashLoads;
  const dryExtra = o.extraDryLoads;
  switch (o.serviceType) {
    case "wash_only":
      return base + washExtra;
    case "dry_only":
      return base + dryExtra;
    case "wash_and_dry":
      return base + washExtra + base + dryExtra;
    default:
      return base + washExtra + dryExtra;
  }
}

async function awardLoyalty(tx: Tx, order: OrderRow) {
  // One award per order, enforced by uq_order_loyalty_award.
  await tx
    .insert(loyaltyLedger)
    .values({ customerId: order.customerId, orderId: order.id, pointsDelta: 1, reason: "order_completed" })
    .onConflictDoNothing();
}

async function deductInventory(tx: Tx, order: OrderRow) {
  const deduct = async (category: "cleaning_supplies" | "operational", amount: number) => {
    if (amount <= 0) return;
    const next = sql`GREATEST(0, ${inventoryItems.currentStock} - ${amount})`;
    await tx
      .update(inventoryItems)
      .set({
        currentStock: next,
        status: sql`CASE
          WHEN ${inventoryItems.status} = 'ordered' THEN ${inventoryItems.status}
          WHEN ${next} <= ${inventoryItems.minStock} THEN 'critical'::inventory_status
          WHEN ${next} <= ${inventoryItems.reorderPoint} THEN 'low'::inventory_status
          ELSE 'ok'::inventory_status END`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(inventoryItems.branchId, order.branchId),
          eq(inventoryItems.category, category),
          isNull(inventoryItems.deletedAt)
        )
      );
  };
  await deduct("cleaning_supplies", 1); // 1 unit of soap per order
  await deduct("operational", tokensUsed(order)); // tokens
}

async function milestoneNotification(tx: Tx, order: OrderRow) {
  const [{ n } = { n: 0 }] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(orders)
    .where(and(eq(orders.customerId, order.customerId), eq(orders.status, "completed"), isNull(orders.deletedAt)));
  if (n === 0 || n % MILESTONE_EVERY !== 0) return;

  const [cust] = await tx.select().from(customers).where(eq(customers.id, order.customerId)).limit(1);
  const [branch] = await tx.select({ name: branches.name }).from(branches).where(eq(branches.id, order.branchId)).limit(1);
  if (!cust) return;

  await tx.insert(notifications).values([
    {
      recipientType: "admin",
      branchId: order.branchId,
      title: `🎉 Customer milestone: ${n} washes`,
      message: `${cust.name} (${cust.phoneNumber}) just completed their ${n}th wash at ${branch?.name ?? "a branch"}.`,
      type: "success",
      entityType: "customer",
      entityId: cust.id,
    },
    {
      recipientType: "station",
      recipientId: order.branchId,
      branchId: order.branchId,
      title: `🎉 ${n} washes milestone!`,
      message: `${cust.name} just hit ${n} washes. Great work team!`,
      type: "success",
      entityType: "customer",
      entityId: cust.id,
    },
  ]);
}

/**
 * Runs when an order becomes "completed", inside the status-change transaction.
 * Each effect sits in its own savepoint: a failure is logged and skipped, and never blocks the status change
 * (the Convex backend also swallowed these errors).
 */
export async function runCompletionEffects(tx: Tx, order: OrderRow) {
  const steps: [string, (t: Tx, o: OrderRow) => Promise<void>][] = [
    ["loyalty", awardLoyalty],
    ["inventory", deductInventory],
    ["milestone", milestoneNotification],
  ];
  for (const [name, fn] of steps) {
    try {
      await tx.transaction((sp) => fn(sp as Tx, order));
    } catch (err) {
      logger.error({ err, orderId: order.id, effect: name }, "Order completion effect failed");
    }
  }
}
