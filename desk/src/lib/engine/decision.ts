import { estimateRoundTripFee, type FeeTier } from "./fees.ts";
import { equityAt, roundDown, roundToTick } from "./orders.ts";
import {
  HARD_MIN_PROTECTED_USD,
  INACTIVITY_INTERVALS,
  type BookQuote,
  type CostBreakdown,
  type Decision,
  type DecisionInput,
  type Gate,
  type StrategyConfig,
} from "./types.ts";

export function clampProtected(value: number): number {
  if (!Number.isFinite(value)) return HARD_MIN_PROTECTED_USD;
  return Math.max(HARD_MIN_PROTECTED_USD, value);
}

export function isIntervalKey(value: string): value is keyof typeof INACTIVITY_INTERVALS {
  return Object.prototype.hasOwnProperty.call(INACTIVITY_INTERVALS, value);
}

export function normalizePair(raw: string): string | null {
  const pair = raw.trim().toUpperCase().replace(/\s+/g, "");
  if (!/^[A-Z0-9]{1,10}-USD$/.test(pair)) return null;
  return pair;
}

function finiteQuote(quote: BookQuote | null): quote is BookQuote {
  if (!quote) return false;
  return (
    Number.isFinite(quote.bid) &&
    Number.isFinite(quote.ask) &&
    quote.bid > 0 &&
    quote.ask > quote.bid &&
    Number.isFinite(quote.timestampMs)
  );
}

export function spreadPctOf(bid: number, ask: number): number {
  const mid = (bid + ask) / 2;
  if (!(mid > 0)) return Number.POSITIVE_INFINITY;
  return ((ask - bid) / mid) * 100;
}

export function slippagePct(notionalUsd: number, depthUsd: number): number {
  if (!(notionalUsd > 0)) return 0;
  const participation = notionalUsd / Math.max(depthUsd, 1);
  return Math.min(1.5, participation * 35);
}

export function limitFillProbability(
  spreadPct: number,
  depthUsd: number,
  notionalUsd: number,
): number {
  const participation = notionalUsd / Math.max(depthUsd, 1);
  const raw =
    0.82 * Math.exp(-Math.max(spreadPct, 0) * 3) * Math.exp(-participation * 4);
  return Math.min(0.93, Math.max(0.05, raw));
}

function blankCost(quote: BookQuote | null): CostBreakdown | null {
  if (!finiteQuote(quote)) return null;
  const mid = (quote.bid + quote.ask) / 2;
  return {
    midpoint: mid,
    spreadPct: spreadPctOf(quote.bid, quote.ask),
    estimatedFeePct: 0,
    estimatedSlippagePct: 0,
    estimatedImpactPct: 0,
    estimatedTotalCostPct: 0,
    orderType: "none",
    fillProbability: null,
    sellNotionalUsd: 0,
    buyNotionalUsd: 0,
    sellQty: 0,
    limitSellPrice: null,
    limitBuyPrice: null,
    expectedRemainingBalance: 0,
  };
}

interface PathCost {
  orderType: "limit" | "market";
  totalPct: number;
  feePct: number;
  slippagePct: number;
  impactPct: number;
  fillProbability: number;
  limitSell: number | null;
  limitBuy: number | null;
}

function pathCosts(
  config: StrategyConfig,
  quote: BookQuote,
  notional: number,
): { limit: PathCost; market: PathCost; spreadPct: number } {
  const spreadPct = spreadPctOf(quote.bid, quote.ask);
  const depth = Math.min(quote.bidDepthUsd, quote.askDepthUsd);
  const slip = slippagePct(notional, depth);
  const impact = slip * 0.45;
  const tier: FeeTier = {
    makerRate: config.makerFeeRate,
    takerRate: config.takerFeeRate,
    source: "configured",
  };
  const maker = estimateRoundTripFee(notional, tier, "limit");
  const taker = estimateRoundTripFee(notional, tier, "market");
  const inside = (quote.ask - quote.bid) * 0.25;
  const limitSell = roundToTick(quote.bid + inside, config.quoteIncrement, "down");
  const limitBuy = roundToTick(quote.ask - inside, config.quoteIncrement, "up");
  return {
    spreadPct,
    limit: {
      orderType: "limit",
      totalPct: spreadPct * 0.5 + maker.feePct + slip * 0.35 + impact * 0.35,
      feePct: maker.feePct,
      slippagePct: slip * 0.35,
      impactPct: impact * 0.35,
      fillProbability: limitFillProbability(spreadPct, depth, notional),
      limitSell,
      limitBuy,
    },
    market: {
      orderType: "market",
      totalPct: spreadPct + taker.feePct + slip + impact,
      feePct: taker.feePct,
      slippagePct: slip,
      impactPct: impact,
      fillProbability: 0.99,
      limitSell: null,
      limitBuy: null,
    },
  };
}

