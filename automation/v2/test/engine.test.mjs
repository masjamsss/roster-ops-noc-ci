import assert from "node:assert/strict";
import os from "node:os";
import { readFileSync } from "node:fs";
import test from "node:test";
import { DEFAULT_PORTFOLIO, DEFAULT_RULES, DEFAULT_TEAM, makeConfig } from "../src/defaults.mjs";
import { generateRoster, plannedWorkers } from "../src/engine.mjs";
import { fairnessOffsets } from "../src/objective.mjs";
import { rollingStats } from "../src/history.mjs";
import { parseRosterCsv } from "../src/roster-csv.mjs";

const september = parseRosterCsv(readFileSync(new URL("./fixtures/september-2026.csv", import.meta.url), "utf8"));
// Same as production (buildHistory): the codes plus the stats for 3-month fairness.
const septemberHistory = {
  key: "2026-09", dates: september.dates, codesById: september.codesById, source: "csv",
  stats: rollingStats([{ key: "2026-09", dates: september.dates, codesById: september.codesById }], september.memberIds, ["1", "2", "3"])
};
const noHolidays = (year) => [{ year, days: [], status: "official-verified" }];

const SMALL_TEAM = [
  { id: "ani", name: "Ani", eligibleShifts: ["1", "2"] },
  { id: "bela", name: "Bela", eligibleShifts: ["1", "2"] },
  { id: "cahyo", name: "Cahyo", eligibleShifts: ["1", "2", "3"] },
  { id: "dodi", name: "Dodi", eligibleShifts: ["1", "2", "3"] },
  { id: "eko", name: "Eko", eligibleShifts: ["1", "2", "3"] }
];
const smallConfig = (overrides = {}) => makeConfig({ year: 2027, month: 2, team: SMALL_TEAM, search: { beamWidth: 600 }, ...overrides });
const emptyHistory = { key: "2027-01", dates: [], codesById: {}, source: "none" };

function nightOwners(result) {
  return Object.keys(result.schedule[result.members[0].id]).map((date) => result.members.filter((member) => result.schedule[member.id][date] === "3").map((member) => member.id));
}

test("a small team month is valid, has one night person per day and 2-3 night blocks", async () => {
  const result = await generateRoster({ config: smallConfig(), calendars: noHolidays(2027), history: emptyHistory });
  assert.equal(result.audit.ok, true, JSON.stringify(result.audit.checks.filter((item) => !item.ok), null, 1));
  assert.equal(result.period.start, "2027-02-01");
  assert.equal(result.period.end, "2027-02-28");
  for (const owners of nightOwners(result)) assert.equal(owners.length, 1);
  for (const block of result.nightBlocks) {
    assert.ok(block.length >= 2 && block.length <= 3, `block ${JSON.stringify(block)}`);
    assert.ok(block.start >= "2027-02-01" && block.end <= "2027-02-28");
  }
  assert.ok(Array.isArray(result.notes) && result.notes.length > 0);
});

test("generation is deterministic", async () => {
  const first = await generateRoster({ config: smallConfig(), calendars: noHolidays(2027), history: emptyHistory });
  const second = await generateRoster({ config: smallConfig(), calendars: noHolidays(2027), history: emptyHistory });
  assert.deepEqual(first.schedule, second.schedule);
});

test("local improvement never makes the roster worse or breaks a rule", async () => {
  const without = await generateRoster({ config: smallConfig({ localSearch: { enabled: false } }), calendars: noHolidays(2027), history: emptyHistory });
  const withSearch = await generateRoster({ config: smallConfig(), calendars: noHolidays(2027), history: emptyHistory });
  assert.equal(withSearch.audit.ok, true);
  assert.ok(withSearch.search.finalScore <= without.search.finalScore, `${withSearch.search.finalScore} > ${without.search.finalScore}`);
});

