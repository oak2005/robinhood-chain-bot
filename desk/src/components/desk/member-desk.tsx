import { useEffect, useState } from "react";
import { UserButton } from "@/lib/auth/gates";
import { GROK_PROVIDERS, authEnabled, signIn } from "@/lib/auth/client";
import { useCurrentUser, useCurrentUserState } from "@/lib/auth/use-current-user";
import { EmailAccess } from "@/components/desk/email-access";
import { addSlot, confirmPayment, getAccess, operatorBoard, removeSlot } from "@/lib/members/api";
import { DONATION_USD, LADDER_USD, MAX_ROUND_TRIP_PCT, MAX_TOKENS, PAY_EVM, PAY_SOLANA, type OperatorRow, type PublicAccess } from "@/lib/members/public";

type Chain = "solana" | "stacks" | "robinhood";
type PayChain = "solana" | "base" | "bsc";
type Interval = "10m" | "20m" | "30m" | "1h";

const CHAINS: Chain[] = ["solana", "stacks", "robinhood"];
const INTERVALS: Interval[] = ["10m", "20m", "30m", "1h"];
const NAMES: Record<Chain, string> = { solana: "Solana", stacks: "Stacks", robinhood: "Robinhood" };

export function MemberDesk() {
  const { isPending } = useCurrentUserState();
  const user = useCurrentUser();
  const [help, setHelp] = useState(false);
  const [access, setAccess] = useState<PublicAccess | null>(null);
  const [rows, setRows] = useState<OperatorRow[] | null>(null);
  const [operator, setOperator] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [chain, setChain] = useState<Chain>("solana");
  const [token, setToken] = useState("");
  const [symbol, setSymbol] = useState("");
  const [interval, setIntervalKey] = useState<Interval>("30m");
  const [privateKey, setPrivateKey] = useState("");
  const [freshAck, setFreshAck] = useState(false);
  const [payChain, setPayChain] = useState<PayChain>("solana");
  const [txHash, setTxHash] = useState("");

  useEffect(() => {
    if (!user) return;
    let gone = false;
    void Promise.all([getAccess(), operatorBoard()]).then(([mine, board]) => {
      if (gone) return;
      setAccess(mine);
      setOperator(board.operator);
      setRows(board.rows);
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
    } catch {
      setError("Could not check that payment.");
    } finally {
      setBusy(false);
    }
  }

  async function onAdd() {
    setError("");
    if (!freshAck) {
      setError("Tick the fresh-wallet warning before the key is accepted.");
      return;
    }
    setBusy(true);
    try {
      const result = await addSlot({ data: { chain, privateKey, token, symbol, interval, freshAck: true } });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setAccess(result.access);
      setPrivateKey("");
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
          <Payment access={access} payChain={payChain} txHash={txHash} busy={busy} onChain={setPayChain} onTx={setTxHash} onPay={() => void onPay()} />
          <div className="space-y-3">
            <h2 className="font-display text-xl text-fg">{"Tokens " + access.slots.length + " of " + MAX_TOKENS}</h2>
            {access.slots.map((slot) => (
              <div key={slot.id} className="flex items-center justify-between gap-3 rounded-2xl border border-line bg-surface p-3">
                <div>
                  <p className="text-fg">{slot.symbol || NAMES[slot.chain]}</p>
                  <p className="text-sm text-muted">{NAMES[slot.chain]} · {short(slot.address)} · {slot.interval}</p>
                </div>
                <button type="button" onClick={() => void onRemove(slot.id)} className="min-h-11 rounded-full border border-line px-3 text-sm text-fg">
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
                    <button key={item} type="button" onClick={() => setChain(item)} className={`min-h-11 rounded-2xl border px-2 text-sm ${chain === item ? "border-accent bg-accent text-accent-fg" : "border-line bg-surface text-fg"}`}>
                      {NAMES[item]}
                    </button>
                  ))}
                </div>
              </fieldset>
              <Field label={chain === "robinhood" ? "Token contract" : chain === "solana" ? "Token mint" : "Token contract"} value={token} onChange={setToken} placeholder={chain === "solana" ? "Mint address" : chain === "stacks" ? "SP….token-name" : "0x token"} />
              <Field label="Symbol" value={symbol} onChange={setSymbol} placeholder="Optional" />
              <label className="block space-y-2">
                <span className="text-sm text-muted">Quiet interval</span>
                <select value={interval} onChange={(event) => setIntervalKey(event.target.value as Interval)} className="min-h-11 w-full rounded-2xl border border-line bg-surface px-3 text-fg">
                  {INTERVALS.map((item) => (
                    <option key={item} value={item}>{item}</option>
                  ))}
                </select>
              </label>
              <label className="flex gap-3 rounded-3xl border border-line bg-surface-2 p-4 text-sm text-fg">
                <input type="checkbox" checked={freshAck} onChange={(event) => setFreshAck(event.target.checked)} className="mt-1 size-4" />
                <span>This is a fresh wallet, not my main wallet. I will keep only the trading amount in it. Do not use the wallet that is already running, or the same coin will trade twice.</span>
              </label>
              <label className="block space-y-2">
                <span className="text-sm text-muted">Private key</span>
                <input type="password" autoComplete="off" value={privateKey} onChange={(event) => setPrivateKey(event.target.value)} className="min-h-11 w-full rounded-2xl border border-line bg-surface px-3 text-fg" />
              </label>
              <button type="submit" disabled={busy || !access.covered} className="min-h-11 w-full rounded-full bg-accent px-4 text-sm font-medium text-accent-fg disabled:opacity-60">
                {access.covered ? "Add token" : "Pay the month first"}
              </button>
            </form>
          ) : null}
          {error ? <p className="text-sm text-danger">{error}</p> : null}
          <Operator operator={operator} rows={rows} />
        </section>
      ) : null}
    </main>
  );
}

