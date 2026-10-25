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

### 💾 Data Persistence (CRITICAL to prevent data wipe on updates):
By default, Docker containers in Railway have **ephemeral filesystems** — meaning every git push/redeploy starts a clean container.
To keep your users' payments, wallets, and settings permanently saved across updates, use either:

1. **Option A (Recommended - Railway PostgreSQL Database)**:
   - In your Railway project, click **+ New** -> **Database** -> **Add PostgreSQL**.
   - In your `robinhood-chain-bot` service -> **Variables** tab -> click **+ New Variable**:
     - Variable Name: `DATABASE_URL`
     - Value: `${{Postgres.DATABASE_URL}}` (or paste your PostgreSQL connection URL).
   - *Result:* All member access, payments, wallets, and tokens are saved in PostgreSQL and will **NEVER be cleared** when you deploy updates!

2. **Option B (Railway Persistent Volume)**:
   - In your Railway project, click your service -> **Settings** tab -> scroll down to **Volumes**.
   - Click **+ Add Volume** -> Set Mount Path to `/data`.
   - *Result:* The bot will automatically detect the volume and persist all data to `/data/bot-store.json` across all deploys!

---

### 🟢 Service Variables:
| Variable | Description | Example |
| :--- | :--- | :--- |
| `DATABASE_URL` | PostgreSQL connection string for permanent multi-deploy persistence | `${{Postgres.DATABASE_URL}}` |
| `PORT` | Web port automatically supplied by Railway | `8080` |
| `BETTER_AUTH_SECRET` | Secret for web desk authentication | auto-generated |
| `BETTER_AUTH_URL` | Web desk public URL | Railway URL |
| `SUPPORT_USERNAME` | (Optional) Admin Telegram username shown in support menu | `@yourtelegram` |

---

## Member Support & Feature Requests

Users can communicate issues or request features anytime:
- **In Bot Menu**: Tapping **`💬 Support & Feedback`** or typing `/support` or `/feature`.
- **Options**:
  - `🐛 Report Issue`: For bugs, swap issues, or errors.
  - `💡 Request Feature`: For proposing new tokens, chains, or DEX integrations.
  - `💬 Message Admin`: Direct message to the admin.

### Admin Commands (Admin Only):
- `/tickets` — List all open user support tickets and feature requests.
- `/reply <user_id> <message>` — Send a direct reply back to a user's Telegram chat.
- In-chat Buttons — When a ticket arrives, tap **`💬 Reply to User`** or **`✅ Close Ticket`**.

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
