import { createCipheriv, createDecipheriv, randomBytes, randomUUID, scryptSync } from "node:crypto";
import fs from "node:fs";
import bs58 from "bs58";
import { ethers, Wallet } from "ethers";
import pg from "pg";
import nacl from "tweetnacl";
import { privateKeyToAddress } from "@stacks/transactions";
import { lookupPayment } from "../src/lib/members/pay.ts";
import { clearRecovery, previewChain, runChainCycle } from "../src/lib/chain/cycle.ts";
import { readUnifiedWalletBalances } from "../src/lib/chain/balance-reader.ts";
import { previewSolana, runSolanaCycle } from "../src/lib/chain/solana-cycle.ts";
import { previewStacks, runStacksCycle } from "../src/lib/chain/stacks-cycle.ts";
import { checkTokenInactivity, checkRobinhoodInactivity } from "../src/lib/chain/inactivity.ts";
import { generateUniversalWallet, deriveUniversalWallet } from "../src/lib/members/keys.ts";
import { LightweightDb } from "../src/lib/db/lightweight-db.ts";

process.on("unhandledRejection", (err) => console.error("[telegram-live:unhandledRejection]", err));
process.on("uncaughtException", (err) => console.error("[telegram-live:uncaughtException]", err));

const TRADE_RANGES = ["5-20", "21-50", "51-100", "100+"];
const TRADE_RANGE_LABELS = {
  "5-20": "$5–$20",
  "21-50": "$21–$50",
  "51-100": "$51–$100",
  "100+": "$100+",
};

const GATE = "/tmp/trade-gate.json";
const STATE_URL = "https://raw.githubusercontent.com/oak2005/robinhood-chain-bot/main/data/stillmark-bot.json";
const NASTY_WALLET = "0xdf246e7a947674476c832544f7867aa864c60bd5";

const MENU = {
  keyboard: [
    [{ text: "Status" }, { text: "Balance" }, { text: "Config" }],
    [{ text: "Help" }, { text: "Resume" }, { text: "Pause" }],
    [{ text: "Stop" }, { text: "Interval" }, { text: "Token" }],
    [{ text: "Add token" }, { text: "Add key" }, { text: "Test trade" }],
    [{ text: "Remove key" }, { text: "Pay" }, { text: "Dispute" }],
  ],
  resize_keyboard: true,
  is_persistent: true,
};

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
  "Test trade": "/testtrade",
  "Push test trade": "/testtrade",
  Test: "/testtrade",
  Trade: "/testtrade",
  "Remove key": "/removekey",
  "Remove wallet": "/removekey",
  "Remove token": "/removetoken",
  "Add phrase": "/importphrase",
  "Restore phrase": "/importphrase",
  Pay: "/pay",
  Dispute: "/dispute",
};

const COMMAND_SYNONYMS = {
  status: "/status",
  balance: "/balance",
  bal: "/balance",
  config: "/config",
  cfg: "/config",
  test: "/testtrade",
  testtrade: "/testtrade",
  "test trade": "/testtrade",
  "push test trade": "/testtrade",
  trade: "/testtrade",
  pushtrade: "/testtrade",
  settings: "/config",
  token: "/tokeninfo",
  tokens: "/tokeninfo",
  tokeninfo: "/tokeninfo",
  coin: "/tokeninfo",
  help: "/help",
  start: "/start",
  resume: "/resume",
  pause: "/pause",
  stop: "/emergency_stop",
  emergency_stop: "/emergency_stop",
  interval: "/interval",
  scope: "/interval",
  range: "/interval",
  "add token": "/addtoken",
  addtoken: "/addtoken",
  "add key": "/addkey",
  addkey: "/addkey",
  importkey: "/addkey",
  genwallet: "/genwallet",
  "remove key": "/removekey",
  removekey: "/removekey",
  "remove wallet": "/removekey",
  removewallet: "/removekey",
  "remove token": "/removetoken",
  removetoken: "/removetoken",
  "add phrase": "/importphrase",
  addphrase: "/importphrase",
  "import phrase": "/importphrase",
  importphrase: "/importphrase",
  "wallet phrase": "/importphrase",
  "restore phrase": "/importphrase",
  restorephrase: "/importphrase",
  "restore wallet": "/importphrase",
  restorewallet: "/importphrase",
  "add wallet": "/addkey",
  addwallet: "/addkey",
  pay: "/pay",
  dispute: "/dispute",
  disputes: "/disputes",
  cancel: "/cancel",
};

function normalizeCommand(input) {
  if (!input) return "";
  const trimmed = input.trim();
  if (BUTTONS[trimmed]) return BUTTONS[trimmed];
  const lower = trimmed.toLowerCase();
  if (COMMAND_SYNONYMS[lower]) return COMMAND_SYNONYMS[lower];
  if (trimmed.startsWith("/")) return trimmed;
  const parts = trimmed.split(/\s+/);
  const firstLower = parts[0]?.toLowerCase();
  if (COMMAND_SYNONYMS[firstLower]) {
    return `${COMMAND_SYNONYMS[firstLower]} ${parts.slice(1).join(" ")}`.trim();
  }
  return trimmed;
}

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
  const next = { telegram: true, ...readGate(), ...patch };
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
  if (trimmed.split(/\s+/).length >= 12) {
    const universal = deriveUniversalWallet(trimmed);
    return universal.wallets[chain].address;
  }
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
let poolConnecting = null;
let lightweightDbInstance = null;
let lastDbErrTime = 0;
let dbBackendName = "";

async function initDbTables(client) {
  await client.query(`create table if not exists tg_wallets (
    user_id text not null,
    chain text not null,
    address text not null,
    wrapped text not null,
    primary key (user_id, chain)
  )`);
  await client.query(`create table if not exists tg_tokens (
    id text primary key,
    user_id text not null,
    chain text not null,
    token text not null,
    symbol text not null default ''
  )`);
  await client.query(`create table if not exists member_access (
    user_id text primary key,
    memo text not null unique,
    paid_until timestamptz,
    last_tx text not null default ''
  )`);
  await client.query(`create table if not exists used_payments (
    tx_hash text primary key,
    user_id text not null,
    pay_chain text not null,
    asset text not null,
    amount text not null
  )`);
  await client.query(`create table if not exists member_settings (
    user_id text primary key,
    paused boolean not null default false,
    interval text not null default '30m',
    trade_range text not null default '5-20',
    cycle_index int not null default 0,
    next_recheck_ms bigint not null default 0,
    last_trade_ms bigint not null default 0,
    last_trade_text text not null default ''
  )`);
  try {
    await client.query(`alter table member_settings add column if not exists trade_range text not null default '5-20'`);
  } catch {}
  await client.query(`create table if not exists payment_disputes (
    id text primary key,
    user_id text not null,
    tx_hash text not null,
    chain text not null,
    user_note text not null default '',
    status text not null default 'pending',
    admin_note text not null default '',
    created_at timestamptz not null default now(),
    resolved_at timestamptz
  )`);
}

async function getLightweightFallback() {
  if (lightweightDbInstance) return lightweightDbInstance;
  try {
    const storePath = process.env.DATA_DIR ? `${process.env.DATA_DIR}/bot-store.json` : "./data/bot-store.json";
    const instance = new LightweightDb(storePath);
    await initDbTables(instance);
    lightweightDbInstance = instance;
    dbBackendName = "Lightweight Store";
    console.log(`[db] Lightweight JSON Store initialized successfully at ${storePath}.`);
    return lightweightDbInstance;
  } catch (err) {
    console.warn("[db] Lightweight Store initialization notice:", err?.message || err);
    return null;
  }
}

async function db() {
  const url = (process.env.DATABASE_URL ?? "").trim();
  if (pool) return pool;

  // Try remote PostgreSQL first if configured
  if (url && (url.startsWith("postgres://") || url.startsWith("postgresql://"))) {
    if (poolConnecting) return await poolConnecting;
    try {
      poolConnecting = (async () => {
        const isInternalRailway = url.includes("railway.internal") || url.includes("localhost") || url.includes("127.0.0.1");
        const p = new pg.Pool({
          connectionString: url,
          max: 4,
          connectionTimeoutMillis: 5000,
          ssl: isInternalRailway ? false : (url.includes("sslmode=require") || url.includes("neon.tech") ? { rejectUnauthorized: false } : false),
        });
        await p.query("select 1");
        await initDbTables(p);
        pool = p;
        dbBackendName = "Remote PostgreSQL";
        console.log("[db] Remote PostgreSQL connected successfully.");
        return pool;
      })();
      const res = await poolConnecting;
      poolConnecting = null;
      return res;
    } catch (err) {
      poolConnecting = null;
      const now = Date.now();
      if (now - lastDbErrTime > 30000) {
        console.warn("[db] Remote PostgreSQL failed (" + (err?.message || err) + "). Falling back to resilient embedded database.");
        lastDbErrTime = now;
      }
    }
  }

  // Resilient fallback: zero-memory, persistent, immune to WASM OOM crashes
  return await getLightweightFallback();
}

async function getOrCreateMemberAccess(userId) {
  try {
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
  } catch (err) {
    console.error("[getOrCreateMemberAccess] db error:", err?.message || err);
    return null;
  }
}

async function getMemberSettings(userId) {
  const fallback = { paused: false, interval: "30m", trade_range: "5-20", cycle_index: 0, next_recheck_ms: 0, last_trade_text: "" };
  try {
    const database = await db();
    if (!database) return fallback;
    const res = await database.query("select * from member_settings where user_id = $1", [userId]);
    if (res.rows.length > 0) return { trade_range: "5-20", ...res.rows[0] };
    await database.query("insert into member_settings (user_id) values ($1) on conflict do nothing", [userId]);
    return fallback;
  } catch (err) {
    console.error("[getMemberSettings] db error:", err?.message || err);
    return fallback;
  }
}

async function updateMemberSettings(userId, patch) {
  try {
    const database = await db();
    if (!database) return;
    const current = await getMemberSettings(userId);
    const next = { ...current, ...patch };
    await database.query(
      `insert into member_settings (user_id, paused, interval, trade_range, cycle_index, next_recheck_ms, last_trade_ms, last_trade_text)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       on conflict (user_id) do update set
         paused = excluded.paused,
         interval = excluded.interval,
         trade_range = excluded.trade_range,
         cycle_index = excluded.cycle_index,
         next_recheck_ms = excluded.next_recheck_ms,
         last_trade_ms = excluded.last_trade_ms,
         last_trade_text = excluded.last_trade_text`,
      [userId, next.paused, next.interval, next.trade_range || "5-20", next.cycle_index, next.next_recheck_ms, next.last_trade_ms, next.last_trade_text],
    );
  } catch (err) {
    console.error("[updateMemberSettings] db error:", err?.message || err);
  }
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
    "Accepted tokens: USDT, USDC, or USDG (minimum $20)",
    "",
    "Solana deposit (USDT/USDC):",
    "GLrFg8GR7iNotxJRvVHakdbhpRHjEEe8EHXVmjHxNG1T",
    "",
    "Base / BNB deposit (USDT/USDC) & Robinhood Chain deposit (USDG):",
    "0x4a543eEbBB5DFaA2FE0E4f36E84b0eaf5803D7DD",
    "",
    "After sending, paste your transaction hash in this chat to activate.",
  ].join("\n");
}

async function raiseDisputeEntry(userId, txHash, userNote = "") {
  const database = await db();
  if (!database) return { text: "Database is not connected. Cannot submit dispute." };
  const cleanHash = txHash.trim();
  const isSolana = /^[1-9A-HJ-NP-Za-km-z]{64,128}$/.test(cleanHash);
  const isEvm = /^0x[0-9a-fA-F]{64}$/.test(cleanHash);
  if (!isSolana && !isEvm) {
    return { text: "That does not look like a valid Solana signature or EVM transaction hash." };
  }
  const chainName = isSolana ? "solana" : "evm";

  const used = await database.query("select tx_hash from used_payments where tx_hash = $1", [cleanHash.toLowerCase()]);
  if (used.rows.length > 0) {
    return { text: "That transaction hash has already been credited." };
  }

  const existing = await database.query(
    "select id, status from payment_disputes where lower(tx_hash) = $1 and status = 'pending'",
    [cleanHash.toLowerCase()],
  );
  if (existing.rows.length > 0) {
    return { text: `A dispute for this transaction is already pending admin review (Dispute #${existing.rows[0].id}).` };
  }

  const disputeId = `disp_${randomUUID().slice(0, 8)}`;
  await database.query(
    "insert into payment_disputes (id, user_id, tx_hash, chain, user_note, status) values ($1, $2, $3, $4, $5, 'pending')",
    [disputeId, userId, cleanHash, chainName, userNote.slice(0, 500)],
  );

  if (admin) {
    const explorer = isSolana
      ? `https://solscan.io/tx/${cleanHash}`
      : `https://basescan.org/tx/${cleanHash}`;
    const adminText = [
      `🚨 *NEW TRANSACTION DISPUTE* #${disputeId}`,
      `User ID: \`${userId}\``,
      `Tx: \`${cleanHash}\``,
      `Chain: ${chainName.toUpperCase()}`,
      `Explorer: ${explorer}`,
      userNote ? `User Note: ${userNote}` : "",
      "",
      "Tap below to accept or reject:",
    ].filter(Boolean).join("\n");

    const adminMarkup = {
      inline_keyboard: [
        [
          { text: "✅ Accept & Credit 30d", callback_data: `dispute:accept:${disputeId}` },
          { text: "❌ Reject", callback_data: `dispute:reject:${disputeId}` },
        ],
      ],
    };
    await send(Number(admin), adminText, adminMarkup).catch(() => {});
  }

  return {
    text: [
      `Transaction dispute submitted! (ID: #${disputeId})`,
      `Tx: ${cleanHash}`,
      "",
      "Your transaction has been sent to the admin portal for verification.",
      "The admin will review and either accept or reject your dispute.",
      "You will receive a notification in this chat as soon as it is processed.",
    ].join("\n"),
  };
}

