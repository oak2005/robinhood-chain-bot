import fs from "node:fs";
import {
  privateKeyToAddress,
  makeContractCall,
  broadcastTransaction,
  contractPrincipalCV,
  standardPrincipalCV,
  boolCV,
  noneCV,
  uintCV,
  PostConditionMode,
} from "@stacks/transactions";
import { chooseTradeUsd, describeClip } from "./size.ts";
import { readStacksWalletBalances, fetchTokenPriceUsd } from "./balance-reader.ts";

const HIRO_API = process.env.HIRO_API_URL || "https://api.hiro.so";
const ROOT = process.env.STILLMARK_ROOT || (fs.existsSync("/workspace") ? "/workspace" : process.cwd());
const MAX_LOSS_BPS = 800; // 8.00% max spread protection
const DEFAULT_FEE = 25000n; // 0.025 STX for fast execution on Stacks

// Bitflow DEX Aggregator on Stacks mainnet
const BITFLOW_ROUTER_ADDRESS = "SP3B8F1ERXWHQ7FSZB6RSJA1S12DBQZZNYYHTPBFF";
const BITFLOW_ROUTER_CONTRACT = "agg-u-v-1-sh-0";
const BITFLOW_VELAR_ADAPTER = "agg-velar-univ2-adapter-v-1-1";

export interface StacksCycleResult {
  text: string;
  traded: boolean;
  halt?: boolean;
  retry: "soon" | "interval";
  txHash?: string;
}

export interface StacksRecovery {
  token: string;
  symbol: string;
  stxAmount: string;
  sellTxHash: string;
  tokenAmountSold: string;
  at: number;
}

function recoveryPath(walletAddr: string): string {
  const clean = walletAddr.replace(/[^a-zA-Z0-9]/g, "");
  return `${ROOT}/data/recovery-stacks-${clean}.json`;
}

function readRecovery(walletAddr: string, token: string): StacksRecovery | null {
  try {
    const p = recoveryPath(walletAddr);
    if (!fs.existsSync(p)) return null;
    const raw = JSON.parse(fs.readFileSync(p, "utf8")) as StacksRecovery;
    if (!raw.sellTxHash || raw.token !== token) return null;
    return raw;
  } catch {
    return null;
  }
}

function writeRecovery(walletAddr: string, value: StacksRecovery) {
  try {
    fs.mkdirSync(`${ROOT}/data`, { recursive: true });
    fs.writeFileSync(recoveryPath(walletAddr), JSON.stringify(value));
  } catch {}
}

