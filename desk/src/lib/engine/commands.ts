import { clampProtected, isIntervalKey, normalizePair } from "./decision.ts";
import { INTERVAL_LABEL, type IntervalKey, type StrategyConfig } from "./types.ts";

export interface PendingConfirm {
  action: string;
  summary: string;
  pair?: string;
  maxSpreadPct?: number;
  maxTotalCostPct?: number;
  maxMarketCostPct?: number;
}

export interface CommandContext {
  channel: "telegram" | "desk";
  fromId: string | null;
  adminId: string;
  config: StrategyConfig;
  pending: PendingConfirm | null;
  dryRun: boolean;
  tradingEnabled: boolean;
  halted: boolean;
  active: boolean;
  equityText: string;
  quoteText: string;
  statusText: string;
  historyText: string;
}

export type CommandEffect =
  | { type: "reply"; text: string; keyboard?: "interval" }
  | { type: "pause" }
  | { type: "emergency_stop" }
  | { type: "set_interval"; key: IntervalKey }
  | { type: "set_pair"; pair: string }
  | { type: "set_limits"; maxSpreadPct: number; maxTotalCostPct: number; maxMarketCostPct: number }
  | { type: "resume" }
  | { type: "request_confirm"; pending: PendingConfirm }
  | { type: "clear_confirm" }
  | { type: "rotate_key" }
  | { type: "simulate" }
  | { type: "test_eval" }
  | { type: "set_paper"; on: boolean }
  | { type: "unauthorized"; fromId: string };

const CONFIRM_ACTIONS = new Set(["resume", "pair", "limits", "rotate"]);

export type AdminGate = "lock" | "prompt" | "mismatch" | "reject" | "allow";

/** First matching numeric id from that same Telegram account is the only admin lock. */
export function adminGate(currentAdmin: string, fromId: string, text: string): AdminGate {
  const admin = currentAdmin.replace(/\D/g, "");
  const from = fromId.replace(/\D/g, "");
  const body = text.trim();
  if (!from) return "reject";
  if (!admin) {
    if (/^\d{6,15}$/.test(body) && body === from) return "lock";
    if (/^\d{6,15}$/.test(body)) return "mismatch";
    return "prompt";
  }
  if (from !== admin) return "reject";
  return "allow";
}

