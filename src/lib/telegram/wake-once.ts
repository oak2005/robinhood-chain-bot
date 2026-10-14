import fs from "node:fs";
import { previewChain, type V4Pool } from "../chain/cycle.ts";
import { runDueTrade } from "./duty.ts";

const ROOT = process.env.STILLMARK_ROOT || "/workspace";

const BUTTONS: Record<string, string> = {
  Status: "/status",
  Balance: "/balance",
  Config: "/config",
  Token: "/tokeninfo",
  Help: "/help",
  Resume: "/resume",
  Pause: "/pause",
  Stop: "/emergency_stop",
  Interval: "/interval",
  "Add token": "/addtoken",
  "Add key": "/addkey",
  "Remove key": "/removekey",
};

const INTERVALS: Record<string, number> = { "10m": 600, "20m": 1200, "30m": 1800, "1h": 3600 };

type BotState = {
  active?: boolean;
  paused?: boolean;
  halted?: boolean;
  nextRecheck?: number;
  config?: { interval?: string };
  token?: { address: string; symbol: string; decimals: number; name?: string } | null;
  pool?: V4Pool | null;
};

function nextLine(state: BotState): string {
  const mins = Math.max(0, Math.ceil(((state.nextRecheck ?? 0) - Date.now()) / 60000));
  return mins <= 0 ? "Next swap is due." : `Next swap in about ${mins} min.`;
}

function modeLine(state: BotState): string {
  if (state.halted) return "Stopped.";
  if (state.paused || state.active === false) return "Paused.";
  return "Running on its own.";
}

async function liveLine(state: BotState, address: string): Promise<string> {
  if (!state.token) return "No token saved.";
  if (!address) return `${state.token.symbol}. Wallet is not readable from here.`;
  try {
    const preview = await previewChain({
      address,
      token: state.token.address,
      symbol: state.token.symbol,
      decimals: state.token.decimals,
      pool: state.pool ?? null,
    });
    if (preview.pool) state.pool = preview.pool;
    return preview.text;
  } catch (error) {
    return error instanceof Error ? error.message : "Could not read the chain.";
  }
}

async function drainCommands() {
  let token = "";
  let admin = "";
  try {
    token = fs.readFileSync(`${ROOT}/.secrets/telegram_bot_token`, "utf8").trim();
    admin = fs.readFileSync(`${ROOT}/.secrets/telegram_admin_id`, "utf8").trim();
  } catch {
    return;
  }
  let address = "";
  try {
    const creds = JSON.parse(fs.readFileSync(`${ROOT}/.secrets/robinhood_creds.json`, "utf8")) as { address?: string };
    address = creds.address ?? "";
  } catch {
    address = "";
  }
  const offsetPath = `${ROOT}/data/telegram_offset`;
  let offset = 0;
  try {
    offset = Number(fs.readFileSync(offsetPath, "utf8")) || 0;
  } catch {
    offset = 0;
  }
  const response = await fetch(`https://api.telegram.org/bot${token}/getUpdates`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ offset, timeout: 0, allowed_updates: ["message"] }),
  });
  const payload = (await response.json().catch(() => null)) as { result?: Array<Record<string, unknown>> } | null;
  const updates = payload?.result ?? [];
  const statePath = `${ROOT}/data/stillmark-bot.json`;
  for (const update of updates) {
    const id = typeof update.update_id === "number" ? update.update_id : 0;
    if (id) offset = Math.max(offset, id + 1);
    const message = update.message as Record<string, unknown> | undefined;
    const from = message?.from as Record<string, unknown> | undefined;
    const raw = typeof message?.text === "string" ? message.text.trim() : "";
    const chat = message?.chat as Record<string, unknown> | undefined;
    const chatId = typeof chat?.id === "number" ? chat.id : 0;
    if (!raw || String(from?.id ?? "") !== admin || !chatId) continue;
    const text = BUTTONS[raw] ?? raw;
    if (!text.startsWith("/")) continue;
    const state = JSON.parse(fs.readFileSync(statePath, "utf8")) as BotState;
    const cmd = text.split(/\s+/)[0]?.split("@")[0] ?? "";
    const arg = text.split(/\s+/)[1] ?? "";
    let reply = "";
    let dirty = false;
    if (cmd === "/pause") {
      state.active = false;
      state.paused = true;
      dirty = true;
      reply = "Paused. No new swap will start.";
    } else if (cmd === "/resume") {
      state.paused = false;
      state.halted = false;
      state.active = true;
      state.nextRecheck = Date.now();
      dirty = true;
      reply = "Running again. The next cycle can swap.";
    } else if (cmd === "/emergency_stop" || cmd === "/stop") {
      state.active = false;
      state.halted = true;
      state.paused = false;
      dirty = true;
      reply = "Stopped. Tap Resume to turn swaps back on.";
    } else if (cmd === "/status" || cmd === "/balance" || cmd === "/tokeninfo") {
      const head = [modeLine(state), nextLine(state)];
      if (state.token) head.push(state.token.symbol, state.token.address);
      reply = `${head.join("\n")}\n${await liveLine(state, address)}`;
      dirty = state.pool != null;
    } else if (cmd === "/config") {
      const interval = state.config?.interval ?? "30m";
      reply = [
        modeLine(state),
        `Interval: ${interval}.`,
        "Size rotates: $5, $8, $6, $7, $7.50, $9.",
        nextLine(state),
        await liveLine(state, address),
      ].join("\n");
      dirty = state.pool != null;
    } else if (cmd === "/help") {
      reply = [
        "Running on GitHub, not in this chat.",
        "Status, Balance, and Config are answered on the next check, within about 5 minutes.",
        "Pause, Resume, and Stop change the bot the same way.",
        "Interval: send /interval 10m, 20m, 30m, or 1h.",
        "The wallet and token stay in GitHub secrets. Do not send a private key here.",
      ].join("\n");
    } else if (cmd === "/interval") {
      const key = arg in INTERVALS ? arg : "";
      if (!key) {
        reply = `Interval is ${state.config?.interval ?? "30m"}. Send /interval 10m, 20m, 30m, or 1h.`;
      } else {
        state.config = { ...(state.config ?? {}), interval: key };
        dirty = true;
        reply = `Interval set to ${key}. ${nextLine(state)}`;
      }
    } else if (cmd === "/addkey" || cmd === "/addtoken" || cmd === "/removekey") {
      reply = "The wallet and token are stored in GitHub secrets. Do not send a private key in this chat.";
    }
    if (!reply) continue;
    if (dirty) fs.writeFileSync(statePath, JSON.stringify(state));
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: reply.slice(0, 3500) }),
    }).catch(() => undefined);
  }
  fs.mkdirSync(`${ROOT}/data`, { recursive: true });
  fs.writeFileSync(offsetPath, String(offset));
}

await (process.env.STILLMARK_SKIP_DRAIN === "1" ? Promise.resolve() : drainCommands().catch(() => undefined));
const line = await runDueTrade(true);
const text = line || "watching";
try {
  fs.appendFileSync(`${ROOT}/data/bot.log`, `${new Date().toISOString()} wake ${text}\n`);
} catch {
  /* keep the printed result */
}
process.stdout.write(`${text}\n`);
