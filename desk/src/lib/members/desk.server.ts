import { randomBytes, randomUUID } from "node:crypto";
import { getSql } from "@/lib/db";
import { deriveUniversalWallet, deriveWallet, normalToken, tokenLooksRight, type DeskChain } from "./keys";
import { lookupPayment, type PayChain } from "./pay";
import { MAX_TOKENS, exactUsd, type DisputeRow, type OperatorRow, type PublicAccess, type PublicSlot } from "./public";
import { sealSecret } from "./seal";

const intervals = ["10m", "20m", "30m", "1h"] as const;
const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

type AccessRow = { memo: string; paid_until: string | null };
type SlotRow = { id: string; chain: string; address: string; token: string; symbol: string; interval: string; trade_range?: string };
type DisputeDbRow = {
  id: string;
  user_id: string;
  tx_hash: string;
  chain: string;
  user_note: string;
  status: string;
  admin_note: string;
  created_at: string;
  resolved_at: string | null;
};

export type SlotInput = {
  chain: DeskChain;
  privateKey: string;
  token: string;
  symbol: string;
  interval: PublicSlot["interval"];
  tradeRange?: PublicSlot["tradeRange"];
  freshAck: true;
};

function covered(paidUntil: string | null): boolean {
  if (!paidUntil) return false;
  return new Date(paidUntil).getTime() > Date.now();
}

export function isOperator(userId: string): boolean {
  const operatorId = process.env.OPERATOR_USER_ID || process.env.TELEGRAM_ADMIN_ID || process.env.ADMIN_USER_ID;
  if (operatorId) return userId === operatorId;
  return !process.env.DATABASE_URL;
}

function toDisputeRow(row: DisputeDbRow): DisputeRow {
  return {
    id: row.id,
    userId: row.user_id,
    txHash: row.tx_hash,
    chain: row.chain,
    userNote: row.user_note,
    status: row.status === "accepted" || row.status === "rejected" ? row.status : "pending",
    adminNote: row.admin_note,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

function newMemo(): string {
  const bytes = randomBytes(6);
  let memo = "";
  for (const byte of bytes) memo += alphabet[byte % alphabet.length];
  return memo;
}

function toSlot(row: SlotRow): PublicSlot {
  const chain = row.chain === "stacks" || row.chain === "robinhood" ? row.chain : "solana";
  const interval = intervals.includes(row.interval as PublicSlot["interval"]) ? (row.interval as PublicSlot["interval"]) : "30m";
  const tradeRange: PublicSlot["tradeRange"] =
    row.trade_range === "21-50" || row.trade_range === "51-100" || row.trade_range === "100+"
      ? row.trade_range
      : "5-20";
  return { id: row.id, chain, address: row.address, token: row.token, symbol: row.symbol, interval, tradeRange };
}

async function ensureAccess(userId: string): Promise<AccessRow> {
  const sql = await getSql();
  const existing = await sql<AccessRow>`select memo, paid_until::text as paid_until from member_access where user_id = ${userId}`;
  if (existing[0]) return existing[0];
  const memo = newMemo();
  await sql`insert into member_access (user_id, memo) values (${userId}, ${memo})`;
  return { memo, paid_until: null };
}

async function slotsFor(userId: string): Promise<PublicSlot[]> {
  const sql = await getSql();
  const rows = await sql<SlotRow>`
    select id, chain, address, token, symbol, interval, coalesce(trade_range, '5-20') as trade_range
    from member_slots
    where user_id = ${userId}
    order by created_at asc
  `;
  return rows.map(toSlot);
}

export async function loadAccess(userId: string): Promise<PublicAccess> {
  const access = await ensureAccess(userId);
  return {
    memo: access.memo,
    exactUsd: exactUsd(access.memo),
    paidUntil: access.paid_until,
    covered: covered(access.paid_until),
    slots: await slotsFor(userId),
  };
}

export async function addSlot(userId: string, data: SlotInput): Promise<{ ok: true; access: PublicAccess } | { ok: false; error: string }> {
  const access = await loadAccess(userId);
  if (!access.covered) return { ok: false, error: "The $20 month is not paid yet. Pay in USDT, USDC, or USDG, then check the transaction." };
  if (access.slots.length >= MAX_TOKENS) return { ok: false, error: "Three tokens are already active. Remove one before adding another." };
  if (!tokenLooksRight(data.chain, data.token)) {
    return { ok: false, error: "That token address does not match the chain." };
  }
  let address = "";
  let privateKeyToSeal = data.privateKey.trim();
  try {
    if (privateKeyToSeal.split(/\s+/).length >= 12) {
      const universal = deriveUniversalWallet(privateKeyToSeal);
      address = universal.wallets[data.chain].address;
      privateKeyToSeal = universal.wallets[data.chain].privateKey;
    } else {
      address = deriveWallet(data.chain, data.privateKey).address;
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "That key could not be read." };
  }
  const token = normalToken(data.chain, data.token);
  if (access.slots.some((slot) => slot.chain === data.chain && slot.token === token)) {
    return { ok: false, error: "That token is already active." };
  }
  let wrapped = "";
  try {
    wrapped = sealSecret(privateKeyToSeal);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "The vault is not ready." };
  }
  const id = randomUUID();
  const tradeRange: PublicSlot["tradeRange"] =
    data.tradeRange === "21-50" || data.tradeRange === "51-100" || data.tradeRange === "100+"
      ? data.tradeRange
      : "5-20";
  const sql = await getSql();
  await sql`
    insert into member_slots (id, user_id, chain, address, token, symbol, interval, trade_range)
    values (${id}, ${userId}, ${data.chain}, ${address}, ${token}, ${data.symbol.trim()}, ${data.interval}, ${tradeRange})
  `;
  await sql`insert into member_slot_vault (slot_id, wrapped) values (${id}, ${wrapped})`;
  return { ok: true, access: await loadAccess(userId) };
}

export async function removeSlot(userId: string, slotId: string): Promise<PublicAccess> {
  const sql = await getSql();
  await sql`delete from member_slots where id = ${slotId} and user_id = ${userId}`;
  return loadAccess(userId);
}

export async function confirmPayment(userId: string, chain: PayChain, txHash: string): Promise<{ ok: true; access: PublicAccess } | { ok: false; error: string }> {
  const access = await ensureAccess(userId);
  let verdict: { ok: true; asset: string; amount: string } | { ok: false; error: string };
  try {
    verdict = await lookupPayment(chain, txHash.trim());
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "The chain check failed." };
  }
  if (!verdict.ok) return verdict;
  const sql = await getSql();
  const inserted = await sql<{ tx_hash: string }>`
    insert into used_payments (tx_hash, user_id, pay_chain, asset, amount)
    values (${txHash.trim().toLowerCase()}, ${userId}, ${chain}, ${verdict.asset}, ${verdict.amount})
    on conflict (tx_hash) do nothing
    returning tx_hash
  `;
  if (!inserted[0]) return { ok: false, error: "That payment was already used." };
  const current = covered(access.paid_until) && access.paid_until ? new Date(access.paid_until).getTime() : Date.now();
  const paidUntil = new Date(Math.max(Date.now(), current) + 30 * 24 * 60 * 60 * 1000).toISOString();
  await sql`
    update member_access
    set paid_until = ${paidUntil}, last_tx = ${txHash.trim()}
    where user_id = ${userId}
  `;
  return { ok: true, access: await loadAccess(userId) };
}

