import assert from "node:assert/strict";
import test from "node:test";
import { buildDays } from "../src/days.mjs";
import { DEFAULT_RULES, DEFAULT_TEAM, makeConfig } from "../src/defaults.mjs";
import { dayScore, makeEnv } from "../src/objective.mjs";

const config = makeConfig({ year: 2026, month: 10 });
const env = { publishedCount: 31, lastPublishedIndex: 30, target: 22 };
const states = config.members.map(() => ({ workCount: 0, availableDays: 0, weekendWorkCount: 0, nightCount: 0, s1Count: 0, s2Count: 0 }));
// Member order: Hana (P), Putri (P), Rudi, Wawan, Ardi, Agus. All patterns are 2-2-1.
const womanOnS1 = ["1", "2", "1", "2", "3", "H"];
const menOnS1 = ["2", "2", "1", "1", "3", "H"];
const friday = { date: "2026-10-16", dayIndex: 15, isWeekend: false, isSpecial: false, published: true };
const thursday = { ...friday, date: "2026-10-15", dayIndex: 14 };

test("Friday Shift 1 without a female agent costs a penalty (Friday prayer coverage)", () => {
  const penalty = dayScore(menOnS1, friday, states, config.members, config, env) - dayScore(womanOnS1, friday, states, config.members, config, env);
  assert.equal(penalty, config.weights.fridayShift1WithoutFemale);
  assert.ok(penalty > config.weights.weekdayShortPerPerson, "stronger than one missing weekday person");
});

test("other days and a disabled rule carry no Friday penalty", () => {
  assert.equal(dayScore(menOnS1, thursday, states, config.members, config, env), dayScore(womanOnS1, thursday, states, config.members, config, env));
  const off = makeConfig({ year: 2026, month: 10, rules: { ...DEFAULT_RULES, fridayShift1Female: false } });
  assert.equal(dayScore(menOnS1, friday, states, off.members, off, env), dayScore(womanOnS1, friday, states, off.members, off, env));
});

test("fixed target: falling behind the monthly pace costs a daily penalty, so the search keeps people on pace", () => {
  const fixed = makeConfig({ year: 2026, month: 10, rules: { ...DEFAULT_RULES, workDaysTarget: 22 }, weights: { workloadSpreadDaily: 0 } });
  const fixedEnv = { publishedCount: 31, lastPublishedIndex: 30, mode: "fixed", target: 22, memberTargets: fixed.members.map(() => ({ target: 22, base: 22, activeDays: 31, excused: 0, rosterable: 31 })) };
  // Thursday 15 Oct = day index 14, so 15 days have passed; everyone else is on pace (10 days).
  const at = (work) => fixed.members.map((_, index) => ({ workCount: index === 0 ? work : 10, availableDays: 15, excusedCount: 0, weekendWorkCount: 0, nightCount: 0, s1Count: 0, s2Count: 0 }));
  const onPace = dayScore(womanOnS1, thursday, at(10), fixed.members, fixed, fixedEnv);
  const behind = dayScore(womanOnS1, thursday, at(7), fixed.members, fixed, fixedEnv);
  // Pace after 15 of 31 days is 22 × 15/31 ≈ 10.6, with 1.5 days of slack for a 5-on-2-off rhythm.
  assert.ok(fixed.weights.underWorkDaysTargetDaily > 0);
  assert.ok(Math.abs(behind - onPace - fixed.weights.underWorkDaysTargetDaily * ((22 * 15) / 31 - 1.5 - 7)) < 1e-9);
});

test("automatic target: the month's ideal work shared evenly, at most 5 workdays per week", () => {
  const target = (year, month, team = DEFAULT_TEAM) => {
    const config = makeConfig({ year, month, team });
    const { days } = buildDays(config, [{ year, days: [] }]);
    const env = makeEnv(config, days, config.members, days.map(() => ({})));
    assert.equal(env.mode, "fixed", "over and under the target are both penalized");
    return Math.round(env.memberTargets[0].target);
  };
  // October 2026: (22 weekdays × 2-2-1 + 9 weekend days × 1-1-1) / 6 people = 22.8, capped at 31 × 5/7.
  assert.equal(target(2026, 10), 22);
  assert.equal(target(2026, 11), 21, "a 30-day month: at most 21");
  assert.equal(target(2027, 2), 20, "February: at most 20");
  const eight = [...DEFAULT_TEAM, { id: "budi", name: "Budi", eligibleShifts: ["1", "2", "3"] }, { id: "citra", name: "Citra", gender: "P", eligibleShifts: ["1", "2"] }];
  assert.equal(target(2026, 10, eight), 17, "a bigger team shares the same work (137 / 8), nobody is pushed to 22");
});