export function clearRecovery(walletAddr: string) {
  try {
    const p = recoveryPath(walletAddr);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch {}
}

export function resolveSenderKey(
  privateKeyHex: string,
  expectedAddress?: string,
): { key: string; address: string } {
  const cleanHex = privateKeyHex.trim().replace(/^0x/, "");
  let uncompressedAddr = "";
  let compressedAddr = "";
  try {
    uncompressedAddr = privateKeyToAddress(cleanHex);
  } catch {}
  try {
    if (cleanHex.length === 64) {
      compressedAddr = privateKeyToAddress(cleanHex + "01");
    }
  } catch {}

  if (expectedAddress) {
    if (expectedAddress === compressedAddr) {
      return { key: cleanHex + "01", address: compressedAddr };
    }
    if (expectedAddress === uncompressedAddr) {
      return { key: cleanHex, address: uncompressedAddr };
    }
  }
  return { key: cleanHex, address: uncompressedAddr || compressedAddr || expectedAddress || "" };
}

export interface StacksPool {
  type: "velar" | "stxcity";
  contractAddress: string;
  contractName: string;
  feesAddress?: string;
  feesName?: string;
  wstxAddress: string;
  wstxName: string;
  tokenAddress: string;
  tokenName: string;
  reserveStx: bigint;
  reserveToken: bigint;
  tokenIsToken0: boolean;
}

export async function findStacksPool(tokenContractId: string): Promise<StacksPool | null> {
  const trimmed = tokenContractId.trim();
  const [tokAddr, tokName] = trimmed.split(".");
  if (!tokAddr || !tokName) return null;

  // 1. Try Velar API
  try {
    const res = await fetch(`https://api.velar.co/pools/SP1Y5YSTAHZ88XYK1VPDH24GY0HPX5J4JECTMY4A1.wstx/${trimmed}`, {
      signal: AbortSignal.timeout(6000),
    });
    if (res.ok) {
      const data = await res.json();
      if (data && data.lpTokenContractAddress) {
        const lp: string = data.lpTokenContractAddress;
        const poolContract = lp.replace("univ2-lp-token", "univ2-pool");
        const feesContract = lp.replace("univ2-lp-token", "univ2-fees");
        const [poolAddr, poolName] = poolContract.split(".");
        const [feesAddr, feesName] = feesContract.split(".");
        const [wstxAddr, wstxName] = (data.token0ContractAddress || "SP1Y5YSTAHZ88XYK1VPDH24GY0HPX5J4JECTMY4A1.wstx").split(".");
        const [tokenAddr, tokenName] = (data.token1ContractAddress || trimmed).split(".");
        const isTok0 = data.token0ContractAddress === trimmed;

        return {
          type: "velar",
          contractAddress: poolAddr,
          contractName: poolName,
          feesAddress: feesAddr,
          feesName: feesName,
          wstxAddress: wstxAddr,
          wstxName: wstxName,
          tokenAddress: tokenAddr,
          tokenName: tokenName,
          reserveStx: BigInt(isTok0 ? data.stats?.reserve1 || 0 : data.stats?.reserve0 || 0),
          reserveToken: BigInt(isTok0 ? data.stats?.reserve0 || 0 : data.stats?.reserve1 || 0),
          tokenIsToken0: isTok0,
        };
      }
    }
  } catch {}

  // 2. Fallback: Check Hiro API token holders for univ2-pool-v1_0_0-...
  try {
    const res = await fetch(`${HIRO_API}/extended/v1/tokens/ft/${trimmed}::${tokName}/holders?limit=50`, {
      signal: AbortSignal.timeout(6000),
    });
    if (res.ok) {
      const data = await res.json();
      const poolHolder = (data.results || []).find((h: { address: string }) =>
        h.address.includes(".univ2-pool-v1_0_0-"),
      );
      if (poolHolder) {
        const [pAddr, pName] = poolHolder.address.split(".");
        const poolRes = await fetch(`${HIRO_API}/v2/contracts/call-read/${pAddr}/${pName}/get-pool`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sender: tokAddr, arguments: [] }),
          signal: AbortSignal.timeout(6000),
        });
        if (poolRes.ok) {
          const poolData = await poolRes.json();
          if (poolData.okay && poolData.result) {
            const { hexToCV, cvToJSON } = await import("@stacks/transactions");
            const parsed = cvToJSON(hexToCV(poolData.result));
            const val = parsed?.value?.value;
            if (val) {
              const r0 = BigInt(val.reserve0?.value || 0);
              const r1 = BigInt(val.reserve1?.value || 0);
              const t0 = val.token0?.value || "";
              const t1 = val.token1?.value || "";
              const fees = val.fees?.value || "";
              const [feesAddr, feesName] = fees.split(".");
              const isTok0 = t0.toLowerCase() === trimmed.toLowerCase();
              const wstxFull = isTok0 ? t1 : t0;
              const [wstxAddr, wstxName] = wstxFull.split(".");

              return {
                type: "velar",
                contractAddress: pAddr,
                contractName: pName,
                feesAddress: feesAddr,
                feesName: feesName,
                wstxAddress: wstxAddr,
                wstxName: wstxName,
                tokenAddress: tokAddr,
                tokenName: tokName,
                reserveStx: isTok0 ? r1 : r0,
                reserveToken: isTok0 ? r0 : r1,
                tokenIsToken0: isTok0,
              };
            }
          }
        }
      }
    }
  } catch {}

  // 3. Fallback: STXCity bonding curve if not graduated
  if (tokName.includes("-stxcity")) {
    try {
      const res = await fetch(`${HIRO_API}/v2/contracts/call-read/${tokAddr}/${tokName}-dex/get-tradable`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sender: tokAddr, arguments: [] }),
        signal: AbortSignal.timeout(6000),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.okay && data.result) {
          const { hexToCV, cvToJSON } = await import("@stacks/transactions");
          const parsed = cvToJSON(hexToCV(data.result));
          if (parsed?.value?.value === true) {
            return {
              type: "stxcity",
              contractAddress: tokAddr,
              contractName: `${tokName}-dex`,
              wstxAddress: "SP1Y5YSTAHZ88XYK1VPDH24GY0HPX5J4JECTMY4A1",
              wstxName: "wstx",
              tokenAddress: tokAddr,
              tokenName: tokName,
              reserveStx: 0n,
              reserveToken: 0n,
              tokenIsToken0: false,
            };
          }
        }
      }
    } catch {}
  }

  return null;
}

