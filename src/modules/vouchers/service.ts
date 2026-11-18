import { and, eq, sql } from "drizzle-orm";
import { db } from "../../platform/db/index.js";
import { vouchers, voucherUsages } from "../../platform/db/schema/loyalty.js";

export const voucherService = {
  async validateVoucher(args: {
    code: string;
    branchId?: string;
    orderTotal?: number; // In GHS or Pesewas
    serviceType?: string;
    customerId?: string;
  }) {
    const code = args.code.trim().toUpperCase();
    const [voucher] = await db
      .select()
      .from(vouchers)
      .where(and(eq(sql`UPPER(${vouchers.code})`, code), eq(vouchers.isActive, true)))
      .limit(1);

    if (!voucher) {
      return {
        valid: false,
        error: "Voucher not found or inactive",
      };
    }

    const now = new Date();
    if (voucher.validFrom && voucher.validFrom > now) {
      return {
        valid: false,
        error: "This voucher is not yet valid",
      };
    }

    if (voucher.expiresAt && voucher.expiresAt < now) {
      return {
        valid: false,
        error: "This voucher has expired",
      };
    }

    if (voucher.maxUsageCount !== null && voucher.currentUsageCount >= voucher.maxUsageCount) {
      return {
        valid: false,
        error: "Voucher usage limit reached",
      };
    }

    if (voucher.branchId && args.branchId && voucher.branchId !== args.branchId) {
      return {
        valid: false,
        error: "Voucher is not valid for this branch",
      };
    }

    if (
      args.serviceType &&
      voucher.applicableServices &&
      Array.isArray(voucher.applicableServices) &&
      voucher.applicableServices.length > 0 &&
      !voucher.applicableServices.includes(args.serviceType)
    ) {
      return {
        valid: false,
        error: "Voucher is not valid for this service type",
      };
    }

    if (voucher.maxUsesPerCustomer !== null && args.customerId) {
      const [custUsage] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(voucherUsages)
        .where(
          and(
            eq(voucherUsages.voucherId, voucher.id),
            eq(voucherUsages.customerId, args.customerId)
          )
        );
      if (custUsage && custUsage.count >= voucher.maxUsesPerCustomer) {
        return {
          valid: false,
          error: "Customer has reached the usage limit for this voucher",
        };
      }
    }

    // args.orderTotal could be GHS (e.g. 50) or Pesewas (e.g. 5000)
    // If orderTotal < 1000 and not 0, it is likely in GHS
    const rawTotal = args.orderTotal ?? 0;
    const orderTotalPesewas = rawTotal > 0 && rawTotal < 1000 ? Math.round(rawTotal * 100) : rawTotal;
    const minOrderPesewas = Number(voucher.minOrderAmountPesewas || 0n);

    if (minOrderPesewas > 0 && orderTotalPesewas > 0 && orderTotalPesewas < minOrderPesewas) {
      return {
        valid: false,
        error: `Minimum order value of GHS ${(minOrderPesewas / 100).toFixed(2)} required`,
      };
    }

    let discountPesewas = 0;
    if (voucher.discountType === "free_wash") {
      discountPesewas = orderTotalPesewas > 0 ? orderTotalPesewas : 2500;
    } else if (voucher.discountType === "percentage") {
      const pct = Number(voucher.discountValue);
      discountPesewas = Math.round((orderTotalPesewas * pct) / 100);
    } else if (voucher.discountType === "fixed") {
      discountPesewas = Number(voucher.discountValue);
    }

    if (orderTotalPesewas > 0) {
      discountPesewas = Math.min(discountPesewas, orderTotalPesewas);
    }

    const discountAmount = discountPesewas / 100;
    const finalPricePesewas = Math.max(0, orderTotalPesewas - discountPesewas);
    const finalPrice = finalPricePesewas / 100;

    return {
      valid: true,
      voucher: {
        _id: voucher.id,
        id: voucher.id,
        code: voucher.code,
        name: voucher.name,
        discountType: voucher.discountType,
        discountValue: Number(voucher.discountValue),
      },
      discountPesewas,
      discountAmount,
      finalPricePesewas,
      finalPrice,
    };
  },
};