test("Dispensasi Shift 3: the month's night share counts only the days someone could do nights (user, 28 Oct)", () => {
  const november = makeConfig({ year: 2026, month: 11 });
  const { days } = buildDays(november, [{ year: 2026, days: [] }]);
  const none = days.map(() => ({}));
  const dispensation = days.map((day) => (day.published && day.date >= "2026-11-16" ? { rudi: new Set(["3"]) } : {}));
  const excused = makeEnv(november, days, november.members, none, dispensation);
  const plain = makeEnv(november, days, november.members, none);
  const rudi = november.members.findIndex((member) => member.id === "rudi");
  assert.equal(excused.memberTargets[rudi].nightRosterable, 15);
  assert.equal(excused.memberTargets[rudi].rosterable, 30, "his workday target is unchanged: he still works day shifts");
  assert.equal(plain.memberTargets[rudi].nightRosterable, 30);
  // Last day of the month: Rudi did 4 nights (his share of 15 days) or 8 (a whole month's share).
  const last = days.filter((day) => day.published).at(-1);
  const others = { 4: [9, 9, 8], 8: [7, 7, 8] };
  const end = (rudiNights) => {
    const men = [rudiNights, ...others[rudiNights]];
    return november.members.map((member, index) => ({
      workCount: 21, excusedCount: 0, availableDays: 30, nightAvailableDays: member.id === "rudi" ? 15 : 30, weekendWorkCount: 5,
      nightCount: member.dayOnly ? 0 : men[index - 2], s1Count: 0, s2Count: 0, longNightBlocks: 0
    }));
  };
  const codes = ["1", "2", "1", "H", "3", "H"];
  const score = (env, nights) => dayScore(codes, last, end(nights), november.members, november, env);
  assert.ok(score(excused, 4) < score(excused, 8), "Dispensasi: 4 nights is his full share");
  assert.ok(score(plain, 8) < score(plain, 4), "Hindari: the month still evens out his nights");
});

// Night workers' Shift 1 / Shift 2 (user, 28 Oct): each person's Shift 2 days are
// compared with the group's share of Shift 2 among its Shift 1+2 days.
const lastDay = { date: "2026-10-31", dayIndex: 30, isWeekend: true, isSpecial: true, published: true };
const atEnd = (split) => config.members.map((member, index) => ({
  workCount: 20, availableDays: 31, excusedCount: 0, weekendWorkCount: 6, nightCount: member.dayOnly ? 0 : 8, longNightBlocks: 0,
  s1Count: member.dayOnly ? 10 : split[index - 2][0], s2Count: member.dayOnly ? 10 : split[index - 2][1]
}));
const UNEVEN = [[10, 1], [7, 4], [8, 4], [6, 7]]; // November 2026 as generated on 21 Oct
const EVEN = [[8, 3], [7, 4], [8, 4], [8, 5]];
const sameCodes = ["1", "2", "H", "H", "3", "H"];

test("night workers: an uneven Shift 1 / Shift 2 split costs a penalty at the end of the month, a fair one costs nothing", () => {
  const strict = makeConfig({ year: 2026, month: 10, weights: { nightWorkerDayShiftDaily: 0 } });
  const score = (split) => dayScore(sameCodes, lastDay, atEnd(split), strict.members, strict, env);
  assert.ok(strict.weights.nightWorkerDayShiftFinal > 0);
  // 16 of 47 day shifts are Shift 2. Rudi: 1 instead of 11 × 16/47, Agus: 7 instead of 13 × 16/47; 1 day of slack each.
  const expected = strict.weights.nightWorkerDayShiftFinal * ((11 * 16) / 47 - 1 - 1 + (7 - (13 * 16) / 47 - 1));
  assert.ok(Math.abs(score(UNEVEN) - score(EVEN) - expected) < 1e-9, `${score(UNEVEN) - score(EVEN)} vs ${expected}`);
  const off = makeConfig({ year: 2026, month: 10, rules: { ...DEFAULT_RULES, balanceNightWorkerDayShifts: false } });
  assert.equal(dayScore(sameCodes, lastDay, atEnd(UNEVEN), off.members, off, env), dayScore(sameCodes, lastDay, atEnd(EVEN), off.members, off, env), "switched off in the Aturan sheet");
});

test("night workers: the split is also steered day by day, with 2 days of slack between the most and least Shift 2", () => {
  const steady = makeConfig({ year: 2026, month: 10, weights: { nightWorkerDayShiftFinal: 0 } });
  const score = (split) => dayScore(sameCodes, thursday, atEnd(split), steady.members, steady, env);
  assert.ok(steady.weights.nightWorkerDayShiftDaily > 0);
  const deviations = (split) => split.map(([s1, s2]) => s2 - ((s1 + s2) * 16) / 47);
  const gap = Math.max(...deviations(UNEVEN)) - Math.min(...deviations(UNEVEN));
  assert.ok(Math.max(...deviations(EVEN)) - Math.min(...deviations(EVEN)) <= 2, "the fair split is within the slack");
  assert.ok(Math.abs(score(UNEVEN) - score(EVEN) - steady.weights.nightWorkerDayShiftDaily * (gap - 2)) < 1e-9);
});
