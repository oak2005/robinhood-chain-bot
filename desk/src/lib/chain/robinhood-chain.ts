const RPC = "https://rpc.mainnet.chain.robinhood.com";

export const CHAIN_ID = 4663;
export const CHAIN_NAME = "Robinhood Chain";
export const EXPLORER = "https://robinhoodchain.blockscout.com";

export interface ChainToken {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
}

async function rpc(method: string, params: unknown[]): Promise<unknown> {
  const response = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(12_000),
  });
  const body = (await response.json()) as { result?: unknown; error?: { message?: string } };
  if (!response.ok || body.error) {
    throw new Error(body.error?.message || "Robinhood Chain did not answer.");
  }
  return body.result;
}

function padAddress(address: string): string {
  return address.toLowerCase().replace(/^0x/, "").padStart(64, "0");
}

async function call(to: string, data: string): Promise<string> {
  const result = await rpc("eth_call", [{ to, data }, "latest"]);
  if (typeof result !== "string" || result === "0x") throw new Error("The contract returned nothing.");
  return result;
}

function decodeString(hex: string): string {
  const raw = hex.replace(/^0x/, "");
  if (!raw || /^0+$/.test(raw)) return "";
  if (raw.length === 64) {
    return Buffer.from(raw, "hex").toString("utf8").replace(/\0+$/g, "").trim();
  }
  if (raw.length < 128) return "";
  const length = Number(BigInt(`0x${raw.slice(64, 128)}`));
  if (!Number.isFinite(length) || length < 0 || length > 64) return "";
  return Buffer.from(raw.slice(128, 128 + length * 2), "hex").toString("utf8").replace(/\0/g, "").trim();
}

export function formatUnits(value: bigint, decimals: number): string {
  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  const fraction = (value % scale).toString().padStart(decimals, "0").slice(0, 6).replace(/0+$/, "");
  return fraction ? `${whole.toString()}.${fraction}` : whole.toString();
}

export async function readChainToken(address: string, wallet?: string): Promise<ChainToken & { balance: string | null }> {
  const code = await rpc("eth_getCode", [address, "latest"]);
  if (typeof code !== "string" || code === "0x" || code === "0x0") {
    throw new Error("No contract at that address on Robinhood Chain.");
  }
  const [symbolHex, decimalsHex, nameHex] = await Promise.all([
    call(address, "0x95d89b41"),
    call(address, "0x313ce567"),
    call(address, "0x06fdde03").catch(() => "0x"),
  ]);
  const symbol = decodeString(symbolHex);
  const decimals = Number(BigInt(decimalsHex));
  const name = decodeString(nameHex) || symbol;
  if (!symbol || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new Error("That contract is not a readable token. Symbol or decimals failed.");
  }
  let balance: string | null = null;
  if (wallet) {
    const raw = await call(address, `0x70a08231${padAddress(wallet)}`);
    balance = formatUnits(BigInt(raw), decimals);
  }
  return { address, symbol, name, decimals, balance };
}

export async function readEthBalance(wallet: string): Promise<string> {
  const wei = await rpc("eth_getBalance", [wallet, "latest"]);
  return formatUnits(BigInt(String(wei)), 18);
}