export async function fetchTxStatus(txHash: string): Promise<string> {
  const clean = txHash.trim();
  const id = clean.startsWith("0x") ? clean : `0x${clean}`;
  try {
    const res = await fetch(`${HIRO_API}/extended/v1/tx/${id}`, {
      signal: AbortSignal.timeout(6000),
    });
    if (res.ok) {
      const data = await res.json();
      return data.tx_status || "unknown";
    }
  } catch {}
  return "unknown";
}

async function getNextNonce(address: string): Promise<bigint> {
  try {
    const res = await fetch(`${HIRO_API}/extended/v1/address/${address}/nonces`, {
      signal: AbortSignal.timeout(6000),
    });
    if (res.ok) {
      const data = await res.json();
      if (typeof data.possible_next_nonce === "number") {
        return BigInt(data.possible_next_nonce);
      }
    }
  } catch {}
  return 0n;
}

async function executeBuyLeg(params: {
  keyToUse: string;
  walletAddr: string;
  token: string;
  symbol: string;
  pool: StacksPool;
  stxAmountMicro: bigint;
}): Promise<{ txHash: string; boughtFormatted: string; routerUsed: string }> {
  const nonce = await getNextNonce(params.walletAddr);
  let buyAmountMicro = params.stxAmountMicro;

  if (buyAmountMicro <= 0n) {
    const balInfo = await readStacksWalletBalances(params.walletAddr);
    const stxBal = parseFloat(balInfo.nativeAmount) || 0;
    const safeStx = Math.max(0, stxBal - 0.05);
    buyAmountMicro = BigInt(Math.floor(safeStx * 1e6));
  }

  if (buyAmountMicro <= 0n) {
    throw new Error("No STX available for buyback.");
  }

  let tx;
  let routerUsed = "Bitflow Aggregator";

  if (params.pool.type === "velar") {
    try {
      // Primary: Route via Bitflow DEX Aggregator
      tx = await makeContractCall({
        contractAddress: BITFLOW_ROUTER_ADDRESS,
        contractName: BITFLOW_ROUTER_CONTRACT,
        functionName: "swap-u",
        functionArgs: [
          contractPrincipalCV(BITFLOW_ROUTER_ADDRESS, BITFLOW_VELAR_ADAPTER),
          contractPrincipalCV(params.pool.contractAddress, params.pool.contractName),
          contractPrincipalCV(params.pool.feesAddress || params.pool.contractAddress, params.pool.feesName || "univ2-fees-v1_0_0-0003"),
          boolCV(true),  // x-for-y: token0 (wstx) for token1 (token)
          boolCV(true),  // is-stx-in
          boolCV(false), // is-stx-out
          contractPrincipalCV(params.pool.wstxAddress, params.pool.wstxName),
          contractPrincipalCV(params.pool.tokenAddress, params.pool.tokenName),
          uintCV(buyAmountMicro),
          uintCV(1n),    // min received
          uintCV(99999999n), // deadline
          uintCV(0n),    // agg-fee-amount
          uintCV(0n),    // agg-fee-max
          standardPrincipalCV(params.walletAddr),
          noneCV(),
        ],
        senderKey: params.keyToUse,
        network: "mainnet",
        postConditionMode: PostConditionMode.Allow,
        fee: DEFAULT_FEE,
        nonce,
      });
    } catch {
      // Fallback: Direct Velar pool call
      routerUsed = "Velar Pool";
      tx = await makeContractCall({
        contractAddress: params.pool.contractAddress,
        contractName: params.pool.contractName,
        functionName: "swap",
        functionArgs: [
          contractPrincipalCV(params.pool.wstxAddress, params.pool.wstxName),
          contractPrincipalCV(params.pool.tokenAddress, params.pool.tokenName),
          contractPrincipalCV(params.pool.feesAddress || params.pool.contractAddress, params.pool.feesName || "univ2-fees-v1_0_0-0003"),
          uintCV(buyAmountMicro),
          uintCV(1n),
        ],
        senderKey: params.keyToUse,
        network: "mainnet",
        postConditionMode: PostConditionMode.Allow,
        fee: DEFAULT_FEE,
        nonce,
      });
    }
  } else {
    routerUsed = "STX.City DEX";
    tx = await makeContractCall({
      contractAddress: params.pool.contractAddress,
      contractName: params.pool.contractName,
      functionName: "buy",
      functionArgs: [
        contractPrincipalCV(params.pool.tokenAddress, params.pool.tokenName),
        uintCV(buyAmountMicro),
      ],
      senderKey: params.keyToUse,
      network: "mainnet",
      postConditionMode: PostConditionMode.Allow,
      fee: DEFAULT_FEE,
      nonce,
    });
  }

  const broadcastRes = await broadcastTransaction({ transaction: tx, network: "mainnet" });
  if ("error" in broadcastRes && broadcastRes.error) {
    throw new Error((broadcastRes.error as string) + (broadcastRes.reason ? `: ${broadcastRes.reason}` : ""));
  }

  const rawTxid = (broadcastRes as { txid: string }).txid || tx.txid();
  const txHash = rawTxid.startsWith("0x") ? rawTxid : `0x${rawTxid}`;

  let boughtUnits = 0n;
  if (params.pool.reserveStx > 0n && params.pool.reserveToken > 0n) {
    const buyInAdj = (buyAmountMicro * 9970n) / 10000n;
    boughtUnits = (buyInAdj * params.pool.reserveToken) / (params.pool.reserveStx + buyInAdj);
  }
  const boughtFormatted = (Number(boughtUnits) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 6 });

  return { txHash, boughtFormatted, routerUsed };
}

