import bs58 from "bs58";
import nacl from "tweetnacl";
import { Keypair, VersionedTransaction, Connection, PublicKey } from "@solana/web3.js";
import { chooseTradeUsd, describeClip } from "./size.ts";
import { readSolanaWalletBalances, fetchTokenPriceUsd } from "./balance-reader.ts";

const SOLANA_RPC = process.env.SOLANA_RPC_URL || "https://api.mainnet.solana.com";
const WSOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

export interface SolanaCycleResult {
  text: string;
  traded: boolean;
  halt?: boolean;
  retry: "soon" | "interval";
  txHash?: string;
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

export async function getJupiterOrder(
  inputMint: string,
  outputMint: string,
  amount: bigint | string,
  taker: string,
  slippageBps = 100,
): Promise<{
  ok: boolean;
  transaction?: string;
  requestId?: string;
  inUsdValue?: number;
  outUsdValue?: number;
  priceImpact?: number;
  outAmount?: string;
  errorMessage?: string;
}> {
  try {
    const url = new URL("https://api.jup.ag/swap/v2/order");
    url.searchParams.set("inputMint", inputMint);
    url.searchParams.set("outputMint", outputMint);
    url.searchParams.set("amount", amount.toString());
    url.searchParams.set("taker", taker);
    url.searchParams.set("slippageBps", slippageBps.toString());
    // Lowest network fees at swap time: exact dynamic compute units + lowest priority fee
    url.searchParams.set("dynamicComputeUnitLimit", "true");
    url.searchParams.set("prioritizationFeeLamports", "auto");
    url.searchParams.set("priorityLevel", "min");

    const res = await fetch(url.toString(), {
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(12000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error || data.errorMessage) {
      return {
        ok: false,
        errorMessage: data.errorMessage || data.error || `Jupiter returned status ${res.status}`,
      };
    }
    return {
      ok: true,
      transaction: data.transaction,
      requestId: data.requestId,
      inUsdValue: data.inUsdValue,
      outUsdValue: data.outUsdValue,
      priceImpact: data.priceImpact,
      outAmount: data.outAmount,
    };
  } catch (err) {
    return {
      ok: false,
      errorMessage: err instanceof Error ? err.message : "Jupiter API request failed",
    };
  }
}

export async function executeJupiterSwap(
  signedTxBase64: string,
  requestId?: string,
): Promise<{ ok: boolean; txHash?: string; error?: string }> {
  try {
    const res = await fetch("https://api.jup.ag/swap/v2/execute", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        signedTransaction: signedTxBase64,
        requestId: requestId || "",
      }),
      signal: AbortSignal.timeout(20000),
    });
    const data = await res.json().catch(() => ({}));
    if (data.signature || data.txid) {
      return { ok: true, txHash: data.signature || data.txid };
    }
    if (data.error || data.errorMessage) {
      return { ok: false, error: data.errorMessage || data.error };
    }
  } catch {}

  // Fallback: Broadcast via Solana RPC directly
  try {
    const conn = new Connection(SOLANA_RPC, "confirmed");
    const rawBytes = Buffer.from(signedTxBase64, "base64");
    const txHash = await conn.sendRawTransaction(rawBytes, {
      skipPreflight: true,
      maxRetries: 3,
    });
    return { ok: true, txHash };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Broadcast failed" };
  }
}

