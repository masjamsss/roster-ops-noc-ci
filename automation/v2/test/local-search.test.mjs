import assert from "node:assert/strict";
import test from "node:test";
import { makeConfig } from "../src/defaults.mjs";
import { prepareMonth } from "../src/engine.mjs";
import { improveBySwaps } from "../src/local-search.mjs";
import { scoreSchedule } from "../src/objective.mjs";
import { runVariant } from "../src/variant-run.mjs";

const TEAM = [
  { id: "ani", name: "Ani", eligibleShifts: ["1", "2"] },
  { id: "bela", name: "Bela", eligibleShifts: ["1", "2"] },
  { id: "cahyo", name: "Cahyo", eligibleShifts: ["1", "2", "3"] },
  { id: "dodi", name: "Dodi", eligibleShifts: ["1", "2", "3"] },
  { id: "eko", name: "Eko", eligibleShifts: ["1", "2", "3"] }
];
const noHolidays = (year) => [{ year, days: [], status: "official-verified" }];
const emptyHistory = { key: "2027-01", dates: [], codesById: {}, source: "none" };

test("polishing can change one person's day, not only swap, and recovers from a missing worker", () => {
  const config = makeConfig({ year: 2027, month: 2, team: TEAM, search: { beamWidth: 600 } });
  const { input } = prepareMonth({ config, calendars: noHolidays(2027), history: emptyHistory });
  const { members, days, fixed, initialStates, ctx, env } = input;
  const codes = runVariant(input, {}, () => {}).codes;
  const score = (rows) => scoreSchedule({ codes: rows, members, days, initialStates, ctx, config, fixed, env });
  // Send one of two Shift 1 people home on a weekday, keeping every hard rule.
  let damaged = null;
  for (const day of days.filter((item) => item.published && !item.isSpecial)) {
    const d = day.dayIndex;
    if (codes.filter((row) => row[d] === "1").length < 2) continue;
    for (let i = 0; i < members.length && !damaged; i += 1) {
      if (codes[i][d] !== "1" || fixed[d][members[i].id] !== undefined) continue;
      const trial = codes.map((row) => row.slice());
      trial[i][d] = "H";
      if (score(trial).valid) damaged = { rows: trial, d };
    }
    if (damaged) break;
  }
  assert.ok(damaged, "a weekday with two people on Shift 1");
  assert.ok(score(damaged.rows).total > score(codes).total, "one person fewer is worse");
  const polished = improveBySwaps({ codes: damaged.rows, members, days, fixed, initialStates, ctx, config, env });
  // Swaps keep every day's counts; only a single-day change can make up for the
  // missing person (by putting them back, or by a better change elsewhere).
  assert.ok(polished.log.some((entry) => entry.change), JSON.stringify(polished.log));
  assert.ok(score(polished.codes).total <= score(codes).total + 1e-6, "at least as good as before the damage");
});