export async function previewStacks(input: {
  address: string;
  token: string;
  symbol: string;
  cycleIndex?: number;
  tradeRange?: string;
}): Promise<{ text: string }> {
  try {
    const balInfo = await readStacksWalletBalances(input.address, [
      { token: input.token, symbol: input.symbol },
    ]);
    const stxAmount = parseFloat(balInfo.nativeAmount) || 0;
    const tokenBal = balInfo.tokens[0];
    const tokenAmount = parseFloat(tokenBal?.amount.replace(/,/g, "") || "0");
    const tokenPrice = tokenBal?.priceUsd || (await fetchTokenPriceUsd(input.token));
    const tokenUsd = tokenBal?.balanceUsd != null ? tokenBal.balanceUsd : tokenPrice ? tokenAmount * tokenPrice : 0;

    const shortAddr = input.token.length > 12 ? `${input.token.slice(0, 6)}…${input.token.slice(-4)}` : input.token;
    const lines: string[] = [
      `Stacks: ${input.symbol} (${shortAddr})`,
      `STX Balance: ${balInfo.nativeAmount} STX${balInfo.nativeBalanceUsd ? ` ($${balInfo.nativeBalanceUsd.toFixed(2)})` : ""}`,
      `${input.symbol} Balance: ${tokenAmount.toLocaleString("en-US", { maximumFractionDigits: 6 })} ($${tokenUsd.toFixed(2)})`,
    ];

    if (stxAmount < 0.05) {
      lines.push("⚠️ Low STX for network fees. Fund wallet with at least 0.1 STX.");
    }

    const recovery = readRecovery(input.address, input.token);
    if (recovery) {
      const status = await fetchTxStatus(recovery.sellTxHash);
      if (status === "pending") {
        lines.push(`⏳ Active sell confirming in mempool (${recovery.sellTxHash.slice(0, 10)}…). Buyback will execute on confirmation.`);
        return { text: lines.join("\n") };
      }
      if (status === "success") {
        lines.push(`✅ Prior sell confirmed. Next cycle will execute buyback.`);
        return { text: lines.join("\n") };
      }
    }

    const pool = await findStacksPool(input.token);
    if (!pool) {
      lines.push(`⚠️ No liquidity pool found on Stacks for ${input.symbol}.`);
      return { text: lines.join("\n") };
    }

    const picked = chooseTradeUsd(tokenUsd, input.cycleIndex ?? 0, input.tradeRange);
    if (!picked.ok) {
      lines.push(picked.text);
      return { text: lines.join("\n") };
    }

    lines.push(describeClip(picked.clip));

    if (pool.type === "velar" && pool.reserveStx > 0n && pool.reserveToken > 0n) {
      const tokenDecimals = tokenBal?.decimals ?? 6;
      const rawUnits = BigInt(Math.max(1, Math.floor((picked.clip.usd / (tokenPrice || 1)) * 10 ** tokenDecimals)));
      const amtInAdj = (rawUnits * 9970n) / 10000n;
      const stxOut = (amtInAdj * pool.reserveStx) / (pool.reserveToken + amtInAdj);
      const buyInAdj = (stxOut * 9970n) / 10000n;
      const backTokens = (buyInAdj * pool.reserveToken) / (pool.reserveStx + buyInAdj);
      const lossBps = rawUnits > backTokens ? Number(((rawUnits - backTokens) * 10000n) / rawUnits) : 0;
      const costPct = Math.max(0, lossBps / 100);

      lines.push(
        `Router: Bitflow Aggregator (agg-u-v-1-sh-0)`,
      );
      lines.push(
        `Quoted: Sell ${(Number(rawUnits) / 10 ** tokenDecimals).toLocaleString()} ${input.symbol} → ${(Number(stxOut) / 1e6).toFixed(4)} STX. Estimated round trip loss: ${costPct.toFixed(2)}%.`,
      );
    }

    lines.push(`Stacks swap ready: $${picked.clip.usd.toFixed(2)} planned cycle.`);
    return { text: lines.join("\n") };
  } catch (error) {
    return {
      text: `Stacks preview failed: ${error instanceof Error ? error.message : "Error reading Stacks"}`,
    };
  }
}

