import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { db } from "../../platform/db/index.js";
import { branchServices } from "../../platform/db/schema/catalog.js";

export const catalogService = {
  async getActiveServices(query: { limit: number; offset: number }) {
    const condition = and(eq(branchServices.isActive, true), isNull(branchServices.deletedAt));
    const [rows, countRows] = await Promise.all([
      db
        .selectDistinctOn([branchServices.code])
        .from(branchServices)
        .where(condition)
        .orderBy(branchServices.code, asc(branchServices.name))
        .limit(query.limit)
        .offset(query.offset),
      db.select({ count: sql<number>`count(distinct ${branchServices.code})::int` })
        .from(branchServices).where(condition),
    ]);

    return {
      items: rows.map((s) => {
      const priceGhs = Number(s.pricePesewas) / 100;
      return {
        _id: s.id,
        id: s.id,
        name: s.name,
        code: s.code,
        description: s.description ?? "",
        imageUrl: s.imageUrl ?? undefined,
        basePrice: priceGhs,
        price: priceGhs,
        pricePesewas: s.pricePesewas.toString(),
        pricingType: "per_load",
        isActive: s.isActive,
      };
      }),
      total: countRows[0]?.count ?? 0,
    };
  },

  async getBranchServices(branchId: string, query: { limit: number; offset: number }) {
    const condition = and(
      eq(branchServices.branchId, branchId),
      eq(branchServices.isActive, true),
      isNull(branchServices.deletedAt)
    );
    const [rows, countRows] = await Promise.all([
      db
      .select()
      .from(branchServices)
      .where(condition)
      .orderBy(asc(branchServices.name))
      .limit(query.limit)
      .offset(query.offset),
      db.select({ count: sql<number>`count(*)::int` }).from(branchServices).where(condition),
    ]);

    return { items: rows.map((s) => {
      const priceGhs = Number(s.pricePesewas) / 100;
      return {
        _id: s.id,
        id: s.id,
        branchId: s.branchId,
        name: s.name,
        code: s.code,
        description: s.description ?? "",
        imageUrl: s.imageUrl ?? undefined,
        basePrice: priceGhs,
        price: priceGhs,
        pricePesewas: s.pricePesewas.toString(),
        extraWashPricePesewas: s.extraWashPricePesewas ? s.extraWashPricePesewas.toString() : null,
        extraDryPricePesewas: s.extraDryPricePesewas ? s.extraDryPricePesewas.toString() : null,
        isActive: s.isActive,
        showOnCustomerSide: s.showOnCustomerSide,
        pricingType: "per_load",
      };
    }), total: countRows[0]?.count ?? 0 };
  },
};
