import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { auditTimeline } from "../src/audit.mjs";
import { eachDate, isWeekend } from "../src/date-utils.mjs";
import { parseRosterCsv } from "../src/roster-csv.mjs";

const SHIFTS = [
  { id: "1", start: "07:00", end: "16:00", level: 1 },
  { id: "2", start: "13:00", end: "21:00", level: 2 },
  { id: "3", start: "21:00", end: "07:00", level: 3, night: true }
];
const RULES = {
  maxConsecutiveWorkDays: 5, maxConsecutiveOffDays: 2, minimumRestHours: 11, forbidBackwardShiftWithoutOff: true,
  nightRecoveryOffDays: 2, nightBlock: { min: 2, preferred: 2, max: 3 }, nightFreeDaysAfterSick: 5
};
const COVERAGE = {
  weekday: { minimum: { 1: 1, 2: 1, 3: 1 }, preferred: { 1: 2, 2: 2, 3: 1 } },
  special: { minimum: { 1: 1, 2: 1, 3: 1 }, preferred: { 1: 1, 2: 1, 3: 1 } }
};
const all = ["1", "2", "3"];
const dayOnly = ["1", "2"];

function audit({ historyDates, historyCodes, dates, codes, members, requests = {}, publishedTo, rules = RULES }) {
  const allDates = [...historyDates, ...dates];
  const dayInfoByDate = Object.fromEntries(allDates.map((date) => [date, { isSpecial: isWeekend(date), isWeekend: isWeekend(date) }]));
  const codesById = Object.fromEntries(members.map((member) => [member.id, [...(historyCodes[member.id] ?? historyDates.map(() => "H")), ...codes[member.id]]]));
  return auditTimeline({
    dates: allDates, codesById, members, shifts: SHIFTS, rules, coverage: COVERAGE, dayInfoByDate,
    requestsByDate: requests, generatedFrom: dates[0], publishedTo: publishedTo ?? dates.at(-1),
    trainingWindow: { start: "08:00", end: "17:00" }
  });
}

const check = (result, id) => result.checks.find((item) => item.id === id);

// A hand-checked valid week (1-7 Oct 2026; 3-4 Oct is a weekend).
const WEEK = eachDate("2026-10-01", "2026-10-07");
const HISTORY = ["2026-09-29", "2026-09-30"];
const TEAM = [
  { id: "a", name: "Ani", eligibleShifts: all }, { id: "b", name: "Budi", eligibleShifts: all },
  { id: "c", name: "Citra", eligibleShifts: all }, { id: "d", name: "Dewi", eligibleShifts: dayOnly },
  { id: "e", name: "Eka", eligibleShifts: dayOnly }
];
const CLEAN = {
  a: ["3", "3", "H", "H", "1", "1", "3"],
  b: ["1", "1", "3", "3", "H", "H", "1"],
  c: ["2", "2", "H", "1", "3", "3", "H"],
  d: ["1", "1", "1", "2", "H", "2", "2"],
  e: ["2", "2", "2", "H", "2", "2", "2"]
};
const withChange = (id, index, code) => ({ ...CLEAN, [id]: CLEAN[id].map((value, i) => (i === index ? code : value)) });

test("a valid week passes every check", () => {
  const result = audit({ historyDates: HISTORY, historyCodes: {}, dates: WEEK, codes: CLEAN, members: TEAM });
  assert.equal(result.ok, true, JSON.stringify(result.checks.filter((item) => !item.ok), null, 1));
  assert.equal(result.checks.length, 12);
});

