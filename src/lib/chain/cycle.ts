import fs from "node:fs";
import { ethers, FetchRequest } from "ethers";
import { chooseTradeUsd, describeClip } from "./size.ts";

const RPC = "https://rpc.mainnet.chain.robinhood.com";
const POOL_MANAGER = "0x8366a39CC670B4001A1121B8F6A443A643e40951";
const QUOTER = "0x8dc178efb8111bb0973dd9d722ebeff267c98f94";
const ROUTER = "0x8876789976dEcBfCbBbe364623C63652db8C0904";
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const INIT_TOPIC = "0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438";
const ROOT = process.env.STILLMARK_ROOT || "/workspace";
const RECOVERY_PATH = `${ROOT}/data/chain-recovery.json`;
const CYCLE_PATH = `${ROOT}/data/clip-cycle.json`;
const MAX_LOSS_BPS = 400;
const STATE_VIEW = "0xF3334192D15450CdD385c8B70e03f9A6bD9E673b";
const MSTR = "0xec262a75e413fAfD0dF80480274532C79D42da09";
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const MSTR_USDG_POOL = "0x319bac87e616a89e241c10aeb8afd4892a852cdd8b373cd9765ecddc40b87cfe";
const SWAP_GAS = 1_400_000n;

const erc20Abi = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
];
const permit2Abi = [
  "function allowance(address,address,address) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
  "function approve(address token, address spender, uint160 amount, uint48 expiration)",
];
const quoterAbi = [
  "function quoteExactInputSingle(((address,address,uint24,int24,address),bool,uint128,bytes) params) returns (uint256 amountOut, uint256 gasEstimate)",
];
const routerAbi = ["function execute(bytes commands, bytes[] inputs, uint256 deadline) payable"];
const stateViewAbi = [
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
];
const decimalsAbi = ["function decimals() view returns (uint8)"];

export interface V4Pool {
  currency0: string;
  currency1: string;
  fee: number;
  tickSpacing: number;
  hooks: string;
}

interface Recovery {
  token: string;
  other: string;
  soldHash: string;
  /** Other-token amount this sell actually received. Absent on older files. */
  buyAmount?: string;
  otherBefore?: string;
}

export interface CycleResult {
  text: string;
  pool: V4Pool | null;
  traded: boolean;
  halt: boolean;
  /** soon = about a minute. interval = wait the full quiet window. */
  retry: "soon" | "interval";
}

const request = new FetchRequest(RPC);
request.timeout = 20_000;
const provider = new ethers.JsonRpcProvider(request, 4663, { staticNetwork: true });
const coder = ethers.AbiCoder.defaultAbiCoder();

function poolTuple(pool: V4Pool) {
  return [pool.currency0, pool.currency1, pool.fee, pool.tickSpacing, pool.hooks];
}

function brief(error: unknown): string {
  const known: Record<string, string> = {
    "0x3b99b53d": "The router rejected the swap data.",
    "0xd81b2f2e": "Permit2 approval is missing.",
    "0x8b063d73": "The swap would receive less than the minimum.",
    "0x486aa307": "That pool is not initialized.",
    "0xf96fb071": "Allowance is too small.",
    "0x23a81f75": "Allowance is too small.",
  };
  if (error && typeof error === "object") {
    const data = "data" in error && typeof error.data === "string" ? error.data : "";
    if (data) {
      const reason = known[data.slice(0, 10)];
      if (reason) return reason;
    }
    const info = "info" in error ? (error as { info?: { error?: { message?: string } } }).info : undefined;
    if (info?.error?.message) return info.error.message.slice(0, 180);
    if ("shortMessage" in error && typeof error.shortMessage === "string" && error.shortMessage !== "could not coalesce error") {
      return error.shortMessage.slice(0, 180);
    }
  }
  return error instanceof Error ? error.message.slice(0, 180) : "Swap failed.";
}

function recoveryPath(wallet?: string): string {
  if (wallet) {
    const clean = wallet.toLowerCase().replace(/[^a-z0-9]/g, "");
    return `${ROOT}/data/recovery-${clean}.json`;
  }
  return RECOVERY_PATH;
}

