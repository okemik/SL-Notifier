import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { Notifier, type NotifierDependencies } from "../src/notifier.js";
import { StateStore } from "../src/state.js";
import { prepareDeviation } from "../src/format.js";
import { TelegramDeliveryError } from "../src/errors.js";
import { deviation } from "./fixtures.js";

const settle = () => new Promise<void>(resolve => setImmediate(resolve));
function harness(t: TestContext, overrides: Partial<NotifierDependencies> = {}) {
  const store = new StateStore(":memory:");
  t.after(() => store.close());
  let time = 1000000, fetches = 0;
  const messages: string[] = [];
  const timers: Array<{ callback: () => void; delay: number }> = [];
  const notifier = new Notifier({
    store, fetch: async () => { fetches++; return { deviations: [], rejectedCount: 0 }; },
    prepare: d => prepareDeviation(d, { preferredLang: "sv", transportMode: "METRO", timeZone: "Europe/Stockholm", translate: false }),
    send: async text => { messages.push(text); },
    intervalMs: 60000, pruneDays: 14, now: () => time,
    schedule: (callback, delay) => { const timer = { callback, delay }; timers.push(timer); return timer; },
    cancel: () => {}, ...overrides,
  });
  return { store, notifier, messages, timers, advance: (ms = 60000) => { time += ms; }, fetches: () => fetches };
}
test("startup checks immediately, never starts twice, and schedules after completion", async t => {
  const h = harness(t);
  h.notifier.start(); h.notifier.start(); await settle();
  assert.equal(h.fetches(), 1); assert.equal(h.timers.length, 1); assert.equal(h.timers[0].delay, 60000);
  h.advance(); h.timers[0].callback(); await settle();
  assert.equal(h.fetches(), 2); assert.equal(h.notifier.status().ready, true);
  await h.notifier.stop();
});
test("manual and scheduled checks share overlap and minimum interval guards", async t => {
  let resolveFetch!: (result: { deviations: []; rejectedCount: number }) => void;
  let calls = 0;
  const h = harness(t, { fetch: () => { calls++; return new Promise(resolve => { resolveFetch = resolve; }); } });
  const first = h.notifier.check();
  assert.equal((await h.notifier.check()).skipped, "running");
  resolveFetch({ deviations: [], rejectedCount: 0 }); await first;
  assert.equal((await h.notifier.check()).skipped, "interval"); assert.equal(calls, 1);
});
test("SL failures report failure, keep readiness false and do not prevent draining the persisted queue", async t => {
  const h = harness(t, { fetch: async () => { throw new Error("secret-url"); } });
  h.store.enqueue(["old:1"], ["Queued before outage"]);
  const result = await h.notifier.check();
  assert.equal(result.ok, false); assert.equal(result.sent, 1);
  assert.deepEqual(h.messages, ["Queued before outage"]); assert.equal(h.notifier.status().ready, false);
  assert.doesNotMatch(JSON.stringify(result), /secret-url/);
});
test("a long incident is split and the following short incident is delivered and deduplicated", async t => {
  const h = harness(t, { fetch: async () => ({ deviations: [deviation(1, "🚆".repeat(3000)), deviation(2)], rejectedCount: 0 }) });
  const first = await h.notifier.check();
  assert.equal(first.ok, true); assert.equal(first.sent, 2); assert.ok(h.messages.length > 2);
  assert.ok(h.messages.every(text => text.length <= 4096));
  const count = h.messages.length;
  h.advance(); await h.notifier.check(); assert.equal(h.messages.length, count);
  assert.equal(h.store.alreadySent("1:1"), true); assert.equal(h.store.alreadySent("2:1"), true);
});
test("failure of one batch does not starve an unrelated batch", async t => {
  const attempted: string[] = [];
  const h = harness(t, {
    fetch: async () => ({ deviations: [deviation(1, "Bad", [17]), deviation(2, "Good", [18])], rejectedCount: 0 }),
    send: async text => { attempted.push(text); if (text.includes("Line 17")) throw new TelegramDeliveryError(400); },
  });
  const result = await h.notifier.check();
  assert.equal(result.ok, false); assert.equal(attempted.length, 2);
  assert.equal(h.store.alreadySent("2:1"), true); assert.equal(h.store.isQueued("1:1"), true);
});
test("failed persistence after an accepted send is retried without sending again", async t => {
  const store = new StateStore(":memory:"); t.after(() => store.close());
  let failWrite = true;
  const h = harness(t, {
    store: {
      alreadySent: key => store.alreadySent(key), isQueued: key => store.isQueued(key),
      enqueue: (keys, parts) => store.enqueue(keys, parts), pending: () => store.pending(),
      prune: (days, keys) => store.prune(days, keys),
      acknowledgePart: (id, nextPart) => {
        if (failWrite) { failWrite = false; throw Object.assign(new Error("disk"), { code: "SQLITE_BUSY" }); }
        store.acknowledgePart(id, nextPart);
      },
    },
    fetch: async () => ({ deviations: [deviation()], rejectedCount: 0 }),
  });
  assert.equal((await h.notifier.check()).ok, false); assert.equal(h.messages.length, 1);
  h.advance(); assert.equal((await h.notifier.check()).ok, true);
  assert.equal(h.messages.length, 1); assert.equal(store.alreadySent("1:1"), true);
});
test("Telegram cooldown prevents later batches and subsequent early delivery attempts", async t => {
  let calls = 0;
  const h = harness(t, {
    fetch: async () => ({ deviations: [deviation(1, "A", [17]), deviation(2, "B", [18])], rejectedCount: 0 }),
    send: async () => { calls++; throw new TelegramDeliveryError(429, 120000); },
  });
  await h.notifier.check(); assert.equal(calls, 1);
  h.advance(); await h.notifier.check(); assert.equal(calls, 1);
  h.advance(); await h.notifier.check(); assert.equal(calls, 2);
});
test("partial SL results are degraded, protect retention, and still send good records", async t => {
  let prunes = 0;
  const store = new StateStore(":memory:"); t.after(() => store.close());
  const h = harness(t, {
    store: {
      alreadySent: key => store.alreadySent(key), isQueued: key => store.isQueued(key),
      enqueue: (keys, parts) => store.enqueue(keys, parts), pending: () => store.pending(),
      acknowledgePart: (id, next) => store.acknowledgePart(id, next), prune: () => { prunes++; },
    },
    fetch: async () => ({ deviations: [deviation()], rejectedCount: 1 }),
  });
  const result = await h.notifier.check();
  assert.equal(result.ok, false); assert.equal(result.sent, 1); assert.equal(prunes, 0);
});
test("failure does not kill the timer; readiness becomes stale and shutdown cancels polling", async t => {
  let calls = 0, cancelled = 0, aborted = 0;
  const h = harness(t, {
    fetch: async () => { if (++calls === 1) throw new Error("outage"); return { deviations: [], rejectedCount: 0 }; },
    cancel: () => { cancelled++; }, abort: () => { aborted++; },
  });
  h.notifier.start(); await settle(); assert.equal(h.notifier.status().ready, false);
  h.advance(); h.timers[0].callback(); await settle(); assert.equal(h.notifier.status().ready, true);
  h.advance(180001); assert.equal(h.notifier.status().ready, false);
  await h.notifier.stop(); assert.equal(cancelled, 1); assert.equal(aborted, 1);
  assert.equal((await h.notifier.check()).skipped, "stopping");
});
test("preparation failure and repeated API keys do not block a healthy event", async t => {
  const h = harness(t, {
    fetch: async () => ({ deviations: [deviation(1), deviation(2), deviation(2)], rejectedCount: 0 }),
    prepare: async d => {
      if (d.deviation_case_id === 1) throw new Error("malformed");
      return prepareDeviation(d, { preferredLang: "sv", transportMode: "METRO", timeZone: "Europe/Stockholm", translate: false });
    },
  });
  const result = await h.notifier.check();
  assert.equal(result.ok, false); assert.equal(result.sent, 1); assert.equal(h.store.alreadySent("2:1"), true);
});


test("stop waits for an in-flight send and persists its acknowledgement before returning", async t => {
  let resolveSend!: () => void;
  let stopped = false;
  const h = harness(t, { send: () => new Promise<void>(resolve => { resolveSend = resolve; }) });
  h.store.enqueue(["late:1"], ["Pending send"]);
  const check = h.notifier.check();
  await settle();
  const stopping = h.notifier.stop().then(() => { stopped = true; });
  try {
    // Exercise the previous notifier-level timeout without a ten-second real wait.
    for (const timer of h.timers.filter(timer => timer.delay === 10000)) timer.callback();
    await settle();
    assert.equal(stopped, false);
    assert.equal(h.store.alreadySent("late:1"), false);
    assert.equal((await h.notifier.check()).skipped, "stopping");
  } finally {
    resolveSend();
    await check;
    await stopping;
  }
  assert.equal(h.store.alreadySent("late:1"), true);
  assert.equal(h.notifier.status().running, false);
});
