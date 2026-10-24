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
  "Remove token": "/removetoken",
  Pay: "/pay",
};

const COMMAND_SYNONYMS: Record<string, string> = {
  status: "/status",
  balance: "/balance",
  bal: "/balance",
  config: "/config",
  settings: "/config",
  token: "/tokeninfo",
  tokeninfo: "/tokeninfo",
  help: "/help",
  start: "/start",
  resume: "/resume",
  pause: "/pause",
  stop: "/emergency_stop",
  interval: "/interval",
  "add token": "/addtoken",
  addtoken: "/addtoken",
  "add key": "/addkey",
  addkey: "/addkey",
  "remove key": "/removekey",
  removekey: "/removekey",
  "remove token": "/removetoken",
  removetoken: "/removetoken",
  pay: "/pay",
};

function normalizeCommand(raw: string): string {
  const trimmed = raw.trim();
  if (BUTTONS[trimmed]) return BUTTONS[trimmed];
  const lower = trimmed.toLowerCase();
  if (COMMAND_SYNONYMS[lower]) return COMMAND_SYNONYMS[lower];
  if (trimmed.startsWith("/")) return trimmed;
  const parts = trimmed.split(/\s+/);
  const firstLower = parts[0]?.toLowerCase() ?? "";
  if (COMMAND_SYNONYMS[firstLower]) {
    return `${COMMAND_SYNONYMS[firstLower]} ${parts.slice(1).join(" ")}`.trim();
  }
  return trimmed;
}

const MENU = {
  keyboard: [
    [{ text: "Status" }, { text: "Balance" }, { text: "Config" }],
    [{ text: "Help" }, { text: "Resume" }, { text: "Pause" }],
    [{ text: "Stop" }, { text: "Interval" }, { text: "Token" }],
    [{ text: "Add token" }, { text: "Add key" }, { text: "Remove key" }],
    [{ text: "Pay" }],
  ],
  resize_keyboard: true,
  is_persistent: true,
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
  lastPreview?: string;
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
    state.lastPreview = preview.text;
    return preview.text;
  } catch (error) {
    return error instanceof Error ? error.message : "Could not read the chain.";
  }
}

