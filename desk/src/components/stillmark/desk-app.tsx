import { useEffect, useRef, useState } from "react";
import { Area, AreaChart, ReferenceLine, ResponsiveContainer, YAxis } from "recharts";
import { syncDesk } from "@/lib/telegram/api";
import { equityAt } from "@/lib/engine/orders";
import { HARD_MIN_PROTECTED_USD, INACTIVITY_INTERVALS, INTERVAL_LABEL, type IntervalKey } from "@/lib/engine/types";
import { intervalLeft, useDesk } from "@/lib/desk/store";

function money(value: number): string {
  return value.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function pct(value: number): string {
  return `${value.toFixed(2)}%`;
}

function remain(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) return `${h}h ${m.toString().padStart(2, "0")}m`;
  return `${m}m ${r.toString().padStart(2, "0")}s`;
}

export function StillmarkApp() {
  const desk = useDesk();
  const [mounted, setMounted] = useState(false);
  const [line, setLine] = useState("");
  const replies = useRef<{ updateId: number; chatId: number; text: string; keyboard?: "interval" }[]>([]);
  const acks = useRef<number[]>([]);
  const seen = useRef(new Set<number>());

  useEffect(() => {
    useDesk.getState().boot();
    setMounted(true);
    const id = window.setInterval(() => useDesk.getState().tick(400), 400);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    if (!mounted) return;
    let stop = false;
    const pull = async () => {
      try {
        const outgoing = replies.current.splice(0);
        const ack = acks.current.splice(0);
        const result = await syncDesk({
          data: { snapshot: useDesk.getState().snapshot(), replies: outgoing, ack },
        });
        if (stop) return;
        if (result.boundAdminId && result.boundAdminId !== useDesk.getState().adminId) {
          useDesk.getState().setAdmin(result.boundAdminId);
        }
        for (const cmd of result.commands) {
          acks.current.push(cmd.updateId);
          if (seen.current.has(cmd.updateId)) continue;
          seen.current.add(cmd.updateId);
          const reply = useDesk.getState().command(cmd.text, cmd.fromId);
          replies.current.push({ updateId: cmd.updateId, chatId: cmd.chatId, text: reply.text, keyboard: reply.keyboard });
        }
      } catch {
        /* The desk mirror can miss a beat. Telegram does not depend on it. */
      }
    };
    void pull();
    const id = window.setInterval(() => void pull(), 2000);
    return () => {
      stop = true;
      window.clearInterval(id);
    };
  }, [mounted]);

  const equity = equityAt(desk.balances, desk.market.mid);
  const left = intervalLeft(desk);
  const windowSec = INACTIVITY_INTERVALS[desk.config.interval];
  const progress = desk.active ? Math.min(100, ((windowSec - left) / windowSec) * 100) : 0;
  const decision = desk.decision;
  const bookPasses = Boolean(decision?.readyExceptWindow);
  const headline = !decision
    ? "Reading the book"
    : !desk.active
      ? bookPasses
        ? "Preview would pass"
        : "Preview would skip"
      : decision.execute
        ? "Cost passed"
        : "Skipped";
  const tone = !decision ? "text-fg" : (desk.active ? decision.execute : bookPasses) ? "text-ok" : "text-warn";
  const gates = (decision?.gates ?? []).map((gate) =>
    !desk.active && gate.id === "window" ? { ...gate, pass: false, detail: "Starts on resume" } : gate,
  );

  return (
    <main className="mx-auto min-h-screen w-full max-w-5xl px-4 pt-6 pb-16 sm:px-6">
      <header className="flex items-end justify-between gap-4">
        <div>
          <p className="text-xs font-medium tracking-wide text-subtle">Chain 4663 · ETH gas</p>
          <h1 className="font-display text-3xl font-medium tracking-tight text-fg">Robinhood Chain</h1>
        </div>
        <p className="text-right text-sm text-muted">
          <span className="block text-fg">{desk.halted ? "Halted" : desk.active ? "Monitoring" : "Standing by"}</span>
          <span className="block">{desk.config.pair}</span>
        </p>
      </header>

      <div className="mt-6 grid items-start gap-4 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)]">
        <section className="grid gap-4">
          <article className="rounded-3xl border border-line bg-surface p-4">
            <p className="text-xs font-medium tracking-wide text-subtle">Paper equity</p>
            <p className="mt-1 font-display text-5xl font-medium tabular-nums tracking-tight text-fg">{money(equity)}</p>
            <p className="mt-2 text-sm text-muted">
              {money(desk.balances.usd)} cash · {desk.balances.tokenQty.toFixed(4)} token · floor {money(desk.config.minProtectedUsd)} locked
            </p>
            <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-surface-2">
              <div className="h-full bg-accent" style={{ width: `${progress}%` }} />
            </div>
            <p className="mt-2 text-sm text-muted">
              {desk.active
                ? `Inactivity window ${remain(left)} of ${INTERVAL_LABEL[desk.config.interval]}. Paper clock ${desk.pace}×.`
                : "The window starts when you resume. Nothing trades on its own."}
            </p>
          </article>

          <article className="rounded-3xl border border-line bg-surface p-4">
            <p className="text-xs font-medium tracking-wide text-subtle">{desk.active ? "Latest evaluation" : "Book preview"}</p>
            <h2 className={`mt-1 font-display text-3xl font-medium ${tone}`}>{headline}</h2>
            <p className="mt-2 text-sm text-muted">{decision?.reason ?? "The paper book is warming up."}</p>
            {decision?.cost && (
              <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
                <Stat label="Spread" value={pct(decision.cost.spreadPct)} />
                <Stat label="Round trip" value={pct(decision.cost.estimatedTotalCostPct)} />
                <Stat label="Fee" value={pct(decision.cost.estimatedFeePct)} />
                <Stat label="Slippage" value={pct(decision.cost.estimatedSlippagePct)} />
                <Stat label="Impact" value={pct(decision.cost.estimatedImpactPct)} />
                <Stat label="After cycle" value={money(decision.cost.expectedRemainingBalance)} />
                <Stat label="Sell size" value={money(decision.cost.sellNotionalUsd)} />
                <Stat label="Order" value={decision.cost.orderType === "none" ? "None" : decision.cost.orderType === "limit" ? "Limit" : "Market"} />
              </div>
            )}
            <p className="mt-4 text-sm text-subtle">
              {desk.active
                ? "A passing window only opens this check. A skip is a successful decision."
                : "Preview ignores the timer so you can see the cost. It cannot submit an order."}
            </p>
          </article>
        </section>

        <section className="grid gap-4">
          <article className="rounded-3xl border border-line bg-surface p-4">
            <p className="text-xs font-medium tracking-wide text-subtle">Preflight</p>
            <ul className="mt-3 grid gap-2">
              {(gates).map((gate) => (
                <li key={gate.id} className="flex items-baseline justify-between gap-3 text-sm">
                  <span className="text-fg">{gate.label}</span>
                  <span className={gate.pass ? "text-ok tabular-nums" : "text-danger tabular-nums"}>{gate.detail}</span>
                </li>
              ))}
              {!decision && <li className="text-sm text-muted">Waiting for the first quote.</li>}
            </ul>
          </article>

          <article className="rounded-3xl border border-line bg-surface p-4">
            <div className="flex items-baseline justify-between gap-3">
              <p className="text-xs font-medium tracking-wide text-subtle">Paper spread</p>
              <p className="text-sm tabular-nums text-muted">
                {desk.market.bid.toFixed(4)} / {desk.market.ask.toFixed(4)}
              </p>
            </div>
            <div className="mt-3 h-36 w-full min-w-0">
              {mounted && desk.points.length > 1 ? (
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={desk.points} margin={{ top: 8, right: 0, left: 0, bottom: 0 }}>
                    <YAxis hide domain={[0, Math.max(0.8, desk.config.maxSpreadPct * 2)]} />
                    <ReferenceLine y={desk.config.maxSpreadPct} stroke="var(--color-danger)" strokeDasharray="3 3" />
                    <Area
                      type="monotone"
                      dataKey="spread"
                      stroke="var(--color-accent)"
                      fill="var(--color-surface-2)"
                      strokeWidth={1.5}
                      isAnimationActive={false}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              ) : (
                <div className="flex h-full items-center text-sm text-subtle">Spread prints after the clock starts.</div>
              )}
            </div>
            <p className="mt-2 text-sm text-subtle">Dashed line is the maximum spread. This book is simulated.</p>
          </article>
        </section>
      </div>

      {desk.pending && (
        <section className="mt-4 rounded-3xl border border-line bg-surface p-4">
          <p className="text-xs font-medium tracking-wide text-subtle">Confirmation</p>
          <p className="mt-2 whitespace-pre-wrap text-sm text-fg">{desk.pending.summary}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" className="h-11 rounded-lg bg-accent px-4 text-sm font-medium text-accent-fg" onClick={() => desk.command("CONFIRM")}>
              Confirm
            </button>
            <button type="button" className="h-11 rounded-lg border border-line bg-surface-2 px-4 text-sm font-medium text-fg" onClick={() => desk.dismissPending()}>
              Dismiss
            </button>
          </div>
        </section>
      )}

      {desk.recovery && (
        <section className="mt-4 rounded-3xl border border-line bg-surface p-4">
          <p className="text-sm text-danger">{desk.recovery}</p>
          <button type="button" className="mt-3 h-11 rounded-lg border border-line bg-surface-2 px-4 text-sm font-medium text-fg" onClick={() => desk.acknowledgeRecovery()}>
            Acknowledge hold
          </button>
        </section>
      )}

      <section className="mt-4 rounded-3xl border border-line bg-surface p-4">
        <p className="text-xs font-medium tracking-wide text-subtle">Controls</p>
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {(Object.keys(INTERVAL_LABEL) as IntervalKey[]).map((key) => (
            <button
              key={key}
              type="button"
              className={`h-11 rounded-lg border text-sm font-medium ${desk.config.interval === key ? "border-accent bg-accent text-accent-fg" : "border-line bg-surface-2 text-fg"}`}
              onClick={() => desk.command(`/interval ${key}`)}
            >
              {INTERVAL_LABEL[key]}
            </button>
          ))}
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {[1, 10, 20, 60].map((pace) => (
            <button
              key={pace}
              type="button"
              className={`h-11 rounded-lg border text-sm font-medium ${desk.pace === pace ? "border-accent bg-accent text-accent-fg" : "border-line bg-surface-2 text-fg"}`}
              onClick={() => desk.setPace(pace)}
            >
              Clock {pace}×
            </button>
          ))}
        </div>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <label className="grid gap-1 text-sm text-muted">
            Trade target
            <input
              className="h-11 rounded-lg border border-line bg-surface-2 px-3 text-fg tabular-nums"
              inputMode="decimal"
              value={String(desk.config.tradeTargetUsd)}
              onChange={(event) => desk.setTarget(Number(event.target.value))}
            />
          </label>
          <label className="grid gap-1 text-sm text-muted">
            Protected floor, minimum {money(HARD_MIN_PROTECTED_USD)}
            <input
              className="h-11 rounded-lg border border-line bg-surface-2 px-3 text-fg tabular-nums"
              inputMode="decimal"
              value={String(desk.config.minProtectedUsd)}
              onChange={(event) => desk.setFloor(Number(event.target.value))}
            />
          </label>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" className="h-11 rounded-lg bg-accent px-4 text-sm font-medium text-accent-fg" onClick={() => desk.command("/resume")}>
            Resume
          </button>
          <button type="button" className="h-11 rounded-lg border border-line bg-surface-2 px-4 text-sm font-medium text-fg" onClick={() => desk.command("/pause")}>
            Pause
          </button>
          <button type="button" className="h-11 rounded-lg border border-line bg-surface-2 px-4 text-sm font-medium text-fg" onClick={() => desk.command("/test")}>
            Evaluate once
          </button>
          <button type="button" className="h-11 rounded-lg border border-line bg-surface-2 px-4 text-sm font-medium text-fg" onClick={() => desk.command("/simulate")}>
            Replay 24h
          </button>
          <button
            type="button"
            className={`h-11 rounded-lg border px-4 text-sm font-medium ${desk.paperFills ? "border-accent bg-accent text-accent-fg" : "border-line bg-surface-2 text-fg"}`}
            onClick={() => desk.setPaperFills(!desk.paperFills)}
          >
            {desk.paperFills ? "Paper fills on" : "Paper fills off"}
          </button>
          <button type="button" className="h-11 rounded-lg border border-line bg-surface-2 px-4 text-sm font-medium text-danger" onClick={() => desk.command("/emergency_stop")}>
            Emergency stop
          </button>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" className="h-11 rounded-lg border border-line px-4 text-sm text-muted" onClick={() => desk.drill("stale")}>
            Drill stale quote
          </button>
          <button type="button" className="h-11 rounded-lg border border-line px-4 text-sm text-muted" onClick={() => desk.drill("jump")}>
            Drill price jump
          </button>
        </div>
      </section>

      {desk.report && (
        <section className="mt-4 rounded-3xl border border-line bg-surface p-4">
          <p className="text-xs font-medium tracking-wide text-subtle">24 hour paper replay</p>
          <div className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            <Stat label="Opportunities" value={String(desk.report.opportunities)} />
            <Stat label="Executed" value={String(desk.report.executed)} />
            <Stat label="Skipped" value={String(desk.report.skipped)} />
            <Stat label="Failed" value={String(desk.report.failed)} />
            <Stat label="Avg spread" value={pct(desk.report.avgSpreadPct)} />
            <Stat label="Avg fee" value={pct(desk.report.avgFeePct)} />
            <Stat label="Avg slippage" value={pct(desk.report.avgSlippagePct)} />
            <Stat label="Estimated cost" value={money(desk.report.totalEstimatedCostUsd)} />
            <Stat label="Start" value={money(desk.report.startingEquity)} />
            <Stat label="End" value={money(desk.report.endingEquity)} />
          </div>
        </section>
      )}

      <section className="mt-4 grid gap-4 lg:grid-cols-2">
        <article className="rounded-3xl border border-line bg-surface p-4">
          <p className="text-xs font-medium tracking-wide text-subtle">Telegram</p>
          <p className="mt-2 text-sm text-fg">The bot runs inside Telegram. This page does not need to stay open.</p>
          <p className="mt-2 text-sm text-muted">
            {desk.adminId
              ? `Locked to Telegram user id ${desk.adminId}. Only that account can command the bot.`
              : "Send your own numeric Telegram user id to the bot. That message is the only confirmation."}
          </p>
          <p className="mt-3 text-sm text-fg tabular-nums">
            {desk.adminId ? `Admin ${desk.adminId}` : "Admin not locked"}
          </p>
          {desk.security.length > 0 && (
            <ul className="mt-3 grid gap-2">
              {desk.security.slice(0, 3).map((row) => (
                <li key={row.id} className="text-sm text-warn">
                  {row.title}. {row.detail}
                </li>
              ))}
            </ul>
          )}
          <form
            className="mt-3 flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (!line.trim()) return;
              desk.command(line.trim());
              setLine("");
            }}
          >
            <input
              className="h-11 min-w-0 flex-1 rounded-lg border border-line bg-surface-2 px-3 text-sm text-fg"
              value={line}
              placeholder="/status"
              onChange={(event) => setLine(event.target.value)}
            />
            <button type="submit" className="h-11 rounded-lg bg-accent px-4 text-sm font-medium text-accent-fg">
              Send
            </button>
          </form>
        </article>

        <article className="rounded-3xl border border-line bg-surface p-4">
          <p className="text-xs font-medium tracking-wide text-subtle">Robinhood Chain</p>
          <p className="mt-2 text-sm text-muted">
            The bot runs in Telegram on Robinhood Chain, chain 4663. Gas is ETH. Add a wallet private key or phrase there, then add a token by its contract address. This is not the Robinhood exchange, and this page does not take a key.
          </p>
          <p className="mt-2 text-sm text-fg">Explorer: robinhoodchain.blockscout.com</p>
        </article>
      </section>

      <section className="mt-4 rounded-3xl border border-line bg-surface p-4">
        <p className="text-xs font-medium tracking-wide text-subtle">Tape</p>
        <ul className="mt-3 grid gap-3">
          {desk.tape.length === 0 && <li className="text-sm text-muted">No evaluations yet. Resume, or run a single test.</li>}
          {desk.tape.slice(0, 8).map((row) => (
            <li key={row.id} className="border-t border-line pt-3 first:border-t-0 first:pt-0">
              <p className="text-sm text-fg">{row.title}</p>
              <p className="text-sm text-muted">{row.detail}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-4 rounded-3xl border border-line bg-surface p-4">
        <p className="text-xs font-medium tracking-wide text-subtle">What this will not do</p>
        <div className="mt-2 grid gap-2 text-sm text-muted">
          <p>Security, then the {money(HARD_MIN_PROTECTED_USD)} floor, then a fresh quote, then total cost. The timer is last. If a higher check fails, nothing is sent.</p>
          <p>The practice book is not Robinhood Chain. Token balances are read in Telegram after you add a contract address. No exchange order is sent from this page.</p>
          <p>The local envelope is not a cloud KMS. Do not paste a production private key into a shared preview. Rotate the Telegram token before any real account is attached. This is not investment advice.</p>
        </div>
      </section>
    </main>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-surface-2 px-3 py-2">
      <dt className="text-xs text-subtle">{label}</dt>
      <dd className="mt-1 tabular-nums text-fg">{value}</dd>
    </div>
  );
}
