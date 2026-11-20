import {
  pgEnum,
  pgTable,
  uuid,
  varchar,
  text,
  bigint,
  integer,
  boolean,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { customers } from "./customers.js";
import { branches } from "./branches.js";
import { admins, attendants } from "./staff.js";

export const subscriptionStatusEnum = pgEnum("subscription_status", [
  "pending_payment",
  "active",
  "cancelled",
]);

export const subscriptionSourceEnum = pgEnum("subscription_source", ["online", "admin_grant"]);

export const subscriptionOtpStatusEnum = pgEnum("subscription_otp_status", [
  "pending",
  "used",
  "expired",
  "locked",
]);

export const subscriptionPlans = pgTable(
  "subscription_plans",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    legacyConvexId: varchar("legacy_convex_id", { length: 64 }).unique(),
    name: varchar("name", { length: 255 }).notNull(),
    description: text("description"),
    pricePesewas: bigint("price_pesewas", { mode: "bigint" }).notNull(),
    loadsIncluded: integer("loads_included").notNull(),
    validityDays: integer("validity_days").notNull(),
    applicableBranches: uuid("applicable_branches").array(),
    applicableServiceTypes: varchar("applicable_service_types", { length: 64 }).array(),
    template: varchar("template", { length: 64 }),
    headline: varchar("headline", { length: 255 }),
    sortOrder: integer("sort_order").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
    createdByAdminId: uuid("created_by_admin_id").notNull().references(() => admins.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    index("idx_subscription_plans_active_order").on(table.isActive, table.sortOrder, table.createdAt),
  ]
);

export const customerSubscriptions = pgTable(
  "customer_subscriptions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    legacyConvexId: varchar("legacy_convex_id", { length: 64 }).unique(),
    customerId: uuid("customer_id").references(() => customers.id, { onDelete: "set null" }),
    phoneNumber: varchar("phone_number", { length: 32 }).notNull(),
    customerName: varchar("customer_name", { length: 255 }).notNull(),
    planId: uuid("plan_id").notNull().references(() => subscriptionPlans.id, { onDelete: "restrict" }),
    planName: varchar("plan_name", { length: 255 }).notNull(),
    planPricePesewas: bigint("plan_price_pesewas", { mode: "bigint" }).notNull(),
    loadsTotal: integer("loads_total").notNull(),
    loadsUsed: integer("loads_used").notNull().default(0),
    validityDays: integer("validity_days").notNull(),
    applicableServiceTypes: varchar("applicable_service_types", { length: 64 }).array(),
    applicableBranches: uuid("applicable_branches").array(),
    purchaseBranchId: uuid("purchase_branch_id").references(() => branches.id, { onDelete: "set null" }),
    code: varchar("code", { length: 16 }).notNull(),
    status: subscriptionStatusEnum("status").notNull().default("pending_payment"),
    source: subscriptionSourceEnum("source").notNull().default("online"),
    paymentReference: varchar("payment_reference", { length: 128 }),
    note: text("note"),
    email: varchar("email", { length: 255 }),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelReason: text("cancel_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("uq_customer_subscriptions_code").on(table.code),
    uniqueIndex("uq_customer_subscriptions_payment_reference").on(table.paymentReference),
    index("idx_customer_subscriptions_customer").on(table.customerId, table.createdAt),
    index("idx_customer_subscriptions_phone").on(table.phoneNumber, table.createdAt),
    index("idx_customer_subscriptions_plan").on(table.planId),
    index("idx_customer_subscriptions_status").on(table.status, table.createdAt),
  ]
);

export const subscriptionOtps = pgTable(
  "subscription_otps",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    subscriptionId: uuid("subscription_id").notNull().references(() => customerSubscriptions.id, { onDelete: "cascade" }),
    phoneNumber: varchar("phone_number", { length: 32 }).notNull(),
    branchId: uuid("branch_id").notNull().references(() => branches.id, { onDelete: "restrict" }),
    requestedByAttendantId: uuid("requested_by_attendant_id").references(() => attendants.id, { onDelete: "set null" }),
    codeHash: varchar("code_hash", { length: 255 }).notNull(),
    attempts: integer("attempts").notNull().default(0),
    status: subscriptionOtpStatusEnum("status").notNull().default("pending"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    usedAt: timestamp("used_at", { withTimezone: true }),
  },
  (table) => [
    index("idx_subscription_otps_subscription_status").on(table.subscriptionId, table.status, table.createdAt),
    index("idx_subscription_otps_created_at").on(table.createdAt),
  ]
);

export type SubscriptionPlan = typeof subscriptionPlans.$inferSelect;
export type CustomerSubscription = typeof customerSubscriptions.$inferSelect;
export type SubscriptionOtp = typeof subscriptionOtps.$inferSelect;