export async function setupBotMenu(token: string) {
  const commands = [
    { command: "status", description: "Check bot status and swap clock" },
    { command: "balance", description: "Check token balance and cycle" },
    { command: "config", description: "View trading configuration" },
    { command: "tokeninfo", description: "View token information" },
    { command: "pause", description: "Pause trading" },
    { command: "resume", description: "Resume trading" },
    { command: "stop", description: "Emergency stop trading" },
    { command: "interval", description: "Set trade interval (10m, 20m, 30m, 1h)" },
    { command: "addkey", description: "Add wallet private key" },
    { command: "addtoken", description: "Add token coin address" },
    { command: "removekey", description: "Remove saved wallet and tokens" },
    { command: "removetoken", description: "Remove a saved token" },
    { command: "pay", description: "Pay for access ($20/30 days)" },
    { command: "help", description: "How to use Inactivity Trade" },
  ];
  try {
    await fetch(`https://api.telegram.org/bot${token}/setMyCommands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commands }),
    });
    await fetch(`https://api.telegram.org/bot${token}/setChatMenuButton`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ menu_button: { type: "commands" } }),
    });
  } catch {}
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
  await setupBotMenu(token);
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
  let cached = "";
  for (const update of updates) {
    const id = typeof update.update_id === "number" ? update.update_id : 0;
    if (id) offset = Math.max(offset, id + 1);
    try {
      const message = update.message as Record<string, unknown> | undefined;
      const from = message?.from as Record<string, unknown> | undefined;
      const raw = typeof message?.text === "string" ? message.text.trim() : "";
      const chat = message?.chat as Record<string, unknown> | undefined;
      const chatId = typeof chat?.id === "number" ? chat.id : 0;
      if (!raw || !chatId) continue;
      const text = normalizeCommand(raw);
      if (!text.startsWith("/")) {
        await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text: "👋 Welcome to *Inactivity Trade Bot*.\n\nTap a button below or type `/status`, `/balance`, or `/help`.",
            reply_markup: MENU,
          }),
        }).catch(() => {});
        continue;
      }
      const isAdmin = String(from?.id ?? "") === admin;
      const state = JSON.parse(fs.readFileSync(statePath, "utf8")) as BotState;
      const cmd = text.split(/\s+/)[0]?.split("@")[0] ?? "";
      const arg = text.split(/\s+/)[1] ?? "";
      if (!isAdmin) {
        const reply = guestReply(cmd);
        const sent = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text: reply, reply_markup: MENU }),
        });
        process.stdout.write(`answered guest ${cmd} ${sent.ok ? "ok" : "fail"}\n`);
        continue;
      }
      let reply = "";
      let dirty = false;
      const chainText = async () => {
        if (cached) return cached;
        cached = await liveLine(state, address);
        return cached;
      };
      if (cmd === "/start") {
        reply = "Running on its own.\nHelp explains the buttons.\nAnother Telegram account can use Help too. It cannot pause your NASTY swaps.";
      } else if (cmd === "/pause") {
        state.active = false;
        state.paused = true;
        dirty = true;
        reply = "Paused. No new swap will start.";
      } else if (cmd === "/resume") {
        const key = state.config?.interval ?? "30m";
        state.paused = false;
        state.halted = false;
        state.active = true;
        state.nextRecheck = Date.now() + (INTERVALS[key] ?? 1800) * 1000;
        dirty = true;
        reply = `Running again. Next swap waits ${key}. Nothing is sent before that.`;
      } else if (cmd === "/emergency_stop" || cmd === "/stop") {
        state.active = false;
        state.halted = true;
        state.paused = false;
        dirty = true;
        reply = "Stopped. Tap Resume to turn swaps back on.";
      } else if (cmd === "/status") {
        const head = [modeLine(state), nextLine(state)];
        if (state.token) head.push(state.token.symbol, state.token.address);
        reply = `${head.join("\n")}\n${await chainText()}`;
        dirty = Boolean(state.pool) || Boolean(state.lastPreview);
      } else if (cmd === "/balance") {
        reply = `💰 Balance\n${modeLine(state)}\n${await chainText()}`;
        dirty = Boolean(state.pool) || Boolean(state.lastPreview);
      } else if (cmd === "/tokeninfo" || cmd === "/token") {
        reply = state.token
          ? `🪙 Token: ${state.token.symbol}\nContract: ${state.token.address}\n\nTo remove this token, send /removetoken`
          : "No token saved yet. Tap Add token.";
      } else if (cmd === "/removetoken") {
        state.token = null;
        state.pool = null;
        dirty = true;
        reply = "Removed saved token.";
      } else if (cmd === "/config") {
        const interval = state.config?.interval ?? "30m";
        reply = [
          modeLine(state),
          `Interval: ${interval}.`,
          "Size rotates: $5, $8, $6, $7, $7.50, $9.",
          nextLine(state),
          await chainText(),
        ].join("\n");
        dirty = Boolean(state.pool) || Boolean(state.lastPreview);
      } else if (cmd === "/help") {
        reply = [
          "Buttons answer in this chat.",
          "Status, Balance, and Config read the running swap.",
          "Pause, Resume, and Stop change the next swap.",
          "Interval: send /interval 10m, 20m, 30m, or 1h.",
          "Another account can press Help. It cannot stop your swaps.",
          "Do not send a private key here.",
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
        reply = "Do not send a private key in this chat. Tap Add key, then send a fresh wallet key in the next message. It is not stored in the chat log here.";
      }
      if (!reply) continue;
      if (dirty) fs.writeFileSync(statePath, JSON.stringify(state));
      const sent = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: reply.slice(0, 3500), reply_markup: MENU }),
      });
      process.stdout.write(`answered ${cmd} ${sent.ok ? "ok" : "fail"}\n`);
    } catch (error) {
      const reason = error instanceof Error ? error.message.split("\n")[0] : "button failed";
      process.stdout.write(`answered fail ${reason.slice(0, 120)}\n`);
    }
  }
  fs.mkdirSync(`${ROOT}/data`, { recursive: true });
  fs.writeFileSync(offsetPath, String(offset));
}

