import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { makeConfig } from "../src/defaults.mjs";
import { dispensationDates, rollingStats } from "../src/history.mjs";
import { dayScore, fairnessOffsets } from "../src/objective.mjs";
import { parseRosterCsv } from "../src/roster-csv.mjs";

const config = makeConfig({ year: 2026, month: 10 });
const members = config.members; // Hana, Putri (day-only), Rudi, Wawan, Ardi, Agus
// A full month for everyone (30 available days, 8 available weekend days):
// Agus had only 6 nights, the other men 8; weekend days worked varied.
const full = (nightDays, weekendDays) => ({ months: 1, nightDays, weekendDays, availableDays: 30, availableWeekendDays: 8 });
const stats = {
  hana: full(0, 4), putri: full(0, 4), rudi: full(8, 3), wawan: full(8, 3), ardi: full(8, 6), agus: full(6, 2)
};

test("three-month offsets: whoever had fewer nights or weekends is owed more this month", () => {
  const offsets = fairnessOffsets(members, stats);
  // Half of the difference is repaid each month (damping), so one person's
  // nights don't swing month to month; day-only members are not in the rotation.
  assert.deepEqual(offsets.nights, [0, 0, -0.25, -0.25, -0.25, 0.75]);
  assert.equal(offsets.weekends[5] > 0, true, "Agus worked the fewest weekends");
  assert.equal(offsets.weekends[4] < 0, true, "Ardi worked the most weekends");
  assert.deepEqual(fairnessOffsets(members, {}).nights, [0, 0, 0, 0, 0, 0], "no history: no offsets (newcomers start level)");
});

test("the month-end fairness penalty prefers giving Agus the extra nights", () => {
  const env = { publishedCount: 31, lastPublishedIndex: 30, target: 22, mode: "equal", nightOffset: fairnessOffsets(members, stats).nights };
  const lastDay = { date: "2026-10-31", dayIndex: 30, isWeekend: true, isSpecial: true, published: true };
  const state = (nights) => ({ workCount: 20, excusedCount: 0, availableDays: 31, weekendWorkCount: 5, nightCount: nights, s1Count: 10, s2Count: 10 });
  const codes = ["1", "2", "H", "H", "H", "3"];
  const ardiExtra = [state(0), state(0), state(8), state(8), state(9), state(6)];
  const agusExtra = [state(0), state(0), state(8), state(8), state(7), state(8)];
  assert.ok(dayScore(codes, lastDay, agusExtra, members, config, env) < dayScore(codes, lastDay, ardiExtra, members, config, env));
});

test("leave creates no night or weekend debt: offsets are measured per available day", () => {
  // Agus was on leave 16 of 30 days: 6 nights in 14 available days is more than
  // his share, and 1 of his 2 available weekend days is the team's usual rate.
  const withLeave = { ...stats, agus: { months: 1, nightDays: 6, weekendDays: 1, availableDays: 14, availableWeekendDays: 2 } };
  const offsets = fairnessOffsets(members, withLeave);
  assert.ok(offsets.nights[5] < -0.9, `Agus gets fewer nights now, got ${offsets.nights[5]}`);
  assert.ok(offsets.nights.slice(2, 5).every((value) => value > 0), "the men who covered for him are owed relief");
  assert.ok(Math.abs(offsets.weekends[5]) < 0.5, `no weekend debt for Agus, got ${offsets.weekends[5]}`);
});

test("available days come from the real codes: leave, training and inactive days are not available", () => {
  const september = parseRosterCsv(readFileSync(new URL("./fixtures/september-2026.csv", import.meta.url), "utf8"));
  const result = rollingStats([{ key: "2026-09", dates: september.dates, codesById: september.codesById }], september.memberIds, ["1", "2", "3"]);
  assert.equal(result.agus.availableDays, 14, "30 days minus 16 days of cuti");
  assert.equal(result.agus.availableWeekendDays, 2, "only 26-27 Sep");
  assert.equal(result.rudi.availableDays, 30);
  assert.equal(result.rudi.availableWeekendDays, 8);
});

test("a big difference is repaid gradually: at most 2 nights or weekend days per month", () => {
  const heavy = { ...stats, ardi: full(16, 6), agus: full(2, 2) };
  const offsets = fairnessOffsets(members, heavy);
  assert.equal(offsets.nights[4], -2, "Ardi did 16 of 34 nights: capped relief of 2");
  assert.equal(offsets.nights[5], 2, "Agus did 2: capped extra of 2");
});

