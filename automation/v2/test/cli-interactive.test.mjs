// The console as an admin uses it: answers are typed into the real menu.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ExcelJS from "exceljs";
import { buatRoster, siapkanData } from "../src/app.mjs";
import { readRosterWorkbook } from "../src/excel-read.mjs";
import { appendRequest, readInputWorkbook } from "../src/input-workbook.mjs";
import { workspacePaths } from "../src/workspace.mjs";

const CLI = fileURLToPath(new URL("../roster-cli.mjs", import.meta.url)); // .pathname is "/D:/..." on Windows
const HOLIDAYS = new URL("../../../pengaturan/hari-libur/", import.meta.url);

async function newRoot() {
  const root = await mkdtemp(path.join(tmpdir(), "roster-cli-"));
  const paths = workspacePaths(root);
  await mkdir(paths.holidaysDir, { recursive: true });
  for (const year of [2026, 2027]) await copyFile(new URL(`ID-${year}.json`, HOLIDAYS), path.join(paths.holidaysDir, `ID-${year}.json`));
  await mkdir(path.join(paths.resultsDir, "2026-09"), { recursive: true });
  await copyFile(new URL("./fixtures/september-2026.csv", import.meta.url), path.join(paths.resultsDir, "2026-09", "roster-2026-09.csv"));
  await writeFile(paths.advancedSettings, JSON.stringify({ search: { beamWidth: 400, portfolio: [{}] } }));
  await siapkanData({ root });
  return { root, paths };
}

function typeInto(root, lines) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, "menu", "--folder", root], { env: { ...process.env, WT_SESSION: "1" } });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (out += chunk));
    child.on("error", reject);
    child.on("close", () => resolve(out));
    child.stdin.end(`${lines.join("\n")}\n`);
  });
}

test("menu 8: a special request ('Hindari Shift 3') is added by question and answer", { timeout: 120_000 }, async () => {
  const { root, paths } = await newRoot();
  // 8 = request menu · 4 = Willy · 10 = Hindari Shift 3 · dates · note · Enter · 0 = exit
  const out = await typeInto(root, ["8", "4", "10", "05/10/2026", "07/10/2026", "kuliah malam", "", "0"]);
  assert.match(out, /Ditambahkan/, out);
  const input = await readInputWorkbook(paths.inputWorkbook);
  const request = input.requests.find((item) => item.name === "Willy");
  assert.deepEqual([request.code, request.from, request.to, request.note], ["!3", "2026-10-05", "2026-10-07", "kuliah malam"]);
});

test("menu 8: a shift the person may not work is refused in plain words and nothing is added", { timeout: 120_000 }, async () => {
  const { root, paths } = await newRoot();
  const out = await typeInto(root, ["8", "1", "7", "", "0"]); // Hilvani · Minta Shift 3
  assert.match(out, /Hilvani tidak boleh Shift 3/, out);
  assert.equal((await readInputWorkbook(paths.inputWorkbook)).requests.length, 0);
});

test("an impossible month: the console offers a temporary member from outside the team, then completes the roster", { timeout: 300_000 }, async () => {
  const { root, paths } = await newRoot();
  for (const name of ["Rizky", "Willy", "Arman", "Addin"]) await appendRequest(paths.inputWorkbook, { name, from: "2026-10-14", to: "2026-10-14", kind: "Cuti" });
  // 1 = make next month · y = confirm the review · 1 = add a temporary member · name · shifts · gender · until (Enter = default) · Enter · 0
  const out = await typeInto(root, ["1", "y", "1", "Doni", "3", "L", "", "", "0"]);
  assert.match(out, /Tidak ada susunan yang mungkin pada Rabu, 14 Oktober 2026/, out);
  assert.match(out, /anggota sementara/);
  assert.match(out, /Roster Oktober 2026 selesai/, out);
  const input = await readInputWorkbook(paths.inputWorkbook);
  const doni = input.members.find((member) => member.name === "Doni");
  assert.deepEqual([doni.eligibleShifts, doni.activeFrom, doni.activeUntil], [["3"], "2026-10-14", "2026-10-15"]);
});

test("rebuilding a month edited by hand: the console asks to lock the edits, and they stay", { timeout: 300_000 }, async () => {
  const { root } = await newRoot();
  const first = await buatRoster({ root, monthKey: "2026-10", online: false });
  const before = first.result.schedule.hilvani["2026-10-20"];
  const wanted = before === "H" ? "1" : "H";
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(first.files.excel);
  workbook.getWorksheet("Roster").getCell(8, 22).value = wanted; // Hilvani, 20 Oct
  await workbook.xlsx.writeFile(first.files.excel);
  // 2 = another month · month · y review · y rebuild · y lock · y keep · Enter · 0
  const out = await typeInto(root, ["2", "2026-10", "y", "y", "y", "y", "", "0"]);
  assert.match(out, /Kunci 1 perubahan manual/, out);
  assert.match(out, /1 perubahan manual dikunci/, out);
  const back = await readRosterWorkbook(first.files.excel);
  assert.equal(back.codesById.hilvani[back.dates.indexOf("2026-10-20")], wanted);
});
