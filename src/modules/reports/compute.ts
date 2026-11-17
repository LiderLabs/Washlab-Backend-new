import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../../platform/db/index.js";
import { branchServices } from "../../platform/db/schema/catalog.js";
import { loyaltyLedger, voucherUsages, vouchers } from "../../platform/db/schema/loyalty.js";
import { orders, payments } from "../../platform/db/schema/index.js";
import { attendanceLogs, attendants } from "../../platform/db/schema/staff.js";
import type { ServiceBreakdownItem, VoucherBreakdownItem } from "../../platform/db/schema/reports.js";

/** Fallback unit price (GHS 25) the Convex backend used when a branch has no wash_only / dry_only service. */
export const FALLBACK_UNIT_PRICE_PESEWAS = 2500;

export function dayBounds(date: string) {
  const start = new Date(`${date}T00:00:00.000Z`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start, end };
}

export const todayUtc = () => new Date().toISOString().slice(0, 10);

const titleCase = (code: string) => code.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

/** Washer / dryer tokens for one order. Same rules as the Convex getAutoData (custom codes are inferred from their name). */
export function tokenSplit(serviceType: string, baseLoads: number, extraWash: number, extraDry: number) {
  if (serviceType === "wash_only") return { washer: baseLoads + extraWash, dryer: 0, label: "Wash Only" };
  if (serviceType === "dry_only") return { washer: 0, dryer: baseLoads + extraDry, label: "Dry Only" };
  if (serviceType === "wash_and_dry") {
    return { washer: baseLoads + extraWash, dryer: baseLoads + extraDry, label: "Wash & Dry" };
  }
  const hasDry = serviceType.includes("dry");
  const hasWash = serviceType.includes("wash");
  if (hasDry && hasWash) return { washer: baseLoads + extraWash, dryer: baseLoads + extraDry, label: null };
  if (hasDry) return { washer: 0, dryer: baseLoads + extraDry, label: null };
  return { washer: baseLoads + extraWash, dryer: extraDry, label: null };
}

export type ServicePriceRow = {
  pricePesewas: number;
  extraWashPricePesewas: number | null;
  extraDryPricePesewas: number | null;
};

/** What one order's tokens are worth, split washer / dryer, using the order's own service prices. */
export function tokenRevenue(
  serviceType: string,
  baseLoads: number,
  extraWash: number,
  extraDry: number,
  svc: ServicePriceRow | undefined,
  fallbackWasher: number,
  fallbackDryer: number
) {
  const price = svc?.pricePesewas ?? fallbackWasher;
  const extraWashPrice = svc?.extraWashPricePesewas ?? fallbackWasher;
  const extraDryPrice = svc?.extraDryPricePesewas ?? fallbackDryer;
  const isDryOnly = serviceType === "dry_only" || (serviceType.includes("dry") && !serviceType.includes("wash"));
  const isBoth = serviceType === "wash_and_dry" || (serviceType.includes("wash") && serviceType.includes("dry"));

  if (isDryOnly) return { washer: 0, dryer: baseLoads * price + extraDry * extraDryPrice };
  if (isBoth) {
    const separate = svc?.extraDryPricePesewas != null;
    const washerUnit = separate ? price : price / 2;
    const dryerUnit = separate ? extraDryPrice : price / 2;
    return {
      washer: baseLoads * washerUnit + extraWash * extraWashPrice,
      dryer: baseLoads * dryerUnit + extraDry * dryerUnit,
    };
  }
  return { washer: baseLoads * price + extraWash * extraWashPrice, dryer: extraDry > 0 ? extraDry * extraDryPrice : 0 };
}

/**
 * The day an order counts for: when the attendant received it. Online orders use checked_in_at, walk-ins use created_at.
 * Tokens and payments share this anchor so nothing is counted on two days.
 */
const processedAt = sql`CASE WHEN ${orders.orderType} = 'online' THEN COALESCE(${orders.checkedInAt}, ${orders.createdAt}) ELSE ${orders.createdAt} END`;

export type AutoReport = Awaited<ReturnType<typeof computeAutoReport>>;

