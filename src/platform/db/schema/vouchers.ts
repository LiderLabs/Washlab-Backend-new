import { pgTable, uuid, varchar, integer, boolean, timestamp, pgEnum } from "drizzle-orm/pg-core";
export const discountTypeEnum = pgEnum("discount_type", ["percentage", "fixed", "free_wash"]);
export const vouchers = pgTable("vouchers", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: varchar("code", { length: 50 }).notNull().unique(),
  name: varchar("name", { length: 100 }),
  discountType: discountTypeEnum("discount_type").notNull(),
  discountValue: integer("discount_value").notNull(),
  usageLimit: integer("usage_limit").default(100).notNull(),
  usedCount: integer("used_count").default(0).notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  validUntil: timestamp("valid_until"),
  branchId: uuid("branch_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
export const voucherUsages = pgTable("voucher_usages", {
  id: uuid("id").primaryKey().defaultRandom(),
  voucherId: uuid("voucher_id").references(() => vouchers.id).notNull(),
  orderId: uuid("order_id").notNull(),
  customerId: uuid("customer_id"),
  discountAmountPesewas: integer("discount_amount_pesewas").notNull(),
  usedAt: timestamp("used_at").defaultNow().notNull(),
});