async function resolveDisputeEntry(disputeId, action, adminNote = "") {
  const database = await db();
  if (!database) return "Database not connected.";
  const res = await database.query("select * from payment_disputes where id = $1", [disputeId]);
  if (!res.rows.length) return `Dispute #${disputeId} not found.`;
  const dispute = res.rows[0];
  if (dispute.status !== "pending") return `Dispute #${disputeId} was already resolved as ${dispute.status.toUpperCase()}.`;

  const note = adminNote.trim() || (action === "accept" ? "Approved by admin" : "Rejected by admin");

  if (action === "accept") {
    const access = await getOrCreateMemberAccess(dispute.user_id);
    const current = access?.paid_until && new Date(access.paid_until).getTime() > Date.now()
      ? new Date(access.paid_until).getTime()
      : Date.now();
    const newPaidUntil = new Date(current + 30 * 24 * 60 * 60 * 1000).toISOString();

    await database.query(
      "insert into used_payments (tx_hash, user_id, pay_chain, asset, amount) values ($1, $2, $3, $4, $5) on conflict do nothing",
      [dispute.tx_hash.toLowerCase(), dispute.user_id, dispute.chain, "MANUAL_APPROVAL", "20.00"],
    );
    await database.query(
      "update member_access set paid_until = $1, last_tx = $2 where user_id = $3",
      [newPaidUntil, dispute.tx_hash, dispute.user_id],
    );
    await database.query(
      "update payment_disputes set status = 'accepted', admin_note = $1, resolved_at = now() where id = $2",
      [note, disputeId],
    );

    const userChatId = Number(dispute.user_id);
    if (userChatId) {
      await send(
        userChatId,
        [
          `🎉 Your payment dispute #${disputeId} has been ACCEPTED by the admin!`,
          `Transaction: ${dispute.tx_hash}`,
          `Access extended by 30 days.`,
          `Active until: ${new Date(newPaidUntil).toUTCString()}`,
          "You can now tap Add key and Add token.",
        ].join("\n"),
      ).catch(() => {});
    }

    return `✅ Dispute #${disputeId} ACCEPTED. 30 days credited to user ${dispute.user_id}.`;
  } else {
    await database.query(
      "update payment_disputes set status = 'rejected', admin_note = $1, resolved_at = now() where id = $2",
      [note, disputeId],
    );

    const userChatId = Number(dispute.user_id);
    if (userChatId) {
      await send(
        userChatId,
        [
          `❌ Your payment dispute #${disputeId} was REJECTED by the admin.`,
          `Transaction: ${dispute.tx_hash}`,
          `Reason: ${note}`,
        ].join("\n"),
      ).catch(() => {});
    }

    return `❌ Dispute #${disputeId} REJECTED.`;
  }
}

async function listDisputes() {
  const database = await db();
  if (!database) return "Database not connected.";
  const res = await database.query(
    "select id, user_id, tx_hash, chain, user_note, status, created_at from payment_disputes where status = 'pending' order by created_at desc limit 10",
  );
  if (!res.rows.length) return "No pending disputes at this time.";
  return [
    `Pending Disputes (${res.rows.length}):`,
    "",
    ...res.rows.map((d) => `• #${d.id} | User: ${d.user_id} | ${d.chain.toUpperCase()} | Tx: ${d.tx_hash.slice(0, 10)}…\n  Note: ${d.user_note || "None"}\n  To resolve: /accept ${d.id} or /reject ${d.id}`),
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
    return "That does not look like a valid Solana signature or Base/BNB/Robinhood transaction hash.";
  }

  const used = await database.query("select tx_hash from used_payments where tx_hash = $1", [cleanHash.toLowerCase()]);
  if (used.rows.length > 0) {
    return "That transaction hash has already been used. Each transaction can only be used once.";
  }

  let verdict;
  let chainName = isSolana ? "solana" : "base";
  try {
    if (isSolana) {
      verdict = await lookupPayment("solana", cleanHash);
    } else {
      verdict = await lookupPayment("base", cleanHash);
      if (!verdict.ok && (verdict.error.includes("not found") || verdict.error.includes("did not send"))) {
        const bscVerdict = await lookupPayment("bsc", cleanHash);
        if (bscVerdict.ok || !bscVerdict.error.includes("not found")) {
          verdict = bscVerdict;
          chainName = "bsc";
        } else {
          const rhVerdict = await lookupPayment("robinhood", cleanHash);
          if (rhVerdict.ok || !rhVerdict.error.includes("not found")) {
            verdict = rhVerdict;
            chainName = "robinhood";
          }
        }
      }
    }
  } catch (error) {
    return {
      text: [
        `Payment check failed: ${error instanceof Error ? error.message : "Error contacting chain RPC."}`,
        "",
        "If you already sent funds, you can raise a dispute to send it to the admin portal:",
        `/dispute ${cleanHash}`,
      ].join("\n"),
      reply_markup: {
        inline_keyboard: [[{ text: "⚠️ Raise Dispute to Admin", callback_data: `dispute:raise:${cleanHash}` }]],
      },
    };
  }

  if (!verdict.ok) {
    return {
      text: [
        `Payment rejected: ${verdict.error}`,
        "",
        "If you already sent funds and believe this is an error, you can raise a dispute to send it to the admin portal for verification:",
        `/dispute ${cleanHash}`,
      ].join("\n"),
      reply_markup: {
        inline_keyboard: [[{ text: "⚠️ Raise Dispute to Admin", callback_data: `dispute:raise:${cleanHash}` }]],
      },
    };
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
    `Received: $${verdict.amount} ${verdict.asset} on ${chainName === "robinhood" ? "Robinhood Chain" : chainName.toUpperCase()}.`,
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
    return "No wallet is saved for this Telegram account yet. Send /pay to activate, then tap Add key.";
  }

  const statusLine = settings.paused ? "Paused." : "Running on its own.";
  const accessLine = isPaid
    ? `Access: Active until ${new Date(access.paid_until).toUTCString()}.`
    : "Access: Unpaid or expired. Send /pay to activate ($20/30 days).";

  const rangeLabel = TRADE_RANGE_LABELS[settings.trade_range || "5-20"] || "$5–$20";
  const intervalLine = `Interval: ${settings.interval || "30m"}. Trade Scope: ${rangeLabel} per swap.`;
  const mins = Math.max(0, Math.ceil(((Number(settings.next_recheck_ms) || 0) - Date.now()) / 60000));
  const when = settings.paused ? "Trading is paused." : mins <= 0 ? "Next swap is due." : `Next swap in about ${mins} min.`;

  const lines = [statusLine, when, accessLine, intervalLine];

  for (const tokenRow of tokens.rows) {
    try {
      const intervalSec = INTERVALS_SEC[settings.interval] || 1800;
      const act = await checkTokenInactivity({
        chain: tokenRow.chain,
        token: tokenRow.token,
        intervalSec,
      });
      if (act) {
        if (!act.isInactive) {
          const elapsedM = Math.floor(act.elapsedSec / 60);
          const remainM = Math.ceil(act.remainingSec / 60);
          lines.push(`📊 ${tokenRow.symbol || tokenRow.chain} Activity: ACTIVE (trade ${elapsedM}m ago). Next swap in ~${remainM}m if quiet.`);
        } else {
          lines.push(`📊 ${tokenRow.symbol || tokenRow.chain} Activity: INACTIVE (>= ${Math.floor(intervalSec / 60)}m quiet). Swap is due!`);
        }
      }
    } catch {}
  }

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
        tradeRange: settings.trade_range || "5-20",
      });
      if (preview?.text) lines.push(preview.text);
    } catch {}
  }

  const solWallet = wallets.rows.find((w) => w.chain === "solana");
  const solToken = tokens.rows.find((t) => t.chain === "solana");
  if (solWallet && solToken) {
    try {
      const preview = await previewSolana({
        address: solWallet.address,
        token: solToken.token,
        symbol: solToken.symbol || "SOL_TOKEN",
        cycleIndex: settings.cycle_index || 0,
        tradeRange: settings.trade_range || "5-20",
      });
      if (preview?.text) lines.push(preview.text);
    } catch {}
  }

  const stxWallet = wallets.rows.find((w) => w.chain === "stacks");
  const stxToken = tokens.rows.find((t) => t.chain === "stacks");
  if (stxWallet && stxToken) {
    try {
      const preview = await previewStacks({
        address: stxWallet.address,
        token: stxToken.token,
        symbol: stxToken.symbol || "STX_TOKEN",
        cycleIndex: settings.cycle_index || 0,
        tradeRange: settings.trade_range || "5-20",
      });
      if (preview?.text) lines.push(preview.text);
    } catch {}
  }

  if (settings.last_trade_text) {
    lines.push(`Last activity:\n${settings.last_trade_text}`);
  }

  return lines.join("\n");
}

async function balanceReply(userId) {
  const isOwner = admin && userId === admin;
  const database = await db();

  // Admin view: NASTY token balance + swap clock preview
  if (isOwner) {
    const lines = ["💰 *Owner NASTY Balance*", ""];
    try {
      const response = await fetch(`${STATE_URL}?t=${Date.now()}`, { signal: AbortSignal.timeout(8000) });
      if (response.ok) {
        const state = await response.json();
        const gate = readGate();
        const mins = Math.max(0, Math.ceil(((state.nextRecheck ?? 0) - Date.now()) / 60000));
        const when = mins <= 0 ? "Next swap is due." : `Next swap in about ${mins} min.`;
        lines.push(`🟢 Status: ${gate.paused ? "⏸️ Paused" : "Running on its own"}`);
        lines.push(`⏱️ Swap Clock: ${when}`);
        lines.push(`🗄️ Database: ${dbBackendName || "Connected"}`);
        if (state.token) {
          lines.push(`🪙 Token: ${state.token.symbol} (${state.token.address})`);
        }
        lines.push("");
        // Live chain preview
        if (state.token) {
          try {
            const preview = await previewChain({
              address: NASTY_WALLET,
              token: state.token.address,
              symbol: state.token.symbol ?? "NASTY",
              decimals: state.token.decimals ?? 18,
              pool: state.pool ?? null,
            });
            if (preview?.text) lines.push(preview.text);
          } catch {}
        }
        if (state.lastPreview && !lines.some((l) => l.includes("Balance"))) {
          lines.push(state.lastPreview);
        }
      } else {
        lines.push("Could not read public state. GitHub may be rate-limiting.");
      }
    } catch (err) {
      lines.push(`State fetch failed: ${err instanceof Error ? err.message : "Network error"}`);
    }
    return {
      text: lines.join("\n"),
      reply_markup: { inline_keyboard: [[{ text: "🔄 Refresh", callback_data: "action:balance" }]] },
    };
  }

  if (!database) {
    return {
      text: [
        "💰 *Wallet & Token Balances*",
        "",
        "⚠️ Local database is starting up.",
        "Please try again in a moment.",
      ].join("\n"),
    };
  }

  const access = await getOrCreateMemberAccess(userId);
  const settings = await getMemberSettings(userId);
  const isPaid = access?.paid_until && new Date(access.paid_until).getTime() > Date.now();

  const wallets = await database.query("select chain, address from tg_wallets where user_id = $1 order by chain", [userId]);
  const tokens = await database.query("select id, chain, token, symbol from tg_tokens where user_id = $1 order by chain", [userId]);

  if (!wallets.rows.length) {
    return {
      text: [
        "💰 *Wallet & Token Balances*",
        "",
        "No wallet is saved for this Telegram account yet.",
        "Send /pay to activate, then tap Add key to store a fresh wallet.",
      ].join("\n"),
      reply_markup: {
        inline_keyboard: [[{ text: "🔑 Add Key", callback_data: "action:addkey" }]],
      },
    };
  }

  const mins = Math.max(0, Math.ceil(((Number(settings.next_recheck_ms) || 0) - Date.now()) / 60000));
  const statusLine = settings.paused ? "⏸️ Status: Paused" : "🟢 Status: Active (Running on its own)";
  const whenLine = settings.paused ? "Trading is paused." : mins <= 0 ? "Next swap is due." : `Next swap in about ${mins} min.`;
  const accessLine = isPaid
    ? `Access: Active until ${new Date(access.paid_until).toUTCString()}`
    : "Access: Inactive / Expired. Send /pay to activate ($20/30 days).";

  const lines = [
    "💰 *Live Wallet & Token Balances*",
    statusLine,
    whenLine,
    accessLine,
    "",
  ];

  for (const w of wallets.rows) {
    const chainTokens = tokens.rows.filter((t) => t.chain === w.chain);
    lines.push(`👛 *Wallet (${w.chain.toUpperCase()}):*`);
    lines.push(`Address: \`${w.address}\``);

    try {
      const bal = await readUnifiedWalletBalances(w.chain, w.address, chainTokens);
      const nativeUsd = bal.nativeBalanceUsd ? ` ($${bal.nativeBalanceUsd.toFixed(2)})` : "";
      lines.push(`• Gas: *${bal.nativeAmount} ${bal.nativeSymbol}*${nativeUsd}`);

      if (bal.tokens.length > 0) {
        for (const tb of bal.tokens) {
          const usdVal = tb.balanceUsd != null ? ` ($${tb.balanceUsd.toFixed(2)})` : "";
          lines.push(`• Token: *${tb.amount} ${tb.symbol}*${usdVal}`);
          lines.push(`  Address: \`${tb.tokenAddress}\``);
        }
      } else {
        lines.push(`  (No tokens added for ${w.chain}. Tap Add token.)`);
      }
    } catch (err) {
      lines.push(`  Balance lookup: ${err instanceof Error ? err.message : "RPC busy"}`);
    }
    lines.push("");
  }

  return {
    text: lines.join("\n"),
    reply_markup: {
      inline_keyboard: [
        [
          { text: "🔄 Refresh Balance", callback_data: "action:balance" },
          { text: "🪙 View Tokens", callback_data: "action:token" },
        ],
      ],
    },
  };
}

