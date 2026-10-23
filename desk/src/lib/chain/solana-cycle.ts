import fs from "node:fs";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { Keypair, VersionedTransaction, Connection, PublicKey } from "@solana/web3.js";
import { ethers } from "ethers";
import { chooseTradeUsd, describeClip } from "./size.ts";
import { readSolanaWalletBalances, fetchTokenPriceUsd } from "./balance-reader.ts";

const ROOT = process.env.STILLMARK_ROOT || "/workspace";
const SOLANA_RPC = process.env.SOLANA_RPC_URL || "https://api.mainnet.solana.com";
const WSOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const MAX_LOSS_BPS = 800; // 8.0% flexible spread protection for Solana DEXes

export interface SolanaCycleResult {
  text: string;
  traded: boolean;
  halt?: boolean;
  retry: "soon" | "interval";
  txHash?: string;
}

interface SolanaRecovery {
  token: string;
  symbol: string;
  solAmount: string;
  sellTxHash: string;
  inUnits: string;
  at: number;
}

function recoveryPath(walletAddr: string): string {
  const clean = walletAddr.replace(/[^a-zA-Z0-9]/g, "");
  return `${ROOT}/data/recovery-solana-${clean}.json`;
}

function readRecovery(walletAddr: string, token: string): SolanaRecovery | null {
  try {
    const p = recoveryPath(walletAddr);
    if (!fs.existsSync(p)) return null;
    const raw = JSON.parse(fs.readFileSync(p, "utf8")) as SolanaRecovery;
    if (!raw.sellTxHash || raw.token !== token) return null;
    return raw;
  } catch {
    return null;
  }
}

function writeRecovery(walletAddr: string, value: SolanaRecovery) {
  try {
    fs.mkdirSync(`${ROOT}/data`, { recursive: true });
    fs.writeFileSync(recoveryPath(walletAddr), JSON.stringify(value));
  } catch {}
}

function clearRecovery(walletAddr: string) {
  try {
    fs.unlinkSync(recoveryPath(walletAddr));
  } catch {}
}

export function decodeSolanaSecret(secret: string): Uint8Array {
  const trimmed = secret.trim();
  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!Array.isArray(parsed) || parsed.some((part) => typeof part !== "number")) {
      throw new Error("That Solana key is not a valid byte array.");
    }
    const bytes = Uint8Array.from(parsed);
    if (bytes.length !== 64 && bytes.length !== 32) throw new Error("A Solana key must be 32 or 64 bytes.");
    return bytes;
  }
  const bytes = bs58.decode(trimmed);
  if (bytes.length !== 64 && bytes.length !== 32) throw new Error("A Solana key must be 32 or 64 bytes.");
  return bytes;
}

export async function keypairFromSecret(secret: string): Promise<Keypair> {
  const bytes = decodeSolanaSecret(secret);
  if (bytes.length === 32) {
    const pair = nacl.sign.keyPair.fromSeed(bytes);
    return await Keypair.fromSecretKey(pair.secretKey);
  }
  return await Keypair.fromSecretKey(bytes);
}

