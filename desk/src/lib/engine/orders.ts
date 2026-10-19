import type { Balances, OrderSide, OrderState } from "./types.ts";

export interface Fill {
  side: OrderSide;
  requestedNotionalUsd: number;
  filledNotionalUsd: number;
  filledQty: number;
  avgPrice: number;
  feeUsd: number;
  state: OrderState;
  clientOrderId: string;
}

export interface BuyPlan {
  action: "buy" | "abort";
  reason: string;
  notionalUsd: number;
  qty: number;
  expectedEquity: number;
}

const seenClientIds = new Set<string>();

export function resetClientOrderIds(): void {
  seenClientIds.clear();
}

/** UUID that has not already been submitted. A timeout must query, not mint a second live id, unless the first never reached the venue. */
export function createClientOrderId(existing?: Iterable<string>): string {
  const bag = existing ? new Set(existing) : seenClientIds;
  let id = crypto.randomUUID();
  while (bag.has(id)) id = crypto.randomUUID();
  bag.add(id);
  if (!existing) seenClientIds.add(id);
  return id;
}

export function hasClientOrderId(id: string, existing?: Iterable<string>): boolean {
  if (existing) return new Set(existing).has(id);
  return seenClientIds.has(id);
}

export function roundDown(value: number, increment: number): number {
  if (!(increment > 0) || !Number.isFinite(value)) return 0;
  const steps = Math.floor((value + increment * 1e-9) / increment);
  const decimals = decimalsOf(increment);
  return Number((steps * increment).toFixed(decimals));
}

export function roundToTick(value: number, increment: number, mode: "down" | "up"): number {
  if (!(increment > 0) || !Number.isFinite(value)) return value;
  const steps = value / increment;
  const k = mode === "down" ? Math.floor(steps + 1e-9) : Math.ceil(steps - 1e-9);
  return Number((k * increment).toFixed(decimalsOf(increment)));
}

function decimalsOf(increment: number): number {
  const text = increment.toString().toLowerCase();
  if (text.includes("e-")) {
    const exp = Number(text.split("e-")[1]);
    return Number.isFinite(exp) ? exp : 8;
  }
  const dot = text.split(".")[1];
  return dot ? dot.length : 0;
}

export function equityAt(balances: Balances, mid: number): number {
  return balances.usd + balances.tokenQty * mid;
}

/**
 * Size the buy from the sell that actually happened.
 * Never assumes the original target came back.
 */
export function planBuyFromProceeds(input: {
  balances: Balances;
  proceedsUsd: number;
  sellFeeUsd: number;
  bid: number;
  ask: number;
  protectedUsd: number;
  minOrderUsd: number;
  assetIncrement: number;
  feeRate: number;
  totalCostPct: number;
}): BuyPlan {
  const mid = (input.bid + input.ask) / 2;
  const net = Math.max(0, input.proceedsUsd - input.sellFeeUsd);
  const equity = equityAt(input.balances, mid);
  if (equity < input.protectedUsd - 1e-9) {
    return {
      action: "abort",
      reason: "Equity is already under the protected floor. Buy aborted.",
      notionalUsd: 0,
      qty: 0,
      expectedEquity: equity,
    };
  }
  const costFrac = Math.max(input.totalCostPct, 0) / 100;
  const room = equity - input.protectedUsd;
  let notional = Math.min(net, input.balances.usd);
  if (costFrac > 0) notional = Math.min(notional, room / costFrac);
  const fee = notional * Math.max(input.feeRate, 0);
  const spend = notional + fee;
  if (spend > input.balances.usd + 1e-9) notional = Math.max(0, input.balances.usd / (1 + Math.max(input.feeRate, 0)));
  const qty = roundDown(notional / input.ask, input.assetIncrement);
  const priced = qty * input.ask;
  const expectedEquity = equity - priced * costFrac;
  if (priced + 1e-9 < input.minOrderUsd || qty <= 0) {
    return {
      action: "abort",
      reason: "Buy would breach the protected floor or the venue minimum. No buy submitted.",
      notionalUsd: 0,
      qty: 0,
      expectedEquity: equity,
    };
  }
  if (expectedEquity + 1e-8 < input.protectedUsd) {
    return {
      action: "abort",
      reason: "Projected balance after the buy is below the protected floor.",
      notionalUsd: 0,
      qty: 0,
      expectedEquity,
    };
  }
  return {
    action: "buy",
    reason: "Buy sized from actual sell proceeds.",
    notionalUsd: priced,
    qty,
    expectedEquity,
  };
}

export function applySell(balances: Balances, fill: Fill): Balances {
  return {
    usd: balances.usd + fill.filledNotionalUsd - fill.feeUsd,
    tokenQty: Math.max(0, balances.tokenQty - fill.filledQty),
  };
}

export function applyBuy(balances: Balances, fill: Fill): Balances {
  return {
    usd: Math.max(0, balances.usd - fill.filledNotionalUsd - fill.feeUsd),
    tokenQty: balances.tokenQty + fill.filledQty,
  };
}
