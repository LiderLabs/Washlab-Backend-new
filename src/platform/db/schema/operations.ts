import { pgTable, uuid, varchar, text, integer, boolean, timestamp, index, pgEnum } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { branches } from "./branches.js";

export const inventoryCategoryEnum = pgEnum("inventory_category", [
  "cleaning_supplies",
  "add_ons",
  "facility",
  "retail",
  "operational",
  "washing_supplies",
]);
export const inventoryStatusEnum = pgEnum("inventory_status", ["critical", "low", "ok", "ordered"]);

export const inventoryItems = pgTable(
  "inventory_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    legacyConvexId: varchar("legacy_convex_id", { length: 64 }).unique(),
    branchId: uuid("branch_id").notNull().references(() => branches.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 255 }).notNull(),
    category: inventoryCategoryEnum("category").notNull(),
    unit: varchar("unit", { length: 32 }).notNull(),
    description: text("description"),
    currentStock: integer("current_stock").notNull().default(0),
    maxStock: integer("max_stock").notNull().default(0),
    minStock: integer("min_stock").notNull().default(0),
    reorderPoint: integer("reorder_point").notNull().default(0),
    status: inventoryStatusEnum("status").notNull().default("ok"),
    // Open reorder, set while status = "ordered" and cleared when the delivery is received.
    orderedAt: timestamp("ordered_at", { withTimezone: true }),
    orderQuantity: integer("order_quantity"),
    expectedArrivalDate: timestamp("expected_arrival_date", { withTimezone: true }),
    arrivalDate: timestamp("arrival_date", { withTimezone: true }),
    lastRestockedAt: timestamp("last_restocked_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("idx_inventory_branch").on(table.branchId).where(sql`deleted_at IS NULL`)]
);

export const notificationRecipientEnum = pgEnum("notification_recipient", [
  "customer",
  "attendant",
  "admin",
  "station",
  "all",
]);

/** In-app notifications. For recipient "station" the recipient_id is the branch id; for "admin"/"all" it is null. */
export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    legacyConvexId: varchar("legacy_convex_id", { length: 64 }).unique(),
    recipientType: notificationRecipientEnum("recipient_type").notNull(),
    recipientId: varchar("recipient_id", { length: 64 }),
    branchId: uuid("branch_id").references(() => branches.id, { onDelete: "cascade" }),
    title: varchar("title", { length: 255 }).notNull(),
    message: text("message").notNull(),
    type: varchar("type", { length: 16 }).notNull().default("info"),
    priority: varchar("priority", { length: 16 }).notNull().default("normal"),
    entityType: varchar("entity_type", { length: 32 }),
    entityId: varchar("entity_id", { length: 64 }),
    isRead: boolean("is_read").notNull().default(false),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_notifications_recipient").on(table.recipientType, table.recipientId, table.createdAt.desc()),
    index("idx_notifications_branch").on(table.branchId, table.createdAt.desc()),
  ]
);
