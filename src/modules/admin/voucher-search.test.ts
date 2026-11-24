import { afterAll, describe, expect, it } from "vitest";
import { inArray } from "drizzle-orm";
import { db } from "../../platform/db/index.js";
import { vouchers } from "../../platform/db/schema/loyalty.js";
import { adminLoyaltyService } from "./loyalty.service.js";

const tag = `VS${Date.now().toString(36).toUpperCase()}`;
const codes = [`${tag}A`, `${tag}B`];

afterAll(async () => {
  await db.delete(vouchers).where(inArray(vouchers.code, codes));
});

describe("voucher search", () => {
  it("never returns a deleted voucher, even when only its name matches", async () => {
    await db.insert(vouchers).values([
      { code: codes[0]!, name: `${tag} live`, discountType: "fixed", discountValue: 100n, maxUsageCount: 1, isActive: true },
      { code: codes[1]!, name: `${tag} gone`, discountType: "fixed", discountValue: 100n, maxUsageCount: 1, isActive: true, deletedAt: new Date() },
    ]);
    // Search by a fragment of the NAME only: with the old unparenthesised OR, the deleted row matched here.
    const { items: rows } = await adminLoyaltyService.listVouchers({ search: `${tag} ` });
    expect(rows.map((r) => r.code)).toEqual([codes[0]]);
  });
});
