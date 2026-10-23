import assert from "node:assert/strict";
import test from "node:test";
import { randomPrivateKey } from "@stacks/transactions";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { deriveWallet, generateUniversalWallet, deriveUniversalWallet } from "./keys.ts";
import { Wallet } from "ethers";
import { readEvmPayment, readSolanaPayment } from "./pay.ts";
import { PAY_EVM, assertNoSecret, nextClip } from "./public.ts";
import { openSecret, sealSecret } from "./seal.ts";
import { chooseTradeUsd } from "../chain/size.ts";

test("solana address comes from the key and the secret is not the address", () => {
  const pair = nacl.sign.keyPair();
  const secret = bs58.encode(pair.secretKey);
  const derived = deriveWallet("solana", secret);
  assert.equal(derived.address, bs58.encode(pair.publicKey));
  assert.notEqual(derived.address, secret);
});

test("stacks address is a mainnet principal and not the key", () => {
  const secret = randomPrivateKey();
  const derived = deriveWallet("stacks", secret);
  assert.match(derived.address, /^SP/);
  assert.equal(derived.address.includes(secret), false);
});

test("robinhood address comes from the hex key", () => {
  const wallet = Wallet.createRandom();
  const derived = deriveWallet("robinhood", wallet.privateKey);
  assert.equal(derived.address, wallet.address);
  assert.equal(derived.address.includes(wallet.privateKey.slice(2)), false);
});

test("solana 20 USDC credit passes with or without memo, under 20 does not", () => {
  const tx = {
    meta: {
      err: null,
      preTokenBalances: [],
      postTokenBalances: [
        {
          accountIndex: 1,
          mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          owner: "GLrFg8GR7iNotxJRvVHakdbhpRHjEEe8EHXVmjHxNG1T",
          uiTokenAmount: { uiAmountString: "20" },
        },
      ],
      innerInstructions: [],
    },
    transaction: {
      message: {
        instructions: [],
      },
    },
  };
  assert.equal(readSolanaPayment(tx).ok, true);
  assert.equal(readSolanaPayment(tx, "K7H2QA").ok, true);

  const underTx = {
    ...tx,
    meta: {
      ...tx.meta,
      postTokenBalances: [
        {
          accountIndex: 1,
          mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          owner: "GLrFg8GR7iNotxJRvVHakdbhpRHjEEe8EHXVmjHxNG1T",
          uiTokenAmount: { uiAmountString: "19.5" },
        },
      ],
    },
  };
  assert.equal(readSolanaPayment(underTx).ok, false);
});

test("base payment accepts 20 or more without memo, under 20 is rejected", () => {
  const deposit = `0x${PAY_EVM.slice(2).toLowerCase().padStart(64, "0")}`;
  const receipt = (data: bigint) => ({
    status: "0x1",
    logs: [
      {
        address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
        topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", "0x" + "11".repeat(32), deposit],
        data: `0x${data.toString(16)}`,
      },
    ],
  });
  assert.equal(readEvmPayment("base", { input: "0x" }, receipt(25_000_000n)).ok, true);
  assert.equal(readEvmPayment("base", { input: "0x" }, receipt(20_000_000n)).ok, true);
  assert.equal(readEvmPayment("base", { input: "0x" }, receipt(19_000_000n)).ok, false);
});

test("robinhood payment accepts at least 20 USDG without memo, under 20 is rejected", () => {
  const deposit = `0x${PAY_EVM.slice(2).toLowerCase().padStart(64, "0")}`;
  const receipt = (data: bigint) => ({
    status: "0x1",
    logs: [
      {
        address: "0x5fc5360d0400a0fd4f2af552add042d716f1d168",
        topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", "0x" + "11".repeat(32), deposit],
        data: `0x${data.toString(16)}`,
      },
    ],
  });
  const okResult = readEvmPayment("robinhood", { input: "0x" }, receipt(20_000_000n));
  assert.equal(okResult.ok, true);
  if (okResult.ok) {
    assert.equal(okResult.asset, "USDG");
    assert.equal(okResult.amount, "20");
  }
  assert.equal(readEvmPayment("robinhood", { input: "0x" }, receipt(35_500_000n)).ok, true);
  assert.equal(readEvmPayment("robinhood", { input: "0x" }, receipt(19_999_999n)).ok, false);
});

