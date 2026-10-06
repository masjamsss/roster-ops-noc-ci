import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import ExcelJS from "exceljs";
import { buatRoster, cekDampakPermintaan, cekRoster, nextMonthKey, periksaSistem, previewRoster, siapkanData } from "../src/app.mjs";
import { appendRequest } from "../src/input-workbook.mjs";
import { INPUT_LAYOUT } from "../src/input-workbook.mjs";
import { monthFiles, workspacePaths } from "../src/workspace.mjs";

const HOLIDAYS = new URL("../../../pengaturan/hari-libur/", import.meta.url);

async function newRoot() {
  const root = await mkdtemp(path.join(tmpdir(), "roster-app-"));
  const paths = workspacePaths(root);
  await mkdir(paths.holidaysDir, { recursive: true });
  for (const year of [2026, 2027]) await copyFile(new URL(`ID-${year}.json`, HOLIDAYS), path.join(paths.holidaysDir, `ID-${year}.json`));
  await mkdir(path.join(paths.resultsDir, "2026-09"), { recursive: true });
  await copyFile(new URL("./fixtures/september-2026.csv", import.meta.url), path.join(paths.resultsDir, "2026-09", "roster-2026-09.csv"));
  await writeFile(paths.advancedSettings, JSON.stringify({ search: { beamWidth: 400, diversePatience: 3, polishMs: 20_000 } }));
  return { root, paths };
}

async function editWorkbook(file, change) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(file);
  change(workbook);
  await workbook.xlsx.writeFile(file);
}

test("October → November → December chain from the September seed", { timeout: 300_000 }, async () => {
  const { root, paths } = await newRoot();
  assert.equal(await nextMonthKey({ root }), "2026-10");
  const october = await buatRoster({ root, online: false });
  assert.equal(october.key, "2026-10");
  assert.equal(october.result.audit.ok, true);
  const files = monthFiles(paths, "2026-10");
  for (const file of [files.excel, files.json, files.csv]) assert.ok(file.includes("2026-10"));
  assert.equal(await nextMonthKey({ root }), "2026-11");

  const november = await buatRoster({ root, online: false });
  const december = await buatRoster({ root, online: false });
  assert.equal(november.result.audit.ok, true);
  assert.equal(december.result.audit.ok, true);
  for (const date of ["2026-12-24", "2026-12-25"]) {
    const day = december.result.days.find((item) => item.date === date);
    assert.equal(day.isSpecial, true, `${date} is staffed like a public holiday`);
    assert.deepEqual(day.counts, { 1: 1, 2: 1, 3: 1 });
  }

  // A manual edit that breaks night recovery is caught by "cek".
  const armanRow = 8 + 4;
  await editWorkbook(files.excel, (workbook) => (workbook.getWorksheet("Roster").getCell(armanRow, 3).value = "1"));
  const check = await cekRoster({ root, monthKey: "2026-10" });
  assert.equal(check.ok, false);
  assert.equal(check.checks.find((item) => item.id === "istirahat-malam").ok, false);
  assert.equal(check.manualChanges.length, 1);

  // Regenerating an edited month needs confirmation, then archives the old version.
  await assert.rejects(buatRoster({ root, monthKey: "2026-10", online: false }), (error) => error.details?.needsConfirmation === true && /diubah manual/.test(error.message));
  const again = await buatRoster({ root, monthKey: "2026-10", online: false, force: true, now: new Date("2026-09-30T08:00:00") });
  assert.match(again.archived, /arsip/);
  assert.ok(again.warnings.some((warning) => /November 2026/.test(warning)), "warns that later months were built from the old October");
});

