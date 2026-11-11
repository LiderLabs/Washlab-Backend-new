import { pgTable, uuid, varchar, integer, timestamp, index, uniqueIndex, boolean, bigint } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { customers } from "./customers.js";
import { orders } from "./orders.js";

export const loyaltyLedger = pgTable(
  "loyalty_ledger",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    customerId: uuid("customer_id").notNull().references(() => customers.id, { onDelete: "restrict" }),
    orderId: uuid("order_id").references(() => orders.id, { onDelete: "restrict" }),
    pointsDelta: integer("points_delta").notNull(),
    reason: varchar("reason", { length: 64 }).notNull(), // 'order_completed', 'reward_redemption', 'manual_adjustment'
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_order_loyalty_award").on(table.orderId, table.reason).where(sql`order_id IS NOT NULL`),
    index("idx_loyalty_customer").on(table.customerId, table.createdAt),
  ]
);

export const vouchers = pgTable(
  "vouchers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    code: varchar("code", { length: 32 }).notNull().unique(),
    discountType: varchar("discount_type", { length: 16 }).notNull(), // 'percentage', 'fixed'
    discountValue: bigint("discount_value", { mode: "bigint" }).notNull(), // pesewas or percentage * 100
    minOrderAmountPesewas: bigint("min_order_amount_pesewas", { mode: "bigint" }).notNull().default(sql`0`),
    maxUsageCount: integer("max_usage_count").default(1),
    currentUsageCount: integer("current_usage_count").notNull().default(0),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  }
);

export const voucherUsages = pgTable(
  "voucher_usages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    voucherId: uuid("voucher_id").notNull().references(() => vouchers.id, { onDelete: "restrict" }),
    customerId: uuid("customer_id").notNull().references(() => customers.id, { onDelete: "restrict" }),
    orderId: uuid("order_id").notNull().references(() => orders.id, { onDelete: "restrict" }),
    discountAppliedPesewas: bigint("discount_applied_pesewas", { mode: "bigint" }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_voucher_order").on(table.voucherId, table.orderId),
  ]
);
