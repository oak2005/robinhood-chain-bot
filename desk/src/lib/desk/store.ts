import { create } from "zustand";
import { interpretCommand, type CommandContext, type CommandEffect, type PendingConfirm } from "@/lib/engine/commands";
import { clampProtected, shouldExecuteTrade } from "@/lib/engine/decision";
import { INITIAL_MARKET, mulberry32, quoteFromMarket, stepMarket, type MarketState } from "@/lib/engine/market";
import { applyBuy, applySell, createClientOrderId, equityAt, planBuyFromProceeds, resetClientOrderIds, type Fill } from "@/lib/engine/orders";
import { simulateHours, type SimReport } from "@/lib/engine/simulate";
import {
  DEFAULT_CONFIG,
  HARD_MIN_PROTECTED_USD,
  INACTIVITY_INTERVALS,
  type Balances,
  type Decision,
  type IntervalKey,
  type StrategyConfig,
} from "@/lib/engine/types";

export interface TapeEntry {
  id: string;
  kind: "skip" | "pass" | "halt" | "config" | "security" | "info" | "cycle";
  title: string;
  detail: string;
  at: number;
}

export interface DeskSnapshot {
  adminId: string;
  pair: string;
  status: string;
  balance: string;
  interval: string;
  dryRun: boolean;
  tradingEnabled: boolean;
  active: boolean;
  halted: boolean;
  pending: string | null;
  config: StrategyConfig;
  historyText: string;
  equityText: string;
  quoteText: string;
  statusText: string;
}

interface Desk {
  booted: boolean;
  config: StrategyConfig;
  balances: Balances;
  market: MarketState;
  simNow: number;
  lastTradeSim: number;
  pace: number;
  active: boolean;
  halted: boolean;
  tradingEnabled: boolean;
  dryRun: boolean;
  paperFills: boolean;
  lockHeld: boolean;
  recovery: string | null;
  adminId: string;
  pending: PendingConfirm | null;
  tape: TapeEntry[];
  decision: Decision | null;
  points: { t: number; spread: number }[];
  tradeTimes: number[];
  blockUntil: number;
  nextRecheck: number;
  report: SimReport | null;
  security: TapeEntry[];
  boot: () => void;
  tick: (dtMs: number) => void;
  command: (text: string, fromId?: string | null) => { text: string; keyboard?: "interval" };
  setAdmin: (id: string) => void;
  setPace: (pace: number) => void;
  setPaperFills: (on: boolean) => void;
  setTarget: (usd: number) => void;
  setFloor: (usd: number) => void;
  drill: (kind: "stale" | "jump") => void;
  acknowledgeRecovery: () => void;
  dismissPending: () => void;
  snapshot: () => DeskSnapshot;
}

const SEED_NOW = 1_700_000_000_000;
const seedQuote = quoteFromMarket(DEFAULT_CONFIG.pair, INITIAL_MARKET, SEED_NOW);
const seedDecision = shouldExecuteTrade({
  nowMs: SEED_NOW,
  quote: seedQuote,
  freshQuote: seedQuote,
  config: DEFAULT_CONFIG,
  balances: { usd: 2, tokenQty: 10 },
  lastConfirmedTradeMs: SEED_NOW,
  cyclesLastHour: 0,
  cyclesLastDay: 0,
  halted: false,
  lockHeld: false,
  assumeWindowOpen: true,
});
const STORAGE_KEY = "stillmark.v1";
let rand = mulberry32(11);
let pointClock = 0;

function uid(): string {
  return crypto.randomUUID();
}

function pushTape(tape: TapeEntry[], entry: Omit<TapeEntry, "id" | "at">): TapeEntry[] {
  return [{ ...entry, id: uid(), at: Date.now() }, ...tape].slice(0, 60);
}

