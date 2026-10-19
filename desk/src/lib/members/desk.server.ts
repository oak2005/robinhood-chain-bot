import { randomBytes, randomUUID } from "node:crypto";
import { getSql } from "@/lib/db";
import { deriveWallet, normalToken, tokenLooksRight, type DeskChain } from "./keys";
import { lookupPayment, type PayChain } from "./pay";
import { MAX_TOKENS, exactUsd, type OperatorRow, type PublicAccess, type PublicSlot } from "./public";
import { sealSecret } from "./seal";

const intervals = ["10m", "20m", "30m", "1h"] as const;
const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

type AccessRow = { memo: string; paid_until: string | null };
type SlotRow = { id: string; chain: string; address: string; token: string; symbol: string; interval: string };

export type SlotInput = {
  chain: DeskChain;
  privateKey: string;
  token: string;
  symbol: string;
  interval: PublicSlot["interval"];
  freshAck: true;
};

function covered(paidUntil: string | null): boolean {
  if (!paidUntil) return false;
  return new Date(paidUntil).getTime() > Date.now();
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
  return { id: row.id, chain, address: row.address, token: row.token, symbol: row.symbol, interval };
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
    select id, chain, address, token, symbol, interval
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
  if (!access.covered) return { ok: false, error: "The $20 month is not paid yet. Pay in USDT or USDC, then check the transaction." };
  if (access.slots.length >= MAX_TOKENS) return { ok: false, error: "Three tokens are already active. Remove one before adding another." };
  if (!tokenLooksRight(data.chain, data.token)) {
    return { ok: false, error: "That token address does not match the chain." };
  }
  let address = "";
  try {
    address = deriveWallet(data.chain, data.privateKey).address;
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "That key could not be read." };
  }
  const token = normalToken(data.chain, data.token);
  if (access.slots.some((slot) => slot.chain === data.chain && slot.token === token)) {
    return { ok: false, error: "That token is already active." };
  }
  let wrapped = "";
  try {
    wrapped = sealSecret(data.privateKey.trim());
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "The vault is not ready." };
  }
  const id = randomUUID();
  const sql = await getSql();
  await sql`
    insert into member_slots (id, user_id, chain, address, token, symbol, interval)
    values (${id}, ${userId}, ${data.chain}, ${address}, ${token}, ${data.symbol.trim()}, ${data.interval})
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
    verdict = await lookupPayment(chain, txHash.trim(), access.memo);
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

export async function loadOperatorBoard(userId: string): Promise<{ operator: boolean; rows: OperatorRow[] }> {
  const operatorId = process.env.OPERATOR_USER_ID ?? "";
  if (!operatorId || userId !== operatorId) return { operator: false, rows: [] };
  const sql = await getSql();
  const rows = await sql<{ chain: string; address: string; token: string; symbol: string; paid_until: string | null }>`
    select s.chain, s.address, s.token, s.symbol, a.paid_until::text as paid_until
    from member_slots s
    left join member_access a on a.user_id = s.user_id
    order by s.created_at desc
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
  };
}
