import { and, asc, eq, isNull } from "drizzle-orm";
import { db } from "../../platform/db/index.js";
import { branchServices } from "../../platform/db/schema/catalog.js";

export const catalogService = {
  async getActiveServices() {
    const rows = await db
      .select()
      .from(branchServices)
      .where(and(eq(branchServices.isActive, true), isNull(branchServices.deletedAt)))
      .orderBy(asc(branchServices.name));

    // Deduplicate by code if services exist across multiple branches
    const seenCodes = new Set<string>();
    const results = [];

    for (const s of rows) {
      if (seenCodes.has(s.code)) continue;
      seenCodes.add(s.code);
      const priceGhs = Number(s.pricePesewas) / 100;
      results.push({
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
      });
    }

    return results;
  },

  async getBranchServices(branchId: string) {
    const rows = await db
      .select()
      .from(branchServices)
      .where(
        and(
          eq(branchServices.branchId, branchId),
          eq(branchServices.isActive, true),
          isNull(branchServices.deletedAt)
        )
      )
      .orderBy(asc(branchServices.name));

    return rows.map((s) => {
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
    });
  },
};