function choosePath(
  config: StrategyConfig,
  paths: { limit: PathCost; market: PathCost },
): { path: PathCost | null; reason: string } {
  const limitOk =
    config.preferLimit &&
    paths.limit.fillProbability + 1e-12 >= config.minFillProbability &&
    paths.limit.totalPct <= config.maxTotalCostPct + 1e-12 &&
    paths.limit.slippagePct <= config.maxSlippagePct + 1e-12;
  const marketOk =
    paths.market.totalPct <= config.maxMarketCostPct + 1e-12 &&
    paths.market.totalPct <= config.maxTotalCostPct + 1e-12 &&
    paths.market.slippagePct <= config.maxSlippagePct + 1e-12;

  if (limitOk && marketOk) {
    return paths.limit.totalPct <= paths.market.totalPct
      ? { path: paths.limit, reason: "Limit order clears the cost test with an acceptable fill chance." }
      : { path: paths.market, reason: "Market order is cheaper on this book and under the stricter market cap." };
  }
  if (limitOk) return { path: paths.limit, reason: "Limit order clears the cost test with an acceptable fill chance." };
  if (marketOk) {
    return { path: paths.market, reason: "Limit was unlikely to fill. Market order is under the stricter cap." };
  }
  const limitWhy =
    paths.limit.fillProbability < config.minFillProbability
      ? "a limit is unlikely to fill"
      : `limit cost ${paths.limit.totalPct.toFixed(3)}%`;
  const marketWhy = `market cost ${paths.market.totalPct.toFixed(3)}% vs ${config.maxMarketCostPct}% cap`;
  return {
    path: null,
    reason: `No order type clears the cost and fill tests (${limitWhy}; ${marketWhy}).`,
  };
}

/**
 * Deterministic execution gate.
 * Hierarchy: security, capital, quote integrity, execution quality, total cost, then the timer.
 * A passing timer never overrides an earlier failure.
 */
