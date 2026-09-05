# SL traffic alerts → Telegram

A small service that monitors SL deviations and sends new or updated alerts to one Telegram chat.
It checks immediately on startup and schedules the next check after the previous check finishes
(default delay: 60 seconds). Automatic and manual checks share a lock and a minimum request interval.

Alerts are grouped by the actual affected transport modes and lines. Original text and available
English text are retained; Swedish text can optionally be translated to English. Messages are split
to fit Telegram's 4096-character limit. SL importance values determine ordering, not a criticality label.

## Local setup

Use **Node.js 24 LTS (24.15 or later)** and npm.

```sh
cp .env.example .env
# Fill in TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID.
npm ci
npm run check
npm test
npm run build
npm start
```

For development: `npm run dev`. The bot must be permitted to post to the destination chat.
Starting the service with real credentials can immediately send currently active deviations.

## Docker (recommended for deployment)

```sh
docker compose up -d --build
```

Compose stores SQLite in the named `notifier-data` volume, restarts the service unless stopped,
and exposes port 3000 only on localhost. `docker compose down` preserves history;
adding `--volumes` removes it.

Equivalent manual setup:

```sh
docker build -t sl-notifier .
docker run -d --name sl-notifier --restart unless-stopped \
  -p 127.0.0.1:3000:3000 --env-file .env \
  -e STATE_DB=/data/state.db -e PORT=3000 \
  -v sl-notifier-data:/data sl-notifier
```

The image runs as the unprivileged node user and contains only production dependencies.
For a host bind mount, ensure the node user (UID 1000) can write the data directory.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| TELEGRAM_BOT_TOKEN | Required | Bot token; never place it in a URL used to call this service |
| TELEGRAM_CHAT_ID | Required | Destination chat ID or supported channel username |
| CHECK_INTERVAL_MS | 60000 | Delay after each scheduled check; range 60000–86400000 ms |
| TRANSPORT_MODE | METRO | BUS, METRO, TRAM, TRAIN, SHIP, FERRY or TAXI |
| LINES | 17,18,19 | Positive line numbers separated by commas; set these to match the transport mode |
| FUTURE | false | Include future deviations |
| PREFERRED_LANG | sv | Preferred original message language |
| TRANSLATE_ENABLED | true | Try Swedish-to-English translation if no English variant exists |
 | GOOGLE_TRANSLATE_API_KEY | Empty | Google Cloud Translation API v2 key for reliable Swedish→English; without it the free endpoint is attempted (often rate-limited by Google) |
| TZ | Europe/Stockholm | Time zone for displayed validity dates |
| PRUNE_DAYS | 14 | Retain inactive sent records for this many days (1–3650) |
| STATE_DB | state.db | SQLite path; Compose uses /data/state.db |
| PORT | 3000 | HTTP port (1–65535); Compose fixes it to 3000 |
| CHECK_API_KEY | Empty | Bearer secret for manual checks; empty disables the endpoint |

Invalid values fail at startup rather than silently monitoring different lines.
Translation is optional: a missing or failing translation never blocks the original alert from being
sent. Without `GOOGLE_TRANSLATE_API_KEY` the app uses Google's free, unauthenticated endpoint, which is
unreliable and frequently returns HTTP 429 ("automated queries"), so messages then show only the Swedish
original. For reliable English output, set `GOOGLE_TRANSLATE_API_KEY` to a Google Cloud Translation API
v2 key (billing required, pay-per-use); results are cached for one hour with an eight-second timeout and
a 4000-character input bound.

## Health and manual checks

- `GET /health`: process liveness (200). Used by the container health check.
- `GET /ready`: 200 after a successful recent check; 503 before the first success, after a failed check,
  during shutdown, or when the last success is older than three polling intervals (minimum two minutes).
  Includes last attempt/success, pending batches and a sanitized error.
- `POST /check`: requires `Authorization: Bearer <CHECK_API_KEY>`. Legacy GET is also supported with
  the same authentication. Without a configured key this returns 404.

```sh
curl -X POST http://localhost:3000/check -H "Authorization: Bearer YOUR_CHECK_API_KEY"
```

A completed check returns 200 on success or 503 on failure. Concurrent requests get 409;
requests inside the polling interval get 429 with Retry-After. A skipped request never starts
another SL fetch. Keep health endpoints on a trusted network or behind your own proxy.

## Delivery and state

- Storage uses Node 24's built-in SQLite, so no external SQLite addon or C++ build tools are needed.
  The Node API is currently release-candidate status; the SQLite file format remains compatible.
- SQLite keeps the existing `sent` table and adds a durable queue. Existing databases migrate automatically.
- A deviation is identified by `deviation_case_id:version`. Duplicate records and already queued versions
  are ignored.
- Grouped messages and their parts are stored before delivery. Each accepted part is acknowledged;
  after restart, delivery resumes at the first unacknowledged part.
- A SQLite acknowledgement failure stops further delivery. In the same process the accepted part is
  remembered and its acknowledgement is retried before another send.
- Explicit Telegram 429/5xx responses get bounded retries. Telegram retry_after is respected; longer
  waits defer the queue. Requests are spaced by at least three seconds to respect the group limit of 20 messages per minute. Ambiguous network failures are not
  retried inside the same send; the durable queue is revisited on a later check.
- A failed message does not erase the queue or trigger a second formatting/send path. Other batches may proceed.
- Active deviations remain protected from retention cleanup. Partial or failed SL responses skip pruning.
- A successful Telegram send followed by a crash before durable acknowledgement can still be repeated.
  Telegram does not offer an idempotency key for sendMessage; exactly-once delivery is not guaranteed.
- Use one service instance and one state database per destination. Do not run multiple replicas against
  the same database, and use a separate database when changing chats.
- SIGINT/SIGTERM stop polling, cancel network waits, and close SQLite after the current check settles.
  Back up the data directory while the service is stopped; include SQLite WAL files if copying a live database.

## Verification

`npm run check`, `npm test` and `npm run build` are also run in CI, followed by a Docker build.
Tests use local fixtures and fake network clients; no Telegram credentials are needed.

The qs 6.16.0 override fixes audited parser vulnerabilities while retaining the existing Express 4 API.

## Telegram groups

Add the bot to the target group and allow it to send messages. Set TELEGRAM_CHAT_ID to the numeric group ID and TELEGRAM_BOT_TOKEN to the BotFather token in .env. The group ID is available from a Telegram update after a command addressed to the bot. Keep privacy mode enabled for this outgoing-only notifier. Use a separate STATE_DB when switching from a private chat to a group. The service runs on your computer or server and posts into Telegram; it must stay running to deliver alerts.
