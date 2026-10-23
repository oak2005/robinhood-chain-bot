import { useEffect, useState } from "react";
import { UserButton } from "@/lib/auth/gates";
import { GROK_PROVIDERS, authEnabled, signIn } from "@/lib/auth/client";
import { useCurrentUser, useCurrentUserState } from "@/lib/auth/use-current-user";
import { EmailAccess } from "@/components/desk/email-access";
import {
  addSlot,
  confirmPayment,
  createUniversalWallet,
  getAccess,
  getUserDisputes,
  operatorBoard,
  raiseDispute,
  removeSlot,
  resolveDispute,
} from "@/lib/members/api";
import {
  DONATION_USD,
  LADDER_USD,
  MAX_ROUND_TRIP_PCT,
  MAX_TOKENS,
  PAY_EVM,
  PAY_SOLANA,
  TRADE_RANGE_OPTIONS,
  type DisputeRow,
  type OperatorRow,
  type PublicAccess,
  type TradeRange,
} from "@/lib/members/public";
import type { UniversalWalletResult } from "@/lib/members/keys";

type Chain = "solana" | "stacks" | "robinhood";
type PayChain = "solana" | "base" | "bsc" | "robinhood";
type Interval = "10m" | "20m" | "30m" | "1h";

const CHAINS: Chain[] = ["solana", "stacks", "robinhood"];
const INTERVALS: Interval[] = ["10m", "20m", "30m", "1h"];
const NAMES: Record<Chain, string> = { solana: "Solana", stacks: "Stacks", robinhood: "Robinhood" };

function explorerUrl(chain: string, hash: string): string {
  const clean = hash.trim();
  if (chain === "solana") return `https://solscan.io/tx/${clean}`;
  if (chain === "base") return `https://basescan.org/tx/${clean}`;
  if (chain === "bsc") return `https://bscscan.com/tx/${clean}`;
  return `https://robinhoodchain.blockscout.com/tx/${clean}`;
}