export async function getJupiterQuote(
  inputMint: string,
  outputMint: string,
  amount: bigint | string,
  slippageBps = 250,
): Promise<{
  ok: boolean;
  inAmount?: string;
  outAmount?: string;
  priceImpactPct?: string;
  quoteResponse?: Record<string, unknown>;
  error?: string;
}> {
  try {
    const url = new URL("https://api.jup.ag/swap/v1/quote");
    url.searchParams.set("inputMint", inputMint);
    url.searchParams.set("outputMint", outputMint);
    url.searchParams.set("amount", amount.toString());
    url.searchParams.set("slippageBps", slippageBps.toString());

    const res = await fetch(url.toString(), {
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(10000),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok || data.error || !data.outAmount) {
      return {
        ok: false,
        error: (data.error as string) || (data.message as string) || `Jupiter quote failed (${res.status})`,
      };
    }
    return {
      ok: true,
      inAmount: data.inAmount as string,
      outAmount: data.outAmount as string,
      priceImpactPct: (data.priceImpactPct as string) || "0",
      quoteResponse: data,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Jupiter quote network error",
    };
  }
}

export async function buildJupiterSwapTx(
  quoteResponse: Record<string, unknown>,
  userPublicKey: string,
): Promise<{
  ok: boolean;
  swapTransaction?: string;
  lastValidBlockHeight?: number;
  error?: string;
}> {
  try {
    const res = await fetch("https://api.jup.ag/swap/v1/swap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        quoteResponse,
        userPublicKey,
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: "auto",
      }),
      signal: AbortSignal.timeout(12000),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok || !data.swapTransaction) {
      return {
        ok: false,
        error: (data.error as string) || (data.message as string) || `Swap build failed (${res.status})`,
      };
    }
    return {
      ok: true,
      swapTransaction: data.swapTransaction as string,
      lastValidBlockHeight: typeof data.lastValidBlockHeight === "number" ? data.lastValidBlockHeight : undefined,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Jupiter swap build error",
    };
  }
}

async function broadcastAndConfirmTx(
  conn: Connection,
  signedVtxBytes: Uint8Array,
  timeoutMs = 25000,
): Promise<string> {
  const txHash = await conn.sendRawTransaction(signedVtxBytes, {
    skipPreflight: true,
    maxRetries: 3n,
  });

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 1500));
    try {
      const statusRes = await conn.getSignatureStatus(txHash, { searchTransactionHistory: true });
      const status = statusRes?.value;
      if (status) {
        if (status.err) {
          throw new Error(`Transaction reverted: ${JSON.stringify(status.err)}`);
        }
        if (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized") {
          return txHash;
        }
      }
    } catch (checkErr) {
      if (checkErr instanceof Error && checkErr.message.includes("Transaction reverted")) {
        throw checkErr;
      }
    }
  }

  // If timeout expired but tx was broadcast, check one last time
  const finalStatus = await conn.getSignatureStatus(txHash, { searchTransactionHistory: true }).catch(() => null);
  if (finalStatus?.value?.err) {
    throw new Error(`Transaction reverted: ${JSON.stringify(finalStatus.value.err)}`);
  }
  return txHash;
}

