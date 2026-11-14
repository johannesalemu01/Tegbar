# Tegbar · ተግባር

A private co-founder operating system that lives in Telegram. It is built for two
founders today, and is organised around **projects** so it can take on more projects, people and modules later.
RideHome is the first project; `General` holds company-wide items.

> Tegbar is **not** accounting software, and Telegram bot chats are **not**
> end-to-end encrypted. Never send passwords, API keys, ID numbers or legal secrets.

## What works now (Phase 1)

- One-time pairing with `SETUP_CODE`. The first two people become co-founders A and B, then registration closes for good. Everyone else gets no reply.
- Projects: create, rename, describe, add links, change status (idea → active → paused → done), archive, switch the current project, use a `#code` override in any command.
- Areas per project, with default owners (tech areas → A, business areas → B).
- Tasks:
  - Quick add from one line (`Call MMCY tomorrow 10am @sami !high #ridehome #sales`).
  - A confirmation card when anything is ambiguous.
  - Done, Snooze, Edit, Reassign, Delete with confirmation, and Restore / `/undo`.
  - Full history of every change.
  - Views `/my /ours /today /week /overdue` with owner, project and status filters and pagination.
  - The partner gets a notification when you assign them a task.
- `/dashboard` across projects and people, `/settings` (current project, 24h/12h), `/menu`, `/help`.
- An append-only event log, feature flags, typed settings, Docker, a health check, structured logs, graceful shutdown, and critical-error alerts to co-founder A.

The next phases are reminders and digests (2), meetings (3), shared costs (4), and notices, decisions, notes, search and backups (5).

## 1. Create the bot (@BotFather)