test("sealed key round-trips and operator payloads have no secret field", () => {
  const secret = "a".repeat(64);
  const wrapped = sealSecret(secret);
  assert.equal(openSecret(wrapped), secret);
  assert.equal(wrapped.includes(secret), false);
  const board = { operator: true, rows: [{ chain: "solana", address: "So111", token: "mint", symbol: "NASTY", donationUsd: 20, paidUntil: null, covered: false }] };
  assert.doesNotThrow(() => assertNoSecret(board));
  assert.throws(() => assertNoSecret({ privateKey: secret }));
});

test("clip ladder rotates", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map(nextClip), [5, 8, 6, 7, 7.5, 9, 5]);
});

test("universal wallet generates 12-word seed and valid addresses for all chains", () => {
  const generated = generateUniversalWallet();
  const words = generated.mnemonic.split(" ");
  assert.equal(words.length, 12);

  // Solana
  assert.match(generated.wallets.solana.address, /^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
  assert.ok(generated.wallets.solana.privateKey.length >= 32);

  // Robinhood / EVM
  assert.match(generated.wallets.robinhood.address, /^0x[0-9a-fA-F]{40}$/);
  assert.match(generated.wallets.robinhood.privateKey, /^0x[0-9a-fA-F]{64}$/);

  // Stacks
  assert.match(generated.wallets.stacks.address, /^(SP|SM)/);
  assert.match(generated.wallets.stacks.privateKey, /^[0-9a-fA-F]{64}$/);

  // Deterministic re-derivation from seed
  const derivedAgain = deriveUniversalWallet(generated.mnemonic);
  assert.equal(derivedAgain.wallets.solana.address, generated.wallets.solana.address);
  assert.equal(derivedAgain.wallets.robinhood.address, generated.wallets.robinhood.address);
  assert.equal(derivedAgain.wallets.stacks.address, generated.wallets.stacks.address);

  // deriveWallet accepts 12-word mnemonic directly
  const evmFromMnemonic = deriveWallet("robinhood", generated.mnemonic);
  assert.equal(evmFromMnemonic.address, generated.wallets.robinhood.address);
  const solFromMnemonic = deriveWallet("solana", generated.mnemonic);
  assert.equal(solFromMnemonic.address, generated.wallets.solana.address);
});

test("chooseTradeUsd respects trade range tiers and available wallet balance", () => {
  // Test $5-$20 range
  const tierSmall = chooseTradeUsd(100, 0, "5-20");
  assert.equal(tierSmall.ok, true);
  if (tierSmall.ok) {
    assert.equal(tierSmall.clip.usd, 5);
    assert.equal(tierSmall.clip.targetUsd, 5);
    assert.equal(tierSmall.clip.capped, false);
  }

  // Test $21-$50 range
  const tierMid = chooseTradeUsd(100, 0, "21-50");
  assert.equal(tierMid.ok, true);
  if (tierMid.ok) {
    assert.equal(tierMid.clip.usd, 22);
    assert.equal(tierMid.clip.targetUsd, 22);
    assert.equal(tierMid.clip.capped, false);
  }

  // Test $51-$100 range
  const tierHigh = chooseTradeUsd(100, 0, "51-100");
  assert.equal(tierHigh.ok, true);
  if (tierHigh.ok) {
    assert.equal(tierHigh.clip.usd, 55);
    assert.equal(tierHigh.clip.targetUsd, 55);
    assert.equal(tierHigh.clip.capped, false);
  }

  // Respects available balance when bag is smaller than target
  const limitedBalance = chooseTradeUsd(15, 0, "21-50");
  assert.equal(limitedBalance.ok, true);
  if (limitedBalance.ok) {
    // Target was 22, but balance is 15 -> caps to usable bag (~14.93)
    assert.ok(limitedBalance.clip.usd < 15);
    assert.ok(limitedBalance.clip.usd >= 14);
    assert.equal(limitedBalance.clip.capped, true);
  }

  // Reject when balance is under $1
  const dust = chooseTradeUsd(0.5, 0, "5-20");
  assert.equal(dust.ok, false);
});