test("members can join and leave through Data Roster.xlsx", { timeout: 300_000 }, async () => {
  const { root, paths } = await newRoot();
  await siapkanData({ root });
  await buatRoster({ root, online: false });
  await editWorkbook(paths.inputWorkbook, (workbook) => {
    const sheet = workbook.getWorksheet(INPUT_LAYOUT.members.sheet);
    sheet.getRow(INPUT_LAYOUT.members.firstRow + 3).getCell(9).value = new Date("2026-11-15T00:00:00Z");
    const newcomer = sheet.getRow(INPUT_LAYOUT.members.firstRow + 6);
    newcomer.getCell(2).value = "Budi";
    newcomer.getCell(4).value = "L";
    for (const column of [5, 6, 7]) newcomer.getCell(column).value = "Ya";
    newcomer.getCell(8).value = new Date("2026-11-01T00:00:00Z");
  });
  const november = await buatRoster({ root, online: false });
  assert.equal(november.result.audit.ok, true, JSON.stringify(november.result.audit.checks.filter((item) => !item.ok), null, 1));
  assert.ok(november.result.members.some((member) => member.id === "budi"));
  assert.equal(november.result.schedule.willy["2026-11-16"], "-");
  assert.ok(Object.values(november.result.schedule.budi).some((code) => code === "3"), "the newcomer joins the night rotation");
});

test("the review before generating lists active agents, joiners, leavers, leave and holidays", { timeout: 120_000 }, async () => {
  const { root, paths } = await newRoot();
  await siapkanData({ root });
  await appendRequest(paths.inputWorkbook, { name: "Addin", from: "2026-12-16", to: "2026-12-18", kind: "Cuti", note: "Cuti tahunan" });
  await appendRequest(paths.inputWorkbook, { name: "Rizky", from: "2027-01-05", to: "2027-01-06", kind: "Cuti" });
  await editWorkbook(paths.inputWorkbook, (workbook) => {
    const sheet = workbook.getWorksheet(INPUT_LAYOUT.members.sheet);
    sheet.getRow(INPUT_LAYOUT.members.firstRow + 3).getCell(9).value = new Date("2026-12-15T00:00:00Z");
    const newcomer = sheet.getRow(INPUT_LAYOUT.members.firstRow + 6);
    newcomer.getCell(2).value = "Budi";
    newcomer.getCell(4).value = "L";
    for (const column of [5, 6, 7]) newcomer.getCell(column).value = "Ya";
    newcomer.getCell(8).value = new Date("2026-12-07T00:00:00Z");
  });
  const preview = await previewRoster({ root, monthKey: "2026-12", online: false });
  assert.equal(preview.label, "Desember 2026");
  assert.equal(preview.members.length, 7);
  assert.deepEqual(preview.joining.map((member) => member.name), ["Budi"]);
  assert.deepEqual(preview.leaving.map((member) => member.name), ["Willy"]);
  assert.deepEqual(preview.requests.map((request) => [request.name, request.kind, request.days]), [["Addin", "Cuti", 3]], "only leave inside the month");
  assert.deepEqual(preview.holidays.map((day) => day.date), ["2026-12-24", "2026-12-25"]);
  assert.match(preview.lines.join("\n"), /Addin — Cuti 16–18 Des \(3 hari\)/);
  // The choices of the Aturan sheet, in plain words, before anything is made.
  const text = preview.lines.join("\n");
  assert.match(text, /Pilihan di sheet Aturan/);
  assert.match(text, /Target yang boleh Shift 3: sama dengan yang lain/);
  assert.match(text, /Setelah sakit 3 hari atau lebih: tanpa Shift 3 selama 5 hari/);
  assert.match(text, /Setelah sakit 1–2 hari: tanpa Shift 3 selama 5 hari/);
});

test("buat roster in best-result mode tries the default variants and keeps the best", { timeout: 600_000 }, async () => {
  const { root } = await newRoot();
  const done = await buatRoster({ root, monthKey: "2026-10", online: false, best: true });
  assert.equal(done.result.audit.ok, true);
  assert.ok(done.result.search.portfolio.length > 6, "the normal search plus 5 variants, then attempts in other directions");
  assert.equal(done.result.search.portfolio.filter((entry) => entry.round === 0).length, 6);
  const ranked = [...done.result.search.portfolio].filter((entry) => !entry.failed).sort((a, b) => a.serious - b.serious || a.wlbLow - b.wlbLow || a.total - b.total);
  assert.equal(done.result.search.chosenVariant, ranked[0].variant, "fewest serious findings, then people below 65, then lowest score");
  assert.ok(done.result.search.confidence.attempts > 6);
});

