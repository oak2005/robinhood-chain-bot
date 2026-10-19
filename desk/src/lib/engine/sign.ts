import { createPrivateKey, sign, type KeyObject } from "node:crypto";

/**
 * Robinhood Crypto Trading API request signature.
 *
 * Message: `${apiKey}${timestamp}${path}${method}${body}`
 * Signature: base64 Ed25519 over that exact string.
 * The private key is a base64 32-byte seed (or 64-byte seed||public).
 *
 * The published docs vector signs Python's `str(dict)`, not JSON. Live
 * orders must sign the exact JSON bytes that are transmitted. Callers pass
 * that string in. `signSampleVector` reproduces the published header so the
 * implementation can be checked without treating the docs bug as protocol.
 */

const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

export function ed25519KeyFromSeed(privateKeyBase64: string): KeyObject {
  const raw = Buffer.from(privateKeyBase64.trim(), "base64");
  if (raw.length !== 32 && raw.length !== 64) {
    throw new Error("Private key must be a base64 Ed25519 seed.");
  }
  const seed = raw.subarray(0, 32);
  const pkcs8 = Buffer.concat([PKCS8_PREFIX, seed]);
  return createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
}

export function signMessage(privateKeyBase64: string, message: string): string {
  const key = ed25519KeyFromSeed(privateKeyBase64);
  return sign(null, Buffer.from(message, "utf8"), key).toString("base64");
}

export function robinhoodMessage(parts: {
  apiKey: string;
  timestamp: string;
  path: string;
  method: string;
  body?: string;
}): string {
  const body = parts.body ?? "";
  return `${parts.apiKey}${parts.timestamp}${parts.path}${parts.method.toUpperCase()}${body}`;
}

/** Published documentation header. Signs the Python dict interpolation, not JSON. */
export function signPublishedDocsVector(privateKeyBase64: string): string {
  const body =
    "{'client_order_id': '131de903-5a9c-4260-abc1-28d562a5dcf0', 'side': 'buy', 'symbol': 'BTC-USD', 'type': 'market', 'market_order_config': {'asset_quantity': '0.1'}}";
  const message = robinhoodMessage({
    apiKey: "rh-api-6148effc-c0b1-486c-8940-a1d099456be6",
    timestamp: "1698708981",
    path: "/api/v1/crypto/trading/orders/",
    method: "POST",
    body,
  });
  return signMessage(privateKeyBase64, message);
}

export const PUBLISHED_DOCS_SIGNATURE =
  "q/nEtxp/P2Or3hph3KejBqnw5o9qeuQ+hYRnB56FaHbjDsNUY9KhB1asMxohDnzdVFSD7StaTqjSd9U9HvaRAw==";

export const PUBLISHED_DOCS_PRIVATE_KEY =
  "xQnTJVeQLmw1/Mg2YimEViSpw/SdJcgNXZ5kQkAXNPU=";
