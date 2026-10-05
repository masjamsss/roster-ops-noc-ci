import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import ExcelJS from "exceljs";
import { makeConfig } from "../src/defaults.mjs";
import { generateRoster } from "../src/engine.mjs";
import { writeRosterWorkbook, ROSTER_LAYOUT } from "../src/excel-export.mjs";
import { readRosterWorkbook } from "../src/excel-read.mjs";

const TEAM = [
  { id: "ani", name: "Ani", eligibleShifts: ["1", "2"] },
  { id: "bela", name: "Bela", eligibleShifts: ["1", "2"] },
  { id: "cahyo", name: "Cahyo", eligibleShifts: ["1", "2", "3"] },
  { id: "dodi", name: "Dodi", eligibleShifts: ["1", "2", "3"] },
  { id: "eko", name: "Eko", eligibleShifts: ["1", "2", "3"] },
  { id: "fajar", name: "Fajar", eligibleShifts: ["1", "2", "3"] }
];
const holidays = [{ year: 2026, status: "official-verified", days: [{ date: "2026-12-24", type: "collective_leave", name: "Cuti Bersama Natal" }, { date: "2026-12-25", type: "national", name: "Hari Raya Natal" }] }, { year: 2027, status: "official-verified", days: [] }];

let cached;
async function exported() {
  if (cached) return cached;
  const result = await generateRoster({ config: makeConfig({ year: 2026, month: 12, team: TEAM, search: { beamWidth: 300 } }), calendars: holidays, history: { dates: [], codesById: {} } });
  const dir = await mkdtemp(path.join(tmpdir(), "roster-excel-"));
  const file = path.join(dir, "Roster Desember 2026.xlsx");
  await writeRosterWorkbook(result, file, { holidayCalendars: holidays, holidayNotes: [], holidayDifferences: [], inputFile: "Data Roster.xlsx" });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(file);
  cached = { result, file, workbook };
  return cached;
}

test("the workbook has the Indonesian sheets in order, with the helper sheet hidden at the end", async () => {
  const { workbook } = await exported();
  assert.deepEqual(workbook.worksheets.map((sheet) => sheet.name), ["Roster", "Jadwal Harian", "Cadangan", "Ringkasan", "Pemeriksaan", "Hari Libur", "Info Admin", "Hitungan"]);
  assert.equal(workbook.getWorksheet("Hitungan").state, "hidden");
});

test("double validation: every check on the Pemeriksaan sheet is a formula, and on the new roster it agrees with the program", async () => {
  const { result, workbook } = await exported();
  const sheet = workbook.getWorksheet("Pemeriksaan");
  const verdicts = [];
  sheet.eachRow((row) => row.eachCell((cell) => {
    if (cell.value?.formula && /Sama|Berbeda/.test(String(cell.value.result))) verdicts.push(cell.value.result);
  }));
  assert.equal(verdicts.length, result.audit.checks.length + 9 + result.members.length, "one verdict per rule, quality check and person");
  assert.deepEqual([...new Set(verdicts)], ["✔ Sama"]);
  const ringkasan = workbook.getWorksheet("Ringkasan");
  const formulas = [];
  ringkasan.eachRow((row) => row.eachCell((cell) => { if (cell.value?.formula?.startsWith("Pemeriksaan!F")) formulas.push(cell.value.formula); }));
  assert.ok(formulas.length >= result.audit.checks.length + 9, "rule results and quality counts on the Ringkasan are formulas");
});

test("reading the Roster sheet back returns exactly the generated codes", async () => {
  const { result, file } = await exported();
  const read = await readRosterWorkbook(file);
  assert.equal(read.monthKey, "2026-12");
  assert.deepEqual(read.dates, Object.keys(result.schedule.ani));
  assert.deepEqual(read.members.map((member) => member.id), TEAM.map((member) => member.id));
  for (const member of TEAM) assert.deepEqual(read.codesById[member.id], Object.values(result.schedule[member.id]));
});

// exceljs writes a cached 0 as <v>0</v> (Excel and LibreOffice read it), but its
// own reader drops zero results, so read-back values need `?? 0`.
const cachedResult = (cell) => cell.value.result ?? 0;

