import { pgTable, uuid, varchar, text, bigint, boolean, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { branches } from "./branches.js";

/**
 * Per-branch service prices. `price` is per LOAD (8 kg), not per kg: this is how the Convex backend priced orders.
 * Codes used by the apps: wash_and_dry, wash_only, dry_only (others allowed).
 */
export const branchServices = pgTable(
  "branch_services",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    legacyConvexId: varchar("legacy_convex_id", { length: 64 }).unique(),
    branchId: uuid("branch_id").notNull().references(() => branches.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 100 }).notNull(),
    code: varchar("code", { length: 64 }).notNull(),
    description: text("description"),
    imageUrl: text("image_url"),
    pricePesewas: bigint("price_pesewas", { mode: "bigint" }).notNull(),
    extraWashPricePesewas: bigint("extra_wash_price_pesewas", { mode: "bigint" }),
    extraDryPricePesewas: bigint("extra_dry_price_pesewas", { mode: "bigint" }),
    isActive: boolean("is_active").notNull().default(true),
    showOnCustomerSide: boolean("show_on_customer_side").notNull().default(true),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_branch_services_code_active").on(table.branchId, table.code).where(sql`deleted_at IS NULL`),
  ]
);

export const branchMachines = pgTable(
  "branch_machines",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    legacyConvexId: varchar("legacy_convex_id", { length: 64 }).unique(),
    branchId: uuid("branch_id").notNull().references(() => branches.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 100 }).notNull(),
    displayName: varchar("display_name", { length: 100 }),
    serialNumber: varchar("serial_number", { length: 100 }),
    otherDetails: text("other_details"),
    washPricePesewas: bigint("wash_price_pesewas", { mode: "bigint" }).notNull(),
    isActive: boolean("is_active").notNull().default(true),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("idx_branch_machines_branch").on(table.branchId)]
);

export type BranchService = typeof branchServices.$inferSelect;
export type BranchMachine = typeof branchMachines.$inferSelect;
