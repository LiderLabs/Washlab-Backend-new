import { pgTable, uuid, varchar, boolean, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { branches } from "./branches.js";

export const customers = pgTable(
  "customers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    legacyConvexId: varchar("legacy_convex_id", { length: 64 }).unique(),
    clerkUserId: varchar("clerk_user_id", { length: 128 }),
    name: varchar("name", { length: 255 }).notNull(),
    phoneNumber: varchar("phone_number", { length: 32 }).notNull(),
    email: varchar("email", { length: 255 }),
    branchId: uuid("branch_id").references(() => branches.id, { onDelete: "set null" }),
    isVerified: boolean("is_verified").notNull().default(false),
    anonymizedAt: timestamp("anonymized_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_customers_phone_active").on(table.phoneNumber).where(sql`deleted_at IS NULL`),
    uniqueIndex("idx_customers_clerk_active").on(table.clerkUserId).where(sql`deleted_at IS NULL AND clerk_user_id IS NOT NULL`),
  ]
);

export type Customer = typeof customers.$inferSelect;
export type NewCustomer = typeof customers.$inferInsert;