test("updating an existing month after sudden sickness: past days frozen, few changes, changes visible in the Excel", { timeout: 600_000 }, async () => {
  const { root, paths } = await newRoot();
  await siapkanData({ root });
  const first = await buatRoster({ root, monthKey: "2026-10", online: false });
  await appendRequest(paths.inputWorkbook, { name: "Rizky", from: "2026-10-13", to: "2026-10-15", kind: "Sakit", note: "Rawat inap" });
  const updated = await buatRoster({ root, monthKey: "2026-10", online: false, force: true, keep: true, now: new Date("2026-10-12T08:00:00") });
  const before = first.result.schedule;
  const after = updated.result.schedule;
  for (const id of Object.keys(before)) {
    for (const date of Object.keys(before[id])) if (date < "2026-10-12") assert.equal(after[id][date], before[id][date], `${id} ${date} already worked: unchanged`);
  }
  assert.deepEqual(["2026-10-13", "2026-10-14", "2026-10-15"].map((date) => after.rizky[date]), ["S", "S", "S"]);
  assert.equal(updated.result.freezeBefore, "2026-10-12");
  assert.ok(updated.result.changes.length > 0 && updated.result.changes.length <= 40, `${updated.result.changes.length} changes`);
  assert.ok(updated.archived, "the previous version is archived");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(updated.files.excel);
  const texts = [];
  workbook.getWorksheet("Info Admin").eachRow((row) => row.eachCell((cell) => typeof cell.value === "string" && texts.push(cell.value)));
  assert.ok(texts.some((text) => /Perubahan dibanding versi sebelumnya/.test(text)), "Info Admin lists the changes");
  let notes = 0;
  workbook.getWorksheet("Roster").eachRow((row) => row.eachCell((cell) => { if (cell.note && /Sebelumnya/.test(JSON.stringify(cell.note))) notes += 1; }));
  assert.equal(notes, updated.result.changes.length, "each changed cell carries a note with the old code");
});

test("rebuilding freely still marks every change against the old version and never touches days already worked", { timeout: 600_000 }, async () => {
  const { root, paths } = await newRoot();
  await siapkanData({ root });
  const first = await buatRoster({ root, monthKey: "2026-10", online: false });
  await appendRequest(paths.inputWorkbook, { name: "Addin", from: "2026-10-20", to: "2026-10-22", kind: "Cuti", note: "Keluarga" });
  const rebuilt = await buatRoster({ root, monthKey: "2026-10", online: false, force: true, keep: false, now: new Date("2026-10-12T08:00:00") });
  for (const [id, row] of Object.entries(first.result.schedule)) {
    for (const [date, code] of Object.entries(row)) if (date < "2026-10-12") assert.equal(rebuilt.result.schedule[id][date], code, `${id} ${date} already worked: unchanged`);
  }
  assert.equal(rebuilt.result.freezeBefore, "2026-10-12");
  assert.ok(rebuilt.result.changes.length > 0, "changes against the old version are listed");
  assert.ok(rebuilt.result.changes.every((change) => change.date >= "2026-10-12"));
  assert.ok(rebuilt.result.notes.some((note) => /disusun ulang/.test(note) && !/dipertahankan/.test(note)), rebuilt.result.notes[0]);
});