test("real October 2026 continues correctly from the actual September roster", { timeout: 240_000 }, async () => {
  const result = await generateRoster({ config: makeConfig({ year: 2026, month: 10 }), calendars: noHolidays(2026), history: septemberHistory });
  assert.equal(result.audit.ok, true, JSON.stringify(result.audit.checks.filter((item) => !item.ok), null, 1));
  const s = result.schedule;
  assert.deepEqual([s.rizky["2026-10-01"], s.rizky["2026-10-02"]], ["3", "3"], "Rizky takes the first night block");
  assert.deepEqual([s.arman["2026-10-01"], s.arman["2026-10-02"]], ["H", "H"], "Arman recovers after 29-30 Sep nights");
  for (const owners of nightOwners(result)) assert.equal(owners.length, 1);
  for (const block of result.nightBlocks) {
    assert.ok(block.length >= 2 && block.length <= 3);
    assert.ok(block.start >= "2026-10-01" && block.end <= "2026-10-31");
  }
  for (const id of ["hilvani", "pavitasari"]) {
    const summary = result.memberSummary[id];
    assert.equal(summary.shifts["3"], 0);
    assert.ok(Math.abs(summary.shifts["1"] - summary.shifts["2"]) <= 2, `${id} balanced S1 ${summary.shifts["1"]} vs S2 ${summary.shifts["2"]} (user's decision), also with 2-1-1 days`);
  }
  const workDays = Object.values(result.memberSummary).map((item) => item.workDays);
  assert.ok(Math.max(...workDays) - Math.min(...workDays) <= 2, `work is shared evenly: ${workDays}`);
  const average = workDays.reduce((sum, value) => sum + value, 0) / workDays.length;
  for (const item of Object.values(result.memberSummary)) assert.equal(item.workTarget, 22, "October: the ideal work shared by 6 is capped at 5 days a week = 22");
  // 20.5 before 30 Sep; with 3-night blocks only when forced (user's decision,
  // healthier) the men lose about half a day.
  assert.ok(average >= 20, `people work close to the 22-day target, got ${workDays}`);
  assert.deepEqual(result.days.filter((day) => day.status === "MINIMAL").map((day) => day.date), [], "no 1-1-1 weekdays (1 Oct can be 2-1-1: Hilvani + Willy on Shift 1)");
  const upsideDown = result.days.filter((day) => !day.isSpecial && day.counts["1"] < day.counts["2"]);
  assert.deepEqual(upsideDown.map((day) => day.date), [], "morning traffic is higher: never fewer people on Shift 1 than on Shift 2");
  assert.ok(result.notes.some((note) => note.startsWith("Setiap hari kerja, Shift 1")), "the notes confirm the Shift 1 rule");
  assert.ok(result.notes.some((note) => /Shift 3 tidak bisa ditutup lembur saja/.test(note)), "the notes explain the night backup");
  const women = result.members.filter((member) => member.gender === "P").map((member) => member.id);
  for (const day of result.days.filter((item) => new Date(`${item.date}T00:00:00Z`).getUTCDay() === 5)) {
    assert.ok(women.some((id) => s[id][day.date] === "1"), `Friday ${day.date}: a female agent on Shift 1 (Friday prayer coverage)`);
  }
});

test("best-result mode: several search variants, all scored the same way, the best one is kept", { timeout: 300_000 }, async () => {
  const run = (search) => generateRoster({ config: makeConfig({ year: 2026, month: 10, search }), calendars: noHolidays(2026), history: septemberHistory });
  const single = await run({ beamWidth: 800 });
  const best = await run({ beamWidth: 800, portfolio: [{}, { weightScale: { singleWorkDay: 0.6, isolatedOff: 0.67, shortWorkBlock: 0.5 } }, { search: { nightChoices: 3, beamScale: 1.5 } }] });
  assert.equal(best.audit.ok, true);
  assert.equal(best.search.portfolio.filter((entry) => entry.round === 0).length, 3, "every variant is reported");
  assert.ok(best.search.portfolio.filter((entry) => entry.round > 0).every((entry) => entry.aim?.length), "extra attempts (not perfect yet) say what they aimed at");
  // Fewest serious quality findings first (what a careful planner would reject),
  // then fewest people with a work-life score below 65, then the lowest score.
  const ranked = best.search.portfolio.filter((entry) => !entry.failed).sort((a, b) => a.serious - b.serious || a.wlbLow - b.wlbLow || a.score - b.score);
  assert.equal(best.search.chosenVariant, ranked[0].variant);
  assert.equal(best.search.finalScore, ranked[0].score);
  assert.equal(best.quality.serious, ranked[0].serious, "the chosen roster's own review matches");
  assert.equal(best.search.portfolio[0].score, single.search.finalScore, "variant 1 is the normal search");
  assert.ok(best.quality.serious <= single.quality.serious, "never more serious findings than the normal search");
  assert.ok(Array.isArray(single.quality.findings), "every roster carries its quality review");
});

