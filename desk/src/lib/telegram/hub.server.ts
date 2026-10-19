import fs from "node:fs";
import { adminGate } from "@/lib/engine/commands";
import { clearVault, rememberAccount, vaultPublic } from "@/lib/security/vault.server";
import { readAccount, RhError } from "@/lib/robinhood/client.server";

const TOKEN_PATH = "/workspace/.secrets/telegram_bot_token";
const ADMIN_PATH = "/workspace/.secrets/telegram_admin_id";
const OFFSET_PATH = "/workspace/.secrets/telegram_offset";

export interface InboundCommand {
  updateId: number;
  fromId: string;
  chatId: number;
  text: string;
}

export interface OutboundReply {
  chatId?: number;
  updateId: number;
  text: string;
  keyboard?: "interval";
}

export interface DeskSnapshot {
  adminId: string;
  pair: string;
  status: string;
  balance: string;
  interval: string;
  dryRun: boolean;
  tradingEnabled: boolean;
  active: boolean;
  halted: boolean;
  pending: string | null;
  historyText: string;
  equityText: string;
  quoteText: string;
  statusText: string;
}

interface Hub {
  offset: number;
  queue: InboundCommand[];
  botUsername: string | null;
  botError: string | null;
  started: boolean;
  snapshot: DeskSnapshot | null;
  liveArmed: boolean;
  authFails: number;
  apiFails: number;
  lastChats: Map<string, number>;
  lastDeskSync: number;
}

const hub: Hub = {
  offset: readOffset(),
  queue: [],
  botUsername: null,
  botError: null,
  started: false,
  snapshot: null,
  liveArmed: false,
  authFails: 0,
  apiFails: 0,
  lastChats: new Map(),
  lastDeskSync: 0,
};

function readToken(): string | null {
  try {
    const value = fs.readFileSync(TOKEN_PATH, "utf8").trim();
    return value || null;
  } catch {
    return null;
  }
}

function readBoundAdmin(): string {
  try {
    return fs.readFileSync(ADMIN_PATH, "utf8").replace(/\D/g, "").slice(0, 15);
  } catch {
    return "";
  }
}

function writeBoundAdmin(id: string) {
  fs.mkdirSync("/workspace/.secrets", { recursive: true });
  fs.writeFileSync(ADMIN_PATH, `${id}\n`, { mode: 0o600 });
}

