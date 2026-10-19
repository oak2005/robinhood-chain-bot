/** Fee helpers. Rates are fractions (0.001 = 0.10%), never hardcoded as "the" fee. */

export interface FeeTier {
  makerRate: number;
  takerRate: number;
  source: "configured" | "estimated_price" | "account";
}

export function estimateOrderFee(notionalUsd: number, rate: number): number {
  if (!Number.isFinite(notionalUsd) || notionalUsd <= 0) return 0;
  if (!Number.isFinite(rate) || rate <= 0) return 0;
  return notionalUsd * rate;
}

export function estimateRoundTripFee(
  notionalUsd: number,
  tier: FeeTier,
  orderType: "limit" | "market",
): { sellFee: number; buyFee: number; feePct: number } {
  const rate = orderType === "market" ? tier.takerRate : tier.makerRate;
  const sellFee = estimateOrderFee(notionalUsd, rate);
  const buyFee = estimateOrderFee(notionalUsd, rate);
  const feePct = notionalUsd > 0 ? ((sellFee + buyFee) / notionalUsd) * 100 : 0;
  return { sellFee, buyFee, feePct };
}

export function feeTierFromEstimate(feeRatio: number | null, fallback: FeeTier): FeeTier {
  if (feeRatio == null || !Number.isFinite(feeRatio) || feeRatio < 0) return fallback;
  return { makerRate: feeRatio, takerRate: feeRatio, source: "estimated_price" };
}
