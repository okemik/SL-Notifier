import test from "node:test";
import assert from "node:assert/strict";
import { createTranslator, createDefaultRequest, createLibreTranslateTranslator } from "../src/translate.js";
test("translation cache avoids repeat requests and expires", async () => {
  let calls = 0, time = 0;
  const translate = createTranslator({ now: () => time, request: async () => { calls++; return "English"; } });
  assert.equal(await translate("Svenska"), "English");
  assert.equal(await translate("Svenska"), "English");
  assert.equal(calls, 1);
  time = 3600001; await translate("Svenska"); assert.equal(calls, 2);
});
test("oversized input and invalid responses fail without caching false translations", async () => {
  let calls = 0;
  const translate = createTranslator({ request: async () => { calls++; return ""; } });
  await assert.rejects(translate("x".repeat(4001))); assert.equal(calls, 0);
  await assert.rejects(translate("Hej")); assert.equal(calls, 1);
  await assert.rejects(translate("Hej")); assert.equal(calls, 2);
});

test("LibreTranslate translator caches and expires translations", async () => {
  let calls = 0, time = 0;
  const translate = createLibreTranslateTranslator({ now: () => time, request: async () => { calls++; return "English"; } });
  assert.equal(await translate("Svenska"), "English");
  assert.equal(await translate("Svenska"), "English");
  assert.equal(calls, 1);
  time = 3600001; await translate("Svenska"); assert.equal(calls, 2);
});
test("LibreTranslate translator rejects oversized input and empty responses without caching", async () => {
  let calls = 0;
  const translate = createLibreTranslateTranslator({ request: async () => { calls++; return "  "; } });
  await assert.rejects(translate("x".repeat(4001))); assert.equal(calls, 0);
  await assert.rejects(translate("Hej")); assert.equal(calls, 1);
  await assert.rejects(translate("Hej")); assert.equal(calls, 2);
});

test("default chain prefers Google without touching MyMemory", async () => {
  let memoryCalls = 0;
  const chain = createDefaultRequest({
    google: async text => `google:${text}`,
    memory: async () => { memoryCalls++; return "unused"; },
  });
  assert.equal(await chain("Hej"), "google:Hej");
  assert.equal(memoryCalls, 0);
});
test("default chain falls back to MyMemory when Google fails and honours aborts", async () => {
  let memoryCalls = 0;
  const chain = createDefaultRequest({
    google: async () => { throw new Error("blocked"); },
    memory: async text => { memoryCalls++; return `memory:${text}`; },
  });
  assert.equal(await chain("Hej"), "memory:Hej");
  assert.equal(memoryCalls, 1);
  const controller = new AbortController();
  controller.abort();
  const aborting = createDefaultRequest({
    google: async (_text, signal) => { if (signal?.aborted) throw new Error("cancelled"); return "never"; },
    memory: async () => { memoryCalls++; return "must not run"; },
  });
  await assert.rejects(aborting("Hej", controller.signal));
  assert.equal(memoryCalls, 1);
});
