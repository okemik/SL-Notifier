# SL (Stockholm) – Green line deviations → Telegram notifier (near real-time)

This service checks SL deviations for the Stockholm Metro **Green line** frequently (default: every 60 seconds)
and sends **new or updated** deviations to a Telegram chat.

It behaves like "send when there is an incident", while still using a stable pull API + de-duplication.

## 1) Prereqs
- Node.js 20+ recommended
- A Telegram bot token
- A Telegram chat id (private chat or group)

## 2) Setup
```bash
cp .env.example .env
npm i
npm run dev
```

## 3) Environment variables
- `TELEGRAM_BOT_TOKEN` – Telegram Bot token from BotFather
- `TELEGRAM_CHAT_ID` – numeric chat id (e.g. `123456789` or `-100...` for groups)
- `CHECK_INTERVAL_MS` – how often to check (default `60000` = 60s)
- `LINES` – comma-separated line IDs to monitor (default: `17,18,19`)
- `TRANSPORT_MODE` – default `METRO`
- `FUTURE` – `true`/`false` (default `false`)
- `TZ` – set to `Europe/Stockholm`

## 4) Run in production
```bash
npm run build
npm start
```

## 5) Docker
```bash
docker build -t sl-greenline-bot .
docker run --rm -p 3000:3000 --env-file .env sl-greenline-bot
```

## 6) Notes
- State is stored in a local SQLite file `state.db`.
- A deviation is considered "new" by the unique key `deviation_case_id:version`.
  If SL updates a message and increments its `version`, you'll get a new Telegram notification.
- Old `sent` records are pruned automatically (default: keep last 14 days).