test("totals and daily counts are live formulas whose cached values match the engine", async () => {
  const { result, workbook } = await exported();
  const sheet = workbook.getWorksheet("Roster");
  const layout = ROSTER_LAYOUT(31, TEAM.length);
  TEAM.forEach((member, index) => {
    const row = sheet.getRow(layout.firstMemberRow + index);
    const work = row.getCell(layout.totalsColumn).value;
    assert.ok(work.formula, "work days is a formula");
    assert.equal(work.result, result.memberSummary[member.id].workDays);
    assert.equal(cachedResult(row.getCell(layout.totalsColumn + 5)), result.memberSummary[member.id].shifts["3"]);
    assert.equal(cachedResult(row.getCell(layout.totalsColumn + 7)), result.memberSummary[member.id].holidayWorkDays);
  });
  const christmas = result.days.findIndex((day) => day.date === "2026-12-25");
  const countCell = sheet.getRow(layout.countRow).getCell(layout.firstDayColumn + christmas).value;
  assert.ok(countCell.formula);
  assert.equal(countCell.result ?? 0, result.days[christmas].counts["1"]);
  const status = sheet.getRow(layout.statusRow).getCell(layout.firstDayColumn + christmas).value;
  assert.equal(status.result, "OK");
});

test("Jadwal Harian names who is on each shift, from formulas", async () => {
  const { result, workbook } = await exported();
  const sheet = workbook.getWorksheet("Jadwal Harian");
  const first = sheet.getRow(5);
  const nightName = TEAM.find((member) => result.schedule[member.id]["2026-12-01"] === "3").name;
  assert.ok(first.getCell(6).value.formula);
  assert.equal(first.getCell(6).value.result, nightName);
});

test("Ringkasan starts with a plain conclusion and lists every rule check", async () => {
  const { result, workbook } = await exported();
  const sheet = workbook.getWorksheet("Ringkasan");
  const texts = [];
  sheet.eachRow((row) => row.eachCell((cell) => {
    if (typeof cell.value === "string") texts.push(cell.value);
    else if (typeof cell.value?.result === "string") texts.push(cell.value.result);
  }));
  assert.ok(texts.some((text) => text.startsWith("✔ Roster memenuhi semua aturan utama")));
  for (const check of result.audit.checks) assert.ok(texts.includes(check.judul), check.judul);
  for (const note of result.notes) assert.ok(texts.includes(note), note);
  for (const header of ["Target hari kerja", "Istirahat wajib setelah Shift 3", "Jam kerja bersih", "Jam kerja untuk HR", "Minggu di atas batas", "Jam kerja di tanggal merah", "Persetujuan", "Status roster"]) assert.ok(texts.includes(header), header);
  assert.ok(!texts.some((text) => /WATCH|critical|rolling/i.test(text)), "no English jargon");
});

// Excel (unlike LibreOffice) treats a colour rule that reads another sheet as
// damaged and "repairs" the file by deleting every colour rule on that sheet.
test("colour rules only read cells on their own sheet, so Excel keeps the shift colours", async () => {
  const { workbook } = await exported();
  const rules = workbook.worksheets.flatMap((sheet) => (sheet.conditionalFormattings ?? []).flatMap((block) =>
    block.rules.flatMap((rule) => (rule.formulae ?? []).map((formula) => ({ sheet: sheet.name, ref: block.ref, formula: String(formula) })))));
  assert.ok(rules.some((rule) => rule.sheet === "Roster"), "the Roster sheet has colour rules");
  assert.deepEqual(rules.filter((rule) => rule.formula.includes("!")), [], "no colour rule may refer to another sheet");

  const roster = workbook.getWorksheet("Roster");
  let statusAddress = null;
  roster.eachRow((row) => row.eachCell((cell) => {
    // The status box is merged; the first (top-left) cell carries the rules.
    if (!statusAddress && typeof cell.value?.formula === "string" && cell.value.formula.includes("Status roster: ")) statusAddress = cell.address;
  }));
  assert.ok(statusAddress, "the Roster sheet shows the approval status");
  const statusRules = rules.filter((rule) => rule.sheet === "Roster" && rule.ref === statusAddress);
  assert.equal(statusRules.length, 2, "one colour for DISETUJUI, one for not yet approved");
  assert.ok(statusRules.every((rule) => rule.formula.includes("DISETUJUI")));
});