function readRecovery(token: string, wallet?: string): Recovery | null {
  try {
    const p = recoveryPath(wallet);
    const target = fs.existsSync(p) ? p : RECOVERY_PATH;
    if (!fs.existsSync(target)) return null;
    const raw = JSON.parse(fs.readFileSync(target, "utf8")) as Recovery;
    if (!raw.soldHash || !raw.other || raw.token?.toLowerCase() !== token.toLowerCase()) return null;
    return raw;
  } catch {
    return null;
  }
}

function writeRecovery(value: Recovery, wallet?: string) {
  try {
    fs.mkdirSync(`${ROOT}/data`, { recursive: true });
    fs.writeFileSync(recoveryPath(wallet), JSON.stringify(value));
  } catch {
    /* ignore write errors */
  }
}

function clearRecovery(wallet?: string) {
  try {
    fs.unlinkSync(recoveryPath(wallet));
  } catch {
    /* none */
  }
}

function readCycleIndex(): number {
  try {
    const raw = JSON.parse(fs.readFileSync(CYCLE_PATH, "utf8")) as { index?: number };
    return Number.isInteger(raw.index) && (raw.index as number) >= 0 ? (raw.index as number) : 0;
  } catch {
    return 0;
  }
}

function bumpCycleIndex() {
  fs.mkdirSync(`${ROOT}/data`, { recursive: true });
  fs.writeFileSync(CYCLE_PATH, JSON.stringify({ index: readCycleIndex() + 1 }));
}

function decodeInit(log: ethers.Log): V4Pool {
  const [fee, tickSpacing, hooks] = coder.decode(["uint24", "int24", "address", "uint160", "int24"], log.data);
  return {
    currency0: ethers.getAddress(ethers.dataSlice(log.topics[2], 12)),
    currency1: ethers.getAddress(ethers.dataSlice(log.topics[3], 12)),
    fee: Number(fee),
    tickSpacing: Number(tickSpacing),
    hooks: ethers.getAddress(hooks),
  };
}

export async function findPool(token: string): Promise<V4Pool | null> {
  const latest = await provider.getBlockNumber();
  const topicToken = ethers.zeroPadValue(token, 32);
  const span = 9_000_000;
  let bestBlock = -1;
  let bestPool: V4Pool | null = null;
  for (let end = latest; end > latest - span * 5 && end > 0; end -= span) {
    const start = Math.max(0, end - span + 1);
    for (const topicIndex of [2, 3]) {
      const topics: Array<string | null> = [INIT_TOPIC, null, null, null];
      topics[topicIndex] = topicToken;
      const logs = (await provider.getLogs({
        address: POOL_MANAGER,
        fromBlock: start,
        toBlock: end,
        topics,
      })) as ethers.Log[];
      for (const log of logs) {
        if (log.blockNumber > bestBlock) {
          bestBlock = log.blockNumber;
          bestPool = decodeInit(log);
        }
      }
    }
    if (bestPool) return bestPool;
  }
  return bestPool;
}

async function quote(pool: V4Pool, zeroForOne: boolean, amount: bigint): Promise<bigint> {
  const quoter = new ethers.Contract(QUOTER, quoterAbi, provider);
  const out = await quoter.quoteExactInputSingle.staticCall([poolTuple(pool), zeroForOne, amount, "0x"]);
  return out[0] as bigint;
}

function swapInput(pool: V4Pool, zeroForOne: boolean, amountIn: bigint, amountOutMin: bigint): string {
  const tokenIn = zeroForOne ? pool.currency0 : pool.currency1;
  const tokenOut = zeroForOne ? pool.currency1 : pool.currency0;
  const swap = coder.encode(
    ["tuple(tuple(address,address,uint24,int24,address),bool,uint128,uint128,uint256,bytes)"],
    [[poolTuple(pool), zeroForOne, amountIn, amountOutMin, 0n, "0x"]],
  );
  const settle = coder.encode(["address", "uint256"], [tokenIn, amountIn]);
  const take = coder.encode(["address", "uint256"], [tokenOut, amountOutMin]);
  return coder.encode(["bytes", "bytes[]"], ["0x060c0f", [swap, settle, take]]);
}

