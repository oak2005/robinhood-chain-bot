export const HARD_MIN_PROTECTED_USD = 7;

export const INACTIVITY_INTERVALS = {
  "10m": 600,
  "20m": 1200,
  "30m": 1800,
  "1h": 3600,
} as const;

export type IntervalKey = keyof typeof INACTIVITY_INTERVALS;

export const INTERVAL_LABEL: Record<IntervalKey, string> = {
  "10m": "10 minutes",
  "20m": "20 minutes",
  "30m": "30 minutes",
  "1h": "1 hour",
};

export type OrderState =
  | "PENDING"
  | "PARTIALLY_FILLED"
  | "FILLED"
  | "CANCELLED"
  | "REJECTED"
  | "EXPIRED";

export type OrderSide = "sell" | "buy";

export interface StrategyConfig {
  pair: string;
  interval: IntervalKey;
  tradeTargetUsd: number;
  minProtectedUsd: number;
  maxSpreadPct: number;
  maxTotalCostPct: number;
  maxMarketCostPct: number;
  maxSlippagePct: number;
  maxPriceChangePct: number;
  maxQuoteAgeMs: number;
  minLiquidityUsd: number;
  maxCyclesPerHour: number;
  maxCyclesPerDay: number;
  maxOrderWaitSec: number;
  minFillProbability: number;
  /** Fractions, not percents. Overwritten by the API fee estimate when live. */
  makerFeeRate: number;
  takerFeeRate: number;
  minOrderUsd: number;
  assetIncrement: number;
  quoteIncrement: number;
  preferLimit: boolean;
}

export interface BookQuote {
  symbol: string;
  bid: number;
  ask: number;
  timestampMs: number;
  bidDepthUsd: number;
  askDepthUsd: number;
}

export interface Balances {
  usd: number;
  tokenQty: number;
}

export interface Gate {
  id: string;
  label: string;
  pass: boolean;
  detail: string;
}

export interface CostBreakdown {
  midpoint: number;
  spreadPct: number;
  estimatedFeePct: number;
  estimatedSlippagePct: number;
  estimatedImpactPct: number;
  estimatedTotalCostPct: number;
  orderType: "limit" | "market" | "none";
  fillProbability: number | null;
  sellNotionalUsd: number;
  buyNotionalUsd: number;
  sellQty: number;
  limitSellPrice: number | null;
  limitBuyPrice: number | null;
  expectedRemainingBalance: number;
}

export interface Decision {
  execute: boolean;
  reason: string;
  gates: Gate[];
  cost: CostBreakdown | null;
  /** True when every gate except the inactivity window passed. */
  readyExceptWindow: boolean;
}

export interface DecisionInput {
  nowMs: number;
  quote: BookQuote | null;
  /** Second read used for the price-movement guard. */
  freshQuote: BookQuote | null;
  config: StrategyConfig;
  balances: Balances;
  lastConfirmedTradeMs: number | null;
  cyclesLastHour: number;
  cyclesLastDay: number;
  halted: boolean;
  lockHeld: boolean;
  /** When true, the inactivity window is treated as open (manual /test). */
  assumeWindowOpen?: boolean;
}

export const DEFAULT_CONFIG: StrategyConfig = {
  pair: "XYZ-USD",
  interval: "10m",
  tradeTargetUsd: 10,
  minProtectedUsd: HARD_MIN_PROTECTED_USD,
  maxSpreadPct: 0.2,
  maxTotalCostPct: 0.5,
  maxMarketCostPct: 0.25,
  maxSlippagePct: 0.15,
  maxPriceChangePct: 0.3,
  maxQuoteAgeMs: 2000,
  minLiquidityUsd: 500,
  maxCyclesPerHour: 6,
  maxCyclesPerDay: 24,
  maxOrderWaitSec: 20,
  minFillProbability: 0.55,
  makerFeeRate: 0,
  takerFeeRate: 0,
  minOrderUsd: 1,
  assetIncrement: 0.000001,
  quoteIncrement: 0.0001,
  preferLimit: true,
};
