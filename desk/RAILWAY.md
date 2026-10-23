# Railway Deployment & Configuration Guide

This service runs the **Inactivity Trade Live Telegram Bot (24/7)** and the **Web Member Desk**.

## Railway Service Settings

- **Root Directory**: `/desk`
- **Build Command**: `npm run build`
- **Start Command**: `npm start` (Runs the unified supervisor `start-service.mjs`, which supervises both the Web Desk and the Telegram Bot)

---

## Service Variables (under `Variables` tab in Railway)

### 🔴 Required Variables for Telegram Bot to Respond:
| Variable | Description | Example |
| :--- | :--- | :--- |
| `TELEGRAM_BOT_TOKEN` | Bot API token from [@BotFather](https://t.me/BotFather) | `7923481234:AAFt...` |
| `TELEGRAM_ADMIN_ID` | Your numeric Telegram user ID (from [@userinfobot](https://t.me/userinfobot)) | `123456789` |
| `VAULT_KEY` | Secret key (min 16 chars) used to seal member private keys via AES-256-GCM | `super-secret-vault-key-32-chars-long` |

### 🟢 Optional Variables:
| Variable | Description | Default |
| :--- | :--- | :--- |
| `DATABASE_URL` | **Leave EMPTY for internal database!** When empty, the bot automatically uses embedded local **PGlite** (`./data/pglite-data`). No Neon, Supabase, or external PostgreSQL needed. | Embedded PGlite |
| `PORT` | Web port automatically supplied by Railway | `8080` |
| `BETTER_AUTH_SECRET` | Secret for web desk authentication | auto-generated |
| `BETTER_AUTH_URL` | Web desk public URL (e.g. `https://robinhood-chain-bot-production.up.railway.app`) | Railway URL |

---

## Live Diagnostics in Railway Console

At any time, you can run the instant audit tool inside Railway:
1. Open your Railway project.
2. Click on the `robinhood-chain-bot` service.
3. Click on the **Console** tab.
4. Run:
```bash
node scripts/audit-bot.mjs
```
This will test the token, Telegram API, webhook, database, and bot heartbeat in 2 seconds.