export async function createDispute(
  userId: string,
  data: { txHash: string; chain: PayChain; userNote?: string },
): Promise<{ ok: true; dispute: DisputeRow } | { ok: false; error: string }> {
  const cleanHash = data.txHash.trim();
  const sql = await getSql();

  const used = await sql<{ tx_hash: string }>`select tx_hash from used_payments where tx_hash = ${cleanHash.toLowerCase()}`;
  if (used.length > 0) {
    return { ok: false, error: "That transaction hash has already been credited." };
  }

  const existing = await sql<DisputeDbRow>`
    select id, user_id, tx_hash, chain, user_note, status, admin_note, created_at::text as created_at, resolved_at::text as resolved_at
    from payment_disputes
    where lower(tx_hash) = ${cleanHash.toLowerCase()} and status = 'pending'
  `;
  if (existing.length > 0) {
    return { ok: false, error: "A dispute for this transaction is already pending admin review." };
  }

  const id = `disp_${randomUUID().slice(0, 8)}`;
  const userNote = (data.userNote ?? "").trim().slice(0, 500);

  await sql`
    insert into payment_disputes (id, user_id, tx_hash, chain, user_note, status)
    values (${id}, ${userId}, ${cleanHash}, ${data.chain}, ${userNote}, 'pending')
  `;

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const admin = process.env.TELEGRAM_ADMIN_ID;
  if (token && admin) {
    const explorer = data.chain === "solana"
      ? `https://solscan.io/tx/${cleanHash}`
      : data.chain === "base"
      ? `https://basescan.org/tx/${cleanHash}`
      : data.chain === "bsc"
      ? `https://bscscan.com/tx/${cleanHash}`
      : `https://robinhoodchain.blockscout.com/tx/${cleanHash}`;

    const text = [
      `⚠️ *NEW PAYMENT DISPUTE #${id}*`,
      `User: \`${userId}\``,
      `Chain: ${data.chain.toUpperCase()}`,
      `Tx: \`${cleanHash}\``,
      `Explorer: ${explorer}`,
      userNote ? `Note: ${userNote}` : "",
      "Tap below to accept or reject:",
    ].filter(Boolean).join("\n");

    fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: admin,
        text,
        reply_markup: {
          inline_keyboard: [
            [
              { text: "✅ Accept & Credit 30d", callback_data: `dispute:accept:${id}` },
              { text: "❌ Reject", callback_data: `dispute:reject:${id}` },
            ],
          ],
        },
      }),
    }).catch(() => {});
  }

  const created = await sql<DisputeDbRow>`
    select id, user_id, tx_hash, chain, user_note, status, admin_note, created_at::text as created_at, resolved_at::text as resolved_at
    from payment_disputes where id = ${id}
  `;

  return { ok: true, dispute: toDisputeRow(created[0]) };
}

