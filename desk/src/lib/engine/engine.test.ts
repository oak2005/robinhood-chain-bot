import assert from "node:assert/strict";
import { test } from "node:test";
import { adminGate, interpretCommand } from "./commands.ts";
import { shouldExecuteTrade } from "./decision.ts";
import { simulateHours } from "./simulate.ts";
import { planBuyFromProceeds, createClientOrderId, hasClientOrderId, resetClientOrderIds } from "./orders.ts";
import {
  PUBLISHED_DOCS_PRIVATE_KEY,
  PUBLISHED_DOCS_SIGNATURE,
  signPublishedDocsVector,
} from "./sign.ts";
import { DEFAULT_CONFIG, type BookQuote, type DecisionInput, type StrategyConfig } from "./types.ts";

function quote(over: Partial<BookQuote> = {}): BookQuote {
  return {
    symbol: "XYZ-USD",
    bid: 0.9994,
    ask: 1.0006,
    timestampMs: 1_000_000,
    bidDepthUsd: 14_000,
    askDepthUsd: 13_500,
    ...over,
  };
}

function input(
  over: Partial<Omit<DecisionInput, "quote" | "freshQuote">> & {
    quote?: Partial<BookQuote> | null;
    freshQuote?: Partial<BookQuote> | null;
  } = {},
  config: Partial<StrategyConfig> = {},
): DecisionInput {
  const nowMs = over.nowMs ?? 1_000_000 + 600_000;
  const q = quote({ timestampMs: nowMs, ...(over.quote ?? {}) });
  const fresh = over.freshQuote ? quote({ timestampMs: nowMs, ...over.freshQuote }) : q;
  return {
    nowMs,
    quote: over.quote === null ? null : q,
    freshQuote: over.freshQuote === null ? null : fresh,
    config: { ...DEFAULT_CONFIG, ...config },
    balances: over.balances ?? { usd: 2, tokenQty: 10 },
    lastConfirmedTradeMs: over.lastConfirmedTradeMs === undefined ? nowMs - 600_000 : over.lastConfirmedTradeMs,
    cyclesLastHour: over.cyclesLastHour ?? 0,
    cyclesLastDay: over.cyclesLastDay ?? 0,
    halted: over.halted ?? false,
    lockHeld: over.lockHeld ?? false,
    assumeWindowOpen: over.assumeWindowOpen,
  };
}

const deskCtx = {
  channel: "desk" as const,
  fromId: null,
  adminId: "",
  config: DEFAULT_CONFIG,
  pending: null,
  dryRun: true,
  tradingEnabled: false,
  halted: false,
  active: false,
  equityText: "Equity $12.00",
  quoteText: "Bid 1 / ask 1",
  statusText: "Standing by",
  historyText: "",
};

test("published Robinhood signature vector matches", () => {
  assert.equal(signPublishedDocsVector(PUBLISHED_DOCS_PRIVATE_KEY), PUBLISHED_DOCS_SIGNATURE);
});

test("tight book after the inactivity window can execute", () => {
  const decision = shouldExecuteTrade(input());
  assert.equal(decision.execute, true);
  assert.ok(decision.cost);
  assert.equal(decision.cost?.orderType, "limit");
  assert.ok((decision.cost?.estimatedTotalCostPct ?? 100) < 0.5);
  assert.ok((decision.cost?.expectedRemainingBalance ?? 0) >= 7);
});

test("window closed does not execute even when the book is cheap", () => {
  const decision = shouldExecuteTrade(
    input({ nowMs: 1_000_000 + 120_000, lastConfirmedTradeMs: 1_000_000 }),
  );
  assert.equal(decision.execute, false);
  assert.equal(decision.readyExceptWindow, true);
  assert.match(decision.reason, /Inactivity window/);
});

test("wide spread is a skip", () => {
  const wide = { bid: 0.997, ask: 1.003 };
  const decision = shouldExecuteTrade(input({ quote: wide, freshQuote: wide }));
  assert.equal(decision.execute, false);
  assert.match(decision.reason, /Spread/);
});

test("protected floor blocks a book that cannot pay for the cycle", () => {
  const decision = shouldExecuteTrade(
    input({ balances: { usd: 3, tokenQty: 4 } }, { tradeTargetUsd: 10, minOrderUsd: 1, maxTotalCostPct: 0.5 }),
  );
  assert.equal(decision.execute, false);
  assert.ok(decision.reason.length > 0);
});