test("parallel attempts: at most half the cores and about 2.8 GB of memory each (the console's time estimate uses the same count)", () => {
  assert.equal(plannedWorkers(6, {}, { cores: 2, memory: 8.6e9 }), 1, "GitHub's 2-core Windows runner");
  assert.equal(plannedWorkers(6, {}, { cores: 8, memory: 8.6e9 }), 3, "this Mac");
  assert.equal(plannedWorkers(6, {}, { cores: 16, memory: 64e9 }), 6);
  assert.equal(plannedWorkers(6, { parallel: false }, { cores: 8, memory: 16e9 }), 1);
  assert.equal(plannedWorkers(1, {}, { cores: 8, memory: 16e9 }), 1);
});

test("a short sickness with its own night-free period: the roster follows it and the notes say until when", { timeout: 300_000 }, async () => {
  const requests = [{ memberId: "rizky", name: "Rizky", from: "2026-10-14", to: "2026-10-14", code: "S", kind: "Sakit", source: "test" }];
  const rules = { ...DEFAULT_RULES, nightFreeDaysAfterShortSick: 2 };
  const result = await generateRoster({ config: makeConfig({ year: 2026, month: 10, rules, requests, search: { beamWidth: 1500 } }), calendars: noHolidays(2026), history: septemberHistory });
  assert.equal(result.audit.ok, true);
  assert.ok(result.notes.some((note) => /Rizky sakit 14 Okt; kembali tgl 15 Okt dengan shift pagi\/siang, tanpa Shift 3 sampai 16 Okt/.test(note)), result.notes.filter((note) => /sakit/.test(note)).join("\n"));
  assert.ok(!["2026-10-15", "2026-10-16"].some((date) => result.schedule.rizky[date] === "3"));
});

test("hours above the daily limit (a night is 9 net hours, the 5-day scheme allows 8) are counted per person for HR", { timeout: 300_000 }, async () => {
  const result = await generateRoster({ config: makeConfig({ year: 2026, month: 10, search: { beamWidth: 1500 } }), calendars: noHolidays(2026), history: septemberHistory });
  const nights = (id) => Object.values(result.schedule[id]).filter((code) => code === "3").length;
  for (const member of result.members) assert.equal(result.memberSummary[member.id].dailyHoursOver, nights(member.id), member.name);
  assert.ok(result.notes.some((note) => /di atas batas 8 jam per hari/.test(note)), result.notes.join("\n"));
});

test("the default best-result portfolio: the normal search first, then 5 variants relative to the settings", () => {
  assert.equal(DEFAULT_PORTFOLIO.length, 6);
  assert.deepEqual(DEFAULT_PORTFOLIO[0], {});
  for (const variant of DEFAULT_PORTFOLIO.slice(1)) {
    assert.ok(!variant.weights, "variants scale the current weights instead of fixing numbers");
    assert.ok(variant.weightScale || variant.search);
  }
  // 5 Oct review: the two variants that never won in six months were replaced by
  // a wide search and a rhythm (work-life) variant (IDEAL weekdays 46 -> 52).
  assert.ok(DEFAULT_PORTFOLIO.some((variant) => variant.search?.beamScale === 3 && variant.search?.nightChoices === 3), "a wide search");
  assert.ok(DEFAULT_PORTFOLIO.some((variant) => variant.weightScale?.isolatedOff > 1 && variant.weightScale?.shortWorkBlock > 1), "a work-life rhythm variant");
});

