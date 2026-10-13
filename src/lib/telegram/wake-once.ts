import fs from "node:fs";
import { runDueTrade } from "./duty.ts";

const ROOT = process.env.STILLMARK_ROOT || "/workspace";

async function drainCommands() {
  let token = "";
  let admin = "";
  try {
    token = fs.readFileSync(`${ROOT}/.secrets/telegram_bot_token`, "utf8").trim();
    admin = fs.readFileSync(`${ROOT}/.secrets/telegram_admin_id`, "utf8").trim();
  } catch {
    return;
  }
  const offsetPath = `${ROOT}/data/telegram_offset`;
  let offset = 0;
  try {
    offset = Number(fs.readFileSync(offsetPath, "utf8")) || 0;
  } catch {
    offset = 0;
  }
  const response = await fetch(`https://api.telegram.org/bot${token}/getUpdates`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ offset, timeout: 0, allowed_updates: ["message"] }),
  });
  const payload = (await response.json().catch(() => null)) as { result?: Array<Record<string, unknown>> } | null;
  const updates = payload?.result ?? [];
  const statePath = `${ROOT}/data/stillmark-bot.json`;
  for (const update of updates) {
    const id = typeof update.update_id === "number" ? update.update_id : 0;
    if (id) offset = Math.max(offset, id + 1);
    const message = update.message as Record<string, unknown> | undefined;
    const from = message?.from as Record<string, unknown> | undefined;
    const text = typeof message?.text === "string" ? message.text.trim() : "";
    const chat = message?.chat as Record<string, unknown> | undefined;
    const chatId = typeof chat?.id === "number" ? chat.id : 0;
    if (!text.startsWith("/") || String(from?.id ?? "") !== admin || !chatId) continue;
    const state = JSON.parse(fs.readFileSync(statePath, "utf8")) as {
      active?: boolean;
      paused?: boolean;
      halted?: boolean;
      nextRecheck?: number;
    };
    const cmd = text.split(/\s+/)[0]?.split("@")[0] ?? "";
    let reply = "";
    if (cmd === "/pause") {
      state.active = false;
      state.paused = true;
      reply = "Paused. No new swap will start.";
    } else if (cmd === "/resume") {
      state.paused = false;
      state.halted = false;
      state.active = true;
      state.nextRecheck = Date.now();
      reply = "Running again. It does not need this chat.";
    } else if (cmd === "/emergency_stop" || cmd === "/stop") {
      state.active = false;
      state.halted = true;
      state.paused = false;
      reply = "Stopped. Send /resume to turn swaps back on.";
    } else if (cmd === "/status") {
      reply = state.halted || state.paused ? "Stopped." : "Running on its own.";
    }
    if (!reply) continue;
    fs.writeFileSync(statePath, JSON.stringify(state));
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: reply }),
    }).catch(() => undefined);
  }
  fs.mkdirSync(`${ROOT}/data`, { recursive: true });
  fs.writeFileSync(offsetPath, String(offset));
}

await (process.env.STILLMARK_SKIP_DRAIN === "1" ? Promise.resolve() : drainCommands().catch(() => undefined));
const line = await runDueTrade(true);
const text = line || "watching";
try {
  fs.appendFileSync(`${ROOT}/data/bot.log`, `${new Date().toISOString()} wake ${text}\n`);
} catch {
  /* keep the printed result */
}
process.stdout.write(`${text}\n`);
