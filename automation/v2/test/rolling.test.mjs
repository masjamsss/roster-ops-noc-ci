import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { makeConfig } from "../src/defaults.mjs";
import { rollingStats } from "../src/history.mjs";
import { dayScore, fairnessOffsets } from "../src/objective.mjs";
import { parseRosterCsv } from "../src/roster-csv.mjs";

const config = makeConfig({ year: 2026, month: 10 });
const members = config.members; // Hilvani, Pavitasari (day-only), Rizky, Willy, Arman, Addin
// A full month for everyone (30 available days, 8 available weekend days):
// Addin had only 6 nights, the other men 8; weekend days worked varied.
const full = (nightDays, weekendDays) => ({ months: 1, nightDays, weekendDays, availableDays: 30, availableWeekendDays: 8 });
const stats = {
  hilvani: full(0, 4), pavitasari: full(0, 4), rizky: full(8, 3), willy: full(8, 3), arman: full(8, 6), addin: full(6, 2)
};

test("three-month offsets: whoever had fewer nights or weekends is owed more this month", () => {
  const offsets = fairnessOffsets(members, stats);
  // Half of the difference is repaid each month (damping), so one person's
  // nights don't swing month to month; day-only members are not in the rotation.
  assert.deepEqual(offsets.nights, [0, 0, -0.25, -0.25, -0.25, 0.75]);
  assert.equal(offsets.weekends[5] > 0, true, "Addin worked the fewest weekends");
  assert.equal(offsets.weekends[4] < 0, true, "Arman worked the most weekends");
  assert.deepEqual(fairnessOffsets(members, {}).nights, [0, 0, 0, 0, 0, 0], "no history: no offsets (newcomers start level)");
});

test("the month-end fairness penalty prefers giving Addin the extra nights", () => {
  const env = { publishedCount: 31, lastPublishedIndex: 30, target: 22, mode: "equal", nightOffset: fairnessOffsets(members, stats).nights };
  const lastDay = { date: "2026-10-31", dayIndex: 30, isWeekend: true, isSpecial: true, published: true };
  const state = (nights) => ({ workCount: 20, excusedCount: 0, availableDays: 31, weekendWorkCount: 5, nightCount: nights, s1Count: 10, s2Count: 10 });
  const codes = ["1", "2", "H", "H", "H", "3"];
  const armanExtra = [state(0), state(0), state(8), state(8), state(9), state(6)];
  const addinExtra = [state(0), state(0), state(8), state(8), state(7), state(8)];
  assert.ok(dayScore(codes, lastDay, addinExtra, members, config, env) < dayScore(codes, lastDay, armanExtra, members, config, env));
});

test("leave creates no night or weekend debt: offsets are measured per available day", () => {
  // Addin was on leave 16 of 30 days: 6 nights in 14 available days is more than
  // his share, and 1 of his 2 available weekend days is the team's usual rate.
  const withLeave = { ...stats, addin: { months: 1, nightDays: 6, weekendDays: 1, availableDays: 14, availableWeekendDays: 2 } };
  const offsets = fairnessOffsets(members, withLeave);
  assert.ok(offsets.nights[5] < -0.9, `Addin gets fewer nights now, got ${offsets.nights[5]}`);
  assert.ok(offsets.nights.slice(2, 5).every((value) => value > 0), "the men who covered for him are owed relief");
  assert.ok(Math.abs(offsets.weekends[5]) < 0.5, `no weekend debt for Addin, got ${offsets.weekends[5]}`);
});

test("available days come from the real codes: leave, training and inactive days are not available", () => {
  const september = parseRosterCsv(readFileSync(new URL("./fixtures/september-2026.csv", import.meta.url), "utf8"));
  const result = rollingStats([{ key: "2026-09", dates: september.dates, codesById: september.codesById }], september.memberIds, ["1", "2", "3"]);
  assert.equal(result.addin.availableDays, 14, "30 days minus 16 days of cuti");
  assert.equal(result.addin.availableWeekendDays, 2, "only 26-27 Sep");
  assert.equal(result.rizky.availableDays, 30);
  assert.equal(result.rizky.availableWeekendDays, 8);
});

test("a big difference is repaid gradually: at most 2 nights or weekend days per month", () => {
  const heavy = { ...stats, arman: full(16, 6), addin: full(2, 2) };
  const offsets = fairnessOffsets(members, heavy);
  assert.equal(offsets.nights[4], -2, "Arman did 16 of 34 nights: capped relief of 2");
  assert.equal(offsets.nights[5], 2, "Addin did 2: capped extra of 2");
});

test("3-night blocks are counted per month, in the month of their third night (a block may continue from the month before)", () => {
  const sep = { key: "2026-09", dates: ["2026-09-28", "2026-09-29", "2026-09-30"], codesById: { arman: ["H", "3", "3"], addin: ["3", "3", "3"] } };
  const oct = { key: "2026-10", dates: ["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"], codesById: { arman: ["3", "H", "H", "1"], addin: ["H", "H", "3", "3"] } };
  const result = rollingStats([oct, sep], ["arman", "addin"], ["1", "2", "3"]);
  assert.deepEqual(result.arman.perMonth.map((item) => [item.key, item.longNightBlocks]), [["2026-09", 0], ["2026-10", 1]]);
  assert.equal(result.addin.longNightBlocks, 1);
});

test("whoever had fewer 3-night blocks per available day is owed more of them", () => {
  const withLong = Object.fromEntries(Object.entries(stats).map(([id, item]) => [id, { ...item, longNightBlocks: { rizky: 2, willy: 2, arman: 2, addin: 0 }[id] ?? 0 }]));
  const offsets = fairnessOffsets(members, withLong);
  assert.ok(offsets.longBlocks[5] > 0.5, `Addin is owed long blocks, got ${offsets.longBlocks[5]}`);
  assert.ok(offsets.longBlocks.slice(2, 5).every((value) => value < 0));
  assert.deepEqual(offsets.longBlocks.slice(0, 2), [0, 0], "day-only members are not in the rotation");
  const env = { publishedCount: 31, lastPublishedIndex: 30, target: 22, mode: "equal", longBlockOffset: offsets.longBlocks };
  const lastDay = { date: "2026-10-31", dayIndex: 30, isWeekend: true, isSpecial: true, published: true };
  const state = (long) => ({ workCount: 20, excusedCount: 0, availableDays: 31, weekendWorkCount: 5, nightCount: 8, s1Count: 10, s2Count: 10, longNightBlocks: long });
  const codes = ["1", "2", "H", "H", "H", "3"];
  const addinTwo = [state(0), state(0), state(1), state(1), state(1), state(2)];
  const armanTwo = [state(0), state(0), state(1), state(1), state(2), state(1)];
  assert.ok(dayScore(codes, lastDay, addinTwo, members, config, env) < dayScore(codes, lastDay, armanTwo, members, config, env), "this month's extra long block goes to Addin");
});