test("updating a month: the current roster is kept where possible, earlier days are frozen, every change is listed", { timeout: 600_000 }, async () => {
  const base = await generateRoster({ config: makeConfig({ year: 2026, month: 10, search: { beamWidth: 1500 } }), calendars: noHolidays(2026), history: septemberHistory });
  const reference = base.schedule;
  const sick = [{ memberId: "hilvani", name: "Hilvani", from: "2026-10-14", to: "2026-10-16", code: "S", kind: "Sakit", source: "test" }];
  const run = (extra) => generateRoster({ config: { ...makeConfig({ year: 2026, month: 10, requests: sick, search: { beamWidth: 1500 } }), ...extra }, calendars: noHolidays(2026), history: septemberHistory });
  const kept = await run({ reference, freezeBefore: "2026-10-12" });
  const fresh = await run({});
  assert.equal(kept.audit.ok, true);
  for (const id of Object.keys(reference)) {
    for (const date of Object.keys(reference[id])) if (date < "2026-10-12") assert.equal(kept.schedule[id][date], reference[id][date], `${id} ${date} is frozen`);
  }
  assert.deepEqual(["2026-10-14", "2026-10-15", "2026-10-16"].map((date) => kept.schedule.hilvani[date]), ["S", "S", "S"]);
  const changed = (result) => Object.keys(reference).reduce((sum, id) => sum + Object.keys(reference[id]).filter((date) => result.schedule[id][date] !== reference[id][date]).length, 0);
  assert.equal(kept.changes.length, changed(kept), "every change is listed");
  assert.ok(kept.changes.every((change) => change.date >= "2026-10-12" && change.from === reference[change.memberId][change.date]));
  assert.ok(changed(kept) < changed(fresh) / 2, `kept ${changed(kept)} changes vs ${changed(fresh)} from scratch`);
  assert.deepEqual(fresh.changes, [], "no reference: nothing to compare");
  assert.ok(kept.notes.some((note) => /perubahan/i.test(note) && /12 Okt/.test(note)), "the notes say what changed and from when");
});

test("back from hospital: Rizky (sick 1-5 Oct) gets no night shift until 11 Oct, and the notes say so", { timeout: 300_000 }, async () => {
  const requests = [{ memberId: "rizky", name: "Rizky", from: "2026-10-01", to: "2026-10-05", code: "S", kind: "Sakit", source: "test" }];
  const result = await generateRoster({ config: makeConfig({ year: 2026, month: 10, requests, search: { beamWidth: 1500 } }), calendars: noHolidays(2026), history: septemberHistory });
  assert.equal(result.audit.ok, true);
  const firstDays = ["2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-10"].map((date) => result.schedule.rizky[date]);
  assert.ok(!firstDays.includes("3"), `first 5 days back: ${firstDays.join(" ")}`);
  assert.ok(result.notes.some((note) => /Rizky/.test(note) && /tanpa Shift 3 sampai 10 Okt/.test(note)), "the notes explain the return");
});

test("an impossible day explains which shift cannot be filled, why, and what the admin can do", { timeout: 120_000 }, async () => {
  const requests = ["rizky", "willy", "arman", "addin"].map((id) => ({ memberId: id, name: id, from: "2026-10-12", to: "2026-10-13", code: "C", kind: "Cuti", source: "test" }));
  await assert.rejects(
    generateRoster({ config: makeConfig({ year: 2026, month: 10, requests, search: { beamWidth: 800 } }), calendars: noHolidays(2026), history: septemberHistory }),
    (error) => error.name === "RosterError"
      && /12 Oktober 2026/.test(error.message)
      && /Shift 3 tidak bisa diisi/.test(error.message)
      && /Rizky cuti/.test(error.message) && /Addin cuti/.test(error.message)
      && /tidak boleh Shift 3/.test(error.message)
      && /anggota sementara/.test(error.message)
  );
});

test("the suggested fix works: a temporary outside member covers the nights while all men are away", { timeout: 300_000 }, async () => {
  const requests = ["rizky", "willy", "arman", "addin"].map((id) => ({ memberId: id, name: id, from: "2026-10-12", to: "2026-10-13", code: "C", kind: "Cuti", source: "test" }));
  const team = [...DEFAULT_TEAM, { id: "doni", name: "Doni", gender: "L", eligibleShifts: ["1", "2", "3"], activeFrom: "2026-10-12", activeUntil: "2026-10-13" }];
  const result = await generateRoster({ config: makeConfig({ year: 2026, month: 10, team, requests, search: { beamWidth: 1500 } }), calendars: noHolidays(2026), history: septemberHistory });
  assert.equal(result.audit.ok, true);
  assert.deepEqual([result.schedule.doni["2026-10-12"], result.schedule.doni["2026-10-13"]], ["3", "3"], "Doni takes both nights");
  assert.equal(result.schedule.doni["2026-10-14"], "-", "and is not scheduled outside his dates");
});

