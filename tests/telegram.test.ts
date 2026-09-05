import test from "node:test";
import assert from "node:assert/strict";
import { createTelegramSender } from "../src/telegram.js";
import { TelegramDeliveryError, safeError } from "../src/errors.js";
const opts = { token: "123:never-log-this", chatId: "123", text: "Hello" };
const success = { ok: true, result: { message_id: 1 } };
test("sends are serialized and spaced for the group limit of 20 per minute", async () => {
  let now = 0; const calls: number[] = [];
  const send = createTelegramSender({
    now: () => now, sleep: async ms => { now += ms; },
    request: async () => { calls.push(now); return success; },
  });
  await Promise.all([send(opts), send(opts), send(opts)]);
  assert.deepEqual(calls, [0, 3000, 6000]);
});
test("429 respects retry_after and accepts the subsequent successful response", async () => {
  let now = 0, calls = 0;
  const send = createTelegramSender({
    now: () => now, sleep: async ms => { now += ms; },
    request: async () => {
      calls++;
      return calls === 1 ? { ok: false, error_code: 429, parameters: { retry_after: 3 } } : success;
    },
  });
  await send(opts); assert.equal(calls, 2); assert.equal(now, 3000);
});
test("long retry_after defers without an excessive sleep", async () => {
  let calls = 0, sleeps = 0;
  const send = createTelegramSender({
    sleep: async () => { sleeps++; },
    request: async () => { calls++; throw new TelegramDeliveryError(429, 120000); },
  });
  await assert.rejects(send(opts), error => {
    assert.ok(error instanceof TelegramDeliveryError);
    assert.equal(error.retryAfterMs, 120000); return true;
  });
  assert.equal(calls, 1); assert.equal(sleeps, 0);
});
test("explicit server errors have bounded retries; ambiguous network errors are not immediately retried", async () => {
  let now = 0, calls = 0;
  const send = createTelegramSender({
    now: () => now, sleep: async ms => { now += ms; },
    request: async () => { calls++; throw new TelegramDeliveryError(503); },
  });
  await assert.rejects(send(opts), TelegramDeliveryError); assert.equal(calls, 3);
  calls = 0;
  const network = createTelegramSender({ request: async () => { calls++; throw new Error(opts.token); } });
  await assert.rejects(network(opts), error => {
    assert.doesNotMatch(String(error), /never-log/); return true;
  });
  assert.equal(calls, 1);
});
test("invalid bodies and oversize messages cannot be acknowledged", async () => {
  let calls = 0;
  const send = createTelegramSender({ request: async () => { calls++; return { ok: true }; } });
  await assert.rejects(send({ ...opts, text: "x".repeat(4097) })); assert.equal(calls, 0);
  await assert.rejects(send(opts)); assert.equal(calls, 1);
});
test("sanitization omits URL, payload, credentials and arbitrary error messages", () => {
  const error = Object.assign(new Error(opts.token), {
    config: { url: `https://api.telegram.org/bot${opts.token}/sendMessage`, data: opts },
    code: "SENSITIVE_CODE_" + opts.token,
  });
  assert.equal(safeError(error), "Operation failed");
  assert.equal(safeError({ code: "ETIMEDOUT" }), "ETIMEDOUT");
  assert.equal(safeError(new TelegramDeliveryError(401)), "Telegram HTTP 401");
});