async function configReply(userId, isAdmin) {
  const gate = readGate();
  const database = await db();

  // Admin fallback: read from gate + public state file when no DB is configured
  if (!database && isAdmin) {
    const isPaused = gate.paused === true;
    const currentInterval = gate.interval || "30m";
    const currentRange = gate.trade_range || "5-20";
    const rangeLabel = TRADE_RANGE_LABELS[currentRange] || currentRange;
    let when = "Fetching swap clock...";
    let lastPreview = "";
    try {
      const response = await fetch(`${STATE_URL}?t=${Date.now()}`, { signal: AbortSignal.timeout(8000) });
      if (response.ok) {
        const state = await response.json();
        const mins = Math.max(0, Math.ceil(((state.nextRecheck ?? 0) - Date.now()) / 60000));
        when = isPaused ? "Trading is paused." : mins <= 0 ? "Next swap is due." : `Next swap in about ${mins} min.`;
        lastPreview = state.lastPreview || "";
      }
    } catch {}

    const lines = [
      "⚙️ *Inactivity Trade Configuration*",
      "",
      `• Bot Status: ${isPaused ? "⏸️ Paused (No new swaps)" : "🟢 Active (Running on its own)"}`,
      `• Quiet Interval: *${currentInterval}* between cycles`,
      `• Trade Scope: *${rangeLabel}* per swap clip`,
      `• Swap Clock: ${when}`,
    ];
    if (lastPreview) {
      lines.push("");
      lines.push(lastPreview);
    }
    lines.push("");
    lines.push(`• Database: \`${dbBackendName || "Connected"}\``);
    lines.push("Tap below to adjust interval, trade scope, or pause/resume:");

    const keyboard = {
      inline_keyboard: [
        [
          { text: currentInterval === "10m" ? "✅ 10m" : "10m", callback_data: "interval:10m" },
          { text: currentInterval === "20m" ? "✅ 20m" : "20m", callback_data: "interval:20m" },
          { text: currentInterval === "30m" ? "✅ 30m" : "30m", callback_data: "interval:30m" },
          { text: currentInterval === "1h" ? "✅ 1h" : "1h", callback_data: "interval:1h" },
        ],
        [
          { text: currentRange === "5-20" ? "✅ $5–$20" : "$5–$20", callback_data: "range:5-20" },
          { text: currentRange === "21-50" ? "✅ $21–$50" : "$21–$50", callback_data: "range:21-50" },
        ],
        [
          { text: currentRange === "51-100" ? "✅ $51–$100" : "$51–$100", callback_data: "range:51-100" },
          { text: currentRange === "100+" ? "✅ $100+" : "$100+", callback_data: "range:100+" },
        ],
        [
          isPaused
            ? { text: "▶️ Resume Trading", callback_data: "action:resume" }
            : { text: "⏸️ Pause Trading", callback_data: "action:pause" },
          { text: "🔄 Refresh Config", callback_data: "action:config" },
        ],
      ],
    };
    return { text: lines.join("\n"), reply_markup: keyboard };
  }

  if (!database) {
    return {
      text: [
        "⚙️ *Trade Configuration*",
        "",
        "⚠️ Local database is starting up.",
        "Please try again in a moment.",
      ].join("\n"),
    };
  }

  const settings = await getMemberSettings(userId);

  const isPaused = isAdmin ? gate.paused === true : settings.paused === true;
  const currentInterval = isAdmin ? (gate.interval || "30m") : (settings.interval || "30m");

  const wallets = await database.query("select chain, address from tg_wallets where user_id = $1 order by chain", [userId]);
  const tokens = await database.query("select id, chain, token, symbol from tg_tokens where user_id = $1 order by chain", [userId]);

  const mins = Math.max(0, Math.ceil(((Number(settings.next_recheck_ms) || 0) - Date.now()) / 60000));
  const when = isPaused ? "Trading is paused." : mins <= 0 ? "Next swap is due." : `Next swap in about ${mins} min.`;

  const currentRange = isAdmin ? (gate.trade_range || settings.trade_range || "5-20") : (settings.trade_range || "5-20");
  const rangeLabel = TRADE_RANGE_LABELS[currentRange] || currentRange;

  const lines = [
    "⚙️ *Inactivity Trade Configuration*",
    "",
    `• Bot Status: ${isPaused ? "⏸️ Paused (No new swaps)" : "🟢 Active (Running on its own)"}`,
    `• Quiet Interval: *${currentInterval}* between cycles`,
    `• Trade Scope: *${rangeLabel}* per swap clip (respects bag balance)`,
    `• Cycle Index: #${settings.cycle_index || 0}`,
    `• Swap Clock: ${when}`,
    `• Saved Wallets: ${wallets.rows.length}`,
    `• Saved Tokens: ${tokens.rows.length}/3`,
    `• Database: \`${dbBackendName || "Connected"}\``,
  ];

  if (settings.last_trade_text) {
    lines.push("");
    lines.push(`*Last Activity:*`);
    lines.push(settings.last_trade_text);
  }

  lines.push("");
  lines.push("Tap below to adjust interval, trade scope, or pause/resume:");

  const keyboard = {
    inline_keyboard: [
      [
        { text: currentInterval === "10m" ? "✅ 10m" : "10m", callback_data: "interval:10m" },
        { text: currentInterval === "20m" ? "✅ 20m" : "20m", callback_data: "interval:20m" },
        { text: currentInterval === "30m" ? "✅ 30m" : "30m", callback_data: "interval:30m" },
        { text: currentInterval === "1h" ? "✅ 1h" : "1h", callback_data: "interval:1h" },
      ],
      [
        { text: currentRange === "5-20" ? "✅ $5–$20" : "$5–$20", callback_data: "range:5-20" },
        { text: currentRange === "21-50" ? "✅ $21–$50" : "$21–$50", callback_data: "range:21-50" },
      ],
      [
        { text: currentRange === "51-100" ? "✅ $51–$100" : "$51–$100", callback_data: "range:51-100" },
        { text: currentRange === "100+" ? "✅ $100+" : "$100+", callback_data: "range:100+" },
      ],
      [
        isPaused
          ? { text: "▶️ Resume Trading", callback_data: "action:resume" }
          : { text: "⏸️ Pause Trading", callback_data: "action:pause" },
        { text: "🪙 Manage Tokens", callback_data: "action:token" },
      ],
      [
        { text: "💰 Live Balances", callback_data: "action:balance" },
        { text: "🔄 Refresh Config", callback_data: "action:config" },
      ],
    ],
  };

  return {
    text: lines.join("\n"),
    reply_markup: keyboard,
  };
}

async function tokenReply(userId) {
  const isAdmin = admin && userId === admin;
  let activeTokenHeader = "";

  if (isAdmin) {
    try {
      const response = await fetch(`${STATE_URL}?t=${Date.now()}`, { signal: AbortSignal.timeout(5000) });
      if (response.ok) {
        const state = await response.json();
        if (state.token) {
          activeTokenHeader = `🪙 *Admin Active Token:* ${state.token.symbol || "NASTY"}\nContract: \`${state.token.address}\`\n\n`;
        }
      }
    } catch {}
  }

  let tokens = { rows: [] };
  try {
    const database = await db();
    if (database) {
      tokens = await database.query("select id, chain, token, symbol from tg_tokens where user_id = $1 order by chain", [userId]);
    }
  } catch (err) {
    console.error("[tokenReply] db error:", err?.message || err);
  }

  if (!tokens.rows.length) {
    return {
      text: [
        activeTokenHeader,
        "🪙 *Token Management*",
        "",
        "No additional tokens are currently saved for this account.",
        "You can add up to 3 tokens to trade on Solana, Stacks, or Robinhood.",
        "",
        "Tap Add token below to add a coin address:",
      ].filter(Boolean).join("\n"),
      reply_markup: {
        inline_keyboard: [
          [{ text: "➕ Add Token", callback_data: "action:addtoken" }],
          [{ text: "🔄 Refresh", callback_data: "action:token" }],
        ],
      },
    };
  }

  const lines = [
    `🪙 *Active Trading Tokens (${tokens.rows.length}/3)*`,
    "",
    "Below are the tokens configured for your account.",
    "Tap any ❌ button below to remove that specific token:",
    "",
  ];

  const inlineButtons = [];

  for (let i = 0; i < tokens.rows.length; i++) {
    const t = tokens.rows[i];
    const name = t.symbol || "TOKEN";
    const shortAddr = t.token.length > 12 ? `${t.token.slice(0, 6)}…${t.token.slice(-4)}` : t.token;
    lines.push(`${i + 1}. *${name}* on *${t.chain.toUpperCase()}*`);
    lines.push(`   Address: \`${t.token}\``);

    inlineButtons.push([
      {
        text: `❌ Remove ${name} (${shortAddr})`,
        callback_data: `token:remove:${t.id}`,
      },
    ]);
  }

  const actionRow = [];
  if (tokens.rows.length < 3) {
    actionRow.push({ text: "➕ Add Token", callback_data: "action:addtoken" });
  }
  actionRow.push({ text: "🔄 Refresh", callback_data: "action:token" });
  inlineButtons.push(actionRow);
  inlineButtons.push([{ text: "🧪 Push Test Trade Across All", callback_data: "action:testtrade" }]);

  return {
    text: lines.join("\n"),
    reply_markup: { inline_keyboard: inlineButtons },
  };
}

async function removeTokenById(userId, tokenId) {
  const database = await db();
  if (!database) return { ok: false, error: "Database not connected." };
  const res = await database.query(
    "delete from tg_tokens where id = $1 and user_id = $2 returning token, symbol, chain",
    [tokenId, userId],
  );
  if (!res.rows.length) {
    const byAddr = await database.query(
      "delete from tg_tokens where (lower(token) = lower($1) or lower(symbol) = lower($1)) and user_id = $2 returning token, symbol, chain",
      [tokenId, userId],
    );
    if (byAddr.rows.length) {
      return { ok: true, deleted: byAddr.rows[0] };
    }
    return { ok: false, error: "Token not found or already removed." };
  }
  return { ok: true, deleted: res.rows[0] };
}

async function removeTokenCommand(userId, arg) {
  if (!arg) {
    return tokenReply(userId);
  }
  const res = await removeTokenById(userId, arg.trim());
  if (!res.ok) {
    const current = await tokenReply(userId);
    return {
      text: `Could not find token "${arg}".\n\n${current.text}`,
      reply_markup: current.reply_markup,
    };
  }
  const reply = await tokenReply(userId);
  return {
    text: `✅ Removed token ${res.deleted.symbol || res.deleted.token} on ${res.deleted.chain}.\n\n${reply.text}`,
    reply_markup: reply.reply_markup,
  };
}