test("a Friday with every female agent on leave is reported, not hidden behind 'every Friday is covered'", { timeout: 300_000 }, async () => {
  const requests = ["hilvani", "pavitasari"].map((id) => ({ memberId: id, name: id, from: "2026-10-19", to: "2026-10-23", code: "C", kind: "Cuti", source: "test" }));
  const result = await generateRoster({ config: makeConfig({ year: 2026, month: 10, requests, search: { beamWidth: 1500 } }), calendars: noHolidays(2026), history: septemberHistory });
  assert.equal(result.audit.ok, true);
  assert.ok(!result.notes.some((note) => note.startsWith("Setiap Jumat, Shift 1 ada agen perempuan")), "not every Friday is covered");
  assert.ok(result.notes.some((note) => /23 Okt/.test(note) && /tidak ada agen perempuan yang masuk/.test(note)), result.notes.join("\n"));
});

test("best-result variants run in parallel on several CPU cores with exactly the same outcome", { timeout: 600_000 }, async () => {
  const portfolio = [{}, { weightScale: { singleWorkDay: 0.6, isolatedOff: 0.67, shortWorkBlock: 0.5 } }, { search: { nightChoices: 3 } }];
  // Diverse attempts included (fixed waves, stopped by patience, not by time); the
  // time-limited part-by-part check is left out here so both runs are comparable.
  const run = (parallel) => generateRoster({ config: makeConfig({ year: 2026, month: 10, search: { beamWidth: 800, portfolio, parallel, diversePatience: 3, polishMs: 0, perfectBudgetMs: 1_800_000 } }), calendars: noHolidays(2026), history: septemberHistory });
  const [sequential, parallel] = [await run(false), await run(true)];
  assert.deepEqual(parallel.search.portfolio, sequential.search.portfolio);
  assert.equal(parallel.search.chosenVariant, sequential.search.chosenVariant);
  assert.deepEqual(parallel.schedule, sequential.schedule);
  // At most half the cores: a 2-core PC (like GitHub's Windows runner for private
  // repositories) runs the attempts one after another, with the same result.
  const cores = typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length;
  if (cores >= 4 && os.totalmem() >= 5.6e9) assert.ok(parallel.search.workers > 1, `ran on ${parallel.search.workers} workers`);
  else assert.equal(parallel.search.workers, 1, "small machine: one attempt at a time");
});

test("a 1-1-1 day explains, person by person, why nobody else could work", { timeout: 300_000 }, async () => {
  const requests = [
    { memberId: "rizky", name: "Rizky", from: "2026-10-01", to: "2026-10-05", code: "S", kind: "Sakit", source: "test" },
    { memberId: "willy", name: "Willy", from: "2026-10-03", to: "2026-10-03", code: "C", kind: "Cuti", source: "test" }
  ];
  const result = await generateRoster({ config: makeConfig({ year: 2026, month: 10, requests, search: { beamWidth: 1500 } }), calendars: noHolidays(2026), history: septemberHistory });
  const minimal = result.days.filter((day) => day.status === "MINIMAL").map((day) => day.date);
  assert.ok(minimal.includes("2026-10-01"), `1 Oct is 1-1-1: ${minimal}`);
  const note = result.notes.find((item) => item.startsWith("1 Okt hanya 1-1-1"));
  assert.ok(note, result.notes.join("\n"));
  assert.match(note, /Rizky sakit/);
  assert.match(note, /Arman masih istirahat setelah Shift 3/);
});

