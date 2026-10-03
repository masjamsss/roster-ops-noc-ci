import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { compareHolidayDays, resolveHolidays } from "../src/holiday-calendar.mjs";
import { parseGoogleIcs } from "../src/holiday-google.mjs";

const ICS = readFileSync(new URL("./fixtures/google-id-sample.ics", import.meta.url), "utf8");
const fakeFetch = (text = ICS, counter = { calls: 0 }) => async () => {
  counter.calls += 1;
  return { ok: true, status: 200, text: async () => text };
};
const failingFetch = async () => {
  throw new Error("getaddrinfo ENOTFOUND calendar.google.com");
};
const official2026 = {
  schemaVersion: 1, country: "ID", year: 2026, status: "official-verified",
  officialSource: { title: "SKB 3 Menteri 2026", url: "https://www.setneg.go.id/" },
  days: [
    { date: "2026-12-24", type: "collective_leave", name: "Cuti Bersama Kelahiran Yesus Kristus" },
    { date: "2026-12-25", type: "national", name: "Kelahiran Yesus Kristus" }
  ]
};

async function tempDir(files = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "libur-"));
  for (const [name, content] of Object.entries(files)) await writeFile(path.join(dir, name), JSON.stringify(content));
  return dir;
}

test("Google ICS: national days, cuti bersama, observances skipped, tentative flagged", () => {
  const days2026 = parseGoogleIcs(ICS, 2026);
  assert.deepEqual(days2026.map((day) => [day.date, day.type]), [["2026-12-24", "collective_leave"], ["2026-12-25", "national"]]);
  assert.equal(days2026[1].name, "Hari Raya Natal");
  const days2027 = parseGoogleIcs(ICS, 2027);
  const isra = days2027.find((day) => day.date === "2027-01-05");
  assert.equal(isra.tentative, true);
  assert.equal(isra.name, "Isra Mikraj Nabi Muhammad");
  assert.equal(days2027.find((day) => day.date === "2027-03-28")?.type, "national", "Paskah counts as tanggal merah");
  assert.equal(days2027.find((day) => day.date === "2027-03-09")?.type, "collective_leave");
  assert.equal(days2027.filter((day) => day.date === "2027-05-18").length, 1, "one entry per date");
});

test("an official-verified file is used as is and never overwritten", async () => {
  const dir = await tempDir({ "ID-2026.json": official2026 });
  const counter = { calls: 0 };
  const { calendars } = await resolveHolidays({ years: [2026], directory: dir, online: false, fetchImpl: fakeFetch(ICS, counter) });
  assert.equal(calendars[0].status, "official-verified");
  assert.equal(calendars[0].days.length, 2);
  assert.equal(counter.calls, 0);
  assert.deepEqual(JSON.parse(await readFile(path.join(dir, "ID-2026.json"), "utf8")), official2026);
});

test("a missing year is fetched from Google once, saved as automatic, and flagged", async () => {
  const dir = await tempDir();
  const counter = { calls: 0 };
  const { calendars, notes } = await resolveHolidays({ years: [2026, 2027], directory: dir, online: true, fetchImpl: fakeFetch(ICS, counter), now: new Date("2026-09-29T00:00:00Z") });
  assert.equal(counter.calls, 1, "one download serves every year");
  assert.equal(calendars[1].status, "auto-google");
  const saved = JSON.parse(await readFile(path.join(dir, "ID-2027.json"), "utf8"));
  assert.equal(saved.status, "auto-google");
  assert.equal(saved.fetchedAt, "2026-09-29T00:00:00.000Z");
  assert.ok(notes.some((note) => /2027/.test(note) && /Google Calendar/.test(note)));
});

test("offline with no file stops with instructions naming the file to add", async () => {
  const dir = await tempDir();
  await assert.rejects(
    resolveHolidays({ years: [2029], directory: dir, online: true, fetchImpl: failingFetch }),
    (error) => error.name === "RosterError" && /ID-2029\.json/.test(error.message) && /internet/.test(error.message)
  );
});

test("a year Google does not know yet stops with a clear message", async () => {
  const dir = await tempDir();
  await assert.rejects(resolveHolidays({ years: [2031], directory: dir, online: true, fetchImpl: fakeFetch() }), /2031/);
});

test("an old automatic file is refreshed; a failed refresh keeps the cache", async () => {
  const stale = { schemaVersion: 1, country: "ID", year: 2027, status: "auto-google", fetchedAt: "2026-01-01T00:00:00.000Z", source: { url: "x" }, days: [] };
  const dir = await tempDir({ "ID-2027.json": stale });
  const { calendars } = await resolveHolidays({ years: [2027], directory: dir, online: true, fetchImpl: fakeFetch(), now: new Date("2026-09-29T00:00:00Z") });
  assert.deepEqual(calendars[0].days, parseGoogleIcs(ICS, 2027));
  assert.equal(calendars[0].fetchedAt, "2026-09-29T00:00:00.000Z");
  const kept = await resolveHolidays({ years: [2027], directory: await tempDir({ "ID-2027.json": stale }), online: true, fetchImpl: failingFetch, now: new Date("2026-09-29T00:00:00Z") });
  assert.equal(kept.calendars[0].days.length, 0);
  assert.ok(kept.notes.some((note) => /tidak bisa diperbarui/.test(note)));
});

test("differences between the official list and Google are reported for a date range", () => {
  const google = parseGoogleIcs(ICS, 2027);
  const official = [
    { date: "2027-05-17", type: "national", name: "Idul Adha" },
    { date: "2027-05-18", type: "collective_leave", name: "Cuti Bersama Idul Adha" }
  ];
  const differences = compareHolidayDays(official, google, "2027-05-01", "2027-05-31");
  assert.equal(differences.length, 1);
  assert.equal(differences[0].date, "2027-05-18");
  assert.match(differences[0].message, /Google/);
  assert.equal(compareHolidayDays(official, google, "2027-06-01", "2027-06-30").length, 0);
});
