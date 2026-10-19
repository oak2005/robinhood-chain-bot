import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";

export interface ImportedWallet {
  address: string;
  privateKeyHex: string;
}

function fromPrivateKey(privateKey: Uint8Array): ImportedWallet {
  const uncompressed = secp256k1.getPublicKey(privateKey, false);
  const hash = keccak_256(uncompressed.slice(1));
  const address = `0x${Buffer.from(hash.slice(-20)).toString("hex")}`;
  return { address, privateKeyHex: Buffer.from(privateKey).toString("hex") };
}

/** English 12 or 24 word phrase, or a 32-byte hex private key. Phrase uses Rabby's first account. */
export function importWallet(text: string): ImportedWallet | null {
  const trimmed = text.trim().toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  const words = trimmed.split(" ").filter(Boolean);
  if (words.length === 12 || words.length === 24) {
    const phrase = words.join(" ");
    if (!validateMnemonic(phrase, wordlist)) return null;
    const seed = mnemonicToSeedSync(phrase);
    const child = HDKey.fromMasterSeed(seed).derive("m/44'/60'/0'/0/0");
    if (!child.privateKey) return null;
    return fromPrivateKey(child.privateKey);
  }
  const hex = trimmed.replace(/^0x/, "");
  if (!/^[0-9a-f]{64}$/.test(hex)) return null;
  return fromPrivateKey(Buffer.from(hex, "hex"));
}
