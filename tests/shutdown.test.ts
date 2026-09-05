import test from "node:test";
import assert from "node:assert/strict";
import { shutdownService } from "../src/shutdown.js";

const settle = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test("shutdown closes storage only after the notifier settles and waits for HTTP", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const stop = deferred(), http = deferred();
  const events: string[] = [];
  let finished = false;
  const result = shutdownService({
    closeHttp: () => { events.push("http"); return http.promise; },
    stop: () => { events.push("stop"); return stop.promise; },
    closeStore: () => { events.push("store"); },
  }).then(value => { finished = true; return value; });
  await settle();
  assert.deepEqual(events, ["http", "stop"]);
  t.mock.timers.tick(9999);
  await settle();
  assert.equal(finished, false);
  stop.resolve();
  await settle();
  assert.deepEqual(events, ["http", "stop", "store"]);
  assert.equal(finished, false);
  http.resolve();
  assert.equal(await result, true);
  t.mock.timers.tick(10000);
  assert.deepEqual(events, ["http", "stop", "store"]);
});

test("shutdown timeout never closes storage underneath a delayed notifier", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const stop = deferred();
  let closed = 0, finished = false;
  const result = shutdownService({
    closeHttp: async () => {}, stop: () => stop.promise, closeStore: () => { closed++; },
  }).then(value => { finished = true; return value; });
  await settle();
  t.mock.timers.tick(9999);
  await settle();
  assert.equal(finished, false);
  t.mock.timers.tick(1);
  assert.equal(await result, false);
  assert.equal(closed, 0);
  // Production exits immediately; a late resolution must not schedule a store close either.
  stop.resolve();
  await settle();
  assert.equal(closed, 0);
});

test("the shutdown deadline also bounds a hanging HTTP connection", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const http = deferred();
  let closed = 0;
  const result = shutdownService({
    closeHttp: () => http.promise, stop: async () => {}, closeStore: () => { closed++; },
  });
  await settle();
  assert.equal(closed, 1);
  t.mock.timers.tick(10000);
  assert.equal(await result, false);
  http.resolve();
  await settle();
  assert.equal(closed, 1);
});

test("shutdown propagates errors without leaving a late storage close", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const stop = deferred();
  let closed = 0;
  const result = shutdownService({
    closeHttp: async () => { throw new Error("HTTP close failed"); },
    stop: () => stop.promise, closeStore: () => { closed++; },
  });
  await assert.rejects(result, /HTTP close failed/);
  stop.resolve();
  await settle();
  t.mock.timers.tick(10000);
  assert.equal(closed, 0);
});
