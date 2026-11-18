import { pgTable, uuid, varchar, text, bigint, numeric, integer, boolean, timestamp, index, uniqueIndex, pgEnum } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { customers } from "./customers.js";
import { branches } from "./branches.js";
import { attendants, userRoleEnum } from "./staff.js";
import { branchMachines } from "./catalog.js";

export const orderStatusEnum = pgEnum("order_status", [
  "pending_dropoff", // online order placed, laundry not yet dropped at the station
  "checked_in", // weighed, bag number assigned
  "sorting",
  "washing",
  "drying",
  "folding",
  "ready_for_pickup",
  "out_for_delivery",
  "delivered",
  "completed",
  "cancelled",
]);

export const orderTypeEnum = pgEnum("order_type", ["walk_in", "online"]);

export const paymentMethodEnum = pgEnum("payment_method", ["cash", "mobile_money", "card", "voucher"]);

/** Statuses after which the physical bag is free to be reused. */
export const BAG_RELEASING_STATUSES = ["completed", "cancelled", "delivered"] as const;

export const paymentStatusEnum = pgEnum("payment_status", [
  "pending",
  "paid",
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
    orderType: orderTypeEnum("order_type").notNull().default("online"),
    serviceType: varchar("service_type", { length: 64 }).notNull().default("wash_and_dry"),
    bagNumber: varchar("bag_number", { length: 16 }),
    // Sent by the tablet once per submit. A second request with the same key is the same order, not a new one.
    idempotencyKey: varchar("idempotency_key", { length: 64 }),
    itemCount: integer("item_count"),
    estimatedLoads: integer("estimated_loads"),
    extraWashLoads: integer("extra_wash_loads").notNull().default(0),
    extraDryLoads: integer("extra_dry_loads").notNull().default(0),
    machineId: uuid("machine_id").references(() => branchMachines.id, { onDelete: "set null" }),
    whitesSeparate: boolean("whites_separate").notNull().default(false),
    notes: text("notes"),
    isDelivery: boolean("is_delivery").notNull().default(false),
    deliveryAddress: text("delivery_address"),
    deliveryPhone: varchar("delivery_phone", { length: 32 }),
    deliveryHall: varchar("delivery_hall", { length: 100 }),
    deliveryRoom: varchar("delivery_room", { length: 50 }),
    paymentMethod: paymentMethodEnum("payment_method"),
    status: orderStatusEnum("status").notNull().default("pending_dropoff"),
    weightKg: numeric("weight_kg", { precision: 6, scale: 2 }),
    basePricePesewas: bigint("base_price_pesewas", { mode: "bigint" }).notNull().default(sql`0`),
    servicePricePesewas: bigint("service_price_pesewas", { mode: "bigint" }).notNull().default(sql`0`),
    deliveryFeePesewas: bigint("delivery_fee_pesewas", { mode: "bigint" }).notNull().default(sql`0`),
    discountPesewas: bigint("discount_pesewas", { mode: "bigint" }).notNull().default(sql`0`),
    finalPricePesewas: bigint("final_price_pesewas", { mode: "bigint" }).notNull().default(sql`0`),
    paymentStatus: paymentStatusEnum("payment_status").notNull().default("pending"),
    createdByAttendantId: uuid("created_by_attendant_id").references(() => attendants.id, { onDelete: "set null" }),
    checkedInAt: timestamp("checked_in_at", { withTimezone: true }),
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
    index("idx_orders_branch_placed").on(table.branchId, table.placedAt.desc(), table.id.desc()).where(sql`deleted_at IS NULL`),
    // A bag number can only be on one live order per branch. Enforced here so two tablets can't race.
    uniqueIndex("uq_orders_branch_idempotency")
      .on(table.branchId, table.idempotencyKey)
      .where(sql`idempotency_key IS NOT NULL`),
    uniqueIndex("idx_orders_active_bag")
      .on(table.branchId, table.bagNumber)
      .where(sql`bag_number IS NOT NULL AND deleted_at IS NULL AND status NOT IN ('completed','cancelled','delivered')`),
  ]
);

export const orderStatusEvents = pgTable(
  "order_status_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orderId: uuid("order_id").notNull().references(() => orders.id, { onDelete: "cascade" }),
    fromStatus: orderStatusEnum("from_status"),
    toStatus: orderStatusEnum("to_status").notNull(),
    attendanceId: uuid("attendance_id"),
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
