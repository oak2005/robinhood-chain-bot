import { shouldExecuteTrade } from "./decision.ts";
import { INITIAL_MARKET, mulberry32, quoteFromMarket, stepMarket, type MarketState } from "./market.ts";
import { applyBuy, applySell, equityAt, planBuyFromProceeds, type Fill } from "./orders.ts";
import {
  INACTIVITY_INTERVALS,
  type Balances,
  type StrategyConfig,
} from "./types.ts";

export interface SimReport {
  hours: number;
  opportunities: number;
  executed: number;
  skipped: number;
  failed: number;
  avgSpreadPct: number;
  avgFeePct: number;
  avgSlippagePct: number;
  totalEstimatedCostUsd: number;
  startingEquity: number;
  endingEquity: number;
  samples: number;
}

export function simulateHours(input: {
  hours: number;
  config: StrategyConfig;
  balances: Balances;
  seed?: number;
}): SimReport {
  const hours = Math.min(168, Math.max(1, Math.round(input.hours)));
  const rand = mulberry32(input.seed ?? 7);
  const stepMs = 60_000;
  const steps = hours * 60;
  let market: MarketState = { ...INITIAL_MARKET };
  let balances: Balances = { ...input.balances };
  let now = 0;
  let lastTrade: number | null = 0;
  let nextAllowed = INACTIVITY_INTERVALS[input.config.interval] * 1000;
  const tradeTimes: number[] = [];
  let opportunities = 0;
  let executed = 0;
  let skipped = 0;
  let failed = 0;
  let spreadSum = 0;
  let feeSum = 0;
  let slipSum = 0;
  let costUsd = 0;
  let samples = 0;
  const startEquity = equityAt(balances, market.mid);

  for (let i = 0; i < steps; i += 1) {
    now += stepMs;
    market = stepMarket(market, rand);
    if (now < nextAllowed) continue;
    opportunities += 1;
    const quote = quoteFromMarket(input.config.pair, market, now);
    const hourAgo = now - 3_600_000;
    const dayAgo = now - 86_400_000;
    const decision = shouldExecuteTrade({
      nowMs: now,
      quote,
      freshQuote: quote,
      config: input.config,
      balances,
      lastConfirmedTradeMs: lastTrade,
      cyclesLastHour: tradeTimes.filter((t) => t >= hourAgo).length,
      cyclesLastDay: tradeTimes.filter((t) => t >= dayAgo).length,
      halted: false,
      lockHeld: false,
    });
    samples += 1;
    if (decision.cost) {
      spreadSum += decision.cost.spreadPct;
      feeSum += decision.cost.estimatedFeePct;
      slipSum += decision.cost.estimatedSlippagePct;
    }
    if (!decision.execute || !decision.cost) {
      skipped += 1;
      nextAllowed = now + 60_000;
      continue;
    }
    const before = equityAt(balances, market.mid);
    const sell: Fill = {
      side: "sell",
      requestedNotionalUsd: decision.cost.sellNotionalUsd,
      filledNotionalUsd: decision.cost.sellNotionalUsd,
      filledQty: decision.cost.sellQty,
      avgPrice: market.bid,
      feeUsd: decision.cost.sellNotionalUsd * (decision.cost.estimatedFeePct / 200),
      state: "FILLED",
      clientOrderId: `sim-sell-${i}`,
    };
    if (sell.filledQty <= 0 || sell.filledQty > balances.tokenQty + 1e-8) {
      failed += 1;
      skipped += 1;
      nextAllowed = now + 60_000;
      continue;
    }
    const afterSell = applySell(balances, sell);
    const buyPlan = planBuyFromProceeds({
      balances: afterSell,
      proceedsUsd: sell.filledNotionalUsd,
      sellFeeUsd: sell.feeUsd,
      bid: market.bid,
      ask: market.ask,
      protectedUsd: input.config.minProtectedUsd,
      minOrderUsd: input.config.minOrderUsd,
      assetIncrement: input.config.assetIncrement,
      feeRate: input.config.takerFeeRate,
      totalCostPct: decision.cost.estimatedTotalCostPct,
    });
    if (buyPlan.action !== "buy") {
      failed += 1;
      balances = afterSell;
      lastTrade = now;
      tradeTimes.push(now);
      nextAllowed = now + INACTIVITY_INTERVALS[input.config.interval] * 1000;
      continue;
    }
    const buy: Fill = {
      side: "buy",
      requestedNotionalUsd: buyPlan.notionalUsd,
      filledNotionalUsd: buyPlan.notionalUsd,
      filledQty: buyPlan.qty,
      avgPrice: market.ask,
      feeUsd: buyPlan.notionalUsd * input.config.takerFeeRate,
      state: "FILLED",
      clientOrderId: `sim-buy-${i}`,
    };
    balances = applyBuy(afterSell, buy);
    const after = equityAt(balances, market.mid);
    costUsd += Math.max(0, before - after);
    executed += 1;
    lastTrade = now;
    tradeTimes.push(now);
    nextAllowed = now + INACTIVITY_INTERVALS[input.config.interval] * 1000;
  }

  const endingEquity = equityAt(balances, market.mid);
  const denom = Math.max(samples, 1);
  return {
    hours,
    opportunities,
    executed,
    skipped,
    failed,
    avgSpreadPct: spreadSum / denom,
    avgFeePct: feeSum / denom,
    avgSlippagePct: slipSum / denom,
    totalEstimatedCostUsd: costUsd,
    startingEquity: startEquity,
    endingEquity,
    samples,
  };
}
