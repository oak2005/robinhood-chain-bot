import fs from "node:fs";

const GATE = "/tmp/trade-gate.json";
const SITE = "https://robinhood-chain-bot-production.up.railway.app";
const STATE_URL = "https://raw.githubusercontent.com/oak2005/robinhood-chain-bot/main/data/stillmark-bot.json";
const BUTTONS = {
  Status: "/status",
  Balance: "/balance",
  Config: "/config",
  Token: "/tokeninfo",
  Help: "/help",
  Resume: "/resume",
  Pause: "/pause",
  Stop: "/emergency_stop",
  Interval: "/interval",
  "Add token": "/addtoken",
  "Add key": "/addkey",
  "Remove key": "/removekey",
};
const INTERVALS = ["10m", "20m", "30m", "1h"];

function readGate() {
  try {
    return JSON.parse(fs.readFileSync(GATE, "utf8"));
  } catch {
    return { telegram: false, paused: false, interval: "" };
  }
}

function writeGate(patch) {
  const next = { ...readGate(), ...patch, telegram: true };
  fs.writeFileSync(GATE, JSON.stringify(next));
}

const token = (process.env.TELEGRAM_BOT_TOKEN ?? "").trim();
const admin = (process.env.TELEGRAM_ADMIN_ID ?? "").trim();
if (!token.includes(":")) {
  fs.writeFileSync(GATE, JSON.stringify({ telegram: false, paused: false, interval: "" }));
  process.exit(0);
}

writeGate({ paused: readGate().paused === true, interval: readGate().interval || "" });

function guestReply(cmd) {
  if (cmd === "/pause" || cmd === "/resume" || cmd === "/stop" || cmd === "/emergency_stop" || cmd === "/interval") {
    return "This account cannot pause or stop the running swaps.";
  }
  if (cmd === "/addkey" || cmd === "/addtoken" || cmd === "/removekey") {
    return `Do not send a private key here. Open ${SITE} and add a fresh wallet there. Your account is separate.`;
  }
  if (cmd === "/balance" || cmd === "/status" || cmd === "/tokeninfo" || cmd === "/config") {
    return `This Telegram account has no wallet yet. Add a fresh wallet on ${SITE}. Do not paste the key in this chat.`;
  }
  return [
    "Inactivity Trade is on.",
    "Your account is separate from the wallet that is already trading.",
    "Help, Balance, Token, and Add token all answer here.",
    `Add the wallet on ${SITE}`,
    "Never send a private key in Telegram.",
  ].join("\n");
}

async function ownerStatus() {
  const gate = readGate();
  if (gate.paused) return "Paused. No new swap will start.";
  try {
    const response = await fetch(STATE_URL, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) return "Running on its own. The swap clock could not be read.";
    const state = await response.json();
    const mins = Math.max(0, Math.ceil(((state.nextRecheck ?? 0) - Date.now()) / 60000));
    const when = mins <= 0 ? "Next swap is due." : `Next swap in about ${mins} min.`;
    const symbol = state.token?.symbol ?? "NASTY";
    const address = state.token?.address ?? "";
    return ["Running on its own.", when, symbol, address].filter(Boolean).join("\n");
  } catch {
    return "Running on its own. The swap clock could not be read.";
  }
}

async function ownerReply(cmd, arg) {
  if (cmd === "/pause" || cmd === "/emergency_stop" || cmd === "/stop") {
    writeGate({ paused: true });
    return "Paused. No new swap will start.";
  }
  if (cmd === "/resume") {
    writeGate({ paused: false });
    return "Running again. The next check can swap.";
  }
  if (cmd === "/interval") {
    if (!INTERVALS.includes(arg)) return "Send /interval 10m, 20m, 30m, or 1h.";
    writeGate({ interval: arg });
    return `Interval set to ${arg}.`;
  }
  if (cmd === "/addkey" || cmd === "/addtoken" || cmd === "/removekey") {
    return `Do not send a private key in this chat. Add a fresh wallet on ${SITE}.`;
  }
  if (cmd === "/status" || cmd === "/balance" || cmd === "/tokeninfo" || cmd === "/config") return ownerStatus();
  return `Running on its own.\nHelp explains the buttons.\nAnother account can use Help. It cannot pause your swaps.\n${SITE}`;
}

async function send(chatId, text) {
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 3500) }),
  });
}

let offset = 0;
while (true) {
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/getUpdates`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ offset, timeout: 25, allowed_updates: ["message"] }),
      signal: AbortSignal.timeout(35000),
    });
    const payload = await response.json();
    if (!response.ok) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      continue;
    }
    for (const update of payload.result ?? []) {
      if (typeof update.update_id === "number") offset = Math.max(offset, update.update_id + 1);
      const message = update.message;
      const raw = typeof message?.text === "string" ? message.text.trim() : "";
      const chatId = message?.chat?.id;
      if (!raw || !chatId) continue;
      const text = BUTTONS[raw] ?? raw;
      if (!text.startsWith("/")) continue;
      const cmd = text.split(/\s+/)[0]?.split("@")[0] ?? "";
      const arg = text.split(/\s+/)[1] ?? "";
      const isAdmin = admin && String(message.from?.id ?? "") === admin;
      const reply = isAdmin ? await ownerReply(cmd, arg) : guestReply(cmd);
      await send(chatId, reply);
    }
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}
