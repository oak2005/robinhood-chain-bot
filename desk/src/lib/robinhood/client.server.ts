import { robinhoodMessage, signMessage } from "../engine/sign.ts";

const BASE = "https://trading.robinhood.com";

export interface RhCreds {
  apiKey: string;
  privateKey: string;
}

export class RhError extends Error {
  status: number;
  auth: boolean;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
    this.auth = status === 401 || status === 403;
  }
}

const hits: number[] = [];

function throttle(): void {
  const now = Date.now();
  while (hits.length && now - hits[0]! > 60_000) hits.shift();
  if (hits.length >= 80) {
    throw new RhError("Robinhood rate limit reached. No order submitted.", 429);
  }
  hits.push(now);
}

export async function rhRequest(
  creds: RhCreds,
  method: "GET" | "POST",
  path: string,
  body?: Record<string, unknown>,
): Promise<unknown> {
  throttle();
  const bodyText = body ? JSON.stringify(body) : "";
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const message = robinhoodMessage({
    apiKey: creds.apiKey,
    timestamp,
    path,
    method,
    body: bodyText || undefined,
  });
  const signature = signMessage(creds.privateKey, message);
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        "x-api-key": creds.apiKey,
        "x-signature": signature,
        "x-timestamp": timestamp,
        accept: "application/json",
        ...(bodyText ? { "content-type": "application/json" } : {}),
      },
      body: bodyText || undefined,
    });
  } catch {
    throw new RhError("Robinhood network request failed.", 0);
  }
  const text = await response.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      parsed = null;
    }
  }
  if (!response.ok) {
    const record = asRecord(parsed);
    const detail = typeof record?.detail === "string" ? record.detail.slice(0, 180) : "";
    throw new RhError(detail || `Robinhood responded ${response.status}.`, response.status);
  }
  return parsed;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

export async function readAccount(creds: RhCreds): Promise<{ buyingPower: number | null; status: string }> {
  const body = await rhRequest(creds, "GET", "/api/v1/crypto/trading/accounts/");
  const record = asRecord(body);
  const results = Array.isArray(record?.results) ? record.results : Array.isArray(body) ? body : [];
  const first = asRecord(results[0]);
  return {
    buyingPower: num(first?.buying_power),
    status: typeof first?.status === "string" ? first.status : "unknown",
  };
}

export interface LiveQuote {
  bid: number;
  ask: number;
  timestampMs: number;
}

export async function readHoldings(creds: RhCreds, assetCode: string): Promise<number> {
  const path = `/api/v1/crypto/trading/holdings/?asset_code=${encodeURIComponent(assetCode)}`;
  const body = await rhRequest(creds, "GET", path);
  const record = asRecord(body);
  const results = Array.isArray(record?.results) ? record.results : [];
  const row = results.map(asRecord).find((item) => item?.asset_code === assetCode) ?? asRecord(results[0]);
  return num(row?.quantity_available_for_trading) ?? num(row?.total_quantity) ?? 0;
}

export async function readQuote(creds: RhCreds, symbol: string): Promise<LiveQuote> {
  const path = `/api/v1/crypto/marketdata/best_bid_ask/?symbol=${encodeURIComponent(symbol)}`;
  const body = await rhRequest(creds, "GET", path);
  const record = asRecord(body);
  const results = Array.isArray(record?.results) ? record.results : [];
  const row = asRecord(results[0]);
  const bid = num(row?.bid_inclusive_of_sell_spread) ?? num(row?.bid);
  const ask = num(row?.ask_inclusive_of_buy_spread) ?? num(row?.ask);
  const timestampMs = typeof row?.timestamp === "string" ? Date.parse(row.timestamp) : Date.now();
  if (bid == null || ask == null || !(ask > bid)) {
    throw new RhError("Quote was missing a usable bid and ask.", 0);
  }
  return { bid, ask, timestampMs: Number.isFinite(timestampMs) ? timestampMs : Date.now() };
}

export async function placeOrder(creds: RhCreds, order: Record<string, unknown>): Promise<unknown> {
  return rhRequest(creds, "POST", "/api/v1/crypto/trading/orders/", order);
}

export async function readOrder(creds: RhCreds, id: string): Promise<unknown> {
  return rhRequest(creds, "GET", `/api/v1/crypto/trading/orders/${encodeURIComponent(id)}/`);
}

export async function cancelOrder(creds: RhCreds, id: string): Promise<void> {
  await rhRequest(creds, "POST", `/api/v1/crypto/trading/orders/${encodeURIComponent(id)}/cancel/`);
}

export async function findByClientId(creds: RhCreds, symbol: string, clientOrderId: string): Promise<unknown | null> {
  const path = `/api/v1/crypto/trading/orders/?symbol=${encodeURIComponent(symbol)}`;
  const body = await rhRequest(creds, "GET", path);
  const record = asRecord(body);
  const results = Array.isArray(record?.results) ? record.results : [];
  return results.find((row) => asRecord(row)?.client_order_id === clientOrderId) ?? null;
}
