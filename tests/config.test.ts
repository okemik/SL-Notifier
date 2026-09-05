import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
const base = { TELEGRAM_BOT_TOKEN: "123:test-secret", TELEGRAM_CHAT_ID: "123" };
test("configuration has safe defaults and preserves explicit line choices", () => {
  const config = loadConfig(base);
  assert.equal(config.intervalMs, 60000);
  assert.equal(config.timeZone, "Europe/Stockholm");
  assert.equal(config.checkApiKey, undefined);
  assert.deepEqual(loadConfig({ ...base, LINES: "13, 14,13", TRANSPORT_MODE: "metro" }).lines, [13, 14]);
});
test("invalid configuration fails before starting or fetching", () => {
  for (const [name, value] of [
    ["CHECK_INTERVAL_MS", "1000"], ["CHECK_INTERVAL_MS", "NaN"], ["CHECK_INTERVAL_MS", "1e6"],
    ["PRUNE_DAYS", "0"], ["LINES", "bad,17"], ["LINES", ""], ["LINES", "-17"],
    ["FUTURE", "yes"], ["TRANSLATE_ENABLED", "1"], ["PORT", "65536"],
    ["TRANSPORT_MODE", "PLANE"], ["TZ", "Invalid/Zone"], ["STATE_DB", " "], ["PREFERRED_LANG", "<html>"],
  ]) assert.throws(() => loadConfig({ ...base, [name]: value }), new RegExp(name));
  assert.throws(() => loadConfig({}), /TELEGRAM_BOT_TOKEN/);
});
test("configuration error messages do not contain invalid secret values", () => {
  const secret = "secret-value-with-token";
  assert.throws(() => loadConfig({ ...base, PORT: secret }), error => {
    assert.equal(String(error).includes(secret), false); return true;
  });
});