function Payment({ access, payChain, txHash, busy, onChain, onTx, onPay }: { access: PublicAccess; payChain: PayChain; txHash: string; busy: boolean; onChain: (chain: PayChain) => void; onTx: (value: string) => void; onPay: () => void }) {
  return (
    <div className="space-y-3 rounded-3xl border border-line bg-surface p-4">
      <p className="text-sm text-subtle">{access.covered ? "Month covered" : "Month due"}</p>
      <p className="font-display text-2xl text-fg">{access.memo}</p>
      <p className="text-sm text-muted">Your memo. It is unique to this account. Only USDT or USDC counts.</p>
      <p className="text-sm text-fg">{"Solana, Base, or BNB. Send $" + DONATION_USD + " or more in USDT or USDC, and put memo " + access.memo + " in the transaction. More than $20 is fine. Under $20, or a missing memo, is rejected."}</p>
      <p className="text-sm text-muted">{"Solana " + PAY_SOLANA}</p>
      <p className="text-sm text-muted">{"Base and BNB " + PAY_EVM}</p>
      <div className="grid grid-cols-3 gap-2">
        {(["solana", "base", "bsc"] as const).map((item) => (
          <button key={item} type="button" onClick={() => onChain(item)} className={`min-h-11 rounded-2xl border text-sm ${payChain === item ? "border-accent bg-accent text-accent-fg" : "border-line text-fg"}`}>
            {item === "bsc" ? "BNB" : item === "base" ? "Base" : "Solana"}
          </button>
        ))}
      </div>
      <input value={txHash} placeholder="Transaction hash" onChange={(event) => onTx(event.target.value)} className="min-h-11 w-full rounded-2xl border border-line bg-bg px-3 text-fg placeholder:text-subtle" />
      <button type="button" disabled={busy} onClick={onPay} className="min-h-11 w-full rounded-full bg-accent text-sm font-medium text-accent-fg disabled:opacity-60">
        Check payment
      </button>
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
      <p>Each account can run up to {MAX_TOKENS} different tokens. A token can be on Solana, Stacks, or Robinhood. After the quiet interval, that token sells one dollar clip and buys the same dollar amount back. It does not withdraw.</p>
      <h2 className="font-display text-2xl text-fg">The calculations</h2>
      <p>The clip rotates: {LADDER_USD.map((usd) => `$${usd.toFixed(2)}`).join(", ")}. Then it repeats. If the bag is smaller than the target, that cycle uses the bag. The quoted round trip is skipped when it is worse than {MAX_ROUND_TRIP_PCT}%. Gas is the network price, with no tip.</p>
      <p>{"Access is $" + DONATION_USD + " or more for 30 days, in USDT or USDC only, on Solana, Base, or BNB. The memo has to be in the transaction on every chain. A payment under $20 is rejected. The same transaction cannot be used twice."}</p>
      <h2 className="font-display text-2xl text-fg">The key</h2>
      <p>Use a fresh wallet. The key is sealed. The operator board shows the address, the token, and whether the month is paid. It does not load the key. Do not add the wallet that is already trading, or that coin will trade twice.</p>
    </article>
  );
}

function SignedOutGate() {
  return (
    <section className="mt-8 space-y-4">
      <p className="text-sm text-muted">Create an account to get a payment memo. The operator still cannot read a key.</p>
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

function Operator({ operator, rows }: { operator: boolean; rows: OperatorRow[] | null }) {
  return (
    <section className="space-y-3 border-t border-line pt-6">
      <h2 className="font-display text-xl text-fg">Operator board</h2>
      <p className="text-sm text-muted">{operator ? "Addresses and tokens only. No keys." : "You are not the operator. This board never includes a private key."}</p>
      {operator && rows && rows.length === 0 ? <p className="text-sm text-subtle">No tokens yet.</p> : null}
      {operator
        ? rows?.map((row) => (
            <div key={`${row.chain}-${row.address}-${row.token}`} className="rounded-2xl border border-line p-3 text-sm">
              <p className="text-fg">{row.symbol || row.chain}</p>
              <p className="text-muted">{short(row.address)}</p>
              <p className="text-subtle">{row.covered ? "Month covered" : "Month due"}</p>
            </div>
          ))
        : null}
    </section>
  );
}

function short(value: string): string {
  if (value.length < 14) return value;
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}