function getBotToken() {
  let t = (process.env.TELEGRAM_BOT_TOKEN ?? "").trim().replace(/^["']|["']$/g, "");
  if (!t.includes(":")) {
    for (const secretPath of ["/workspace/.secrets/telegram_bot_token", ".secrets/telegram_bot_token", "../.secrets/telegram_bot_token"]) {
      try {
        const fileContent = fs.readFileSync(secretPath, "utf8").trim().replace(/^["']|["']$/g, "");
        if (fileContent.includes(":")) {
          t = fileContent;
          break;
        }
      } catch {}
    }
  }
  return t;
}

function getAdminId() {
  let a = (process.env.TELEGRAM_ADMIN_ID ?? "").trim().replace(/^["']|["']$/g, "");
  if (!a) {
    for (const secretPath of ["/workspace/.secrets/telegram_admin_id", ".secrets/telegram_admin_id", "../.secrets/telegram_admin_id"]) {
      try {
        const fileContent = fs.readFileSync(secretPath, "utf8").trim().replace(/^["']|["']$/g, "");
        if (fileContent) {
          a = fileContent;
          break;
        }
      } catch {}
    }
  }
  return a;
}

const HEARTBEAT_FILE = "/tmp/bot-heartbeat.json";
function updateHeartbeat(patch) {
  try {
    fs.mkdirSync("/tmp", { recursive: true });
    let current = {};
    try { current = JSON.parse(fs.readFileSync(HEARTBEAT_FILE, "utf8")); } catch {}
    fs.writeFileSync(HEARTBEAT_FILE, JSON.stringify({ ...current, ...patch, timestamp: Date.now() }));
  } catch {}
}

let token = getBotToken();
let admin = getAdminId();

async function ensureToken() {
  let warnCount = 0;
  while (!token.includes(":")) {
    warnCount++;
    console.error("==================================================================================");
    console.error(`⚠️ [telegram-live] TELEGRAM_BOT_TOKEN IS MISSING IN RAILWAY VARIABLES! (Check #${warnCount})`);
    console.error("----------------------------------------------------------------------------------");
    console.error("The Telegram bot service is running and waiting for your bot token.");
    console.error("How to resolve in Railway:");
    console.error("1. Open Railway -> your project -> robinhood-chain-bot service.");
    console.error("2. Click on the 'Variables' tab.");
    console.error("3. Click 'New Variable' and add:");
    console.error("     TELEGRAM_BOT_TOKEN = <your_bot_token_from_botfather>");
    console.error("     TELEGRAM_ADMIN_ID  = <your_numeric_telegram_user_id>");
    console.error("4. Click 'Deploy Changes'.");
    console.error("==================================================================================");
    updateHeartbeat({
      status: "waiting_for_token",
      error: "TELEGRAM_BOT_TOKEN missing in Railway Variables",
      checkCount: warnCount,
    });
    try {
      fs.mkdirSync("/tmp", { recursive: true });
      fs.writeFileSync(GATE, JSON.stringify({ telegram: false, paused: false, interval: "" }));
    } catch {}
    await new Promise((r) => setTimeout(r, 15000));
    token = getBotToken();
    admin = getAdminId();
  }
}

await ensureToken();

let botUsername = "";
let botId = null;

try {
  const meRes = await fetch(`https://api.telegram.org/bot${token}/getMe`, { signal: AbortSignal.timeout(10000) });
  const meData = await meRes.json();
  if (meData.ok) {
    botUsername = meData.result.username || "";
    botId = meData.result.id || null;
    console.log(`[telegram-live] ✅ Connected to Telegram bot: @${meData.result.username} (ID: ${meData.result.id}, Name: ${meData.result.first_name})`);
    updateHeartbeat({ botUsername: meData.result.username, botId: meData.result.id, status: "ready" });
    writeGate({
      telegram: true,
      tokenValid: true,
      botUsername: meData.result.username,
      botId: meData.result.id,
      paused: readGate().paused === true,
      interval: readGate().interval || "",
      error: null,
    });
  } else {
    const errorDesc = meData.description || "Invalid Telegram Bot Token";
    console.error("==================================================================================");
    console.error(`❌ [telegram-live] TELEGRAM_BOT_TOKEN ERROR: ${errorDesc}`);
    console.error("If you updated TELEGRAM_BOT_TOKEN in GitHub Secrets, remember you MUST also update");
    console.error("it in Railway: Railway Dashboard -> Project -> Variables -> TELEGRAM_BOT_TOKEN!");
    console.error("==================================================================================");
    writeGate({
      telegram: false,
      tokenValid: false,
      error: `Telegram getMe failed: ${errorDesc}`,
      paused: readGate().paused === true,
      interval: readGate().interval || "",
    });
  }
} catch (e) {
  const errorMsg = e?.message || String(e);
  console.warn("[telegram-live] ⚠️ getMe notice:", errorMsg);
  writeGate({
    telegram: false,
    tokenValid: false,
    error: errorMsg,
  });
}

console.log(`[telegram-live] Telegram token check complete (admin: ${admin ? admin : "none"}).`);

function buildTradeInlineMarkup(text, tokenAddress, chain = "robinhood") {
  const sellMatch = (text || "").match(/Sell(?:\s*\n\s*|[\s:]+)([0-9a-zA-Z]{40,90})/i);
  const buyMatch = (text || "").match(/Buy(?:\s*\n\s*|[\s:]+)([0-9a-zA-Z]{40,90})/i);
  const rows = [];
  const txButtons = [];

  const getTxUrl = (hash) => {
    const clean = hash.trim();
    if (chain === "solana") return `https://solscan.io/tx/${clean}`;
    if (chain === "stacks") return `https://explorer.hiro.so/txid/${clean.startsWith("0x") ? clean : "0x" + clean}?chain=mainnet`;
    return `https://robinhoodchain.blockscout.com/tx/${clean.startsWith("0x") ? clean : "0x" + clean}`;
  };

  const getTokenUrl = (addr) => {
    const clean = addr.trim();
    if (chain === "solana") return `https://solscan.io/token/${clean}`;
    if (chain === "stacks") return `https://explorer.hiro.so/token/${clean}?chain=mainnet`;
    return `https://robinhoodchain.blockscout.com/token/${clean}`;
  };

  if (sellMatch) {
    txButtons.push({ text: "🔍 Sell Tx", url: getTxUrl(sellMatch[1]) });
  }
  if (buyMatch) {
    txButtons.push({ text: "🔍 Buy Tx", url: getTxUrl(buyMatch[1]) });
  }
  if (txButtons.length > 0) rows.push(txButtons);
  if (tokenAddress) {
    rows.push([{ text: "📊 Token Explorer", url: getTokenUrl(tokenAddress) }]);
  }
  return rows.length > 0 ? { inline_keyboard: rows } : null;
}

// Configure Telegram Bot Commands Menu & persistent Menu Button
async function setupBotMenu() {
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
    { command: "dispute", description: "Raise transaction dispute for admin review" },
    { command: "help", description: "How to use Inactivity Trade" },
  ];
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const cmdRes = await fetch(`https://api.telegram.org/bot${token}/setMyCommands`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ commands }),
      });
      const cmdData = await cmdRes.json().catch(() => ({}));
      console.log(`[setupBotMenu] setMyCommands attempt ${attempt}: status ${cmdRes.status}`, cmdData);

      const btnRes = await fetch(`https://api.telegram.org/bot${token}/setChatMenuButton`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ menu_button: { type: "commands" } }),
      });
      const btnData = await btnRes.json().catch(() => ({}));
      console.log(`[setupBotMenu] setChatMenuButton attempt ${attempt}: status ${btnRes.status}`, btnData);

      if (cmdRes.status === 429 || btnRes.status === 429) {
        console.warn("[setupBotMenu] Telegram menu rate-limited (429). Skipping menu update.");
        break;
      }

      if (cmdData?.ok && btnData?.ok) {
        writeGate({ menuReady: true });
        break;
      }
    } catch (err) {
      console.error(`[setupBotMenu] attempt ${attempt} error:`, err);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}
setupBotMenu().catch(() => {});

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
    if (state.token?.address) {
      try {
        const intervalSec = INTERVALS_SEC[state.config?.interval || "30m"] || 1800;
        const act = await checkRobinhoodInactivity(state.token.address, intervalSec);
        if (act) {
          if (!act.isInactive) {
            const elapsedM = Math.floor(act.elapsedSec / 60);
            const remainM = Math.ceil(act.remainingSec / 60);
            lines.push(`📊 On-chain Activity: ACTIVE (trade ${elapsedM}m ago). Next swap in ~${remainM}m if quiet.`);
          } else {
            lines.push(`📊 On-chain Activity: INACTIVE (>= ${Math.floor(intervalSec / 60)}m quiet). Swap is due!`);
          }
        }
      } catch {}
    }
    let previewText = "";
    if (state.token?.address) {
      try {
        const preview = await previewChain({
          address: NASTY_WALLET,
          token: state.token.address,
          symbol: state.token.symbol ?? "NASTY",
          decimals: state.token.decimals ?? 18,
          pool: state.pool ?? null,
        });
        if (preview?.text) previewText = preview.text;
      } catch {
        /* fallback */
      }
    }
    if (!previewText && state.lastPreview) {
      previewText = state.lastPreview;
    }
    if (previewText) lines.push(previewText);
    return lines.filter(Boolean).join("\n");
  } catch {
    return "Running on its own. The swap clock could not be read.";
  }
}

function helpText() {
  return [
    "Inactivity Trade — Commands & Buttons",
    "",
    "Status, Balance, Config: Check running status, balance, and next cycle.",
    "Pause, Resume, Stop: Control swap execution.",
    "Interval: Choose between 10m, 20m, 30m, or 1h.",
    "Add key: Store your fresh wallet private key (AES-256 sealed).",
    "Add token: Add a coin contract address (up to 3 tokens).",
    "Test trade: Manually trigger an immediate test trade across all saved tokens/chains.",
    "Remove token: Remove a specific token by clicking its ❌ button.",
    "Remove key: Clear your saved wallets and tokens.",
    "Pay: Access is at least $20/30 days USDT, USDC, or USDG on Solana, Base, BNB, or Robinhood (no memo required).",
    "Dispute: If a transaction needs manual verification, send /dispute <txHash> to submit to admin.",
    "",
    "Everything stays in this chat. Tap buttons below or use the Menu button at the bottom left.",
  ].join("\n");
}

async function intervalReply(userId, isAdmin, arg) {
  const currentSettings = await getMemberSettings(userId);
  const gate = readGate();
  const currentInterval = isAdmin ? (gate.interval || "30m") : (currentSettings.interval || "30m");
  const currentRange = isAdmin ? (gate.trade_range || currentSettings.trade_range || "5-20") : (currentSettings.trade_range || "5-20");

  if (!arg) {
    const keyboard = {
      inline_keyboard: [
        [
          { text: currentInterval === "10m" ? "✅ 10m" : "10m", callback_data: "interval:10m" },
          { text: currentInterval === "20m" ? "✅ 20m" : "20m", callback_data: "interval:20m" },
          { text: currentInterval === "30m" ? "✅ 30m" : "30m", callback_data: "interval:30m" },
          { text: currentInterval === "1h" ? "✅ 1h" : "1h", callback_data: "interval:1h" },
        ],
        [
          { text: currentRange === "5-20" ? "✅ $5–$20" : "$5–$20", callback_data: "range:5-20" },
          { text: currentRange === "21-50" ? "✅ $21–$50" : "$21–$50", callback_data: "range:21-50" },
        ],
        [
          { text: currentRange === "51-100" ? "✅ $51–$100" : "$51–$100", callback_data: "range:51-100" },
          { text: currentRange === "100+" ? "✅ $100+" : "$100+", callback_data: "range:100+" },
        ],
        [{ text: "🔄 Refresh Config", callback_data: "action:config" }],
      ],
    };
    return {
      text: [
        "⚙️ *Trade Interval & Scope*",
        "",
        `⏱️ *Quiet Window:* \`${currentInterval}\` between swaps`,
        `💲 *Trade Scope:* \`${TRADE_RANGE_LABELS[currentRange] || currentRange}\` per cycle`,
        "",
        "• Tap an *Interval* to change swap frequency.",
        "• Tap a *Trade Scope* to select trade dollar bracket (optimizes low fee & spread while respecting wallet balance).",
      ].join("\n"),
      reply_markup: keyboard,
    };
  }

  const rangeVal = arg.startsWith("range:") ? arg.replace("range:", "") : arg;
  if (TRADE_RANGES.includes(rangeVal)) {
    if (isAdmin) {
      writeGate({ trade_range: rangeVal });
    }
    await updateMemberSettings(userId, { trade_range: rangeVal });
    return intervalReply(userId, isAdmin, null);
  }

  const intVal = arg.startsWith("interval:") ? arg.replace("interval:", "") : arg;
  if (INTERVALS.includes(intVal)) {
    if (isAdmin) {
      writeGate({ interval: intVal });
    }
    await updateMemberSettings(userId, { interval: intVal });
    return intervalReply(userId, isAdmin, null);
  }

  return { text: "Send /interval 10m, 20m, 30m, 1h or /range 5-20, 21-50, 51-100, 100+." };
}

