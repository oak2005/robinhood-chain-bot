import { ethers } from "ethers";
import { Connection, PublicKey } from "@solana/web3.js";

const SOLANA_RPC = process.env.SOLANA_RPC_URL || "https://api.mainnet.solana.com";
const HIRO_API = "https://api.hiro.so";
const ROBINHOOD_RPC = "https://rpc.robinhoodchain.com";

const WSOL_MINT = "So11111111111111111111111111111111111111112";
const STX_CONTRACT = "SP000000000000000000002Q6VF78.stx";

export interface TokenBalanceInfo {
  chain: string;
  tokenAddress: string;
  symbol: string;
  amount: string;
  rawAmount?: string;
  decimals: number;
  priceUsd: number | null;
  balanceUsd: number | null;
}

export interface WalletBalanceInfo {
  chain: string;
  address: string;
  nativeSymbol: string;
  nativeAmount: string;
  nativePriceUsd: number | null;
  nativeBalanceUsd: number | null;
  tokens: TokenBalanceInfo[];
}

// Cached price lookups with a 30-second TTL
const priceCache = new Map<string, { price: number; ts: number }>();

export async function fetchTokenPriceUsd(addressOrMint: string): Promise<number | null> {
  const key = addressOrMint.trim();
  const cached = priceCache.get(key);
  if (cached && Date.now() - cached.ts < 30_000) {
    return cached.price;
  }
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${key}`, {
      signal: AbortSignal.timeout(6000),
    });
    if (res.ok) {
      const data = await res.json();
      const pair = data.pairs?.[0];
      const price = pair?.priceUsd ? parseFloat(pair.priceUsd) : null;
      if (price != null && !isNaN(price) && price > 0) {
        priceCache.set(key, { price, ts: Date.now() });
        return price;
      }
    }
  } catch {}

  // Fallback for Solana tokens: quote against USDC via Jupiter v1
  try {
    const isSolanaMint = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(key);
    if (isSolanaMint) {
      const usdcMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
      if (key === usdcMint) return 1.0;
      const res = await fetch(`https://api.jup.ag/swap/v1/quote?inputMint=${key}&outputMint=${usdcMint}&amount=1000000&slippageBps=200`, {
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.outAmount) {
          const price = Number(data.outAmount) / 1e6;
          if (price > 0) {
            priceCache.set(key, { price, ts: Date.now() });
            return price;
          }
        }
      }
    }
  } catch {}

  return null;
}

export async function readSolanaWalletBalances(
  address: string,
  tokens: Array<{ token: string; symbol?: string }> = [],
): Promise<WalletBalanceInfo> {
  const conn = new Connection(SOLANA_RPC, "confirmed");
  const pubkey = new PublicKey(address);

  let solLamports = 0n;
  try {
    const raw = await conn.getBalance(pubkey);
    solLamports = BigInt(raw);
  } catch {}

  const solAmount = Number(solLamports) / 1e9;
  const solPrice = await fetchTokenPriceUsd(WSOL_MINT);
  const solUsd = solPrice != null ? solAmount * solPrice : null;

  // Read SPL Token accounts
  const tokenBalances: TokenBalanceInfo[] = [];
  let parsedAccounts: Array<{ mint: string; amount: string; rawAmount: string; decimals: number }> = [];

  try {
    // Check standard Token program
    const tokenAccounts = await conn.getParsedTokenAccountsByOwner(pubkey, {
      programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
    });
    for (const item of tokenAccounts.value) {
      const info = item.account.data.parsed?.info;
      if (info?.mint) {
        parsedAccounts.push({
          mint: info.mint,
          amount: info.tokenAmount?.uiAmountString || "0",
          rawAmount: info.tokenAmount?.amount || "0",
          decimals: info.tokenAmount?.decimals || 0,
        });
      }
    }
  } catch {}

  try {
    // Check Token-2022 program
    const token2022Accounts = await conn.getParsedTokenAccountsByOwner(pubkey, {
      programId: new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"),
    });
    for (const item of token2022Accounts.value) {
      const info = item.account.data.parsed?.info;
      if (info?.mint) {
        parsedAccounts.push({
          mint: info.mint,
          amount: info.tokenAmount?.uiAmountString || "0",
          rawAmount: info.tokenAmount?.amount || "0",
          decimals: info.tokenAmount?.decimals || 0,
        });
      }
    }
  } catch {}

  for (const t of tokens) {
    const mint = t.token.trim();
    const found = parsedAccounts.find((p) => p.mint === mint);
    const amountStr = found ? found.amount : "0";
    const rawAmount = found ? found.rawAmount : "0";
    const decimals = found ? found.decimals : 9;
    const price = await fetchTokenPriceUsd(mint);
    const numAmount = parseFloat(amountStr) || 0;
    const balanceUsd = price != null ? numAmount * price : null;

    tokenBalances.push({
      chain: "solana",
      tokenAddress: mint,
      symbol: t.symbol || "SPL",
      amount: amountStr,
      rawAmount,
      decimals,
      priceUsd: price,
      balanceUsd,
    });
  }

  return {
    chain: "solana",
    address,
    nativeSymbol: "SOL",
    nativeAmount: solAmount.toFixed(4),
    nativePriceUsd: solPrice,
    nativeBalanceUsd: solUsd,
    tokens: tokenBalances,
  };
}