function contextOf(s: Desk): CommandContext {
  const equity = equityAt(s.balances, s.market.mid);
  const history = s.tape
    .slice(0, 5)
    .map((row) => `${row.title}: ${row.detail}`)
    .join("\n");
  return {
    channel: "desk",
    fromId: s.adminId || null,
    adminId: s.adminId,
    config: s.config,
    pending: s.pending,
    dryRun: s.dryRun,
    tradingEnabled: s.tradingEnabled,
    halted: s.halted,
    active: s.active,
    equityText: `Equity ${equity.toFixed(2)} USD. Cash ${s.balances.usd.toFixed(2)}. Token ${s.balances.tokenQty.toFixed(4)}. Floor ${HARD_MIN_PROTECTED_USD.toFixed(2)} USD. This cannot be lowered.`,
    quoteText: `${s.config.pair} bid ${s.market.bid.toFixed(4)} ask ${s.market.ask.toFixed(4)} spread ${s.market.spreadPct.toFixed(3)}%. Paper book, not a live Robinhood quote.`,
    statusText: statusText(s),
    historyText: history,
  };
}

export function statusText(s: Pick<Desk, "halted" | "active" | "dryRun" | "tradingEnabled" | "config" | "recovery">): string {
  const state = s.halted ? "Halted" : s.active ? "Monitoring" : "Standing by";
  return [
    `Status: ${state}`,
    `Pair: ${s.config.pair}`,
    `Dry-run: ${s.dryRun ? "on" : "off"}`,
    `Trading flag: ${s.tradingEnabled ? "enabled" : "disabled"}`,
    s.recovery ? `Recovery hold: ${s.recovery}` : "Recovery hold: none",
    "Live Robinhood orders are not sent from the desk. Dry-run stays on.",
  ].join("\n");
}

function applyEffects(s: Desk, effects: CommandEffect[], channelNote: string): Desk {
  let next: Desk = s;
  const notes: TapeEntry[] = [];
  for (const effect of effects) {
    if (effect.type === "pause") {
      next = { ...next, active: false, tradingEnabled: false };
      notes.push(note("info", "Monitoring paused", channelNote));
    } else if (effect.type === "emergency_stop") {
      next = {
        ...next,
        active: false,
        tradingEnabled: false,
        halted: true,
        lockHeld: false,
        pending: null,
      };
      notes.push(note("halt", "Emergency stop", "New orders blocked. Strategy halted."));
    } else if (effect.type === "set_interval") {
      const previous = next.config.interval;
      next = {
        ...next,
        config: { ...next.config, interval: effect.key },
        blockUntil: Date.now() + 8000,
      };
      notes.push(
        note(
          "config",
          "Interval updated",
          `${previous} → ${effect.key}. Authorized desk. No order submitted.`,
        ),
      );
    } else if (effect.type === "set_pair") {
      const previous = next.config.pair;
      next = { ...next, config: { ...next.config, pair: effect.pair }, blockUntil: Date.now() + 8000 };
      notes.push(note("config", "Pair updated", `${previous} → ${effect.pair}. No order submitted.`));
    } else if (effect.type === "set_limits") {
      next = {
        ...next,
        config: {
          ...next.config,
          maxSpreadPct: effect.maxSpreadPct,
          maxTotalCostPct: effect.maxTotalCostPct,
          maxMarketCostPct: effect.maxMarketCostPct,
        },
        blockUntil: Date.now() + 8000,
      };
      notes.push(note("config", "Limits updated", "Spread, total cost, and market cap changed. No order submitted."));
    } else if (effect.type === "request_confirm") {
      next = { ...next, pending: effect.pending };
    } else if (effect.type === "clear_confirm") {
      next = { ...next, pending: null };
    } else if (effect.type === "resume") {
      next = {
        ...next,
        active: true,
        halted: false,
        tradingEnabled: true,
        dryRun: true,
        lastTradeSim: next.simNow,
        nextRecheck: next.simNow + INACTIVITY_INTERVALS[next.config.interval] * 1000,
        blockUntil: Date.now() + 1500,
      };
      notes.push(note("info", "Monitoring resumed", "Fresh inactivity window. Dry-run remains on."));
    } else if (effect.type === "set_paper") {
      next = { ...next, paperFills: effect.on };
      notes.push(note("config", "Paper fills", effect.on ? "On" : "Off"));
    } else if (effect.type === "rotate_key") {
      notes.push(note("security", "Credential rotation requested", "Server vault clear was requested. No order submitted."));
    } else if (effect.type === "simulate") {
      const report = simulateHours({
        hours: 24,
        config: next.config,
        balances: { usd: 2, tokenQty: 10 },
        seed: 9,
      });
      next = { ...next, report };
      notes.push(
        note(
          "info",
          "24h paper replay",
          `${report.executed} executed, ${report.skipped} skipped, ending equity ${report.endingEquity.toFixed(2)}.`,
        ),
      );
    } else if (effect.type === "test_eval") {
      const decision = evaluate(next, { assumeWindowOpen: true, stale: false, jump: false });
      next = { ...next, decision };
      notes.push(note(decision.execute ? "pass" : "skip", "Test evaluation", decision.reason));
    } else if (effect.type === "unauthorized") {
      const row = note("security", "Unauthorized Telegram user", `User id ${effect.fromId} was rejected.`);
      next = { ...next, security: [row, ...next.security].slice(0, 20) };
      notes.push(row);
    }
  }
  if (notes.length) next = { ...next, tape: [...notes, ...next.tape].slice(0, 60) };
  return next;
}