async function generateWalletForUser(userId) {
  const database = await db();
  if (!database) return { text: "No database is connected yet. Please wait until the database is ready." };

  const wallet = generateUniversalWallet();
  const wrappedRh = seal(wallet.wallets.robinhood.privateKey);
  const wrappedSol = seal(wallet.wallets.solana.privateKey);
  const wrappedStx = seal(wallet.wallets.stacks.privateKey);

  await database.query(
    `insert into tg_wallets (user_id, chain, address, wrapped) values
     ($1, 'robinhood', $2, $3),
     ($1, 'solana', $4, $5),
     ($1, 'stacks', $6, $7)
     on conflict (user_id, chain) do update set address = excluded.address, wrapped = excluded.wrapped`,
    [
      userId,
      wallet.wallets.robinhood.address,
      wrappedRh,
      wallet.wallets.solana.address,
      wrappedSol,
      wallet.wallets.stacks.address,
      wrappedStx,
    ],
  );

  return {
    text: [
      "✨ *Universal Multi-Chain Wallet Generated!*",
      "",
      "⚠️ *IMPORTANT: Save Your 12-Word Seed Phrase*",
      `\`${wallet.mnemonic}\``,
      "",
      "📝 *Write this down somewhere safe now!* This seed phrase controls your funds on all 3 chains (Robinhood EVM, Solana, and Stacks).",
      "",
      "📥 *Your Multi-Chain Deposit Addresses:*",
      `• *Robinhood Chain (EVM):*`,
      `\`${wallet.wallets.robinhood.address}\``,
      `• *Solana:*`,
      `\`${wallet.wallets.solana.address}\``,
      `• *Stacks:*`,
      `\`${wallet.wallets.stacks.address}\``,
      "",
      "Your wallet is already saved. Deposit the tokens or gas you want to trade to these addresses.",
      "Then tap *Add token* to choose which coin the bot will swap!",
    ].join("\n"),
    reply_markup: {
      inline_keyboard: [
        [
          { text: "🪙 Add Token", callback_data: "action:addtoken" },
          { text: "💰 Live Balances", callback_data: "action:balance" },
        ],
        [{ text: "⚙️ View Config", callback_data: "action:config" }],
      ],
    },
  };
}

async function ownerReply(cmd, arg) {
  if (cmd === "/pause" || cmd === "/emergency_stop" || cmd === "/stop") {
    writeGate({ paused: true });
    return { text: "Paused. No new swap will start." };
  }
  if (cmd === "/resume" || cmd === "/clear_recovery") {
    clearRecovery(NASTY_WALLET);
    writeGate({ paused: false });
    return { text: "Running again. Recovery cleared and next check can swap." };
  }
  if (cmd === "/interval" || cmd === "/range" || cmd === "/scope") {
    return intervalReply(admin, true, arg);
  }
  if (cmd === "/pay") return { text: await payInfoText(admin) };
  if (cmd === "/disputes") return { text: await listDisputes() };
  if (cmd === "/dispute") {
    return {
      text: [
        "To raise a transaction dispute for admin review, send:",
        "/dispute <tx_hash> <optional note>",
        "",
        "Example:",
        "/dispute 0x123...456 sent $20 USDC without memo",
      ].join("\n"),
    };
  }
  if (cmd === "/balance") return balanceReply(admin);
  if (cmd === "/config") return configReply(admin, true);
  if (cmd === "/tokeninfo" || cmd === "/token") return tokenReply(admin);
  if (cmd === "/removetoken") return removeTokenCommand(admin, arg);
  if (cmd === "/testtrade" || cmd === "/test" || cmd === "/trade" || cmd === "/pushtrade") return pushTestTrade(admin, true);
  if (cmd === "/status") return { text: await ownerStatus() };
  if (cmd === "/addkey") return beginKey(admin);
  if (cmd === "/importphrase" || cmd === "/restorephrase" || cmd === "/restorewallet") return beginPhrase(admin);
  if (cmd === "/removekey" || cmd === "/removewallet") return promptRemoveKeys(admin, admin);
  if (cmd === "/help" || cmd === "/start") return { text: `Running on its own.\n\n${helpText()}` };
  return { text: helpText() };
}

async function beginKey(chatId) {
  pending.set(chatId, { step: "wallet-choice" });
  const keyboard = {
    inline_keyboard: [
      [{ text: "✨ Generate Universal Wallet (12 Words)", callback_data: "action:genwallet" }],
      [{ text: "📝 Add Wallet Phrase Back (12-Word Seed)", callback_data: "action:importphrase" }],
      [{ text: "🔑 Import Single Private Key", callback_data: "action:importkey" }],
      [{ text: "Cancel", callback_data: "action:cancel" }],
    ],
  };
  return {
    text: [
      "👛 *Wallet Setup Options*",
      "",
      "Choose an option:",
      "• *Generate Universal Wallet*: Creates a fresh 12-word recovery phrase with new addresses on Robinhood EVM, Solana, and Stacks.",
      "• *Add Wallet Phrase Back*: Restore an existing 12-word seed phrase. Re-connects all 3 chain addresses at once!",
      "• *Import Single Private Key*: Manually paste an individual private key for a single chain.",
    ].join("\n"),
    reply_markup: keyboard,
  };
}

async function beginToken(chatId) {
  pending.set(chatId, { step: "chain-token" });
  const keyboard = {
    inline_keyboard: [
      [
        { text: "Solana", callback_data: "chain:solana" },
        { text: "Stacks", callback_data: "chain:stacks" },
        { text: "Robinhood", callback_data: "chain:robinhood" },
      ],
      [{ text: "Cancel", callback_data: "action:cancel" }],
    ],
  };
  return {
    text: "Which chain is the token on? Tap a button or reply Solana, Stacks, or Robinhood.",
    reply_markup: keyboard,
  };
}

async function beginPhrase(chatId) {
  pending.set(chatId, { step: "phrase" });
  const keyboard = {
    inline_keyboard: [
      [{ text: "❌ Cancel", callback_data: "action:cancel" }],
    ],
  };
  return {
    text: [
      "📝 *Add Your Wallet Phrase Back*",
      "",
      "Please reply with your *12-word seed recovery phrase* separated by spaces.",
      "",
      "Example:",
      "`abandon amount liar wonder cherry apple orange pear summer winter ocean space`",
      "",
      "✨ This will automatically restore your deposit addresses on Robinhood Chain, Solana, and Stacks all at once.",
      "🔒 *Security Note:* Your message will be automatically deleted from this chat immediately after reading.",
      "",
      "Reply /cancel to abort.",
    ].join("\n"),
    reply_markup: keyboard,
  };
}

async function promptRemoveKeys(chatId, userId) {
  const database = await db();
  if (!database) return { text: "No vault or database is connected yet." };
  const wallets = await database.query("select chain, address from tg_wallets where user_id = $1 order by chain", [userId]);
  const tokens = await database.query("select chain, token, symbol from tg_tokens where user_id = $1 order by chain", [userId]);
  if (!wallets.rows.length && !tokens.rows.length) {
    return { text: "ℹ️ No saved wallet or tokens found for this account. Nothing to remove." };
  }

  pending.set(chatId, { step: "confirm-remove-wallet" });
  const keyboard = {
    inline_keyboard: [
      [{ text: "❌ Cancel (Keep Wallet)", callback_data: "action:cancel" }],
    ],
  };

  const walletSummary = wallets.rows.map((w) => `• *${w.chain.toUpperCase()}:* \`${w.address.slice(0, 8)}…${w.address.slice(-6)}\``).join("\n");
  const tokenSummary = tokens.rows.length ? `\n🪙 *Tokens:* ${tokens.rows.map((t) => t.symbol || t.chain).join(", ")}` : "";

  return {
    text: [
      "⚠️ *CONFIRM WALLET REMOVAL*",
      "",
      `You are about to remove your saved wallet and trading tokens:`,
      walletSummary,
      tokenSummary,
      "",
      "🔴 *All stored keys and active tokens will be deleted, and trading will STOP immediately.*",
      "",
      "To prevent accidental removal, please *type and send the word:*",
      "`CONFIRM`",
      "",
      "Or reply /cancel (or tap Cancel below) to keep your wallet safe.",
    ].join("\n"),
    reply_markup: keyboard,
  };
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
  if (!state) return { text: "" };
  if (text === "/cancel" || text === "action:cancel") {
    pending.delete(chatId);
    return { text: "Cancelled." };
  }

  if (state.step === "confirm-remove-wallet") {
    if (text.trim().toUpperCase() === "CONFIRM") {
      pending.delete(chatId);
      const rmResult = await removeKeys(userId);
      return {
        text: [
          `🗑️ ${rmResult}`,
          "",
          "💡 *Did you keep your 12-word seed phrase?*",
          "You can restore your wallet and deposit addresses anytime by tapping *Add key* ➡️ *Add Wallet Phrase Back* (or sending /importphrase).",
        ].join("\n"),
        reply_markup: {
          inline_keyboard: [
            [{ text: "📝 Add Wallet Phrase Back", callback_data: "action:importphrase" }],
            [{ text: "✨ Generate New Wallet", callback_data: "action:genwallet" }],
          ],
        },
      };
    }
    pending.delete(chatId);
    return { text: "❌ Wallet removal cancelled. Your saved wallet and tokens were kept safe." };
  }

  if (state.step === "wallet-choice") {
    if (text === "action:genwallet" || text === "/genwallet") {
      pending.delete(chatId);
      return generateWalletForUser(userId);
    }
    if (text === "action:importphrase" || text === "/importphrase") {
      return beginPhrase(chatId);
    }
    if (text === "action:importkey" || text === "/importkey") {
      state.step = "chain-key";
      const keyboard = {
        inline_keyboard: [
          [
            { text: "Solana", callback_data: "chain:solana" },
            { text: "Stacks", callback_data: "chain:stacks" },
            { text: "Robinhood", callback_data: "chain:robinhood" },
          ],
          [{ text: "Cancel", callback_data: "action:cancel" }],
        ],
      };
      return {
        text: "Which chain? Tap a button or reply Solana, Stacks, or Robinhood. Use a fresh wallet, not the one already trading.",
        reply_markup: keyboard,
      };
    }
  }

  if (state.step === "phrase") {
    const rawPhrase = text.trim().toLowerCase().replace(/\s+/g, " ");
    const words = rawPhrase.split(" ");
    if (words.length !== 12 && words.length !== 24) {
      return {
        text: `⚠️ A recovery seed phrase must have 12 words (or 24 words). You sent ${words.length} words.\n\nPlease check your phrase and try again, or reply /cancel.`,
      };
    }
    const database = await db();
    if (!database) return { text: "No vault or database is connected yet." };

    let wallet;
    try {
      wallet = deriveUniversalWallet(rawPhrase);
    } catch (err) {
      return {
        text: `❌ That seed phrase could not be derived: ${err instanceof Error ? err.message : "Invalid mnemonic"}.\n\nPlease check the spelling and order of your words and try again, or reply /cancel.`,
      };
    }

    const wrappedRh = seal(wallet.wallets.robinhood.privateKey);
    const wrappedSol = seal(wallet.wallets.solana.privateKey);
    const wrappedStx = seal(wallet.wallets.stacks.privateKey);

    await database.query(
      `insert into tg_wallets (user_id, chain, address, wrapped) values
       ($1, 'robinhood', $2, $3),
       ($1, 'solana', $4, $5),
       ($1, 'stacks', $6, $7)
       on conflict (user_id, chain) do update set address = excluded.address, wrapped = excluded.wrapped`,
      [
        userId,
        wallet.wallets.robinhood.address,
        wrappedRh,
        wallet.wallets.solana.address,
        wrappedSol,
        wallet.wallets.stacks.address,
        wrappedStx,
      ],
    );

    pending.delete(chatId);
    return {
      text: [
        "✅ *Wallet Phrase Restored Successfully!*",
        "",
        "Your multi-chain wallet is back and active:",
        `• *Robinhood Chain (EVM):*`,
        `\`${wallet.wallets.robinhood.address}\``,
        `• *Solana:*`,
        `\`${wallet.wallets.solana.address}\``,
        `• *Stacks:*`,
        `\`${wallet.wallets.stacks.address}\``,
        "",
        "Your addresses have been saved. Tap *Add token* to choose which coin to swap!",
      ].join("\n"),
      reply_markup: {
        inline_keyboard: [
          [
            { text: "🪙 Add Token", callback_data: "action:addtoken" },
            { text: "💰 Live Balances", callback_data: "action:balance" },
          ],
          [{ text: "⚙️ View Config", callback_data: "action:config" }],
        ],
      },
    };
  }

  if (state.step === "chain-key" || state.step === "chain-token") {
    const chain = chainOf(text);
    if (!chain) return { text: "Reply Solana, Stacks, or Robinhood." };
    state.chain = chain;
    state.step = state.step === "chain-key" ? "key" : "token";
    return state.step === "key"
      ? { text: "Send the fresh wallet private key (or 12-word seed phrase) in the next message. It will be sealed. Do not send the wallet that is already trading." }
      : { text: `Send the ${state.chain} token coin address.` };
  }
  if (state.step === "key") {
    const database = await db();
    if (!database) return { text: "No vault is connected yet. The key was not stored." };
    let address = "";
    let keyToStore = text.trim();
    try {
      if (keyToStore.split(/\s+/).length >= 12) {
        const universal = deriveUniversalWallet(keyToStore);
        address = universal.wallets[state.chain].address;
        keyToStore = universal.wallets[state.chain].privateKey;
      } else {
        address = derive(state.chain, keyToStore);
      }
    } catch (error) {
      return { text: error instanceof Error ? error.message : "That key could not be read." };
    }
    const wrapped = seal(keyToStore);
    await database.query(
      `insert into tg_wallets (user_id, chain, address, wrapped) values ($1, $2, $3, $4)
       on conflict (user_id, chain) do update set address = excluded.address, wrapped = excluded.wrapped`,
      [userId, state.chain, address, wrapped],
    );
    pending.delete(chatId);
    return { text: `Saved ${state.chain} ${address}. The key is not repeated. Tap Add token for the coin.` };
  }
  const database = await db();
  if (!database) return { text: "No vault is connected yet. The token was not stored." };
  const count = await database.query("select count(*)::int as n from tg_tokens where user_id = $1", [userId]);
  if ((count.rows[0]?.n ?? 0) >= 3) return { text: "Three tokens are already saved. Tap Remove key before adding another account's set." };
  const tokenText = text.trim();
  let symbol = "";
  if (state.chain === "robinhood" && /^0x[0-9a-fA-F]{40}$/.test(tokenText)) {
    try {
      const provider = new ethers.JsonRpcProvider("https://rpc.mainnet.chain.robinhood.com", 4663, { staticNetwork: true });
      const erc20 = new ethers.Contract(tokenText, ["function symbol() view returns (string)"], provider);
      symbol = await Promise.race([erc20.symbol(), new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 3000))]);
    } catch {}
  }
  if (state.chain === "solana" || state.chain === "stacks") {
    try {
      const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${tokenText}`, {
        signal: AbortSignal.timeout(4000),
      });
      if (res.ok) {
        const data = await res.json();
        symbol = data.pairs?.[0]?.baseToken?.symbol || "";
      }
    } catch {}
  }
  await database.query("insert into tg_tokens (id, user_id, chain, token, symbol) values ($1, $2, $3, $4, $5)", [
    randomUUID(),
    userId,
    state.chain,
    tokenText,
    symbol || "",
  ]);
  pending.delete(chatId);
  const symText = symbol ? ` (${symbol})` : "";
  return { text: `Saved the token${symText} on ${state.chain}. This account can hold up to 3.` };
}

async function guestCommand(chatId, userId, cmd, arg) {
  if (cmd === "/pause") {
    await updateMemberSettings(userId, { paused: true });
    return { text: "Paused your trading. No new swap will start for your account." };
  }
  if (cmd === "/resume") {
    const settings = await getMemberSettings(userId);
    const intervalSec = INTERVALS_SEC[settings.interval] || 1800;
    await updateMemberSettings(userId, { paused: false, next_recheck_ms: Date.now() + intervalSec * 1000 });
    return { text: `Running again. Next swap waits ${settings.interval || "30m"}.` };
  }
  if (cmd === "/emergency_stop" || cmd === "/stop") {
    await updateMemberSettings(userId, { paused: true });
    return { text: "Stopped your trading. Tap Resume to turn swaps back on." };
  }
  if (cmd === "/interval" || cmd === "/range" || cmd === "/scope") {
    return intervalReply(userId, false, arg);
  }
  if (cmd === "/genwallet") {
    return generateWalletForUser(userId);
  }
  if (cmd === "/pay") return { text: await payInfoText(userId) };
  if (cmd === "/dispute") {
    return {
      text: [
        "To raise a transaction dispute for admin review, send:",
        "/dispute <tx_hash> <optional note>",
        "",
        "Example:",
        "/dispute 0x123...456 sent $20 USDC without memo",
      ].join("\n"),
    };
  }
  if (cmd === "/addkey") return beginKey(chatId);
  if (cmd === "/importphrase" || cmd === "/restorephrase" || cmd === "/restorewallet") return beginPhrase(chatId);
  if (cmd === "/addtoken") return beginToken(chatId);
  if (cmd === "/removekey" || cmd === "/removewallet") return promptRemoveKeys(chatId, userId);
  if (cmd === "/balance") return balanceReply(userId);
  if (cmd === "/config") return configReply(userId, false);
  if (cmd === "/tokeninfo" || cmd === "/token") return tokenReply(userId);
  if (cmd === "/removetoken") return removeTokenCommand(userId, arg);
  if (cmd === "/testtrade" || cmd === "/test" || cmd === "/trade" || cmd === "/pushtrade") return pushTestTrade(userId, false);
  if (cmd === "/status") return { text: await savedLines(userId) };
  if (cmd === "/start") {
    return {
      text: [
        "Welcome to Inactivity Trade!",
        "",
        helpText(),
      ].join("\n"),
    };
  }
  return { text: helpText() };
}

async function send(chatId, text, customMarkup = null) {
  const body = {
    chat_id: chatId,
    text: text.slice(0, 3500),
    reply_markup: customMarkup ?? MENU,
  };
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      console.error(`[telegram-live:send] Failed to send to ${chatId} (${res.status}):`, errText);
    } else {
      console.log(`[telegram-live:send] ✅ Successfully sent reply to ${chatId}`);
    }
  } catch (err) {
    console.error(`[telegram-live:send] Network error sending to ${chatId}:`, err?.message || err);
  }
}

async function hide(chatId, messageId) {
  await fetch(`https://api.telegram.org/bot${token}/deleteMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId }),
  }).catch(() => undefined);
}

