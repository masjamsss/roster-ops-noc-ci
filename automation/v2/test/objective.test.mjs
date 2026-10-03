import assert from "node:assert/strict";
import test from "node:test";
import { buildDays } from "../src/days.mjs";
import { DEFAULT_RULES, DEFAULT_TEAM, makeConfig } from "../src/defaults.mjs";
import { dayScore, makeEnv } from "../src/objective.mjs";

const config = makeConfig({ year: 2026, month: 10 });
const env = { publishedCount: 31, lastPublishedIndex: 30, target: 22 };
const states = config.members.map(() => ({ workCount: 0, availableDays: 0, weekendWorkCount: 0, nightCount: 0, s1Count: 0, s2Count: 0 }));
// Member order: Hilvani (P), Pavitasari (P), Rizky, Willy, Arman, Addin. All patterns are 2-2-1.
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