export async function readStacksWalletBalances(
  address: string,
  tokens: Array<{ token: string; symbol?: string }> = [],
): Promise<WalletBalanceInfo> {
  let stxAmount = 0;
  let fungibleTokens: Record<string, { balance: string }> = {};

  try {
    const res = await fetch(`${HIRO_API}/extended/v1/address/${address}/balances`, {
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      const data = await res.json();
      if (data.stx?.balance) {
        stxAmount = Number(BigInt(data.stx.balance)) / 1e6;
      }
      fungibleTokens = data.fungible_tokens || {};
    }
  } catch {}

  const stxPrice = await fetchTokenPriceUsd(STX_CONTRACT).catch(() => null);
  const stxUsd = stxPrice != null ? stxAmount * stxPrice : null;

  const tokenBalances: TokenBalanceInfo[] = [];

  for (const t of tokens) {
    const contractId = t.token.trim();
    // Look up in fungible_tokens (keys are like: 'SP3...token::asset-name')
    let rawBalance = "0";
    for (const [key, val] of Object.entries(fungibleTokens)) {
      if (key.startsWith(contractId) || key.toLowerCase().includes(contractId.toLowerCase())) {
        rawBalance = val.balance || "0";
        break;
      }
    }

    const price = await fetchTokenPriceUsd(contractId);
    // Usually 6 decimals for SIP-010 or 8
    const numAmount = Number(BigInt(rawBalance || "0")) / 1e6;
    const balanceUsd = price != null ? numAmount * price : null;

    tokenBalances.push({
      chain: "stacks",
      tokenAddress: contractId,
      symbol: t.symbol || "SIP-010",
      amount: numAmount.toLocaleString("en-US", { maximumFractionDigits: 6 }),
      decimals: 6,
      priceUsd: price,
      balanceUsd,
    });
  }

  return {
    chain: "stacks",
    address,
    nativeSymbol: "STX",
    nativeAmount: stxAmount.toFixed(4),
    nativePriceUsd: stxPrice,
    nativeBalanceUsd: stxUsd,
    tokens: tokenBalances,
  };
}

export async function readRobinhoodWalletBalances(
  address: string,
  tokens: Array<{ token: string; symbol?: string }> = [],
): Promise<WalletBalanceInfo> {
  const provider = new ethers.JsonRpcProvider(ROBINHOOD_RPC, 4663, { staticNetwork: true });

  let ethAmount = "0.0000";
  try {
    const bal = await provider.getBalance(address);
    ethAmount = ethers.formatEther(bal);
  } catch {}

  const tokenBalances: TokenBalanceInfo[] = [];
  const erc20Abi = [
    "function balanceOf(address) view returns (uint256)",
    "function decimals() view returns (uint8)",
    "function symbol() view returns (string)",
  ];

  for (const t of tokens) {
    let tokenBal = "0";
    let decimals = 18;
    let sym = t.symbol || "TOKEN";

    try {
      const contract = new ethers.Contract(t.token, erc20Abi, provider);
      const [raw, dec] = await Promise.all([
        contract.balanceOf(address),
        contract.decimals().catch(() => 18),
      ]);
      decimals = dec;
      tokenBal = ethers.formatUnits(raw, dec);
    } catch {}

    const price = await fetchTokenPriceUsd(t.token);
    const numAmount = parseFloat(tokenBal) || 0;
    const balanceUsd = price != null ? numAmount * price : null;

    tokenBalances.push({
      chain: "robinhood",
      tokenAddress: t.token,
      symbol: sym,
      amount: numAmount.toLocaleString("en-US", { maximumFractionDigits: 6 }),
      decimals,
      priceUsd: price,
      balanceUsd,
    });
  }

  return {
    chain: "robinhood",
    address,
    nativeSymbol: "ETH",
    nativeAmount: parseFloat(ethAmount).toFixed(4),
    nativePriceUsd: null,
    nativeBalanceUsd: null,
    tokens: tokenBalances,
  };
}

export async function readUnifiedWalletBalances(
  chain: string,
  address: string,
  tokens: Array<{ token: string; symbol?: string }> = [],
): Promise<WalletBalanceInfo> {
  if (chain === "solana") return readSolanaWalletBalances(address, tokens);
  if (chain === "stacks") return readStacksWalletBalances(address, tokens);
  return readRobinhoodWalletBalances(address, tokens);
}
