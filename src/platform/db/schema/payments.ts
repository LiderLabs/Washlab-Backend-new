import { pgTable, uuid, varchar, bigint, timestamp, index, uniqueIndex, pgEnum, jsonb } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { orders, paymentStatusEnum } from "./orders.js";
import { branches } from "./branches.js";
import { customers } from "./customers.js";
import { attendants } from "./staff.js";

export const paymentMethodEnum = pgEnum("payment_method", [
  "cash",
  "mobile_money",
  "card",
  "voucher",
]);

export const payments = pgTable(
  "payments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    legacyConvexId: varchar("legacy_convex_id", { length: 64 }).unique(),
    orderId: uuid("order_id").references(() => orders.id, { onDelete: "restrict" }),
    branchId: uuid("branch_id").notNull().references(() => branches.id, { onDelete: "restrict" }), // Denormalized for zero-join reporting
    customerId: uuid("customer_id").notNull().references(() => customers.id, { onDelete: "restrict" }),
    amountPesewas: bigint("amount_pesewas", { mode: "bigint" }).notNull(),
    currency: varchar("currency", { length: 3 }).notNull().default("GHS"),
    method: paymentMethodEnum("method").notNull(),
    status: paymentStatusEnum("status").notNull().default("pending"),
    gatewayReference: varchar("gateway_reference", { length: 128 }).unique(),
    idempotencyKey: varchar("idempotency_key", { length: 128 }).unique(),
    metadata: jsonb("metadata"),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_payments_branch_date").on(table.branchId, table.createdAt),
    index("idx_payments_reconciliation").on(table.status, table.createdAt).where(sql`status = 'pending'`),
  ]
);

export const webhookEvents = pgTable(
  "webhook_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    provider: varchar("provider", { length: 32 }).notNull(), // 'paystack', 'clerk', 'hubtel'
    eventId: varchar("event_id", { length: 128 }).notNull(),
    eventType: varchar("event_type", { length: 64 }).notNull(),
    payload: jsonb("payload").notNull(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    errorMessage: varchar("error_message", { length: 500 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_provider_event").on(table.provider, table.eventId),
  ]
);

export const cashReconciliations = pgTable(
  "cash_reconciliations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    legacyConvexId: varchar("legacy_convex_id", { length: 64 }).unique(),
    branchId: uuid("branch_id").notNull().references(() => branches.id, { onDelete: "restrict" }),
    attendantId: uuid("attendant_id").notNull().references(() => attendants.id, { onDelete: "restrict" }),
    expectedAmountPesewas: bigint("expected_amount_pesewas", { mode: "bigint" }).notNull(),
    actualAmountPesewas: bigint("actual_amount_pesewas", { mode: "bigint" }).notNull(),
    discrepancyPesewas: bigint("discrepancy_pesewas", { mode: "bigint" }).notNull().default(sql`0`),
    status: varchar("status", { length: 32 }).notNull().default("submitted"), // 'submitted', 'verified', 'discrepancy'
    verifiedByAdminId: uuid("verified_by_admin_id"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    notes: varchar("notes", { length: 500 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_cash_reconciliation_branch").on(table.branchId, table.createdAt),
  ]
);

export type Payment = typeof payments.$inferSelect;
export type NewPayment = typeof payments.$inferInsert;
