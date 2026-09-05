import test from "node:test";
import assert from "node:assert/strict";
import { parseDeviationResult } from "../src/sl.js";
import { SLResponseError } from "../src/errors.js";
import { deviation } from "./fixtures.js";
test("unexpected envelopes and wholly invalid records fail instead of pretending there are no alerts", () => {
  for (const data of [{ error: "outage" }, null, "html", [{ version: 1 }]]) {
    assert.throws(() => parseDeviationResult(data), SLResponseError);
  }
  assert.deepEqual(parseDeviationResult([]), { deviations: [], rejectedCount: 0 });
});
test("malformed records are counted while healthy records can still be delivered", () => {
  const result = parseDeviationResult([deviation(), { ...deviation(2), message_variants: null }]);
  assert.equal(result.rejectedCount, 1);
  assert.equal(result.deviations.length, 1);
});
test("nested fields consumed by formatting are validated", () => {
  for (const patch of [
    { scope: { lines: [{ id: 17, designation: 17 }] } },
    { priority: { importance_level: "critical" } },
    { publish: { upto: {} } },
    { message_variants: [{ header: "H", details: {}, language: "sv" }] },
  ]) assert.throws(() => parseDeviationResult([{ ...deviation(), ...patch }]), SLResponseError);
});
