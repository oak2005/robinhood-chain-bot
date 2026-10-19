import bs58 from "bs58";
import { Wallet } from "ethers";
import nacl from "tweetnacl";
import { privateKeyToAddress } from "@stacks/transactions";

export type DeskChain = "solana" | "stacks" | "robinhood";

const SOLANA_MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const STACKS_TOKEN = /^(SP|SM)[0-9A-Z]+\.[A-Za-z0-9-]+$/;
const EVM_TOKEN = /^0x[0-9a-fA-F]{40}$/;

export function deriveWallet(chain: DeskChain, secret: string): { address: string } {
  const trimmed = secret.trim();
  if (chain === "solana") return { address: solanaAddress(trimmed) };
  if (chain === "robinhood") return { address: robinhoodAddress(trimmed) };
  return { address: stacksAddress(trimmed) };
}

export function tokenLooksRight(chain: DeskChain, token: string): boolean {
  const value = token.trim();
  if (chain === "solana") return SOLANA_MINT.test(value);
  if (chain === "robinhood") return EVM_TOKEN.test(value);
  return STACKS_TOKEN.test(value);
}

export function normalToken(chain: DeskChain, token: string): string {
  const value = token.trim();
  return chain === "robinhood" ? value.toLowerCase() : value;
}

function robinhoodAddress(secret: string): string {
  const hex = secret.startsWith("0x") ? secret : `0x${secret}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error("Paste the Robinhood wallet private key, 64 hex characters. Do not paste a seed phrase.");
  }
  return new Wallet(hex).address;
}

function solanaAddress(secret: string): string {
  const bytes = decodeSolanaSecret(secret);
  const pair = bytes.length === 64 ? nacl.sign.keyPair.fromSecretKey(bytes) : nacl.sign.keyPair.fromSeed(bytes);
  return bs58.encode(pair.publicKey);
}

function decodeSolanaSecret(secret: string): Uint8Array {
  if (secret.startsWith("[")) {
    const parsed = JSON.parse(secret) as unknown;
    if (!Array.isArray(parsed) || parsed.some((part) => typeof part !== "number")) {
      throw new Error("That Solana key is not a byte list.");
    }
    const bytes = Uint8Array.from(parsed);
    if (bytes.length !== 64 && bytes.length !== 32) throw new Error("A Solana key is 32 or 64 bytes.");
    return bytes;
  }
  const bytes = bs58.decode(secret);
  if (bytes.length !== 64 && bytes.length !== 32) throw new Error("A Solana key is 32 or 64 bytes.");
  return bytes;
}

function stacksAddress(secret: string): string {
  const hex = secret.replace(/^0x/, "");
  const compressed = /^[0-9a-fA-F]{64}01$/i.test(hex);
  if (!/^[0-9a-fA-F]{64}$/.test(hex) && !compressed) {
    throw new Error("Paste the Stacks private key, 64 hex characters. Do not paste a seed phrase.");
  }
  const address = privateKeyToAddress(hex);
  if (!address.startsWith("SP") && !address.startsWith("SM")) {
    throw new Error("That Stacks key did not make a mainnet address.");
  }
  return address;
}
