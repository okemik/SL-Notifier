import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/app.js";
import { Notifier } from "../src/notifier.js";
import { StateStore } from "../src/state.js";
import { parseDeviationResult } from "../src/sl.js";
import { prepareDeviation } from "../src/format.js";
import { createTelegramSender } from "../src/telegram.js";
import { deviation } from "./fixtures.js";
test("authenticated HTTP check flows through validation, formatting, Telegram acknowledgement and SQLite deduplication", async t => {
  let now = Date.now(), requests = 0;
  const store = new StateStore(":memory:");
  const telegram = createTelegramSender({
    now: () => now, sleep: async ms => { now += ms; },
    request: async options => {
      assert.ok(options.text.length <= 4096);
      assert.match(options.text, /Line 13/);
      requests++;
      return { ok: true, result: { message_id: requests } };
    },
  });
  const notifier = new Notifier({
    store, intervalMs: 60000, pruneDays: 14, now: () => now,
    fetch: async () => parseDeviationResult([deviation(1, "Delay", [13])]),
    prepare: d => prepareDeviation(d, { preferredLang: "sv", transportMode: "METRO", timeZone: "Europe/Stockholm", translate: false }),
    send: text => telegram({ text, token: "test-only", chatId: "test-only" }),
  });
  const server = createApp(notifier, "integration-key").listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    await notifier.stop();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const check = () => fetch(base + "/check", { method: "POST", headers: { Authorization: "Bearer integration-key" } });
  assert.equal((await fetch(base + "/ready")).status, 503);
  assert.equal((await check()).status, 200);
  assert.equal(requests, 1); assert.equal(store.alreadySent("1:1"), true);
  assert.equal((await fetch(base + "/ready")).status, 200);
  now += 60000;
  assert.equal((await check()).status, 200);
  assert.equal(requests, 1);
});
