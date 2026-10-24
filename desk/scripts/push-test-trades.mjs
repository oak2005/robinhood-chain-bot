import fs from "node:fs";
import pg from "pg";
import { createDecipheriv, scryptSync } from "node:crypto";
import { runSolanaCycle } from "../src/lib/chain/solana-cycle.ts";
import { runStacksCycle } from "../src/lib/chain/stacks-cycle.ts";
import { runChainCycle, previewChain } from "../src/lib/chain/cycle.ts";

const SECRET = process.env.STILLMARK_VAULT_SECRET || process.env.VAULT_SECRET || "stillmark-default-vault-secret";
const admin = process.env.ADMIN_ID || "";
const NASTY_WALLET = "0xdf246e7a947674476c832544f7867aa864c60bd5";

function unseal(wrapped) {
  if (!wrapped || !wrapped.includes(":")) return "";
  const [ivHex, tagHex, dataHex] = wrapped.split(":");
  const key = scryptSync(SECRET, "vault-salt", 32);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(dataHex, "hex")), decipher.final()]);
  return decrypted.toString("utf8");
}

async function getDatabase() {
  const url = process.argv[2] || process.env.DATABASE_URL;
  if (url && (url.startsWith("postgres://") || url.startsWith("postgresql://"))) {
    const pool = new pg.Pool({
      connectionString: url,
      ssl: url.includes("localhost") ? false : { rejectUnauthorized: false },
    });
    return pool;
  }
  const pglitePath = fs.existsSync("./data/pglite-data")
    ? "./data/pglite-data"
    : fs.existsSync("../data/pglite-data")
    ? "../data/pglite-data"
    : "./data/pglite-data";
  try {
    fs.mkdirSync(pglitePath, { recursive: true });
  } catch {}
  const { PGlite } = await import("@electric-sql/pglite");
  const pool = new PGlite(pglitePath);
  await pool.waitReady;
  return pool;
}

async function main() {
  console.log("=================================================");
  console.log("    PUSH TEST TRADE ACROSS ALL ACTIVE ACCOUNTS   ");
  console.log("=================================================\n");

  const database = await getDatabase();
  const now = Date.now();

  // Query all active accounts (members with valid access + admin) with wallets & tokens
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

  console.log(`Found ${byUser.size} active account(s) with saved wallets & tokens.\n`);

  if (byUser.size === 0) {
    console.log("No registered members found. Running preview on owner Robinhood wallet...");
    try {
      const preview = await Promise.race([
        previewChain({
          address: NASTY_WALLET,
          token: "0xec262a75e413fAfD0dF80480274532C79D42da09",
          symbol: "NASTY",
          decimals: 18,
          pool: null,
          cycleIndex: 0,
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error("RPC preview timed out")), 5000)),
      ]);
      console.log("\nOwner Preview Output:\n" + preview.text);
    } catch (err) {
      console.log("Owner preview notice: " + (err?.message || err));
    }
    console.log("\nDone.");
    return;
  }

  for (const [userId, items] of byUser.entries()) {
    const isThisAdmin = admin && userId === admin;
    const label = isThisAdmin ? `👑 Admin (${userId})` : `👤 Member (${userId})`;
    console.log(`\n-------------------------------------------------`);
    console.log(`Processing: ${label}`);
    console.log(`-------------------------------------------------`);

    for (const item of items) {
      const sym = item.symbol || item.token.slice(0, 8);
      console.log(`-> Testing [${item.chain.toUpperCase()}] Token: ${sym} (${item.token})`);
      console.log(`   Wallet: ${item.address}`);

      let secret = "";
      try {
        secret = unseal(item.wrapped);
      } catch (err) {
        console.error(`   ❌ Failed to unseal key: ${err?.message}`);
        continue;
      }

      if (!secret) {
        console.error("   ❌ Unsealed key is empty.");
        continue;
      }

      try {
        if (item.chain === "solana") {
          const res = await runSolanaCycle({
            privateKey: secret,
            token: item.token,
            symbol: sym,
            walletAddress: item.address,
            cycleIndex: 0,
            tradeRange: "5-20",
          });
          console.log(`   ${res.traded ? "✅ TRADED" : "ℹ️ CHECKED"}:\n   ${res.text.replace(/\n/g, "\n   ")}`);
        } else if (item.chain === "stacks") {
          const res = await runStacksCycle({
            privateKey: secret,
            token: item.token,
            symbol: sym,
            walletAddress: item.address,
            cycleIndex: 0,
            tradeRange: "5-20",
          });
          console.log(`   ${res.traded ? "✅ TRADED" : "ℹ️ CHECKED"}:\n   ${res.text.replace(/\n/g, "\n   ")}`);
        } else if (item.chain === "robinhood") {
          const res = await runChainCycle({
            privateKeyHex: secret,
            token: item.token,
            symbol: sym,
            decimals: 18,
            pool: null,
            cycleIndex: 0,
            tradeRange: "5-20",
            walletAddress: item.address,
          });
          console.log(`   ${res.traded ? "✅ TRADED" : "ℹ️ CHECKED"}:\n   ${res.text.replace(/\n/g, "\n   ")}`);
        }
      } catch (tradeErr) {
        console.error(`   ❌ Swap execution error: ${tradeErr instanceof Error ? tradeErr.message : tradeErr}`);
      }
    }
  }

  console.log("\n=================================================");
  console.log("   TEST TRADE PUSH COMPLETED ACROSS ALL ACCOUNTS ");
  console.log("=================================================\n");
}

main().catch(console.error);
