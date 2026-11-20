import { and, asc, desc, eq, gte, isNotNull, isNull, lte, ne, sql } from "drizzle-orm";
import { db } from "../../platform/db/index.js";
import { orders } from "../../platform/db/schema/orders.js";
import { payments } from "../../platform/db/schema/payments.js";
import { branches } from "../../platform/db/schema/branches.js";
import { customers } from "../../platform/db/schema/customers.js";

export const adminAnalyticsService = {
  async getOverview(query: {
    branchId?: string;
    startDate?: number;
    endDate?: number;
  }) {
    const conditions = [isNull(orders.deletedAt)];

    if (query.branchId) {
      conditions.push(eq(orders.branchId, query.branchId));
    }

    if (query.startDate) {
      conditions.push(gte(orders.createdAt, new Date(query.startDate)));
    }

    if (query.endDate) {
      conditions.push(lte(orders.createdAt, new Date(query.endDate)));
    }

    const [summary] = await db
      .select({
        totalOrders: sql<number>`count(*)::int`,
        totalRevenuePesewas: sql<string>`coalesce(sum(${orders.finalPricePesewas}) filter (where ${orders.paymentStatus} = 'paid'), 0)::text`,
      })
      .from(orders)
      .where(and(...conditions));

    const [statusRows, dailyRows, topCustomers] = await Promise.all([
      db.select({ status: orders.status, count: sql<number>`count(*)::int` })
        .from(orders).where(and(...conditions)).groupBy(orders.status),
      db.select({
        day: sql<string>`to_char(${orders.createdAt} at time zone 'UTC', 'YYYY-MM-DD')`,
        count: sql<number>`count(*)::int`,
      }).from(orders).where(and(...conditions))
        .groupBy(sql`to_char(${orders.createdAt} at time zone 'UTC', 'YYYY-MM-DD')`)
        .orderBy(sql`to_char(${orders.createdAt} at time zone 'UTC', 'YYYY-MM-DD')`),
      db.select({
        customerId: orders.customerId,
        name: customers.name,
        phoneNumber: customers.phoneNumber,
        orderCount: sql<number>`count(*)::int`,
      }).from(orders)
        .leftJoin(customers, eq(orders.customerId, customers.id))
        .where(and(...conditions, isNotNull(orders.customerId)))
        .groupBy(orders.customerId, customers.name, customers.phoneNumber)
        .orderBy(desc(sql`count(*)`))
        .limit(10),
    ]);

    const totalOrders = summary?.totalOrders ?? 0;
    const totalRevenue = Number(summary?.totalRevenuePesewas ?? 0) / 100;
    const ordersByStatus = Object.fromEntries(statusRows.map((row) => [row.status, row.count]));
    const ordersByDay = Object.fromEntries(dailyRows.map((row) => [row.day, row.count]));
    const averageOrderValue = totalOrders > 0 ? Math.round((totalRevenue / totalOrders) * 100) / 100 : 0;

    return {
      totalOrders,
      totalRevenue: Math.round(totalRevenue * 100) / 100,
      averageOrderValue,
      ordersByStatus,
      ordersByDay,
      topCustomers: topCustomers.filter((row) => row.customerId !== null).map((row) => ({
        customerId: row.customerId!,
        name: row.name ?? "Unknown",
        phoneNumber: row.phoneNumber ?? "",
        orderCount: row.orderCount,
      })),
      dateRange: {
        start: query.startDate,
        end: query.endDate,
      },
    };
  },

  async getPaymentStats(query: {
    startDate: string;
    endDate: string;
    branchId?: string;
  }) {
    const startTs = new Date(`${query.startDate}T00:00:00.000Z`);
    const endTs = new Date(`${query.endDate}T23:59:59.999Z`);

    const conditions = [
      gte(payments.createdAt, startTs),
      lte(payments.createdAt, endTs),
      eq(payments.status, "paid"),
    ];

    if (query.branchId) {
      conditions.push(eq(payments.branchId, query.branchId));
    }

    const rows = await db.select({
      day: sql<string>`to_char(coalesce(${payments.paidAt}, ${payments.createdAt}) at time zone 'UTC', 'YYYY-MM-DD')`,
      method: payments.method,
      amountPesewas: sql<string>`coalesce(sum(${payments.amountPesewas}), 0)::text`,
    }).from(payments).where(and(...conditions))
      .groupBy(
        sql`to_char(coalesce(${payments.paidAt}, ${payments.createdAt}) at time zone 'UTC', 'YYYY-MM-DD')`,
        payments.method
      );

    const totals = new Map<string, number>();
    const byDayByMethod: Record<string, { cash: number; mobile_money: number; card: number }> = {};
    const dayTotals = new Map<string, number>();
    let totalRevenue = 0;
    for (const row of rows) {
      const amount = Number(row.amountPesewas) / 100;
      totalRevenue += amount;
      totals.set(row.method, (totals.get(row.method) ?? 0) + amount);
      byDayByMethod[row.day] = byDayByMethod[row.day] ?? { cash: 0, mobile_money: 0, card: 0 };
      dayTotals.set(row.day, (dayTotals.get(row.day) ?? 0) + amount);
      if (row.method === "cash" || row.method === "mobile_money" || row.method === "card") {
        byDayByMethod[row.day][row.method] = Math.round(
          (byDayByMethod[row.day][row.method] + amount) * 100
        ) / 100;
      }
    }

    const byDay = Object.fromEntries(Array.from(dayTotals, ([day, amount]) => [day, Math.round(amount * 100) / 100]));
    const cashAmount = totals.get("cash") ?? 0;
    const mobileMoneyAmount = totals.get("mobile_money") ?? 0;
    const cardAmount = totals.get("card") ?? 0;

    return {
      totalRevenue: Math.round(totalRevenue * 100) / 100,
      cashAmount: Math.round(cashAmount * 100) / 100,
      mobileMoneyAmount: Math.round(mobileMoneyAmount * 100) / 100,
      cardAmount: Math.round(cardAmount * 100) / 100,
      paystackAmount: Math.round(cardAmount * 100) / 100,
      byDay,
      byDayByMethod,
    };
  },

  async getWeeklyOrderStats(query: {
    weekStart?: number;
    weekEnd?: number;
  }) {
    let weekStartTs = query.weekStart;
    if (!weekStartTs) {
      const now = new Date();
      const startOfWeek = new Date(now);
      startOfWeek.setDate(now.getDate() - now.getDay());
      startOfWeek.setHours(0, 0, 0, 0);
      weekStartTs = startOfWeek.getTime();
    }

    const weekEndTs = query.weekEnd ?? weekStartTs + 7 * 24 * 60 * 60 * 1000;

    const branchList = await db
      .select({
        id: branches.id,
        name: branches.name,
        weeklyOrderTarget: branches.weeklyOrderTarget,
      })
      .from(branches)
      .where(and(isNull(branches.deletedAt), eq(branches.isActive, true)));

    const weekOrders = await db
      .select({
        branchId: orders.branchId,
        count: sql<number>`count(*)::int`,
      })
      .from(orders)
      .where(
        and(
          isNull(orders.deletedAt),
          gte(orders.createdAt, new Date(weekStartTs)),
          lte(orders.createdAt, new Date(weekEndTs)),
          ne(orders.status, "cancelled")
        )
      )
      .groupBy(orders.branchId);

    const countMap = new Map(weekOrders.map((w) => [w.branchId, w.count]));

    return branchList.map((b) => ({
      branchId: b.id,
      branchName: b.name,
      weeklyOrders: countMap.get(b.id) ?? 0,
      weeklyTarget: b.weeklyOrderTarget ?? 0,
    }));
  },
};
