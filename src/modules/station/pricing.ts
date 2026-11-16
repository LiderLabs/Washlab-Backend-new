/**
 * Order pricing, in pesewas (bigint). Pure: no DB access, so it is easy to test.
 *
 * Ported from the Convex backend. Prices are PER LOAD (8 kg), not per kg.
 */
export const KG_PER_LOAD = 8;

export type ServicePrices = {
  pricePesewas: bigint;
  extraWashPricePesewas: bigint | null;
  extraDryPricePesewas: bigint | null;
};

export type PricingInput = {
  serviceType: string;
  weightKg: number;
  /** price rows for this branch, keyed by service code */
  services: Record<string, ServicePrices | undefined>;
  /** selected machine's wash price (walk-in only) */
  machineWashPricePesewas?: bigint | null;
  /** last-resort per-load price when the branch has no row for the service */
  branchFallbackPerLoadPesewas: bigint;
  isDelivery: boolean;
  branchDeliveryFeePesewas: bigint;
  extraWashLoads: number;
  extraDryLoads: number;
};

export type PricingResult = {
  loads: number;
  basePricePesewas: bigint;
  deliveryFeePesewas: bigint;
  extrasPesewas: bigint;
  totalPesewas: bigint;
};

const STANDARD = new Set(["wash_and_dry", "wash_only", "dry_only"]);

export function loadsForWeight(weightKg: number): number {
  return Math.ceil(weightKg / KG_PER_LOAD);
}

export function calculatePrice(i: PricingInput): PricingResult {
  const svc = i.services[i.serviceType];
  const washOnly = i.services["wash_only"]?.pricePesewas;
  const dryOnly = i.services["dry_only"]?.pricePesewas;

  const perLoad = i.machineWashPricePesewas ?? svc?.pricePesewas ?? i.branchFallbackPerLoadPesewas;
  const washUnit = washOnly ?? perLoad;
  const dryUnit = dryOnly ?? perLoad;

  // wash_and_dry is charged as a wash load plus a dry load.
  const effectivePerLoad = i.serviceType === "wash_and_dry" ? washUnit + dryUnit : perLoad;

  const loads = loadsForWeight(i.weightKg);
  const basePricePesewas = BigInt(loads) * effectivePerLoad;

  const extraWashUnit = svc?.extraWashPricePesewas ?? (STANDARD.has(i.serviceType) ? washUnit : perLoad);
  const extraDryUnit = svc?.extraDryPricePesewas ?? dryUnit;
  const extrasPesewas = BigInt(i.extraWashLoads) * extraWashUnit + BigInt(i.extraDryLoads) * extraDryUnit;

  const deliveryFeePesewas = i.isDelivery ? i.branchDeliveryFeePesewas : 0n;
  return {
    loads,
    basePricePesewas,
    deliveryFeePesewas,
    extrasPesewas,
    totalPesewas: basePricePesewas + deliveryFeePesewas + extrasPesewas,
  };
}