test("3-night blocks are counted per month, in the month of their third night (a block may continue from the month before)", () => {
  const sep = { key: "2026-09", dates: ["2026-09-28", "2026-09-29", "2026-09-30"], codesById: { ardi: ["H", "3", "3"], agus: ["3", "3", "3"] } };
  const oct = { key: "2026-10", dates: ["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"], codesById: { ardi: ["3", "H", "H", "1"], agus: ["H", "H", "3", "3"] } };
  const result = rollingStats([oct, sep], ["ardi", "agus"], ["1", "2", "3"]);
  assert.deepEqual(result.ardi.perMonth.map((item) => [item.key, item.longNightBlocks]), [["2026-09", 0], ["2026-10", 1]]);
  assert.equal(result.agus.longNightBlocks, 1);
});

test("whoever had fewer 3-night blocks per available day is owed more of them", () => {
  const withLong = Object.fromEntries(Object.entries(stats).map(([id, item]) => [id, { ...item, longNightBlocks: { rudi: 2, wawan: 2, ardi: 2, agus: 0 }[id] ?? 0 }]));
  const offsets = fairnessOffsets(members, withLong);
  assert.ok(offsets.longBlocks[5] > 0.5, `Agus is owed long blocks, got ${offsets.longBlocks[5]}`);
  assert.ok(offsets.longBlocks.slice(2, 5).every((value) => value < 0));
  assert.deepEqual(offsets.longBlocks.slice(0, 2), [0, 0], "day-only members are not in the rotation");
  const env = { publishedCount: 31, lastPublishedIndex: 30, target: 22, mode: "equal", longBlockOffset: offsets.longBlocks };
  const lastDay = { date: "2026-10-31", dayIndex: 30, isWeekend: true, isSpecial: true, published: true };
  const state = (long) => ({ workCount: 20, excusedCount: 0, availableDays: 31, weekendWorkCount: 5, nightCount: 8, s1Count: 10, s2Count: 10, longNightBlocks: long });
  const codes = ["1", "2", "H", "H", "H", "3"];
  const agusTwo = [state(0), state(0), state(1), state(1), state(1), state(2)];
  const ardiTwo = [state(0), state(0), state(1), state(1), state(2), state(1)];
  assert.ok(dayScore(codes, lastDay, agusTwo, members, config, env) < dayScore(codes, lastDay, ardiTwo, members, config, env), "this month's extra long block goes to Agus");
});

test("Dispensasi Shift 3 creates no night debt; Hindari Shift 3 does (user, 28 Oct)", () => {
  const dates = Array.from({ length: 30 }, (_, i) => `2026-09-${String(i + 1).padStart(2, "0")}`);
  const row = (nights) => dates.map((_, i) => (nights.includes(i) ? "3" : "1"));
  // Rudi: 5 nights in 1-15 Sep, none 16-30 Sep; the other men 10 nights each.
  const codesById = {
    hana: row([]), putri: row([]), rudi: row([0, 1, 6, 7, 12]),
    wawan: row([0, 3, 6, 9, 12, 15, 18, 21, 24, 27]), ardi: row([1, 4, 7, 10, 13, 16, 19, 22, 25, 28]), agus: row([2, 5, 8, 11, 14, 17, 20, 23, 26, 29])
  };
  const ids = Object.keys(codesById);
  const months = [{ key: "2026-09", dates, codesById }];
  const excused = rollingStats(months, ids, ["1", "2", "3"], "3", 3, { noNight: { rudi: new Set(dates.slice(15)) } });
  assert.equal(excused.rudi.availableDays, 30, "he still worked day shifts: available for the roster");
  assert.equal(excused.rudi.nightAvailableDays, 15, "but not for nights on the dispensation days");
  assert.equal(excused.wawan.nightAvailableDays, 30);
  const rudi = members.findIndex((member) => member.id === "rudi");
  assert.ok(Math.abs(fairnessOffsets(members, excused).nights[rudi]) < 0.01, "5 nights in 15 nights-available days is his full share: nothing to make up");
  const owed = fairnessOffsets(members, rollingStats(months, ids, ["1", "2", "3"])).nights[rudi];
  assert.ok(owed > 1.5, `with Hindari the same month is a debt of almost 2 nights, got ${owed}`);
});

test("dispensationDates: the excused days per person for one shift, from requests", () => {
  const requests = [
    { memberId: "rudi", from: "2026-11-16", to: "2026-11-18", code: "!3", dispensation: true },
    { memberId: "rudi", from: "2026-11-20", to: "2026-11-20", code: "!13", dispensation: true },
    { memberId: "wawan", from: "2026-11-16", to: "2026-11-30", code: "!3" }
  ];
  assert.deepEqual(Object.fromEntries(Object.entries(dispensationDates(requests, "3")).map(([id, set]) => [id, [...set]])), { rudi: ["2026-11-16", "2026-11-17", "2026-11-18", "2026-11-20"] });
  assert.deepEqual(dispensationDates(requests, "2"), {});
});