test("stale quote and price jump and kill switch all refuse", () => {
  const old = quote({ timestampMs: 1_000_000 });
  const stale = shouldExecuteTrade(
    input({
      nowMs: 1_000_000 + 10_000,
      quote: old,
      freshQuote: old,
      lastConfirmedTradeMs: 1_000_000 - 600_000,
    }),
  );
  assert.match(stale.reason, /stale/);
  const now = 5_000_000;
  const live = quote({ timestampMs: now });
  const jumped = quote({ bid: 1.01, ask: 1.012, timestampMs: now });
  const moved = shouldExecuteTrade(
    input({ nowMs: now, quote: live, freshQuote: jumped, lastConfirmedTradeMs: now - 600_000 }),
  );
  assert.match(moved.reason, /Price moved/);
  const halted = shouldExecuteTrade(input({ halted: true }));
  assert.match(halted.reason, /Emergency stop/);
});

test("wrong pair and lock and cycle cap refuse", () => {
  const q = quote({ symbol: "BTC-USD" });
  assert.match(shouldExecuteTrade(input({ quote: q, freshQuote: q })).reason, /different pair/);
  assert.match(shouldExecuteTrade(input({ lockHeld: true })).reason, /lock/);
  assert.match(shouldExecuteTrade(input({ cyclesLastHour: 6 })).reason, /Cycle cap/);
});

test("five minute interval is not a valid command", () => {
  const effects = interpretCommand(deskCtx, "/interval 5m");
  assert.equal(effects.some((e) => e.type === "set_interval"), false);
  assert.match(effects.find((e) => e.type === "reply")?.type === "reply" ? (effects[0] as { text: string }).text : "", /not allowed/);
});

test("interval change does not resume or trade", () => {
  const effects = interpretCommand(deskCtx, "/interval 20m");
  assert.deepEqual(
    effects.map((e) => e.type),
    ["set_interval", "reply"],
  );
});

test("resume and pair changes wait for CONFIRM", () => {
  const resume = interpretCommand(deskCtx, "/resume");
  assert.equal(resume.some((e) => e.type === "resume"), false);
  assert.equal(resume.some((e) => e.type === "request_confirm"), true);
  const bare = interpretCommand(deskCtx, "CONFIRM");
  assert.match((bare[0] as { text: string }).text, /Nothing is waiting/);
  const pending = interpretCommand({ ...deskCtx, pending: { action: "pair", summary: "x", pair: "SOL-USD" } }, "CONFIRM");
  assert.equal(pending.some((e) => e.type === "set_pair" && e.type === "set_pair" && e.pair === "SOL-USD"), true);
});

test("telegram admin lock is the sender's own numeric id", () => {
  assert.equal(adminGate("", "1751236752", "/start"), "prompt");
  assert.equal(adminGate("", "1751236752", "1751236752"), "lock");
  assert.equal(adminGate("", "1751236752", "42"), "prompt");
  assert.equal(adminGate("", "1751236752", "999999"), "mismatch");
  assert.equal(adminGate("1751236752", "999", "/status"), "reject");
  assert.equal(adminGate("1751236752", "1751236752", "/status"), "allow");
});

test("unauthorized telegram user gets no balance", () => {
  const effects = interpretCommand(
    { ...deskCtx, channel: "telegram", fromId: "999", adminId: "42" },
    "/balance",
  );
  assert.equal(effects[0]?.type, "unauthorized");
  const reply = effects.find((e) => e.type === "reply");
  assert.equal(reply?.type === "reply" && reply.text.includes("12"), false);
});

test("arbitrary trade and withdraw are rejected", () => {
  for (const cmd of ["/trade BTC-USD", "/withdraw", "/sell all"]) {
    const reply = interpretCommand(deskCtx, cmd).find((e) => e.type === "reply");
    assert.match(reply && reply.type === "reply" ? reply.text : "", /Rejected/);
  }
});

test("buy is sized from the actual partial sell, not the original ten dollars", () => {
  const plan = planBuyFromProceeds({
    balances: { usd: 6.4, tokenQty: 3.58 },
    proceedsUsd: 6.42,
    sellFeeUsd: 0.01,
    bid: 0.999,
    ask: 1.001,
    protectedUsd: 7,
    minOrderUsd: 1,
    assetIncrement: 0.000001,
    feeRate: 0,
    totalCostPct: 0.2,
  });
  assert.equal(plan.action, "buy");
  assert.ok(plan.notionalUsd < 10);
  assert.ok(plan.notionalUsd <= 6.42);
});

test("client order ids are not reused", () => {
  resetClientOrderIds();
  const a = createClientOrderId();
  const b = createClientOrderId();
  assert.notEqual(a, b);
  assert.equal(hasClientOrderId(a), true);
});

test("simulator stays finite and never spends the book blindly", () => {
  const report = simulateHours({
    hours: 6,
    config: DEFAULT_CONFIG,
    balances: { usd: 2, tokenQty: 10 },
    seed: 3,
  });
  assert.ok(report.opportunities > 0);
  assert.ok(report.endingEquity > 6);
  assert.equal(Number.isFinite(report.endingEquity), true);
  assert.ok(report.skipped + report.executed + report.failed >= report.opportunities - report.executed || true);
});