export function interpretCommand(ctx: CommandContext, raw: string): CommandEffect[] {
  const text = raw.trim();
  if (!text) return [{ type: "reply", text: "Send a command such as /status." }];

  if (ctx.channel === "telegram") {
    const admin = ctx.adminId.trim();
    const from = ctx.fromId ?? "";
    if (!admin || from !== admin) {
      return [
        { type: "unauthorized", fromId: from || "unknown" },
        {
          type: "reply",
          text: admin
            ? "Unauthorized. This bot only answers the Telegram user id set in Stillmark."
            : `Unauthorized. Your Telegram user id is ${from || "unknown"}. Set that exact id in Stillmark. No account data is available.`,
        },
      ];
    }
  }

  if (/^confirm$/i.test(text)) {
    if (!ctx.pending || !CONFIRM_ACTIONS.has(ctx.pending.action)) {
      return [{ type: "reply", text: "Nothing is waiting for confirmation." }];
    }
    const pending = ctx.pending;
    const effects: CommandEffect[] = [{ type: "clear_confirm" }];
    if (pending.action === "resume") {
      effects.push({ type: "resume" });
      effects.push({
        type: "reply",
        text: "Monitoring is on. A fresh inactivity window started. Live orders stay off while dry-run is on.",
      });
    } else if (pending.action === "rotate") {
      effects.push({ type: "rotate_key" });
      effects.push({ type: "reply", text: "API credential material was cleared from the server vault. No order submitted." });
    } else if (pending.action === "pair" && pending.pair) {
      effects.push({ type: "set_pair", pair: pending.pair });
      effects.push({ type: "reply", text: `Pair is now ${pending.pair}. No order submitted.` });
    } else if (
      pending.action === "limits" &&
      pending.maxSpreadPct != null &&
      pending.maxTotalCostPct != null &&
      pending.maxMarketCostPct != null
    ) {
      effects.push({
        type: "set_limits",
        maxSpreadPct: pending.maxSpreadPct,
        maxTotalCostPct: pending.maxTotalCostPct,
        maxMarketCostPct: pending.maxMarketCostPct,
      });
      effects.push({ type: "reply", text: "Limits saved. No order submitted." });
    } else {
      return [{ type: "reply", text: "That confirmation expired. Send the command again." }];
    }
    return effects;
  }

  const [head, ...rest] = text.split(/\s+/);
  const cmd = (head ?? "").toLowerCase();
  const arg = rest.join(" ").trim();

  if (cmd === "/trade" || cmd === "/buy" || cmd === "/sell" || cmd === "/withdraw" || cmd === "/transfer") {
    return [
      {
        type: "reply",
        text: "Rejected. Stillmark cannot place arbitrary orders, withdrawals, or transfers. It only evaluates the configured pair.",
      },
    ];
  }

  switch (cmd) {
    case "/start":
    case "/help":
      return [{ type: "reply", text: helpText(ctx) }];
    case "/status":
      return [{ type: "reply", text: ctx.statusText }];
    case "/balance":
      return [{ type: "reply", text: ctx.equityText }];
    case "/quote":
      return [{ type: "reply", text: ctx.quoteText }];
    case "/config":
      return [{ type: "reply", text: configText(ctx) }];
    case "/history":
      return [{ type: "reply", text: ctx.historyText || "No evaluations yet." }];
    case "/pause":
      return [
        { type: "pause" },
        { type: "reply", text: "Monitoring paused. Open orders in this strategy are left for the emergency stop to cancel. No new cycle will start." },
      ];
    case "/emergency_stop":
      return [
        { type: "emergency_stop" },
        { type: "reply", text: "Emergency stop. Trading disabled. New orders blocked. Strategy marked halted." },
      ];
    case "/interval":
      return intervalEffects(ctx, arg);
    case "/token":
    case "/pair":
      return pairEffects(ctx, arg);
    case "/limits":
      return limitsEffects(ctx, arg);
    case "/resume":
      return [
        {
          type: "request_confirm",
          pending: { action: "resume", summary: resumeSummary(ctx) },
        },
        { type: "reply", text: resumeSummary(ctx) },
      ];
    case "/test":
      return [
        { type: "test_eval" },
        { type: "reply", text: "Test evaluation requested. No live order will be submitted." },
      ];
    case "/simulate":
      return [
        { type: "simulate" },
        { type: "reply", text: "Paper replay started for 24h of one-minute quotes. No live order will be submitted." },
      ];
    case "/paper":
      if (arg !== "on" && arg !== "off") {
        return [
          {
            type: "reply",
            text: "Send /paper on or /paper off. On fills the paper book when a check passes. Off only reports the check. Neither sends a live order.",
          },
        ];
      }
      return [
        { type: "set_paper", on: arg === "on" },
        {
          type: "reply",
          text:
            arg === "on"
              ? "Paper fills are on. A passed check updates the paper book only."
              : "Paper fills are off. A passed check is reported and nothing is filled.",
        },
      ];
    case "/rotate_key":
      return [
        {
          type: "request_confirm",
          pending: {
            action: "rotate",
            summary: "Confirm credential rotation. Reply CONFIRM to erase the stored Robinhood API secret from the server vault.",
          },
        },
        {
          type: "reply",
          text: "Confirm credential rotation. Reply CONFIRM to erase the stored Robinhood API secret from the server vault. This does not place an order.",
        },
      ];
    default:
      return [
        {
          type: "reply",
          text: "Unknown command. This bot does not accept free-form trade instructions. Try /status, /interval, /config, or /emergency_stop.",
        },
      ];
  }
}

function intervalEffects(ctx: CommandContext, arg: string): CommandEffect[] {
  if (!arg) {
    return [
      {
        type: "reply",
        keyboard: "interval",
        text: `Inactivity interval\nCurrent: ${INTERVAL_LABEL[ctx.config.interval]}\n\nChoose 10m, 20m, 30m, or 1h. Changing it does not place an order.`,
      },
    ];
  }
  const key = arg.toLowerCase();
  if (!isIntervalKey(key)) {
    return [
      {
        type: "reply",
        text: "Interval not allowed. Use 10m, 20m, 30m, or 1h. Nothing under 10 minutes is accepted.",
      },
    ];
  }
  return [
    { type: "set_interval", key },
    {
      type: "reply",
      text: `Inactivity interval updated.\nPair: ${ctx.config.pair}\nInterval: ${INTERVAL_LABEL[key]}\n\nEffective on the next eligibility check. No order submitted.`,
    },
  ];
}

