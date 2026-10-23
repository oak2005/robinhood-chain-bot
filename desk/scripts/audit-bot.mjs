#!/usr/bin/env node
/**
 * Instant Bot Diagnostic and Health Audit Tool
 *
 * Usage:
 *   node scripts/audit-bot.mjs
 *
 * Verifies:
 * 1. Environment variables (TELEGRAM_BOT_TOKEN, TELEGRAM_ADMIN_ID, VAULT_KEY, DATABASE_URL)
 * 2. Telegram Bot API Connectivity & @Username via getMe
 * 3. Telegram Webhook status via getWebhookInfo
 * 4. Internal Database (PGlite / PostgreSQL) tables and member counts
 * 5. Bot process status & heartbeat (/tmp/bot-heartbeat.json)
 */

import fs from "node:fs";

console.log("=========================================================");
console.log("     🔍 INACTIVITY TRADE COMPREHENSIVE BOT AUDIT         ");
console.log("=========================================================");
console.log(`⏰ Time: ${new Date().toISOString()}`);
console.log(`📁 Current Dir: ${process.cwd()}`);
console.log("");

// 1. Audit Environment Variables
console.log("--- [1/5] ENVIRONMENT VARIABLES ---");
const token = (process.env.TELEGRAM_BOT_TOKEN ?? "").trim().replace(/^["']|["']$/g, "");
const admin = (process.env.TELEGRAM_ADMIN_ID ?? "").trim().replace(/^["']|["']$/g, "");
const vaultKey = (process.env.VAULT_KEY ?? "").trim();
const dbUrl = (process.env.DATABASE_URL ?? "").trim();

if (!token) {
  console.log("❌ TELEGRAM_BOT_TOKEN: MISSING! (Bot cannot poll or send messages)");
} else if (!token.includes(":")) {
  console.log(`⚠️ TELEGRAM_BOT_TOKEN: INVALID FORMAT ("${token.slice(0, 5)}...")`);
} else {
  const [botId, ...rest] = token.split(":");
  console.log(`✅ TELEGRAM_BOT_TOKEN: Set (Bot ID: ${botId}, Hash: ${rest.join(":").slice(0, 4)}...)`);
}

if (!admin) {
  console.log("⚠️ TELEGRAM_ADMIN_ID: Not set (Admin commands will not be recognized)");
} else {
  console.log(`✅ TELEGRAM_ADMIN_ID: Set (${admin})`);
}

if (!vaultKey) {
  console.log("⚠️ VAULT_KEY: Not set (Private keys cannot be sealed until set)");
} else {
  console.log(`✅ VAULT_KEY: Set (${vaultKey.length} chars)`);
}

if (!dbUrl) {
  console.log("✅ DATABASE_URL: Unset -> Using 100% INTERNAL EMBEDDED DATABASE (PGlite)");
} else {
  console.log(`ℹ️ DATABASE_URL: Configured (Remote PostgreSQL)`);
}
console.log("");

// 2. Audit Telegram API Connection
console.log("--- [2/5] TELEGRAM BOT API TEST ---");
if (token && token.includes(":")) {
  try {
    const meRes = await fetch(`https://api.telegram.org/bot${token}/getMe`, {
      signal: AbortSignal.timeout(10000),
    });
    const meData = await meRes.json();
    if (meData.ok) {
      console.log(`✅ Telegram API Connected:`);
      console.log(`   - Bot Username: @${meData.result.username}`);
      console.log(`   - Bot First Name: ${meData.result.first_name}`);
      console.log(`   - Bot ID: ${meData.result.id}`);
      console.log(`   - Can Join Groups: ${meData.result.can_join_groups}`);
    } else {
      console.log(`❌ Telegram API Error: ${meData.error_code} - ${meData.description}`);
    }
  } catch (err) {
    console.log(`❌ Failed to reach Telegram API: ${err?.message || err}`);
  }
} else {
  console.log("⏭️ Skipped Telegram test because TELEGRAM_BOT_TOKEN is not set.");
}
console.log("");

// 3. Audit Webhook Status
console.log("--- [3/5] TELEGRAM WEBHOOK AUDIT ---");
if (token && token.includes(":")) {
  try {
    const hookRes = await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`, {
      signal: AbortSignal.timeout(10000),
    });
    const hookData = await hookRes.json();
    if (hookData.ok) {
      if (hookData.result.url) {
        console.log(`⚠️ Active Webhook detected: ${hookData.result.url}`);
        console.log(`   (Note: getUpdates polling requires deleting the webhook. telegram-live.mjs deletes it on startup.)`);
      } else {
        console.log("✅ No webhook registered (Clean for getUpdates live polling)");
      }
      console.log(`   - Pending update count: ${hookData.result.pending_update_count ?? 0}`);
      if (hookData.result.last_error_message) {
        console.log(`   - Last webhook error: ${hookData.result.last_error_message}`);
      }
    }
  } catch (err) {
    console.log(`⚠️ Could not check webhook status: ${err?.message || err}`);
  }
} else {
  console.log("⏭️ Skipped Webhook test.");
}
console.log("");

// 4. Audit Internal Database
console.log("--- [4/5] DATABASE AUDIT ---");
try {
  let dbInstance;
  if (dbUrl && (dbUrl.startsWith("postgres://") || dbUrl.startsWith("postgresql://"))) {
    const pg = (await import("pg")).default;
    dbInstance = new pg.Pool({ connectionString: dbUrl, connectionTimeoutMillis: 5000 });
    await dbInstance.query("SELECT 1");
    console.log("✅ Remote PostgreSQL: Connected");
  } else {
    const { PGlite } = await import("@electric-sql/pglite");
    const dataDir = process.env.RAILWAY_VOLUME_MOUNT_PATH
      ? `${process.env.RAILWAY_VOLUME_MOUNT_PATH}/pglite-data`
      : "./data/pglite-data";
    dbInstance = new PGlite(dataDir);
    await dbInstance.waitReady;
    console.log(`✅ Embedded Local PGlite: Ready (${dataDir})`);
  }

  const wallets = await dbInstance.query("SELECT count(*)::int as n FROM tg_wallets").catch(() => ({ rows: [{ n: 0 }] }));
  const tokens = await dbInstance.query("SELECT count(*)::int as n FROM tg_tokens").catch(() => ({ rows: [{ n: 0 }] }));
  const access = await dbInstance.query("SELECT count(*)::int as n FROM member_access").catch(() => ({ rows: [{ n: 0 }] }));
  const settings = await dbInstance.query("SELECT count(*)::int as n FROM member_settings").catch(() => ({ rows: [{ n: 0 }] }));

  console.log(`   - Saved Wallets:   ${wallets.rows[0]?.n ?? 0}`);
  console.log(`   - Saved Tokens:    ${tokens.rows[0]?.n ?? 0}`);
  console.log(`   - Member Accounts: ${access.rows[0]?.n ?? 0}`);
  console.log(`   - Member Settings: ${settings.rows[0]?.n ?? 0}`);

  if (dbInstance.end) await dbInstance.end();
  else if (dbInstance.close) await dbInstance.close();
} catch (err) {
  console.log(`❌ Database Error: ${err?.message || err}`);
}
console.log("");

// 5. Audit Local Heartbeat / Status File
console.log("--- [5/5] BOT RUNTIME HEARTBEAT ---");
try {
  if (fs.existsSync("/tmp/bot-heartbeat.json")) {
    const hb = JSON.parse(fs.readFileSync("/tmp/bot-heartbeat.json", "utf8"));
    const ageSec = Math.round((Date.now() - (hb.timestamp || 0)) / 1000);
    console.log(`✅ Heartbeat file found (/tmp/bot-heartbeat.json):`);
    console.log(`   - Status: ${hb.status}`);
    console.log(`   - Last update: ${ageSec}s ago`);
    if (hb.botUsername) console.log(`   - Bot Username: @${hb.botUsername}`);
    if (hb.offset) console.log(`   - Polling Offset: ${hb.offset}`);
    if (hb.error) console.log(`   - Last Error: ${hb.error}`);
  } else {
    console.log("ℹ️ No heartbeat file at /tmp/bot-heartbeat.json (Bot might not have run yet in this container)");
  }
} catch (err) {
  console.log(`⚠️ Heartbeat read error: ${err?.message || err}`);
}

console.log("=========================================================");
console.log("                   AUDIT COMPLETE                        ");
console.log("=========================================================");
