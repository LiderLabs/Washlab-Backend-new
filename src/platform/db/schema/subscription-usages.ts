import { sql } from "drizzle-orm";
import { pgTable, uuid, varchar, integer, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { customerSubscriptions } from "./subscriptions.js";
import { orders } from "./orders.js";
import { branches } from "./branches.js";
import { attendants } from "./staff.js";

export const subscriptionUsages = pgTable(
  "subscription_usages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    legacyConvexId: varchar("legacy_convex_id", { length: 64 }).unique(),
    subscriptionId: uuid("subscription_id").notNull().references(() => customerSubscriptions.id, { onDelete: "restrict" }),
    orderId: uuid("order_id").notNull().references(() => orders.id, { onDelete: "restrict" }),
    branchId: uuid("branch_id").notNull().references(() => branches.id, { onDelete: "restrict" }),
    attendantId: uuid("attendant_id").references(() => attendants.id, { onDelete: "set null" }),
    loadsUsed: integer("loads_used").notNull(),
    extraWash: integer("extra_wash").notNull().default(0),
    extraDry: integer("extra_dry").notNull().default(0),
    loadsRemainingAfter: integer("loads_remaining_after").notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("uq_subscription_usages_live_order").on(table.orderId).where(sql`deleted_at IS NULL`),
    index("idx_subscription_usages_subscription").on(table.subscriptionId, table.usedAt),
    index("idx_subscription_usages_branch").on(table.branchId, table.usedAt),
  ]
);
