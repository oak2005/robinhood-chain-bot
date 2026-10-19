import fs from "node:fs";
import { runChainCycle, type V4Pool } from "../chain/cycle.ts";
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

async function send(chatId: number, text: string) {
  const token = fs.readFileSync(TOKEN_PATH, "utf8").trim();
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 3500) }),
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
    const state = JSON.parse(fs.readFileSync(STATE_PATH, "utf8")) as SavedState;
    const now = Date.now();
    if (state.halted || state.paused || state.active === false) return state.halted || state.paused ? "paused" : "";
    if (!state.token || !state.nextRecheck || now < state.nextRecheck) return "";
    const secret = readSecret();
    if (!secret) return "";
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
        const key = state.config?.interval ?? "10m";
        state.nextRecheck = now + (INACTIVITY_INTERVALS[key] ?? 600) * 1000;
      } else if (result.halt) {
        state.active = true;
        state.halted = false;
        state.nextRecheck = now + BUY_RETRY_MS;
      } else if (result.retry === "interval") {
        const key = state.config?.interval ?? "10m";
        state.nextRecheck = now + (INACTIVITY_INTERVALS[key] ?? 600) * 1000;
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
        if (admin) await send(Number(admin), text);
      } catch {
        /* chat can miss a note; the next window still runs */
      }
    }
    return head || "done";
  } finally {
    unlock();
  }
}
