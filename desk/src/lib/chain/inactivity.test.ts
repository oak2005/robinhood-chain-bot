import assert from "node:assert/strict";
import { test } from "node:test";
import { checkTokenInactivity } from "./inactivity.ts";

test("checkTokenInactivity falls back gracefully for unsupported chains", async () => {
  const res = await checkTokenInactivity({
    chain: "unsupported-chain",
    token: "0x123",
    intervalSec: 1800,
  });
  assert.equal(res.isInactive, true);
  assert.equal(res.elapsedSec, 1801);
  assert.equal(res.remainingSec, 0);
  assert.equal(res.source, "unsupported-chain-fallback");
});

test("checkTokenInactivity enforces intervalSec minimum default", async () => {
  const res = await checkTokenInactivity({
    chain: "unknown",
    token: "0x123",
    intervalSec: 0, // should default to 1800
  });
  assert.equal(res.isInactive, true);
  assert.equal(res.elapsedSec, 1801);
  assert.equal(res.remainingSec, 0);
});

test("checkRobinhoodInactivity fails closed with isInactive: false on network error", async () => {
  // Pass an invalid / non-existent contract or malformed address
  const res = await checkTokenInactivity({
    chain: "robinhood",
    token: "invalid-token-address",
    intervalSec: 1800,
  });
  // Should fail safe (isInactive: false) so we never trade on network errors
  assert.equal(res.isInactive, false);
  assert.ok(res.remainingSec > 0);
  assert.equal(res.source, "robinhood-error");
});

test("checkSolanaInactivity fails closed with isInactive: false on invalid mint", async () => {
  const res = await checkTokenInactivity({
    chain: "solana",
    token: "not-a-valid-solana-mint",
    intervalSec: 1800,
  });
  assert.equal(res.isInactive, false);
  assert.ok(res.remainingSec > 0);
  assert.equal(res.source, "solana-error");
});
