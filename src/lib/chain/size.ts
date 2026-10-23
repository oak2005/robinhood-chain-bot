export type TradeRangeKey = "5-20" | "21-50" | "51-100" | "100+";

export const TRADE_LADDERS: Record<TradeRangeKey, number[]> = {
  "5-20": [5, 8, 12, 15, 10, 18, 7, 14],
  "21-50": [22, 30, 25, 45, 35, 50, 28, 40],
  "51-100": [55, 75, 65, 90, 80, 100, 60, 85],
  "100+": [100, 150, 120, 200, 175, 250, 140, 220],
};

/** Default ladder for backwards compatibility */
export const CLIP_LADDER_USD = [5, 8, 6, 7, 7.5, 9];

export interface TradeClip {
  usd: number;
  targetUsd: number;
  balanceUsd: number;
  capped: boolean;
  index: number;
  tradeRange?: TradeRangeKey;
}

function money(value: number): string {
  return `$${value.toFixed(2)}`;
}

function roundUsd(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Every cycle trades. The dollar size moves along the ladder for the selected
 * trade range ($5-$20, $21-$50, $51-$100, $100+).
 * If the bag is smaller than the target, that cycle uses the available bag
 * instead of skipping, respecting the wallet balance.
 */
export function chooseTradeUsd(
  balanceUsd: number,
  cycleIndex: number,
  tradeRange?: string,
): { ok: true; clip: TradeClip } | { ok: false; text: string } {
  const balance = Number.isFinite(balanceUsd) && balanceUsd > 0 ? balanceUsd : 0;
  const index = Number.isInteger(cycleIndex) && cycleIndex >= 0 ? cycleIndex : 0;
  const key: TradeRangeKey =
    tradeRange === "21-50" || tradeRange === "51-100" || tradeRange === "100+" ? tradeRange : "5-20";

  const ladder = tradeRange ? TRADE_LADDERS[key] : CLIP_LADDER_USD;
  const targetUsd = ladder[index % ladder.length] ?? 5;

  if (balance < 1) {
    return {
      ok: false,
      text: `Token value about ${money(balance)} is too small to swap. No swap sent.`,
    };
  }
  const usable = roundUsd(Math.max(0, balance * 0.995));
  if (usable < 1) {
    return { ok: false, text: `Token value about ${money(balance)} is too small to swap. No swap sent.` };
  }
  const usd = targetUsd <= usable ? targetUsd : usable;
  const capped = usd + 0.009 < targetUsd;
  return {
    ok: true,
    clip: { usd, targetUsd, balanceUsd: balance, capped, index, tradeRange: key },
  };
}

export function describeClip(clip: TradeClip): string {
  const rangeInfo = clip.tradeRange ? ` [Tier $${clip.tradeRange}]` : "";
  if (clip.capped) {
    return `This cycle sells and buys ${money(clip.usd)}${rangeInfo}. Target was ${money(clip.targetUsd)}, bag is ${money(clip.balanceUsd)}, so this one uses the bag.`;
  }
  return `This cycle sells and buys ${money(clip.usd)}${rangeInfo}. Balance ${money(clip.balanceUsd)}.`;
}
