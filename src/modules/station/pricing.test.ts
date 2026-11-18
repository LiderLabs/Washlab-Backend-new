import { describe, expect, it } from "vitest";
import { calculatePrice, loadsForWeight, PricingInput, ServicePrices } from "./pricing.js";

const p = (n: number, extraWash: number | null = null, extraDry: number | null = null): ServicePrices => ({
  pricePesewas: BigInt(n),
  extraWashPricePesewas: extraWash === null ? null : BigInt(extraWash),
  extraDryPricePesewas: extraDry === null ? null : BigInt(extraDry),
});

const base: PricingInput = {
  mode: "walk_in",
  serviceType: "wash_only",
  weightKg: 5,
  services: { wash_only: p(3000), dry_only: p(2000), wash_and_dry: p(5000) },
  branchFallbackPerLoadPesewas: 4000n,
  isDelivery: false,
  branchDeliveryFeePesewas: 500n,
  extraWashLoads: 0,
  extraDryLoads: 0,
};

describe("loadsForWeight", () => {
  it("rounds up per 8 kg", () => {
    expect(loadsForWeight(0.5)).toBe(1);
    expect(loadsForWeight(8)).toBe(1);
    expect(loadsForWeight(8.01)).toBe(2);
    expect(loadsForWeight(17)).toBe(3);
  });
});

describe("calculatePrice", () => {
  it("charges per load, not per kg", () => {
    const r = calculatePrice({ ...base, weightKg: 9 });
    expect(r.loads).toBe(2);
    expect(r.totalPesewas).toBe(6000n);
  });

  it("wash_and_dry is wash + dry per load", () => {
    const r = calculatePrice({ ...base, serviceType: "wash_and_dry", weightKg: 9 });
    expect(r.basePricePesewas).toBe(10000n); // 2 x (3000 + 2000)
  });

  it("service mode (check-in, edit) uses the service's own price and ignores machines", () => {
    const r = calculatePrice({ ...base, mode: "service", serviceType: "wash_and_dry", weightKg: 9, machineWashPricePesewas: 100n });
    expect(r.basePricePesewas).toBe(2n * 5000n); // 2 loads x the wash_and_dry price, not wash + dry
  });

  it("uses the machine price when one is selected", () => {
    const r = calculatePrice({ ...base, machineWashPricePesewas: 3500n });
    expect(r.totalPesewas).toBe(3500n);
  });

  it("falls back to the branch rate when the service has no row", () => {
    const r = calculatePrice({ ...base, serviceType: "ironing", services: {} });
    expect(r.totalPesewas).toBe(4000n);
  });

  it("adds delivery only for delivery orders", () => {
    expect(calculatePrice({ ...base, isDelivery: true }).totalPesewas).toBe(3500n);
    expect(calculatePrice({ ...base, isDelivery: false }).totalPesewas).toBe(3000n);
  });

  it("prices extra loads from the service's extra prices, else wash/dry prices", () => {
    const withOwn = calculatePrice({
      ...base,
      serviceType: "wash_and_dry",
      services: { ...base.services, wash_and_dry: p(5000, 2500, 1500) },
      extraWashLoads: 2,
      extraDryLoads: 1,
    });
    expect(withOwn.extrasPesewas).toBe(2n * 2500n + 1500n);

    const fallback = calculatePrice({ ...base, serviceType: "wash_and_dry", extraWashLoads: 2, extraDryLoads: 1 });
    expect(fallback.extrasPesewas).toBe(2n * 3000n + 2000n);
  });

  it("ignores extras that don't belong to the service", () => {
    expect(calculatePrice({ ...base, serviceType: "wash_only", extraWashLoads: 1, extraDryLoads: 5 }).extrasPesewas).toBe(3000n);
    expect(calculatePrice({ ...base, serviceType: "dry_only", extraWashLoads: 5, extraDryLoads: 1 }).extrasPesewas).toBe(2000n);
  });

  it("never loses precision on large values", () => {
    const big = 9_007_199_254_740_993n; // beyond Number.MAX_SAFE_INTEGER
    const r = calculatePrice({
      ...base,
      weightKg: 800,
      services: { wash_only: { pricePesewas: big, extraWashPricePesewas: null, extraDryPricePesewas: null } },
    });
    expect(r.totalPesewas).toBe(100n * big);
  });
});
