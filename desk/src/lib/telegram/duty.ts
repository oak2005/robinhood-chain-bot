import fs from "node:fs";
import { runChainCycle, type V4Pool } from "../chain/cycle.ts";
import { checkRobinhoodInactivity } from "../chain/inactivity.ts";
import { INACTIVITY_INTERVALS, type IntervalKey } from "../engine/types.ts";

const ROOT = process.env.STILLMARK_ROOT || "/workspace";
const STATE_PATH = `${ROOT}/data/stillmark-bot.json`;
const CREDS_PATH = `${ROOT}/.secrets/robinhood_creds.json`;
const TOKEN_PATH = `${ROOT}/.secrets/telegram_bot_token`;
const ADMIN_PATH = `${ROOT}/.secrets/telegram_admin_id`;
const LOCK_PATH = `${ROOT}/data/cycle.lock`;
const SKIP_RECHECK_MS = 60 * 1000;
const BUY_RETRY_MS = 30 * 1000;

interface TapeNote {
  at: number;
  title: string;
  detail: string;
}

interface SavedState {
  config?: { interval?: IntervalKey };
  active?: boolean;
  halted?: boolean;
  paused?: boolean;
  lastTradeMs?: number;
  nextRecheck?: number;
  tape?: TapeNote[];
  token?: { address: string; symbol: string; decimals: number } | null;
  pool?: V4Pool | null;
}

function readSecret(): string | null {
  try {
    const raw = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as { type?: string; privateKeyHex?: string };
    if (raw.type !== "wallet" || !raw.privateKeyHex) return null;
    return raw.privateKeyHex;
  } catch {
    return null;
  }
}

function tryLock(): boolean {
  try {
    const fd = fs.openSync(LOCK_PATH, "wx");
    fs.writeFileSync(fd, String(process.pid));
    fs.closeSync(fd);
    return true;
  } catch {
    try {
      const age = Date.now() - fs.statSync(LOCK_PATH).mtimeMs;
      if (age > 180_000) {
        fs.unlinkSync(LOCK_PATH);
        return tryLock();
      }
    } catch {
      /* lock is in use */
    }
    return false;
  }
}

function unlock() {
  try {
    fs.unlinkSync(LOCK_PATH);
  } catch {
    /* already gone */
  }
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

async function send(chatId: number, text: string, tokenAddress?: string) {
  const token = fs.readFileSync(TOKEN_PATH, "utf8").trim();
  const sellMatch = text.match(/Sell\s*\n\s*(0x[0-9a-fA-F]{64})/);
  const buyMatch = text.match(/Buy\s*\n\s*(0x[0-9a-fA-F]{64})/);
  const rows: Array<Array<{ text: string; url: string }>> = [];
  const txButtons: Array<{ text: string; url: string }> = [];
  if (sellMatch) {
    txButtons.push({ text: "🔍 Sell Tx", url: `https://robinhoodchain.blockscout.com/tx/${sellMatch[1]}` });
  }
  if (buyMatch) {
    txButtons.push({ text: "🔍 Buy Tx", url: `https://robinhoodchain.blockscout.com/tx/${buyMatch[1]}` });
  }
  if (txButtons.length > 0) rows.push(txButtons);
  if (tokenAddress && /^0x[0-9a-fA-F]{40}$/.test(tokenAddress)) {
    rows.push([{ text: "📊 Token Explorer", url: `https://robinhoodchain.blockscout.com/token/${tokenAddress}` }]);
  }
  const replyMarkup = rows.length > 0 ? { inline_keyboard: rows } : MENU;

  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 3500), reply_markup: replyMarkup }),
  });
  if (!response.ok) throw new Error(`Telegram HTTP ${response.status}`);
}

function note(state: SavedState, title: string, detail: string) {
  state.tape = [{ at: Date.now(), title, detail: detail.slice(0, 600) }, ...(state.tape ?? [])].slice(0, 20);
}

