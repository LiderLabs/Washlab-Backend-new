import { pgTable, uuid, varchar, text, boolean, integer, timestamp, index } from "drizzle-orm/pg-core";

export const subscriptionPromoImages = pgTable(
  "subscription_promo_images",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    title: varchar("title", { length: 255 }).notNull(),
    imageUrl: text("image_url").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("idx_subscription_promo_images_active_order").on(table.isActive, table.sortOrder)]
);

export type SubscriptionPromoImage = typeof subscriptionPromoImages.$inferSelect;