export async function previewSolana(input: {
  address: string;
  token: string;
  symbol: string;
  decimals?: number;
  cycleIndex?: number;
}): Promise<{ text: string }> {
  try {
    const balInfo = await readSolanaWalletBalances(input.address, [
      { token: input.token, symbol: input.symbol },
    ]);
    const solAmount = parseFloat(balInfo.nativeAmount) || 0;
    const tokenBal = balInfo.tokens[0];
    const tokenAmount = parseFloat(tokenBal?.amount || "0");
    const tokenPrice = tokenBal?.priceUsd || (await fetchTokenPriceUsd(input.token));
    const tokenUsd = tokenBal?.balanceUsd != null ? tokenBal.balanceUsd : tokenPrice ? tokenAmount * tokenPrice : 0;

    const lines: string[] = [
      `Solana: ${input.symbol} (${input.token.slice(0, 4)}…${input.token.slice(-4)})`,
      `SOL Balance: ${balInfo.nativeAmount} SOL${balInfo.nativeBalanceUsd ? ` ($${balInfo.nativeBalanceUsd.toFixed(2)})` : ""}`,
      `${input.symbol} Balance: ${tokenAmount.toLocaleString("en-US", { maximumFractionDigits: 6 })} ($${tokenUsd.toFixed(2)})`,
    ];

    if (solAmount < 0.003) {
      lines.push("⚠️ Low SOL for transaction fees. Fund wallet with at least 0.005 SOL.");
    }

    const picked = chooseTradeUsd(tokenUsd, input.cycleIndex ?? 0);
    if (!picked.ok) {
      lines.push(picked.text);
      return { text: lines.join("\n") };
    }

    lines.push(describeClip(picked.clip));

    // Try quoting Jupiter order
    const tokenDecimals = tokenBal?.decimals ?? input.decimals ?? 6;
    const rawUnits = BigInt(Math.max(1, Math.floor((picked.clip.usd / (tokenPrice || 1)) * 10 ** tokenDecimals)));
    const jup = await getJupiterOrder(input.token, WSOL_MINT, rawUnits, input.address, 100);

    if (jup.ok) {
      lines.push(
        `Jupiter route ready: $${picked.clip.usd.toFixed(2)} round trip. Impact: ${(jup.priceImpact ?? 0).toFixed(2)}%`,
      );
    } else {
      lines.push(`Jupiter route note: ${jup.errorMessage || "Order preparation in progress"}`);
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

  // Check balances
  const balInfo = await readSolanaWalletBalances(walletAddr, [{ token: input.token, symbol: input.symbol }]);
  const solAmount = parseFloat(balInfo.nativeAmount) || 0;
  if (solAmount < 0.003) {
    return {
      text: `Not enough SOL for gas fee (${solAmount.toFixed(4)} SOL). Need at least 0.005 SOL to execute swaps on Solana.`,
      traded: false,
      retry: "interval",
    };
  }

  const tokenBal = balInfo.tokens[0];
  const tokenAmount = parseFloat(tokenBal?.amount || "0");
  const tokenPrice = tokenBal?.priceUsd || (await fetchTokenPriceUsd(input.token)) || 0;
  const tokenUsd = tokenBal?.balanceUsd != null ? tokenBal.balanceUsd : tokenAmount * tokenPrice;

  if (tokenAmount <= 0 || tokenUsd < 1) {
    return {
      text: `Token balance for ${input.symbol} is too low to swap ($${tokenUsd.toFixed(2)}, need >= $1.00).`,
      traded: false,
      retry: "interval",
    };
  }

  const picked = chooseTradeUsd(tokenUsd, input.cycleIndex ?? 0);
  if (!picked.ok) {
    return {
      text: picked.text,
      traded: false,
      retry: "interval",
    };
  }

  const tokenDecimals = tokenBal?.decimals ?? input.decimals ?? 6;
  const rawUnits = BigInt(Math.max(1, Math.floor((picked.clip.usd / tokenPrice) * 10 ** tokenDecimals)));

  // Leg 1: Sell Token -> WSOL
  const sellOrder = await getJupiterOrder(input.token, WSOL_MINT, rawUnits, walletAddr, 100);
  if (!sellOrder.ok || !sellOrder.transaction) {
    return {
      text: `Jupiter swap order could not be built: ${sellOrder.errorMessage || "No route"}. Swap postponed.`,
      traded: false,
      retry: "soon",
    };
  }

  let sellTxHash = "";
  try {
    const txBuf = Buffer.from(sellOrder.transaction, "base64");
    const vtx = await VersionedTransaction.deserialize(txBuf);
    await vtx.sign([keypair]);
    const signedBase64 = Buffer.from(vtx.serialize()).toString("base64");

    const execRes = await executeJupiterSwap(signedBase64, sellOrder.requestId);
    if (!execRes.ok || !execRes.txHash) {
      return {
        text: `Jupiter swap sell submission failed: ${execRes.error || "Unknown error"}`,
        traded: false,
        retry: "soon",
      };
    }
    sellTxHash = execRes.txHash;
  } catch (error) {
    return {
      text: `Solana transaction signing/broadcast failed: ${error instanceof Error ? error.message : "Error"}`,
      traded: false,
      retry: "soon",
    };
  }

  // Leg 2: Buy back WSOL -> Token (round trip)
  let buyTxHash = "";
  const receivedWsol = sellOrder.outAmount ? BigInt(sellOrder.outAmount) : 0n;
  if (receivedWsol > 0n) {
    try {
      await new Promise((r) => setTimeout(r, 2000)); // wait for slot confirmation
      const buyOrder = await getJupiterOrder(WSOL_MINT, input.token, receivedWsol, walletAddr, 100);
      if (buyOrder.ok && buyOrder.transaction) {
        const buyTxBuf = Buffer.from(buyOrder.transaction, "base64");
        const buyVtx = await VersionedTransaction.deserialize(buyTxBuf);
        await buyVtx.sign([keypair]);
        const buySigned = Buffer.from(buyVtx.serialize()).toString("base64");
        const buyExec = await executeJupiterSwap(buySigned, buyOrder.requestId);
        if (buyExec.ok && buyExec.txHash) {
          buyTxHash = buyExec.txHash;
        }
      }
    } catch {
      /* buyback optional */
    }
  }

  if (input.onBumpCycleIndex) {
    await input.onBumpCycleIndex((input.cycleIndex ?? 0) + 1);
  }

  const lines = [
    `🎉 Solana Inactivity Swap completed for ${input.symbol}!`,
    `Sold $${picked.clip.usd.toFixed(2)} ${input.symbol}.`,
    buyTxHash ? `Bought back ${input.symbol}.` : `Proceeds swapped to WSOL.`,
    `Sell Tx: https://solscan.io/tx/${sellTxHash}`,
  ];
  if (buyTxHash) {
    lines.push(`Buy Tx: https://solscan.io/tx/${buyTxHash}`);
  }

  return {
    text: lines.join("\n"),
    traded: true,
    retry: "interval",
    txHash: sellTxHash,
  };
}