async function ensureAllowance(wallet: ethers.Wallet, token: string, amount: bigint) {
  const erc20 = new ethers.Contract(token, erc20Abi, wallet);
  const permit2 = new ethers.Contract(PERMIT2, permit2Abi, wallet);
  const current = (await erc20.allowance(wallet.address, PERMIT2)) as bigint;
  if (current < amount) {
    const tx = await erc20.approve(PERMIT2, ethers.MaxUint256);
    await tx.wait();
  }
  const allowed = (await permit2.allowance(wallet.address, token, ROUTER)) as [bigint, bigint, bigint];
  const expiration = BigInt(allowed[1]);
  if (allowed[0] < amount || expiration < BigInt(Math.floor(Date.now() / 1000) + 120)) {
    const tx = await permit2.approve(token, ROUTER, (1n << 160n) - 1n, Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30);
    await tx.wait();
  }
}

async function networkGasPrice(): Promise<bigint> {
  const fee = await provider.getFeeData();
  return fee.maxFeePerGas ?? fee.gasPrice ?? 20_000_000n;
}

async function sendSwap(wallet: ethers.Wallet, data: string) {
  const router = new ethers.Contract(ROUTER, routerAbi, wallet);
  const deadline = Math.floor(Date.now() / 1000) + 600;
  await router.execute.staticCall("0x10", [data], deadline);
  const price = await networkGasPrice();
  const balance = await provider.getBalance(wallet.address);
  let estimated = 950_000n;
  try {
    const quoted = await router.execute.estimateGas("0x10", [data], deadline);
    if (quoted > 200_000n) estimated = quoted;
  } catch {
    /* use the measured size */
  }
  // One leg may use at most about half the ETH, so the buy can still be paid.
  const affordable = price > 0n ? (balance * 46n) / 100n / price : estimated;
  let gasLimit = estimated + estimated / 10n + 15_000n;
  if (affordable >= estimated && affordable < gasLimit) gasLimit = affordable;
  if (gasLimit > SWAP_GAS) gasLimit = SWAP_GAS;
  if (gasLimit < estimated || affordable < estimated) {
    throw new Error(`Not enough ETH for gas (${ethers.formatEther(balance)}).`);
  }
  if (process.env.STILLMARK_DRY === "1") throw new Error(`dry static ok gas ${gasLimit.toString()}`);
  const tx = await router.execute("0x10", [data], deadline, { gasLimit });
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) throw new Error("The swap transaction reverted.");
  return tx.hash as string;
}

async function balanceOf(token: string, account: string): Promise<bigint> {
  const erc20 = new ethers.Contract(token, erc20Abi, provider);
  return (await erc20.balanceOf(account)) as bigint;
}

function rawToken1PerToken0(sqrtPriceX96: bigint): number {
  if (sqrtPriceX96 <= 0n) return 0;
  const priceX192 = sqrtPriceX96 * sqrtPriceX96;
  const whole = priceX192 >> 192n;
  const frac = priceX192 & ((1n << 192n) - 1n);
  return Number(whole) + Number(frac >> (192n - 53n)) / 2 ** 53;
}

function poolIdOf(pool: V4Pool): string {
  return ethers.keccak256(coder.encode(["address", "address", "uint24", "int24", "address"], poolTuple(pool)));
}

async function tokenDecimals(address: string): Promise<number> {
  const known: Record<string, number> = {
    [MSTR.toLowerCase()]: 18,
    [USDG.toLowerCase()]: 6,
  };
  const hit = known[address.toLowerCase()];
  if (hit != null) return hit;
  const erc = new ethers.Contract(address, decimalsAbi, provider);
  return Number(await erc.decimals());
}

async function readSlot0(id: string): Promise<{ sqrtPriceX96: bigint; lpFee: number } | null> {
  const view = new ethers.Contract(STATE_VIEW, stateViewAbi, provider);
  const slot = await view.getSlot0(id);
  const sqrtPriceX96 = slot[0] as bigint;
  if (sqrtPriceX96 <= 0n) return null;
  return { sqrtPriceX96, lpFee: Number(slot[3]) };
}

async function usdPerMstr(): Promise<number | null> {
  const slot = await readSlot0(MSTR_USDG_POOL);
  if (!slot) return null;
  const human = rawToken1PerToken0(slot.sqrtPriceX96) * 10 ** (6 - 18);
  if (!(human > 0)) return null;
  return 1 / human;
}