async function executeMemberTradeCycle(userId, item, settings) {
  const sym = item.symbol || (item.token ? item.token.slice(0, 8) : "TOKEN");
  const cycleIndex = settings.cycle_index || 0;
  const tradeRange = settings.trade_range || "5-20";

  let secret = "";
  try {
    secret = unseal(item.wrapped);
  } catch {
    return { ok: false, traded: false, chain: item.chain, symbol: sym, text: "Could not decrypt wallet key." };
  }
  if (!secret) {
    return { ok: false, traded: false, chain: item.chain, symbol: sym, text: "Missing private key." };
  }

  try {
    if (item.chain === "solana") {
      const res = await runSolanaCycle({
        privateKey: secret,
        token: item.token,
        symbol: sym,
        walletAddress: item.address,
        cycleIndex,
        tradeRange,
        onBumpCycleIndex: async (nextIdx) => {
          await updateMemberSettings(userId, { cycle_index: nextIdx });
        },
      });
      return { ok: true, traded: res.traded, chain: "solana", symbol: sym, text: res.text, token: item.token };
    }

    if (item.chain === "stacks") {
      const res = await runStacksCycle({
        privateKey: secret,
        token: item.token,
        symbol: sym,
        walletAddress: item.address,
        cycleIndex,
        tradeRange,
        onBumpCycleIndex: async (nextIdx) => {
          await updateMemberSettings(userId, { cycle_index: nextIdx });
        },
      });
      return { ok: true, traded: res.traded, chain: "stacks", symbol: sym, text: res.text, token: item.token };
    }

    if (item.chain === "robinhood") {
      const res = await runChainCycle({
        privateKeyHex: secret,
        token: item.token,
        symbol: sym,
        decimals: 18,
        pool: null,
        cycleIndex,
        tradeRange,
        walletAddress: item.address,
        onBumpCycleIndex: async (nextIdx) => {
          await updateMemberSettings(userId, { cycle_index: nextIdx });
        },
      });
      return { ok: true, traded: res.traded, chain: "robinhood", symbol: sym, text: res.text, token: item.token };
    }

    return { ok: false, traded: false, chain: item.chain, symbol: sym, text: `Unknown chain ${item.chain}` };
  } catch (err) {
    return {
      ok: false,
      traded: false,
      chain: item.chain,
      symbol: sym,
      text: err instanceof Error ? err.message : "Swap execution error",
    };
  }
}