function readOffset(): number {
  try {
    const value = Number(fs.readFileSync(OFFSET_PATH, "utf8").trim());
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

function writeOffset(offset: number) {
  fs.mkdirSync("/workspace/.secrets", { recursive: true });
  fs.writeFileSync(OFFSET_PATH, `${offset}\n`, { mode: 0o600 });
}

async function tg(method: string, body?: Record<string, unknown>): Promise<unknown> {
  const token = readToken();
  if (!token) throw new Error("Telegram token is not configured.");
  let response: Response;
  try {
    response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
  } catch {
    throw new Error("Telegram network request failed.");
  }
  const payload = (await response.json().catch(() => null)) as { ok?: boolean; description?: string; result?: unknown } | null;
  if (!response.ok || !payload?.ok) {
    const description = payload?.description ?? `HTTP ${response.status}`;
    if (response.status === 401) throw new Error("Telegram rejected the token.");
    throw new Error(description);
  }
  return payload.result;
}

function parseUpdate(update: Record<string, unknown>): InboundCommand | null {
  const updateId = typeof update.update_id === "number" ? update.update_id : null;
  if (updateId == null) return null;
  const callback = update.callback_query as Record<string, unknown> | undefined;
  const message = (callback?.message ?? update.message) as Record<string, unknown> | undefined;
  const from = (callback?.from ?? message?.from) as Record<string, unknown> | undefined;
  const fromId = from?.id != null ? String(from.id) : "";
  const chat = message?.chat as Record<string, unknown> | undefined;
  const chatId = typeof chat?.id === "number" ? chat.id : null;
  if (chatId != null && fromId) hub.lastChats.set(fromId, chatId);
  let text = "";
  if (typeof callback?.data === "string") {
    text = callback.data.startsWith("interval:") ? `/interval ${callback.data.slice("interval:".length)}` : callback.data;
    const id = callback.id;
    if (typeof id === "string") void tg("answerCallbackQuery", { callback_query_id: id }).catch(() => undefined);
  } else if (typeof message?.text === "string") {
    text = message.text;
  }
  if (!text || chatId == null || !fromId) return null;
  return { updateId, fromId, chatId, text: text.slice(0, 500) };
}

async function sendText(chatId: number, text: string) {
  await tg("sendMessage", { chat_id: chatId, text: text.slice(0, 3500) });
}

function deskIsLive(): boolean {
  return hub.lastDeskSync > 0 && Date.now() - hub.lastDeskSync < 15000;
}

async function handleInbound(cmd: InboundCommand) {
  const gate = adminGate(readBoundAdmin(), cmd.fromId, cmd.text);
  if (gate === "lock") {
    writeBoundAdmin(cmd.fromId);
    await sendText(
      cmd.chatId,
      [
        "Admin locked.",
        "",
        `Telegram user id ${cmd.fromId} is the only account that can command this bot.`,
        "Sending that id from this chat was the confirmation. Usernames are ignored.",
        "",
        "Nothing is trading. Dry-run stays on until you resume from Stillmark.",
        "Commands: /status /balance /quote /config /interval /help /pause /resume /emergency_stop",
      ].join("\n"),
    );
    return;
  }
  if (gate === "mismatch") {
    await sendText(
      cmd.chatId,
      `That number is not this account's id (${cmd.fromId}). Send your own id to lock admin. Nothing was changed.`,
    );
    return;
  }
  if (gate === "prompt") {
    await sendText(
      cmd.chatId,
      [
        "Not locked yet.",
        "",
        `Your Telegram user id is ${cmd.fromId}.`,
        "Send that exact number as the only confirmation. It has to come from this account.",
      ].join("\n"),
    );
    return;
  }
  if (gate === "reject") {
    await sendText(cmd.chatId, "Unauthorized. This bot only answers the Telegram account that locked it.");
    return;
  }
  const head = cmd.text.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  if (head === "/start" || head === "/help") {
    await sendText(
      cmd.chatId,
      [
        "Stillmark is locked to this account.",
        "A quiet window only opens a cost check. It does not force a trade.",
        "Commands: /status /balance /quote /config /interval /history /test /simulate /pause /resume /emergency_stop",
        "No withdrawals. No seed phrase. No password.",
      ].join("\n"),
    );
    return;
  }
  if (!deskIsLive()) {
    await sendText(
      cmd.chatId,
      "You're the admin. That command runs on the Stillmark desk, and the desk is not connected right now. Open it, then send the command again.",
    );
    return;
  }
  if (hub.queue.some((row) => row.updateId === cmd.updateId)) return;
  hub.queue.push(cmd);
  if (hub.queue.length > 40) hub.queue.splice(0, hub.queue.length - 40);
}

async function pollOnce() {
  const updates = (await tg("getUpdates", {
    offset: hub.offset,
    timeout: 0,
    allowed_updates: ["message", "callback_query"],
  })) as unknown;
  if (!Array.isArray(updates) || updates.length === 0) return;
  const batch: InboundCommand[] = [];
  let nextOffset = hub.offset;
  for (const update of updates) {
    if (!update || typeof update !== "object") continue;
    const record = update as Record<string, unknown>;
    if (typeof record.update_id === "number") nextOffset = Math.max(nextOffset, record.update_id + 1);
    const cmd = parseUpdate(record);
    if (cmd) batch.push(cmd);
  }
  for (let i = 0; i < batch.length; i += 1) {
    const cmd = batch[i];
    if (!cmd) continue;
    const next = batch[i + 1];
    const bareStart = cmd.text.trim() === "/start" || cmd.text.trim().startsWith("/start@");
    if (
      bareStart &&
      !readBoundAdmin() &&
      next &&
      next.fromId === cmd.fromId &&
      next.text.trim() === cmd.fromId
    ) {
      continue;
    }
    await handleInbound(cmd);
  }
  hub.offset = nextOffset;
  writeOffset(nextOffset);
}

async function loop() {
  try {
    const me = (await tg("getMe")) as { username?: string };
    hub.botUsername = me.username ?? null;
    hub.botError = null;
  } catch (error) {
    hub.botError = error instanceof Error ? error.message : "Telegram is unavailable.";
  }
  for (;;) {
    try {
      if (readToken()) {
        await pollOnce();
        hub.botError = null;
      } else {
        hub.botError = "Telegram token is not configured on the server.";
      }
    } catch (error) {
      hub.botError = error instanceof Error ? error.message : "Telegram poll failed.";
      await sleep(4000);
    }
    await sleep(1200);
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function startTelegramLoop() {
  /* Polling lives in the standalone bot process, not the web preview. */
}

export function boundAdminId(): string {
  return readBoundAdmin();
}

const intervalKeyboard = {
  inline_keyboard: [
    [{ text: "10 minutes", callback_data: "interval:10m" }],
    [{ text: "20 minutes", callback_data: "interval:20m" }],
    [{ text: "30 minutes", callback_data: "interval:30m" }],
    [{ text: "1 hour", callback_data: "interval:1h" }],
  ],
};

export async function hubSync(input: { snapshot: DeskSnapshot; replies: OutboundReply[]; ack: number[] }) {
  hub.snapshot = input.snapshot;
  if (input.snapshot.halted) hub.liveArmed = false;
  if (input.ack.length) {
    const ack = new Set(input.ack);
    hub.queue = hub.queue.filter((row) => !ack.has(row.updateId));
  }
  for (const reply of input.replies) {
    const chatId = reply.chatId ?? hub.lastChats.get(hub.snapshot?.adminId ?? "");
    if (chatId == null) continue;
    const body: Record<string, unknown> = { chat_id: chatId, text: reply.text.slice(0, 3500) };
    if (reply.keyboard === "interval") body.reply_markup = intervalKeyboard;
    try {
      await tg("sendMessage", body);
    } catch (error) {
      hub.botError = error instanceof Error ? error.message : "Telegram send failed.";
    }
  }
  return {
    commands: hub.queue.slice(0, 8).map(({ updateId, fromId, chatId, text }) => ({ updateId, fromId, chatId, text })),
    bot: { username: hub.botUsername, error: hub.botError, configured: readToken() != null },
    boundAdminId: readBoundAdmin(),
    vault: vaultPublic(),
    liveArmed: hub.liveArmed,
  };
}

export async function saveCredentials(apiKey: string, privateKey: string) {
  const creds = { apiKey: apiKey.trim(), privateKey: privateKey.trim() };
  try {
    const account = await readAccount(creds);
    rememberAccount({ ...creds, accountStatus: account.status, buyingPower: account.buyingPower });
    hub.authFails = 0;
    return { ok: true as const, vault: vaultPublic(), liveArmed: false };
  } catch (error) {
    if (error instanceof RhError && error.auth) hub.authFails += 1;
    else hub.apiFails += 1;
    if (hub.authFails >= 3) hub.liveArmed = false;
    return {
      ok: false as const,
      error: error instanceof Error ? error.message : "Credential check failed.",
      vault: vaultPublic(),
    };
  }
}

export function eraseCredentials() {
  clearVault();
  hub.liveArmed = false;
  hub.authFails = 0;
  return { ok: true as const, vault: vaultPublic(), liveArmed: false };
}

export function publicStatus() {
  return {
    bot: { username: hub.botUsername, error: hub.botError, configured: readToken() != null },
    vault: vaultPublic(),
    liveArmed: hub.liveArmed,
    armedNote:
      "Live order submission stays off. Credentials, when present, are held only in server memory and are used for an account read. This preview does not place Robinhood orders.",
  };
}
