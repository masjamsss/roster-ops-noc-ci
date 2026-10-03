import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import ExcelJS from "exceljs";
import { buatRoster, siapkanData } from "../src/app.mjs";
import { readRosterWorkbook } from "../src/excel-read.mjs";
import { createInputWorkbook, readInputWorkbook } from "../src/input-workbook.mjs";
import { monthFiles, workspacePaths } from "../src/workspace.mjs";

const HOLIDAYS = new URL("../../../pengaturan/hari-libur/", import.meta.url);
async function newRoot() {
  const root = await mkdtemp(path.join(tmpdir(), "roster-approval-"));
  const paths = workspacePaths(root);
  await mkdir(paths.holidaysDir, { recursive: true });
  await copyFile(new URL("ID-2026.json", HOLIDAYS), path.join(paths.holidaysDir, "ID-2026.json"));
  await mkdir(path.join(paths.resultsDir, "2026-09"), { recursive: true });
  await copyFile(new URL("./fixtures/september-2026.csv", import.meta.url), path.join(paths.resultsDir, "2026-09", "roster-2026-09.csv"));
  await writeFile(paths.advancedSettings, JSON.stringify({ search: { beamWidth: 400 } }));
  return { root, paths };
}
async function edit(file, change) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(file);
  change(workbook);
  await workbook.xlsx.writeFile(file);
}

test("the OM approval block: DRAF by default, DISETUJUI protects the month from silent regeneration", { timeout: 180_000 }, async () => {
  const { root, paths } = await newRoot();
  const { files } = await buatRoster({ root, monthKey: "2026-10", online: false });
  assert.equal((await readRosterWorkbook(files.excel)).approval, "DRAF");
  await edit(files.excel, (workbook) => {
    const sheet = workbook.getWorksheet("Ringkasan");
    sheet.eachRow((row) => row.eachCell((cell, column) => {
      if (cell.value === "Status roster") row.getCell(column + 2).value = "DISETUJUI";
    }));
  });
  assert.equal((await readRosterWorkbook(files.excel)).approval, "DISETUJUI");
  await assert.rejects(buatRoster({ root, monthKey: "2026-10", online: false }), (error) => error.details?.reason === "approved" && /DISETUJUI/.test(error.message));
  void paths;
});

test("backups from outside the team come from Data Roster.xlsx and appear in the Cadangan sheet", { timeout: 180_000 }, async () => {
  const { root, paths } = await newRoot();
  await siapkanData({ root });
  await edit(paths.inputWorkbook, (workbook) => {
    const sheet = workbook.getWorksheet("Cadangan Luar Tim");
    const row = sheet.getRow(5);
    row.getCell(2).value = "Doni";
    row.getCell(3).value = "NOC";
    for (const column of [4, 5, 6]) row.getCell(column).value = "Ya";
    row.getCell(7).value = "0812-0000-0000";
  });
  const input = await readInputWorkbook(paths.inputWorkbook);
  assert.deepEqual(input.externalBackups.map((item) => [item.name, item.origin, item.eligibleShifts]), [["Doni", "NOC", ["1", "2", "3"]]]);
  const { files, result } = await buatRoster({ root, monthKey: "2026-10", online: false });
  assert.deepEqual(result.externalBackups.map((item) => item.name), ["Doni"]);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(files.excel);
  const texts = [];
  workbook.getWorksheet("Cadangan").eachRow((row) => row.eachCell((cell) => typeof cell.value === "string" && texts.push(cell.value)));
  assert.ok(texts.some((text) => text.includes("Doni") && text.includes("0812")), "listed with contact");
  assert.ok(texts.some((text) => /luar tim: Doni/i.test(text)), "offered where the team has no backup");
  assert.ok(result.notes.some((note) => /Cadangan/.test(note) && /93/.test(note)), "resilience summary in the notes");
});

test("older Data Roster.xlsx without the new sheet still reads", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "roster-old-"));
  const file = path.join(dir, "Data Roster.xlsx");
  await createInputWorkbook(file);
  await edit(file, (workbook) => workbook.removeWorksheet(workbook.getWorksheet("Cadangan Luar Tim").id));
  assert.deepEqual((await readInputWorkbook(file)).externalBackups, []);
});
