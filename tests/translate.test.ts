import axios from "axios";
import { prepareDeviation } from "../src/format.js";
import { deviation } from "./fixtures.js";
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


test("MyMemory requests respect its UTF-8 byte limit without breaking Unicode", async t => {
  const chunks: string[] = [];
  t.mock.method(axios, "get", async (_url: string, config: { params: { q: string } }) => {
    chunks.push(config.params.q);
    return { data: { responseStatus: 200, responseData: { translatedText: "English" } } };
  });
  const translate = createDefaultRequest({ google: async () => { throw new Error("offline"); } });
  for (const input of ["å".repeat(450), "a".repeat(449) + "🚇".repeat(160), "Försening på tåget. ".repeat(80)]) {
    chunks.length = 0;
    await translate(input);
    assert.ok(chunks.length > 1);
    assert.ok(chunks.every(chunk => Buffer.byteLength(chunk, "utf8") <= 500));
    assert.ok(chunks.every(chunk => chunk.isWellFormed() && chunk.trim().length > 0));
    assert.equal(chunks.join("").replace(/\s/g, ""), input.replace(/\s/g, ""));
  }
});

for (const status of [403, 429, 500, undefined]) {
  test("MyMemory application status " + status + " is rejected and not cached", async t => {
    let failed = true, requests = 0;
    t.mock.method(axios, "get", async () => {
      requests++;
      return { data: { responseStatus: failed ? status : 200, responseData: {
        translatedText: failed ? "QUERY LENGTH LIMIT EXCEEDED" : "Recovered translation",
      } } };
    });
    const translate = createTranslator({ request: createDefaultRequest({
      google: async () => { throw new Error("offline"); },
    }) });
    await assert.rejects(translate("Svenska"));
    failed = false;
    assert.equal(await translate("Svenska"), "Recovered translation");
    assert.equal(await translate("Svenska"), "Recovered translation");
    assert.equal(requests, 2);
  });
}

test("a blank MyMemory chunk rejects the whole translation and preserves the Swedish alert", async t => {
  let requests = 0;
  t.mock.method(axios, "get", async () => ({ data: {
    responseStatus: 200, responseData: { translatedText: ++requests === 1 ? "First part" : "  " },
  } }));
  const translate = createTranslator({ request: createDefaultRequest({
    google: async () => { throw new Error("offline"); },
  }) });
  const item = deviation(1, "å".repeat(600)); item.message_variants.pop();
  const result = await prepareDeviation(item, {
    preferredLang: "sv", transportMode: "METRO", timeZone: "Europe/Stockholm", translator: translate,
  });
  assert.match(result.text, /translation unavailable/);
  assert.match(result.text, /Original \(SV\)/);
  assert.doesNotMatch(result.text, /First part/);
});

test("one LibreTranslate instance reuses translations across different alerts", async t => {
  let requests = 0;
  t.mock.method(axios, "post", async () => {
    requests++;
    return { data: { translatedText: "English alert" } };
  });
  const translator = createLibreTranslateTranslator({ endpoint: "http://translation.invalid" });
  for (const id of [1, 2]) {
    const item = deviation(id, "Samma meddelande"); item.message_variants.pop();
    const result = await prepareDeviation(item, {
      preferredLang: "sv", transportMode: "METRO", timeZone: "Europe/Stockholm", translator,
    });
    assert.match(result.text, /English alert/);
  }
  assert.equal(requests, 1);
});
