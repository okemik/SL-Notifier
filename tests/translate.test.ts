import test from "node:test";
import assert from "node:assert/strict";
import { createTranslator, createLibreTranslateTranslator } from "../src/translate.js";
test("translation cache avoids repeat requests and expires", async () => {
  let calls = 0, time = 0;
  const translate = createTranslator({ now: () => time, request: async () => { calls++; return [[["English", "Svenska"]]]; } });
  assert.equal(await translate("Svenska"), "English");
  assert.equal(await translate("Svenska"), "English");
  assert.equal(calls, 1);
  time = 3600001; await translate("Svenska"); assert.equal(calls, 2);
});
test("oversized input and invalid responses fail without caching false translations", async () => {
  let calls = 0;
  const translate = createTranslator({ request: async () => { calls++; return { error: "unavailable" }; } });
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
