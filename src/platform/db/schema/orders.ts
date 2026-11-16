import { pgTable, uuid, varchar, text, bigint, numeric, timestamp, index, uniqueIndex, pgEnum } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { customers } from "./customers.js";
import { branches } from "./branches.js";
import { attendants, userRoleEnum } from "./staff.js";

export const orderStatusEnum = pgEnum("order_status", [
  "draft",
  "pending_dropoff",
  "received",
  "weighed",
  "washing",
  "drying",
  "folding",
  "ready_for_pickup",
  "out_for_delivery",
  "delivered",
  "completed",
  "cancelled",
]);

export const paymentStatusEnum = pgEnum("payment_status", [
  "pending",
  "successful",
  "failed",
  "refunded",
]);

export const orders = pgTable(
  "orders",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    legacyConvexId: varchar("legacy_convex_id", { length: 64 }).unique(),
    orderNumber: varchar("order_number", { length: 32 }).notNull(),
    customerId: uuid("customer_id").notNull().references(() => customers.id, { onDelete: "restrict" }),
    branchId: uuid("branch_id").notNull().references(() => branches.id, { onDelete: "restrict" }),
    status: orderStatusEnum("status").notNull().default("draft"),
    weightKg: numeric("weight_kg", { precision: 6, scale: 2 }),
    servicePricePesewas: bigint("service_price_pesewas", { mode: "bigint" }).notNull().default(sql`0`),
    deliveryFeePesewas: bigint("delivery_fee_pesewas", { mode: "bigint" }).notNull().default(sql`0`),
    discountPesewas: bigint("discount_pesewas", { mode: "bigint" }).notNull().default(sql`0`),
    finalPricePesewas: bigint("final_price_pesewas", { mode: "bigint" }).notNull().default(sql`0`),
    paymentStatus: paymentStatusEnum("payment_status").notNull().default("pending"),
    fulfilledByAttendantId: uuid("fulfilled_by_attendant_id").references(() => attendants.id, { onDelete: "set null" }),
    placedAt: timestamp("placed_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_orders_order_number").on(table.orderNumber),
    index("idx_orders_branch_status").on(table.branchId, table.status).where(sql`deleted_at IS NULL`),
    index("idx_orders_customer_date").on(table.customerId, table.placedAt),
  ]
);

export const orderStatusEvents = pgTable(
  "order_status_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orderId: uuid("order_id").notNull().references(() => orders.id, { onDelete: "cascade" }),
    fromStatus: orderStatusEnum("from_status"),
    toStatus: orderStatusEnum("to_status").notNull(),
    changedByUserId: varchar("changed_by_user_id", { length: 128 }).notNull(),
    changedByRole: userRoleEnum("changed_by_role").notNull(),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_order_status_events_order").on(table.orderId, table.createdAt),
  ]
);

export type Order = typeof orders.$inferSelect;
export type NewOrder = typeof orders.$inferInsert;
export type OrderStatusEvent = typeof orderStatusEvents.$inferSelect;
