import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { DEFAULT_RULES, DEFAULT_TEAM, makeConfig } from "../src/defaults.mjs";
import { generateRoster } from "../src/engine.mjs";
import { parseRosterCsv } from "../src/roster-csv.mjs";

const september = parseRosterCsv(readFileSync(new URL("./fixtures/september-2026.csv", import.meta.url), "utf8"));
const history = { key: "2026-09", dates: september.dates, codesById: september.codesById, source: "csv" };
const calendars = [{ year: 2026, days: [] }];

test("a team too small for minimum staffing is told so before searching", async () => {
  const team = DEFAULT_TEAM.filter((member) => ["hilvani", "rizky", "willy"].includes(member.id));
  await assert.rejects(
    generateRoster({ config: makeConfig({ year: 2026, month: 10, team }), calendars, history }),
    (error) => error.name === "RosterError" && /Tim terlalu kecil/.test(error.message) && /sheet Anggota/.test(error.message)
  );
});

test("work is shared evenly and each leave, sick or training day lowers that person's target by exactly one", { timeout: 120_000 }, async () => {
  const requests = [
    { memberId: "addin", name: "Addin", from: "2026-10-19", to: "2026-10-23", code: "C", kind: "Cuti", source: "test" },
    { memberId: "willy", name: "Willy", from: "2026-10-24", to: "2026-10-25", code: "C", kind: "Cuti", source: "test" },
    { memberId: "hilvani", name: "Hilvani", from: "2026-10-13", to: "2026-10-13", code: "T", kind: "Training/Dinas", source: "test" }
  ];
  const result = await generateRoster({ config: makeConfig({ year: 2026, month: 10, requests, search: { beamWidth: 1500 } }), calendars, history });
  assert.equal(result.audit.ok, true);
  const summary = result.memberSummary;
  const target = (id) => summary[id].workTarget;
  assert.equal(target("addin"), target("rizky") - 5, "5 days of cuti: 5 fewer workdays");
  assert.equal(target("willy"), target("rizky") - 2, "a weekend of cuti still counts 1:1");
  assert.equal(target("hilvani"), target("rizky") - 1, "1 training day: 1 fewer workday");
  const responsible = Object.values(summary).map((item) => item.workDays + item.leaveDays + item.sickDays + item.trainingDays);
  assert.ok(Math.max(...responsible) - Math.min(...responsible) <= 3, `responsible days ${responsible}`);
});

test("a member joining mid-month gets a share only for the days in the team", { timeout: 120_000 }, async () => {
  const team = [...DEFAULT_TEAM, { id: "budi", name: "Budi", eligibleShifts: ["1", "2", "3"], activeFrom: "2026-10-19" }];
  const result = await generateRoster({ config: makeConfig({ year: 2026, month: 10, team, search: { beamWidth: 1500 } }), calendars, history });
  const budi = result.memberSummary.budi.workTarget;
  const full = result.memberSummary.rizky.workTarget;
  assert.ok(budi >= Math.floor((full * 13) / 31) && budi <= Math.ceil((full * 13) / 31), `Budi ${budi} vs full-month ${full}`);
  // He is not in the team yet on the 1st, so the notes do not call it "his turn".
  assert.ok(!result.notes.some((note) => /seharusnya Budi/.test(note)), result.notes.join("\n"));
});

test("Aturan option: the night workers' target follows the weekly hours limit, because a night is longer", { timeout: 300_000 }, async () => {
  const rules = { ...DEFAULT_RULES, workDaysTargetHoursCap: true };
  const result = await generateRoster({ config: makeConfig({ year: 2026, month: 10, rules, search: { beamWidth: 1500 } }), calendars, history });
  assert.equal(result.audit.ok, true);
  // 40 h x 31/7 days = 177 h; a night is 9 h net, a day shift 8 h; 31 nights / 4 men.
  assert.equal(result.memberSummary.rizky.workTarget, 21);
  assert.equal(result.memberSummary.hilvani.workTarget, 22, "day-shift people keep the normal target");
  assert.ok(result.notes.some((note) => /yang boleh Shift 3: 21 hari/.test(note)), result.notes.join("\n"));
  const normal = await generateRoster({ config: makeConfig({ year: 2026, month: 10, search: { beamWidth: 1500 } }), calendars, history });
  assert.equal(normal.memberSummary.rizky.workTarget, 22, "off by default: the same target for everyone");
});

test("a fixed target in the Aturan sheet still works: over and under are both penalized", { timeout: 120_000 }, async () => {
  const result = await generateRoster({ config: makeConfig({ year: 2026, month: 10, rules: { ...DEFAULT_RULES, workDaysTarget: 21 }, search: { beamWidth: 1500 } }), calendars, history });
  assert.equal(result.memberSummary.hilvani.workTarget, 21);
  assert.ok(result.memberSummary.hilvani.workDays <= 22);
});

test("a larger team stays fast, valid, and gets a hint to raise the ideal staffing", { timeout: 600_000 }, async () => {
  const team = [...DEFAULT_TEAM, { id: "budi", name: "Budi", eligibleShifts: ["1", "2", "3"] }, { id: "citra", name: "Citra", gender: "P", eligibleShifts: ["1", "2"] }];
  // Relative to the normal team on the same machine (a fixed 60 s failed on
  // GitHub's 2-core Windows runner). Measured on the Mac: 6 people 26 s, 8 people 23 s.
  let started = Date.now();
  await generateRoster({ config: makeConfig({ year: 2026, month: 10 }), calendars, history });
  const normal = Date.now() - started;
  started = Date.now();
  const result = await generateRoster({ config: makeConfig({ year: 2026, month: 10, team }), calendars, history });
  const larger = Date.now() - started;
  assert.ok(larger < 2 * normal + 5_000, `8 people ${larger} ms vs 6 people ${normal} ms`);
  assert.equal(result.audit.ok, true);
  assert.ok(result.notes.some((note) => /naikkan jumlah "ideal"/.test(note)));
  const newcomers = ["budi", "citra"].map((id) => result.memberSummary[id]);
  assert.ok(newcomers[0].shifts["3"] > 0, "a night-capable newcomer joins the rotation");
  assert.equal(newcomers[1].shifts["3"], 0);
});
