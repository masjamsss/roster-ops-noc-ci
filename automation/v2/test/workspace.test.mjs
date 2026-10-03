import assert from "node:assert/strict";
import { chmod, copyFile, mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import ExcelJS from "exceljs";
import { makeConfig } from "../src/defaults.mjs";
import { RosterError, explainFileError } from "../src/errors.mjs";
import { generateRoster } from "../src/engine.mjs";
import { writeRosterWorkbook } from "../src/excel-export.mjs";
import { archiveMonth, buildHistory, latestResultMonth, loadMonthCodes, monthFiles, workspacePaths } from "../src/workspace.mjs";

const SEPTEMBER = new URL("./fixtures/september-2026.csv", import.meta.url);

async function workspaceWithSeptember() {
  const root = await mkdtemp(path.join(tmpdir(), "roster-ws-"));
  const paths = workspacePaths(root);
  await mkdir(path.join(paths.resultsDir, "2026-09"), { recursive: true });
  await copyFile(SEPTEMBER, path.join(paths.resultsDir, "2026-09", "roster-2026-09.csv"));
  return paths;
}

test("the September seed CSV is found as the latest month and read as history", async () => {
  const paths = await workspaceWithSeptember();
  assert.equal(await latestResultMonth(paths), "2026-09");
  const history = await buildHistory(paths, "2026-10");
  assert.equal(history.source, "csv");
  assert.equal(history.key, "2026-09");
  assert.equal(history.dates.at(-1), "2026-09-30");
  assert.deepEqual(history.codesById.addin.slice(-4), ["1", "2", "2", "2"]);
});

test("a missing previous month stops with the month the admin must create first", async () => {
  const paths = await workspaceWithSeptember();
  await assert.rejects(buildHistory(paths, "2026-12"), (error) => error.name === "RosterError" && /November 2026/.test(error.message) && /hasil\/2026-11/.test(error.message));
});

test("an edited roster Excel wins over the JSON, and the swap is reported", async () => {
  const paths = await workspaceWithSeptember();
  const result = await generateRoster({
    config: makeConfig({ year: 2026, month: 10, search: { beamWidth: 300 } }),
    calendars: [{ year: 2026, days: [] }],
    history: await buildHistory(paths, "2026-10")
  });
  const files = monthFiles(paths, "2026-10");
  await mkdir(files.dir, { recursive: true });
  await writeFile(files.json, JSON.stringify(result));
  await writeRosterWorkbook(result, files.excel, {});
  const original = result.schedule.hilvani["2026-10-31"];
  const replacement = original === "H" ? "C" : "H";
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(files.excel);
  const sheet = workbook.getWorksheet("Roster");
  sheet.getCell(8, 3 + 30).value = replacement;
  await workbook.xlsx.writeFile(files.excel);

  const loaded = await loadMonthCodes(paths, "2026-10");
  assert.equal(loaded.source, "excel");
  assert.equal(loaded.codesById.hilvani.at(-1), replacement);
  assert.deepEqual(loaded.manualChanges.map((change) => [change.memberId, change.date, change.from, change.to]), [["hilvani", "2026-10-31", original, replacement]]);
  const history = await buildHistory(paths, "2026-11");
  assert.equal(history.codesById.hilvani.at(-1), replacement, "next month continues from the edited Excel");
});

test("archiving moves the current files into arsip/<local date and time>", async () => {
  const paths = await workspaceWithSeptember();
  const when = new Date("2026-09-29T10:11:12Z");
  const archived = await archiveMonth(paths, "2026-09", when);
  const two = (value) => String(value).padStart(2, "0");
  const local = `${when.getFullYear()}-${two(when.getMonth() + 1)}-${two(when.getDate())}_${two(when.getHours())}-${two(when.getMinutes())}-${two(when.getSeconds())}`;
  assert.equal(path.basename(archived), local, "the admin sees their own clock time, not UTC");
  assert.deepEqual(await readdir(path.join(paths.resultsDir, "2026-09")), ["arsip"]);
  assert.deepEqual(await readdir(archived), ["roster-2026-09.csv"]);
  assert.equal(await archiveMonth(paths, "2026-08"), null);
});

test("a roster file that is open (locked) stops the archive before anything is moved", async () => {
  const paths = await workspaceWithSeptember();
  const dir = path.join(paths.resultsDir, "2026-09");
  await writeFile(path.join(dir, "Roster September 2026.xlsx"), "x");
  // On Windows an open Excel file refuses write access; a read-only file behaves the same here.
  await chmod(path.join(dir, "Roster September 2026.xlsx"), 0o444);
  await assert.rejects(archiveMonth(paths, "2026-09"), (error) => error instanceof RosterError && /Roster September 2026\.xlsx/.test(error.message) && /tutup/i.test(error.message));
  assert.deepEqual((await readdir(dir)).sort(), ["Roster September 2026.xlsx", "roster-2026-09.csv"], "nothing was moved, no half-made arsip folder");
});

test("file-lock errors from Windows become a plain message; other errors stay program errors", () => {
  const locked = Object.assign(new Error("EBUSY: resource busy or locked, open 'C:\\Roster\\hasil\\2026-10\\Roster Oktober 2026.xlsx'"), { code: "EBUSY", path: "C:\\Roster\\hasil\\2026-10\\Roster Oktober 2026.xlsx" });
  const friendly = explainFileError(locked);
  assert.ok(friendly instanceof RosterError);
  assert.match(friendly.message, /Roster Oktober 2026\.xlsx/);
  assert.match(friendly.message, /sedang dibuka/);
  assert.equal(explainFileError(Object.assign(new Error("EPERM"), { code: "EPERM", path: "/x/Data Roster.xlsx" })).message.includes("Data Roster.xlsx"), true);
  assert.equal(explainFileError(Object.assign(new Error("gone"), { code: "ENOENT", path: "/x/a.xlsx" })), null);
  assert.equal(explainFileError(new TypeError("bug")), null);
});
