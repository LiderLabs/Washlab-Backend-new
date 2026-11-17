import { pgTable, uuid, integer, varchar, timestamp, pgEnum } from "drizzle-orm/pg-core";
export const loyaltyTxTypeEnum = pgEnum("loyalty_tx_type", ["earned", "redeemed", "adjusted"]);
export const loyaltyLedgers = pgTable("loyalty_ledgers", {
  id: uuid("id").primaryKey().defaultRandom(),
  customerId: uuid("customer_id").notNull(),
  orderId: uuid("order_id"),
  type: loyaltyTxTypeEnum("type").notNull(),
  points: integer("points").notNull(),
  balanceAfter: integer("balance_after").notNull(),
  description: varchar("description", { length: 255 }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
