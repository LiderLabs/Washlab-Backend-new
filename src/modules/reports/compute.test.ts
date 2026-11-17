import { describe, expect, it } from "vitest";
import { tokenRevenue, tokenSplit } from "./compute.js";

describe("tokenSplit (same rules as the Convex daily report)", () => {
  it("wash only uses washers, dry only uses dryers", () => {
    expect(tokenSplit("wash_only", 2, 1, 5)).toMatchObject({ washer: 3, dryer: 0 });
    expect(tokenSplit("dry_only", 2, 5, 1)).toMatchObject({ washer: 0, dryer: 3 });
  });
  it("wash and dry uses both, each with its own extras", () => {
    expect(tokenSplit("wash_and_dry", 2, 1, 3)).toMatchObject({ washer: 3, dryer: 5 });
  });
  it("custom codes are inferred from their name", () => {
    expect(tokenSplit("wash_dry_fold", 1, 0, 0)).toMatchObject({ washer: 1, dryer: 1 });
    expect(tokenSplit("quick_dry", 1, 0, 2)).toMatchObject({ washer: 0, dryer: 3 });
    expect(tokenSplit("duvet", 1, 1, 2)).toMatchObject({ washer: 2, dryer: 2 }); // base+extraWash, extraDry only
  });
});

describe("tokenRevenue", () => {
  const svc = { pricePesewas: 5000, extraWashPricePesewas: 3000, extraDryPricePesewas: null };
  it("splits a wash_and_dry price in half when there is no separate dry price", () => {
    expect(tokenRevenue("wash_and_dry", 2, 0, 0, svc, 2500, 2500)).toEqual({ washer: 5000, dryer: 5000 });
  });
  it("uses the extra prices for extra loads", () => {
    expect(tokenRevenue("wash_only", 1, 2, 0, { ...svc, pricePesewas: 3000 }, 2500, 2500)).toEqual({
      washer: 3000 + 2 * 3000,
      dryer: 0,
    });
  });
  it("falls back to the default unit price when the service is gone", () => {
    expect(tokenRevenue("wash_only", 2, 0, 0, undefined, 2500, 2500)).toEqual({ washer: 5000, dryer: 0 });
  });
});
