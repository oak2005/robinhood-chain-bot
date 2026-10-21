import { PAY_EVM, PAY_SOLANA } from "./public.ts";

const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const SOL_MINTS: Record<string, string> = {
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: "USDC",
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: "USDT",
};

const EVM_TOKENS = {
  base: [
    { symbol: "USDC", address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", decimals: 6 },
    { symbol: "USDT", address: "0xfde4c96c8593536e31f229ea8f37b2ada2699bb2", decimals: 6 },
  ],
  bsc: [
    { symbol: "USDT", address: "0x55d398326f99059ff775485246999027b3197955", decimals: 18 },
    { symbol: "USDC", address: "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d", decimals: 18 },
  ],
  robinhood: [
    { symbol: "USDG", address: "0x5fc5360d0400a0fd4f2af552add042d716f1d168", decimals: 6 },
  ],
} as const;

export type PayChain = "solana" | "base" | "bsc" | "robinhood";

type Verdict = { ok: true; asset: string; amount: string } | { ok: false; error: string };

export function readSolanaPayment(tx: SolanaTx, _memo?: string): Verdict {
  if (tx.meta?.err) return { ok: false, error: "That Solana transaction failed." };
  let received = 0;
  for (const post of tx.meta?.postTokenBalances ?? []) {
    const asset = SOL_MINTS[post.mint];
    if (!asset || post.owner !== PAY_SOLANA) continue;
    const pre = tx.meta?.preTokenBalances?.find((row) => row.accountIndex === post.accountIndex);
    const after = Number(post.uiTokenAmount?.uiAmountString ?? 0);
    const before = Number(pre?.uiTokenAmount?.uiAmountString ?? 0);
    const gain = after - before;
    if (gain >= 20) return { ok: true, asset, amount: gain.toFixed(6) };
    received = Math.max(received, gain);
  }
  if (received > 0) return { ok: false, error: "The USDT or USDC that arrived is under $20." };
  return { ok: false, error: "No USDT or USDC arrived in that transaction." };
}

export function readEvmPayment(chain: "base" | "bsc" | "robinhood", _tx: EvmTx, receipt: EvmReceipt, _memo?: string): Verdict {
  if (receipt.status !== "0x1") return { ok: false, error: "That transaction failed." };
  const wanted = PAY_EVM.toLowerCase();
  const padded = `0x${wanted.slice(2).padStart(64, "0")}`;
  for (const token of EVM_TOKENS[chain]) {
    for (const log of receipt.logs ?? []) {
      if (log.address.toLowerCase() !== token.address) continue;
      if ((log.topics?.[0] ?? "").toLowerCase() !== TRANSFER) continue;
      if ((log.topics?.[2] ?? "").toLowerCase() !== padded) continue;
      const value = BigInt(log.data);
      const minimum = 20n * 10n ** BigInt(token.decimals);
      if (value >= minimum) {
        const whole = value / 10n ** BigInt(token.decimals);
        const frac = value % 10n ** BigInt(token.decimals);
        const fracText = frac.toString().padStart(token.decimals, "0").replace(/0+$/, "") || "0";
        return { ok: true, asset: token.symbol, amount: fracText === "0" ? whole.toString() : `${whole}.${fracText}` };
      }
      if (value > 0n && value < minimum) return { ok: false, error: "That transfer is under $20." };
    }
  }
  return {
    ok: false,
    error: chain === "robinhood"
      ? "That transaction did not send USDG to the payment address on Robinhood Chain."
      : "That transaction did not send USDT or USDC to the payment address on this chain.",
  };
}

function memos(tx: SolanaTx): string {
  const groups = [tx.transaction?.message?.instructions ?? [], ...(tx.meta?.innerInstructions ?? []).map((group) => group.instructions)];
  const bits: string[] = [];
  for (const list of groups) {
    for (const ix of list) {
      if (ix.programId === MEMO_PROGRAM || ix.program === "spl-memo") {
        if (typeof ix.parsed === "string") bits.push(ix.parsed);
      }
    }
  }
  return bits.join(" ");
}

type TokenBal = { accountIndex: number; mint: string; owner?: string; uiTokenAmount?: { uiAmountString?: string } };
type SolanaIx = { programId?: string; program?: string; parsed?: string };
export type SolanaTx = {
  meta?: {
    err?: unknown;
    preTokenBalances?: TokenBal[];
    postTokenBalances?: TokenBal[];
    innerInstructions?: { instructions: SolanaIx[] }[];
  } | null;
  transaction?: { message?: { instructions?: SolanaIx[] } };
};
export type EvmTx = { input?: string };
export type EvmReceipt = { status?: string; logs?: { address: string; topics?: string[]; data: string }[] };

const RPC: Record<PayChain, string> = {
  solana: "https://api.mainnet-beta.solana.com",
  base: "https://mainnet.base.org",
  bsc: "https://bsc-dataseed.binance.org",
  robinhood: "https://rpc.mainnet.chain.robinhood.com",
};

export async function lookupPayment(chain: PayChain, txHash: string, memo?: string): Promise<Verdict> {
  if (chain === "solana") {
    if (!/^[1-9A-HJ-NP-Za-km-z]{64,128}$/.test(txHash)) return { ok: false, error: "That is not a Solana transaction signature." };
    const tx = await rpc<SolanaTx | null>(RPC.solana, "getTransaction", [txHash, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }]);
    if (!tx) return { ok: false, error: "That Solana transaction was not found." };
    return readSolanaPayment(tx, memo);
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) return { ok: false, error: "That is not a Base, BNB, or Robinhood transaction hash." };
  const [tx, receipt] = await Promise.all([
    rpc<EvmTx>(RPC[chain], "eth_getTransactionByHash", [txHash]),
    rpc<EvmReceipt | null>(RPC[chain], "eth_getTransactionReceipt", [txHash]),
  ]);
  if (!tx || !receipt) return { ok: false, error: "That transaction was not found on this chain." };
  return readEvmPayment(chain, tx, receipt, memo);
}

async function rpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) throw new Error("The chain did not answer. Try the check again.");
  const body = (await response.json()) as { result?: T; error?: { message?: string } };
  if (body.error) throw new Error(body.error.message || "The chain rejected the check.");
  return body.result as T;
}