export async function loadUserDisputes(userId: string): Promise<DisputeRow[]> {
  const sql = await getSql();
  const rows = await sql<DisputeDbRow>`
    select id, user_id, tx_hash, chain, user_note, status, admin_note, created_at::text as created_at, resolved_at::text as resolved_at
    from payment_disputes
    where user_id = ${userId}
    order by created_at desc
    limit 20
  `;
  return rows.map(toDisputeRow);
}

export async function loadAdminDisputes(userId: string): Promise<{ authorized: boolean; disputes: DisputeRow[] }> {
  if (!isOperator(userId)) return { authorized: false, disputes: [] };
  const sql = await getSql();
  const rows = await sql<DisputeDbRow>`
    select id, user_id, tx_hash, chain, user_note, status, admin_note, created_at::text as created_at, resolved_at::text as resolved_at
    from payment_disputes
    order by case when status = 'pending' then 0 else 1 end, created_at desc
    limit 100
  `;
  return { authorized: true, disputes: rows.map(toDisputeRow) };
}

export async function resolveDispute(
  adminUserId: string,
  disputeId: string,
  action: "accept" | "reject",
  adminNote?: string,
): Promise<{ ok: true; dispute: DisputeRow } | { ok: false; error: string }> {
  if (!isOperator(adminUserId)) return { ok: false, error: "Unauthorized" };
  const sql = await getSql();
  const rows = await sql<DisputeDbRow>`
    select id, user_id, tx_hash, chain, user_note, status, admin_note, created_at::text as created_at, resolved_at::text as resolved_at
    from payment_disputes
    where id = ${disputeId}
  `;
  const dispute = rows[0];
  if (!dispute) return { ok: false, error: "Dispute not found" };

  const note = (adminNote ?? "").trim() || (action === "accept" ? "Approved by admin" : "Rejected by admin");

  if (action === "accept") {
    const access = await ensureAccess(dispute.user_id);
    const current = covered(access.paid_until) && access.paid_until ? new Date(access.paid_until).getTime() : Date.now();
    const paidUntil = new Date(Math.max(Date.now(), current) + 30 * 24 * 60 * 60 * 1000).toISOString();

    await sql`
      insert into used_payments (tx_hash, user_id, pay_chain, asset, amount)
      values (${dispute.tx_hash.toLowerCase()}, ${dispute.user_id}, ${dispute.chain}, 'USD_CLAIM', '20.00')
      on conflict (tx_hash) do nothing
    `;
    await sql`
      update member_access
      set paid_until = ${paidUntil}, last_tx = ${dispute.tx_hash}
      where user_id = ${dispute.user_id}
    `;
    await sql`
      update payment_disputes
      set status = 'accepted', admin_note = ${note}, resolved_at = now()
      where id = ${disputeId}
    `;

    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (token && /^\d+$/.test(dispute.user_id)) {
      fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: Number(dispute.user_id),
          text: `🎉 Your payment dispute for transaction ${dispute.tx_hash} has been ACCEPTED by the admin!\nAccess extended by 30 days (Active until ${new Date(paidUntil).toUTCString()}).`,
        }),
      }).catch(() => {});
    }
  } else {
    await sql`
      update payment_disputes
      set status = 'rejected', admin_note = ${note}, resolved_at = now()
      where id = ${disputeId}
    `;

    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (token && /^\d+$/.test(dispute.user_id)) {
      fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: Number(dispute.user_id),
          text: `❌ Your payment dispute for transaction ${dispute.tx_hash} was REJECTED by the admin.\nReason: ${note}`,
        }),
      }).catch(() => {});
    }
  }

  const updated = await sql<DisputeDbRow>`
    select id, user_id, tx_hash, chain, user_note, status, admin_note, created_at::text as created_at, resolved_at::text as resolved_at
    from payment_disputes where id = ${disputeId}
  `;
  return { ok: true, dispute: toDisputeRow(updated[0]) };
}

export async function loadOperatorBoard(userId: string): Promise<{ operator: boolean; rows: OperatorRow[]; disputes: DisputeRow[] }> {
  if (!isOperator(userId)) return { operator: false, rows: [], disputes: [] };
  const sql = await getSql();
  const rows = await sql<{ chain: string; address: string; token: string; symbol: string; paid_until: string | null }>`
    select s.chain, s.address, s.token, s.symbol, a.paid_until::text as paid_until
    from member_slots s
    left join member_access a on a.user_id = s.user_id
    order by s.created_at desc
  `;
  const disputeRows = await sql<DisputeDbRow>`
    select id, user_id, tx_hash, chain, user_note, status, admin_note, created_at::text as created_at, resolved_at::text as resolved_at
    from payment_disputes
    order by case when status = 'pending' then 0 else 1 end, created_at desc
    limit 100
  `;
  return {
    operator: true,
    rows: rows.map((row) => ({
      chain: row.chain,
      address: row.address,
      token: row.token,
      symbol: row.symbol,
      covered: covered(row.paid_until),
    })),
    disputes: disputeRows.map(toDisputeRow),
  };
}