test("Ringkasan shows each night person's Shift 3 and 3-night blocks over the last months, per available day", { timeout: 300_000 }, async () => {
  const { readFileSync } = await import("node:fs");
  const { parseRosterCsv } = await import("../src/roster-csv.mjs");
  const { rollingStats } = await import("../src/history.mjs");
  const september = parseRosterCsv(readFileSync(new URL("./fixtures/september-2026.csv", import.meta.url), "utf8"));
  const history = { key: "2026-09", dates: september.dates, codesById: september.codesById, source: "csv",
    stats: rollingStats([{ key: "2026-09", dates: september.dates, codesById: september.codesById }], september.memberIds, ["1", "2", "3"]) };
  const result = await generateRoster({ config: makeConfig({ year: 2026, month: 10, search: { beamWidth: 300 } }), calendars: [{ year: 2026, days: [] }], history });
  assert.deepEqual(result.fairness.months, ["2026-09", "2026-10"]);
  const addin = result.fairness.members.find((item) => item.id === "addin");
  assert.deepEqual(addin.months[0], { key: "2026-09", nights: 6, longBlocks: 2, availableDays: 14 }, "Addin: 16 days of cuti in September");
  assert.equal(addin.months[1].nights, result.memberSummary.addin.shifts["3"]);
  assert.ok(!result.fairness.members.some((item) => item.id === "hilvani"), "day-only members are not in the rotation");

  const dir = await mkdtemp(path.join(tmpdir(), "roster-fair-"));
  const file = path.join(dir, "Roster Oktober 2026.xlsx");
  await writeRosterWorkbook(result, file, { holidayCalendars: [], holidayNotes: [], holidayDifferences: [], inputFile: "Data Roster.xlsx" });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(file);
  const texts = [];
  workbook.getWorksheet("Ringkasan").eachRow((row) => row.eachCell((cell) => texts.push(String(cell.value?.result ?? cell.value?.formula ?? cell.value ?? ""))));
  assert.ok(texts.includes("Pembagian Shift 3 selama 3 bulan"), "heading");
  assert.ok(texts.includes("September 2026") && texts.includes("Oktober 2026"));
});

test("double validation understands 'Hindari Shift X': the Excel agrees with the program", { timeout: 300_000 }, async () => {
  const requests = [{ memberId: "cahyo", name: "Cahyo", from: "2026-12-07", to: "2026-12-11", code: "!3", kind: "Hindari Shift 3", source: "test" }];
  const result = await generateRoster({ config: makeConfig({ year: 2026, month: 12, team: TEAM, requests, search: { beamWidth: 300 } }), calendars: holidays, history: { dates: [], codesById: {} } });
  const dir = await mkdtemp(path.join(tmpdir(), "roster-avoid-"));
  const file = path.join(dir, "Roster Desember 2026.xlsx");
  await writeRosterWorkbook(result, file, { holidayCalendars: holidays, holidayNotes: [], holidayDifferences: [], inputFile: "Data Roster.xlsx" });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(file);
  const verdicts = [];
  workbook.getWorksheet("Pemeriksaan").eachRow((row) => row.eachCell((cell) => { if (/Sama|Berbeda/.test(String(cell.value?.result))) verdicts.push(cell.value.result); }));
  assert.deepEqual([...new Set(verdicts)], ["✔ Sama"]);
});

test("formulas and checks are locked against slips of the keyboard; the cells people fill in stay open; no password", async () => {
  const { workbook } = await exported();
  for (const sheet of workbook.worksheets) {
    assert.equal(sheet.sheetProtection?.sheet, true, `${sheet.name} is protected`);
    assert.equal(sheet.sheetProtection?.hashValue, undefined, `${sheet.name}: no password (Review → Unprotect Sheet)`);
  }
  const roster = workbook.getWorksheet("Roster");
  const codeCell = roster.getCell(8, 3);
  assert.equal(codeCell.protection?.locked, false, "a shift code can be swapped");
  let lockedFormula = null;
  roster.getRow(8).eachCell((cell) => { if (!lockedFormula && cell.value?.formula) lockedFormula = cell; });
  assert.ok(lockedFormula, "the row has formula totals");
  assert.notEqual(lockedFormula.protection?.locked, false, "a total is locked");
  const summary = workbook.getWorksheet("Ringkasan");
  let status = null;
  summary.eachRow((row) => row.eachCell((cell) => { if (String(cell.value) === "Status roster") status = summary.getCell(cell.row, 3); }));
  assert.equal(status?.protection?.locked, false, "the OM can set DISETUJUI");
  let verdicts = 0;
  workbook.getWorksheet("Pemeriksaan").eachRow((row) => row.eachCell((cell) => { if (/Sama/.test(String(cell.value?.result ?? "")) && cell.protection?.locked !== false) verdicts += 1; }));
  assert.ok(verdicts > 20, "the double-validation verdicts are locked");
});

test("the HR table shows hours above the daily limit as a live formula that follows swaps", async () => {
  const { workbook, result } = await exported();
  const summary = workbook.getWorksheet("Ringkasan");
  let header = null;
  summary.eachRow((row) => row.eachCell((cell) => { if (/^Jam di atas 8 jam\/hari/.test(String(cell.value))) header = cell; }));
  assert.ok(header, "column header");
  result.members.forEach((member, index) => {
    const cell = summary.getCell(Number(header.row) + 1 + index, Number(header.col));
    assert.match(cell.value.formula, /Roster!/, member.name);
    assert.equal(cell.value.result ?? 0, result.memberSummary[member.id].dailyHoursOver, member.name); // exceljs reads a cached 0 as empty
  });
  assert.ok(result.members.some((member) => result.memberSummary[member.id].dailyHoursOver > 0), "night workers have hours above the daily limit");
});
