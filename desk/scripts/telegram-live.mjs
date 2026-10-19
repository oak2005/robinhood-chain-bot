import { createCipheriv, randomBytes, randomUUID, scryptSync } from "node:crypto";
import fs from "node:fs";
import bs58 from "bs58";
import { Wallet } from "ethers";
import pg from "pg";
import nacl from "tweetnacl";
import { privateKeyToAddress } from "@stacks/transactions";

const GATE = "/tmp/trade-gate.json";
const STATE_URL = "https://raw.githubusercontent.com/oak2005/robinhood-chain-bot/main/data/stillmark-bot.json";
const BUTTONS = {
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
const INTERVALS = ["10m", "20m", "30m", "1h"];
const pending = new Map();

function readGate() {
  try {
    return JSON.parse(fs.readFileSync(GATE, "utf8"));
  } catch {
    return { telegram: false, paused: false, interval: "" };
  }
}

function writeGate(patch) {
  const next = { ...readGate(), ...patch, telegram: true };
  fs.writeFileSync(GATE, JSON.stringify(next));
}

function seal(secret) {
  const raw = process.env.VAULT_KEY ?? "";
  if (raw.length < 16) throw new Error("The vault secret is not set. Nothing was stored.");
  const key = scryptSync(raw, "inactivity-vault", 32);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
}

function chainOf(text) {
  const value = text.trim().toLowerCase();
  if (value.startsWith("sol")) return "solana";
  if (value.startsWith("stack")) return "stacks";
  if (value.startsWith("rob") || value === "rh") return "robinhood";
  return "";
}

function derive(chain, secret) {
  const trimmed = secret.trim();
  if (chain === "solana") {
    const bytes = trimmed.startsWith("[") ? Uint8Array.from(JSON.parse(trimmed)) : bs58.decode(trimmed);
    if (bytes.length !== 64 && bytes.length !== 32) throw new Error("A Solana key is 32 or 64 bytes.");
    const pair = bytes.length === 64 ? nacl.sign.keyPair.fromSecretKey(bytes) : nacl.sign.keyPair.fromSeed(bytes);
    return bs58.encode(pair.publicKey);
  }
  if (chain === "stacks") {
    const hex = trimmed.replace(/^0x/, "");
    const address = privateKeyToAddress(hex);
    if (!address.startsWith("SP") && !address.startsWith("SM")) throw new Error("That Stacks key did not make a mainnet address.");
    return address;
  }
  const hex = trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) throw new Error("Paste the Robinhood private key, 64 hex characters.");
  return new Wallet(hex).address;
}

let pool;
async function db() {
  if (!process.env.DATABASE_URL) return null;
  if (!pool) {
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
    await pool.query(`create table if not exists tg_wallets (
      user_id text not null,
      chain text not null,
      address text not null,
      wrapped text not null,
      primary key (user_id, chain)
    )`);
    await pool.query(`create table if not exists tg_tokens (
      id text primary key,
      user_id text not null,
      chain text not null,
      token text not null,
      symbol text not null default ''
    )`);
  }
  return pool;
}

async function savedLines(userId) {
  const database = await db();
  if (!database) return "No vault is connected yet, so a key cannot be kept.";
  const wallets = await database.query("select chain, address from tg_wallets where user_id = $1 order by chain", [userId]);
  const tokens = await database.query("select chain, token, symbol from tg_tokens where user_id = $1 order by chain", [userId]);
  if (!wallets.rows.length && !tokens.rows.length) return "No wallet is saved for this Telegram account yet. Tap Add key.";
  const lines = wallets.rows.map((row) => `${row.chain} ${row.address}`);
  for (const row of tokens.rows) lines.push(`${row.symbol || row.chain} ${row.token}`);
  return lines.join("\n");
}

const token = (process.env.TELEGRAM_BOT_TOKEN ?? "").trim();
const admin = (process.env.TELEGRAM_ADMIN_ID ?? "").trim();
if (!token.includes(":")) {
  fs.writeFileSync(GATE, JSON.stringify({ telegram: false, paused: false, interval: "" }));
  process.exit(0);
}
writeGate({ paused: readGate().paused === true, interval: readGate().interval || "" });

