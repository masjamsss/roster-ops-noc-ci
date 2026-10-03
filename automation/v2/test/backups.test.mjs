import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { makeConfig } from "../src/defaults.mjs";
import { generateRoster } from "../src/engine.mjs";
import { parseRosterCsv } from "../src/roster-csv.mjs";

const september = parseRosterCsv(readFileSync(new URL("./fixtures/september-2026.csv", import.meta.url), "utf8"));
const history = { key: "2026-09", dates: september.dates, codesById: september.codesById, source: "csv" };
const requests = [{ memberId: "willy", name: "Willy", from: "2026-10-12", to: "2026-10-13", code: "C", kind: "Cuti", source: "test" }];

test("Cadangan: only people on a normal day off who can step in without breaking a rule", { timeout: 120_000 }, async () => {
  const result = await generateRoster({ config: makeConfig({ year: 2026, month: 10, requests, search: { beamWidth: 1500 } }), calendars: [{ year: 2026, days: [] }], history });
  assert.equal(result.backups.length, 31 * 3, "every day and every shift");
  const byName = new Map(result.members.map((member) => [member.name, member]));
  for (const entry of result.backups) {
    for (const name of entry.names) {
      const member = byName.get(name);
      assert.equal(result.schedule[member.id][entry.date], "H", `${name} is off on ${entry.date}`);
      assert.ok(member.eligibleShifts.includes(entry.shift), `${name} may work Shift ${entry.shift}`);
    }
  }
  assert.ok(!result.backups.some((entry) => entry.names.includes("Willy") && ["2026-10-12", "2026-10-13"].includes(entry.date)), "someone on leave is never a backup");
  assert.ok(!result.backups.some((entry) => entry.shift === "3" && entry.names.some((name) => byName.get(name).dayOnly)), "day-only members never back up Shift 3");
  // Someone who just finished nights must not be offered for the next day.
  for (const block of result.nightBlocks) {
    const next = new Date(`${block.end}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    const date = next.toISOString().slice(0, 10);
    assert.ok(!result.backups.some((entry) => entry.date === date && entry.names.includes(block.name)), `${block.name} rests after nights`);
  }
  assert.ok(result.backups.some((entry) => entry.names.length > 0), "some days have a backup within all rules");
  // When nobody fits all rules, show who could step in by working a 6th day in a row (flagged, emergency only).
  const empty = result.backups.filter((entry) => entry.names.length === 0);
  assert.ok(empty.some((entry) => entry.stretched.length > 0), "emergency options are offered");
  for (const entry of result.backups) {
    for (const name of entry.stretched) {
      const member = byName.get(name);
      assert.equal(result.schedule[member.id][entry.date], "H");
      assert.ok(!entry.names.includes(name));
    }
    if (entry.shift === "3") assert.ok(entry.stretched.every((name) => !byName.get(name).dayOnly));
  }
});

test("each person's mandatory rest after Shift 3 is counted", { timeout: 120_000 }, async () => {
  const result = await generateRoster({ config: makeConfig({ year: 2026, month: 10, search: { beamWidth: 1500 } }), calendars: [{ year: 2026, days: [] }], history });
  assert.equal(result.memberSummary.hilvani.nightRecoveryDays, 0);
  for (const id of ["rizky", "willy", "arman", "addin"]) {
    const blocks = result.nightBlocks.filter((block) => block.memberId === id).length;
    const carried = id === "arman" ? 2 : 0; // 1-2 Oct rest after 29-30 Sep nights
    assert.ok(result.memberSummary[id].nightRecoveryDays >= carried + 2 * blocks - 2, `${id}: ${result.memberSummary[id].nightRecoveryDays} rest days for ${blocks} blocks`);
  }
});

test("backup plan: a second person on the shift, else overtime of at most 4 hours per side, else a replacement", { timeout: 120_000 }, async () => {
  const result = await generateRoster({ config: makeConfig({ year: 2026, month: 10, search: { beamWidth: 1500 } }), calendars: [{ year: 2026, days: [] }], history });
  assert.equal(result.backupPlan.length, 31 * 3, "every day and every shift");
  const statuses = ["aman", "lembur", "pengganti", "darurat", "kosong"];
  for (const entry of result.backupPlan) {
    assert.ok(statuses.includes(entry.status), entry.status);
    const count = result.members.filter((member) => result.schedule[member.id][entry.date] === entry.shift).length;
    assert.equal(entry.status === "aman", count >= 2, `${entry.date} Shift ${entry.shift}: ${count} people, status ${entry.status}`);
    for (const part of [entry.extension, entry.early].filter(Boolean)) assert.ok(part.hours > 0 && part.hours <= 4, JSON.stringify(part));
    if (entry.status === "lembur") assert.deepEqual(entry.uncovered, []);
    if (entry.shift === "3") {
      assert.notEqual(entry.status, "lembur", "overtime can never cover a whole night");
      assert.ok(entry.uncovered.length > 0, `${entry.date}: some night hours stay open`);
      for (const part of [entry.extension, entry.early].filter(Boolean)) {
        const member = result.members.find((item) => item.name === part.name);
        assert.ok(member.eligibleShifts.includes("3"), `${entry.date}: ${part.name} may not cover night hours`);
      }
    }
  }
  const dayShifts = result.backupPlan.filter((entry) => entry.shift !== "3" && entry.status !== "aman");
  assert.ok(dayShifts.length > 0 && dayShifts.every((entry) => entry.status === "lembur"), "a one-person day shift is always closed by overtime from both sides");
  assert.equal(result.settings.rules.overtimeHours, 4);
});