function guestReply(cmd: string): string {
  if (cmd === "/pay") {
    return "Access is at least $20 USD per 30 days in USDT, USDC, or USDG on Solana, Base, BNB, or Robinhood. Tap Pay or send /pay on Railway.";
  }
  if (cmd === "/pause" || cmd === "/resume" || cmd === "/stop" || cmd === "/emergency_stop" || cmd === "/interval") {
    return "This account cannot pause or stop the running swaps.";
  }
  if (cmd === "/addkey" || cmd === "/addtoken" || cmd === "/removekey") {
    return "Tap Add key. The next message should be a fresh wallet private key, not the wallet already trading. Then tap Add token.";
  }
  if (cmd === "/balance") {
    return "No wallet is saved for this Telegram account yet. Tap Add key.";
  }
  if (cmd === "/config") {
    return "Trading configuration: 30m interval, size rotates: $5, $8, $6, $7, $7.50, $9. Tap Add key to configure.";
  }
  if (cmd === "/tokeninfo" || cmd === "/token") {
    return "No token is saved for this Telegram account yet. Tap Add key, then Add token.";
  }
  if (cmd === "/removetoken") {
    return "Tap Remove key to clear your saved wallet and tokens.";
  }
  if (cmd === "/status") {
    return "No wallet is saved for this Telegram account yet. Tap Add key.";
  }
  return [
    "Inactivity Trade is on.",
    "Your account is separate from the wallet that is already trading.",
    "Tap Add key, then send a fresh wallet key.",
    "Tap Add token for the coin.",
    "Do not use the wallet that is already running.",
  ].join("\n");
}

try {
  const secretToken = fs.readFileSync(`${ROOT}/.secrets/telegram_bot_token`, "utf8").trim();
  if (secretToken) await setupBotMenu(secretToken);
} catch {}

// If Railway is actively running with a valid bot token, it sets telegram: true,
// which sets STILLMARK_SKIP_DRAIN=1 in trade.yml. In that case we skip getUpdates to avoid 409 conflict.
// If Railway is inactive, down, or has an invalid token (telegram: false), GitHub Actions acts as fallback drain.
const skipDrain = process.env.STILLMARK_SKIP_DRAIN === "1";
if (!skipDrain) {
  console.log("[wake-once] Railway live bot is not verified/active. Polling commands via GitHub Actions...");
  await drainCommands().catch((e) => console.error("[wake-once] drainCommands error:", e?.message || e));
} else {
  console.log("[wake-once] Railway live bot is active 24/7. Skipping GitHub Actions drain to avoid 409 Conflict.");
}
const line = await runDueTrade(true);
try {
  const statePath = `${ROOT}/data/stillmark-bot.json`;
  if (fs.existsSync(statePath)) {
    const state = JSON.parse(fs.readFileSync(statePath, "utf8")) as BotState;
    let address = "";
    try {
      const creds = JSON.parse(fs.readFileSync(`${ROOT}/.secrets/robinhood_creds.json`, "utf8")) as { address?: string };
      address = creds.address ?? "";
    } catch {
      address = "";
    }
    if (state.token && address) {
      const preview = await previewChain({
        address,
        token: state.token.address,
        symbol: state.token.symbol,
        decimals: state.token.decimals,
        pool: state.pool ?? null,
      });
      if (preview.pool) state.pool = preview.pool;
      state.lastPreview = preview.text;
      fs.writeFileSync(statePath, JSON.stringify(state));
    }
  }
} catch {
  /* keep going even if preview refresh fails */
}
const text = line || "watching";
try {
  fs.appendFileSync(`${ROOT}/data/bot.log`, `${new Date().toISOString()} wake ${text}\n`);
} catch {
  /* keep the printed result */
}
process.stdout.write(`${text}\n`);

