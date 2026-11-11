import { describe, it, expect } from "vitest";
import { updateBranchInputSchema, createBranchInputSchema } from "./schemas.js";

describe("branch schemas", () => {
    it("update does not inject defaults for omitted fields", () => {
        const parsed = updateBranchInputSchema.parse({ name: "New Name" });
        expect(parsed).toEqual({ name: "New Name" });
    });

    it("rejects short PINs", () => {
        const base = {
            name: "Main", code: "MAIN", phoneNumber: "0240000000", address: "1 Street",
            city: "Accra", pricingPerKgPesewas: 1500,
        };
        expect(createBranchInputSchema.safeParse({ ...base, stationPin: "1234" }).success).toBe(false);
        expect(createBranchInputSchema.safeParse({ ...base, stationPin: "123456" }).success).toBe(true);
    });
});