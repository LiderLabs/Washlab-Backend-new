import { and, desc, eq, gte, isNull, lte, sql } from "drizzle-orm";
import { db } from "../../platform/db/index.js";
import { attendanceLogs, attendants } from "../../platform/db/schema/staff.js";
import { branches } from "../../platform/db/schema/branches.js";
import { orders } from "../../platform/db/schema/orders.js";
import { payments } from "../../platform/db/schema/payments.js";
import { customers } from "../../platform/db/schema/customers.js";

type Pagination = { limit: number; offset: number };

export const adminDataService = {
  async listAttendanceLogs(query: Pagination & {
    branchId?: string;
    attendantId?: string;
    startDate?: number;
    endDate?: number;
  }) {
    const conditions = [];
    if (query.branchId) conditions.push(eq(attendanceLogs.branchId, query.branchId));
    if (query.attendantId) conditions.push(eq(attendanceLogs.attendantId, query.attendantId));
    if (query.startDate !== undefined) conditions.push(gte(attendanceLogs.clockInAt, new Date(query.startDate)));
    if (query.endDate !== undefined) conditions.push(lte(attendanceLogs.clockInAt, new Date(query.endDate)));
    const where = conditions.length ? and(...conditions) : undefined;
    const [rows, countRows] = await Promise.all([
      db
        .select({
          id: attendanceLogs.id,
          attendantId: attendanceLogs.attendantId,
          attendantName: attendants.name,
          branchId: attendanceLogs.branchId,
          branchName: branches.name,
          clockInAt: attendanceLogs.clockInAt,
          clockOutAt: attendanceLogs.clockOutAt,
          deviceId: attendanceLogs.deviceId,
        })
        .from(attendanceLogs)
        .innerJoin(attendants, eq(attendanceLogs.attendantId, attendants.id))
        .innerJoin(branches, eq(attendanceLogs.branchId, branches.id))
        .where(where)
        .orderBy(desc(attendanceLogs.clockInAt), desc(attendanceLogs.id))
        .limit(query.limit)
        .offset(query.offset),
      db.select({ count: sql<number>`count(*)::int` }).from(attendanceLogs).where(where),
    ]);
    return {
      items: rows.map((row) => ({
        ...row,
        clockInAt: row.clockInAt.toISOString(),
        clockOutAt: row.clockOutAt?.toISOString() ?? null,
      })),
      total: countRows[0]?.count ?? 0,
    };
  },

  async listTransactions(query: Pagination & {
    branchId?: string;
    status?: "pending" | "paid" | "failed" | "refunded";
    method?: "cash" | "mobile_money" | "card" | "voucher" | "subscription";
    startDate?: number;
    endDate?: number;
  }) {
    const conditions = [];
    if (query.branchId) conditions.push(eq(payments.branchId, query.branchId));
    if (query.status) conditions.push(eq(payments.status, query.status));
    if (query.method) conditions.push(eq(payments.method, query.method));
    if (query.startDate !== undefined) conditions.push(gte(payments.createdAt, new Date(query.startDate)));
    if (query.endDate !== undefined) conditions.push(lte(payments.createdAt, new Date(query.endDate)));
    const where = conditions.length ? and(...conditions) : undefined;
    const [rows, countRows] = await Promise.all([
      db
        .select({
          id: payments.id,
          orderId: payments.orderId,
          orderNumber: orders.orderNumber,
          customerId: payments.customerId,
          customerName: customers.name,
          branchId: payments.branchId,
          branchName: branches.name,
          amountPesewas: payments.amountPesewas,
          currency: payments.currency,
          method: payments.method,
          status: payments.status,
          gatewayReference: payments.gatewayReference,
          paidAt: payments.paidAt,
          createdAt: payments.createdAt,
        })
        .from(payments)
        .leftJoin(orders, eq(payments.orderId, orders.id))
        .leftJoin(customers, eq(payments.customerId, customers.id))
        .leftJoin(branches, eq(payments.branchId, branches.id))
        .where(where)
        .orderBy(desc(payments.createdAt), desc(payments.id))
        .limit(query.limit)
        .offset(query.offset),
      db.select({ count: sql<number>`count(*)::int` }).from(payments).where(where),
    ]);
    return {
      items: rows.map((row) => ({
        ...row,
        amountPesewas: row.amountPesewas.toString(),
        paidAt: row.paidAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
      })),
      total: countRows[0]?.count ?? 0,
    };
  },
};

export function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? "" : String(value);
  if (/^[\s]*[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}