async function pushTestTrade(callerId, isAdmin) {
  const database = await db();
  if (!database) return { text: "⚠️ Database not connected yet." };

  const now = Date.now();

  if (isAdmin) {
    // 🌟 PUSH TEST TRADE ACROSS ALL ACTIVE MEMBERS (NOT ONLY ADMIN!)
    const membersRes = await database.query(`
      select distinct w.user_id, w.chain, w.address, w.wrapped, t.token, t.symbol
      from tg_wallets w
      join tg_tokens t on t.user_id = w.user_id and t.chain = w.chain
      left join member_access a on a.user_id = w.user_id
      where (a.paid_until is not null and a.paid_until > now()) or ($1 <> '' and w.user_id = $1)
    `, [admin || ""]);

    const byUser = new Map();
    for (const row of membersRes.rows) {
      if (!byUser.has(row.user_id)) byUser.set(row.user_id, []);
      byUser.get(row.user_id).push(row);
    }

    const hasAdminCustom = byUser.has(admin) && byUser.get(admin).length > 0;

    if (byUser.size === 0 && !hasAdminCustom) {
      const rhPreview = await Promise.race([
        previewChain({
          address: NASTY_WALLET,
          token: "0xec262a75e413fAfD0dF80480274532C79D42da09",
          symbol: "NASTY",
          decimals: 18,
          pool: null,
          cycleIndex: 0,
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error("Robinhood RPC preview timed out")), 6000)),
      ]).catch((e) => ({ text: e?.message || "Robinhood preview could not be completed." }));

      return {
        text: [
          "🧪 *Push Test Trade Across All Active Members*",
          "━━━━━━━━━━━━━━━━━━━━",
          "No external active members with tokens currently registered in the database.",
          "",
          "• *Owner Robinhood (NASTY):*",
          rhPreview.text,
          "━━━━━━━━━━━━━━━━━━━━",
          "💡 When members register tokens on Solana, Stacks, or Robinhood, /testtrade executes across all active accounts once.",
        ].join("\n"),
        reply_markup: {
          inline_keyboard: [
            [{ text: "🪙 Add Token", callback_data: "action:addtoken" }],
            [{ text: "💰 Live Balances", callback_data: "action:balance" }],
          ],
        },
      };
    }

    const reportLines = [];
    let totalSwaps = 0;
    let successfulTrades = 0;

    for (const [userId, items] of byUser.entries()) {
      const isThisAdmin = admin && userId === admin;
      const userLabel = isThisAdmin ? "👑 Admin Account" : `👤 Member ${userId}`;
      const userResults = [];
      const settings = await getMemberSettings(userId);
      const intervalSec = INTERVALS_SEC[settings.interval] || 1800;

      for (const item of items) {
        totalSwaps++;
        const tradeRes = await executeMemberTradeCycle(userId, item, settings);
        if (tradeRes.traded) successfulTrades++;

        const icon = tradeRes.traded ? "✅" : "ℹ️";
        const chainName = item.chain.charAt(0).toUpperCase() + item.chain.slice(1);
        userResults.push(`  ${icon} *${chainName} (${tradeRes.symbol}):*\n  ${tradeRes.text}`);

        // Notify the member in their chat if it traded or attempted
        const memberChatId = Number(userId);
        if (memberChatId && memberChatId !== Number(callerId)) {
          const notifHeader = tradeRes.traded
            ? `🟢 *Test Swap Executed* (${tradeRes.symbol} on ${chainName})`
            : `ℹ️ *Test Trade Check* (${tradeRes.symbol} on ${chainName})`;
          const inline = buildTradeInlineMarkup(tradeRes.text, item.token, item.chain);
          await send(memberChatId, `${notifHeader}\n\n${tradeRes.text}`, inline).catch(() => {});
        }
      }

      await updateMemberSettings(userId, {
        next_recheck_ms: now + intervalSec * 1000,
        last_trade_ms: now,
        last_trade_text: "Manual test trade across all active members",
      });

      reportLines.push(`*${userLabel}:*\n${userResults.join("\n")}`);
    }

    return {
      text: [
        "🧪 *Test Trade Pushed Across All Active Accounts*",
        "━━━━━━━━━━━━━━━━━━━━",
        `👥 *Active Accounts Processed:* ${byUser.size}`,
        `🪙 *Total Swaps Checked:* ${totalSwaps} (${successfulTrades} executed)`,
        "",
        reportLines.join("\n\n"),
        "━━━━━━━━━━━━━━━━━━━━",
        "⏱️ Inactivity timers refreshed for all active accounts once.",
      ].join("\n"),
      reply_markup: {
        inline_keyboard: [
          [
            { text: "🔄 Push Across All Again", callback_data: "action:testtrade" },
            { text: "💰 Live Balances", callback_data: "action:balance" },
          ],
          [{ text: "⚙️ View Config", callback_data: "action:config" }],
        ],
      },
    };
  }

  // 👤 Non-admin member running test trade on their own active tokens
  const walletsRes = await database.query("select chain, address, wrapped from tg_wallets where user_id = $1", [callerId]);
  const tokensRes = await database.query("select id, chain, token, symbol from tg_tokens where user_id = $1 order by chain", [callerId]);

  if (tokensRes.rows.length === 0) {
    return {
      text: [
        "🧪 *Push Test Trade Across All Your Tokens*",
        "",
        "⚠️ No tokens are currently configured for your account.",
        "",
        "Tap *Add token* below to add a coin address on Solana, Stacks, or Robinhood before running a test trade.",
      ].join("\n"),
      reply_markup: {
        inline_keyboard: [
          [
            { text: "🪙 Add Token", callback_data: "action:addtoken" },
            { text: "👛 Add Key", callback_data: "action:addkey" },
          ],
        ],
      },
    };
  }

  const walletsByChain = new Map();
  for (const w of walletsRes.rows) {
    walletsByChain.set(w.chain, w);
  }

  const settings = await getMemberSettings(callerId);
  const intervalSec = INTERVALS_SEC[settings.interval] || 1800;
  const results = [];

  for (const tokenRow of tokensRes.rows) {
    const chainName = tokenRow.chain.charAt(0).toUpperCase() + tokenRow.chain.slice(1);
    const sym = tokenRow.symbol || tokenRow.token.slice(0, 8);
    const wallet = walletsByChain.get(tokenRow.chain);

    if (!wallet) {
      results.push(`• *${chainName} (${sym}):*\n⚠️ No wallet saved for ${chainName}. Tap *Add key* first.`);
      continue;
    }

    const item = {
      user_id: callerId,
      chain: tokenRow.chain,
      address: wallet.address,
      wrapped: wallet.wrapped,
      token: tokenRow.token,
      symbol: tokenRow.symbol,
    };

    const tradeRes = await executeMemberTradeCycle(callerId, item, settings);
    const icon = tradeRes.traded ? "✅" : "ℹ️";
    results.push(`${icon} *${chainName} (${tradeRes.symbol}):*\n${tradeRes.text}`);
  }

  await updateMemberSettings(callerId, {
    next_recheck_ms: now + intervalSec * 1000,
    last_trade_ms: now,
    last_trade_text: "Manual test trade initiated",
  });

  return {
    text: [
      "🧪 *Test Trade Across All Your Configured Tokens*",
      "━━━━━━━━━━━━━━━━━━━━",
      results.join("\n\n"),
      "━━━━━━━━━━━━━━━━━━━━",
      `⏱️ Inactivity timer reset. Automatic monitoring resumes (window: ${settings.interval || "30m"}).`,
    ].join("\n"),
    reply_markup: {
      inline_keyboard: [
        [
          { text: "🔄 Push Test Trade Again", callback_data: "action:testtrade" },
          { text: "💰 Live Balances", callback_data: "action:balance" },
        ],
        [{ text: "⚙️ View Config", callback_data: "action:config" }],
      ],
    },
  };
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

    // Query active paid members with saved wallets and tokens (admin is always active)
    const membersRes = await database.query(`
      select distinct w.user_id, w.chain, w.address, w.wrapped, t.token, t.symbol
      from tg_wallets w
      join tg_tokens t on t.user_id = w.user_id and t.chain = w.chain
      left join member_access a on a.user_id = w.user_id
      where (a.paid_until is not null and a.paid_until > now()) or ($1 <> '' and w.user_id = $1)
    `, [admin || ""]);

    const byUser = new Map();
    for (const row of membersRes.rows) {
      if (admin && row.user_id === admin && row.chain === "robinhood" && row.address?.toLowerCase() === NASTY_WALLET.toLowerCase()) continue;
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
          // Check on-chain inactivity first for this token
          let inactivity = null;
          try {
            inactivity = await checkTokenInactivity({
              chain: item.chain,
              token: item.token,
              intervalSec,
            });
          } catch (inactivityErr) {
            console.warn(`[checkMemberSwaps] Inactivity check notice for ${item.symbol || item.token}:`, inactivityErr?.message || inactivityErr);
          }

          if (inactivity && !inactivity.isInactive) {
            const remainingMs = Math.max(30, inactivity.remainingSec) * 1000;
            const elapsedMins = Math.floor(inactivity.elapsedSec / 60);
            const remainMins = Math.ceil(inactivity.remainingSec / 60);
            console.log(`[checkMemberSwaps] ⏳ Token ${item.symbol || item.token} on ${item.chain} is ACTIVE on-chain (trade ${elapsedMins}m ago). Next quiet check in ~${remainMins}m.`);
            await updateMemberSettings(userId, {
              next_recheck_ms: now + remainingMs,
            });
            continue; // Token is active; do NOT trade!
          }

          console.log(`[checkMemberSwaps] 🟢 Inactivity confirmed for ${item.symbol || item.token} on ${item.chain} (>= ${Math.floor(intervalSec / 60)}m quiet window). Running cycle swap...`);

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
                tradeRange: settings.trade_range || "5-20",
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
                if (chatId) {
                  const notifText = [
                    `🟢 *Inactivity Swap Executed* (${item.symbol || "Token"} on Robinhood Chain)`,
                    "",
                    result.text,
                    "",
                    `⏱️ Triggered after ${settings.interval || "30m"} of on-chain inactivity.`,
                    `Next quiet check in about ${Math.ceil(intervalSec / 60)} min.`,
                  ].join("\n");
                  const inline = buildTradeInlineMarkup(result.text, item.token, "robinhood");
                  await send(chatId, notifText, inline).catch((e) => console.error(`[checkMemberSwaps] Send trade notification failed:`, e?.message || e));
                }
              } else {
                const chatId = Number(userId);
                if (chatId) {
                  const mins = Math.max(1, Math.ceil(intervalSec / 60));
                  const failMsg = [
                    `⚠️ ${item.symbol || "Token"} cycle swap failed on Robinhood Chain.`,
                    result.text || "Swap could not be completed.",
                    `Next retry in about ${mins} min.`,
                  ].join("\n");
                  const isRepeat = settings.last_trade_text === result.text && (now - Number(settings.last_trade_ms || 0) < 15 * 60 * 1000);
                  if (!isRepeat) {
                    const inline = buildTradeInlineMarkup("", item.token, "robinhood");
                    await send(chatId, failMsg, inline).catch(() => {});
                  }
                }
              }
            } catch (tradeErr) {
              const errText = tradeErr instanceof Error ? tradeErr.message : "Swap failed";
              await updateMemberSettings(userId, {
                next_recheck_ms: nextRecheck,
                last_trade_text: errText,
              });
              const chatId = Number(userId);
              if (chatId) {
                const mins = Math.max(1, Math.ceil(intervalSec / 60));
                const failMsg = [
                  `⚠️ ${item.symbol || "Token"} cycle swap failed on Robinhood Chain.`,
                  errText,
                  `Next retry in about ${mins} min.`,
                ].join("\n");
                const isRepeat = settings.last_trade_text === errText && (now - Number(settings.last_trade_ms || 0) < 15 * 60 * 1000);
                if (!isRepeat) {
                  const inline = buildTradeInlineMarkup("", item.token, "robinhood");
                  await send(chatId, failMsg, inline).catch(() => {});
                }
              }
            }
          }

          if (item.chain === "solana") {
            let secret = "";
            try {
              secret = unseal(item.wrapped);
            } catch {
              continue;
            }
            if (!secret) continue;

            try {
              const result = await runSolanaCycle({
                privateKey: secret,
                token: item.token,
                symbol: item.symbol || "SOL_TOKEN",
                walletAddress: item.address,
                cycleIndex: settings.cycle_index || 0,
                tradeRange: settings.trade_range || "5-20",
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
                if (chatId) {
                  const notifText = [
                    `🟢 *Inactivity Swap Executed* (${item.symbol || "Token"} on Solana)`,
                    "",
                    result.text,
                    "",
                    `⏱️ Triggered after ${settings.interval || "30m"} of on-chain inactivity.`,
                    `Next quiet check in about ${Math.ceil(intervalSec / 60)} min.`,
                  ].join("\n");
                  const inline = buildTradeInlineMarkup(result.text, item.token, "solana");
                  await send(chatId, notifText, inline).catch((e) => console.error(`[checkMemberSwaps] Send trade notification failed:`, e?.message || e));
                }
              } else {
                const chatId = Number(userId);
                if (chatId) {
                  const mins = Math.max(1, Math.ceil(intervalSec / 60));
                  const failMsg = [
                    `⚠️ ${item.symbol || "Token"} cycle swap failed on Solana.`,
                    result.text || "Swap could not be completed.",
                    `Next retry in about ${mins} min.`,
                  ].join("\n");
                  const isRepeat = settings.last_trade_text === result.text && (now - Number(settings.last_trade_ms || 0) < 15 * 60 * 1000);
                  if (!isRepeat) {
                    const inline = buildTradeInlineMarkup("", item.token, "solana");
                    await send(chatId, failMsg, inline).catch(() => {});
                  }
                }
              }
            } catch (tradeErr) {
              const errText = tradeErr instanceof Error ? tradeErr.message : "Solana swap failed";
              await updateMemberSettings(userId, {
                next_recheck_ms: nextRecheck,
                last_trade_text: errText,
              });
              const chatId = Number(userId);
              if (chatId) {
                const mins = Math.max(1, Math.ceil(intervalSec / 60));
                const failMsg = [
                  `⚠️ ${item.symbol || "Token"} cycle swap failed on Solana.`,
                  errText,
                  `Next retry in about ${mins} min.`,
                ].join("\n");
                const isRepeat = settings.last_trade_text === errText && (now - Number(settings.last_trade_ms || 0) < 15 * 60 * 1000);
                if (!isRepeat) {
                  const inline = buildTradeInlineMarkup("", item.token, "solana");
                  await send(chatId, failMsg, inline).catch(() => {});
                }
              }
            }
          }

          if (item.chain === "stacks") {
            let secret = "";
            try {
              secret = unseal(item.wrapped);
            } catch {
              continue;
            }
            if (!secret) continue;

            try {
              const result = await runStacksCycle({
                privateKey: secret,
                token: item.token,
                symbol: item.symbol || "STX_TOKEN",
                walletAddress: item.address,
                cycleIndex: settings.cycle_index || 0,
                tradeRange: settings.trade_range || "5-20",
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
                if (chatId) {
                  const notifText = [
                    `🟢 *Inactivity Swap Executed* (${item.symbol || "Token"} on Stacks)`,
                    "",
                    result.text,
                    "",
                    `⏱️ Triggered after ${settings.interval || "30m"} of on-chain inactivity.`,
                    `Next quiet check in about ${Math.ceil(intervalSec / 60)} min.`,
                  ].join("\n");
                  const inline = buildTradeInlineMarkup(result.text, item.token, "stacks");
                  await send(chatId, notifText, inline).catch((e) => console.error(`[checkMemberSwaps] Send trade notification failed:`, e?.message || e));
                }
              } else {
                const chatId = Number(userId);
                if (chatId) {
                  const mins = Math.max(1, Math.ceil(intervalSec / 60));
                  const failMsg = [
                    `⚠️ ${item.symbol || "Token"} cycle swap failed on Stacks.`,
                    result.text || "Swap could not be completed.",
                    `Next retry in about ${mins} min.`,
                  ].join("\n");
                  const isRepeat = settings.last_trade_text === result.text && (now - Number(settings.last_trade_ms || 0) < 15 * 60 * 1000);
                  if (!isRepeat) {
                    const inline = buildTradeInlineMarkup("", item.token, "stacks");
                    await send(chatId, failMsg, inline).catch(() => {});
                  }
                }
              }
            } catch (tradeErr) {
              const errText = tradeErr instanceof Error ? tradeErr.message : "Stacks swap failed";
              await updateMemberSettings(userId, {
                next_recheck_ms: nextRecheck,
                last_trade_text: errText,
              });
              const chatId = Number(userId);
              if (chatId) {
                const mins = Math.max(1, Math.ceil(intervalSec / 60));
                const failMsg = [
                  `⚠️ ${item.symbol || "Token"} cycle swap failed on Stacks.`,
                  errText,
                  `Next retry in about ${mins} min.`,
                ].join("\n");
                const isRepeat = settings.last_trade_text === errText && (now - Number(settings.last_trade_ms || 0) < 15 * 60 * 1000);
                if (!isRepeat) {
                  const inline = buildTradeInlineMarkup("", item.token, "stacks");
                  await send(chatId, failMsg, inline).catch(() => {});
                }
              }
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

// Initialize database eagerly on startup
console.log("[startup] Initializing database...");
await db().catch((err) => console.error("[startup] Database init error:", err));
console.log(`[startup] Database initialized (backend: ${dbBackendName || "None"}).`);

// Clear any webhook so getUpdates polling works cleanly
await fetch(`https://api.telegram.org/bot${token}/deleteWebhook?drop_pending_updates=false`, { signal: AbortSignal.timeout(10000) })
  .then((r) => r.json())
  .then((d) => console.log("[telegram-live] Webhook state cleared:", d?.description || d?.ok))
  .catch((e) => console.warn("[telegram-live] deleteWebhook notice:", e?.message || e));

if (admin) {
  const adminChatId = Number(admin);
  if (adminChatId) {
    await send(
      adminChatId,
      `🟢 *Inactivity Trade Live Bot Online*\n\nDatabase: \`${dbBackendName || "Ready"}\`\nListening for commands and swap events.`,
      MENU,
    ).catch((err) => console.error("[telegram-live] Failed to send admin startup message:", err));
  }
}

console.log("[telegram-live] Live polling loop started via getUpdates.");
let offset = 0;
try {
  const savedOffset = fs.readFileSync("/tmp/telegram-offset", "utf8").trim();
  if (savedOffset && Number(savedOffset) > 0) offset = Number(savedOffset);
} catch {}

while (true) {
  try {
    updateHeartbeat({ status: "polling", offset, dbBackend: dbBackendName, lastPoll: Date.now() });
    const response = await fetch(`https://api.telegram.org/bot${token}/getUpdates`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ offset, timeout: 25, allowed_updates: ["message", "callback_query"] }),
      signal: AbortSignal.timeout(35000),
    });
    const payload = await response.json();
    if (!response.ok) {
      if (response.status === 409) {
        console.warn("[telegram-live] ⚠️ 409 Conflict: another instance is calling getUpdates. Backing off 10s...");
        writeGate({ telegram: false, conflict: true, error: "409 Conflict" });
        await new Promise((resolve) => setTimeout(resolve, 10000 + Math.random() * 5000));
        continue;
      }
      if (response.status === 401) {
        console.error("==================================================================================");
        console.error("❌ [telegram-live] 401 UNAUTHORIZED from Telegram API!");
        console.error("The bot token configured in Railway is invalid or has been revoked.");
        console.error("Please update TELEGRAM_BOT_TOKEN in Railway Dashboard -> Variables.");
        console.error("==================================================================================");
        writeGate({
          telegram: false,
          tokenValid: false,
          error: "401 Unauthorized: TELEGRAM_BOT_TOKEN invalid in Railway Variables",
        });
        await new Promise((resolve) => setTimeout(resolve, 10000));
        continue;
      }
      console.error(`[telegram-live] getUpdates failed (${response.status}):`, payload?.description || JSON.stringify(payload));
      await new Promise((resolve) => setTimeout(resolve, 3000));
      continue;
    }
    // Update gate on successful poll
    writeGate({
      telegram: true,
      tokenValid: true,
      botUsername,
      lastPollSuccess: Date.now(),
      error: null,
    });
    for (const update of payload.result ?? []) {
      if (typeof update.update_id === "number") {
        offset = Math.max(offset, update.update_id + 1);
        try { fs.writeFileSync("/tmp/telegram-offset", String(offset)); } catch {}
      }

      // Handle inline button clicks
      if (update.callback_query) {
        const cq = update.callback_query;
        const cqId = cq.id;
        const chatId = cq.message?.chat?.id;
        const userId = String(cq.from?.id ?? "");
        const data = cq.data || "";

        await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ callback_query_id: cqId }),
        }).catch(() => {});

        if (!chatId || !userId) continue;
        console.log(`[telegram-live] Button click from ${userId}: "${data}"`);
        const isAdmin = admin && userId === admin;

        try {
          if (data.startsWith("interval:") || data.startsWith("range:")) {
            const reply = await intervalReply(userId, isAdmin, data);
            await send(chatId, reply.text, reply.reply_markup);
            continue;
          }

          if (data === "action:genwallet") {
            pending.delete(chatId);
            const reply = await generateWalletForUser(userId);
            await send(chatId, reply.text, reply.reply_markup);
            continue;
          }

          if (data === "action:importkey") {
            pending.set(chatId, { step: "chain-key" });
            const keyboard = {
              inline_keyboard: [
                [
                  { text: "Solana", callback_data: "chain:solana" },
                  { text: "Stacks", callback_data: "chain:stacks" },
                  { text: "Robinhood", callback_data: "chain:robinhood" },
                ],
                [{ text: "Cancel", callback_data: "action:cancel" }],
              ],
            };
            await send(chatId, "Which chain? Tap a button or reply Solana, Stacks, or Robinhood. Use a fresh wallet, not the one already trading.", keyboard);
            continue;
          }

          if (data === "action:interval") {
            const reply = await intervalReply(userId, isAdmin, null);
            await send(chatId, reply.text, reply.reply_markup);
            continue;
          }

          if (data.startsWith("chain:")) {
            const val = data.replace("chain:", "");
            const pendingRes = await takePending(chatId, userId, val);
            await send(chatId, pendingRes.text, pendingRes.reply_markup);
            continue;
          }

          if (data.startsWith("dispute:raise:")) {
            const txHash = data.replace("dispute:raise:", "");
            const res = await raiseDisputeEntry(userId, txHash, "Raised via button in chat");
            await send(chatId, res.text);
            continue;
          }

          if (data.startsWith("dispute:accept:")) {
            if (!isAdmin) {
              await send(chatId, "Only the admin can accept disputes.");
              continue;
            }
            const disputeId = data.replace("dispute:accept:", "");
            const resText = await resolveDisputeEntry(disputeId, "accept");
            await send(chatId, resText);
            continue;
          }

          if (data.startsWith("dispute:reject:")) {
            if (!isAdmin) {
              await send(chatId, "Only the admin can reject disputes.");
              continue;
            }
            const disputeId = data.replace("dispute:reject:", "");
            const resText = await resolveDisputeEntry(disputeId, "reject");
            await send(chatId, resText);
            continue;
          }

          if (data.startsWith("token:remove:")) {
            const tokenId = data.replace("token:remove:", "");
            const rmRes = await removeTokenById(userId, tokenId);
            const feedback = rmRes.ok
              ? `✅ Removed token ${rmRes.deleted?.symbol ? `${rmRes.deleted.symbol} ` : ""}(${rmRes.deleted?.token?.slice(0, 8)}…).`
              : "❌ Token not found or already removed.";
            const reply = await tokenReply(userId);
            await send(chatId, `${feedback}\n\n${reply.text}`, reply.reply_markup);
            continue;
          }

          if (data === "action:token") {
            const reply = await tokenReply(userId);
            await send(chatId, reply.text, reply.reply_markup);
            continue;
          }

          if (data === "action:balance") {
            const reply = await balanceReply(userId);
            await send(chatId, reply.text, reply.reply_markup);
            continue;
          }

          if (data === "action:config") {
            const reply = await configReply(userId, isAdmin);
            await send(chatId, reply.text, reply.reply_markup);
            continue;
          }

          if (data === "action:addtoken") {
            const reply = await beginToken(chatId);
            await send(chatId, reply.text, reply.reply_markup);
            continue;
          }

          if (data === "action:addkey") {
            const reply = await beginKey(chatId);
            await send(chatId, reply.text, reply.reply_markup);
            continue;
          }

          if (data === "action:importphrase") {
            const reply = await beginPhrase(chatId);
            await send(chatId, reply.text, reply.reply_markup);
            continue;
          }

          if (data === "action:genwallet") {
            pending.delete(chatId);
            const reply = await generateWalletForUser(userId);
            await send(chatId, reply.text, reply.reply_markup);
            continue;
          }

          if (data === "action:removekey") {
            const reply = await promptRemoveKeys(chatId, userId);
            await send(chatId, reply.text, reply.reply_markup);
            continue;
          }

          if (data === "action:testtrade") {
            const reply = await pushTestTrade(userId, isAdmin);
            await send(chatId, reply.text, reply.reply_markup);
            continue;
          }

          if (data === "action:pause") {
            if (isAdmin) writeGate({ paused: true });
            await updateMemberSettings(userId, { paused: true });
            const reply = await configReply(userId, isAdmin);
            await send(chatId, "⏸️ Trading paused.\n\n" + reply.text, reply.reply_markup);
            continue;
          }

          if (data === "action:resume") {
            if (isAdmin) writeGate({ paused: false });
            const settings = await getMemberSettings(userId);
            const intervalSec = INTERVALS_SEC[settings.interval] || 1800;
            await updateMemberSettings(userId, { paused: false, next_recheck_ms: Date.now() + intervalSec * 1000 });
            const reply = await configReply(userId, isAdmin);
            await send(chatId, "▶️ Trading resumed.\n\n" + reply.text, reply.reply_markup);
            continue;
          }

          if (data === "action:cancel") {
            pending.delete(chatId);
            await send(chatId, "Cancelled.");
            continue;
          }
        } catch (error) {
          const reason = error instanceof Error ? error.message : "Button action failed.";
          await send(chatId, `⚠️ ${reason.slice(0, 300)}`);
        }
        continue;
      }

      const message = update.message;
      const raw = typeof message?.text === "string" ? message.text.trim() : "";
      const chatId = message?.chat?.id;
      const userId = String(message?.from?.id ?? "");
      if (!raw || !chatId || !userId) continue;
      const waiting = pending.get(chatId);
      const mapped = normalizeCommand(raw);
      console.log(`[telegram-live] Received message from ${userId}: "${raw}" (command: "${mapped}")`);
      try {
        if (mapped === "/cancel") {
          pending.delete(chatId);
          await send(chatId, "Cancelled.");
          continue;
        }

        // If user sent a command or button, cancel any stale waiting prompt so they are not trapped
        if (mapped.startsWith("/")) {
          if (waiting) pending.delete(chatId);
        } else if (waiting) {
          if (waiting.step === "key" || waiting.step === "phrase") await hide(chatId, message.message_id);
          const pendingRes = await takePending(chatId, userId, raw);
          await send(chatId, pendingRes.text, pendingRes.reply_markup);
          continue;
        }

        // Check if user submitted a payment transaction hash (Solana signature or EVM tx hash)
        const isTxHash = (/^[1-9A-HJ-NP-Za-km-z]{64,128}$/.test(raw) || /^0x[0-9a-fA-F]{64}$/.test(raw)) && !mapped.startsWith("/");
        if (isTxHash) {
          const paymentResult = await verifyPayment(userId, raw);
          const replyText = typeof paymentResult === "string" ? paymentResult : paymentResult.text;
          const replyMarkup = paymentResult.reply_markup ?? null;
          await send(chatId, replyText, replyMarkup);
          continue;
        }

        if (mapped.startsWith("/pay") && mapped.split(/\s+/).length > 1) {
          const parts = mapped.split(/\s+/);
          const txArg = parts.length > 2 && /^(solana|base|bsc|robinhood)$/i.test(parts[1]) ? parts[2] : parts[1];
          const paymentResult = await verifyPayment(userId, txArg);
          const replyText = typeof paymentResult === "string" ? paymentResult : paymentResult.text;
          const replyMarkup = paymentResult.reply_markup ?? null;
          await send(chatId, replyText, replyMarkup);
          continue;
        }

        // Respond helpfully to any unrecognized message instead of dropping it
        if (!mapped.startsWith("/")) {
          const fallbackText = [
            "👋 Welcome to *Inactivity Trade Bot*.",
            "",
            "Choose an option from the menu below or tap a button:",
            "• *Status*: Check swap clock and on-chain activity",
            "• *Balance*: Check balances",
            "• *Interval*: Set inactivity window (10m, 20m, 30m, 1h)",
            "• *Config*: View current strategy setup",
            "• *Help*: View setup guide and commands",
          ].join("\n");
          await send(chatId, fallbackText);
          continue;
        }
        const cmd = mapped.split(/\s+/)[0]?.split("@")[0] ?? "";
        const arg = mapped.split(/\s+/)[1] ?? "";
        const isAdmin = admin && userId === admin;

        if (cmd === "/dispute") {
          const parts = raw.split(/\s+/);
          const txArg = parts[1] ?? "";
          const noteArg = parts.slice(2).join(" ");
          if (!txArg) {
            await send(
              chatId,
              [
                "To raise a transaction dispute for admin review, send:",
                "/dispute <tx_hash> <optional note>",
                "",
                "Example:",
                "/dispute 0x123...456 sent $20 USDC without memo",
              ].join("\n"),
            );
            continue;
          }
          const disputeRes = await raiseDisputeEntry(userId, txArg, noteArg);
          await send(chatId, disputeRes.text);
          continue;
        }

        if (isAdmin && cmd === "/disputes") {
          const text = await listDisputes();
          await send(chatId, text);
          continue;
        }

        if (isAdmin && (cmd === "/accept" || cmd === "/reject")) {
          const disputeId = arg.trim();
          if (!disputeId) {
            await send(chatId, `Usage: ${cmd} <dispute_id> [optional note]`);
            continue;
          }
          const note = raw.split(/\s+/).slice(2).join(" ");
          const action = cmd === "/accept" ? "accept" : "reject";
          const resultText = await resolveDisputeEntry(disputeId, action, note);
          await send(chatId, resultText);
          continue;
        }

        if (cmd === "/interval" || cmd === "/range" || cmd === "/scope") {
          const reply = await intervalReply(userId, isAdmin, arg);
          await send(chatId, reply.text, reply.reply_markup);
          continue;
        }

        if (cmd === "/addkey" || cmd === "/addtoken" || cmd === "/removekey" || cmd === "/removewallet") {
          const reply = cmd === "/addkey"
            ? await beginKey(chatId)
            : cmd === "/addtoken"
            ? await beginToken(chatId)
            : await promptRemoveKeys(chatId, userId);
          const text = isAdmin && cmd !== "/removekey" && cmd !== "/removewallet" ? `${reply.text}\nThis does not replace the wallet already trading.` : reply.text;
          await send(chatId, text, reply.reply_markup);
          continue;
        }

        if (cmd === "/importphrase" || cmd === "/restorephrase" || cmd === "/restorewallet") {
          const reply = await beginPhrase(chatId);
          await send(chatId, reply.text, reply.reply_markup);
          continue;
        }

        if (cmd === "/removetoken") {
          const reply = await removeTokenCommand(userId, arg);
          await send(chatId, reply.text, reply.reply_markup);
          continue;
        }

        const reply = isAdmin && cmd !== "/help" && cmd !== "/start" ? await ownerReply(cmd, arg) : isAdmin ? await ownerReply(cmd, arg) : await guestCommand(chatId, userId, cmd, arg);
        await send(chatId, reply.text, reply.reply_markup);
      } catch (error) {
        const reason = error instanceof Error ? error.message : "That could not be saved.";
        await send(chatId, `⚠️ ${reason.slice(0, 300)}`);
      }
    }
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}