export async function runStacksCycle(input: {
  privateKey: string;
  token: string;
  symbol: string;
  walletAddress: string;
  cycleIndex?: number;
  tradeRange?: string;
  onBumpCycleIndex?: (next: number) => Promise<void> | void;
}): Promise<StacksCycleResult> {
  const resolved = resolveSenderKey(input.privateKey, input.walletAddress);
  const walletAddr = input.walletAddress || resolved.address;
  if (!resolved.key) {
    return {
      text: "Stacks key error: Invalid private key.",
      traded: false,
      halt: true,
      retry: "interval",
    };
  }

  // 1. Check recovery for open sell
  const recovery = readRecovery(walletAddr, input.token);
  if (recovery) {
    const status = await fetchTxStatus(recovery.sellTxHash);
    if (status === "pending") {
      return {
        text: `Sell ${recovery.sellTxHash} is confirming on Stacks. Buyback will execute as soon as it confirms on-chain.`,
        traded: false,
        retry: "soon",
      };
    }
    if (status === "success") {
      const pool = await findStacksPool(input.token);
      if (pool) {
        try {
          const buyRes = await executeBuyLeg({
            keyToUse: resolved.key,
            walletAddr,
            token: input.token,
            symbol: input.symbol,
            pool,
            stxAmountMicro: BigInt(recovery.stxAmount || "0"),
          });
          clearRecovery(walletAddr);
          if (input.onBumpCycleIndex) {
            await input.onBumpCycleIndex((input.cycleIndex ?? 0) + 1);
          }
          return {
            text: [
              `${input.symbol} round trip completed on Stacks (${buyRes.routerUsed}).`,
              `Sold ${recovery.tokenAmountSold} ${input.symbol}.`,
              `Bought back ${buyRes.boughtFormatted} ${input.symbol}.`,
              `Sell`,
              recovery.sellTxHash,
              `Buy`,
              buyRes.txHash,
            ].join("\n"),
            traded: true,
            retry: "interval",
            txHash: buyRes.txHash,
          };
        } catch (buyErr) {
          return {
            text: `Sell ${recovery.sellTxHash} confirmed on Stacks but buyback broadcast failed: ${buyErr instanceof Error ? buyErr.message : "Error"}. Will retry buyback shortly.`,
            traded: false,
            retry: "soon",
          };
        }
      }
    } else if (status === "abort_by_response" || status === "abort_by_post_condition") {
      clearRecovery(walletAddr);
    }
  }

  // 2. Balances & Gas Guards
  const balInfo = await readStacksWalletBalances(walletAddr, [{ token: input.token, symbol: input.symbol }]);
  const stxAmount = parseFloat(balInfo.nativeAmount) || 0;

  if (stxAmount < 0.05) {
    return {
      text: `Not enough STX for gas fee (${stxAmount.toFixed(4)} STX). Need at least 0.05 STX for Stacks network transaction fees.`,
      traded: false,
      retry: "interval",
    };
  }

  const tokenBal = balInfo.tokens[0];
  const tokenAmount = parseFloat(tokenBal?.amount.replace(/,/g, "") || "0");
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

  const pool = await findStacksPool(input.token);
  if (!pool) {
    return {
      text: `No active liquidity pool found on Stacks for ${input.symbol}. Swap skipped.`,
      traded: false,
      retry: "interval",
    };
  }

  const picked = chooseTradeUsd(tokenUsd, input.cycleIndex ?? 0, input.tradeRange);
  if (!picked.ok) {
    return {
      text: picked.text,
      traded: false,
      retry: "interval",
    };
  }

  const tokenDecimals = tokenBal?.decimals ?? 6;
  let amountIn: bigint;
  if (tokenPrice > 0) {
    amountIn = BigInt(Math.max(1, Math.floor((picked.clip.usd / tokenPrice) * 10 ** tokenDecimals)));
  } else {
    amountIn = rawBalance > 0n ? rawBalance / 4n : 1000n;
  }
  if (rawBalance > 0n && amountIn > rawBalance) {
    amountIn = rawBalance;
  }
  if (amountIn <= 0n) amountIn = 1n;

  let expectedStxOut = 0n;
  let expectedTokensBack = 0n;

  if (pool.type === "velar" && pool.reserveStx > 0n && pool.reserveToken > 0n) {
    const amtInAdj = (amountIn * 9970n) / 10000n;
    expectedStxOut = (amtInAdj * pool.reserveStx) / (pool.reserveToken + amtInAdj);
    const buyInAdj = (expectedStxOut * 9970n) / 10000n;
    expectedTokensBack = (buyInAdj * pool.reserveToken) / (pool.reserveStx + buyInAdj);

    const lossBps = amountIn > expectedTokensBack ? Number(((amountIn - expectedTokensBack) * 10000n) / amountIn) : 0;
    const costPct = Math.max(0, lossBps / 100);

    if (lossBps > MAX_LOSS_BPS) {
      return {
        text: `${input.symbol} spread is too wide on Stacks (quoted round-trip loss ${costPct.toFixed(2)}%, max allowed is 8.00%). Swap skipped to protect bag.`,
        traded: false,
        retry: "soon",
      };
    }
  }

  // 3. Leg 1: Sell Token -> STX (via Bitflow Aggregator)
  const nonce = await getNextNonce(walletAddr);
  const minStxOut = expectedStxOut > 0n ? (expectedStxOut * 92n) / 100n : 1n;

  let tx;
  let routerUsed = "Bitflow Aggregator";

  if (pool.type === "velar") {
    try {
      // Primary: Bitflow DEX Aggregator
      tx = await makeContractCall({
        contractAddress: BITFLOW_ROUTER_ADDRESS,
        contractName: BITFLOW_ROUTER_CONTRACT,
        functionName: "swap-u",
        functionArgs: [
          contractPrincipalCV(BITFLOW_ROUTER_ADDRESS, BITFLOW_VELAR_ADAPTER),
          contractPrincipalCV(pool.contractAddress, pool.contractName),
          contractPrincipalCV(pool.feesAddress || pool.contractAddress, pool.feesName || "univ2-fees-v1_0_0-0003"),
          boolCV(false), // x-for-y: token1 (FlatEarth) for token0 (wstx)
          boolCV(false), // is-stx-in
          boolCV(true),  // is-stx-out
          contractPrincipalCV(pool.tokenAddress, pool.tokenName),
          contractPrincipalCV(pool.wstxAddress, pool.wstxName),
          uintCV(amountIn),
          uintCV(minStxOut),
          uintCV(99999999n), // deadline
          uintCV(0n), // agg-fee-amount
          uintCV(0n), // agg-fee-max
          standardPrincipalCV(walletAddr),
          noneCV(),
        ],
        senderKey: resolved.key,
        network: "mainnet",
        postConditionMode: PostConditionMode.Allow,
        fee: DEFAULT_FEE,
        nonce,
      });
    } catch {
      // Direct pool fallback
      routerUsed = "Velar Pool";
      tx = await makeContractCall({
        contractAddress: pool.contractAddress,
        contractName: pool.contractName,
        functionName: "swap",
        functionArgs: [
          contractPrincipalCV(pool.tokenAddress, pool.tokenName),
          contractPrincipalCV(pool.wstxAddress, pool.wstxName),
          contractPrincipalCV(pool.feesAddress || pool.contractAddress, pool.feesName || "univ2-fees-v1_0_0-0003"),
          uintCV(amountIn),
          uintCV(minStxOut),
        ],
        senderKey: resolved.key,
        network: "mainnet",
        postConditionMode: PostConditionMode.Allow,
        fee: DEFAULT_FEE,
        nonce,
      });
    }
  } else {
    routerUsed = "STX.City DEX";
    tx = await makeContractCall({
      contractAddress: pool.contractAddress,
      contractName: pool.contractName,
      functionName: "sell",
      functionArgs: [
        contractPrincipalCV(pool.tokenAddress, pool.tokenName),
        uintCV(amountIn),
      ],
      senderKey: resolved.key,
      network: "mainnet",
      postConditionMode: PostConditionMode.Allow,
      fee: DEFAULT_FEE,
      nonce,
    });
  }

  const broadcastRes = await broadcastTransaction({ transaction: tx, network: "mainnet" });
  if ("error" in broadcastRes && broadcastRes.error) {
    const errDesc = (broadcastRes.error as string) + (broadcastRes.reason ? `: ${broadcastRes.reason}` : "");
    return {
      text: `Stacks sell broadcast failed (${routerUsed}): ${errDesc}.`,
      traded: false,
      retry: "soon",
    };
  }

  const rawTxid = (broadcastRes as { txid: string }).txid || tx.txid();
  const sellTxHash = rawTxid.startsWith("0x") ? rawTxid : `0x${rawTxid}`;
  const soldFormatted = (Number(amountIn) / 10 ** tokenDecimals).toLocaleString("en-US", { maximumFractionDigits: 6 });

  writeRecovery(walletAddr, {
    token: input.token,
    symbol: input.symbol,
    stxAmount: expectedStxOut > 0n ? expectedStxOut.toString() : "0",
    sellTxHash,
    tokenAmountSold: soldFormatted,
    at: Date.now(),
  });

  if (input.onBumpCycleIndex) {
    await input.onBumpCycleIndex((input.cycleIndex ?? 0) + 1);
  }

  return {
    text: [
      `Stacks Inactivity Swap broadcasted for ${input.symbol} (${routerUsed}).`,
      `Sold ${soldFormatted} ${input.symbol} (~$${picked.clip.usd.toFixed(2)}).`,
      `Target size: $${picked.clip.usd.toFixed(2)}.`,
      `STX Gas Balance: ${stxAmount.toFixed(4)} STX.`,
      `Sell`,
      sellTxHash,
      `Explorer: https://explorer.hiro.so/txid/${sellTxHash}?chain=mainnet`,
      `Buyback leg will execute once the sell confirms on-chain.`,
    ].join("\n"),
    traded: true,
    retry: "interval",
    txHash: sellTxHash,
  };
}