function note(kind: TapeEntry["kind"], title: string, detail: string): TapeEntry {
  return { id: uid(), at: Date.now(), kind, title, detail };
}

function evaluate(s: Desk, opt: { assumeWindowOpen: boolean; stale: boolean; jump: boolean }): Decision {
  const quote = quoteFromMarket(s.config.pair, s.market, opt.stale ? s.simNow - 10_000 : s.simNow);
  const freshMarket = opt.jump
    ? { ...s.market, bid: s.market.bid * 1.008, ask: s.market.ask * 1.008, mid: s.market.mid * 1.008 }
    : s.market;
  const fresh = quoteFromMarket(s.config.pair, freshMarket, s.simNow);
  const hour = s.tradeTimes.filter((t) => s.simNow - t <= 3_600_000).length;
  const day = s.tradeTimes.filter((t) => s.simNow - t <= 86_400_000).length;
  return shouldExecuteTrade({
    nowMs: s.simNow,
    quote,
    freshQuote: fresh,
    config: { ...s.config, minProtectedUsd: clampProtected(s.config.minProtectedUsd) },
    balances: s.balances,
    lastConfirmedTradeMs: s.lastTradeSim,
    cyclesLastHour: hour,
    cyclesLastDay: day,
    halted: s.halted,
    lockHeld: s.lockHeld,
    assumeWindowOpen: opt.assumeWindowOpen,
  });
}

function paperCycle(s: Desk, decision: Decision): Partial<Desk> {
  if (!decision.execute || !decision.cost) return {};
  const cost = decision.cost;
  const depth = Math.min(s.market.bidDepthUsd, s.market.askDepthUsd);
  const ratio = depth < 2500 ? 0.64 : 1;
  const qty = cost.sellQty * ratio;
  const notional = qty * s.market.bid;
  if (!(qty > 0) || qty > s.balances.tokenQty + 1e-8) {
    return { tape: pushTape(s.tape, { kind: "skip", title: "Paper sell aborted", detail: "Sized quantity was not available." }) };
  }
  const sell: Fill = {
    side: "sell",
    requestedNotionalUsd: cost.sellNotionalUsd,
    filledNotionalUsd: notional,
    filledQty: qty,
    avgPrice: s.market.bid,
    feeUsd: notional * s.config.takerFeeRate,
    state: ratio < 1 ? "PARTIALLY_FILLED" : "FILLED",
    clientOrderId: createClientOrderId(),
  };
  const afterSell = applySell(s.balances, sell);
  const plan = planBuyFromProceeds({
    balances: afterSell,
    proceedsUsd: sell.filledNotionalUsd,
    sellFeeUsd: sell.feeUsd,
    bid: s.market.bid,
    ask: s.market.ask,
    protectedUsd: clampProtected(s.config.minProtectedUsd),
    minOrderUsd: s.config.minOrderUsd,
    assetIncrement: s.config.assetIncrement,
    feeRate: s.config.makerFeeRate,
    totalCostPct: cost.estimatedTotalCostPct,
  });
  if (plan.action !== "buy") {
    return {
      balances: s.balances,
      recovery: plan.reason,
      active: false,
      tradingEnabled: false,
      lockHeld: false,
      tape: pushTape(s.tape, {
        kind: "halt",
        title: "Buy aborted after sell math",
        detail: `${plan.reason} Balances were not changed because the buy could not be sized safely.`,
      }),
    };
  }
  const buy: Fill = {
    side: "buy",
    requestedNotionalUsd: plan.notionalUsd,
    filledNotionalUsd: plan.notionalUsd,
    filledQty: plan.qty,
    avgPrice: s.market.ask,
    feeUsd: plan.notionalUsd * s.config.makerFeeRate,
    state: "FILLED",
    clientOrderId: createClientOrderId(),
  };
  const balances = applyBuy(afterSell, buy);
  const equity = equityAt(balances, s.market.mid);
  if (equity + 1e-8 < HARD_MIN_PROTECTED_USD) {
    return {
      recovery: "Cycle would have finished under the protected floor. It was reverted.",
      active: false,
      tradingEnabled: false,
      tape: pushTape(s.tape, {
        kind: "halt",
        title: "Cycle reverted",
        detail: "Post-trade equity would have broken the $7 floor.",
      }),
    };
  }
  return {
    balances,
    lastTradeSim: s.simNow,
    tradeTimes: [...s.tradeTimes, s.simNow].slice(-200),
    lockHeld: false,
    tape: pushTape(s.tape, {
      kind: "cycle",
      title: "Paper cycle filled",
      detail: `Sell ${sell.filledNotionalUsd.toFixed(2)} (${sell.state}). Buy ${buy.filledNotionalUsd.toFixed(2)}. Equity ${equity.toFixed(2)}. Ids ${sell.clientOrderId.slice(0, 8)} / ${buy.clientOrderId.slice(0, 8)}.`,
    }),
  };
}

