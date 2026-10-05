import assert from "node:assert/strict";
import test from "node:test";
import { workLifeBalance } from "../src/wellbeing.mjs";

// Two weeks, Thu 1 Oct - Wed 14 Oct 2026 (weekends 3-4 and 10-11 Oct).
const DATES = Array.from({ length: 14 }, (_, i) => `2026-10-${String(i + 1).padStart(2, "0")}`);
const row = (codes) => Object.fromEntries(DATES.map((date, i) => [date, codes[i]]));
const members = [
  { id: "ani", name: "Ani", dayOnly: true },
  { id: "cahyo", name: "Cahyo", dayOnly: false },
  { id: "eko", name: "Eko", dayOnly: false }
];
const days = DATES.map((date) => ({ date, isWeekend: [3, 4, 10, 11].includes(Number(date.slice(8))) }));
const summary = (overrides) => ({
  workDays: 9, workTarget: 10, shifts: { 1: 5, 2: 4, 3: 0 }, fullWeekendsOff: 2, weekendWorkDays: 0, isolatedOffDays: 0,
  hoursOverLimit: 0, weeklyHours: [{ weekStart: "2026-09-28", hours: 32 }], leaveDays: 0, sickDays: 0, trainingDays: 0, inactiveDays: 0, ...overrides
});
const schedule = {
  ani: row("1111HH1111HH22"), // calm: two full weekends off, one block type each
  cahyo: row("333HH33311H333"), // heavy: 9 nights, 3 blocks of 3 nights, a single day off on 10 Oct
  eko: row("--------------") // not in the team this fortnight
};
const memberSummary = {
  ani: summary({}),
  cahyo: summary({ workDays: 12, workTarget: 10, shifts: { 1: 2, 2: 0, 3: 9 }, fullWeekendsOff: 0, weekendWorkDays: 3, isolatedOffDays: 1, hoursOverLimit: 6, weeklyHours: [{ weekStart: "2026-10-05", hours: 46 }] }),
  eko: summary({ inactiveDays: 14, workDays: 0 })
};

test("work-life balance: 100 minus clear, named burdens; calm schedules score high", () => {
  const result = workLifeBalance({ members, days, schedule, memberSummary });
  const ani = result.members.find((item) => item.id === "ani");
  assert.ok(ani.score >= 90, `Ani ${ani.score}`);
  assert.equal(ani.level, "Baik");
  const cahyo = result.members.find((item) => item.id === "cahyo");
  const labels = cahyo.factors.map((factor) => factor.label).join(" | ");
  for (const expected of [/Shift 3: 9 malam/, /Blok 3 malam: 3/, /Tidak ada libur Sabtu–Minggu penuh/, /Hari kerja di atas target: 2/, /Jam di atas 40 per minggu: 6/, /Libur hanya 1 hari/])
    assert.match(labels, expected);
  assert.equal(cahyo.score, 100 - cahyo.factors.reduce((sum, factor) => sum + factor.points, 0));
  assert.ok(cahyo.score < ani.score);
  assert.equal(result.members.find((item) => item.id === "eko").score, null, "not scored with fewer than 10 days in the team");
  assert.equal(result.team, Math.round((ani.score + cahyo.score) / 2));
});

test("stretches and 3-night blocks continue from last month, as in the rules", () => {
  // Cahyo ended September with 3 3 (nights) and 1 1 1 (work) for Eko.
  const history = { dates: ["2026-09-29", "2026-09-30"], codesById: { ani: ["H", "H"], cahyo: ["3", "3"], eko: ["1", "1"] } };
  const rows = { ani: row("1111HH1111HH22"), cahyo: row("3HH11111HH1111"), eko: row("111HH11111HH11") };
  const sums = { ani: summary({}), cahyo: summary({ shifts: { 1: 9, 2: 0, 3: 1 } }), eko: summary({ inactiveDays: 0 }) };
  const result = workLifeBalance({ members, days, schedule: rows, memberSummary: sums, history });
  const labels = (id) => result.members.find((item) => item.id === id).factors.map((factor) => factor.label).join(" | ");
  assert.match(labels("cahyo"), /Blok 3 malam: 1/, "29-30 Sep + 1 Oct is a 3-night block, counted in October");
  assert.doesNotMatch(labels("eko"), /hari kerja/, "5 work days then 2 days off is the healthy rhythm, not a burden");
});

test("too little recovery: 5 work days (counting last month) followed by only 1 day off costs extra", () => {
  const history = { dates: ["2026-09-29", "2026-09-30"], codesById: { ani: ["H", "H"], cahyo: ["1", "1"], eko: ["H", "H"] } };
  // Cahyo: 29 Sep - 3 Oct = 5 days, H on 4 Oct, back on 5 Oct.
  const rows = { ani: row("1111HH1111HH22"), cahyo: row("111H1111HH1111"), eko: row("111HH11111HH11") };
  const sums = { ani: summary({}), cahyo: summary({}), eko: summary({}) };
  const result = workLifeBalance({ members, days, schedule: rows, memberSummary: sums, history });
  const factors = (id) => result.members.find((item) => item.id === id).factors;
  const short = factors("cahyo").find((factor) => /setelah 5 hari kerja/.test(factor.label));
  assert.ok(short, JSON.stringify(factors("cahyo")));
  assert.match(short.label, /Libur hanya 1 hari setelah 5 hari kerja: 1 kali/);
  assert.ok(!factors("eko").some((factor) => /setelah 5 hari kerja/.test(factor.label)));
});