export function MemberDesk() {
  const { isPending } = useCurrentUserState();
  const user = useCurrentUser();
  const [help, setHelp] = useState(false);
  const [access, setAccess] = useState<PublicAccess | null>(null);
  const [rows, setRows] = useState<OperatorRow[] | null>(null);
  const [disputes, setDisputes] = useState<DisputeRow[]>([]);
  const [userDisputes, setUserDisputes] = useState<DisputeRow[]>([]);
  const [operator, setOperator] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [chain, setChain] = useState<Chain>("solana");
  const [token, setToken] = useState("");
  const [symbol, setSymbol] = useState("");
  const [interval, setIntervalKey] = useState<Interval>("30m");
  const [tradeRange, setTradeRange] = useState<TradeRange>("5-20");
  const [walletMode, setWalletMode] = useState<"generate" | "import">("generate");
  const [universalWallet, setUniversalWallet] = useState<UniversalWalletResult | null>(null);
  const [generatingWallet, setGeneratingWallet] = useState(false);
  const [copiedItem, setCopiedItem] = useState<string>("");
  const [privateKey, setPrivateKey] = useState("");
  const [freshAck, setFreshAck] = useState(false);
  const [payChain, setPayChain] = useState<PayChain>("solana");
  const [txHash, setTxHash] = useState("");
  const [disputeOpen, setDisputeOpen] = useState(false);
  const [disputeNote, setDisputeNote] = useState("");
  const [disputeMsg, setDisputeMsg] = useState("");

  async function refreshData() {
    if (!user) return;
    try {
      const [mine, board, myDisputes] = await Promise.all([
        getAccess(),
        operatorBoard(),
        getUserDisputes(),
      ]);
      setAccess(mine);
      setOperator(board.operator);
      setRows(board.rows);
      setDisputes(board.disputes ?? []);
      setUserDisputes(myDisputes ?? []);
    } catch {
      /* ignore */
    }
  }

  useEffect(() => {
    if (!user) return;
    let gone = false;
    void Promise.all([getAccess(), operatorBoard(), getUserDisputes()]).then(([mine, board, myDisputes]) => {
      if (gone) return;
      setAccess(mine);
      setOperator(board.operator);
      setRows(board.rows);
      setDisputes(board.disputes ?? []);
      setUserDisputes(myDisputes ?? []);
    });
    return () => {
      gone = true;
    };
  }, [user]);

  async function onPay() {
    setError("");
    setBusy(true);
    try {
      const result = await confirmPayment({ data: { chain: payChain, txHash } });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setAccess(result.access);
      setTxHash("");
      setError("");
    } catch {
      setError("Could not check that payment.");
    } finally {
      setBusy(false);
    }
  }

  async function onSubmitDispute() {
    if (!txHash.trim()) {
      setError("Please enter the transaction hash for the dispute.");
      return;
    }
    setError("");
    setBusy(true);
    try {
      const res = await raiseDispute({
        data: {
          chain: payChain,
          txHash: txHash.trim(),
          userNote: disputeNote.trim(),
        },
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setDisputeMsg(`Dispute #${res.dispute.id} submitted! Sent to admin portal for review.`);
      setDisputeNote("");
      await refreshData();
    } catch {
      setError("Could not submit the dispute. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function onResolveDispute(disputeId: string, action: "accept" | "reject", note?: string) {
    setBusy(true);
    try {
      const res = await resolveDispute({
        data: { disputeId, action, adminNote: note },
      });
      if (res.ok) {
        await refreshData();
      } else {
        setError(res.error);
      }
    } catch {
      setError("Failed to resolve dispute.");
    } finally {
      setBusy(false);
    }
  }

  async function onGenerateWallet() {
    setError("");
    setGeneratingWallet(true);
    try {
      const wallet = await createUniversalWallet();
      setUniversalWallet(wallet);
      setPrivateKey(wallet.wallets[chain].privateKey);
    } catch {
      setError("Could not generate a wallet right now. You can also import an existing private key.");
    } finally {
      setGeneratingWallet(false);
    }
  }

  function handleChainChange(newChain: Chain) {
    setChain(newChain);
    if (walletMode === "generate" && universalWallet) {
      setPrivateKey(universalWallet.wallets[newChain].privateKey);
    }
  }

  function copy(text: string, label: string) {
    void navigator.clipboard.writeText(text);
    setCopiedItem(label);
    setTimeout(() => setCopiedItem(""), 2200);
  }

  async function onAdd() {
    setError("");
    if (!freshAck) {
      setError(
        walletMode === "generate"
          ? "Please confirm that you have saved your 12-word seed phrase."
          : "Tick the fresh-wallet warning before the key is accepted.",
      );
      return;
    }
    const finalKey =
      walletMode === "generate" && universalWallet
        ? universalWallet.wallets[chain].privateKey
        : privateKey.trim();

    if (!finalKey) {
      setError(
        walletMode === "generate"
          ? "Please click 'Generate Universal Wallet' first to create your addresses."
          : "Please enter your wallet private key.",
      );
      return;
    }

    setBusy(true);
    try {
      const result = await addSlot({
        data: {
          chain,
          privateKey: finalKey,
          token,
          symbol,
          interval,
          tradeRange,
          freshAck: true,
        },
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setAccess(result.access);
      if (walletMode === "import") {
        setPrivateKey("");
      }
      setToken("");
      setFreshAck(false);
    } catch {
      setError("Could not add the token.");
    } finally {
      setBusy(false);
    }
  }

  async function onRemove(slotId: string) {
    setBusy(true);
    setError("");
    try {
      setAccess(await removeSlot({ data: { slotId } }));
    } catch {
      setError("Could not remove that token.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto min-h-screen w-full max-w-lg px-4 py-6">
      <header className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm text-subtle">Member desk</p>
          <h1 className="font-display text-3xl text-fg">Inactivity</h1>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => setHelp((open) => !open)} className="min-h-11 rounded-full border border-line px-4 text-sm text-fg">
            {help ? "Close" : "Help"}
          </button>
          <UserButton />
        </div>
      </header>

      {help ? <Guide /> : null}
      {!help && isPending ? <p className="mt-8 text-muted">Checking the session.</p> : null}
      {!help && !isPending && !user ? <SignedOutGate /> : null}

      {!help && user && !access ? <p className="mt-8 text-muted">Loading the desk.</p> : null}
      {!help && user && access ? (
        <section className="mt-8 space-y-6">
          <Payment
            access={access}
            payChain={payChain}
            txHash={txHash}
            busy={busy}
            onChain={setPayChain}
            onTx={setTxHash}
            onPay={() => void onPay()}
            disputeOpen={disputeOpen}
            onToggleDispute={() => setDisputeOpen((prev) => !prev)}
            disputeNote={disputeNote}
            onDisputeNoteChange={setDisputeNote}
            onSubmitDispute={() => void onSubmitDispute()}
            disputeMsg={disputeMsg}
            userDisputes={userDisputes}
          />
          <div className="space-y-3">
            <h2 className="font-display text-xl text-fg">{"Tokens " + access.slots.length + " of " + MAX_TOKENS}</h2>
            {access.slots.map((slot) => (
              <div key={slot.id} className="flex items-center justify-between gap-3 rounded-2xl border border-line bg-surface p-3">
                <div>
                  <div className="flex items-center gap-2">
                    <p className="font-medium text-fg">{slot.symbol || NAMES[slot.chain]}</p>
                    <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[11px] text-muted font-medium">
                      {NAMES[slot.chain]}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted mt-1">
                    <span className="font-mono">{short(slot.address)}</span>
                    <span>·</span>
                    <span className="rounded bg-surface-2 px-1.5 py-0.5 text-fg">{slot.interval}</span>
                    <span>·</span>
                    <span className="rounded bg-emerald-500/10 border border-emerald-500/20 px-1.5 py-0.5 font-medium text-emerald-400">
                      ${slot.tradeRange || "5-20"} / trade
                    </span>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => void onRemove(slot.id)}
                  className="min-h-11 rounded-full border border-line px-3 text-sm text-fg hover:border-danger hover:text-danger transition"
                >
                  Remove
                </button>
              </div>
            ))}
            {access.slots.length === 0 ? <p className="text-sm text-subtle">No token yet. The month has to be paid first.</p> : null}
          </div>
          {access.slots.length < MAX_TOKENS ? (
            <form
              className="space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                void onAdd();
              }}
            >
              <fieldset className="space-y-2">
                <legend className="text-sm text-muted">Chain</legend>
                <div className="grid grid-cols-3 gap-2">
                  {CHAINS.map((item) => (
                    <button
                      key={item}
                      type="button"
                      onClick={() => handleChainChange(item)}
                      className={`min-h-11 rounded-2xl border px-2 text-sm font-medium transition ${
                        chain === item
                          ? "border-accent bg-accent text-accent-fg shadow-sm"
                          : "border-line bg-surface text-fg hover:border-line/80"
                      }`}
                    >
                      {NAMES[item]}
                    </button>
                  ))}
                </div>
              </fieldset>

              <Field
                label={chain === "robinhood" ? "Token contract" : chain === "solana" ? "Token mint" : "Token contract"}
                value={token}
                onChange={setToken}
                placeholder={chain === "solana" ? "Mint address" : chain === "stacks" ? "SP….token-name" : "0x token"}
              />

              <Field label="Symbol" value={symbol} onChange={setSymbol} placeholder="Optional" />

              {/* Trade Scope / Interval per trade Range */}
              <fieldset className="space-y-2">
                <div className="flex items-center justify-between">
                  <legend className="text-sm text-muted">Interval per trade (Trade size scope)</legend>
                  <span className="text-[11px] text-emerald-400 font-medium">Low fee & low spread</span>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {TRADE_RANGE_OPTIONS.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => setTradeRange(item.id)}
                      className={`p-3 rounded-2xl border text-left transition flex flex-col justify-between ${
                        tradeRange === item.id
                          ? "border-accent bg-accent text-accent-fg shadow-sm"
                          : "border-line bg-surface text-fg hover:border-line/80"
                      }`}
                    >
                      <div className="flex items-center justify-between w-full">
                        <span className="font-bold text-sm">{item.label}</span>
                        {tradeRange === item.id ? (
                          <span className="text-xs bg-accent-fg/20 text-accent-fg rounded-full px-1.5 py-0.2">✓</span>
                        ) : null}
                      </div>
                      <span className={`text-[11px] mt-1 line-clamp-2 ${tradeRange === item.id ? "text-accent-fg/80" : "text-muted"}`}>
                        {item.desc}
                      </span>
                    </button>
                  ))}
                </div>
                <p className="text-[11px] text-subtle">
                  Trades in {TRADE_RANGE_OPTIONS.find((o) => o.id === tradeRange)?.range}. If wallet balance is lower, trades will automatically scale to your available balance.
                </p>
              </fieldset>

              <label className="block space-y-2">
                <span className="text-sm text-muted">Quiet time interval (between cycles)</span>
                <select
                  value={interval}
                  onChange={(event) => setIntervalKey(event.target.value as Interval)}
                  className="min-h-11 w-full rounded-2xl border border-line bg-surface px-3 text-fg focus:outline-none focus:border-accent"
                >
                  {INTERVALS.map((item) => (
                    <option key={item} value={item}>{item}</option>
                  ))}
                </select>
              </label>

              {/* Wallet Choice: Generate Multi-Chain Wallet OR Import Key */}
              <div className="space-y-3 pt-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted font-medium">Wallet Setup</span>
                  <div className="inline-flex rounded-xl border border-line p-0.5 bg-surface text-xs">
                    <button
                      type="button"
                      onClick={() => setWalletMode("generate")}
                      className={`px-3 py-1 rounded-lg font-medium transition ${
                        walletMode === "generate" ? "bg-accent text-accent-fg shadow-sm" : "text-muted hover:text-fg"
                      }`}
                    >
                      ✨ Generate Wallet
                    </button>
                    <button
                      type="button"
                      onClick={() => setWalletMode("import")}
                      className={`px-3 py-1 rounded-lg font-medium transition ${
                        walletMode === "import" ? "bg-accent text-accent-fg shadow-sm" : "text-muted hover:text-fg"
                      }`}
                    >
                      🔑 Import Key
                    </button>
                  </div>
                </div>

                {walletMode === "generate" ? (
                  <div className="space-y-3">
                    {!universalWallet ? (
                      <div className="rounded-3xl border border-dashed border-accent/40 bg-accent/5 p-5 text-center space-y-3">
                        <div className="inline-flex size-10 items-center justify-center rounded-full bg-accent/10 text-accent text-lg">
                          ✨
                        </div>
                        <div>
                          <p className="font-semibold text-fg text-sm">Universal Multi-Chain Wallet</p>
                          <p className="text-xs text-muted max-w-sm mx-auto mt-1">
                            Generate a single 12-word seed phrase that gives you deposit addresses for Solana, Robinhood, and Stacks all at once. No private key exports required!
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() => void onGenerateWallet()}
                          disabled={generatingWallet || busy}
                          className="min-h-11 px-5 rounded-full bg-accent text-accent-fg text-sm font-semibold hover:opacity-90 transition inline-flex items-center gap-2 shadow-sm"
                        >
                          {generatingWallet ? "Generating..." : "🎲 Generate Universal Wallet"}
                        </button>
                      </div>
                    ) : (
                      <div className="space-y-3 rounded-3xl border border-line bg-surface p-4">
                        {/* Seed Phrase Display */}
                        <div className="space-y-2">
                          <div className="flex items-center justify-between">
                            <span className="text-xs font-semibold text-fg flex items-center gap-1.5">
                              <span>📝</span> Your 12-Word Recovery Seed Phrase
                            </span>
                            <button
                              type="button"
                              onClick={() => copy(universalWallet.mnemonic, "seed")}
                              className="text-xs text-accent hover:underline font-medium"
                            >
                              {copiedItem === "seed" ? "✓ Copied!" : "Copy Words"}
                            </button>
                          </div>
                          <div className="grid grid-cols-3 gap-1.5 rounded-2xl bg-bg/70 p-3 border border-line/60">
                            {universalWallet.mnemonic.split(" ").map((word, idx) => (
                              <div key={idx} className="flex items-center gap-1 text-xs">
                                <span className="text-[10px] text-subtle w-4 font-mono">{idx + 1}.</span>
                                <span className="font-mono text-fg font-medium">{word}</span>
                              </div>
                            ))}
                          </div>
                          <p className="text-[11px] text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded-xl p-2">
                            ⚠️ <strong>Crucial:</strong> Save these 12 words in a safe offline place. This is your master backup. We do not store your seed phrase.
                          </p>
                        </div>

                        {/* Deposit Addresses */}
                        <div className="space-y-2 pt-2 border-t border-line/40">
                          <p className="text-xs font-semibold text-subtle">Deposit Addresses For Your Wallet:</p>
                          {(["solana", "robinhood", "stacks"] as const).map((c) => {
                            const isCurrent = chain === c;
                            const addr = universalWallet.wallets[c].address;
                            return (
                              <div
                                key={c}
                                className={`rounded-2xl p-2.5 transition text-xs border ${
                                  isCurrent
                                    ? "bg-accent/5 border-accent/40"
                                    : "bg-bg/40 border-line/60"
                                }`}
                              >
                                <div className="flex items-center justify-between mb-1">
                                  <div className="flex items-center gap-1.5">
                                    <span className="font-semibold text-fg">{NAMES[c]}</span>
                                    {isCurrent ? (
                                      <span className="rounded bg-accent text-accent-fg text-[10px] px-1.5 py-0.2 font-semibold">
                                        Selected Chain
                                      </span>
                                    ) : null}
                                  </div>
                                  <button
                                    type="button"
                                    onClick={() => copy(addr, c)}
                                    className="text-[11px] text-accent hover:underline font-medium"
                                  >
                                    {copiedItem === c ? "✓ Copied!" : "Copy Address"}
                                  </button>
                                </div>
                                <p className="font-mono text-[11px] text-muted break-all select-all">{addr}</p>
                              </div>
                            );
                          })}
                          <p className="text-[11px] text-muted pt-1">
                            💡 Send your trading token and a little gas to your <strong>{NAMES[chain]}</strong> address.
                          </p>
                        </div>

                        <div className="flex justify-end pt-1">
                          <button
                            type="button"
                            onClick={() => void onGenerateWallet()}
                            className="text-xs text-subtle hover:text-fg transition"
                          >
                            🔄 Generate different wallet
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  <label className="block space-y-2">
                    <span className="text-sm text-muted">Private key</span>
                    <input
                      type="password"
                      autoComplete="off"
                      placeholder="Paste private key (or 12-word seed phrase)"
                      value={privateKey}
                      onChange={(event) => setPrivateKey(event.target.value)}
                      className="min-h-11 w-full rounded-2xl border border-line bg-surface px-3 text-fg placeholder:text-subtle focus:outline-none focus:border-accent"
                    />
                  </label>
                )}
              </div>

              <label className="flex gap-3 rounded-3xl border border-line bg-surface-2 p-4 text-sm text-fg">
                <input
                  type="checkbox"
                  checked={freshAck}
                  onChange={(event) => setFreshAck(event.target.checked)}
                  className="mt-1 size-4 accent-accent"
                />
                <span>
                  {walletMode === "generate"
                    ? "I have written down and saved my 12-word recovery seed phrase. I will only deposit the trading amount into this address."
                    : "This is a fresh wallet, not my main wallet. I will keep only the trading amount in it. Do not use the wallet that is already running."}
                </span>
              </label>

              <button
                type="submit"
                disabled={busy || !access.covered}
                className="min-h-11 w-full rounded-full bg-accent px-4 text-sm font-semibold text-accent-fg disabled:opacity-60 transition"
              >
                {access.covered ? "Add token" : "Pay the month first"}
              </button>
            </form>
          ) : null}
          {error ? <p className="text-sm text-danger">{error}</p> : null}
          <Operator
            operator={operator}
            rows={rows}
            disputes={disputes}
            busy={busy}
            onResolve={(id, action, note) => void onResolveDispute(id, action, note)}
          />
        </section>
      ) : null}
    </main>
  );
}

function Payment({
  access,
  payChain,
  txHash,
  busy,
  onChain,
  onTx,
  onPay,
  disputeOpen,
  onToggleDispute,
  disputeNote,
  onDisputeNoteChange,
  onSubmitDispute,
  disputeMsg,
  userDisputes,
}: {
  access: PublicAccess;
  payChain: PayChain;
  txHash: string;
  busy: boolean;
  onChain: (chain: PayChain) => void;
  onTx: (value: string) => void;
  onPay: () => void;
  disputeOpen: boolean;
  onToggleDispute: () => void;
  disputeNote: string;
  onDisputeNoteChange: (note: string) => void;
  onSubmitDispute: () => void;
  disputeMsg: string;
  userDisputes: DisputeRow[];
}) {
  return (
    <div className="space-y-4 rounded-3xl border border-line bg-surface p-4">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-subtle">{access.covered ? "Month covered" : "Month due"}</p>
        <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${access.covered ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20" : "bg-amber-500/10 text-amber-400 border border-amber-500/20"}`}>
          {access.covered ? "ACTIVE" : "INACTIVE"}
        </span>
      </div>

      <div>
        <p className="font-display text-2xl text-fg">{"$" + DONATION_USD + " USD / 30 days"}</p>
        <p className="mt-1 text-sm text-muted">Accepted tokens: USDT, USDC, or USDG (minimum $20). No memo required.</p>
      </div>

      <div className="space-y-2 rounded-2xl bg-bg/50 p-3 text-xs">
        <div>
          <span className="font-medium text-subtle">Solana deposit (USDT/USDC):</span>
          <p className="mt-0.5 select-all font-mono text-fg break-all">{PAY_SOLANA}</p>
        </div>
        <div className="pt-1 border-t border-line/40">
          <span className="font-medium text-subtle">Base / BNB deposit (USDT/USDC) & Robinhood Chain (USDG):</span>
          <p className="mt-0.5 select-all font-mono text-fg break-all">{PAY_EVM}</p>
        </div>
      </div>

      <div className="space-y-2">
        <label className="text-xs text-muted">Select Payment Chain:</label>
        <div className="grid grid-cols-4 gap-2">
          {(["solana", "base", "bsc", "robinhood"] as const).map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => onChain(item)}
              className={`min-h-10 rounded-xl border text-xs font-medium transition ${payChain === item ? "border-accent bg-accent text-accent-fg" : "border-line bg-surface-2 text-fg hover:border-line/80"}`}
            >
              {item === "bsc" ? "BNB" : item === "base" ? "Base" : item === "robinhood" ? "Robinhood" : "Solana"}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-2">
        <input
          value={txHash}
          placeholder="Paste transaction hash or signature"
          onChange={(event) => onTx(event.target.value)}
          className="min-h-11 w-full rounded-2xl border border-line bg-bg px-3 text-sm text-fg placeholder:text-subtle focus:outline-none focus:border-accent"
        />
        <div className="flex gap-2">
          <button
            type="button"
            disabled={busy || !txHash.trim()}
            onClick={onPay}
            className="min-h-11 flex-1 rounded-full bg-accent text-sm font-medium text-accent-fg disabled:opacity-50 transition"
          >
            Check payment
          </button>
          <button
            type="button"
            onClick={onToggleDispute}
            className="min-h-11 rounded-full border border-line px-4 text-xs font-medium text-fg hover:bg-surface-2 transition"
          >
            {disputeOpen ? "Close dispute" : "Raise dispute"}
          </button>
        </div>
      </div>

      {disputeOpen ? (
        <div className="mt-3 space-y-3 rounded-2xl border border-line/80 bg-surface-2 p-3 text-sm">
          <p className="font-medium text-fg">Raise Transaction Dispute</p>
          <p className="text-xs text-muted">
            If your transaction did not activate automatically, submit it here. It will be sent to the admin portal for verification.
          </p>
          <input
            value={disputeNote}
            placeholder="Optional note for admin (e.g., wallet used, sent via exchange)"
            onChange={(e) => onDisputeNoteChange(e.target.value)}
            className="min-h-10 w-full rounded-xl border border-line bg-bg px-3 text-xs text-fg placeholder:text-subtle"
          />
          <button
            type="button"
            disabled={busy || !txHash.trim()}
            onClick={onSubmitDispute}
            className="min-h-10 w-full rounded-xl bg-accent text-xs font-medium text-accent-fg disabled:opacity-50"
          >
            Submit dispute to admin
          </button>
          {disputeMsg ? <p className="text-xs text-emerald-400">{disputeMsg}</p> : null}
        </div>
      ) : null}

      {userDisputes.length > 0 ? (
        <div className="space-y-2 pt-2 border-t border-line/40">
          <p className="text-xs font-semibold text-subtle">Your Raised Disputes</p>
          {userDisputes.map((d) => (
            <div key={d.id} className="rounded-xl border border-line/60 bg-bg/40 p-2.5 text-xs space-y-1">
              <div className="flex items-center justify-between">
                <span className="font-mono text-muted">{d.id} · {d.chain.toUpperCase()}</span>
                <span
                  className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                    d.status === "accepted"
                      ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
                      : d.status === "rejected"
                      ? "bg-rose-500/10 text-rose-400 border border-rose-500/20"
                      : "bg-amber-500/10 text-amber-400 border border-amber-500/20"
                  }`}
                >
                  {d.status.toUpperCase()}
                </span>
              </div>
              <p className="font-mono text-fg text-[11px] truncate">
                <a href={explorerUrl(d.chain, d.txHash)} target="_blank" rel="noreferrer" className="underline hover:text-accent">
                  {short(d.txHash)}
                </a>
              </p>
              {d.adminNote ? <p className="text-subtle text-[11px]">Admin note: {d.adminNote}</p> : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function Field({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (value: string) => void; placeholder: string }) {
  return (
    <label className="block space-y-2">
      <span className="text-sm text-muted">{label}</span>
      <input value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} className="min-h-11 w-full rounded-2xl border border-line bg-surface px-3 text-fg placeholder:text-subtle" />
    </label>
  );
}

function Guide() {
  return (
    <article className="mt-8 space-y-5 text-sm text-muted">
      <h2 className="font-display text-2xl text-fg">How this works</h2>
      <p>Each account can run up to {MAX_TOKENS} different tokens across Solana, Stacks, or Robinhood. After the quiet interval, that token sells one clip and buys the same dollar amount back to keep activity alive. It never withdraws your funds.</p>
      <h2 className="font-display text-2xl text-fg">Interval per trade (Trade size scope)</h2>
      <p>You can choose your trade size bracket: $5–$20, $21–$50, $51–$100, or $100+. The bot automatically searches for the lowest fee and spread within that scope while strictly respecting your available wallet balance. The quoted round trip is skipped when spread is worse than {MAX_ROUND_TRIP_PCT}%.</p>
      <h2 className="font-display text-2xl text-fg">Universal Multi-Chain Wallet</h2>
      <p>You can generate a single 12-word recovery seed phrase that creates deposit addresses for Solana, Robinhood, and Stacks all at once. Simply save your seed phrase offline, deposit tokens and gas into the generated address, and the bot handles the rest. Alternatively, you can import an existing private key.</p>
      <p>{"Access is $" + DONATION_USD + " or more for 30 days, in USDT, USDC, or USDG, on Solana, Base, BNB, or Robinhood Chain. No memo is required."}</p>
    </article>
  );
}

function SignedOutGate() {
  return (
    <section className="mt-8 space-y-4">
      <p className="text-sm text-muted">Sign in to access your trading desk. The operator still cannot read a key.</p>
      <EmailAccess />
      {authEnabled
        ? GROK_PROVIDERS.map((provider) => (
            <button key={provider.providerId} type="button" onClick={() => signIn(provider.providerId, { callbackURL: "/" })} className="min-h-11 w-full rounded-full border border-line text-sm text-fg">
              Continue with {provider.label}
            </button>
          ))
        : null}
    </section>
  );
}

function Operator({
  operator,
  rows,
  disputes,
  busy,
  onResolve,
}: {
  operator: boolean;
  rows: OperatorRow[] | null;
  disputes: DisputeRow[];
  busy: boolean;
  onResolve: (disputeId: string, action: "accept" | "reject", note?: string) => void;
}) {
  const [activeTab, setActiveTab] = useState<"disputes" | "slots">("disputes");
  const [adminNotes, setAdminNotes] = useState<Record<string, string>>({});

  const pendingDisputes = disputes.filter((d) => d.status === "pending");
  const resolvedDisputes = disputes.filter((d) => d.status !== "pending");

  return (
    <section className="space-y-4 border-t border-line pt-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-display text-xl text-fg">Admin & Operator Portal</h2>
          <p className="text-xs text-muted">
            {operator ? "Verify disputes and monitor member activity." : "You are not the operator. This board never includes a private key."}
          </p>
        </div>
        {operator ? (
          <div className="flex gap-1 rounded-full border border-line bg-surface-2 p-1 text-xs">
            <button
              type="button"
              onClick={() => setActiveTab("disputes")}
              className={`rounded-full px-3 py-1 font-medium transition ${activeTab === "disputes" ? "bg-accent text-accent-fg" : "text-muted hover:text-fg"}`}
            >
              Disputes ({pendingDisputes.length})
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("slots")}
              className={`rounded-full px-3 py-1 font-medium transition ${activeTab === "slots" ? "bg-accent text-accent-fg" : "text-muted hover:text-fg"}`}
            >
              Slots ({rows?.length ?? 0})
            </button>
          </div>
        ) : null}
      </div>

      {operator && activeTab === "disputes" ? (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-fg">Pending Verification ({pendingDisputes.length})</h3>
          </div>

          {pendingDisputes.length === 0 ? (
            <div className="rounded-2xl border border-line/60 bg-surface/50 p-6 text-center text-xs text-subtle">
              No pending disputes to review. All transactions are clear.
            </div>
          ) : (
            pendingDisputes.map((dispute) => (
              <div key={dispute.id} className="space-y-3 rounded-2xl border border-line bg-surface p-4 text-xs">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="font-mono font-semibold text-fg">{dispute.id}</span>
                    <span className="rounded bg-accent/20 px-2 py-0.5 font-mono text-[10px] text-accent">
                      {dispute.chain.toUpperCase()}
                    </span>
                  </div>
                  <span className="rounded-full border border-amber-500/20 bg-amber-500/10 px-2.5 py-0.5 text-[10px] font-medium text-amber-400">
                    PENDING
                  </span>
                </div>

                <div className="space-y-1 rounded-xl bg-bg/60 p-2.5 text-xs">
                  <div className="flex justify-between">
                    <span className="text-subtle">User ID:</span>
                    <span className="font-mono text-fg">{dispute.userId}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-subtle">Tx Hash:</span>
                    <a
                      href={explorerUrl(dispute.chain, dispute.txHash)}
                      target="_blank"
                      rel="noreferrer"
                      className="font-mono text-accent underline hover:opacity-80"
                    >
                      {short(dispute.txHash)} ↗
                    </a>
                  </div>
                  {dispute.userNote ? (
                    <div className="pt-1 border-t border-line/40">
                      <span className="text-subtle">User note: </span>
                      <span className="text-fg">{dispute.userNote}</span>
                    </div>
                  ) : null}
                </div>

                <div className="space-y-2">
                  <input
                    value={adminNotes[dispute.id] ?? ""}
                    placeholder="Admin note (optional reason)"
                    onChange={(e) => setAdminNotes({ ...adminNotes, [dispute.id]: e.target.value })}
                    className="min-h-9 w-full rounded-xl border border-line bg-bg px-3 text-xs text-fg placeholder:text-subtle"
                  />
                  <div className="flex gap-2">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => onResolve(dispute.id, "accept", adminNotes[dispute.id])}
                      className="min-h-9 flex-1 rounded-xl bg-emerald-600 font-medium text-white hover:bg-emerald-500 disabled:opacity-50 transition"
                    >
                      Accept (Credit 30 Days)
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => onResolve(dispute.id, "reject", adminNotes[dispute.id])}
                      className="min-h-9 rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 font-medium text-rose-400 hover:bg-rose-500/20 disabled:opacity-50 transition"
                    >
                      Reject
                    </button>
                  </div>
                </div>
              </div>
            ))
          )}

          {resolvedDisputes.length > 0 ? (
            <div className="space-y-2 pt-3 border-t border-line/40">
              <h4 className="text-xs font-semibold text-subtle">Past Resolved Disputes ({resolvedDisputes.length})</h4>
              {resolvedDisputes.map((d) => (
                <div key={d.id} className="flex items-center justify-between rounded-xl border border-line/50 bg-surface/30 p-2.5 text-xs">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-fg">{d.id}</span>
                      <span className="text-subtle">({d.chain})</span>
                      <a
                        href={explorerUrl(d.chain, d.txHash)}
                        target="_blank"
                        rel="noreferrer"
                        className="font-mono text-muted underline hover:text-fg text-[11px]"
                      >
                        {short(d.txHash)}
                      </a>
                    </div>
                    {d.adminNote ? <p className="text-[11px] text-subtle mt-0.5">Admin: {d.adminNote}</p> : null}
                  </div>
                  <span
                    className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                      d.status === "accepted" ? "bg-emerald-500/10 text-emerald-400" : "bg-rose-500/10 text-rose-400"
                    }`}
                  >
                    {d.status.toUpperCase()}
                  </span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {operator && activeTab === "slots" ? (
        <div className="space-y-3">
          {rows && rows.length === 0 ? <p className="text-sm text-subtle">No tokens yet.</p> : null}
          {rows?.map((row) => (
            <div key={`${row.chain}-${row.address}-${row.token}`} className="rounded-2xl border border-line p-3 text-sm">
              <p className="text-fg">{row.symbol || row.chain}</p>
              <p className="text-muted">{short(row.address)}</p>
              <p className="text-subtle">{row.covered ? "Month covered" : "Month due"}</p>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function short(value: string): string {
  if (value.length < 14) return value;
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}