test("catches the old v2 October: Addin works 6 days in a row across the month boundary", () => {
  const september = parseRosterCsv(readFileSync(new URL("./fixtures/september-2026.csv", import.meta.url), "utf8"));
  const october = parseRosterCsv(readFileSync(new URL("./fixtures/old-v2-october-2026.csv", import.meta.url), "utf8"));
  const members = [
    { id: "hilvani", name: "Hilvani", eligibleShifts: dayOnly }, { id: "pavitasari", name: "Pavitasari", eligibleShifts: dayOnly },
    { id: "rizky", name: "Rizky", eligibleShifts: all }, { id: "willy", name: "Willy", eligibleShifts: all },
    { id: "arman", name: "Arman", eligibleShifts: all }, { id: "addin", name: "Addin", eligibleShifts: all }
  ];
  const result = audit({ historyDates: september.dates, historyCodes: september.codesById, dates: october.dates, codes: october.codesById, members });
  const streak = check(result, "maks-hari-kerja");
  assert.equal(streak.ok, false);
  const addin = streak.pelanggaran.find((item) => item.anggota === "Addin");
  assert.ok(addin, "Addin must be reported");
  assert.equal(addin.tanggal, "2026-10-02");
  assert.match(addin.pesan, /6 hari/);
});

test("night recovery: Arman cannot work 1 Oct after nights on 29-30 Sep", () => {
  const history = { a: ["3", "3"] };
  const codes = withChange("a", 0, "1");
  const result = audit({ historyDates: HISTORY, historyCodes: history, dates: WEEK, codes, members: TEAM });
  const recovery = check(result, "istirahat-malam");
  assert.equal(recovery.ok, false);
  assert.equal(recovery.pelanggaran[0].tanggal, "2026-10-01");
});

test("coverage gap and special-day overstaffing are reported per date", () => {
  const gap = audit({ historyDates: HISTORY, historyCodes: {}, dates: WEEK, codes: withChange("a", 6, "H"), members: TEAM });
  assert.equal(check(gap, "cakupan").ok, false);
  assert.equal(check(gap, "cakupan").pelanggaran[0].tanggal, "2026-10-07");
  const over = audit({ historyDates: HISTORY, historyCodes: {}, dates: WEEK, codes: withChange("c", 2, "2"), members: TEAM });
  assert.equal(check(over, "hari-khusus").ok, false);
});

test("backward shift, eligibility, too many H, requests and inactive days", () => {
  const backward = audit({ historyDates: HISTORY, historyCodes: {}, dates: WEEK, codes: withChange("d", 5, "1"), members: TEAM });
  assert.equal(check(backward, "shift-mundur").ok, true, "2 -> H -> 1 is allowed");
  const noOff = audit({ historyDates: HISTORY, historyCodes: {}, dates: WEEK, codes: { ...CLEAN, e: ["2", "2", "2", "H", "2", "1", "1"] }, members: TEAM });
  assert.equal(check(noOff, "shift-mundur").ok, false);

  const eligibility = audit({ historyDates: HISTORY, historyCodes: {}, dates: WEEK, codes: withChange("d", 0, "3"), members: TEAM });
  assert.equal(check(eligibility, "shift-diizinkan").ok, false);

  const tooManyOff = { ...CLEAN, d: ["1", "1", "1", "H", "H", "H", "2"] };
  assert.equal(check(audit({ historyDates: HISTORY, historyCodes: {}, dates: WEEK, codes: tooManyOff, members: TEAM }), "maks-libur").ok, false);
  const requested = { "2026-10-06": { d: "H" } };
  assert.equal(check(audit({ historyDates: HISTORY, historyCodes: {}, dates: WEEK, codes: tooManyOff, members: TEAM, requests: requested }), "maks-libur").ok, true);

  const ignoredRequest = audit({ historyDates: HISTORY, historyCodes: {}, dates: WEEK, codes: CLEAN, members: TEAM, requests: { "2026-10-02": { e: "C" } } });
  assert.equal(check(ignoredRequest, "permintaan").ok, false);

  const leaver = TEAM.map((member) => (member.id === "e" ? { ...member, activeUntil: "2026-10-06" } : member));
  const inactive = audit({ historyDates: HISTORY, historyCodes: {}, dates: WEEK, codes: CLEAN, members: leaver });
  assert.equal(check(inactive, "tidak-aktif").ok, false);
  assert.equal(check(inactive, "tidak-aktif").pelanggaran[0].tanggal, "2026-10-07");
});

