import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { StateStore } from "../src/state.js";

test("group keys become sent only after the final part; acknowledgements are idempotent", t => {
  const store = new StateStore(":memory:"); t.after(() => store.close());
  store.enqueue(["1:1", "2:1"], ["part 1", "part 2"]);
  const batch = store.pending()[0];
  assert.equal(store.isQueued("1:1"), true);
  store.acknowledgePart(batch.id, 1);
  store.acknowledgePart(batch.id, 1);
  assert.equal(store.alreadySent("1:1"), false);
  assert.equal(store.pending()[0].nextPart, 1);
  store.acknowledgePart(batch.id, 2);
  store.acknowledgePart(batch.id, 2);
  assert.equal(store.alreadySent("1:1"), true);
  assert.equal(store.alreadySent("2:1"), true);
  assert.equal(store.isQueued("1:1"), false);
  assert.deepEqual(store.pending(), []);
});
test("legacy history migrates, queued parts survive reopening, active old records survive pruning", t => {
  const dir = mkdtempSync(join(tmpdir(), "sl-notifier-test-"));
  t.after(() => {
    assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + sep));
    rmSync(dir, { recursive: true, force: true });
  });
  const path = join(dir, "state.db");
  const old = new DatabaseSync(path);
  old.exec("CREATE TABLE sent(id TEXT PRIMARY KEY, sent_at TEXT NOT NULL)");
  old.prepare("INSERT INTO sent VALUES (?, ?)").run("active:1", "2020-01-01T00:00:00Z");
  old.prepare("INSERT INTO sent VALUES (?, ?)").run("inactive:1", "2020-01-01T00:00:00Z");
  old.close();
  let store = new StateStore(path);
  assert.equal(store.alreadySent("active:1"), true);
  store.enqueue(["new:1"], ["first", "second"]);
  store.acknowledgePart(store.pending()[0].id, 1);
  store.close();
  store = new StateStore(path);
  try {
    assert.equal(store.pending()[0].nextPart, 1);
    assert.equal(store.pending()[0].parts[1], "second");
    store.prune(14, ["active:1"]);
    assert.equal(store.alreadySent("active:1"), true);
    assert.equal(store.alreadySent("inactive:1"), false);
  } finally { store.close(); }
});
test("invalid queue writes and skipped acknowledgements cannot corrupt progress", t => {
  const store = new StateStore(":memory:"); t.after(() => store.close());
  assert.throws(() => store.enqueue(["1:1"], ["x".repeat(4097)]));
  assert.throws(() => store.enqueue(["1:1", "1:1"], ["hello"]));
  store.enqueue(["1:1"], ["one", "two"]);
  assert.throws(() => store.enqueue(["1:1", "2:1"], ["other"]));
  assert.equal(store.isQueued("2:1"), false);
  assert.throws(() => store.acknowledgePart(store.pending()[0].id, 2));
  assert.equal(store.pending()[0].nextPart, 0);
});


test("a mid-transaction SQLite failure rolls back all sent keys and preserves the queue", t => {
  const dir = mkdtempSync(join(tmpdir(), "sl-notifier-atomic-test-"));
  const path = join(dir, "state.db");
  const store = new StateStore(path);
  const control = new DatabaseSync(path);
  t.after(() => {
    store.close(); control.close();
    assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + sep));
    rmSync(dir, { recursive: true, force: true });
  });
  control.exec("CREATE TRIGGER fail_second BEFORE INSERT ON sent WHEN NEW.id = '2:1' BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
  store.enqueue(["1:1", "2:1"], ["group"]);
  const batch = store.pending()[0];
  assert.throws(() => store.acknowledgePart(batch.id, 1));
  assert.equal(store.alreadySent("1:1"), false);
  assert.equal(store.alreadySent("2:1"), false);
  assert.equal(store.pending()[0].nextPart, 0);
  control.exec("DROP TRIGGER fail_second");
  store.acknowledgePart(batch.id, 1);
  assert.equal(store.alreadySent("1:1"), true);
  assert.equal(store.alreadySent("2:1"), true);
  assert.deepEqual(store.pending(), []);
});

test("queues from older versions gain attempt tracking; abandoned batches leave the queue", t => {
  const dir = mkdtempSync(join(tmpdir(), "sl-notifier-attempts-test-"));
  t.after(() => {
    assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + sep));
    rmSync(dir, { recursive: true, force: true });
  });
  const path = join(dir, "state.db");
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE delivery_batches (id TEXT PRIMARY KEY, parts TEXT NOT NULL, next_part INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
    CREATE TABLE delivery_keys (deviation_key TEXT PRIMARY KEY, batch_id TEXT NOT NULL REFERENCES delivery_batches(id) ON DELETE CASCADE);
    INSERT INTO delivery_batches VALUES ('b1', '["old"]', 0, '2026-01-01T00:00:00Z');
    INSERT INTO delivery_keys VALUES ('9:1', 'b1');`);
  old.close();
  const store = new StateStore(path);
  try {
    assert.equal(store.pending()[0].id, "b1");
    assert.equal(store.recordFailure("b1", 2), false);
    assert.equal(store.isQueued("9:1"), true);
    assert.equal(store.recordFailure("b1", 2), true);
    assert.deepEqual(store.pending(), []);
    assert.equal(store.isQueued("9:1"), false);
    assert.equal(store.alreadySent("9:1"), true);
    assert.equal(store.failedCount(), 1);
    assert.equal(store.recordFailure("b1", 2), false);
    store.acknowledgePart("b1", 1);
    assert.equal(store.failedCount(), 1);
  } finally { store.close(); }
});
test("metadata values persist and can be replaced", t => {
  const store = new StateStore(":memory:"); t.after(() => store.close());
  assert.equal(store.getMeta("offset"), undefined);
  store.setMeta("offset", "5"); store.setMeta("offset", "6");
  assert.equal(store.getMeta("offset"), "6");
});