test("a requested Shift 3 on the 1st continues last month's night block (at most 3 nights), then 2 days off", { timeout: 300_000 }, async () => {
  const requests = [
    { memberId: "rizky", name: "Rizky", from: "2026-10-01", to: "2026-10-05", code: "S", kind: "Sakit", source: "test" },
    { memberId: "willy", name: "Willy", from: "2026-10-03", to: "2026-10-03", code: "C", kind: "Cuti", source: "test" },
    { memberId: "arman", name: "Arman", from: "2026-10-01", to: "2026-10-01", code: "3", kind: "Minta Shift 3", source: "test" }
  ];
  const result = await generateRoster({ config: makeConfig({ year: 2026, month: 10, requests, search: { beamWidth: 1500 } }), calendars: noHolidays(2026), history: septemberHistory });
  const arman = result.schedule.arman;
  assert.deepEqual([arman["2026-10-01"], arman["2026-10-02"], arman["2026-10-03"]], ["3", "H", "H"], "29-30 Sep + 1 Oct, then rest");
  assert.notEqual(result.schedule.willy["2026-10-01"], "3");
  assert.ok(result.audit.ok);
  assert.ok(result.notes.some((note) => /Arman melanjutkan blok Shift 3 dari 29–30 Sep sampai 1 Okt/.test(note)), result.notes.join("\n"));
  assert.ok(!result.notes.some((note) => note.startsWith("Arman libur 1–2 Okt")), "no stale rest note");
});

test("Shift 3 is shared evenly: nights per available day and 3-night blocks per person (user, 30 Sep)", { timeout: 300_000 }, async () => {
  const result = await generateRoster({ config: makeConfig({ year: 2026, month: 10, search: { beamWidth: 1500 } }), calendars: noHolidays(2026), history: septemberHistory });
  const men = result.members.filter((member) => !member.dayOnly);
  const rows = men.map((member) => result.days.map((day) => result.schedule[member.id][day.date]).join(""));
  const nights = rows.map((row) => (row.match(/3/g) ?? []).length);
  const long = rows.map((row) => (row.match(/3{3,}/g) ?? []).length);
  assert.ok(Math.max(...long) - Math.min(...long) <= 1, `3-night blocks per man: ${long}`);
  // Fair over three months: September's share per available day is repaid
  // (Addin did 6 nights in 14 available days, so he is owed about one night off).
  const offsets = fairnessOffsets(result.members, septemberHistory.stats).nights;
  const menIndex = result.members.map((member, index) => (member.dayOnly ? -1 : index)).filter((index) => index >= 0);
  const adjusted = menIndex.map((index, k) => nights[k] - offsets[index]); // as in objective.mjs
  assert.ok(Math.max(...adjusted) - Math.min(...adjusted) <= 2, `nights per man ${nights}, after last month's share ${adjusted.map((value) => value.toFixed(1))}`);
});

test("3-night blocks only when forced (user, 30 Sep): a 31-day month needs just one; switched off, more are used", { timeout: 300_000 }, async () => {
  const longBlocks = (result) => result.members.filter((member) => !member.dayOnly)
    .reduce((sum, member) => sum + (result.days.map((day) => result.schedule[member.id][day.date]).join("").match(/3{3}/g) ?? []).length, 0);
  const forced = await generateRoster({ config: makeConfig({ year: 2026, month: 10, search: { beamWidth: 1500 } }), calendars: noHolidays(2026), history: septemberHistory });
  assert.ok(forced.audit.ok);
  assert.equal(longBlocks(forced), 1, "31 nights cannot all be 2-night blocks inside the month; one 3-night block is forced");
  const free = await generateRoster({ config: makeConfig({ year: 2026, month: 10, rules: { ...DEFAULT_RULES, longNightBlockOnlyIfNeeded: false }, search: { beamWidth: 1500 } }), calendars: noHolidays(2026), history: septemberHistory });
  assert.ok(longBlocks(free) > 1, `without the rule: ${longBlocks(free)} three-night blocks`);
});