test("violations are reported only inside the generated period", () => {
  const historyDates = eachDate("2026-09-23", "2026-09-30");
  const history = { d: ["1", "1", "1", "1", "1", "1", "H", "H"] };
  const pastProblem = audit({ historyDates, historyCodes: history, dates: WEEK, codes: CLEAN, members: TEAM });
  assert.equal(check(pastProblem, "maks-hari-kerja").ok, true);
  const intoOctober = audit({ historyDates: HISTORY, historyCodes: { d: ["1", "1"] }, dates: WEEK, codes: CLEAN, members: TEAM });
  assert.equal(check(intoOctober, "maks-hari-kerja").pelanggaran[0].tanggal, "2026-10-04");
});

test("after sick leave, no Shift 3 in the first days back unless it was asked for", () => {
  const sickBefore = audit({ historyDates: HISTORY, historyCodes: { a: ["S", "S"] }, dates: WEEK, codes: CLEAN, members: TEAM });
  const afterSick = check(sickBefore, "setelah-sakit");
  assert.equal(afterSick.ok, false);
  assert.equal(afterSick.pelanggaran[0].tanggal, "2026-10-01");
  assert.match(afterSick.pelanggaran[0].pesan, /Ani/);
  const asked = audit({ historyDates: HISTORY, historyCodes: { a: ["S", "S"] }, dates: WEEK, codes: CLEAN, members: TEAM, requests: { "2026-10-01": { a: "3" }, "2026-10-02": { a: "3" }, "2026-10-07": { a: "3" } } });
  assert.equal(check(asked, "setelah-sakit").ok, true, "a night the admin asked for is allowed");
});

test("a short sickness may have a shorter night-free period; a sickness of 3 days or more keeps the normal one", () => {
  const rules = { ...RULES, nightFreeDaysAfterShortSick: 0 };
  const short = audit({ historyDates: HISTORY, historyCodes: { a: ["S", "S"] }, dates: WEEK, codes: CLEAN, members: TEAM, rules });
  assert.equal(check(short, "setelah-sakit").ok, true, "2 days sick, 0 night-free days for a short sickness");
  const threeDays = ["2026-09-28", ...HISTORY];
  const long = audit({ historyDates: threeDays, historyCodes: { a: ["S", "S", "S"] }, dates: WEEK, codes: CLEAN, members: TEAM, rules });
  assert.equal(check(long, "setelah-sakit").ok, false, "3 days sick: the normal 5 days");
  assert.match(check(long, "setelah-sakit").pelanggaran[0].pesan, /5 hari/);
});

test("a leave day counts toward the 5-day limit and is not rest after nights (hand-edited roster)", () => {
  const streak = check(audit({ historyDates: HISTORY, historyCodes: {}, dates: WEEK, codes: withChange("d", 4, "C"), members: TEAM }), "maks-hari-kerja");
  assert.equal(streak.ok, false);
  assert.equal(streak.pelanggaran[0].tanggal, "2026-10-06");
  assert.match(streak.pelanggaran[0].pesan, /Dewi .*termasuk cuti/);
  const recovery = check(audit({ historyDates: HISTORY, historyCodes: {}, dates: WEEK, codes: withChange("a", 2, "C"), members: TEAM }), "istirahat-malam");
  assert.equal(recovery.ok, false);
  assert.equal(recovery.pelanggaran[0].tanggal, "2026-10-05");
});

test("a hand-edited 5 days + leave + work is reported, not a crash (the 6th day falls on the leave)", () => {
  const codes = { ...CLEAN, d: ["1", "1", "1", "1", "1", "C", "1"] };
  const streak = check(audit({ historyDates: HISTORY, historyCodes: {}, dates: WEEK, codes, members: TEAM }), "maks-hari-kerja");
  assert.equal(streak.ok, false);
  assert.equal(streak.pelanggaran.length, 1);
  assert.equal(streak.pelanggaran[0].anggota, "Dewi");
  assert.equal(streak.pelanggaran[0].tanggal, "2026-10-07");
  assert.match(streak.pelanggaran[0].pesan, /7 hari berturut-turut termasuk cuti/);
});
