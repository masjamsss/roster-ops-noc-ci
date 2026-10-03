import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { makeConfig } from "../src/defaults.mjs";
import { generateRoster } from "../src/engine.mjs";
import { rollingStats } from "../src/history.mjs";
import { parseRosterCsv } from "../src/roster-csv.mjs";

const september = parseRosterCsv(readFileSync(new URL("./fixtures/september-2026.csv", import.meta.url), "utf8"));
const stats = rollingStats([{ key: "2026-09", dates: september.dates, codesById: september.codesById }], september.memberIds, ["1", "2", "3"]);
const history = { key: "2026-09", dates: september.dates, codesById: september.codesById, source: "csv", stats };

test("net hours, weeks over 40 hours and holiday hours are reported per person", { timeout: 180_000 }, async () => {
  const holidays = [{ year: 2026, days: [{ date: "2026-10-15", type: "national", name: "Uji tanggal merah" }] }];
  const result = await generateRoster({ config: makeConfig({ year: 2026, month: 10 }), calendars: holidays, history });
  for (const member of result.members) {
    const item = result.memberSummary[member.id];
    const expected = item.shifts["1"] * 8 + item.shifts["2"] * 7 + item.shifts["3"] * 9 + item.trainingDays * 8;
    assert.equal(item.netHours, expected, `${member.name} net hours (1 hour unpaid break per shift)`);
    assert.ok(Array.isArray(item.weeklyHours) && item.weeklyHours.length >= 4);
    assert.equal(item.weeksOverLimit, item.weeklyHours.filter((week) => week.hours > 40).length);
    const onHoliday = result.schedule[member.id]["2026-10-15"];
    assert.equal(item.holidayHours, { 1: 8, 2: 7, 3: 9 }[onHoliday] ?? 0);
  }
  assert.equal(result.settings.rules.weeklyHoursLimit, 40);
});

// With about 21-22 workdays (user's decision, 29 Sep 2026) and 9-hour nights some
// weeks go slightly over 40 net hours; the two-tier penalty keeps it spread out.
test("overtime stays small and spread out: no week above 44 net hours", { timeout: 180_000 }, async () => {
  const result = await generateRoster({ config: makeConfig({ year: 2026, month: 10 }), calendars: [{ year: 2026, days: [] }], history });
  const weeks = Object.values(result.memberSummary).flatMap((item) => item.weeklyHours.map((week) => week.hours));
  assert.ok(Math.max(...weeks) <= 44, `heaviest week: ${Math.max(...weeks)} h`);
  const over = Object.values(result.memberSummary).reduce((sum, item) => sum + item.hoursOverLimit, 0);
  // 12 before 30 Sep; the same shift through a work block (user's decision,
  // 30 Sep) costs a few hours: 14 in October, still no week above 44.
  assert.ok(over <= 16, `hours above 40 across the team: ${over}`);
});
