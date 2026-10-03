import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_COVERAGE, DEFAULT_WEIGHTS } from "../src/defaults.mjs";
import { dayStatus, staffingPenalty } from "../src/staffing.mjs";

const ids = ["1", "2", "3"];
const counts = (s1, s2, s3) => ({ 1: s1, 2: s2, 3: s3 });

test("weekday status: 2-2-1 IDEAL, 2-1-1 and 1-2-1 CUKUP, only 1-1-1 MINIMAL", () => {
  assert.equal(dayStatus(counts(2, 2, 1), false, DEFAULT_COVERAGE, ids), "IDEAL");
  assert.equal(dayStatus(counts(3, 2, 1), false, DEFAULT_COVERAGE, ids), "IDEAL");
  assert.equal(dayStatus(counts(2, 1, 1), false, DEFAULT_COVERAGE, ids), "CUKUP");
  assert.equal(dayStatus(counts(1, 2, 1), false, DEFAULT_COVERAGE, ids), "CUKUP");
  assert.equal(dayStatus(counts(1, 1, 1), false, DEFAULT_COVERAGE, ids), "MINIMAL");
  assert.equal(dayStatus(counts(2, 0, 1), false, DEFAULT_COVERAGE, ids), "KURANG");
});

test("weekend and tanggal merah: exactly 1-1-1 is OK", () => {
  assert.equal(dayStatus(counts(1, 1, 1), true, DEFAULT_COVERAGE, ids), "OK");
  assert.equal(dayStatus(counts(2, 1, 1), true, DEFAULT_COVERAGE, ids), "LEBIH");
  assert.equal(dayStatus(counts(1, 0, 1), true, DEFAULT_COVERAGE, ids), "KURANG");
});

test("staffing penalty: 2-1-1 is cheap, 1-2-1 near-forbidden (morning traffic is higher), 1-1-1 expensive", () => {
  const penalty = (c) => staffingPenalty(c, false, DEFAULT_COVERAGE, ids, DEFAULT_WEIGHTS);
  assert.equal(penalty(counts(2, 2, 1)), 0);
  const twoOneOne = penalty(counts(2, 1, 1));
  const oneTwoOne = penalty(counts(1, 2, 1));
  const minimal = penalty(counts(1, 1, 1));
  assert.ok(twoOneOne > 0 && twoOneOne < oneTwoOne, `${twoOneOne} < ${oneTwoOne}`);
  assert.ok(minimal > 4 * twoOneOne, `1-1-1 (${minimal}) must cost far more than 2-1-1`);
  assert.equal(staffingPenalty(counts(1, 1, 1), true, DEFAULT_COVERAGE, ids, DEFAULT_WEIGHTS), 0, "weekends are exact by design");
});

test("weekdays never have fewer people on Shift 1 than on Shift 2: 2-1-1 before 1-2-1, 3-2-1 before 2-3-1", () => {
  const penalty = (c) => staffingPenalty(c, false, DEFAULT_COVERAGE, ids, DEFAULT_WEIGHTS);
  const upsideDown = DEFAULT_WEIGHTS.shift1BelowShift2;
  assert.ok(upsideDown >= 400, "far worse than any rest-comfort term");
  assert.equal(penalty(counts(1, 2, 1)) - penalty(counts(2, 1, 1)), upsideDown);
  assert.equal(penalty(counts(2, 3, 1)) - penalty(counts(3, 2, 1)), upsideDown, "a spare person goes to Shift 1 first");
  // But an extra person on Shift 2 still beats sending that person home.
  assert.ok(penalty(counts(1, 2, 1)) < penalty(counts(1, 1, 1)), "1-2-1 is still better than 1-1-1");
});
