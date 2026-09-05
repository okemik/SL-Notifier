import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/app.js";
import type { CheckResult, NotifierStatus } from "../src/notifier.js";
const status: NotifierStatus = {
  running: false, stopping: false, ready: false, lastAttemptAt: null, lastSuccessAt: null,
  lastError: null, nextCheckAt: null, consecutiveFailures: 0, pendingBatches: 0,
};
test("HTTP liveness, readiness, authentication and check outcomes remain distinct", async t => {
  let calls = 0;
  let result: CheckResult = { ok: false, ran: true, error: "SL check failed" };
  const server = createApp({ check: async () => { calls++; return result; }, status: () => status }, "test-key").listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  assert.equal((await fetch(base + "/health")).status, 200);
  assert.equal((await fetch(base + "/ready")).status, 503);
  assert.equal((await fetch(base + "/check", { method: "POST" })).status, 401);
  assert.equal(calls, 0);
  const authenticated = () => fetch(base + "/check", { method: "POST", headers: { Authorization: "Bearer test-key" } });
  assert.equal((await authenticated()).status, 503);
  result = { ok: true, ran: true }; assert.equal((await authenticated()).status, 200);
  result = { ok: true, ran: false, skipped: "running" }; assert.equal((await authenticated()).status, 409);
  result = { ok: true, ran: false, skipped: "interval", nextCheckAt: new Date(Date.now() + 60000).toISOString() };
  const limited = await authenticated(); assert.equal(limited.status, 429); assert.ok(Number(limited.headers.get("retry-after")) > 0);
});
test("manual checks are disabled without a configured key", async t => {
  const server = createApp({ check: async () => { throw new Error("must not run"); }, status: () => status }).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/check`, { method: "POST" });
  assert.equal(response.status, 404);
});
