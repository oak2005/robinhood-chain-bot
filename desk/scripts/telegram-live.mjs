import { createCipheriv, createDecipheriv, randomBytes, randomUUID, scryptSync } from "node:crypto";
import fs from "node:fs";
import bs58 from "bs58";
import { ethers, Wallet } from "ethers";
import pg from "pg";
import nacl from "tweetnacl";
import { privateKeyToAddress } from "@stacks/transactions";
import { lookupPayment } from "../src/lib/members/pay.ts";
import { previewChain, runChainCycle } from "../src/lib/chain/cycle.ts";

const GATE = "/tmp/trade-gate.json";
const STATE_URL = "https://raw.githubusercontent.com/oak2005/robinhood-chain-bot/main/data/stillmark-bot.json";
const NASTY_WALLET = "0xdf246e7a947674476c832544f7867aa864c60bd5";
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
  Pay: "/pay",
};
const INTERVALS = ["10m", "20m", "30m", "1h"];
const INTERVALS_SEC = { "10m": 600, "20m": 1200, "30m": 1800, "1h": 3600 };
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const pending = new Map();

function readGate() {
  try {
    return JSON.parse(fs.readFileSync(GATE, "utf8"));
  } catch {
    return { telegram: false, paused: false, interval: "" };
  }
}