export async function previewSolana(input: {
  address: string;
  token: string;
  symbol: string;
  decimals?: number;
  cycleIndex?: number;
  tradeRange?: string;
}): Promise<{ text: string }> {
  try {
    const balInfo = await readSolanaWalletBalances(input.address, [
      { token: input.token, symbol: input.symbol },
    ]);
    const solAmount = parseFloat(balInfo.nativeAmount) || 0;
    const tokenBal = balInfo.tokens[0];
    const tokenAmount = parseFloat(tokenBal?.amount || "0");
    const tokenPrice = tokenBal?.priceUsd || (await fetchTokenPriceUsd(input.token)) || 0;
    const tokenUsd = tokenBal?.balanceUsd != null ? tokenBal.balanceUsd : tokenAmount * tokenPrice;

    const shortAddr = input.token.length > 8 ? `${input.token.slice(0, 4)}…${input.token.slice(-4)}` : input.token;
    const lines: string[] = [
      `Solana: ${input.symbol} (${shortAddr})`,
      `SOL Balance: ${balInfo.nativeAmount} SOL${balInfo.nativeBalanceUsd ? ` ($${balInfo.nativeBalanceUsd.toFixed(2)})` : ""}`,
      `${input.symbol} Balance: ${tokenAmount.toLocaleString("en-US", { maximumFractionDigits: 6 })} ($${tokenUsd.toFixed(2)})`,
    ];

    if (solAmount < 0.003) {
      lines.push("⚠️ Low SOL for transaction fees. Fund wallet with at least 0.005 SOL.");
    }

    const picked = chooseTradeUsd(tokenUsd, input.cycleIndex ?? 0, input.tradeRange);
    if (!picked.ok) {
      lines.push(picked.text);
      return { text: lines.join("\n") };
    }

    lines.push(describeClip(picked.clip));

    // Try quoting round trip via Jupiter v1
    const tokenDecimals = tokenBal?.decimals ?? input.decimals ?? 6;
    const rawUnits = BigInt(Math.max(1, Math.floor((picked.clip.usd / (tokenPrice || 1)) * 10 ** tokenDecimals)));
    const sQuote = await getJupiterQuote(input.token, WSOL_MINT, rawUnits, 250);

    if (sQuote.ok && sQuote.outAmount) {
      const bQuote = await getJupiterQuote(WSOL_MINT, input.token, sQuote.outAmount, 250);
      if (bQuote.ok && bQuote.outAmount) {
        const inUnits = BigInt(sQuote.inAmount || rawUnits.toString());
        const backUnits = BigInt(bQuote.outAmount);
        const lossBps = inUnits > backUnits ? Number(((inUnits - backUnits) * 10000n) / inUnits) : 0;
        const costPct = Math.max(0, lossBps / 100);
        lines.push(
          `Best rate ${costPct.toFixed(2)}% round trip (spread/slippage/impact ${costPct.toFixed(2)}%). Gas is the network price, not a boosted tip.`,
        );
      } else {
        lines.push(`Jupiter route ready: $${picked.clip.usd.toFixed(2)} planned cycle.`);
      }
    } else {
      lines.push(`Jupiter route note: ${sQuote.error || "Order route check in progress"}`);
    }

    return { text: lines.join("\n") };
  } catch (error) {
    return {
      text: `Solana preview failed: ${error instanceof Error ? error.message : "Error reading chain"}`,
    };
  }
}

