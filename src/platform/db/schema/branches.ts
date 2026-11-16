import { pgTable, uuid, varchar, text, bigint, boolean, integer, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const branches = pgTable(
  "branches",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    legacyConvexId: varchar("legacy_convex_id", { length: 64 }).unique(),
    name: varchar("name", { length: 255 }).notNull(),
    code: varchar("code", { length: 32 }).notNull(),
    terminalId: varchar("terminal_id", { length: 16 }),
    phoneNumber: varchar("phone_number", { length: 32 }).notNull(),
    email: varchar("email", { length: 255 }),
    address: text("address").notNull(),
    city: varchar("city", { length: 100 }).notNull(),
    pricingPerKgPesewas: bigint("pricing_per_kg_pesewas", { mode: "bigint" }).notNull(),
    deliveryFeePesewas: bigint("delivery_fee_pesewas", { mode: "bigint" }).notNull().default(sql`0`),
    stationPinHash: varchar("station_pin_hash", { length: 255 }),
    requireStationLogin: boolean("require_station_login").notNull().default(true),
    weeklyOrderTarget: integer("weekly_order_target").default(0),
    momoNumber: varchar("momo_number", { length: 32 }),
    isActive: boolean("is_active").notNull().default(true),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_branches_code_active").on(table.code).where(sql`deleted_at IS NULL`),
    uniqueIndex("idx_branches_terminal_active").on(table.terminalId).where(sql`deleted_at IS NULL AND terminal_id IS NOT NULL`),
  ]
);

export type Branch = typeof branches.$inferSelect;
export type NewBranch = typeof branches.$inferInsert;
