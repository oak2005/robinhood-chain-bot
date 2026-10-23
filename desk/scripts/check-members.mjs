import pg from "pg";

const url = process.argv[2] || process.env.DATABASE_URL;

if (!url) {
  console.log("\n❌ Please provide your DATABASE_URL as an argument or environment variable.");
  console.log("Usage: node scripts/check-members.mjs \"postgres://...\"\n");
  process.exit(1);
}

const pool = new pg.Pool({
  connectionString: url,
  ssl: url.includes("localhost") ? false : { rejectUnauthorized: false },
});

async function run() {
  try {
    console.log("\nConnecting to database...\n");

    // 1. Check users (Better Auth user table)
    let userCount = 0;
    try {
      const res = await pool.query("SELECT COUNT(*) AS count FROM \"user\"");
      userCount = Number(res.rows[0].count);
    } catch {
      // Table might not exist or be named differently
    }

    // 2. Check member_access
    let accessCount = 0;
    let paidCount = 0;
    try {
      const res = await pool.query(
        "SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE paid_until > NOW()) AS paid FROM member_access"
      );
      accessCount = Number(res.rows[0].total);
      paidCount = Number(res.rows[0].paid);
    } catch {
      // Table might not exist
    }

    // 3. Check member_slots
    let slotCount = 0;
    let slots = [];
    try {
      const res = await pool.query(
        "SELECT chain, address, token, symbol, interval, created_at FROM member_slots ORDER BY created_at DESC"
      );
      slotCount = res.rows.length;
      slots = res.rows;
    } catch {
      // Table might not exist
    }

    // 4. Check member_slot_vault (stored encrypted private keys)
    let vaultKeyCount = 0;
    try {
      const res = await pool.query("SELECT COUNT(*) AS count FROM member_slot_vault");
      vaultKeyCount = Number(res.rows[0].count);
    } catch {
      // Table might not exist
    }

    // 5. Check legacy member_vault (if any)
    let legacyVaultCount = 0;
    try {
      const res = await pool.query("SELECT COUNT(*) AS count FROM member_vault");
      legacyVaultCount = Number(res.rows[0].count);
    } catch {
      // Table might not exist
    }

    console.log("=========================================");
    console.log("        MEMBER & KEY AUDIT SUMMARY       ");
    console.log("=========================================");
    console.log(`👤 Total Registered Users:        ${userCount || accessCount}`);
    console.log(`💳 Members With Paid Subscriptions: ${paidCount}`);
    console.log(`🎯 Active Trading Slots:           ${slotCount}`);
    console.log(`🔑 Total Wallet Private Keys Stored: ${vaultKeyCount + legacyVaultCount}`);
    console.log("=========================================\n");

    if (slots.length > 0) {
      console.log("Configured Wallet Addresses:");
      slots.forEach((s, idx) => {
        console.log(` ${idx + 1}. [${s.chain.toUpperCase()}] ${s.address} (Token: ${s.symbol || s.token}, Interval: ${s.interval})`);
      });
      console.log("\n⚠️  IMPORTANT: Transfer funds away from these wallet addresses immediately!\n");
    } else {
      console.log("No wallet slots found in the database.\n");
    }

  } catch (err) {
    console.error("❌ Failed to query database:", err.message);
  } finally {
    await pool.end();
  }
}

run();