export function shouldExecuteTrade(input: DecisionInput): Decision {
  const { config, quote } = input;
  const protectedUsd = clampProtected(config.minProtectedUsd);
  const gates: Gate[] = [];
  const costShell = blankCost(quote);

  const fail = (reason: string, readyExceptWindow = false): Decision => ({
    execute: false,
    reason,
    gates,
    cost: costShell,
    readyExceptWindow,
  });

  gates.push({
    id: "kill_switch",
    label: "Kill switch",
    pass: !input.halted,
    detail: input.halted ? "Halted" : "Clear",
  });
  if (input.halted) return fail("Emergency stop is active. No order submitted.");

  const pairOk = quote ? quote.symbol.toUpperCase() === config.pair.toUpperCase() : true;
  gates.push({
    id: "pair",
    label: "Configured pair",
    pass: pairOk,
    detail: quote ? quote.symbol : config.pair,
  });
  if (!pairOk) return fail("Quote is for a different pair than the one configured. No order submitted.");

  gates.push({
    id: "lock",
    label: "Single cycle",
    pass: !input.lockHeld,
    detail: input.lockHeld ? "Cycle already running" : "Lock free",
  });
  if (input.lockHeld) return fail("Another cycle holds the strategy lock. No second order submitted.");

  const quoteOk = finiteQuote(quote);
  const age = quoteOk ? Math.max(0, input.nowMs - quote.timestampMs) : Number.POSITIVE_INFINITY;
  gates.push({
    id: "quote",
    label: "Quote age",
    pass: quoteOk && age <= config.maxQuoteAgeMs,
    detail: quoteOk ? `${(age / 1000).toFixed(1)}s` : "Missing",
  });
  if (!quoteOk) return fail("No usable bid and ask. No order submitted.");
  if (age > config.maxQuoteAgeMs) return fail("Quote is stale. No order submitted.");

  const fresh = finiteQuote(input.freshQuote) ? input.freshQuote : quote;
  const mid = (quote.bid + quote.ask) / 2;
  const freshMid = (fresh.bid + fresh.ask) / 2;
  const movePct = (Math.abs(freshMid - mid) / mid) * 100;
  const moveOk = movePct <= config.maxPriceChangePct + 1e-12;
  gates.push({
    id: "price",
    label: "Price stability",
    pass: moveOk,
    detail: `${movePct.toFixed(3)}%`,
  });
  if (!moveOk) return fail("Price moved beyond the allowed tolerance before submission. No order submitted.");

  const equity = equityAt(input.balances, mid);
  const floorOk = equity > protectedUsd + 1e-8;
  gates.push({
    id: "floor",
    label: "Protected floor",
    pass: floorOk,
    detail: `$${equity.toFixed(2)} vs $${protectedUsd.toFixed(2)}`,
  });
  if (!floorOk) return fail("Account equity is not above the protected floor. No order submitted.");

  const depth = Math.min(quote.bidDepthUsd, quote.askDepthUsd);
  const liqOk = depth + 1e-9 >= config.minLiquidityUsd;
  gates.push({
    id: "liquidity",
    label: "Book depth",
    pass: liqOk,
    detail: `$${Math.round(depth).toLocaleString("en-US")}`,
  });
  if (!liqOk) return fail("Displayed depth is below the minimum liquidity requirement. No order submitted.");

  const spreadPct = spreadPctOf(quote.bid, quote.ask);
  const spreadOk = spreadPct <= config.maxSpreadPct + 1e-12;
  gates.push({
    id: "spread",
    label: "Spread",
    pass: spreadOk,
    detail: `${spreadPct.toFixed(3)}% / ${config.maxSpreadPct.toFixed(2)}%`,
  });

  const probeNotional = Math.min(config.tradeTargetUsd, input.balances.tokenQty * quote.bid);
  const probed = pathCosts(config, quote, Math.max(probeNotional, config.minOrderUsd));
  const chosen = choosePath(config, probed);

  let sellNotional = Math.min(config.tradeTargetUsd, input.balances.tokenQty * quote.bid);
  const working = chosen.path;
  const costFrac = working ? working.totalPct / 100 : probed.market.totalPct / 100;
  if (costFrac > 0) {
    const room = equity - protectedUsd;
    sellNotional = Math.min(sellNotional, room / costFrac);
  }
  sellNotional = Math.max(0, sellNotional);
  const sellQty = roundDown(sellNotional / quote.bid, config.assetIncrement);
  const sizedNotional = sellQty * quote.bid;
  const sizeOk = sizedNotional + 1e-8 >= config.minOrderUsd && sellQty > 0;
  gates.push({
    id: "size",
    label: "Size vs floor",
    pass: sizeOk,
    detail: sizeOk ? `$${sizedNotional.toFixed(2)}` : "Below minimum",
  });

  const sizedPaths = pathCosts(config, quote, Math.max(sizedNotional, config.minOrderUsd));
  const sizedChoice = sizeOk ? choosePath(config, sizedPaths) : { path: null, reason: chosen.reason };
  const path = sizedChoice.path;
  const total = path ? path.totalPct : Math.min(sizedPaths.limit.totalPct, sizedPaths.market.totalPct);
  const slip = path ? path.slippagePct : sizedPaths.market.slippagePct;
  const costOk = path != null;
  gates.push({
    id: "cost",
    label: "Round-trip cost",
    pass: spreadOk && sizeOk && costOk,
    detail: `${total.toFixed(3)}%`,
  });

  const loss = sizedNotional * (total / 100);
  const expectedRemaining = equity - loss;
  if (costShell) {
    costShell.midpoint = mid;
    costShell.spreadPct = spreadPct;
    costShell.estimatedFeePct = path ? path.feePct : sizedPaths.market.feePct;
    costShell.estimatedSlippagePct = slip;
    costShell.estimatedImpactPct = path ? path.impactPct : sizedPaths.market.impactPct;
    costShell.estimatedTotalCostPct = total;
    costShell.orderType = path ? path.orderType : "none";
    costShell.fillProbability = path ? path.fillProbability : sizedPaths.limit.fillProbability;
    costShell.sellNotionalUsd = sizedNotional;
    costShell.buyNotionalUsd = path ? Math.max(0, sizedNotional - sizedNotional * (path.feePct / 100)) : 0;
    costShell.sellQty = sellQty;
    costShell.limitSellPrice = path?.limitSell ?? null;
    costShell.limitBuyPrice = path?.limitBuy ?? null;
    costShell.expectedRemainingBalance = expectedRemaining;
  }

  if (!spreadOk) return fail(`Spread is above the maximum (${spreadPct.toFixed(3)}% > ${config.maxSpreadPct.toFixed(2)}%). No order submitted.`);
  if (!sizeOk) return fail("Even the minimum viable size would breach the protected floor or the venue minimum. No order submitted.");
  if (expectedRemaining + 1e-8 < protectedUsd) {
    return fail("Projected balance after the cycle is below the protected floor. No order submitted.");
  }
  if (!path) return fail(sizedChoice.reason + " No order submitted.");

  const hourOk = input.cyclesLastHour < config.maxCyclesPerHour;
  const dayOk = input.cyclesLastDay < config.maxCyclesPerDay;
  gates.push({
    id: "pace",
    label: "Cycle cap",
    pass: hourOk && dayOk,
    detail: `${input.cyclesLastHour}/${config.maxCyclesPerHour} this hour`,
  });
  if (!hourOk || !dayOk) return fail("Cycle cap for the hour or day is already used. No order submitted.");

  const windowMs = INACTIVITY_INTERVALS[config.interval] * 1000;
  const elapsed =
    input.lastConfirmedTradeMs == null ? windowMs : input.nowMs - input.lastConfirmedTradeMs;
  const windowOpen = input.assumeWindowOpen === true || elapsed + 1 >= windowMs;
  gates.push({
    id: "window",
    label: "Inactivity window",
    pass: windowOpen,
    detail: windowOpen ? "Open" : `${Math.max(0, Math.ceil((windowMs - elapsed) / 1000))}s left`,
  });

  const readyExceptWindow = gates.filter((g) => g.id !== "window").every((g) => g.pass);
  if (!windowOpen) {
    return {
      execute: false,
      reason: "Inactivity window has not elapsed. Cost was checked only as a preview. No order submitted.",
      gates,
      cost: costShell,
      readyExceptWindow,
    };
  }

  return {
    execute: true,
    reason: sizedChoice.reason,
    gates,
    cost: costShell,
    readyExceptWindow: true,
  };
}
