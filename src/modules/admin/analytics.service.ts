import { and, asc, desc, eq, gte, inArray, isNull, lte, neq, sql } from "drizzle-orm";
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

    const orderRows = await db
      .select({
        id: orders.id,
        customerId: orders.customerId,
        status: orders.status,
        paymentStatus: orders.paymentStatus,
        finalPricePesewas: orders.finalPricePesewas,
        createdAt: orders.createdAt,
      })
      .from(orders)
      .where(and(...conditions))
      .orderBy(desc(orders.createdAt))
      .limit(5000);

    const totalOrders = orderRows.length;
    let totalRevenuePesewas = 0n;
    const ordersByStatus: Record<string, number> = {};
    const ordersByDay: Record<string, number> = {};
    const customerOrderCounts = new Map<string, number>();

    for (const o of orderRows) {
      if (o.paymentStatus === "paid") {
        totalRevenuePesewas += o.finalPricePesewas;
      }

      ordersByStatus[o.status] = (ordersByStatus[o.status] || 0) + 1;

      const dateStr = o.createdAt.toISOString().split("T")[0];
      ordersByDay[dateStr] = (ordersByDay[dateStr] || 0) + 1;

      if (o.customerId) {
        customerOrderCounts.set(o.customerId, (customerOrderCounts.get(o.customerId) || 0) + 1);
      }
    }

    const totalRevenue = Number(totalRevenuePesewas) / 100;
    const averageOrderValue = totalOrders > 0 ? Math.round((totalRevenue / totalOrders) * 100) / 100 : 0;

    // Top 10 customers
    const sortedCustomerEntries = Array.from(customerOrderCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);

    const topCustomerIds = sortedCustomerEntries.map((e) => e[0]);
    let topCustomers: { customerId: string; name: string; phoneNumber: string; orderCount: number }[] = [];

    if (topCustomerIds.length > 0) {
      const customerDetails = await db
        .select({
          id: customers.id,
          name: customers.name,
          phoneNumber: customers.phoneNumber,
        })
        .from(customers)
        .where(inArray(customers.id, topCustomerIds));

      const detailMap = new Map(customerDetails.map((c) => [c.id, c]));

      topCustomers = sortedCustomerEntries.map(([customerId, count]) => {
        const detail = detailMap.get(customerId);
        return {
          customerId,
          name: detail?.name ?? "Unknown",
          phoneNumber: detail?.phoneNumber ?? "",
          orderCount: count,
        };
      });
    }

    return {
      totalOrders,
      totalRevenue: Math.round(totalRevenue * 100) / 100,
      averageOrderValue,
      ordersByStatus,
      ordersByDay,
      topCustomers,
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

    const paymentRows = await db
      .select({
        id: payments.id,
        amountPesewas: payments.amountPesewas,
        method: payments.method,
        paidAt: payments.paidAt,
        createdAt: payments.createdAt,
      })
      .from(payments)
      .where(and(...conditions));

    let totalRevenue = 0;
    let cashAmount = 0;
    let mobileMoneyAmount = 0;
    let cardAmount = 0;
    const byDay: Record<string, number> = {};
    const byDayByMethod: Record<string, { cash: number; mobile_money: number; card: number }> = {};

    for (const p of paymentRows) {
      const amount = Number(p.amountPesewas) / 100;
      totalRevenue += amount;

      if (p.method === "cash") cashAmount += amount;
      else if (p.method === "mobile_money") mobileMoneyAmount += amount;
      else if (p.method === "card") cardAmount += amount;

      const dateStr = (p.paidAt ?? p.createdAt).toISOString().split("T")[0];
      byDay[dateStr] = Math.round(((byDay[dateStr] || 0) + amount) * 100) / 100;

      if (!byDayByMethod[dateStr]) {
        byDayByMethod[dateStr] = { cash: 0, mobile_money: 0, card: 0 };
      }

      if (p.method === "cash") {
        byDayByMethod[dateStr].cash = Math.round((byDayByMethod[dateStr].cash + amount) * 100) / 100;
      } else if (p.method === "mobile_money") {
        byDayByMethod[dateStr].mobile_money = Math.round((byDayByMethod[dateStr].mobile_money + amount) * 100) / 100;
      } else if (p.method === "card") {
        byDayByMethod[dateStr].card = Math.round((byDayByMethod[dateStr].card + amount) * 100) / 100;
      }
    }

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
          neq(orders.status, "cancelled")
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
