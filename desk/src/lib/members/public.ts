export const LADDER_USD = [5, 8, 6, 7, 7.5, 9] as const;
export const MAX_ROUND_TRIP_PCT = 4;
export const DONATION_USD = 20;
export const MAX_TOKENS = 3;

export const PAY_EVM = "0x4a543eEbBB5DFaA2FE0E4f36E84b0eaf5803D7DD";
export const PAY_SOLANA = "GLrFg8GR7iNotxJRvVHakdbhpRHjEEe8EHXVmjHxNG1T";

export type PublicSlot = {
  id: string;
  chain: "solana" | "stacks" | "robinhood";
  address: string;
  token: string;
  symbol: string;
  interval: "10m" | "20m" | "30m" | "1h";
};

export type PublicAccess = {
  memo: string;
  exactUsd: string;
  paidUntil: string | null;
  covered: boolean;
  slots: PublicSlot[];
};

export type OperatorRow = {
  chain: string;
  address: string;
  token: string;
  symbol: string;
  covered: boolean;
};

const SECRET_KEYS = ["privateKey", "secret", "wrapped", "seed", "mnemonic"];

export function assertNoSecret(value: unknown): void {
  const text = JSON.stringify(value);
  for (const key of SECRET_KEYS) {
    if (text.includes(`"${key}"`)) throw new Error(`Operator payload exposed ${key}`);
  }
}

export function nextClip(index: number): number {
  const safe = Number.isInteger(index) && index >= 0 ? index : 0;
  return LADDER_USD[safe % LADDER_USD.length] ?? 5;
}

export function exactUsd(memo: string): string {
  let hash = 0;
  for (const char of memo) hash = (hash * 33 + char.charCodeAt(0)) % 800000;
  const micro = 100000 + hash;
  return `20.${String(micro).padStart(6, "0")}`;
}

export function rawForDecimals(memo: string, decimals: number): bigint {
  const [whole, frac] = exactUsd(memo).split(".");
  const base = BigInt(whole ?? "0") * 10n ** BigInt(decimals) + BigInt(frac ?? "0") * 10n ** BigInt(decimals - 6);
  return base;
}
