import assert from "node:assert/strict";
import test from "node:test";
import { randomPrivateKey } from "@stacks/transactions";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { deriveWallet } from "./keys.ts";
import { Wallet } from "ethers";
import { readEvmPayment, readSolanaPayment } from "./pay.ts";
import { PAY_EVM, assertNoSecret, nextClip } from "./public.ts";
import { openSecret, sealSecret } from "./seal.ts";

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
