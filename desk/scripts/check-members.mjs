import fs from "node:fs";
import pg from "pg";

const url = process.argv[2] || process.env.DATABASE_URL;
let pool;
let isPglite = false;

if (url && (url.startsWith("postgres://") || url.startsWith("postgresql://"))) {
  pool = new pg.Pool({
    connectionString: url,
    ssl: url.includes("localhost") ? false : { rejectUnauthorized: false },
  });
} else {
  isPglite = true;
  const pglitePath = fs.existsSync("./data/pglite-data")
    ? "./data/pglite-data"
    : fs.existsSync("../data/pglite-data")
    ? "../data/pglite-data"
    : "./data/pglite-data";
  try {
    fs.mkdirSync(pglitePath, { recursive: true });
  } catch {}
  console.log(`\n📂 Using embedded local database at: ${pglitePath}`);
  const { PGlite } = await import("@electric-sql/pglite");
  pool = new PGlite(pglitePath);
  await pool.waitReady;
}

async function run() {
  try {
    console.log("Connecting to database...\n");

    // 1. Check Telegram Wallets (tg_wallets)
    let tgWallets = [];
    try {
      const res = await pool.query("SELECT user_id, chain, address FROM tg_wallets ORDER BY chain, user_id");
      tgWallets = res.rows;
    } catch {}

    // 2. Check Telegram Tokens (tg_tokens)
    let tgTokens = [];
    try {
      const res = await pool.query("SELECT user_id, chain, token, symbol FROM tg_tokens ORDER BY chain, user_id");
      tgTokens = res.rows;
    } catch {}

    // 3. Check Telegram Member Access (member_access)
    let tgAccess = [];
    let paidCount = 0;
    try {
      const res = await pool.query("SELECT user_id, memo, paid_until, last_tx FROM member_access ORDER BY user_id");
      tgAccess = res.rows;
      paidCount = tgAccess.filter((a) => a.paid_until && new Date(a.paid_until).getTime() > Date.now()).length;
    } catch {}

    // 4. Check Telegram Settings (member_settings)
    let tgSettings = [];
    try {
      const res = await pool.query("SELECT user_id, paused, interval, trade_range FROM member_settings ORDER BY user_id");
      tgSettings = res.rows;
    } catch {}

    // 5. Check Web App Slots (member_slots)
    let slotCount = 0;
    let webSlots = [];
    try {
      const res = await pool.query(
        "SELECT chain, address, token, symbol, interval, created_at FROM member_slots ORDER BY created_at DESC"
      );
      slotCount = res.rows.length;
      webSlots = res.rows;
    } catch {}

    // 6. Check Disputes (payment_disputes)
    let disputeCount = 0;
    try {
      const res = await pool.query("SELECT COUNT(*) AS count FROM payment_disputes WHERE status = 'pending'");
      disputeCount = Number(res.rows[0]?.count || 0);
    } catch {}

    // 7. Check Support Tickets (support_tickets)
    let ticketCount = 0;
    try {
      const res = await pool.query("SELECT COUNT(*) AS count FROM support_tickets WHERE status = 'open'");
      ticketCount = Number(res.rows[0]?.count || 0);
    } catch {}

    console.log("=========================================");
    console.log("       INACTIVITY TRADE DATABASE AUDIT    ");
    console.log("=========================================");
    console.log(`🗄️ Backend:                        ${isPglite ? "Embedded Local (PGlite)" : "PostgreSQL Server"}`);
    console.log(`👤 Telegram Members Registered:   ${tgAccess.length}`);
    console.log(`💳 Members With Active Access:     ${paidCount}`);
    console.log(`👛 Telegram Saved Wallets:        ${tgWallets.length}`);
    console.log(`🪙 Telegram Configured Tokens:     ${tgTokens.length}`);
    console.log(`🌐 Web App Trading Slots:          ${slotCount}`);
    console.log(`⚠️ Pending Payment Disputes:       ${disputeCount}`);
    console.log(`📩 Open Support Tickets / Ideas:   ${ticketCount}`);
    console.log("=========================================\n");

    if (tgWallets.length > 0) {
      console.log("Telegram Bot Saved Wallets:");
      tgWallets.forEach((w, idx) => {
        const tokensForUser = tgTokens.filter((t) => t.user_id === w.user_id && t.chain === w.chain);
        const tokenStr = tokensForUser.map((t) => t.symbol || t.token.slice(0, 8)).join(", ") || "No tokens";
        console.log(` ${idx + 1}. User [${w.user_id}] [${w.chain.toUpperCase()}]: ${w.address} (Tokens: ${tokenStr})`);
      });
      console.log("");
    } else {
      console.log("No Telegram member wallets saved yet.\n");
    }

    if (webSlots.length > 0) {
      console.log("Web App Trading Slots:");
      webSlots.forEach((s, idx) => {
        console.log(` ${idx + 1}. [${s.chain.toUpperCase()}] ${s.address} (Token: ${s.symbol || s.token}, Interval: ${s.interval})`);
      });
      console.log("");
    }

  } catch (err) {
    console.error("❌ Failed to query database:", err.message);
  } finally {
    if (pool.end) await pool.end();
    else if (pool.close) await pool.close();
  }
}

run();