async function ownerStatus() {
  const gate = readGate();
  if (gate.paused) return "Paused. No new swap will start.";
  try {
    const response = await fetch(STATE_URL, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) return "Running on its own. The swap clock could not be read.";
    const state = await response.json();
    const mins = Math.max(0, Math.ceil(((state.nextRecheck ?? 0) - Date.now()) / 60000));
    const when = mins <= 0 ? "Next swap is due." : `Next swap in about ${mins} min.`;
    const lines = ["Running on its own.", when, state.token?.symbol ?? "NASTY", state.token?.address ?? ""];
    if (state.lastPreview) lines.push(state.lastPreview);
    return lines.filter(Boolean).join("\n");
  } catch {
    return "Running on its own. The swap clock could not be read.";
  }
}

function helpText() {
  return [
    "Everything stays in this chat.",
    "Add key, then send a fresh wallet private key in the next message.",
    "Add token, then send the coin address.",
    "Each account can keep 3 tokens.",
    "Do not use the wallet that is already trading.",
    "The key is sealed. It is not shown back and it is not written into the public files.",
  ].join("\n");
}

async function ownerReply(cmd, arg) {
  if (cmd === "/pause" || cmd === "/emergency_stop" || cmd === "/stop") {
    writeGate({ paused: true });
    return "Paused. No new swap will start.";
  }
  if (cmd === "/resume") {
    writeGate({ paused: false });
    return "Running again. The next check can swap.";
  }
  if (cmd === "/interval") {
    if (!INTERVALS.includes(arg)) return "Send /interval 10m, 20m, 30m, or 1h.";
    writeGate({ interval: arg });
    return `Interval set to ${arg}.`;
  }
  if (cmd === "/status" || cmd === "/balance" || cmd === "/tokeninfo" || cmd === "/config") return ownerStatus();
  if (cmd === "/help" || cmd === "/start") return `Running on its own.\n${helpText()}`;
  return helpText();
}

async function beginKey(chatId) {
  pending.set(chatId, { step: "chain-key" });
  return "Which chain? Reply Solana, Stacks, or Robinhood. Use a fresh wallet, not the one already trading.";
}

async function beginToken(chatId) {
  pending.set(chatId, { step: "chain-token" });
  return "Which chain is the token on? Reply Solana, Stacks, or Robinhood.";
}

async function removeKeys(userId) {
  const database = await db();
  if (!database) return "No vault is connected yet, so there is nothing to remove.";
  await database.query("delete from tg_tokens where user_id = $1", [userId]);
  await database.query("delete from tg_wallets where user_id = $1", [userId]);
  return "Removed the wallets and tokens saved for this Telegram account.";
}

async function takePending(chatId, userId, text) {
  const state = pending.get(chatId);
  if (!state) return "";
  if (text === "/cancel") {
    pending.delete(chatId);
    return "Cancelled.";
  }
  if (state.step === "chain-key" || state.step === "chain-token") {
    const chain = chainOf(text);
    if (!chain) return "Reply Solana, Stacks, or Robinhood.";
    state.chain = chain;
    state.step = state.step === "chain-key" ? "key" : "token";
    return state.step === "key"
      ? "Send the fresh wallet private key in the next message. It will be sealed. Do not send the wallet that is already trading."
      : "Send the token address.";
  }
  if (state.step === "key") {
    const database = await db();
    if (!database) return "No vault is connected yet. The key was not stored.";
    let address = "";
    try {
      address = derive(state.chain, text);
    } catch (error) {
      return error instanceof Error ? error.message : "That key could not be read.";
    }
    const wrapped = seal(text.trim());
    await database.query(
      `insert into tg_wallets (user_id, chain, address, wrapped) values ($1, $2, $3, $4)
       on conflict (user_id, chain) do update set address = excluded.address, wrapped = excluded.wrapped`,
      [userId, state.chain, address, wrapped],
    );
    pending.delete(chatId);
    return `Saved ${state.chain} ${address}. The key is not repeated. Tap Add token for the coin.`;
  }
  const database = await db();
  if (!database) return "No vault is connected yet. The token was not stored.";
  const count = await database.query("select count(*)::int as n from tg_tokens where user_id = $1", [userId]);
  if ((count.rows[0]?.n ?? 0) >= 3) return "Three tokens are already saved. Tap Remove key before adding another account's set.";
  const tokenText = text.trim();
  await database.query("insert into tg_tokens (id, user_id, chain, token, symbol) values ($1, $2, $3, $4, '')", [
    randomUUID(),
    userId,
    state.chain,
    tokenText,
  ]);
  pending.delete(chatId);
  return `Saved the token on ${state.chain}. This account can hold up to 3.`;
}

