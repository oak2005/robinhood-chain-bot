import { privateKeyToAddress } from "@stacks/transactions";
import { chooseTradeUsd, describeClip } from "./size.ts";
import { readStacksWalletBalances, fetchTokenPriceUsd } from "./balance-reader.ts";

export interface StacksCycleResult {
  text: string;
  traded: boolean;
  halt?: boolean;
  retry: "soon" | "interval";
  txHash?: string;
}

export async function previewStacks(input: {
  address: string;
  token: string;
  symbol: string;
  cycleIndex?: number;
}): Promise<{ text: string }> {
  try {
    const balInfo = await readStacksWalletBalances(input.address, [
      { token: input.token, symbol: input.symbol },
    ]);
    const stxAmount = parseFloat(balInfo.nativeAmount) || 0;
    const tokenBal = balInfo.tokens[0];
    const tokenAmount = parseFloat(tokenBal?.amount.replace(/,/g, "") || "0");
    const tokenPrice = tokenBal?.priceUsd || (await fetchTokenPriceUsd(input.token));
    const tokenUsd = tokenBal?.balanceUsd != null ? tokenBal.balanceUsd : tokenPrice ? tokenAmount * tokenPrice : 0;

    const lines: string[] = [
      `Stacks: ${input.symbol} (${input.token.slice(0, 10)}…)`,
      `STX Balance: ${balInfo.nativeAmount} STX${balInfo.nativeBalanceUsd ? ` ($${balInfo.nativeBalanceUsd.toFixed(2)})` : ""}`,
      `${input.symbol} Balance: ${tokenAmount.toLocaleString("en-US", { maximumFractionDigits: 6 })} ($${tokenUsd.toFixed(2)})`,
    ];

    if (stxAmount < 0.1) {
      lines.push("⚠️ Low STX for network fees. Fund wallet with at least 0.2 STX.");
    }

    const picked = chooseTradeUsd(tokenUsd, input.cycleIndex ?? 0);
    if (!picked.ok) {
      lines.push(picked.text);
      return { text: lines.join("\n") };
    }

    lines.push(describeClip(picked.clip));
    lines.push(`Stacks swap ready: $${picked.clip.usd.toFixed(2)} planned cycle.`);

    return { text: lines.join("\n") };
  } catch (error) {
    return {
      text: `Stacks preview failed: ${error instanceof Error ? error.message : "Error reading Stacks"}`,
    };
  }
}

export async function runStacksCycle(input: {
  privateKey: string;
  token: string;
  symbol: string;
  walletAddress: string;
  cycleIndex?: number;
  onBumpCycleIndex?: (next: number) => Promise<void> | void;
}): Promise<StacksCycleResult> {
  const hex = input.privateKey.trim().replace(/^0x/, "");
  let address = "";
  try {
    address = privateKeyToAddress(hex);
  } catch (err) {
    return {
      text: `Stacks key error: ${err instanceof Error ? err.message : "Invalid key"}`,
      traded: false,
      halt: true,
      retry: "interval",
    };
  }

  const walletAddr = input.walletAddress || address;
  const balInfo = await readStacksWalletBalances(walletAddr, [{ token: input.token, symbol: input.symbol }]);
  const stxAmount = parseFloat(balInfo.nativeAmount) || 0;

  if (stxAmount < 0.1) {
    return {
      text: `Not enough STX for gas fee (${stxAmount.toFixed(4)} STX). Need at least 0.2 STX for Stacks network transaction fees.`,
      traded: false,
      retry: "interval",
    };
  }

  const tokenBal = balInfo.tokens[0];
  const tokenAmount = parseFloat(tokenBal?.amount.replace(/,/g, "") || "0");
  const tokenPrice = tokenBal?.priceUsd || (await fetchTokenPriceUsd(input.token)) || 0;
  const tokenUsd = tokenBal?.balanceUsd != null ? tokenBal.balanceUsd : tokenAmount * tokenPrice;

  if (tokenAmount <= 0 || tokenUsd < 1) {
    return {
      text: `Token balance for ${input.symbol} is too low to swap ($${tokenUsd.toFixed(2)}, need >= $1.00).`,
      traded: false,
      retry: "interval",
    };
  }

  const picked = chooseTradeUsd(tokenUsd, input.cycleIndex ?? 0);
  if (!picked.ok) {
    return {
      text: picked.text,
      traded: false,
      retry: "interval",
    };
  }

  if (input.onBumpCycleIndex) {
    await input.onBumpCycleIndex((input.cycleIndex ?? 0) + 1);
  }

  return {
    text: [
      `Stacks Inactivity Cycle planned for ${input.symbol}.`,
      `Target size: $${picked.clip.usd.toFixed(2)}.`,
      `STX Gas Balance: ${stxAmount.toFixed(4)} STX.`,
      `Token Balance: ${tokenAmount.toLocaleString("en-US", { maximumFractionDigits: 6 })} ${input.symbol}.`,
      `Wallet: ${walletAddr}`,
      `Explorer: https://explorer.hiro.so/address/${walletAddr}`,
    ].join("\n"),
    traded: true,
    retry: "interval",
  };
}
