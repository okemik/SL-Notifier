# Review Fixes Implementation Plan

**Goal:** Correct the four approved translation and shutdown findings.
**Architecture:** Retain provider adapters and queue; share the startup translator and isolate the service shutdown deadline from notifier draining.
**Tech Stack:** TypeScript, Node 24, Axios, node:test, node:sqlite.

## Constraints
- Keep the existing 60-second external cron arrangement.
- No new runtime dependencies or credential changes.
- No live Telegram sends or deployment.

## Task 1: Translation validation
- [x] Mock Axios in tests/translate.test.ts. Force Google failure, assert MyMemory q parameters stay within 500 UTF-8 bytes and preserve Unicode. Reject responseStatus 403/429/500, missing status and blank partial translations; failed responses must not be cached.
- [x] Run node --import tsx --test tests/translate.test.ts and observe failures.
- [x] In src/translate.ts iterate code points with Buffer.byteLength(character, 'utf8'), split at 500 bytes with preferred word boundaries, and require responseStatus === 200 and nonempty translatedText for every part.

## Task 2: Shared translator
- [x] In src/index.ts construct the selected translator before Notifier and pass the same instance to every prepareDeviation call.
- [x] Prepare different Swedish deviations with a shared LibreTranslate instance and assert one provider request for identical text.

## Task 3: Ordered, bounded shutdown
- [x] Add a notifier regression with a deferred send; stop must wait and persist the acknowledgement.
- [x] Replace Notifier.stop's Promise.race with await this.activeCheck.
- [x] Add src/shutdown.ts exposing shutdownService({stop, closeHttp, closeStore}): Promise<boolean>. Race full shutdown against ten seconds; return false on timeout. Close storage only after stop settles and while shutdown has not expired.
- [x] Make src/index.ts exit with status 1 on timeout/error, keeping the idempotent guard.
- [x] Test normal drain, delayed notifier, delayed HTTP close and errors using virtual timers in tests/shutdown.test.ts.

## Task 4: Verification
- [x] Update README.md with byte limits, per-request timeouts and forced-shutdown behavior.
- [x] Run npm run check, npm test and npm run build with Node 24.
- [x] Inspect git diff --check and the final diff; retain local changes for review.

## Verification result

The initial regression run produced seven expected failures. After the fixes, all 54 tests passed; npm run check and npm run build passed under Node 24.20.0. Final diff review found no whitespace errors. No live credentials, Telegram messages, cron settings or deployment were changed.
