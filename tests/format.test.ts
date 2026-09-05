import test from "node:test";
import assert from "node:assert/strict";
import { prepareDeviation, buildMessageBatches, splitMessage } from "../src/format.js";
import { deviation } from "./fixtures.js";
const options = { preferredLang: "sv", transportMode: "METRO", timeZone: "Europe/Stockholm", translate: false };

test("actual lines and modes are used without hardcoded Green Line or fabricated criticality", async () => {
  const metro = await prepareDeviation(deviation(1, "Entrance maintenance", [13]), options);
  assert.match(metro.group, /Line 13/);
  assert.doesNotMatch(metro.group + metro.text, /Green|CRITICAL/);
  const train = deviation(2, "Delays", [40, 41]);
  train.scope!.lines!.forEach(line => line.transport_mode = "TRAIN");
  const formatted = await prepareDeviation(train, options);
  assert.match(formatted.group, /TRAIN.*40, 41/);
});
test("English-only data and failed translation are not labelled as another language", async () => {
  const english = deviation();
  english.message_variants = [english.message_variants[1]];
  const en = await prepareDeviation(english, options);
  assert.match(en.text, /Message \(EN\)/); assert.doesNotMatch(en.text, /Original \(SV\)/);
  const swedish = deviation(); swedish.message_variants.pop();
  const sv = await prepareDeviation(swedish, {
    ...options, translate: true, translator: async () => { throw new Error("secret transport payload"); },
  });
  assert.match(sv.text, /translation unavailable/);
  assert.match(sv.text, /Original \(SV\)/);
  assert.doesNotMatch(sv.text, /Translation \(EN\)|secret transport payload/);
});
test("preferred available language is respected and valid dates use configured timezone", async () => {
  const d = deviation();
  d.message_variants.push({ language: "de", header: "Hinweis", details: "Verspätung" });
  d.publish = { upto: "2026-09-05T10:00:00Z" };
  const formatted = await prepareDeviation(d, { ...options, preferredLang: "de" });
  assert.match(formatted.text, /Original \(DE\)/);
  assert.match(formatted.text, /12:00 \(Europe\/Stockholm\)/);
});
test("long Unicode messages split safely and do not swallow a later short record", async () => {
  const long = await prepareDeviation(deviation(1, "🚇".repeat(3500)), options);
  const short = await prepareDeviation(deviation(2), options);
  const batches = buildMessageBatches([long, short]);
  assert.equal(batches.length, 2);
  assert.deepEqual(batches[0].keys, ["1:1"]); assert.deepEqual(batches[1].keys, ["2:1"]);
  assert.ok(batches[0].parts.length > 1);
  for (const batch of batches) for (const part of batch.parts) {
    assert.ok(part.length <= 4096);
    assert.ok(part.isWellFormed());
    assert.ok(part.trim().length > 0);
  }
  const text = "x".repeat(4095) + "🚆" + "\n" + "ü".repeat(4200);
  assert.equal(splitMessage(text).join(""), text);
});
test("short messages remain grouped and sorted by SL importance", async () => {
  const first = await prepareDeviation(deviation(1), options);
  const second = await prepareDeviation(deviation(2), options);
  first.importance = 9; second.importance = 1;
  const batches = buildMessageBatches([first, second]);
  assert.equal(batches.length, 1);
  assert.deepEqual(batches[0].keys, ["2:1", "1:1"]);
  assert.ok(batches[0].parts[0].indexOf("ID: 2") < batches[0].parts[0].indexOf("ID: 1"));
});


test("whitespace-heavy details never generate a blank Telegram part", async () => {
  const item = await prepareDeviation(deviation(1, "Start" + "\n".repeat(9000) + "End"), options);
  const batches = buildMessageBatches([item]);
  assert.ok(batches[0].parts.every(part => part.trim().length > 0 && part.length <= 4096));
  assert.match(batches[0].parts.join(""), /Start/);
  assert.match(batches[0].parts.join(""), /End/);
});