function unitsForUsd(usd: number, usdPerToken: number, decimals: number): bigint {
  if (!(usd > 0) || !(usdPerToken > 0)) return 0n;
  const fixed = (usd / usdPerToken).toFixed(decimals);
  if (!/^\d+\.\d+$/.test(fixed) && !/^\d+$/.test(fixed)) return 0n;
  const [whole, fraction = ""] = fixed.split(".");
  const digits = `${whole}${fraction.padEnd(decimals, "0").slice(0, decimals)}`.replace(/^0+(?=\d)/, "");
  return BigInt(digits || "0");
}

interface Mark {
  usdPerToken: number;
  otherPerToken: number;
  usdPerOther: number;
  otherDecimals: number;
  lpFee: number;
  other: string;
  zeroForOne: boolean;
}

async function markToken(pool: V4Pool, token: string, decimals: number): Promise<Mark | null> {
  const slot = await readSlot0(poolIdOf(pool));
  if (!slot) return null;
  const tokenIs0 = pool.currency0.toLowerCase() === token.toLowerCase();
  const other = tokenIs0 ? pool.currency1 : pool.currency0;
  const otherDecimals = await tokenDecimals(other);
  const raw = rawToken1PerToken0(slot.sqrtPriceX96);
  if (!(raw > 0)) return null;
  const otherPerToken = tokenIs0 ? raw * 10 ** (decimals - otherDecimals) : 10 ** (decimals - otherDecimals) / raw;
  if (!(otherPerToken > 0)) return null;
  const otherKey = other.toLowerCase();
  let usdPerOther = 0;
  if (otherKey === USDG.toLowerCase()) usdPerOther = 1;
  else if (otherKey === MSTR.toLowerCase()) {
    const usd = await usdPerMstr();
    if (usd == null) return null;
    usdPerOther = usd;
  } else return null;
  return {
    usdPerToken: otherPerToken * usdPerOther,
    otherPerToken,
    usdPerOther,
    otherDecimals,
    lpFee: slot.lpFee,
    other,
    zeroForOne: tokenIs0,
  };
}

async function roundTripGasWei(): Promise<bigint> {
  const price = await networkGasPrice();
  // Measured round trip is about 1.69M gas. Keep headroom for both legs.
  return price * 2_050_000n;
}

interface Plan {
  text: string;
  tradable: boolean;
  retry: "soon" | "interval";
  amountIn: bigint;
  midOut: bigint;
  other: string;
  zeroForOne: boolean;
  costPct: number;
  usd: number;
}

function idle(text: string, retry: "soon" | "interval"): Plan {
  return { text, tradable: false, retry, amountIn: 0n, midOut: 0n, other: "", zeroForOne: true, costPct: 0, usd: 0 };
}

async function planSell(
  address: string,
  input: { token: string; symbol: string; decimals: number },
  pool: V4Pool,
  cycleIndex?: number,
): Promise<Plan> {
  const eth = await provider.getBalance(address);
  const need = await roundTripGasWei();
  if (eth < need) {
    return idle(
      `Not enough ETH for a sell and a buy (${ethers.formatEther(eth)} ETH, need about ${ethers.formatEther(need)}). No swap sent.`,
      "interval",
    );
  }
  const balance = await balanceOf(input.token, address);
  if (balance <= 0n) return idle(`No ${input.symbol} to sell. No swap sent.`, "interval");

  const mark = await markToken(pool, input.token, input.decimals);
  if (!mark || !(mark.usdPerToken > 0)) {
    return idle(`Could not price ${input.symbol} in dollars. No swap sent.`, "soon");
  }
  const balanceUsd = Number(ethers.formatUnits(balance, input.decimals)) * mark.usdPerToken;
  const picked = chooseTradeUsd(balanceUsd, cycleIndex ?? readCycleIndex());
  if (!picked.ok) return idle(picked.text, "interval");

  let amountIn = unitsForUsd(picked.clip.usd, mark.usdPerToken, input.decimals);
  if (amountIn > balance) amountIn = balance;
  if (amountIn <= 0n) return idle(`${input.symbol} clip rounded to zero. No swap sent.`, "interval");

  let midOut: bigint;
  let back: bigint;
  try {
    midOut = await quote(pool, mark.zeroForOne, amountIn);
    back = await quote(pool, !mark.zeroForOne, midOut);
  } catch (error) {
    return idle(`Could not quote ${input.symbol}. ${brief(error)}\nNo swap sent.`, "soon");
  }
  if (midOut <= 0n || back <= 0n) return idle(`${input.symbol} has no liquidity at this size. No swap sent.`, "soon");

  const lossBps = Number(((amountIn - back) * 10_000n) / amountIn);
  const totalPct = Math.max(0, lossBps / 100);
  const feePct = (mark.lpFee / 1_000_000) * 2 * 100;
  const residualPct = Math.max(0, totalPct - feePct);
  const costLine = `Best rate ${totalPct.toFixed(2)}% round trip (fee ${feePct.toFixed(2)}%, spread/slippage/impact ${residualPct.toFixed(2)}%). Gas is the network price, not a boosted tip.`;
  if (back * 10_000n < amountIn * BigInt(10_000 - MAX_LOSS_BPS)) {
    return idle(`${input.symbol} best rate is still too expensive. ${costLine} No swap sent.`, "soon");
  }
  return {
    text: [describeClip(picked.clip), costLine].join("\n"),
    tradable: true,
    retry: "interval",
    amountIn,
    midOut,
    other: mark.other,
    zeroForOne: mark.zeroForOne,
    costPct: totalPct,
    usd: picked.clip.usd,
  };
}