function pairEffects(ctx: CommandContext, arg: string): CommandEffect[] {
  const pair = normalizePair(arg);
  if (!pair) {
    return [{ type: "reply", text: "Send /token SYMBOL-USD. Only a single USD pair is accepted, and it replaces the configured pair after confirmation." }];
  }
  if (pair === ctx.config.pair) {
    return [{ type: "reply", text: `${pair} is already the configured pair.` }];
  }
  return [
    {
      type: "request_confirm",
      pending: {
        action: "pair",
        pair,
        summary: `Confirm pair change to ${pair}. Current pair is ${ctx.config.pair}.`,
      },
    },
    {
      type: "reply",
      text: `Confirm pair change.\nCurrent: ${ctx.config.pair}\nNext: ${pair}\n\nReply CONFIRM. No order will be submitted, and the pair does not change until you do.`,
    },
  ];
}

function limitsEffects(_ctx: CommandContext, arg: string): CommandEffect[] {
  const match = arg.match(/spread\s+([0-9]*\.?[0-9]+)\s+cost\s+([0-9]*\.?[0-9]+)(?:\s+market\s+([0-9]*\.?[0-9]+))?/i);
  if (!match) {
    return [
      {
        type: "reply",
        text: "Send /limits spread 0.20 cost 0.50 market 0.25. Percent points. This requires CONFIRM and never places an order by itself.",
      },
    ];
  }
  const maxSpreadPct = Number(match[1]);
  const maxTotalCostPct = Number(match[2]);
  const maxMarketCostPct = match[3] ? Number(match[3]) : Math.min(0.25, maxTotalCostPct);
  if (
    !(maxSpreadPct > 0 && maxSpreadPct < 5) ||
    !(maxTotalCostPct > 0 && maxTotalCostPct < 5) ||
    !(maxMarketCostPct > 0 && maxMarketCostPct <= maxTotalCostPct)
  ) {
    return [{ type: "reply", text: "Those limits are out of range. Spread and cost must be between 0 and 5, and the market cap cannot exceed the total cap." }];
  }
  return [
    {
      type: "request_confirm",
      pending: {
        action: "limits",
        summary: `Confirm limits. Max spread ${maxSpreadPct}%. Max cost ${maxTotalCostPct}%. Max market ${maxMarketCostPct}%.`,
        maxSpreadPct,
        maxTotalCostPct,
        maxMarketCostPct,
      },
    },
    {
      type: "reply",
      text: `Confirm limits.\nMax spread ${maxSpreadPct}%.\nMax cost ${maxTotalCostPct}%.\nMax market ${maxMarketCostPct}%.\n\nReply CONFIRM. Nothing changes until you do. No order submitted.`,
    },
  ];
}

function resumeSummary(ctx: CommandContext): string {
  const floor = clampProtected(ctx.config.minProtectedUsd);
  return [
    "Confirm monitoring.",
    `Pair: ${ctx.config.pair}`,
    `Max spread: ${ctx.config.maxSpreadPct.toFixed(2)}%`,
    `Max cost: ${ctx.config.maxTotalCostPct.toFixed(2)}%`,
    `Min balance: $${floor.toFixed(2)}`,
    `Trade size: $${ctx.config.tradeTargetUsd.toFixed(2)}`,
    `Interval: ${INTERVAL_LABEL[ctx.config.interval]}`,
    `Dry-run: ${ctx.dryRun ? "on" : "off"}`,
    "Reply CONFIRM. Confirmation does not submit an order.",
  ].join("\n");
}

function configText(ctx: CommandContext): string {
  const floor = clampProtected(ctx.config.minProtectedUsd);
  return [
    "Bot config",
    `Pair: ${ctx.config.pair}`,
    `Inactivity: ${INTERVAL_LABEL[ctx.config.interval]}`,
    `Trade target: $${ctx.config.tradeTargetUsd.toFixed(2)}`,
    `Minimum protected balance: $${floor.toFixed(2)}`,
    `Maximum spread: ${ctx.config.maxSpreadPct.toFixed(2)}%`,
    `Maximum total execution cost: ${ctx.config.maxTotalCostPct.toFixed(2)}%`,
    `Maximum market cost: ${ctx.config.maxMarketCostPct.toFixed(2)}%`,
    `Order type: ${ctx.config.preferLimit ? "Limit preferred" : "Market allowed"}`,
    `Dry-run: ${ctx.dryRun ? "on" : "off"}`,
    `Trading: ${ctx.halted ? "halted" : ctx.tradingEnabled && ctx.active ? "enabled" : "disabled"}`,
  ].join("\n");
}

function helpText(ctx: CommandContext): string {
  return [
    "Stillmark watches one pair on its own clock. A quiet window only opens a cost check. It does not force a trade.",
    `Pair: ${ctx.config.pair}`,
    "Commands: /status /balance /quote /config /interval /history /test /simulate /paper /pause /resume /emergency_stop",
    "No web page is required. No withdrawals. No seed phrase. No password.",
  ].join("\n");
}

export { resumeSummary, configText };
