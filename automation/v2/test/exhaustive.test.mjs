// Very low availability: the complete search behind the normal one.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { DEFAULT_TEAM, makeConfig } from "../src/defaults.mjs";
import { generateRoster, prepareMonth } from "../src/engine.mjs";
import { exhaustiveSearch, nightCoverageCheck } from "../src/exhaustive.mjs";
import { scoreSchedule } from "../src/objective.mjs";
import { parseRosterCsv } from "../src/roster-csv.mjs";
import { runBeamSearch } from "../src/search.mjs";

const september = parseRosterCsv(readFileSync(new URL("./fixtures/september-2026.csv", import.meta.url), "utf8"));
const history = { key: "2026-09", dates: september.dates, codesById: september.codesById, source: "csv" };
const calendars = [{ year: 2026, days: [] }];
const leave = (ids, from, to) => ids.map((id) => ({ memberId: id, name: id, from, to, code: "C", kind: "Cuti", source: "test" }));
// Only Addin can work nights 13-16 Oct: four nights in a row, the maximum is three.
const fourNightsAlone = () => makeConfig({ year: 2026, month: 10, requests: leave(["rizky", "willy", "arman"], "2026-10-13", "2026-10-16") });

test("Shift 3 coverage proof: one person for four nights in a row is impossible, found at once and explained", () => {
  const started = Date.now();
  const check = nightCoverageCheck(prepareMonth({ config: fourNightsAlone(), calendars, history }).input);
  assert.ok(Date.now() - started < 2000, "a quick check");
  assert.equal(check.ok, false);
  assert.equal(check.date, "2026-10-16", "the fourth night");
  assert.match(check.reason, /Addin/);
  assert.match(check.reason, /paling banyak 3 malam/);
});

test("coverage proof also counts the day shifts: whoever is on nights or resting after them cannot work days", () => {
  // Addin and Willy away, Hilvani sick 18-19: on 18 or 19 Oct, one of Rizky/Arman is on nights and
  // the other has just finished his, so Pavitasari would be alone for Shift 1 and Shift 2.
  const requests = [
    ...leave(["addin"], "2026-10-09", "2026-10-20"), ...leave(["willy"], "2026-10-16", "2026-10-20"),
    { memberId: "hilvani", name: "Hilvani", from: "2026-10-18", to: "2026-10-19", code: "S", kind: "Sakit", source: "test" }
  ];
  const check = nightCoverageCheck(prepareMonth({ config: makeConfig({ year: 2026, month: 10, requests }), calendars, history }).input);
  assert.equal(check.ok, false);
  assert.ok(["2026-10-18", "2026-10-19"].includes(check.date), check.date);
  assert.match(check.reason, /Shift 1 dan Shift 2/);
  assert.match(check.reason, /Pavitasari/);
});

test("Shift 3 coverage proof stays quiet when nights can be shared, also with only two men left", () => {
  assert.equal(nightCoverageCheck(prepareMonth({ config: makeConfig({ year: 2026, month: 10 }), calendars, history }).input).ok, true);
  const twoMen = DEFAULT_TEAM.map((member) => (["arman", "addin"].includes(member.id) ? { ...member, activeUntil: "2026-10-15" } : member));
  assert.equal(nightCoverageCheck(prepareMonth({ config: makeConfig({ year: 2026, month: 10, team: twoMen }), calendars, history }).input).ok, true);
});

test("the complete search finds a valid roster in a very tight month (two men for every night of the second half)", () => {
  const twoMen = DEFAULT_TEAM.map((member) => (["arman", "addin"].includes(member.id) ? { ...member, activeUntil: "2026-10-15" } : member));
  const config = makeConfig({ year: 2026, month: 10, team: twoMen });
  const { input } = prepareMonth({ config, calendars, history });
  const found = exhaustiveSearch(input, { budgetMs: 60_000 });
  assert.equal(found.status, "found");
  const { members, days, initialStates, ctx, fixed, env } = input;
  assert.equal(scoreSchedule({ codes: found.codes, members, days, initialStates, ctx, config, fixed, env }).valid, true, "every hard rule holds");
  assert.equal(found.nights.length, days.length, "the night rotation of every day, for next month's order");
});

test("a month that cannot be made says so plainly and at once: it was checked, which date, and why (and the console can offer a way out)", async () => {
  const started = Date.now();
  await assert.rejects(generateRoster({ config: fourNightsAlone(), calendars, history }), (error) => {
    assert.equal(error.name, "RosterError");
    assert.match(error.message, /sudah dipastikan/);
    assert.match(error.message, /16 Oktober 2026/);
    assert.match(error.message, /Addin/);
    assert.equal(error.details.date, "2026-10-16");
    return true;
  });
  assert.ok(Date.now() - started < 5000, `before any search (${Date.now() - started} ms)`);
});

test("a month the normal search misses (it dead-ends) is still made: the complete search finds a valid roster", { timeout: 600_000 }, async () => {
  // A tight last week from the random study of 5 Oct: Arman away 20-26, Addin no nights 21-25, Rizky away 21-23.
  const ask = (memberId, code, from, to) => ({ memberId, name: memberId, from, to, code, kind: code, source: "test" });
  const requests = [
    ask("arman", "C", "2026-10-20", "2026-10-21"), ask("addin", "!3", "2026-10-21", "2026-10-25"), ask("arman", "T", "2026-10-22", "2026-10-24"),
    ask("rizky", "T", "2026-10-21", "2026-10-22"), ask("arman", "T", "2026-10-26", "2026-10-26"), ask("willy", "!3", "2026-10-15", "2026-10-17"),
    ask("willy", "!3", "2026-10-06", "2026-10-06"), ask("rizky", "C", "2026-10-23", "2026-10-23"), ask("rizky", "T", "2026-10-09", "2026-10-10")
  ];
  const config = makeConfig({ year: 2026, month: 10, requests, search: { beamWidth: 1500 } });
  assert.throws(() => runBeamSearch(prepareMonth({ config, calendars, history }).input), /tidak bisa disusun/, "precondition: the normal search alone dead-ends");
  const result = await generateRoster({ config, calendars, history });
  assert.equal(result.audit.ok, true, "every rule holds");
  assert.ok(result.search.exhaustive, "made by the complete search");
  assert.match(result.notes[0], /memeriksa semua kemungkinan/);
});

test("leave, training or requested shifts that by themselves exceed the work-day limit are named at once (no search needed)", async () => {
  const requests = [{ memberId: "willy", name: "Willy", from: "2026-10-17", to: "2026-10-22", code: "T", kind: "Training/Dinas", source: "test" }];
  const started = Date.now();
  await assert.rejects(generateRoster({ config: makeConfig({ year: 2026, month: 10, requests }), calendars, history }), (error) => {
    assert.match(error.message, /Willy/);
    assert.match(error.message, /6 hari/);
    assert.match(error.message, /maksimal 5 hari kerja berturut-turut/);
    assert.equal(error.details.date, "2026-10-22");
    assert.equal(error.details.inputConflict, true, "fixed in Data Roster.xlsx, not by adding people");
    return true;
  });
  assert.ok(Date.now() - started < 5000, "before any search");
});