function skipped(text: string, pool: V4Pool | null, retry: "soon" | "interval"): CycleResult {
  return { text, pool, traded: false, halt: false, retry };
}

export async function previewChain(input: {
  address: string;
  token: string;
  symbol: string;
  decimals: number;
  pool: V4Pool | null;
  cycleIndex?: number;
}): Promise<{ text: string; pool: V4Pool | null }> {
  const pool = input.pool ?? (await findPool(input.token));
  if (!pool) return { text: `No Robinhood Chain pool found for ${input.symbol}.`, pool: null };
  const recovery = readRecovery(input.token, input.address);
  if (recovery) {
    return {
      text: `A sell is already open (${recovery.soldHash}). Next step is the buy only. No second sell.`,
      pool,
    };
  }
  const plan = await planSell(input.address, input, pool, input.cycleIndex);
  return { text: plan.text, pool };
}

export async function runChainCycle(input: {
  privateKeyHex: string;
  token: string;
  symbol: string;
  decimals: number;
  pool: V4Pool | null;
  cycleIndex?: number;
  walletAddress?: string;
  onBumpCycleIndex?: (next: number) => void;
}): Promise<CycleResult> {
  const wallet = new ethers.Wallet(input.privateKeyHex.startsWith("0x") ? input.privateKeyHex : `0x${input.privateKeyHex}`, provider);
  const pool = input.pool ?? (await findPool(input.token));
  if (!pool) {
    return skipped(`No Robinhood Chain pool found for ${input.symbol}. No swap sent.`, null, "soon");
  }
  const recovery = readRecovery(input.token, wallet.address);
  if (recovery) return buyBack(wallet, input, pool, recovery, undefined, undefined, undefined, input.onBumpCycleIndex, input.cycleIndex);

  let plan: Plan;
  try {
    plan = await planSell(wallet.address, input, pool, input.cycleIndex);
  } catch (error) {
    return skipped(`Could not check ${input.symbol}. ${brief(error)}\nNo swap sent.`, pool, "soon");
  }
  if (!plan.tradable) return skipped(plan.text, pool, plan.retry);

  const otherBefore = await balanceOf(plan.other, wallet.address);
  let soldHash = "";
  try {
    await ensureAllowance(wallet, input.token, plan.amountIn);
    const sellMin = (plan.midOut * 99n) / 100n;
    soldHash = await sendSwap(wallet, swapInput(pool, plan.zeroForOne, plan.amountIn, sellMin));
    const otherAfter = await balanceOf(plan.other, wallet.address);
    const delta = otherAfter > otherBefore ? otherAfter - otherBefore : 0n;
    writeRecovery({
      token: input.token,
      other: plan.other,
      soldHash,
      buyAmount: delta > 0n ? delta.toString() : undefined,
      otherBefore: otherBefore.toString(),
    }, wallet.address);
    if (delta <= 0n) {
      return {
        text: `Sell ${soldHash} went through and the buy amount is not in yet. It will try the buy again by itself. No second sell.`,
        pool,
        traded: false,
        halt: true,
        retry: "soon",
      };
    }
    return buyBack(wallet, input, pool, readRecovery(input.token, wallet.address) ?? {
      token: input.token,
      other: plan.other,
      soldHash,
      buyAmount: delta.toString(),
      otherBefore: otherBefore.toString(),
    }, plan.amountIn, plan.costPct, plan.usd, input.onBumpCycleIndex, input.cycleIndex);
  } catch (error) {
    const detail = brief(error);
    if (soldHash) {
      writeRecovery({
        token: input.token,
        other: plan.other,
        soldHash,
        otherBefore: otherBefore.toString(),
      }, wallet.address);
      return {
        text: `Sell ${soldHash} went through and the buy did not. ${detail}\nIt will try the buy again by itself. No second sell.`,
        pool,
        traded: false,
        halt: true,
        retry: "soon",
      };
    }
    return skipped(`Swap was not sent. ${detail}`, pool, "soon");
  }
}

