import fs from "node:fs";

export interface TgWallet {
  user_id: string;
  chain: string;
  address: string;
  wrapped: string;
}

export interface TgToken {
  id: string;
  user_id: string;
  chain: string;
  token: string;
  symbol: string;
}

export interface MemberAccess {
  user_id: string;
  memo: string;
  paid_until: string | null;
  last_tx: string;
}

export interface UsedPayment {
  tx_hash: string;
  user_id: string;
  pay_chain: string;
  asset: string;
  amount: string;
}

export interface MemberSetting {
  user_id: string;
  paused: boolean;
  interval: string;
  trade_range: string;
  cycle_index: number;
  next_recheck_ms: number;
  last_trade_ms: number;
  last_trade_text: string;
}

export interface PaymentDispute {
  id: string;
  user_id: string;
  tx_hash: string;
  chain: string;
  user_note: string;
  status: string;
  admin_note: string;
  created_at: string;
  resolved_at: string | null;
}

export interface DbState {
  tg_wallets: TgWallet[];
  tg_tokens: TgToken[];
  member_access: MemberAccess[];
  used_payments: UsedPayment[];
  member_settings: MemberSetting[];
  payment_disputes: PaymentDispute[];
}

export class LightweightDb {
  filePath: string;
  state: DbState;

  constructor(filePath: string = "./data/bot-store.json") {
    this.filePath = filePath;
    this.state = {
      tg_wallets: [],
      tg_tokens: [],
      member_access: [],
      used_payments: [],
      member_settings: [],
      payment_disputes: [],
    };
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
        this.state = {
          tg_wallets: Array.isArray(raw.tg_wallets) ? raw.tg_wallets : [],
          tg_tokens: Array.isArray(raw.tg_tokens) ? raw.tg_tokens : [],
          member_access: Array.isArray(raw.member_access) ? raw.member_access : [],
          used_payments: Array.isArray(raw.used_payments) ? raw.used_payments : [],
          member_settings: Array.isArray(raw.member_settings) ? raw.member_settings : [],
          payment_disputes: Array.isArray(raw.payment_disputes) ? raw.payment_disputes : [],
        };
      }
    } catch (e) {
      console.warn("[LightweightDb] Notice reading store:", e instanceof Error ? e.message : e);
    }
  }

  save() {
    try {
      const parts = this.filePath.replace(/\\/g, "/").split("/");
      parts.pop();
      const dir = parts.join("/");
      if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2));
    } catch (e) {
      console.error("[LightweightDb] Failed to persist store:", e instanceof Error ? e.message : e);
    }
  }

  async query(sql: string, params: any[] = []): Promise<{ rows: any[] }> {
    const s = sql.trim().toLowerCase();

    // Table DDL / health checks
    if (s.startsWith("create table") || s.startsWith("alter table") || s.startsWith("select 1")) {
      return { rows: [{ "?column?": 1 }] };
    }

    // 1. tg_wallets
    if (s.includes("from tg_wallets") && !s.includes("join tg_tokens") && s.startsWith("select")) {
      const userId = String(params[0] ?? "");
      const rows = this.state.tg_wallets
        .filter((w) => w.user_id === userId)
        .sort((a, b) => a.chain.localeCompare(b.chain));
      return { rows: JSON.parse(JSON.stringify(rows)) };
    }

    if (s.startsWith("insert into tg_wallets")) {
      for (let i = 0; i < params.length; i += 7) {
        const userId = String(params[i] ?? "");
        const addrRh = String(params[i + 1] ?? "");
        const wrapRh = String(params[i + 2] ?? "");
        const addrSol = String(params[i + 3] ?? "");
        const wrapSol = String(params[i + 4] ?? "");
        const addrStx = String(params[i + 5] ?? "");
        const wrapStx = String(params[i + 6] ?? "");

        if (!userId) break;

        const setWallet = (chain: string, address: string, wrapped: string) => {
          const idx = this.state.tg_wallets.findIndex((w) => w.user_id === userId && w.chain === chain);
          if (idx >= 0) {
            this.state.tg_wallets[idx] = { user_id: userId, chain, address, wrapped };
          } else {
            this.state.tg_wallets.push({ user_id: userId, chain, address, wrapped });
          }
        };

        setWallet("robinhood", addrRh, wrapRh);
        setWallet("solana", addrSol, wrapSol);
        setWallet("stacks", addrStx, wrapStx);
      }
      this.save();
      return { rows: [] };
    }

    if (s.startsWith("delete from tg_wallets")) {
      const userId = String(params[0] ?? "");
      this.state.tg_wallets = this.state.tg_wallets.filter((w) => w.user_id !== userId);
      this.save();
      return { rows: [] };
    }

    // 2. tg_tokens
    if (s.includes("from tg_tokens") && s.startsWith("select")) {
      const userId = String(params[0] ?? "");
      if (s.includes("count(*)")) {
        const count = this.state.tg_tokens.filter((t) => t.user_id === userId).length;
        return { rows: [{ n: count }] };
      }
      const rows = this.state.tg_tokens
        .filter((t) => t.user_id === userId)
        .sort((a, b) => a.chain.localeCompare(b.chain));
      return { rows: JSON.parse(JSON.stringify(rows)) };
    }

    if (s.startsWith("insert into tg_tokens")) {
      const [id, userId, chain, token, symbol] = params;
      const existing = this.state.tg_tokens.find((t) => t.id === id);
      if (existing) {
        existing.user_id = String(userId);
        existing.chain = String(chain);
        existing.token = String(token);
        existing.symbol = String(symbol ?? "");
      } else {
        this.state.tg_tokens.push({
          id: String(id),
          user_id: String(userId),
          chain: String(chain),
          token: String(token),
          symbol: String(symbol ?? ""),
        });
      }
      this.save();
      return { rows: [] };
    }

    if (s.startsWith("delete from tg_tokens")) {
      if (params.length === 1) {
        const userId = String(params[0]);
        this.state.tg_tokens = this.state.tg_tokens.filter((t) => t.user_id !== userId);
        this.save();
        return { rows: [] };
      }
      if (params.length >= 2) {
        const tokenId = String(params[0]);
        const userId = String(params[1]);
        const idx = this.state.tg_tokens.findIndex(
          (t) =>
            (t.id === tokenId || t.token.toLowerCase() === tokenId.toLowerCase() || t.symbol.toLowerCase() === tokenId.toLowerCase()) &&
            t.user_id === userId,
        );
        if (idx >= 0) {
          const [deleted] = this.state.tg_tokens.splice(idx, 1);
          this.save();
          return { rows: [deleted] };
        }
        return { rows: [] };
      }
    }

    // 3. member_access
    if (s.includes("from member_access") && s.startsWith("select")) {
      const userId = String(params[0] ?? "");
      const found = this.state.member_access.find((a) => a.user_id === userId);
      return { rows: found ? [JSON.parse(JSON.stringify(found))] : [] };
    }

    if (s.startsWith("insert into member_access")) {
      const [userId, memo] = params;
      const existing = this.state.member_access.find((a) => a.user_id === String(userId));
      if (!existing) {
        this.state.member_access.push({
          user_id: String(userId),
          memo: String(memo),
          paid_until: null,
          last_tx: "",
        });
        this.save();
      }
      return { rows: [] };
    }

    if (s.startsWith("update member_access set paid_until")) {
      const [paidUntil, lastTx, userId] = params;
      const existing = this.state.member_access.find((a) => a.user_id === String(userId));
      if (existing) {
        existing.paid_until = paidUntil ? String(paidUntil) : null;
        existing.last_tx = String(lastTx ?? "");
        this.save();
      }
      return { rows: [] };
    }

    // 4. used_payments
    if (s.includes("from used_payments") && s.startsWith("select")) {
      const txHash = String(params[0] ?? "").toLowerCase();
      const found = this.state.used_payments.find((p) => p.tx_hash.toLowerCase() === txHash);
      return { rows: found ? [JSON.parse(JSON.stringify(found))] : [] };
    }

    if (s.startsWith("insert into used_payments")) {
      const [txHash, userId, payChain, asset, amount] = params;
      const clean = String(txHash).toLowerCase();
      if (!this.state.used_payments.some((p) => p.tx_hash.toLowerCase() === clean)) {
        this.state.used_payments.push({
          tx_hash: clean,
          user_id: String(userId),
          pay_chain: String(payChain),
          asset: String(asset),
          amount: String(amount),
        });
        this.save();
      }
      return { rows: [] };
    }

    // 5. member_settings
    if (s.includes("from member_settings") && s.startsWith("select")) {
      const userId = String(params[0] ?? "");
      const found = this.state.member_settings.find((m) => m.user_id === userId);
      return { rows: found ? [JSON.parse(JSON.stringify(found))] : [] };
    }

    if (s.startsWith("insert into member_settings")) {
      if (s.includes("on conflict do nothing") && params.length === 1) {
        const userId = String(params[0]);
        if (!this.state.member_settings.some((m) => m.user_id === userId)) {
          this.state.member_settings.push({
            user_id: userId,
            paused: false,
            interval: "30m",
            trade_range: "5-20",
            cycle_index: 0,
            next_recheck_ms: 0,
            last_trade_ms: 0,
            last_trade_text: "",
          });
          this.save();
        }
        return { rows: [] };
      }

      if (params.length >= 8) {
        const [userId, paused, interval, tradeRange, cycleIndex, nextRecheckMs, lastTradeMs, lastTradeText] = params;
        const uid = String(userId);
        const idx = this.state.member_settings.findIndex((m) => m.user_id === uid);
        const setting: MemberSetting = {
          user_id: uid,
          paused: Boolean(paused),
          interval: String(interval || "30m"),
          trade_range: String(tradeRange || "5-20"),
          cycle_index: Number(cycleIndex || 0),
          next_recheck_ms: Number(nextRecheckMs || 0),
          last_trade_ms: Number(lastTradeMs || 0),
          last_trade_text: String(lastTradeText || ""),
        };
        if (idx >= 0) {
          this.state.member_settings[idx] = setting;
        } else {
          this.state.member_settings.push(setting);
        }
        this.save();
        return { rows: [] };
      }
    }

    // 6. payment_disputes
    if (s.includes("from payment_disputes") && s.startsWith("select")) {
      if (params.length === 1) {
        const disputeId = String(params[0]);
        const found = this.state.payment_disputes.find((d) => d.id === disputeId);
        return { rows: found ? [JSON.parse(JSON.stringify(found))] : [] };
      }
      const pending = this.state.payment_disputes
        .filter((d) => d.status === "pending")
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .slice(0, 10);
      return { rows: JSON.parse(JSON.stringify(pending)) };
    }

    if (s.startsWith("insert into payment_disputes")) {
      const [id, userId, txHash, chain, userNote, status] = params;
      this.state.payment_disputes.push({
        id: String(id),
        user_id: String(userId),
        tx_hash: String(txHash),
        chain: String(chain),
        user_note: String(userNote ?? ""),
        status: String(status || "pending"),
        admin_note: "",
        created_at: new Date().toISOString(),
        resolved_at: null,
      });
      this.save();
      return { rows: [] };
    }

    if (s.startsWith("update payment_disputes set status")) {
      const [adminNote, disputeId] = params;
      const status = s.includes("'accepted'") ? "accepted" : "rejected";
      const found = this.state.payment_disputes.find((d) => d.id === String(disputeId));
      if (found) {
        found.status = status;
        found.admin_note = String(adminNote ?? "");
        found.resolved_at = new Date().toISOString();
        this.save();
      }
      return { rows: [] };
    }

    // 7. Member swap query (join wallets, tokens, access)
    if (s.includes("from tg_wallets w") && s.includes("join tg_tokens t")) {
      const adminId = String(params[0] ?? "");
      const now = Date.now();
      const rows: any[] = [];

      for (const w of this.state.tg_wallets) {
        const matchingTokens = this.state.tg_tokens.filter((t) => t.user_id === w.user_id && t.chain === w.chain);
        const access = this.state.member_access.find((a) => a.user_id === w.user_id);
        const isPaid = access?.paid_until && new Date(access.paid_until).getTime() > now;
        const isAdmin = adminId && w.user_id === adminId;

        if (isPaid || isAdmin) {
          for (const t of matchingTokens) {
            rows.push({
              user_id: w.user_id,
              chain: w.chain,
              address: w.address,
              wrapped: w.wrapped,
              token: t.token,
              symbol: t.symbol,
            });
          }
        }
      }
      return { rows };
    }

    return { rows: [] };
  }
}
