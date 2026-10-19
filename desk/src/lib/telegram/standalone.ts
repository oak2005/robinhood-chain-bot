import fs from "node:fs";
try {
  fs.appendFileSync("/workspace/data/bot.log", `${new Date().toISOString()} boot file loaded\n`);
} catch {
  /* keep going even if the log file is unavailable */
}
import { adminGate, interpretCommand, type CommandEffect, type PendingConfirm } from "../engine/commands.ts";
import { clampProtected } from "../engine/decision.ts";
import { INITIAL_MARKET, type MarketState } from "../engine/market.ts";
import { CHAIN_ID, CHAIN_NAME, EXPLORER, readChainToken, readEthBalance, type ChainToken } from "../chain/robinhood-chain.ts";
import { type V4Pool, previewChain } from "../chain/cycle.ts";
import { runDueTrade } from "./duty.ts";
import { importWallet } from "./wallet-import.ts";
import {
  DEFAULT_CONFIG,
  HARD_MIN_PROTECTED_USD,
  INACTIVITY_INTERVALS,
  INTERVAL_LABEL,
  type Balances,
  type IntervalKey,
  type StrategyConfig,
} from "../engine/types.ts";

const STATE_PATH = "/workspace/data/stillmark-bot.json";
const CREDS_PATH = "/workspace/.secrets/robinhood_creds.json";
const TOKEN_PATH = "/workspace/.secrets/telegram_bot_token";
const ADMIN_PATH = "/workspace/.secrets/telegram_admin_id";
const OFFSET_PATH = "/workspace/.secrets/telegram_offset";

interface TapeNote {
  at: number;
  title: string;
  detail: string;
}

interface BotState {
  config: StrategyConfig;
  balances: Balances;
  market: MarketState;
  active: boolean;
  halted: boolean;
  paused: boolean;
  paperFills: boolean;
  awaitingKey: boolean;
  awaitingToken: boolean;
  lastTradeMs: number;
  nextRecheck: number;
  tape: TapeNote[];
  pending: PendingConfirm | null;
  token: ChainToken | null;
  pool: V4Pool | null;
  lastOnlineNote: number;
}

interface Inbound {
  updateId: number;
  fromId: string;
  chatId: number;
  messageId: number | null;
  text: string;
}

let state: BotState = freshState();
let offset = 0;
let chain: Promise<void> = Promise.resolve();
let lastInboundAt = 0;
let tickQueued = false;

function freshState(): BotState {
  const now = Date.now();
  return {
    config: { ...DEFAULT_CONFIG },
    balances: { usd: 2, tokenQty: 10 },
    market: { ...INITIAL_MARKET },
    active: false,
    halted: false,
    paused: false,
    paperFills: false,
    awaitingKey: false,
    awaitingToken: false,
    lastTradeMs: now,
    nextRecheck: now + INACTIVITY_INTERVALS["10m"] * 1000,
    tape: [],
    pending: null,
    token: null,
    pool: null,
    lastOnlineNote: 0,
  };
}

function readToken(): string {
  return fs.readFileSync(TOKEN_PATH, "utf8").trim();
}

function readAdmin(): string {
  try {
    return fs.readFileSync(ADMIN_PATH, "utf8").trim();
  } catch {
    return "";
  }
}

function writeAdmin(id: string) {
  fs.mkdirSync("/workspace/.secrets", { recursive: true });
  fs.writeFileSync(ADMIN_PATH, `${id}\n`, { mode: 0o600 });
}

function loadWalletSecret(): { address: string; privateKeyHex: string } | null {
  try {
    const raw = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as {
      type?: string;
      address?: string;
      privateKeyHex?: string;
    };
    if (raw.type !== "wallet" || !raw.address || !raw.privateKeyHex) return null;
    return { address: raw.address, privateKeyHex: raw.privateKeyHex };
  } catch {
    return null;
  }
}

function loadWallet(): { address: string } | null {
  const secret = loadWalletSecret();
  return secret ? { address: secret.address } : null;
}

function saveWallet(address: string, privateKeyHex: string) {
  fs.mkdirSync("/workspace/.secrets", { recursive: true });
  fs.writeFileSync(CREDS_PATH, JSON.stringify({ type: "wallet", address, privateKeyHex }), { mode: 0o600 });
}