export async function runSolanaCycle(input: {
  privateKey: string;
  token: string;
  symbol: string;
  decimals?: number;
  walletAddress: string;
  cycleIndex?: number;
  tradeRange?: string;
  onBumpCycleIndex?: (next: number) => Promise<void> | void;
}): Promise<SolanaCycleResult> {
  let keypair: Keypair;
  try {
    keypair = await keypairFromSecret(input.privateKey);
  } catch (error) {
    return {
      text: `Solana key error: ${error instanceof Error ? error.message : "Invalid key"}`,
      traded: false,
      halt: true,
      retry: "interval",
    };
  }

  const walletAddr = input.walletAddress || (keypair.address ? keypair.address.toString() : keypair.publicKey?.toBase58());
  const conn = new Connection(SOLANA_RPC, "confirmed");

  // Check for open recovery from a previous interrupted buyback
  const recovery = readRecovery(walletAddr, input.token);
  if (recovery && recovery.solAmount && recovery.sellTxHash) {
    try {
      const buyQuote = await getJupiterQuote(WSOL_MINT, input.token, recovery.solAmount, 300);
      if (buyQuote.ok && buyQuote.quoteResponse) {
        const buyTxBuild = await buildJupiterSwapTx(buyQuote.quoteResponse, walletAddr);
        if (buyTxBuild.ok && buyTxBuild.swapTransaction) {
          const buyVtx = VersionedTransaction.deserialize(Buffer.from(buyTxBuild.swapTransaction, "base64"));
          await buyVtx.sign([keypair]);
          const buyTxHash = await broadcastAndConfirmTx(conn, buyVtx.serialize());
          clearRecovery(walletAddr);

          if (input.onBumpCycleIndex) {
            await input.onBumpCycleIndex((input.cycleIndex ?? 0) + 1);
          }

          return {
            text: [
              `${input.symbol} round trip sent on Solana (recovered buy).`,
              `Completed buyback after sell ${recovery.sellTxHash}.`,
              `Sell`,
              recovery.sellTxHash,
              `Buy`,
              buyTxHash,
            ].join("\n"),
            traded: true,
            retry: "interval",
            txHash: buyTxHash,
          };
        }
      }
    } catch (recErr) {
      return {
        text: `A sell is already open (${recovery.sellTxHash}). Buy retry failed: ${recErr instanceof Error ? recErr.message : "Error"}.\nWill try the buy again. No second sell.`,
        traded: false,
        halt: true,
        retry: "soon",
      };
    }
  }

  // 1. Check wallet balances
  const balInfo = await readSolanaWalletBalances(walletAddr, [{ token: input.token, symbol: input.symbol }]);
  const solAmount = parseFloat(balInfo.nativeAmount) || 0;
  if (solAmount < 0.003) {
    return {
      text: `Not enough SOL for transaction fees (${solAmount.toFixed(4)} SOL). Need at least 0.005 SOL to execute swaps on Solana.`,
      traded: false,
      retry: "interval",
    };
  }

  const tokenBal = balInfo.tokens[0];
  const tokenAmount = parseFloat(tokenBal?.amount || "0");
  const rawBalance = BigInt(tokenBal?.rawAmount || "0");
  const tokenPrice = tokenBal?.priceUsd || (await fetchTokenPriceUsd(input.token)) || 0;
  const tokenUsd = tokenBal?.balanceUsd != null ? tokenBal.balanceUsd : tokenAmount * tokenPrice;

  if (tokenAmount <= 0 || tokenUsd < 1) {
    return {
      text: `Token balance for ${input.symbol} is too low to swap ($${tokenUsd.toFixed(2)}, need >= $1.00).`,
      traded: false,
      retry: "interval",
    };
  }

  // 2. Select trade dollar size along the rotating ladder ($5, $8, $6, $7, $7.50, $9)
  const picked = chooseTradeUsd(tokenUsd, input.cycleIndex ?? 0, input.tradeRange);
  if (!picked.ok) {
    return {
      text: picked.text,
      traded: false,
      retry: "interval",
    };
  }

  const tokenDecimals = tokenBal?.decimals ?? input.decimals ?? 6;
  let amountIn: bigint;
  if (tokenPrice > 0) {
    amountIn = BigInt(Math.max(1, Math.floor((picked.clip.usd / tokenPrice) * 10 ** tokenDecimals)));
  } else {
    amountIn = rawBalance / 4n;
  }
  // Cap amount to actual wallet token balance so Jupiter never rejects with Insufficient Funds
  if (rawBalance > 0n && amountIn > rawBalance) {
    amountIn = rawBalance;
  }
  if (amountIn <= 0n) amountIn = 1n;

  // 3. Quoting with flexible spread (250 bps slippage)
  const sellQuote = await getJupiterQuote(input.token, WSOL_MINT, amountIn, 250);
  if (!sellQuote.ok || !sellQuote.outAmount || !sellQuote.quoteResponse) {
    return {
      text: `Could not quote ${input.symbol} on Solana: ${sellQuote.error || "No route found"}. Swap skipped.`,
      traded: false,
      retry: "soon",
    };
  }

  const buyQuote = await getJupiterQuote(WSOL_MINT, input.token, sellQuote.outAmount, 250);
  if (!buyQuote.ok || !buyQuote.outAmount) {
    return {
      text: `Could not quote ${input.symbol} buyback route on Solana. Swap postponed.`,
      traded: false,
      retry: "soon",
    };
  }

  // Calculate quoted round trip loss
  const inUnits = BigInt(sellQuote.inAmount || amountIn.toString());
  const backUnits = BigInt(buyQuote.outAmount);
  const lossBps = inUnits > backUnits ? Number(((inUnits - backUnits) * 10000n) / inUnits) : 0;
  const costPct = Math.max(0, lossBps / 100);

  if (lossBps > MAX_LOSS_BPS) {
    return {
      text: `${input.symbol} spread is too wide (quoted cost ${costPct.toFixed(2)}%, max allowed is 8.00%). Swap skipped to protect bag.`,
      traded: false,
      retry: "soon",
    };
  }

  // 4. Leg 1: Sell Token -> SOL
  const sellTxBuild = await buildJupiterSwapTx(sellQuote.quoteResponse, walletAddr);
  if (!sellTxBuild.ok || !sellTxBuild.swapTransaction) {
    return {
      text: `Could not build Solana sell transaction: ${sellTxBuild.error || "Build error"}. Swap postponed.`,
      traded: false,
      retry: "soon",
    };
  }

  let sellTxHash = "";
  try {
    const vtx = VersionedTransaction.deserialize(Buffer.from(sellTxBuild.swapTransaction, "base64"));
    await vtx.sign([keypair]);
    sellTxHash = await broadcastAndConfirmTx(conn, vtx.serialize());
  } catch (sellErr) {
    return {
      text: `Solana sell failed: ${sellErr instanceof Error ? sellErr.message : "Broadcast failed"}.`,
      traded: false,
      retry: "soon",
    };
  }

  // Write recovery in case buy leg fails
  writeRecovery(walletAddr, {
    token: input.token,
    symbol: input.symbol,
    solAmount: sellQuote.outAmount,
    sellTxHash,
    inUnits: inUnits.toString(),
    at: Date.now(),
  });

  // 5. Leg 2: Buy back SOL -> Token (round trip)
  let buyTxHash = "";
  let boughtUnits = backUnits;
  try {
    await new Promise((r) => setTimeout(r, 2000)); // wait for account state update

    // Re-quote buyback with the SOL actually received
    const freshBuyQuote = await getJupiterQuote(WSOL_MINT, input.token, sellQuote.outAmount, 300);
    const quoteToUse = freshBuyQuote.ok && freshBuyQuote.quoteResponse ? freshBuyQuote.quoteResponse : buyQuote.quoteResponse;
    if (freshBuyQuote.ok && freshBuyQuote.outAmount) {
      boughtUnits = BigInt(freshBuyQuote.outAmount);
    }

    if (quoteToUse) {
      const buyTxBuild = await buildJupiterSwapTx(quoteToUse, walletAddr);
      if (buyTxBuild.ok && buyTxBuild.swapTransaction) {
        const buyVtx = VersionedTransaction.deserialize(Buffer.from(buyTxBuild.swapTransaction, "base64"));
        await buyVtx.sign([keypair]);
        buyTxHash = await broadcastAndConfirmTx(conn, buyVtx.serialize());
        clearRecovery(walletAddr);
      }
    }
  } catch (buyErr) {
    return {
      text: [
        `Sell ${sellTxHash} went through on Solana and the buy did not. ${buyErr instanceof Error ? buyErr.message : "Error"}`,
        `It will try the buy again by itself. No second sell.`,
      ].join("\n"),
      traded: false,
      halt: true,
      retry: "soon",
    };
  }

  if (input.onBumpCycleIndex) {
    await input.onBumpCycleIndex((input.cycleIndex ?? 0) + 1);
  }

  const soldFormatted = ethers.formatUnits(inUnits, tokenDecimals);
  const boughtFormatted = ethers.formatUnits(boughtUnits, tokenDecimals);

  return {
    text: [
      `${input.symbol} round trip sent on Solana.`,
      `Sold ${soldFormatted}.`,
      `Bought back ${boughtFormatted}.`,
      `About $${picked.clip.usd.toFixed(2)} sold and bought back.`,
      `Quoted cost ${costPct.toFixed(2)}% before the buy was recalculated.`,
      `Sell`,
      sellTxHash,
      `Buy`,
      buyTxHash,
    ].join("\n"),
    traded: true,
    retry: "interval",
    txHash: sellTxHash,
  };
}
