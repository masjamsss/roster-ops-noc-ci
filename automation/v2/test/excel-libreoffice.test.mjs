// The Excel formulas, computed by a real spreadsheet program (LibreOffice):
// they must equal what the program cached, and must catch a manual edit that
// breaks a rule. Skipped when LibreOffice is not installed.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import ExcelJS from "exceljs";
import { makeConfig } from "../src/defaults.mjs";
import { generateRoster } from "../src/engine.mjs";
import { writeRosterWorkbook } from "../src/excel-export.mjs";
import { rollingStats } from "../src/history.mjs";
import { parseRosterCsv } from "../src/roster-csv.mjs";
import { findSoffice, recalculate } from "../tools/recalc.mjs";
import { verifyWorkbook } from "../tools/verify-excel.mjs";

const skip = findSoffice() ? false : "LibreOffice is not installed";
const september = parseRosterCsv(readFileSync(new URL("./fixtures/september-2026.csv", import.meta.url), "utf8"));
const history = {
  key: "2026-09", dates: september.dates, codesById: september.codesById, source: "csv",
  stats: rollingStats([{ key: "2026-09", dates: september.dates, codesById: september.codesById }], september.memberIds, ["1", "2", "3"])
};

async function octoberWorkbook() {
  const result = await generateRoster({ config: makeConfig({ year: 2026, month: 10, search: { beamWidth: 300 } }), calendars: [{ year: 2026, days: [] }], history });
  const file = path.join(await mkdtemp(path.join(tmpdir(), "roster-lo-")), "Roster Oktober 2026.xlsx");
  await writeRosterWorkbook(result, file, { holidayCalendars: [], holidayNotes: [], holidayDifferences: [], inputFile: "Data Roster.xlsx" });
  return { result, file };
}

const textOf = (value) => String(value?.result ?? value ?? "");

test("LibreOffice computes every formula exactly as the program cached it", { skip, timeout: 300_000 }, async () => {
  const { file } = await octoberWorkbook();
  const report = await verifyWorkbook(file);
  assert.ok(report.formulas > 3000, `${report.formulas} formulas`);
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.mismatches.slice(0, 5), []);
  assert.deepEqual(report.crossSheetColourRules, []);
});

test("a manual edit that breaks rules is caught by the Excel formulas (double validation)", { skip, timeout: 300_000 }, async () => {
  const { result, file } = await octoberWorkbook();
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(file);
  const roster = workbook.getWorksheet("Roster");
  // Hilvani (row 8, Shift 1/2 only) gets Shift 3 on 15 Oct (column C = 1 Oct).
  const cell = roster.getCell(8, 3 + 14);
  assert.equal(result.members[0].name, "Hilvani");
  cell.value = "3";
  await workbook.xlsx.writeFile(file);
  recalculate(file);
  const after = new ExcelJS.Workbook();
  await after.xlsx.readFile(file);
  const checks = after.getWorksheet("Pemeriksaan");
  let eligibility = null;
  checks.eachRow((row) => { if (textOf(row.getCell(2).value).startsWith("Setiap orang hanya mendapat shift")) eligibility = row; });
  assert.ok(eligibility, "the rule row exists");
  assert.match(textOf(eligibility.getCell(6).value), /^✖ Tidak/, "Excel: the rule is broken now");
  assert.match(textOf(eligibility.getCell(7).value), /^✔/, "program: fine when the roster was made");
  assert.equal(textOf(eligibility.getCell(8).value), "✖ Berbeda", "the difference is flagged");
  assert.match(textOf(after.getWorksheet("Ringkasan").getCell(5, 1).value), /^✖ Ada \d+ aturan/, "the Ringkasan conclusion follows");
});