function writeGate(patch) {
  try {
    fs.mkdirSync("/tmp", { recursive: true });
  } catch {}
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

function unseal(wrapped) {
  const raw = process.env.VAULT_KEY ?? "";
  if (raw.length < 16) throw new Error("The vault secret is not set.");
  const key = scryptSync(raw, "inactivity-vault", 32);
  const buf = Buffer.from(wrapped, "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const body = buf.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
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

function generateMemo() {
  const bytes = randomBytes(6);
  let memo = "";
  for (const byte of bytes) memo += ALPHABET[byte % ALPHABET.length];
  return memo;
}

let pool;
async function db() {
  if (!process.env.DATABASE_URL) return null;
  if (!pool) {
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
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
    await pool.query(`create table if not exists member_access (
      user_id text primary key,
      memo text not null unique,
      paid_until timestamptz,
      last_tx text not null default ''
    )`);
    await pool.query(`create table if not exists used_payments (
      tx_hash text primary key,
      user_id text not null,
      pay_chain text not null,
      asset text not null,
      amount text not null
    )`);
    await pool.query(`create table if not exists member_settings (
      user_id text primary key,
      paused boolean not null default false,
      interval text not null default '30m',
      cycle_index int not null default 0,
      next_recheck_ms bigint not null default 0,
      last_trade_ms bigint not null default 0,
      last_trade_text text not null default ''
    )`);
  }
  return pool;
}

async function getOrCreateMemberAccess(userId) {
  const database = await db();
  if (!database) return null;
  const res = await database.query("select memo, paid_until::text as paid_until from member_access where user_id = $1", [userId]);
  if (res.rows.length > 0) return res.rows[0];
  const memo = generateMemo();
  try {
    await database.query("insert into member_access (user_id, memo) values ($1, $2)", [userId, memo]);
    return { memo, paid_until: null };
  } catch {
    const retry = await database.query("select memo, paid_until::text as paid_until from member_access where user_id = $1", [userId]);
    return retry.rows[0] ?? null;
  }
}

async function getMemberSettings(userId) {
  const database = await db();
  if (!database) return { paused: false, interval: "30m", cycle_index: 0, next_recheck_ms: 0, last_trade_text: "" };
  const res = await database.query("select * from member_settings where user_id = $1", [userId]);
  if (res.rows.length > 0) return res.rows[0];
  await database.query("insert into member_settings (user_id) values ($1) on conflict do nothing", [userId]);
  return { paused: false, interval: "30m", cycle_index: 0, next_recheck_ms: 0, last_trade_text: "" };
}

async function updateMemberSettings(userId, patch) {
  const database = await db();
  if (!database) return;
  const current = await getMemberSettings(userId);
  const next = { ...current, ...patch };
  await database.query(
    `insert into member_settings (user_id, paused, interval, cycle_index, next_recheck_ms, last_trade_ms, last_trade_text)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (user_id) do update set
       paused = excluded.paused,
       interval = excluded.interval,
       cycle_index = excluded.cycle_index,
       next_recheck_ms = excluded.next_recheck_ms,
       last_trade_ms = excluded.last_trade_ms,
       last_trade_text = excluded.last_trade_text`,
    [userId, next.paused, next.interval, next.cycle_index, next.next_recheck_ms, next.last_trade_ms, next.last_trade_text],
  );
}

async function payInfoText(userId) {
  const access = await getOrCreateMemberAccess(userId);
  if (!access) return "Database is not connected. Payment cannot be verified yet.";
  const isCovered = access.paid_until && new Date(access.paid_until).getTime() > Date.now();
  const coveredText = isCovered
    ? `Access is ACTIVE until ${new Date(access.paid_until).toUTCString()}.`
    : "Currently INACTIVE. Access is at least $20 USD per 30 days.";

  return [
    `Inactivity Trade — Access & Payment`,
    coveredText,
    "",
    `Your unique memo: ${access.memo}`,
    "You MUST include this exact memo in the transaction (Solana memo program, or in Base/BNB transaction input).",
    "",
    "Accepted tokens: USDT or USDC (minimum $20)",
    "",
    "Solana deposit:",
    "GLrFg8GR7iNotxJRvVHakdbhpRHjEEe8EHXVmjHxNG1T",
    "",
    "Base / BNB deposit:",
    "0x4a543eEbBB5DFaA2FE0E4f36E84b0eaf5803D7DD",
    "",
    "After sending, paste your transaction hash in this chat to activate.",
  ].join("\n");
}

async function verifyPayment(userId, txHash) {
  const database = await db();
  if (!database) return "No vault/database is connected yet.";
  const cleanHash = txHash.trim();
  const access = await getOrCreateMemberAccess(userId);
  if (!access) return "Could not load access record.";

  const isSolana = /^[1-9A-HJ-NP-Za-km-z]{64,128}$/.test(cleanHash);
  const isEvm = /^0x[0-9a-fA-F]{64}$/.test(cleanHash);
  if (!isSolana && !isEvm) {
    return "That does not look like a valid Solana signature or Base/BNB transaction hash.";
  }

  const used = await database.query("select tx_hash from used_payments where tx_hash = $1", [cleanHash.toLowerCase()]);
  if (used.rows.length > 0) {
    return "That transaction hash has already been used. Each transaction can only be used once.";
  }

  let verdict;
  let chainName = isSolana ? "solana" : "base";
  try {
    if (isSolana) {
      verdict = await lookupPayment("solana", cleanHash, access.memo);
    } else {
      verdict = await lookupPayment("base", cleanHash, access.memo);
      if (!verdict.ok && (verdict.error.includes("not found") || verdict.error.includes("did not send"))) {
        const bscVerdict = await lookupPayment("bsc", cleanHash, access.memo);
        if (bscVerdict.ok || !bscVerdict.error.includes("not found")) {
          verdict = bscVerdict;
          chainName = "bsc";
        }
      }
    }
  } catch (error) {
    return `Payment check failed: ${error instanceof Error ? error.message : "Error contacting chain RPC."}`;
  }

  if (!verdict.ok) {
    return `Payment rejected: ${verdict.error}`;
  }

  const currentPaid = access.paid_until && new Date(access.paid_until).getTime() > Date.now()
    ? new Date(access.paid_until).getTime()
    : Date.now();
  const newPaidUntil = new Date(currentPaid + 30 * 24 * 60 * 60 * 1000).toISOString();

  await database.query(
    "insert into used_payments (tx_hash, user_id, pay_chain, asset, amount) values ($1, $2, $3, $4, $5) on conflict do nothing",
    [cleanHash.toLowerCase(), userId, chainName, verdict.asset, verdict.amount],
  );
  await database.query(
    "update member_access set paid_until = $1, last_tx = $2 where user_id = $3",
    [newPaidUntil, cleanHash, userId],
  );

  return [
    `Payment verified!`,
    `Received: $${verdict.amount} ${verdict.asset} on ${chainName.toUpperCase()}.`,
    `Access extended by 30 days.`,
    `Active until: ${new Date(newPaidUntil).toUTCString()}`,
    `You can now tap Add key and Add token.`,
  ].join("\n");
}

async function savedLines(userId) {
  const database = await db();
  if (!database) return "No vault is connected yet, so a key cannot be kept.";
  const access = await getOrCreateMemberAccess(userId);
  const settings = await getMemberSettings(userId);
  const isPaid = access?.paid_until && new Date(access.paid_until).getTime() > Date.now();

  const wallets = await database.query("select chain, address, wrapped from tg_wallets where user_id = $1 order by chain", [userId]);
  const tokens = await database.query("select chain, token, symbol from tg_tokens where user_id = $1 order by chain", [userId]);

  if (!wallets.rows.length && !tokens.rows.length) {
    const memoLine = access?.memo ? `Your payment memo: ${access.memo} (send /pay for details).` : "";
    return ["No wallet is saved for this Telegram account yet. Tap Add key.", memoLine].filter(Boolean).join("\n");
  }

  const statusLine = settings.paused ? "Paused." : "Running on its own.";
  const accessLine = isPaid
    ? `Access: Active until ${new Date(access.paid_until).toUTCString()}.`
    : `Access: Unpaid or expired. Send /pay to activate ($20/30 days, Memo: ${access?.memo || ""}).`;

  const intervalLine = `Interval: ${settings.interval || "30m"}. Size rotates: $5, $8, $6, $7, $7.50, $9.`;
  const mins = Math.max(0, Math.ceil(((Number(settings.next_recheck_ms) || 0) - Date.now()) / 60000));
  const when = settings.paused ? "Trading is paused." : mins <= 0 ? "Next swap is due." : `Next swap in about ${mins} min.`;

  const lines = [statusLine, when, accessLine, intervalLine];

  for (const row of wallets.rows) {
    lines.push(`Wallet (${row.chain}): ${row.address}`);
  }
  for (const row of tokens.rows) {
    lines.push(`Token (${row.chain}): ${row.symbol || ""} ${row.token}`);
  }

  const rhWallet = wallets.rows.find((w) => w.chain === "robinhood");
  const rhToken = tokens.rows.find((t) => t.chain === "robinhood");
  if (rhWallet && rhToken) {
    try {
      const preview = await previewChain({
        address: rhWallet.address,
        token: rhToken.token,
        symbol: rhToken.symbol || "TOKEN",
        decimals: 18,
        pool: null,
        cycleIndex: settings.cycle_index || 0,
      });
      if (preview?.text) lines.push(preview.text);
    } catch {
      /* preview optional */
    }
  }

  if (settings.last_trade_text) {
    lines.push(`Last activity:\n${settings.last_trade_text}`);
  }

  return lines.join("\n");
}

const token = (process.env.TELEGRAM_BOT_TOKEN ?? "").trim();
const admin = (process.env.TELEGRAM_ADMIN_ID ?? "").trim();
if (!token.includes(":")) {
  try {
    fs.mkdirSync("/tmp", { recursive: true });
  } catch {}
  fs.writeFileSync(GATE, JSON.stringify({ telegram: false, paused: false, interval: "" }));
  process.exit(0);
}
writeGate({ paused: readGate().paused === true, interval: readGate().interval || "" });

async function ownerStatus() {
  const gate = readGate();
  if (gate.paused) return "Paused. No new swap will start.";
  try {
    const response = await fetch(`${STATE_URL}?t=${Date.now()}`, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) return "Running on its own. The swap clock could not be read.";
    const state = await response.json();
    const mins = Math.max(0, Math.ceil(((state.nextRecheck ?? 0) - Date.now()) / 60000));
    const when = mins <= 0 ? "Next swap is due." : `Next swap in about ${mins} min.`;
    const lines = ["Running on its own.", when, state.token?.symbol ?? "NASTY", state.token?.address ?? ""];
    if (state.lastPreview) {
      lines.push(state.lastPreview);
    } else if (state.token?.address && state.pool) {
      try {
        const preview = await previewChain({
          address: NASTY_WALLET,
          token: state.token.address,
          symbol: state.token.symbol ?? "NASTY",
          decimals: state.token.decimals ?? 18,
          pool: state.pool,
        });
        if (preview?.text) lines.push(preview.text);
      } catch {
        /* fallback */
      }
    }
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
    "Pay: Send /pay for payment instructions ($20/30 days USDT/USDC on Solana, Base, BNB).",
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
  if (cmd === "/pay") return payInfoText(admin);
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

async function guestCommand(chatId, userId, cmd, arg) {
  if (cmd === "/pause") {
    await updateMemberSettings(userId, { paused: true });
    return "Paused your trading. No new swap will start for your account.";
  }
  if (cmd === "/resume") {
    const settings = await getMemberSettings(userId);
    const intervalSec = INTERVALS_SEC[settings.interval] || 1800;
    await updateMemberSettings(userId, { paused: false, next_recheck_ms: Date.now() + intervalSec * 1000 });
    return `Running again. Next swap waits ${settings.interval || "30m"}.`;
  }
  if (cmd === "/emergency_stop" || cmd === "/stop") {
    await updateMemberSettings(userId, { paused: true });
    return "Stopped your trading. Tap Resume to turn swaps back on.";
  }
  if (cmd === "/interval") {
    if (!INTERVALS.includes(arg)) return "Send /interval 10m, 20m, 30m, or 1h.";
    await updateMemberSettings(userId, { interval: arg });
    return `Interval set to ${arg}.`;
  }
  if (cmd === "/pay") return payInfoText(userId);
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

// Background member swap runner on Railway
let memberLoopRunning = false;
async function checkMemberSwaps() {
  if (memberLoopRunning) return;
  memberLoopRunning = true;
  try {
    const database = await db();
    if (!database) return;
    const now = Date.now();

    // Query active paid members with saved wallets and tokens
    const membersRes = await database.query(`
      select distinct w.user_id, w.chain, w.address, w.wrapped, t.token, t.symbol
      from tg_wallets w
      join tg_tokens t on t.user_id = w.user_id and t.chain = w.chain
      join member_access a on a.user_id = w.user_id
      where a.paid_until is not null and a.paid_until > now()
    `);

    const byUser = new Map();
    for (const row of membersRes.rows) {
      if (admin && row.user_id === admin) continue; // NASTY owner wallet runs on GitHub Actions ONLY!
      if (!byUser.has(row.user_id)) byUser.set(row.user_id, []);
      byUser.get(row.user_id).push(row);
    }

    for (const [userId, items] of byUser.entries()) {
      try {
        const settings = await getMemberSettings(userId);
        if (settings.paused) continue;
        if (settings.next_recheck_ms && now < Number(settings.next_recheck_ms)) continue;

        const intervalSec = INTERVALS_SEC[settings.interval] || 1800;
        const nextRecheck = now + intervalSec * 1000;

        for (const item of items) {
          if (item.chain === "robinhood") {
            let secret = "";
            try {
              secret = unseal(item.wrapped);
            } catch {
              continue;
            }
            if (!secret) continue;

            try {
              const result = await runChainCycle({
                privateKeyHex: secret,
                token: item.token,
                symbol: item.symbol || "TOKEN",
                decimals: 18,
                pool: null,
                cycleIndex: settings.cycle_index || 0,
                walletAddress: item.address,
                onBumpCycleIndex: async (nextIdx) => {
                  await updateMemberSettings(userId, { cycle_index: nextIdx });
                },
              });

              await updateMemberSettings(userId, {
                next_recheck_ms: nextRecheck,
                last_trade_ms: now,
                last_trade_text: result.text,
              });

              if (result.traded) {
                const chatId = Number(userId);
                if (chatId) await send(chatId, result.text).catch(() => {});
              }
            } catch (tradeErr) {
              const errText = tradeErr instanceof Error ? tradeErr.message : "Swap failed";
              await updateMemberSettings(userId, {
                next_recheck_ms: nextRecheck,
                last_trade_text: errText,
              });
            }
          }
        }
      } catch {
        /* proceed to next member */
      }
    }
  } catch {
    /* loop continues */
  } finally {
    memberLoopRunning = false;
  }
}

setInterval(checkMemberSwaps, 30_000);

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

        // Check if user submitted a payment transaction hash (Solana signature or EVM tx hash)
        const isTxHash = (/^[1-9A-HJ-NP-Za-km-z]{64,128}$/.test(raw) || /^0x[0-9a-fA-F]{64}$/.test(raw)) && !mapped.startsWith("/");
        if (isTxHash) {
          const paymentResult = await verifyPayment(userId, raw);
          await send(chatId, paymentResult);
          continue;
        }

        if (mapped.startsWith("/pay") && mapped.split(/\s+/).length > 1) {
          const txArg = mapped.split(/\s+/)[1];
          const paymentResult = await verifyPayment(userId, txArg);
          await send(chatId, paymentResult);
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
        const reply = isAdmin && cmd !== "/help" && cmd !== "/start" ? await ownerReply(cmd, arg) : isAdmin ? await ownerReply(cmd, arg) : await guestCommand(chatId, userId, cmd, arg);
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