test("not perfect yet: extra attempts aimed at what is left, then an honest report (no pretending)", { timeout: 600_000 }, async () => {
  const requests = [
    { memberId: "rizky", name: "Rizky", from: "2026-10-05", to: "2026-10-09", code: "S", kind: "Sakit", source: "test" },
    { memberId: "willy", name: "Willy", from: "2026-10-05", to: "2026-10-09", code: "C", kind: "Cuti", source: "test" }
  ];
  const config = makeConfig({ year: 2026, month: 10, requests, search: { beamWidth: 600, portfolio: [{}, { search: { beamScale: 1.2 } }], perfectRounds: 1, diverse: false, polishMs: 0 } });
  const result = await generateRoster({ config, calendars: noHolidays(2026), history: septemberHistory });
  const perfect = result.search.perfect;
  assert.equal(perfect.reached, false, "two men out the same week: 1-1-1 days cannot all be avoided");
  assert.equal(perfect.rounds, 1);
  assert.ok(perfect.tried > 2, `${perfect.tried} rosters tried`);
  assert.ok(perfect.remaining.includes("minimal"), JSON.stringify(perfect));
  const aimed = result.search.portfolio.filter((entry) => entry.round === 1);
  assert.ok(aimed.length > 0 && aimed.every((entry) => entry.aim?.length), JSON.stringify(aimed));
  assert.ok(aimed.some((entry) => entry.aim.includes("minimal")));
  const best = result.search.portfolio.filter((entry) => !entry.failed).sort((a, b) => a.serious - b.serious || a.wlbLow - b.wlbLow || a.score - b.score)[0];
  assert.equal(result.search.chosenVariant, best.variant, "the best roster over all rounds wins");
});

test("best of the best: more attempts in other directions, the winner checked part by part, and a report of how sure it is", { timeout: 900_000 }, async () => {
  const config = makeConfig({ year: 2026, month: 10, search: { beamWidth: 600, portfolio: [{}, { search: { beamScale: 1.2 } }], perfectRounds: 0, diversePatience: 3, polishMs: 30_000 } });
  const result = await generateRoster({ config, calendars: noHolidays(2026), history: septemberHistory });
  const sure = result.search.confidence;
  assert.ok(sure.diverseTried >= 3, JSON.stringify(sure));
  assert.equal(sure.attempts, result.search.portfolio.filter((entry) => !entry.failed).length);
  assert.ok(sure.sameBest >= 1);
  assert.equal(sure.chanceNextBetter, 1 / (sure.attempts + 1));
  assert.ok(sure.polish.checked["satu-orang"].parts >= 1, JSON.stringify(sure.polish));
  const best = result.search.portfolio.filter((entry) => !entry.failed).sort((a, b) => a.serious - b.serious || a.wlbLow - b.wlbLow || a.score - b.score)[0];
  assert.ok(result.search.finalScore <= best.score + 1, "never worse than the best attempt");
  assert.ok(result.notes.some((note) => /^Keyakinan hasil:/.test(note)), result.notes.join("\n"));
  assert.equal(result.audit.ok, true);
});

test("a quick single search does not claim to be perfect", { timeout: 300_000 }, async () => {
  const result = await generateRoster({ config: smallConfig(), calendars: noHolidays(2027), history: emptyHistory });
  assert.equal(result.search.perfect, null);
});

test("special requests: 'Hindari Shift 3' keeps the person off nights on those dates, and the audit checks it", { timeout: 300_000 }, async () => {
  const requests = [
    { memberId: "willy", name: "Willy", from: "2026-10-01", to: "2026-10-12", code: "!3", kind: "Hindari Shift 3", source: "test" },
    { memberId: "hilvani", name: "Hilvani", from: "2026-10-05", to: "2026-10-09", code: "!1", kind: "Hindari Shift 1", source: "test" }
  ];
  const result = await generateRoster({ config: makeConfig({ year: 2026, month: 10, requests, search: { beamWidth: 1500 } }), calendars: noHolidays(2026), history: septemberHistory });
  assert.ok(result.audit.ok);
  const between = (id, from, to) => result.days.filter((day) => day.date >= from && day.date <= to).map((day) => result.schedule[id][day.date]);
  const valid = new Set(["1", "2", "3", "H", "C", "S", "T", "-"]);
  for (const [id, row] of Object.entries(result.schedule)) for (const code of Object.values(row)) assert.ok(valid.has(code), `${id}: "${code}" is not a roster code`);
  assert.ok(!between("willy", "2026-10-01", "2026-10-12").includes("3"), between("willy", "2026-10-01", "2026-10-12").join(""));
  assert.ok(between("willy", "2026-10-01", "2026-10-12").filter((code) => code === "1" || code === "2").length >= 5, "Willy still works day shifts then");
  assert.ok(!between("hilvani", "2026-10-05", "2026-10-09").includes("1"));
  assert.ok(result.schedule.willy && result.days.some((day) => day.date > "2026-10-12" && result.schedule.willy[day.date] === "3"), "nights again after the dates");
});
