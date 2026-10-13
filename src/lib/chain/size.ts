/** One dollar size per cycle, then the list repeats. Not a fixed clip. */
export const CLIP_LADDER_USD = [5, 8, 6, 7, 7.5, 9];

export interface TradeClip {
  usd: number;
  targetUsd: number;
  balanceUsd: number;
  capped: boolean;
  index: number;
}

function money(value: number): string {
  return `$${value.toFixed(2)}`;
}

function roundUsd(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Every cycle trades. The dollar size moves along the ladder ($5, then $8, …).
 * If the bag is smaller than the target, that cycle uses almost the whole bag
 * instead of skipping.
 */
export function chooseTradeUsd(balanceUsd: number, cycleIndex: number): { ok: true; clip: TradeClip } | { ok: false; text: string } {
  const balance = Number.isFinite(balanceUsd) && balanceUsd > 0 ? balanceUsd : 0;
  const index = Number.isInteger(cycleIndex) && cycleIndex >= 0 ? cycleIndex : 0;
  const targetUsd = CLIP_LADDER_USD[index % CLIP_LADDER_USD.length] ?? 5;
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
    clip: { usd, targetUsd, balanceUsd: balance, capped, index },
  };
}

export function describeClip(clip: TradeClip): string {
  if (clip.capped) {
    return `This cycle sells and buys ${money(clip.usd)}. Target was ${money(clip.targetUsd)}, bag is ${money(clip.balanceUsd)}, so this one uses the bag.`;
  }
  return `This cycle sells and buys ${money(clip.usd)}. Balance ${money(clip.balanceUsd)}.`;
}
