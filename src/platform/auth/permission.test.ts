import { describe, it, expect } from "vitest";
import { can } from "./permissions.js";

describe("permission map", () => {
    it("super_admin can do everything", () => {
        expect(can("super_admin", "branch.delete")).toBe(true);
        expect(can("super_admin", "pricing.update")).toBe(true);
    });

    it("admin cannot run destructive, pricing or settings actions", () => {
        expect(can("admin", "branch.delete")).toBe(false);
        expect(can("admin", "order.delete")).toBe(false);
        expect(can("admin", "pricing.update")).toBe(false);
        expect(can("admin", "settings.update")).toBe(false);
        expect(can("admin", "admin.manage")).toBe(false);
    });

    it("admin can do daily operations", () => {
        expect(can("admin", "order.update_status")).toBe(true);
        expect(can("admin", "report.view")).toBe(true);
    });

    it("attendant cannot manage branches or delete customers", () => {
        expect(can("attendant", "branch.create")).toBe(false);
        expect(can("attendant", "customer.delete")).toBe(false);
        expect(can("attendant", "order.update_status")).toBe(true);
    });

    it("customer has no staff permissions", () => {
        expect(can("customer", "order.read")).toBe(false);
        expect(can("customer", "branch.update")).toBe(false);
    });
});