export const useDesk = create<Desk>((set, get) => ({
  booted: false,
  config: DEFAULT_CONFIG,
  balances: { usd: 2, tokenQty: 10 },
  market: INITIAL_MARKET,
  simNow: 0,
  lastTradeSim: 0,
  pace: 20,
  active: false,
  halted: false,
  tradingEnabled: false,
  dryRun: true,
  paperFills: false,
  lockHeld: false,
  recovery: null,
  adminId: "",
  pending: null,
  tape: [],
  decision: seedDecision,
  points: [],
  tradeTimes: [],
  blockUntil: 0,
  nextRecheck: 0,
  report: null,
  security: [],
  boot: () => {
    if (get().booted) return;
    rand = mulberry32(11);
    resetClientOrderIds();
    const now = Date.now();
    let stored: Partial<Pick<Desk, "config" | "balances" | "adminId" | "paperFills" | "pace">> = {};
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) stored = JSON.parse(raw) as typeof stored;
    } catch {
      stored = {};
    }
    const config = {
      ...DEFAULT_CONFIG,
      ...stored.config,
      minProtectedUsd: clampProtected(stored.config?.minProtectedUsd ?? HARD_MIN_PROTECTED_USD),
    };
    set({
      booted: true,
      config: { ...config, minProtectedUsd: clampProtected(config.minProtectedUsd) },
      balances: stored.balances ?? { usd: 2, tokenQty: 10 },
      adminId: stored.adminId ?? "",
      paperFills: stored.paperFills ?? false,
      pace: stored.pace && [1, 10, 20, 60].includes(stored.pace) ? stored.pace : 20,
      simNow: now,
      lastTradeSim: now,
      active: false,
      halted: false,
      tradingEnabled: false,
      dryRun: true,
      market: INITIAL_MARKET,
    });
    get().tick(0);
  },
  tick: (dtMs) => {
    const s = get();
    if (!s.booted) return;
    const simNow = s.simNow + dtMs * s.pace;
    const market = dtMs > 0 ? stepMarket(s.market, rand) : s.market;
    pointClock += 1;
    const points =
      pointClock % 2 === 0
        ? [...s.points, { t: pointClock, spread: market.spreadPct }].slice(-48)
        : s.points;
    const base: Desk = { ...s, simNow, market, points };
    const preview = !s.active || s.halted;
    const decision = evaluate(base, { assumeWindowOpen: preview, stale: false, jump: false });
    let next: Desk = { ...base, decision };
    if (!preview && s.recovery == null && Date.now() >= s.blockUntil && simNow >= s.nextRecheck) {
      const windowClosed = decision.gates.some((g) => g.id === "window" && !g.pass);
      if (windowClosed) {
        next = {
          ...next,
          nextRecheck: s.lastTradeSim + INACTIVITY_INTERVALS[s.config.interval] * 1000,
        };
      } else {
        next = {
          ...next,
          blockUntil: Date.now() + 8000,
          nextRecheck: decision.execute ? simNow + INACTIVITY_INTERVALS[s.config.interval] * 1000 : simNow + 60_000,
          tape: pushTape(s.tape, {
            kind: decision.execute ? "pass" : "skip",
            title: decision.execute ? "Window open, cost passed" : "Trade skipped",
            detail: decision.reason,
          }),
        };
        if (decision.execute && s.paperFills) {
          next = { ...next, ...paperCycle(next, decision) };
        } else if (decision.execute) {
          next = {
            ...next,
            nextRecheck: simNow + 90_000,
            tape: pushTape(next.tape, {
              kind: "pass",
              title: "Dry-run would execute",
              detail: "No order was submitted. Paper fills are off, and live Robinhood orders stay disabled.",
            }),
          };
        }
      }
    }
    set(next);
    if (dtMs > 0 && pointClock % 8 === 0) persist(next);
  },
  command: (text, fromId) => {
    const s = get();
    const ctx = contextOf(s);
    if (fromId !== undefined) {
      ctx.channel = "telegram";
      ctx.fromId = fromId;
    }
    const effects = interpretCommand(ctx, text);
    const reply = effects.find((e) => e.type === "reply");
    const keyboard = reply && reply.type === "reply" ? reply.keyboard : undefined;
    set(applyEffects(get(), effects, text));
    persist(get());
    return { text: reply && reply.type === "reply" ? reply.text : "No reply.", keyboard };
  },
  setAdmin: (id) => {
    const clean = id.replace(/\D/g, "").slice(0, 15);
    set({ adminId: clean });
    persist(get());
  },
  setPace: (pace) => {
    if (![1, 10, 20, 60].includes(pace)) return;
    set({ pace });
    persist(get());
  },
  setPaperFills: (on) => {
    set({ paperFills: on });
    persist(get());
  },
  setTarget: (usd) => {
    const tradeTargetUsd = Math.min(50, Math.max(1, usd));
    set({ config: { ...get().config, tradeTargetUsd } });
    persist(get());
  },
  setFloor: (usd) => {
    const minProtectedUsd = clampProtected(usd);
    set({ config: { ...get().config, minProtectedUsd } });
    persist(get());
  },
  drill: (kind) => {
    const s = get();
    const decision = evaluate(s, { assumeWindowOpen: true, stale: kind === "stale", jump: kind === "jump" });
    set({
      decision,
      tape: pushTape(s.tape, {
        kind: "skip",
        title: kind === "stale" ? "Stale-quote drill" : "Price-jump drill",
        detail: decision.reason,
      }),
    });
  },
  acknowledgeRecovery: () => set({ recovery: null }),
  dismissPending: () => set({ pending: null }),
  snapshot: () => {
    const s = get();
    const ctx = contextOf(s);
    return {
      adminId: s.adminId,
      pair: s.config.pair,
      status: s.halted ? "halted" : s.active ? "monitoring" : "standing-by",
      balance: ctx.equityText,
      interval: s.config.interval,
      dryRun: true,
      tradingEnabled: s.tradingEnabled,
      active: s.active,
      halted: s.halted,
      pending: s.pending?.summary ?? null,
      config: s.config,
      historyText: ctx.historyText,
      equityText: ctx.equityText,
      quoteText: ctx.quoteText,
      statusText: ctx.statusText,
    };
  },
}));

function persist(s: Desk) {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        config: s.config,
        balances: s.balances,
        adminId: s.adminId,
        paperFills: s.paperFills,
        pace: s.pace,
      }),
    );
  } catch {
    /* private mode */
  }
}

export function intervalLeft(s: Pick<Desk, "config" | "simNow" | "lastTradeSim" | "active">): number {
  if (!s.active) return INACTIVITY_INTERVALS[s.config.interval];
  const elapsed = (s.simNow - s.lastTradeSim) / 1000;
  return Math.max(0, INACTIVITY_INTERVALS[s.config.interval] - elapsed);
}

export type { IntervalKey };
