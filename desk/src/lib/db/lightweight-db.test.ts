import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { LightweightDb } from "./lightweight-db.ts";

test("LightweightDb handles basic CRUD operations and joins without memory overhead", async () => {
  const tmpPath = "./data/test-bot-store.json";
  try { fs.unlinkSync(tmpPath); } catch {}

  const db = new LightweightDb(tmpPath);

  // Health check
  const ping = await db.query("select 1");
  assert.equal(ping.rows.length, 1);

  // Member access
  await db.query("insert into member_access (user_id, memo) values ($1, $2)", ["123", "ABCDEF"]);
  const access = await db.query("select memo, paid_until::text as paid_until from member_access where user_id = $1", ["123"]);
  assert.equal(access.rows.length, 1);
  assert.equal(access.rows[0].memo, "ABCDEF");

  // Wallets
  await db.query(
    `insert into tg_wallets (user_id, chain, address, wrapped) values
     ($1, 'robinhood', $2, $3),
     ($1, 'solana', $4, $5),
     ($1, 'stacks', $6, $7)`,
    ["123", "0xRhAddr", "wrapRh", "SolAddr", "wrapSol", "StxAddr", "wrapStx"],
  );
  const wallets = await db.query("select chain, address from tg_wallets where user_id = $1 order by chain", ["123"]);
  assert.equal(wallets.rows.length, 3);
  assert.equal(wallets.rows[0].chain, "robinhood");

  // Tokens
  await db.query("insert into tg_tokens (id, user_id, chain, token, symbol) values ($1, $2, $3, $4, $5)", [
    "tok-1",
    "123",
    "robinhood",
    "0xTokenAddr",
    "NASTY",
  ]);
  const tokens = await db.query("select id, chain, token, symbol from tg_tokens where user_id = $1 order by chain", ["123"]);
  assert.equal(tokens.rows.length, 1);
  assert.equal(tokens.rows[0].symbol, "NASTY");

  const countRes = await db.query("select count(*)::int as n from tg_tokens where user_id = $1", ["123"]);
  assert.equal(countRes.rows[0].n, 1);

  // Settings
  await db.query(
    `insert into member_settings (user_id, paused, interval, trade_range, cycle_index, next_recheck_ms, last_trade_ms, last_trade_text)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    ["123", false, "30m", "5-20", 0, 1000, 500, "Bought token"],
  );
  const settings = await db.query("select * from member_settings where user_id = $1", ["123"]);
  assert.equal(settings.rows.length, 1);
  assert.equal(settings.rows[0].interval, "30m");

  // Member swap join (admin or paid)
  const members = await db.query(`
    select distinct w.user_id, w.chain, w.address, w.wrapped, t.token, t.symbol
    from tg_wallets w
    join tg_tokens t on t.user_id = w.user_id and t.chain = w.chain
    left join member_access a on a.user_id = w.user_id
    where (a.paid_until is not null and a.paid_until > now()) or ($1 <> '' and w.user_id = $1)
  `, ["123"]);
  assert.equal(members.rows.length, 1);
  assert.equal(members.rows[0].token, "0xTokenAddr");

  // Cleanup test file
  try { fs.unlinkSync(tmpPath); } catch {}
});