export async function runDueTrade(wait = false): Promise<string> {
  if (fs.existsSync(`${ROOT}/data/external-runner`)) return "external";
  const deadline = Date.now() + (wait ? 150_000 : 0);
  let locked = tryLock();
  while (!locked && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    locked = tryLock();
  }
  if (!locked) return "";
  try {
    try {
      const botToken = fs.readFileSync(TOKEN_PATH, "utf8").trim();
      if (botToken) await setupBotMenu(botToken);
    } catch {}
    const state = JSON.parse(fs.readFileSync(STATE_PATH, "utf8")) as SavedState;
    const now = Date.now();
    if (state.halted || state.paused || state.active === false) return state.halted || state.paused ? "paused" : "";
    if (!state.token || !state.nextRecheck || now < state.nextRecheck) return "";
    const secret = readSecret();
    if (!secret) return "";

    const key = state.config?.interval ?? "30m";
    const windowSec = INACTIVITY_INTERVALS[key] ?? 1800;

    // Check actual on-chain inactivity for this token
    const inactivity = await checkRobinhoodInactivity(state.token.address, windowSec).catch(() => null);
    if (inactivity && !inactivity.isInactive) {
      const waitMs = Math.max(30, inactivity.remainingSec) * 1000;
      state.nextRecheck = now + waitMs;
      fs.writeFileSync(STATE_PATH, JSON.stringify(state));
      const elapsedM = Math.floor(inactivity.elapsedSec / 60);
      const waitM = Math.ceil(inactivity.remainingSec / 60);
      console.log(`[duty:runDueTrade] ⏳ Token ${state.token.symbol} is active on-chain (trade ${elapsedM}m ago). Next quiet check in ~${waitM}m.`);
      return "watching";
    }

    state.nextRecheck = now + SKIP_RECHECK_MS;
    let text = "";
    let traded = false;
    let halt = false;
    try {
      const result = await runChainCycle({
        privateKeyHex: secret,
        token: state.token.address,
        symbol: state.token.symbol,
        decimals: state.token.decimals,
        pool: state.pool ?? null,
      });
      state.pool = result.pool;
      traded = result.traded;
      halt = result.halt;
      if (result.traded) {
        state.lastTradeMs = now;
        state.nextRecheck = now + windowSec * 1000;
      } else if (result.halt) {
        state.active = true;
        state.halted = false;
        state.nextRecheck = now + BUY_RETRY_MS;
      } else if (result.retry === "interval") {
        state.nextRecheck = now + windowSec * 1000;
      }
      text = result.text;
    } catch (error) {
      text = `Swap failed. ${error instanceof Error ? error.message.slice(0, 180) : "Unknown error."} It will try again.`;
      halt = false;
    }
    const head = text.split("\n")[0] ?? "";
    const previous = state.tape?.[0];
    const repeat = !traded && previous != null && previous.detail.startsWith(head) && now - previous.at < 15 * 60 * 1000;
    note(state, traded ? "Round trip" : halt ? "Buy retry" : "Swap skipped", text);
    fs.writeFileSync(STATE_PATH, JSON.stringify(state));
    const line = `${new Date().toISOString()} ${head}\n`;
    for (const path of ["/tmp/telegram-bot.log", `${ROOT}/data/bot.log`]) {
      try {
        fs.appendFileSync(path, line);
      } catch {
        /* logging must not stop the next cycle */
      }
    }
    if (!repeat) {
      try {
        const admin = fs.readFileSync(ADMIN_PATH, "utf8").trim();
        const notificationText = traded
          ? `🟢 *Robinhood Inactivity Swap Executed* (${state.token?.symbol || "Token"})\n\n${text}\n\n⏱️ Triggered after ${key} of on-chain inactivity.`
          : `⚠️ ${state.token?.symbol || "Token"} cycle swap failed on Robinhood Chain.\n${text}`;
        if (admin) await send(Number(admin), notificationText, state.token?.address);
      } catch (sendErr) {
        console.error("[duty:runDueTrade] Failed to send Telegram notification:", sendErr instanceof Error ? sendErr.message : sendErr);
      }
    }
    return head || "done";
  } finally {
    unlock();
  }
}