async function guestCommand(chatId, userId, cmd) {
  if (cmd === "/pause" || cmd === "/resume" || cmd === "/stop" || cmd === "/emergency_stop" || cmd === "/interval") {
    return "This account cannot pause or stop the running swaps.";
  }
  if (cmd === "/addkey") return beginKey(chatId);
  if (cmd === "/addtoken") return beginToken(chatId);
  if (cmd === "/removekey") return removeKeys(userId);
  if (cmd === "/balance" || cmd === "/status" || cmd === "/tokeninfo" || cmd === "/config") return savedLines(userId);
  return helpText();
}

async function send(chatId, text) {
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 3500) }),
  });
}

async function hide(chatId, messageId) {
  await fetch(`https://api.telegram.org/bot${token}/deleteMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId }),
  }).catch(() => undefined);
}

let offset = 0;
while (true) {
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/getUpdates`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ offset, timeout: 25, allowed_updates: ["message"] }),
      signal: AbortSignal.timeout(35000),
    });
    const payload = await response.json();
    if (!response.ok) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      continue;
    }
    for (const update of payload.result ?? []) {
      if (typeof update.update_id === "number") offset = Math.max(offset, update.update_id + 1);
      const message = update.message;
      const raw = typeof message?.text === "string" ? message.text.trim() : "";
      const chatId = message?.chat?.id;
      const userId = String(message?.from?.id ?? "");
      if (!raw || !chatId || !userId) continue;
      const waiting = pending.get(chatId);
      const mapped = BUTTONS[raw] ?? raw;
      try {
        if (waiting && !BUTTONS[raw] && !mapped.startsWith("/status") && mapped !== "/cancel" && !mapped.startsWith("/add") && !mapped.startsWith("/remove") && !mapped.startsWith("/help") && !mapped.startsWith("/start")) {
          if (waiting.step === "key") await hide(chatId, message.message_id);
          await send(chatId, await takePending(chatId, userId, raw));
          continue;
        }
        if (mapped === "/cancel") {
          pending.delete(chatId);
          await send(chatId, "Cancelled.");
          continue;
        }
        if (!mapped.startsWith("/")) continue;
        const cmd = mapped.split(/\s+/)[0]?.split("@")[0] ?? "";
        const arg = mapped.split(/\s+/)[1] ?? "";
        const isAdmin = admin && userId === admin;
        if (cmd === "/addkey" || cmd === "/addtoken" || cmd === "/removekey") {
          const reply = cmd === "/addkey" ? await beginKey(chatId) : cmd === "/addtoken" ? await beginToken(chatId) : await removeKeys(userId);
          await send(chatId, isAdmin ? `${reply}\nThis does not replace the wallet already trading.` : reply);
          continue;
        }
        const reply = isAdmin && cmd !== "/help" && cmd !== "/start" ? await ownerReply(cmd, arg) : isAdmin ? await ownerReply(cmd, arg) : await guestCommand(chatId, userId, cmd);
        await send(chatId, reply);
      } catch (error) {
        const reason = error instanceof Error ? error.message : "That could not be saved.";
        await send(chatId, reason.slice(0, 300));
      }
    }
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}