export async function computeAutoReport(branchId: string, date: string) {
  const { start, end } = dayBounds(date);
  const startIso = start.toISOString();
  const endIso = end.toISOString();

  const dayOrders = await db
    .select({
      id: orders.id,
      serviceType: orders.serviceType,
      status: orders.status,
      paymentStatus: orders.paymentStatus,
      estimatedLoads: orders.estimatedLoads,
      extraWashLoads: orders.extraWashLoads,
      extraDryLoads: orders.extraDryLoads,
      finalPricePesewas: orders.finalPricePesewas,
      discountPesewas: orders.discountPesewas,
    })
    .from(orders)
    .where(
      and(
        eq(orders.branchId, branchId),
        isNull(orders.deletedAt),
        sql`${processedAt} >= ${startIso}::timestamptz AND ${processedAt} < ${endIso}::timestamptz`
      )
    );

  const services = await db
    .select()
    .from(branchServices)
    .where(and(eq(branchServices.branchId, branchId), isNull(branchServices.deletedAt)));
  const byCode = new Map(services.map((s) => [s.code, s]));
  const priceRow = (code: string): ServicePriceRow | undefined => {
    const s = byCode.get(code);
    return s
      ? {
          pricePesewas: Number(s.pricePesewas),
          extraWashPricePesewas: s.extraWashPricePesewas == null ? null : Number(s.extraWashPricePesewas),
          extraDryPricePesewas: s.extraDryPricePesewas == null ? null : Number(s.extraDryPricePesewas),
        }
      : undefined;
  };
  const washerPrice = priceRow("wash_only")?.pricePesewas ?? FALLBACK_UNIT_PRICE_PESEWAS;
  const dryerPrice = priceRow("dry_only")?.pricePesewas ?? FALLBACK_UNIT_PRICE_PESEWAS;

  // "Active" = work the branch actually took in: not cancelled and not still waiting for drop-off.
  const active = dayOrders.filter((o) => o.status !== "cancelled" && o.status !== "pending_dropoff");

  let washerTokensUsed = 0;
  let dryerTokensUsed = 0;
  let washerRevenue = 0;
  let dryerRevenue = 0;
  const serviceMap = new Map<string, ServiceBreakdownItem>();

  for (const o of active) {
    const base = o.estimatedLoads ?? 1;
    const split = tokenSplit(o.serviceType, base, o.extraWashLoads, o.extraDryLoads);
    washerTokensUsed += split.washer;
    dryerTokensUsed += split.dryer;
    const label = split.label ?? byCode.get(o.serviceType)?.name ?? titleCase(o.serviceType);
    const row = serviceMap.get(o.serviceType) ?? { serviceType: o.serviceType, label, count: 0, tokensUsed: 0 };
    row.count += 1;
    row.tokensUsed += split.washer + split.dryer;
    serviceMap.set(o.serviceType, row);

    const rev = tokenRevenue(
      o.serviceType,
      base,
      o.extraWashLoads,
      o.extraDryLoads,
      priceRow(o.serviceType),
      washerPrice,
      dryerPrice
    );
    washerRevenue += rev.washer;
    dryerRevenue += rev.dryer;
  }

  // Payments received today, on orders of this branch. Revenue is the ORDER price (the payment row may include Paystack fees).
  const paidToday = await db
    .select({
      method: payments.method,
      orderFinal: orders.finalPricePesewas,
      // Decided in SQL so no timestamp has to be parsed back out of the driver.
      handledToday: sql<boolean>`(${processedAt} >= ${startIso}::timestamptz AND ${processedAt} < ${endIso}::timestamptz)`,
    })
    .from(payments)
    .innerJoin(orders, eq(orders.id, payments.orderId))
    .where(
      and(
        eq(orders.branchId, branchId),
        isNull(orders.deletedAt),
        eq(payments.status, "paid"),
        sql`${payments.paidAt} >= ${startIso}::timestamptz AND ${payments.paidAt} < ${endIso}::timestamptz`
      )
    );

  let cash = 0;
  let momo = 0;
  let card = 0;
  let freeWashCount = 0;
  let recovered = 0;
  for (const p of paidToday) {
    const amount = Number(p.orderFinal);
    if (p.handledToday) {
      if (amount === 0) {
        freeWashCount += 1;
        continue;
      }
      if (p.method === "cash") cash += amount;
      else if (p.method === "mobile_money") momo += amount;
      else if (p.method === "card") card += amount;
    } else if (amount > 0) {
      // Paid today for an order handled on an earlier day.
      recovered += amount;
    }
  }

  const outstanding = active.filter((o) => o.paymentStatus !== "paid");
  const outstandingAmount = outstanding.reduce((s, o) => s + Number(o.finalPricePesewas), 0);
  const expectedRevenue = dayOrders
    .filter((o) => o.paymentStatus === "paid")
    .reduce((s, o) => s + Number(o.finalPricePesewas), 0);

  // Vouchers and loyalty used on today's orders.
  const orderIds = dayOrders.map((o) => o.id);
  const voucherMap = new Map<string, VoucherBreakdownItem>();
  const voucherDiscountByOrder = new Map<string, number>();
  if (orderIds.length) {
    const usages = await db
      .select({
        orderId: voucherUsages.orderId,
        voucherId: voucherUsages.voucherId,
        discount: voucherUsages.discountAppliedPesewas,
        code: vouchers.code,
        discountType: vouchers.discountType,
        discountValue: vouchers.discountValue,
      })
      .from(voucherUsages)
      .innerJoin(vouchers, eq(vouchers.id, voucherUsages.voucherId))
      .where(inArray(voucherUsages.orderId, orderIds));
    for (const u of usages) {
      voucherDiscountByOrder.set(u.orderId, (voucherDiscountByOrder.get(u.orderId) ?? 0) + Number(u.discount));
      const row = voucherMap.get(u.voucherId) ?? {
        voucherId: u.voucherId,
        code: u.code,
        name: u.code,
        discountType: u.discountType,
        discountValue: Number(u.discountValue),
        count: 0,
        totalDiscountPesewas: 0,
      };
      row.count += 1;
      row.totalDiscountPesewas += Number(u.discount);
      voucherMap.set(u.voucherId, row);
    }

    const redemptions = await db
      .select({ orderId: loyaltyLedger.orderId })
      .from(loyaltyLedger)
      .where(and(eq(loyaltyLedger.reason, "reward_redemption"), inArray(loyaltyLedger.orderId, orderIds)));
    if (redemptions.length) {
      const discountByOrder = new Map(dayOrders.map((o) => [o.id, Number(o.discountPesewas)]));
      // The order's discount also holds any voucher on it, which is already counted above.
      const total = redemptions.reduce(
        (s, r) => s + Math.max(0, (discountByOrder.get(r.orderId!) ?? 0) - (voucherDiscountByOrder.get(r.orderId!) ?? 0)),
        0
      );
      voucherMap.set("__loyalty__", {
        voucherId: "__loyalty__",
        code: "LOYALTY",
        name: "Loyalty Reward",
        discountType: "loyalty",
        count: redemptions.length,
        totalDiscountPesewas: total,
      });
    }
  }

  const shift = await db
    .selectDistinct({ name: attendants.name })
    .from(attendanceLogs)
    .innerJoin(attendants, eq(attendants.id, attendanceLogs.attendantId))
    .where(
      and(
        eq(attendanceLogs.branchId, branchId),
        sql`${attendanceLogs.clockInAt} >= ${startIso}::timestamptz AND ${attendanceLogs.clockInAt} < ${endIso}::timestamptz`
      )
    );

  const tokenRevenueTotal = Math.round(washerRevenue) + Math.round(dryerRevenue);
  return {
    date,
    washerPricePesewas: washerPrice,
    dryerPricePesewas: dryerPrice,
    washerTokensUsed,
    dryerTokensUsed,
    washerTokenRevenuePesewas: Math.round(washerRevenue),
    dryerTokenRevenuePesewas: Math.round(dryerRevenue),
    tokenRevenuePesewas: tokenRevenueTotal,
    cashPesewas: cash,
    mobileMoneyPesewas: momo,
    cardPesewas: card,
    freeWashCount,
    totalRevenuePesewas: cash + momo + card,
    expectedRevenuePesewas: expectedRevenue,
    totalOrders: dayOrders.length,
    serviceBreakdown: [...serviceMap.values()],
    voucherBreakdown: [...voucherMap.values()],
    outstandingAmountPesewas: outstandingAmount,
    outstandingOrderCount: outstanding.length,
    outstandingRecoveredPesewas: recovered,
    todayAttendantNames: shift.map((s) => s.name).filter(Boolean),
  };
}
