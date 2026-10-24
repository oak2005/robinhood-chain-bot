#!/usr/bin/env node
/**
 * Unified Process Supervisor for Railway & Production
 *
 * Runs:
 * 1. Database migration (node scripts/migrate.mjs)
 * 2. Web Application / Desk preview (node scripts/with-app-env.mjs vite preview)
 * 3. 24/7 Live Telegram Bot runner (node scripts/telegram-live.mjs)
 *
 * Features:
 * - Supervises child processes, automatically restarting the bot if it crashes.
 * - Streams output directly to stdout/stderr with timestamped [bot] and [web] prefixes.
 * - Forwards termination signals (SIGTERM, SIGINT) cleanly to child processes.
 * - Writes heartbeat and status to /tmp/supervisor-status.json.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";

console.log("==================================================================");
console.log("🚀 [supervisor] Starting Inactivity Trade Full Stack Service...");
console.log(`⏰ Time: ${new Date().toISOString()}`);
console.log(`📁 Node version: ${process.version}, PID: ${process.pid}`);
console.log("==================================================================");

// 1. Run deploy-time migrations if DATABASE_URL is set (skips cleanly for PGlite)
try {
  const { execSync } = await import("node:child_process");
  console.log("[supervisor] Checking database migrations...");
  execSync("node scripts/migrate.mjs", { stdio: "inherit" });
} catch (err) {
  console.warn("[supervisor] Migration notice (non-fatal):", err?.message || err);
}

let webChild = null;
let botChild = null;
let shuttingDown = false;
let botRestarts = 0;

const LOG_FILE = "/tmp/bot-recent-logs.txt";
const logBuffer = [];

function formatLog(prefix, data) {
  const lines = data.toString().split("\n");
  for (const line of lines) {
    if (line.trim()) {
      const entry = `[${new Date().toISOString()}] ${prefix} ${line}`;
      process.stdout.write(`${prefix} ${line}\n`);
      logBuffer.push(entry);
      if (logBuffer.length > 100) logBuffer.shift();
    }
  }
  try {
    fs.writeFileSync(LOG_FILE, logBuffer.join("\n"));
  } catch {}
}

// 2. Start Web Server (Vite preview on PORT)
function startWebServer() {
  if (shuttingDown) return;
  const port = process.env.PORT || "8080";
  console.log(`[supervisor] Spawning Web Desk preview on 0.0.0.0:${port}...`);

  webChild = spawn(
    "node",
    ["scripts/with-app-env.mjs", "vite", "preview", "--host", "0.0.0.0", "--port", port],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PORT: port },
    }
  );

  webChild.stdout.on("data", (data) => formatLog("🌐 [web]", data));
  webChild.stderr.on("data", (data) => formatLog("🌐 [web:err]", data));

  webChild.on("exit", (code, signal) => {
    console.error(`[supervisor] Web server exited with code ${code}, signal ${signal}`);
    if (!shuttingDown) {
      console.log("[supervisor] Web server exited unexpectedly. Triggering container restart...");
      process.exit(code || 1);
    }
  });
}

// 3. Start Telegram Live Bot Poller
function startBotPoller() {
  if (shuttingDown) return;
  console.log(`[supervisor] Spawning Telegram Live Poller (attempt #${botRestarts + 1})...`);

  botChild = spawn("node", ["scripts/telegram-live.mjs"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });

  botChild.stdout.on("data", (data) => formatLog("🤖 [bot]", data));
  botChild.stderr.on("data", (data) => formatLog("🤖 [bot:err]", data));

  botChild.on("exit", (code, signal) => {
    botRestarts++;
    console.warn(`[supervisor] ⚠️ Telegram bot exited with code ${code}, signal ${signal}`);
    if (!shuttingDown) {
      const delay = Math.min(3000 * Math.min(botRestarts, 5), 15000);
      console.log(`[supervisor] Auto-restarting Telegram bot in ${delay / 1000}s...`);
      setTimeout(startBotPoller, delay);
    }
  });
}

// Handle signals
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[supervisor] Received ${signal}. Gracefully stopping children...`);

  if (botChild) {
    try { botChild.kill(signal); } catch {}
  }
  if (webChild) {
    try { webChild.kill(signal); } catch {}
  }

  setTimeout(() => {
    console.log("[supervisor] Exiting.");
    process.exit(0);
  }, 2000);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// Launch both services
startWebServer();
startBotPoller();
