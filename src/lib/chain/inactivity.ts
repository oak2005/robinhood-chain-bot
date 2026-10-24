import { ethers, FetchRequest } from "ethers";
import { Connection, PublicKey } from "@solana/web3.js";

const ROBINHOOD_RPC = "https://rpc.mainnet.chain.robinhood.com";
const SOLANA_RPC = process.env.SOLANA_RPC_URL || "https://api.mainnet.solana.com";

export interface InactivityResult {
  isInactive: boolean;
  elapsedSec: number;
  remainingSec: number;
  lastTradeSec?: number;
  lastTxHash?: string;
  source?: string;
  error?: string;
}

/**
 * Checks on-chain inactivity for an ERC-20 token on Robinhood Chain.
 * Scans recent blocks for Transfer events to see when the last on-chain swap or transfer occurred.
 */
export async function checkRobinhoodInactivity(
  tokenAddress: string,
  windowSec: number = 1800,
): Promise<InactivityResult> {
  const req = new FetchRequest(ROBINHOOD_RPC);
  req.timeout = 15_000;
  const provider = new ethers.JsonRpcProvider(req, 4663, { staticNetwork: true });

  try {
    const latestBlock = await provider.getBlock("latest");
    if (!latestBlock) throw new Error("Could not fetch latest block from Robinhood Chain");
    const nowSec = latestBlock.timestamp;

    const blocksToScan = Math.min(Math.ceil(windowSec * 12), 45_000);
    const fromBlock = Math.max(0, latestBlock.number - blocksToScan);

    const logs = await provider.getLogs({
      address: tokenAddress,
      fromBlock,
      toBlock: latestBlock.number,
    });

    if (!logs || logs.length === 0) {
      return {
        isInactive: true,
        elapsedSec: windowSec + 1,
        remainingSec: 0,
        source: "robinhood-zero-logs",
      };
    }

    const lastLog = logs[logs.length - 1];
    const lastBlock = await provider.getBlock(lastLog.blockNumber);
    const lastTradeSec = lastBlock ? lastBlock.timestamp : nowSec - Math.round((latestBlock.number - lastLog.blockNumber) * 0.1);
    const elapsedSec = Math.max(0, nowSec - lastTradeSec);
    const isInactive = elapsedSec >= windowSec;
    const remainingSec = Math.max(0, windowSec - elapsedSec);

    return {
      isInactive,
      elapsedSec,
      remainingSec,
      lastTradeSec,
      lastTxHash: lastLog.transactionHash,
      source: "robinhood-logs",
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.warn(`[checkRobinhoodInactivity] Warning: ${errorMsg}`);
    return {
      isInactive: false,
      elapsedSec: 0,
      remainingSec: 60,
      error: errorMsg,
      source: "robinhood-error",
    };
  }
}

/**
 * Checks on-chain inactivity for a Solana SPL token.
 */
export async function checkSolanaInactivity(
  tokenMint: string,
  windowSec: number = 1800,
): Promise<InactivityResult> {
  try {
    const connection = new Connection(SOLANA_RPC, { commitment: "confirmed" });
    const sigs = await connection.getSignaturesForAddress(new PublicKey(tokenMint), { limit: 1 });

    if (!sigs || sigs.length === 0 || !sigs[0].blockTime) {
      return {
        isInactive: true,
        elapsedSec: windowSec + 1,
        remainingSec: 0,
        source: "solana-zero-sigs",
      };
    }

    const lastTradeSec = Number(sigs[0].blockTime);
    const nowSec = Math.floor(Date.now() / 1000);
    const elapsedSec = Math.max(0, nowSec - lastTradeSec);
    const isInactive = elapsedSec >= windowSec;
    const remainingSec = Math.max(0, windowSec - elapsedSec);

    return {
      isInactive,
      elapsedSec,
      remainingSec,
      lastTradeSec,
      lastTxHash: sigs[0].signature,
      source: "solana-sigs",
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.warn(`[checkSolanaInactivity] Warning: ${errorMsg}`);
    return {
      isInactive: false,
      elapsedSec: 0,
      remainingSec: 60,
      error: errorMsg,
      source: "solana-error",
    };
  }
}

/**
 * Checks on-chain inactivity for a Stacks token contract.
 */
export async function checkStacksInactivity(
  tokenContract: string,
  windowSec: number = 1800,
): Promise<InactivityResult> {
  try {
    const res = await fetch(
      `https://api.mainnet.hiro.so/extended/v1/address/${encodeURIComponent(tokenContract)}/transactions?limit=1`,
      { signal: AbortSignal.timeout(10000) },
    );
    if (!res.ok) throw new Error(`Hiro API HTTP ${res.status}`);
    const data = (await res.json()) as { results?: Array<{ burn_block_time?: number; tx_id?: string }> };

    if (!data?.results || data.results.length === 0 || !data.results[0].burn_block_time) {
      return {
        isInactive: true,
        elapsedSec: windowSec + 1,
        remainingSec: 0,
        source: "stacks-zero-txs",
      };
    }

    const lastTradeSec = Number(data.results[0].burn_block_time);
    const nowSec = Math.floor(Date.now() / 1000);
    const elapsedSec = Math.max(0, nowSec - lastTradeSec);
    const isInactive = elapsedSec >= windowSec;
    const remainingSec = Math.max(0, windowSec - elapsedSec);

    return {
      isInactive,
      elapsedSec,
      remainingSec,
      lastTradeSec,
      lastTxHash: data.results[0].tx_id,
      source: "stacks-hiro",
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.warn(`[checkStacksInactivity] Warning: ${errorMsg}`);
    return {
      isInactive: false,
      elapsedSec: 0,
      remainingSec: 60,
      error: errorMsg,
      source: "stacks-error",
    };
  }
}

/**
 * Universal multi-chain inactivity checker.
 */
export async function checkTokenInactivity(input: {
  chain: string;
  token: string;
  intervalSec: number;
}): Promise<InactivityResult> {
  const chain = input.chain.toLowerCase();
  const windowSec = input.intervalSec > 0 ? input.intervalSec : 1800;

  if (chain === "robinhood") {
    return checkRobinhoodInactivity(input.token, windowSec);
  }
  if (chain === "solana") {
    return checkSolanaInactivity(input.token, windowSec);
  }
  if (chain === "stacks") {
    return checkStacksInactivity(input.token, windowSec);
  }

  return {
    isInactive: true,
    elapsedSec: windowSec + 1,
    remainingSec: 0,
    source: "unsupported-chain-fallback",
  };
}