1. Open [@BotFather](https://t.me/BotFather) → `/newbot` → pick a name (`Tegbar`) and a username ending in `bot`.
2. Copy the **API token** and keep it secret.
3. `/mybots` → your bot → **Bot Settings → Allow Groups? → Turn off** (Tegbar is private-chat only for now).
4. Optional: `/setdescription`, `/setuserpic`.

You don't need to set commands by hand. Tegbar sets them itself, and only for the two paired chats.

## 2. Configure

```bash
cp .env.example .env
openssl rand -base64 24      # paste the output as SETUP_CODE
```

| Variable | Required | Meaning |
|---|---|---|
| `BOT_TOKEN` | yes | Token from @BotFather |
| `SETUP_CODE` | yes | One-time pairing secret (≥ 12 chars). Share it privately with your co-founder. |
| `PERSON_A_NAME`, `PERSON_B_NAME` | no | Display names (`John`, `Sami`); they also become the `@john` / `@sami` handles |
| `DATA_DIR` | no | Where the database lives (default `./data`) |
| `BOT_MODE` | no | `polling` (default) or `webhook` |
| `WEBHOOK_URL`, `WEBHOOK_SECRET` | webhook only | Public HTTPS base URL and the secret Telegram sends in `X-Telegram-Bot-Api-Secret-Token` |
| `PORT`, `HOST` | no | HTTP server for `/healthz` (and `/telegram` in webhook mode) |
| `TIMEZONE` | no | Default `Africa/Addis_Ababa` |
| `BUTTON_STYLES` | no | `on` uses Telegram's coloured button styles; set `off` if they render badly |
| `LOG_LEVEL` | no | `info` by default |

## 3. Run locally

Requires Node.js 22 or newer.

```bash
npm install
npm test            # 50 tests
npm run dev         # long polling, reloads on change
```

Then pair in Telegram:

1. **John** opens the bot and sends the `SETUP_CODE` as a message, or `/start <code>`. The bot deletes that message and welcomes John as co-founder **A**.
2. **Sami** does the same and becomes co-founder **B**. John gets a "Sami joined" message, and registration is now closed permanently.

To add a third person later you will use an owner-approved invite. That arrives with the generic approvals mechanism in Phase 4; `SETUP_CODE` will never work again.

## 4. Deploy (free hosting)

Tegbar needs **one always-on process and a persistent disk** for SQLite.
Long polling needs **no public URL or open port**, which makes free VMs easy.

**Good fits** [VERIFY the current free-tier terms before signing up]:

- **Oracle Cloud "Always Free"**: a small Ampere (arm64) or AMD VM with a persistent boot volume. This is the best free option. The Docker image is multi-arch.
- **Google Cloud free tier `e2-micro`**: only in some US regions, with a small persistent disk.
- **A spare laptop, mini-PC or Raspberry Pi at home**: works fine with long polling.

**Poor fits**: free web/app tiers that **sleep when idle** or have an **ephemeral filesystem**. They lose the database and will miss reminders from Phase 2 onwards. Serverless functions fall in the same group.

### On the VM

```bash
# Debian/Ubuntu
sudo apt-get update && sudo apt-get install -y docker.io docker-compose-plugin git
git clone https://github.com/johannesalemu01/Tegbar.git && cd Tegbar
cp .env.example .env && nano .env            # set BOT_TOKEN, SETUP_CODE, names
mkdir -p data && sudo chown 1000:1000 data    # the container runs as uid 1000 (node)
sudo docker compose up -d --build
sudo docker compose logs -f                   # look for "long polling started"
curl -s localhost:8080/healthz                # {"ok":true,...}
```

Update with `git pull && sudo docker compose up -d --build`. Migrations run automatically at start.

### Webhook mode (optional)

Put Tegbar behind HTTPS (Caddy, nginx, or a tunnel) and set `BOT_MODE=webhook`, `WEBHOOK_URL=https://your.host` and `WEBHOOK_SECRET=<16–256 chars of A-Z a-z 0-9 _ ->`.
Tegbar registers `https://your.host/telegram`. grammY rejects requests whose secret header doesn't match.

## 5. Backup and restore

Encrypted, scheduled backups with a tested restore arrive in **Phase 5**. Until then, make a consistent copy while the bot runs:

```bash
sudo docker compose exec tegbar node -e "
  const D=require('better-sqlite3'); new D('/data/tegbar.db').backup('/data/backup-'+Date.now()+'.db').then(()=>console.log('ok'))"
```

Copy `data/backup-*.db` off the server. Treat it like a password, because it is not encrypted yet.
To restore: stop the bot, replace `data/tegbar.db` with the backup, delete `tegbar.db-wal` and `tegbar.db-shm`, then start the bot.

## 6. Everyday use

| Do this | Send |
|---|---|
| Add a task | any message, or `/add Call MMCY tomorrow 10am @sami !high #sales` |
| My tasks everywhere | `/my` |
| Everyone's tasks in the current project | `/ours` (or `/ours #general`) |
| Due today / this week / overdue | `/today`, `/week`, `/overdue` |
| Open, reassign or re-date a task | `/task T12`, `/assign T12 @sami`, `/due T12 friday 5pm` |
| Restore the last deletion | `/undo` |
| Switch project | `/project` or `/project #ridehome` |
| New project | `/projects` → **＋ New project** → `FLEET Fleet Ops — B2B pilot` |

Quick-add syntax:

- `@john`, `@sami`, `@me`, `@partner` for the owner
- `!high`, `!low` for priority
- `#ridehome` for the project, `#sales` for an area in that project
- dates such as `tomorrow 10am`, `friday`, `in 3 hours`, `2026-11-20 15:00`, or the Amharic `ዛሬ`, `ነገ`, `ከነገ ወዲያ`

## 7. Extending

- **New project**: use the bot. The defaults (areas Product, Engineering, Sales, Operations) are in `src/core/services/projects.ts`.
- **New module**: see [ARCHITECTURE.md](ARCHITECTURE.md#adding-a-module). In short: schema + migrations + service + telegram registration, then one line in `src/app.ts`.

## Dependencies and why

| Package | Why |
|---|---|
| `grammy` | Telegram Bot API framework, typed, maintained |
| `better-sqlite3` | Fast embedded database, no server to run |
| `kysely` | Typed SQL builder and migrator; the same code can target PostgreSQL later |
| `luxon` | Time zones (Africa/Addis_Ababa) and date maths |
| `chrono-node` | Natural-language dates for quick add |
| `pino` | Structured JSON logs with secret redaction |
| `zod` | Validates environment config at start-up |

Dev only: `typescript`, `tsx`, `vitest`, and type packages.
I left out grammY's conversations and menu plugins: flows are stored in the database instead, which survives restarts and makes stale buttons safe.