test("updating in best mode also tries a lighter and a stronger 'keep' setting", { timeout: 900_000 }, async () => {
  const { root, paths } = await newRoot();
  await siapkanData({ root });
  await buatRoster({ root, monthKey: "2026-10", online: false });
  await appendRequest(paths.inputWorkbook, { name: "Willy", from: "2026-10-20", to: "2026-10-21", kind: "Cuti" });
  const done = await buatRoster({ root, monthKey: "2026-10", online: false, force: true, keep: true, best: true, now: new Date("2026-10-15T08:00:00") });
  assert.equal(done.result.search.portfolio.filter((entry) => entry.round === 0).length, 8, "6 search variants + 2 keep strengths");
  assert.ok(done.result.search.portfolio.filter((entry) => entry.round > 0).every((entry) => entry.aim?.length), "any extra attempt says what it aimed at");
  assert.equal(done.result.audit.ok, true);
});

test("an older Data Roster.xlsx is completed automatically and the admin is told", { timeout: 120_000 }, async () => {
  const { root, paths } = await newRoot();
  await siapkanData({ root });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(paths.inputWorkbook);
  const sheet = workbook.getWorksheet("Aturan");
  let leaveRow = null;
  sheet.eachRow((row, rowNumber) => { if (String(row.getCell(1).value).startsWith("Cuti dihitung hari kerja")) leaveRow = rowNumber; });
  sheet.spliceRows(leaveRow, 1);
  await workbook.xlsx.writeFile(paths.inputWorkbook);
  const preview = await previewRoster({ root, monthKey: "2026-10", online: false });
  assert.ok(preview.lines.some((line) => /dilengkapi baris baru di sheet Aturan: "Cuti dihitung hari kerja/.test(line)), preview.lines.join("\n"));
  assert.deepEqual((await siapkanData({ root })).upgraded, [], "only once");
});

test("the readiness check says in plain words what is in place and what is missing", { timeout: 120_000 }, async () => {
  const { root } = await newRoot();
  const report = await periksaSistem({ root, now: new Date("2026-09-30T08:00:00") });
  assert.equal(report.key, "2026-10");
  const text = report.items.map((item) => `${item.level}: ${item.text}`).join("\n");
  assert.match(text, /ok: Node\.js/);
  assert.match(text, /ok: Roster September 2026 ada/);
  assert.match(text, /Data Roster\.xlsx/);
  assert.match(text, /ok: Data hari libur 2026: resmi/);
  assert.match(text, /ok: Folder hasil bisa ditulis/);
  assert.equal(report.ok, true, text);

  const empty = await mkdtemp(path.join(tmpdir(), "roster-empty-"));
  const bad = await periksaSistem({ root: empty, now: new Date("2026-09-30T08:00:00") });
  assert.equal(bad.ok, false);
  assert.ok(bad.items.some((item) => item.level === "masalah" && /belum ada/.test(item.text)), bad.items.map((item) => item.text).join("\n"));
});

test("lock the manual edits and fill the rest: the admin's change stays, everything else is rearranged around it", { timeout: 600_000 }, async () => {
  const { root } = await newRoot();
  await siapkanData({ root });
  const first = await buatRoster({ root, monthKey: "2026-10", online: false });
  // Hilvani (row 8) gets 15 Oct off by hand (column C = 1 Oct, so 15 Oct = column 17).
  const working = first.result.schedule.hilvani["2026-10-15"];
  assert.notEqual(working, "H", "she was working that day");
  await editWorkbook(first.files.excel, (workbook) => (workbook.getWorksheet("Roster").getCell(8, 17).value = "H"));
  const filled = await buatRoster({ root, monthKey: "2026-10", online: false, force: true, keep: true, lockManual: true, now: new Date("2026-09-30T08:00:00") });
  assert.equal(filled.result.schedule.hilvani["2026-10-15"], "H", "the manual change is kept");
  assert.equal(filled.result.audit.ok, true, "every rule holds around it");
  assert.equal(filled.locked, 1);
  assert.ok(filled.warnings.some((warning) => /1 perubahan manual dikunci/.test(warning)), filled.warnings.join("\n"));
});

test("lock the manual edits: the console is told how many there are, and a newer request for the same day wins over the old edit", { timeout: 600_000 }, async () => {
  const { root } = await newRoot();
  await siapkanData({ root });
  const first = await buatRoster({ root, monthKey: "2026-10", online: false });
  await editWorkbook(first.files.excel, (workbook) => (workbook.getWorksheet("Roster").getCell(8, 17).value = "H"));
  await assert.rejects(buatRoster({ root, monthKey: "2026-10", online: false }), (error) => error.details?.reason === "edited" && error.details.manualCount === 1);
  // Later Hilvani asks to work Shift 1 that day: the request is newer than the edit.
  await appendRequest(workspacePaths(root).inputWorkbook, { name: "Hilvani", from: "2026-10-15", to: "2026-10-15", kind: "Minta Shift 1" });
  const filled = await buatRoster({ root, monthKey: "2026-10", online: false, force: true, keep: true, lockManual: true, now: new Date("2026-09-30T08:00:00") });
  assert.equal(filled.result.schedule.hilvani["2026-10-15"], "1");
  assert.equal(filled.locked, 0);
  assert.ok(filled.warnings.some((warning) => /1 perubahan manual tidak dikunci/.test(warning)), filled.warnings.join("\n"));
});

test("before leave is saved, its impact is checked: still possible, or why not", { timeout: 120_000 }, async () => {
  const { root, paths } = await newRoot();
  await siapkanData({ root });
  for (const name of ["Rizky", "Willy"]) await appendRequest(paths.inputWorkbook, { name, from: "2026-10-13", to: "2026-10-16", kind: "Cuti" });
  const fine = await cekDampakPermintaan({ root, request: { memberId: "hilvani", name: "Hilvani", from: "2026-10-20", to: "2026-10-21", code: "C", kind: "Cuti" } });
  assert.deepEqual(fine.map((item) => [item.key, item.ok]), [["2026-10", true]]);
  const started = Date.now();
  const blocked = await cekDampakPermintaan({ root, request: { memberId: "arman", name: "Arman", from: "2026-10-13", to: "2026-10-16", code: "C", kind: "Cuti" } });
  assert.equal(blocked[0].ok, false);
  assert.match(blocked[0].reason, /Shift 3 tidak mungkin terisi/);
  assert.equal(blocked[0].date, "2026-10-16");
  assert.ok(blocked[0].suggestions.some((text) => /Bisa bila .*dimulai/.test(text)), blocked[0].suggestions.join("\n"));
  assert.ok(blocked[0].suggestions.some((text) => /orang luar tim/.test(text)), blocked[0].suggestions.join("\n"));
  assert.ok(Date.now() - started < 30_000, "an answer within seconds");
  const unknown = await cekDampakPermintaan({ root, request: { memberId: "arman", name: "Arman", from: "2026-12-01", to: "2026-12-02", code: "C", kind: "Cuti" } });
  assert.equal(unknown[0].ok, null, "December cannot be checked before November exists");
  assert.match(unknown[0].reason, /belum bisa dicek/);
});

test("the readiness check also reminds: no backups outside the team, next month not made after the 20th, this month not approved yet", { timeout: 300_000 }, async () => {
  const { root } = await newRoot();
  await siapkanData({ root });
  await buatRoster({ root, monthKey: "2026-10", online: false });
  const late = await periksaSistem({ root, now: new Date("2026-10-22T08:00:00") });
  const text = late.items.map((item) => `${item.level}: ${item.text}`).join("\n");
  assert.match(text, /perhatian: Sheet Cadangan Luar Tim masih kosong/);
  assert.match(text, /perhatian: Roster November 2026 belum dibuat/);
  assert.match(text, /perhatian: Roster Oktober 2026 belum disetujui/);
  assert.equal(late.ok, true, "reminders, not problems");
  const early = await periksaSistem({ root, now: new Date("2026-10-05T08:00:00") });
  assert.ok(!early.items.some((item) => /November 2026 belum dibuat/.test(item.text)), "before the 20th it is not due yet");
});
