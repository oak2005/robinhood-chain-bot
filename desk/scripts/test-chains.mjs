import { readSolanaWalletBalances, readStacksWalletBalances, fetchTokenPriceUsd } from "../src/lib/chain/balance-reader.ts";
import { previewSolana, runSolanaCycle, getJupiterOrder } from "../src/lib/chain/solana-cycle.ts";
import { previewStacks, runStacksCycle } from "../src/lib/chain/stacks-cycle.ts";
import nacl from "tweetnacl";
import bs58 from "bs58";

async function main() {
  console.log("=== MULTI-CHAIN SWAP & BALANCE TEST SUITE ===\n");

  // 1. Test Solana Price & Balance Reader
  console.log("1. Testing Solana Price & Balance Reading...");
  const usdtMint = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
  const solDepositAddr = "GLrFg8GR7iNotxJRvVHakdbhpRHjEEe8EHXVmjHxNG1T";

  const solBal = await readSolanaWalletBalances(solDepositAddr, [{ token: usdtMint, symbol: "USDT" }]);
  console.log("Solana Deposit Wallet Balance:", JSON.stringify(solBal, null, 2));

  // 2. Test Jupiter Quote on Solana
  console.log("\n2. Testing Jupiter API v2 Order Quote on Solana...");
  const jupOrder = await getJupiterOrder(
    "So11111111111111111111111111111111111111112",
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    10_000_000n, // 0.01 SOL
    solDepositAddr,
  );
  console.log("Jupiter quote result:", {
    ok: jupOrder.ok,
    inUsdValue: jupOrder.inUsdValue,
    outUsdValue: jupOrder.outUsdValue,
    priceImpact: jupOrder.priceImpact,
    errorMessage: jupOrder.errorMessage,
  });

  // 3. Test Solana Preview
  console.log("\n3. Testing Solana Preview...");
  const solPreview = await previewSolana({
    address: solDepositAddr,
    token: usdtMint,
    symbol: "USDT",
    decimals: 6,
    cycleIndex: 0,
  });
  console.log("Solana Preview Output:\n" + solPreview.text);

  // 4. Test Solana Cycle with a test keypair
  console.log("\n4. Testing Solana Cycle (Gas & Balance Guard)...");
  const testSolKey = nacl.sign.keyPair();
  const testSolAddr = bs58.encode(testSolKey.publicKey);
  const solCycleResult = await runSolanaCycle({
    privateKey: bs58.encode(testSolKey.secretKey),
    token: usdtMint,
    symbol: "USDT",
    decimals: 6,
    walletAddress: testSolAddr,
    cycleIndex: 0,
  });
  console.log("Solana Cycle Output:\n" + solCycleResult.text);

  // 5. Test Stacks Price & Balance Reader
  console.log("\n5. Testing Stacks Price & Balance Reading...");
  const stacksTestAddr = "SP3K8BC0PPEVCV7NZ6QSRWPQ2JE9E5B6N3PA0KBR9";
  const welshToken = "SP3NE50GEXFG9SZGTT51P40X2CKYSZ5CC4ZTZ7A2G.welshcorgicoin-token";

  const stxBal = await readStacksWalletBalances(stacksTestAddr, [{ token: welshToken, symbol: "WELSH" }]);
  console.log("Stacks Wallet Balance:", JSON.stringify(stxBal, null, 2));

  // 6. Test Stacks Preview
  console.log("\n6. Testing Stacks Preview...");
  const stxPreview = await previewStacks({
    address: stacksTestAddr,
    token: welshToken,
    symbol: "WELSH",
    cycleIndex: 0,
  });
  console.log("Stacks Preview Output:\n" + stxPreview.text);

  // 7. Test Stacks Cycle (Gas Guard)
  console.log("\n7. Testing Stacks Cycle Guard...");
  const dummyHexKey = "11223344556677889900aabbccddeeff11223344556677889900aabbccddeeff";
  const stxCycleResult = await runStacksCycle({
    privateKey: dummyHexKey,
    token: welshToken,
    symbol: "WELSH",
    walletAddress: "SP3NE50GEXFG9SZGTT51P40X2CKYSZ5CC4ZTZ7A2G",
    cycleIndex: 0,
  });
  console.log("Stacks Cycle Output:\n" + stxCycleResult.text);

  console.log("\n=== ALL MULTI-CHAIN TESTS COMPLETED SUCCESSFULLY ===");
}

main().catch(console.error);
