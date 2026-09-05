# SL notifier reliability implementation plan

> For agentic workers: execute the independently owned tasks below with parallel agents and review the integrated result before completion.

**Goal:** Implement the reliability and deployment corrections approved after the repository audit.

**Architecture:** Keep Express, TypeScript and SQLite. Separate configuration, polling orchestration, formatting and durable delivery. Persist grouped message parts before sending; acknowledge each accepted part transactionally and retain in-memory acknowledgements when a database write fails. HTTP health distinguishes process liveness from successful recent checks.

**Tech Stack:** Node.js 24 LTS, TypeScript, Express, Axios, built-in node:sqlite, Node test runner with tsx.

## Global constraints

- No live Telegram messages or deployment during development.
- Preserve existing SQLite sent records and grouped bilingual alerts.
- SL requests must be at least 60 seconds apart, including manual requests.
- Telegram messages must be at most 4096 UTF-16 code units without splitting surrogate pairs.
- Do not expose raw Axios errors, credentials, chat identifiers or payloads in logs or HTTP responses.
- A Telegram acceptance followed by process termination before durable acknowledgement is inherently ambiguous; do not claim exactly-once delivery.
- Default manual control is disabled unless CHECK_API_KEY is configured.

## Task 1: Durable delivery and safe transport

Files: src/state.ts, src/telegram.ts, src/errors.ts, tests/state.test.ts, tests/telegram.test.ts.

Interfaces:

```ts
type DeliveryBatch = { id: string; keys: string[]; parts: string[]; nextPart: number };
// StateStore: alreadySent(key), isQueued(key), enqueue(keys, parts), pending(),
// acknowledgePart(id, nextPart), prune(days, activeKeys), close().
// sendTelegramMessage({token, chatId, text}) -> Promise<void>.
// TelegramDeliveryError: retryAfterMs?: number, status?: number; safe message only.
// safeError(error: unknown) -> string (fixed allowlisted information).
```

- [x] Add regression tests for restart/resume, atomic final acknowledgement, legacy sent table and active-record retention.
- [x] Implement durable grouped batches with per-part progress; create database parent directory, WAL and busy timeout.
- [x] Bound Telegram retries; respect retry_after; return a typed safe error and never log transport config.
- [x] Verify transport response bodies as well as HTTP status, size limits and error sanitization.

## Task 2: Validated input and accurate messages

Files: src/types.ts, src/sl.ts, src/format.ts, src/translate.ts, tests/format.test.ts, tests/sl.test.ts.

Interfaces:

```ts
type FormatOptions = { preferredLang: string; transportMode: string; timeZone: string; translate?: boolean };
type PreparedDeviation = { key: string; group: string; importance: number; text: string };
// prepareDeviation(d, options) -> Promise<PreparedDeviation>
// buildMessageBatches(items) -> Array<{keys: string[]; parts: string[]}>
// fetchDeviations(filters) -> Promise<Deviation[]> (throws on invalid response).
```

- [x] Test line 13, mixed 40/41 scopes, missing language variants, translation failure and long Unicode text.
- [x] Produce accurate scope groups from scope.lines, keeping all affected lines; use importance for sorting only.
- [x] Group short messages and split oversized individual messages deterministically, recording their deviation keys.
- [x] Validate network payloads before formatting; bound translation work and allow translation to be disabled.

## Task 3: Polling, state reporting and request controls

Files: src/config.ts, src/notifier.ts, src/app.ts, src/index.ts, tests/notifier.test.ts, tests/app.test.ts, tests/config.test.ts.

- [x] Test immediate startup, overlap prevention, minimum interval and timer recovery after a failure using an injected clock and scheduler.
- [x] Drain persisted batches, fetch new deviations, prepare each independently, enqueue before sending and acknowledge each part.
- [x] Retain successful acknowledgements in memory if database persistence fails; flush them before any further delivery attempt.
- [x] Preserve active sent keys during pruning; make preparation/delivery failures visible without stopping unrelated batches.
- [x] Report /health liveness, /ready readiness and /check actual outcome; secure manual check with a configured bearer key.
- [x] Validate all environment settings and shut down timers, requests and SQLite gracefully.

## Task 4: Reproducible deployment

Files: package.json, package-lock.json, Dockerfile, compose.yaml, .dockerignore, .env.example, README.md, .github/workflows/ci.yml.

- [x] Use supported Node 24, built-in SQLite and matching Node types, npm test and npm check scripts.
- [x] Fix Docker build-stage inputs, install from lockfile and keep only production dependencies in the non-root runtime image.
- [x] Add persistent /data storage, a documented restart policy and complete environment examples.
- [x] Add CI for type checking, tests and Docker build.

## Integrated verification

- [x] Run npm install to generate the lockfile, then npm run check and npm test with no external service calls.
- [x] Run npm audit and address actionable dependency issues within scope.
- [x] Build the container if a Docker engine is available; otherwise report that validation limitation explicitly.
- [x] Review the complete diff against the approved audit and confirm secrets are absent.

## Installation correction

A clean Windows install exposed a native SQLite addon build failure. Storage now uses Node 24.15+ built-in SQLite with explicit BEGIN IMMEDIATE/COMMIT/ROLLBACK transactions. Existing database schemas and queued parts are preserved; C++ build tools are no longer required.

## Verified result

- Node 24.20.0 clean npm ci: successful, 0 audited vulnerabilities.
- npm run check: source and test types pass.
- npm test: 37 passed, 0 failed, using fixtures, local HTTP and temporary SQLite databases.
- npm run build: successful.
- Docker Compose configuration validates without resolving credentials.
- Docker image build was not run because the Docker engine is unavailable; CI includes the build check.
- No live Telegram messages, deployment, or git commits were performed.
