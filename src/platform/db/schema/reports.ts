import { pgTable, uuid, varchar, text, bigint, integer, date, jsonb, timestamp, index, uniqueIndex, pgEnum } from "drizzle-orm/pg-core";
import { branches } from "./branches.js";
import { attendants } from "./staff.js";

export const dailyReportStatusEnum = pgEnum("daily_report_status", [
  "draft",
  "submitted",
  "submitted_with_outstanding",
]);

/**
 * End-of-day branch report. One row per branch per UTC day.
 * Money and outstanding figures are computed by the server from payments and orders (never taken from the client).
 * Amounts are pesewas.
 */
export const dailyReports = pgTable(
  "daily_reports",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    legacyConvexId: varchar("legacy_convex_id", { length: 64 }).unique(),
    branchId: uuid("branch_id").notNull().references(() => branches.id, { onDelete: "restrict" }),
    attendantId: uuid("attendant_id").references(() => attendants.id, { onDelete: "set null" }),
    reportDate: date("report_date", { mode: "string" }).notNull(),
    attendantsOnShift: jsonb("attendants_on_shift").$type<string[]>().notNull().default([]),
    washerTokensUsed: integer("washer_tokens_used").notNull().default(0),
    dryerTokensUsed: integer("dryer_tokens_used").notNull().default(0),
    totalTokensUsed: integer("total_tokens_used").notNull().default(0),
    serviceBreakdown: jsonb("service_breakdown").$type<ServiceBreakdownItem[]>().notNull().default([]),
    voucherBreakdown: jsonb("voucher_breakdown").$type<VoucherBreakdownItem[]>().notNull().default([]),
    cashPesewas: bigint("cash_pesewas", { mode: "number" }).notNull().default(0),
    mobileMoneyPesewas: bigint("mobile_money_pesewas", { mode: "number" }).notNull().default(0),
    cardPesewas: bigint("card_pesewas", { mode: "number" }).notNull().default(0),
    totalRevenuePesewas: bigint("total_revenue_pesewas", { mode: "number" }).notNull().default(0),
    soapUnitsUsed: integer("soap_units_used").notNull().default(0),
    freeWashCount: integer("free_wash_count").notNull().default(0),
    washingPlanCount: integer("washing_plan_count").notNull().default(0),
    technicalFaultCount: integer("technical_fault_count").notNull().default(0),
    technicalFaultNotes: text("technical_fault_notes"),
    outstandingAmountPesewas: bigint("outstanding_amount_pesewas", { mode: "number" }).notNull().default(0),
    outstandingOrderCount: integer("outstanding_order_count").notNull().default(0),
    outstandingRecoveredPesewas: bigint("outstanding_recovered_pesewas", { mode: "number" }).notNull().default(0),
    status: dailyReportStatusEnum("status").notNull().default("draft"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_daily_reports_branch_date").on(table.branchId, table.reportDate),
    index("idx_daily_reports_date").on(table.reportDate),
  ]
);

export type ServiceBreakdownItem = { serviceType: string; label: string; count: number; tokensUsed: number };
export type VoucherBreakdownItem = {
  voucherId: string;
  code: string;
  name: string;
  discountType: string;
  discountValue?: number;
  count: number;
  totalDiscountPesewas: number;
};
export type DailyReport = typeof dailyReports.$inferSelect;
