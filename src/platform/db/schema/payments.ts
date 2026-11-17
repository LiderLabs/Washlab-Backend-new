import { pgTable, uuid, varchar, bigint, timestamp, index, uniqueIndex, jsonb, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { orders, paymentStatusEnum, paymentMethodEnum } from "./orders.js";
import { branches } from "./branches.js";
import { customers } from "./customers.js";
import { attendants } from "./staff.js";

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
    gatewayTransactionId: varchar("gateway_transaction_id", { length: 64 }),
    processedByAttendantId: uuid("processed_by_attendant_id").references(() => attendants.id, { onDelete: "set null" }),
    metadata: jsonb("metadata"),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_payments_branch_date").on(table.branchId, table.createdAt),
    index("idx_payments_order").on(table.orderId),
    // Cash ledger buckets by paid_at, so it needs to be cheap to scan per branch.
    index("idx_payments_branch_paid").on(table.branchId, table.paidAt).where(sql`status = 'paid'`),
    // A MoMo or card payment can't be marked paid without a gateway reference
    // (this is what stops cash being recorded as MoMo, and MoMo with no proof of payment).
    check(
      "chk_gateway_payment_has_reference",
      sql`method NOT IN ('mobile_money','card') OR status <> 'paid' OR gateway_reference IS NOT NULL`
    ),
    check("chk_payment_amount_positive", sql`amount_pesewas >= 0`),
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

export type Payment = typeof payments.$inferSelect;
export type NewPayment = typeof payments.$inferInsert;