function wipeCreds() {
  state.active = false;
  try {
    fs.unlinkSync(CREDS_PATH);
  } catch {
    /* already gone */
  }
}

function load() {
  try {
    offset = Number(fs.readFileSync(OFFSET_PATH, "utf8").trim()) || 0;
  } catch {
    offset = 0;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_PATH, "utf8")) as Partial<BotState>;
    state = {
      ...freshState(),
      ...raw,
      config: {
        ...DEFAULT_CONFIG,
        ...raw.config,
        minProtectedUsd: clampProtected(raw.config?.minProtectedUsd ?? HARD_MIN_PROTECTED_USD),
      },
      active: false,
      halted: Boolean(raw.halted),
      paused: Boolean(raw.paused),
      pending: null,
      awaitingKey: false,
      awaitingToken: false,
      token: raw.token ?? null,
      pool: raw.pool ?? null,
      lastOnlineNote: raw.lastOnlineNote ?? 0,
    };
    if (state.token && loadWallet() && !state.halted && !state.paused) state.active = true;
  } catch {
    state = freshState();
  }
}

function save() {
  try {
    const disk = JSON.parse(fs.readFileSync(STATE_PATH, "utf8")) as BotState;
    const diskAt = disk.tape?.[0]?.at ?? 0;
    const memoryAt = state.tape[0]?.at ?? 0;
    if (diskAt > memoryAt) {
      state.tape = disk.tape;
      state.pool = disk.pool;
      state.lastTradeMs = disk.lastTradeMs;
      if (disk.nextRecheck > state.nextRecheck) state.nextRecheck = disk.nextRecheck;
    }
  } catch {
    /* no state yet */
  }
  fs.mkdirSync("/workspace/data", { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(state));
  fs.mkdirSync("/workspace/.secrets", { recursive: true });
  fs.writeFileSync(OFFSET_PATH, `${offset}\n`, { mode: 0o600 });
}

function note(title: string, detail: string) {
  state.tape = [{ at: Date.now(), title, detail: detail.slice(0, 600) }, ...state.tape].slice(0, 20);
}

function walletLabel(): string {
  const wallet = loadWallet();
  return wallet ? `${wallet.address.slice(0, 6)}…${wallet.address.slice(-4)}` : "not stored";
}

function prettyAmount(amount: string): string {
  const [whole, fraction] = amount.split(".");
  const grouped = (whole || "0").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return fraction ? `${grouped}.${fraction}` : grouped;
}

function nextCheckText(): string {
  const mins = Math.max(0, Math.ceil((state.nextRecheck - Date.now()) / 60000));
  return mins <= 0 ? "Next check is due." : `Next check in about ${mins} min.`;
}

async function chainBalanceText(): Promise<string> {
  const mode = state.halted ? "halted" : state.active ? "watching" : "paused";
  const wallet = loadWallet();
  const lines = [`${CHAIN_NAME} is ${mode}.`, `Chain ${CHAIN_ID}. Gas is ETH.`, nextCheckText()];
  if (!state.token) lines.push("No token saved. Tap Add token and send the contract address.");
  else lines.push(state.token.symbol, state.token.name);
  if (!wallet) {
    lines.push("No wallet saved. Tap Add key.");
    if (state.token) lines.push("Contract", state.token.address);
    return lines.join("\n");
  }
  try {
    const eth = await readEthBalance(wallet.address);
    lines.push(`ETH ${prettyAmount(eth)}`);
    if (state.token) {
      const token = await readChainToken(state.token.address, wallet.address);
      lines.splice(3, 0, `${prettyAmount(token.balance ?? "0")} ${token.symbol}`);
    }
  } catch (error) {
    lines.push(error instanceof Error ? error.message : "Chain read failed.");
  }
  lines.push(`Wallet ${wallet.address}`);
  if (state.token) lines.push("Contract", state.token.address);
  if (wallet && state.token) {
    try {
      const preview = await previewChain({
        address: wallet.address,
        token: state.token.address,
        symbol: state.token.symbol,
        decimals: state.token.decimals,
        pool: state.pool,
      });
      if (preview.pool) state.pool = preview.pool;
      lines.push(preview.text);
    } catch (error) {
      lines.push(error instanceof Error ? error.message : "Price check failed.");
    }
  }
  return lines.join("\n");
}

function helpBody(): string {
  return [
    "This bot trades one token on Robinhood Chain, in Telegram only.",
    "If this chat is quiet for 1 second, the bot runs itself. You do not have to stay or send a message.",
    "Swaps still wait out the interval you picked: 10, 20, 30 minutes, or 1 hour.",
    "Tap Stop to turn it off.",
    "",
    "Status — balance, dollar value, and whether the next clip would pass.",
    "Balance — the same chain balances.",
    "Config — interval, the rotating dollar size, and the cost check.",
    "Token — the saved contract.",
    "Help — this list.",
    "Resume — turn swaps back on.",
    "Pause — stop new swaps until you tap Resume.",
    "Stop — turn the bot off until you tap Resume.",
    "Interval — 10, 20, 30 minutes, or 1 hour of quiet time.",
    "Add token — send the token contract address.",
    "Add key — only if you are replacing the saved wallet.",
    "Remove key — delete the stored key. Reply CONFIRM.",
    "",
    "Each cycle sells a dollar size and buys that same size back.",
    "The size changes every cycle: $5, then $8, then $6, $7, $7.50, $9, and it repeats.",
    "If the bag is smaller than the target, that cycle uses the bag instead of waiting.",
    "It quotes the pool and takes that rate. Gas is the network price, with no boosted tip.",
    "A round trip worse than 4% is skipped. After a sell, the buy is priced again from what came back.",
    "If a buy fails, it retries that buy and does not sell again.",
    "There is no withdrawal.",
  ].join("\n");
}

async function configBody(): Promise<string> {
  const lines = [
    state.token ? `${state.token.symbol} on ${CHAIN_NAME}` : `No token on ${CHAIN_NAME}`,
    `Interval: ${INTERVAL_LABEL[state.config.interval]}`,
    "Size rotates each cycle: $5, $8, $6, $7, $7.50, $9. Sell that many dollars, then buy them back.",
    "If the bag is smaller than the target, that cycle still trades and uses the bag.",
    "Route: best quoted rate on the pool. Skips only if that round trip is over 4%.",
    "Gas: network price, no boosted tip.",
    nextCheckText(),
    state.halted ? "Stopped." : state.paused || !state.active ? "Paused." : "Watching.",
  ];
  const wallet = loadWallet();
  if (wallet) lines.push(`Wallet ${wallet.address}`);
  if (wallet && state.token) {
    try {
      const preview = await previewChain({
        address: wallet.address,
        token: state.token.address,
        symbol: state.token.symbol,
        decimals: state.token.decimals,
        pool: state.pool,
      });
      if (preview.pool) state.pool = preview.pool;
      lines.push(preview.text);
    } catch (error) {
      lines.push(error instanceof Error ? error.message : "Price check failed.");
    }
  }
  return lines.join("\n");
}

const MENU = {
  keyboard: [
    [{ text: "Status" }, { text: "Balance" }, { text: "Config" }],
    [{ text: "Help" }, { text: "Resume" }, { text: "Pause" }],
    [{ text: "Stop" }, { text: "Interval" }, { text: "Token" }],
    [{ text: "Add token" }, { text: "Add key" }, { text: "Remove key" }],
  ],
  resize_keyboard: true,
  is_persistent: true,
};

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

async function tg(method: string, body: Record<string, unknown>): Promise<unknown> {
  const response = await fetch(`https://api.telegram.org/bot${readToken()}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await response.json().catch(() => null)) as { ok?: boolean; description?: string; result?: unknown } | null;
  if (!response.ok || !payload?.ok) throw new Error(payload?.description ?? `Telegram HTTP ${response.status}`);
  return payload.result;
}

async function send(chatId: number, text: string, keyboard?: "interval") {
  const body: Record<string, unknown> = { chat_id: chatId, text: text.slice(0, 3500), reply_markup: MENU };
  if (keyboard === "interval") {
    body.reply_markup = {
      inline_keyboard: [
        [{ text: "10 minutes", callback_data: "interval:10m" }],
        [{ text: "20 minutes", callback_data: "interval:20m" }],
        [{ text: "30 minutes", callback_data: "interval:30m" }],
        [{ text: "1 hour", callback_data: "interval:1h" }],
      ],
    };
  }
  await tg("sendMessage", body);
}

function enqueue(task: () => Promise<void>) {
  chain = chain.then(task, task);
}

function silenceTick() {
  if (tickQueued) return;
  if (Date.now() - lastInboundAt < 1000) return;
  tickQueued = true;
  enqueue(async () => {
    try {
      await onTick();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      try {
        fs.appendFileSync("/workspace/data/bot.log", `${new Date().toISOString()} tick ${message.slice(0, 180)}\n`);
      } catch {
        /* logging must not stop the trigger */
      }
    } finally {
      tickQueued = false;
    }
  });
}

function applyEffects(effects: CommandEffect[]) {
  for (const effect of effects) {
    if (effect.type === "pause") {
      state.active = false;
      state.paused = true;
      note("Paused", "No new swap will start.");
    } else if (effect.type === "emergency_stop") {
      state.active = false;
      state.halted = true;
      state.paused = false;
      state.pending = null;
      note("Stopped", "Halted.");
    } else if (effect.type === "set_interval") {
      state.config = { ...state.config, interval: effect.key as IntervalKey };
      note("Interval", INTERVAL_LABEL[effect.key]);
    } else if (effect.type === "request_confirm") {
      state.pending = effect.pending;
    } else if (effect.type === "clear_confirm") {
      state.pending = null;
    } else if (effect.type === "resume") {
      const now = Date.now();
      state.halted = false;
      state.paused = false;
      state.active = true;
      state.lastTradeMs = now;
      state.nextRecheck = now + INACTIVITY_INTERVALS[state.config.interval] * 1000;
      if (state.token) {
        try {
          const open = JSON.parse(fs.readFileSync("/workspace/data/chain-recovery.json", "utf8")) as { soldHash?: string; token?: string };
          if (open.soldHash && open.token?.toLowerCase() === state.token.address.toLowerCase()) state.nextRecheck = now;
        } catch {
          /* no open sell */
        }
      }
      note("Watching", "Fresh quiet window.");
    }
  }
}

function handleCommand(cmd: Inbound) {
  const text = BUTTONS[cmd.text] ?? cmd.text;
  const gate = adminGate(readAdmin(), cmd.fromId, text);
  if (gate === "lock") {
    writeAdmin(cmd.fromId);
    return send(cmd.chatId, `Admin locked to ${cmd.fromId}.\n${CHAIN_NAME}. Tap Add key, then Add token.`);
  }
  if (gate === "mismatch") return send(cmd.chatId, `That number is not this account's id (${cmd.fromId}).`);
  if (gate === "prompt") return send(cmd.chatId, `Your Telegram user id is ${cmd.fromId}. Send that number once.`);
  if (gate === "reject") return send(cmd.chatId, "Unauthorized.");
  return handleAdmin(cmd, text);
}

async function handleAdmin(cmd: Inbound, text: string) {
  if (state.awaitingKey && text !== "/cancel" && !BUTTONS[cmd.text] && !text.startsWith("/")) {
    state.awaitingKey = false;
    if (cmd.messageId != null) await tg("deleteMessage", { chat_id: cmd.chatId, message_id: cmd.messageId }).catch(() => undefined);
    const wallet = importWallet(text);
    if (!wallet) {
      save();
      return send(cmd.chatId, "That was not a private key or a 12/24 word phrase. Nothing was stored.");
    }
    saveWallet(wallet.address, wallet.privateKeyHex);
    if (state.token && !state.halted) {
      state.active = true;
      state.nextRecheck = Date.now();
    }
    save();
    return send(cmd.chatId, `Wallet saved.\n${wallet.address}\nDelete that message if it is still visible.`);
  }
  if (state.awaitingToken && text !== "/cancel" && !BUTTONS[cmd.text] && !text.startsWith("/")) {
    state.awaitingToken = false;
    const found = text.match(/0x[a-fA-F0-9]{40}/);
    if (!found) {
      save();
      return send(cmd.chatId, "Send the token contract address. 0x and 40 hex characters.");
    }
    try {
      const wallet = loadWallet();
      const token = await readChainToken(found[0], wallet?.address);
      state.token = { address: token.address, symbol: token.symbol, name: token.name, decimals: token.decimals };
      state.pool = null;
      if (wallet && !state.halted) {
        state.active = true;
        state.nextRecheck = Date.now();
      }
      note("Token saved", token.symbol);
      save();
      const held = token.balance == null ? "Add a wallet to read the balance." : `Balance ${prettyAmount(token.balance)} ${token.symbol}.`;
      return send(cmd.chatId, [`${token.symbol} is saved.`, held, "Contract", token.address, `${EXPLORER}/token/${token.address}`].join("\n"));
    } catch (error) {
      save();
      return send(cmd.chatId, `Token was not saved. ${error instanceof Error ? error.message : "Read failed."}`);
    }
  }
  if (text === "/help") return send(cmd.chatId, helpBody());
  if (text === "/config") {
    const body = await configBody();
    save();
    return send(cmd.chatId, body);
  }
  if (text === "/addkey") {
    state.awaitingKey = true;
    state.awaitingToken = false;
    save();
    return send(cmd.chatId, "Send a wallet private key, or a 12 or 24 word phrase.\nRobinhood Chain only. Reply /cancel to stop.");
  }
  if (text === "/addtoken") {
    state.awaitingToken = true;
    state.awaitingKey = false;
    save();
    return send(cmd.chatId, `Send the token contract on ${CHAIN_NAME}.\nReply /cancel to stop.`);
  }
  if (text === "/cancel" && (state.awaitingKey || state.awaitingToken)) {
    state.awaitingKey = false;
    state.awaitingToken = false;
    save();
    return send(cmd.chatId, "Cancelled. Nothing was stored.");
  }
  if (text === "/removekey") {
    if (!loadWallet()) return send(cmd.chatId, "No key is stored.");
    state.pending = { action: "clear_key", summary: "Delete the stored wallet key." };
    save();
    return send(cmd.chatId, "Reply CONFIRM to delete the stored key.");
  }
  if (/^confirm$/i.test(text) && state.pending?.action === "clear_key") {
    wipeCreds();
    state.pending = null;
    save();
    return send(cmd.chatId, "Stored key deleted. Swaps are off.");
  }
  if (text === "/status" || text === "/balance" || text === "/tokeninfo") return send(cmd.chatId, await chainBalanceText());
  if (text === "/resume" && state.token) {
    const now = Date.now();
    state.halted = false;
    state.paused = false;
    state.active = true;
    state.lastTradeMs = now;
    state.nextRecheck = now + INACTIVITY_INTERVALS[state.config.interval] * 1000;
    try {
      const open = JSON.parse(fs.readFileSync("/workspace/data/chain-recovery.json", "utf8")) as { soldHash?: string; token?: string };
      if (open.soldHash && open.token?.toLowerCase() === state.token.address.toLowerCase()) state.nextRecheck = now;
    } catch {
      /* no open sell */
    }
    note("Watching", "Running on its own.");
    save();
    return send(cmd.chatId, `Running again.\n${state.token.symbol}\n${nextCheckText()}\nYou can leave this chat.`);
  }
  if (text === "/pause") {
    state.active = false;
    state.paused = true;
    save();
    return send(cmd.chatId, "Paused. No new swap will start. Tap Resume to turn it back on.");
  }
  if (text === "/emergency_stop") {
    state.active = false;
    state.halted = true;
    state.paused = false;
    state.pending = null;
    save();
    return send(cmd.chatId, "Stopped. Swaps are off until you tap Resume.");
  }

  const effects = interpretCommand(
    {
      channel: "telegram",
      fromId: cmd.fromId,
      adminId: readAdmin(),
      config: state.config,
      pending: state.pending,
      dryRun: true,
      tradingEnabled: state.active,
      halted: state.halted,
      active: state.active,
      equityText: walletLabel(),
      quoteText: state.token ? `${state.token.symbol} ${state.token.address}` : "No token",
      statusText: state.token ? `${state.token.symbol} on ${CHAIN_NAME}` : "No token",
      historyText: state.tape.map((item) => `${item.title}: ${item.detail}`).join("\n") || "No notes yet.",
    },
    text,
  );
  applyEffects(effects);
  const reply = effects.find((effect) => effect.type === "reply");
  save();
  return send(cmd.chatId, reply && reply.type === "reply" ? reply.text : "No reply.", reply && reply.type === "reply" ? reply.keyboard : undefined);
}

async function onTick() {
  await runDueTrade(false);
  try {
    const disk = JSON.parse(fs.readFileSync(STATE_PATH, "utf8")) as BotState;
    state.nextRecheck = disk.nextRecheck ?? state.nextRecheck;
    state.lastTradeMs = disk.lastTradeMs ?? state.lastTradeMs;
    state.tape = disk.tape ?? state.tape;
    state.pool = disk.pool ?? state.pool;
    if (typeof disk.active === "boolean") state.active = disk.active;
    state.halted = Boolean(disk.halted);
    state.paused = Boolean(disk.paused);
  } catch {
    /* keep memory */
  }
}

function parseUpdate(update: Record<string, unknown>): Inbound | null {
  const updateId = typeof update.update_id === "number" ? update.update_id : null;
  if (updateId == null) return null;
  const callback = update.callback_query as Record<string, unknown> | undefined;
  const message = (callback?.message ?? update.message) as Record<string, unknown> | undefined;
  const from = (callback?.from ?? message?.from) as Record<string, unknown> | undefined;
  const fromId = from?.id != null ? String(from.id) : "";
  const chat = message?.chat as Record<string, unknown> | undefined;
  const chatId = typeof chat?.id === "number" ? chat.id : null;
  const messageId = typeof message?.message_id === "number" ? message.message_id : null;
  let text = "";
  if (typeof callback?.data === "string") {
    text = callback.data.startsWith("interval:") ? `/interval ${callback.data.slice("interval:".length)}` : callback.data;
    const id = callback.id;
    if (typeof id === "string") void tg("answerCallbackQuery", { callback_query_id: id }).catch(() => undefined);
  } else if (typeof message?.text === "string") text = message.text.trim();
  if (!text || chatId == null || !fromId) return null;
  return { updateId, fromId, chatId, messageId, text: text.slice(0, 2000) };
}

async function main() {
  load();
  fs.appendFileSync("/workspace/data/bot.log", `${new Date().toISOString()} online\n`);
  const admin = readAdmin();
  const now = Date.now();
  if (admin && now - state.lastOnlineNote > 15 * 60 * 1000) {
    state.lastOnlineNote = now;
    save();
    const text = await chainBalanceText().catch(() => `${CHAIN_NAME} is online.`);
    const running =
      state.token && loadWallet() && state.active
        ? `${text}\n\nQuiet for 1 second starts it. You do not have to stay in this chat.\nSwaps still follow your interval. Tap Stop to turn it off.`
        : text;
    await send(Number(admin), running).catch(() => undefined);
  }
  setInterval(() => {
    try {
      fs.writeFileSync("/workspace/data/bot.heartbeat", String(Date.now()));
    } catch {
      /* heartbeat must not stop the trigger */
    }
    silenceTick();
  }, 1000);
  for (;;) {
    let updates: unknown = [];
    try {
      updates = await tg("getUpdates", { offset, timeout: 20, allowed_updates: ["message", "callback_query"] });
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (!message.includes("Conflict")) {
        fs.appendFileSync("/workspace/data/bot.log", `${new Date().toISOString()} telegram ${message.slice(0, 180)}\n`);
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
      continue;
    }
    if (!Array.isArray(updates)) continue;
    for (const update of updates) {
      if (!update || typeof update !== "object") continue;
      const inbound = parseUpdate(update as Record<string, unknown>);
      if (!inbound) {
        const id = (update as { update_id?: number }).update_id;
        if (typeof id === "number") offset = id + 1;
        continue;
      }
      offset = inbound.updateId + 1;
      lastInboundAt = Date.now();
      fs.mkdirSync("/workspace/.secrets", { recursive: true });
      fs.writeFileSync(OFFSET_PATH, `${offset}\n`, { mode: 0o600 });
      enqueue(async () => {
        try {
          await handleCommand(inbound);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          fs.appendFileSync("/workspace/data/bot.log", `${new Date().toISOString()} command ${message.slice(0, 180)}\n`);
        }
      });
    }
  }
}

process.on("unhandledRejection", (error) => {
  const message = error instanceof Error ? error.message : String(error);
  fs.appendFileSync("/workspace/data/bot.log", `${new Date().toISOString()} rejection ${message.slice(0, 180)}\n`);
});

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  fs.appendFileSync("/workspace/data/bot.log", `${new Date().toISOString()} exit ${message.slice(0, 180)}\n`);
  process.exit(1);
});
