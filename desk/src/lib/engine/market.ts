import type { BookQuote } from "./types.ts";

export interface MarketState {
  mid: number;
  bid: number;
  ask: number;
  spreadPct: number;
  bidDepthUsd: number;
  askDepthUsd: number;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const INITIAL_MARKET: MarketState = {
  mid: 1,
  bid: 0.9994,
  ask: 1.0006,
  spreadPct: 0.12,
  bidDepthUsd: 14000,
  askDepthUsd: 13500,
};

export function quoteFromMarket(symbol: string, market: MarketState, timestampMs: number): BookQuote {
  return {
    symbol,
    bid: market.bid,
    ask: market.ask,
    timestampMs,
    bidDepthUsd: market.bidDepthUsd,
    askDepthUsd: market.askDepthUsd,
  };
}

export function stepMarket(state: MarketState, rand: () => number): MarketState {
  const shock = (rand() - 0.48) * 0.0016;
  let mid = state.mid * (1 + shock);
  mid = Math.min(1.35, Math.max(0.75, mid));
  const burst = rand() > 0.9;
  const spreadPct = burst ? 0.26 + rand() * 0.5 : 0.045 + rand() * 0.11;
  const half = spreadPct / 100 / 2;
  const depth = burst ? 350 + rand() * 900 : 7000 + rand() * 18000;
  return {
    mid,
    bid: mid * (1 - half),
    ask: mid * (1 + half),
    spreadPct,
    bidDepthUsd: depth,
    askDepthUsd: depth * (0.92 + rand() * 0.16),
  };
}