function lotOf(recovery: Recovery, held: bigint): bigint {
  if (recovery.buyAmount) {
    try {
      const hinted = BigInt(recovery.buyAmount);
      if (hinted > 0n && hinted <= held) return hinted;
    } catch {
      /* fall through */
    }
  }
  if (recovery.otherBefore) {
    try {
      const before = BigInt(recovery.otherBefore);
      if (held > before) return held - before;
    } catch {
      /* fall through */
    }
  }
  return held;
}

async function buyBack(
  wallet: ethers.Wallet,
  input: { token: string; symbol: string; decimals: number },
  pool: V4Pool,
  recovery: Recovery,
  amountIn?: bigint,
  costPct?: number,
  usd?: number,
  onBumpCycleIndex?: (next: number) => void,
  cycleIndex?: number,
): Promise<CycleResult> {
  const sellingToken = pool.currency0.toLowerCase() === input.token.toLowerCase();
  const soldHash = recovery.soldHash;
  try {
    const held = await balanceOf(recovery.other, wallet.address);
    const received = lotOf(recovery, held);
    if (received <= 0n) {
      return {
        text: `Sell ${soldHash} did not leave a token to buy back yet. It will try again by itself. No second sell.`,
        pool,
        traded: false,
        halt: true,
        retry: "soon",
      };
    }
    const before = await balanceOf(input.token, wallet.address);
    const buyOut = await quote(pool, !sellingToken, received);
    if (buyOut <= 0n) throw new Error("The buy quote came back empty.");
    await ensureAllowance(wallet, recovery.other, received);
    const buyHash = await sendSwap(wallet, swapInput(pool, !sellingToken, received, (buyOut * 99n) / 100n));
    const after = await balanceOf(input.token, wallet.address);
    const bought = after > before ? after - before : buyOut;
    clearRecovery(wallet.address);
    if (onBumpCycleIndex && cycleIndex != null) {
      onBumpCycleIndex(cycleIndex + 1);
    } else {
      bumpCycleIndex();
    }
    const sold = amountIn != null ? ethers.formatUnits(amountIn, input.decimals) : "the open lot";
    const size = usd != null ? `About $${usd.toFixed(2)} sold and bought back.` : "Buy size was recalculated from the tokens the sell actually received.";
    const cost = costPct != null ? `Quoted cost ${costPct.toFixed(2)}% before the buy was recalculated.` : "Buy was priced again from what the sell received.";
    return {
      text: [
        `${input.symbol} round trip sent on Robinhood Chain.`,
        `Sold ${sold}.`,
        `Bought back ${ethers.formatUnits(bought, input.decimals)}.`,
        size,
        cost,
        `Sell ${soldHash}`,
        `Buy ${buyHash}`,
      ].join("\n"),
      pool,
      traded: true,
      halt: false,
      retry: "interval",
    };
  } catch (error) {
    return {
      text: `Sell ${soldHash} went through and the buy did not. ${brief(error)}\nIt will try the buy again by itself. No second sell.`,
      pool,
      traded: false,
      halt: true,
      retry: "soon",
    };
  }
}

