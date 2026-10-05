import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import ExcelJS from "exceljs";
import { DEFAULT_COVERAGE, DEFAULT_RULES, DEFAULT_TEAM } from "../src/defaults.mjs";
import { appendMember, appendRequest, createInputWorkbook, INPUT_LAYOUT, readInputWorkbook, upgradeInputWorkbook } from "../src/input-workbook.mjs";
import { buildConfig } from "../src/settings.mjs";

async function freshWorkbook() {
  const dir = await mkdtemp(path.join(tmpdir(), "data-roster-"));
  const file = path.join(dir, "Data Roster.xlsx");
  await createInputWorkbook(file);
  return file;
}

async function edit(file, change) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(file);
  change(workbook);
  await workbook.xlsx.writeFile(file);
}

const date = (iso) => new Date(`${iso}T00:00:00Z`);
function addRequest(workbook, offset, values) {
  const sheet = workbook.getWorksheet(INPUT_LAYOUT.requests.sheet);
  const row = sheet.getRow(INPUT_LAYOUT.requests.firstRow + offset);
  const [name, from, to, kind, note] = values;
  row.getCell(2).value = name;
  row.getCell(3).value = from ? date(from) : null;
  row.getCell(4).value = to ? date(to) : null;
  row.getCell(5).value = kind;
  row.getCell(6).value = note ?? null;
}

test("a new workbook reads back as the current team, staffing and rules", async () => {
  const input = await readInputWorkbook(await freshWorkbook());
  assert.deepEqual(input.members.map((member) => [member.id, member.name, member.gender, member.eligibleShifts]), DEFAULT_TEAM.map((member) => [member.id, member.name, member.gender, member.eligibleShifts]));
  assert.deepEqual(input.requests, []);
  assert.deepEqual(input.coverage.weekday, DEFAULT_COVERAGE.weekday);
  assert.deepEqual(input.coverage.special, DEFAULT_COVERAGE.special);
  assert.equal(input.coverage.collectiveLeaveIsSpecial, true);
  for (const key of ["maxConsecutiveWorkDays", "maxConsecutiveOffDays", "minimumRestHours", "nightRecoveryOffDays", "balanceDayOnlyShifts", "workDaysTarget"]) {
    assert.deepEqual(input.rules[key], DEFAULT_RULES[key], key);
  }
  assert.deepEqual(input.rules.nightBlock, DEFAULT_RULES.nightBlock);
  assert.equal(input.shiftTimes["1"].start, "07:00");
});

test("leave rows become requests; the example row above the table is ignored", async () => {
  const file = await freshWorkbook();
  await edit(file, (workbook) => {
    addRequest(workbook, 0, ["addin", "2026-11-16", "2026-11-18", "Cuti", "Cuti tahunan"]);
    addRequest(workbook, 1, ["Willy", "2026-11-09", null, "Training/Dinas"]);
    addRequest(workbook, 2, ["Hilvani", "2026-11-20", "2026-11-20", "Minta Shift 1"]);
  });
  const { requests } = await readInputWorkbook(file);
  assert.deepEqual(requests.map((request) => [request.memberId, request.from, request.to, request.code]), [
    ["addin", "2026-11-16", "2026-11-18", "C"],
    ["willy", "2026-11-09", "2026-11-09", "T"],
    ["hilvani", "2026-11-20", "2026-11-20", "1"]
  ]);
  assert.match(requests[0].source, /Cuti & Permintaan" baris 6/);
});

test("mistakes in the leave sheet name the sheet, row and problem", async () => {
  const cases = [
    [["Adin", "2026-11-16", "2026-11-18", "Cuti"], /baris 6: nama "Adin" tidak ada di sheet Anggota/],
    [["Addin", "2026-11-18", "2026-11-16", "Cuti"], /baris 6: tanggal selesai .* sebelum tanggal mulai/],
    [["Addin", null, null, "Cuti"], /baris 6: tanggal mulai kosong/],
    [["Addin", "2026-11-16", "2026-11-18", "Liburan"], /baris 6: jenis "Liburan" tidak dikenal/]
  ];
  for (const [values, message] of cases) {
    const file = await freshWorkbook();
    await edit(file, (workbook) => addRequest(workbook, 0, values));
    await assert.rejects(readInputWorkbook(file), message);
  }
  const clash = await freshWorkbook();
  await edit(clash, (workbook) => {
    addRequest(workbook, 0, ["Addin", "2026-11-16", "2026-11-18", "Cuti"]);
    addRequest(workbook, 1, ["Addin", "2026-11-18", "2026-11-18", "Minta Shift 1"]);
  });
  await assert.rejects(readInputWorkbook(clash), /baris 7: bentrok dengan baris 6/);
});

test("members: exit date, newcomer without ID, and no allowed shift", async () => {
  const file = await freshWorkbook();
  await edit(file, (workbook) => {
    const sheet = workbook.getWorksheet(INPUT_LAYOUT.members.sheet);
    const willy = sheet.getRow(INPUT_LAYOUT.members.firstRow + 3);
    willy.getCell(9).value = date("2026-10-15");
    const newcomer = sheet.getRow(INPUT_LAYOUT.members.firstRow + 6);
    newcomer.getCell(2).value = "Budi Santoso";
    newcomer.getCell(4).value = "L";
    for (const column of [5, 6, 7]) newcomer.getCell(column).value = "Ya";
    newcomer.getCell(8).value = date("2026-11-01");
  });
  const { members } = await readInputWorkbook(file);
  assert.equal(members.find((member) => member.id === "willy").activeUntil, "2026-10-15");
  const budi = members.find((member) => member.name === "Budi Santoso");
  assert.equal(budi.id, "budi-santoso");
  assert.equal(budi.activeFrom, "2026-11-01");

  const none = await freshWorkbook();
  await edit(none, (workbook) => {
    const row = workbook.getWorksheet(INPUT_LAYOUT.members.sheet).getRow(INPUT_LAYOUT.members.firstRow);
    for (const column of [5, 6, 7]) row.getCell(column).value = "Tidak";
  });
  await assert.rejects(readInputWorkbook(none), /Hilvani tidak boleh shift apa pun/);
});

test("the Friday prayer rule is a Ya/Tidak row; workbooks made before it still read", async () => {
  const file = await freshWorkbook();
  assert.equal((await readInputWorkbook(file)).rules.fridayShift1Female, true);
  const setRow = (value) => (workbook) => {
    workbook.getWorksheet(INPUT_LAYOUT.rules.sheet).eachRow((row) => {
      if (String(row.getCell(1).value).startsWith("Jumat:")) {
        if (value === null) row.getCell(1).value = null;
        row.getCell(2).value = value;
      }
    });
  };
  await edit(file, setRow("Tidak"));
  assert.equal((await readInputWorkbook(file)).rules.fridayShift1Female, false);
  await edit(file, setRow(null));
  assert.equal((await readInputWorkbook(file)).rules.fridayShift1Female, true, "missing optional row falls back to the default");
});

test("rules outside their allowed range are rejected", async () => {
  const file = await freshWorkbook();
  await edit(file, (workbook) => {
    const sheet = workbook.getWorksheet(INPUT_LAYOUT.rules.sheet);
    sheet.eachRow((row) => {
      if (String(row.getCell(1).value).startsWith("Maksimal hari kerja berturut-turut")) row.getCell(2).value = 9;
    });
  });
  await assert.rejects(readInputWorkbook(file), /Maksimal hari kerja berturut-turut.*antara 3 dan 7/);
});

test("appendRequest adds a validated row, and rejects a bad one without changing the file", async () => {
  const file = await freshWorkbook();
  const added = await appendRequest(file, { name: "addin", from: "2026-11-16", to: "2026-11-18", kind: "Cuti", note: "Cuti tahunan" });
  assert.equal(added.row, INPUT_LAYOUT.requests.firstRow);
  const { requests } = await readInputWorkbook(file);
  assert.deepEqual(requests.map((request) => [request.name, request.from, request.to, request.code]), [["Addin", "2026-11-16", "2026-11-18", "C"]]);
  await assert.rejects(appendRequest(file, { name: "Adin", from: "2026-11-20", to: "2026-11-20", kind: "Cuti" }), /"Adin" tidak ada/);
  assert.equal((await readInputWorkbook(file)).requests.length, 1, "the bad row was not kept");
});

test("buildConfig keeps only members active in the month and maps requests", async () => {
  const file = await freshWorkbook();
  await edit(file, (workbook) => {
    const sheet = workbook.getWorksheet(INPUT_LAYOUT.members.sheet);
    sheet.getRow(INPUT_LAYOUT.members.firstRow + 3).getCell(9).value = date("2026-09-30");
    addRequest(workbook, 0, ["Addin", "2026-10-16", "2026-10-18", "Cuti"]);
    addRequest(workbook, 1, ["Addin", "2026-12-01", "2026-12-02", "Cuti"]);
  });
  const config = buildConfig({ input: await readInputWorkbook(file), advanced: {}, monthKey: "2026-10" });
  assert.deepEqual(config.members.map((member) => member.id), ["hilvani", "pavitasari", "rizky", "arman", "addin"]);
  assert.equal(config.period.year, 2026);
  assert.equal(config.period.month, 10);
  assert.equal(config.requests.length, 2, "rows outside the month stay; the engine ignores dates outside its horizon");
  assert.equal(config.members.find((member) => member.id === "hilvani").dayOnly, true);
});

test("the overtime row for the backup plan: 4 hours by default, the admin's value is used, older workbooks still read", async () => {
  const file = await freshWorkbook();
  const rowText = async () => {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(file);
    let value;
    workbook.getWorksheet(INPUT_LAYOUT.rules.sheet).eachRow((row) => { if (String(row.getCell(1).value).startsWith("Lembur maksimal")) value = row.getCell(2).value; });
    return value;
  };
  assert.equal(await rowText(), 4, "the template shows the default");
  assert.equal((await readInputWorkbook(file)).rules.overtimeHours, 4);
  const setRow = (value) => (workbook) => {
    workbook.getWorksheet(INPUT_LAYOUT.rules.sheet).eachRow((row) => {
      if (String(row.getCell(1).value).startsWith("Lembur maksimal")) {
        if (value === null) row.getCell(1).value = null;
        row.getCell(2).value = value;
      }
    });
  };
  await edit(file, setRow(3));
  assert.equal((await readInputWorkbook(file)).rules.overtimeHours, 3, "the admin's value is used");
  await edit(file, setRow(null));
  assert.equal((await readInputWorkbook(file)).rules.overtimeHours, 4, "missing optional row falls back to the default");
});

test("the Aturan sheet has a row for night-free days after sick leave (5 by default)", async () => {
  const file = await freshWorkbook();
  assert.equal((await readInputWorkbook(file)).rules.nightFreeDaysAfterSick, 5);
  await edit(file, (workbook) => {
    workbook.getWorksheet(INPUT_LAYOUT.rules.sheet).eachRow((row) => {
      if (String(row.getCell(1).value).startsWith("Hari tanpa Shift 3 setelah sakit")) row.getCell(2).value = 7;
    });
  });
  assert.equal((await readInputWorkbook(file)).rules.nightFreeDaysAfterSick, 7, "the admin's value is used");
});

test("the Aturan sheet has a row for counting leave as a work day (Ya by default)", async () => {
  const file = await freshWorkbook();
  assert.equal((await readInputWorkbook(file)).rules.leaveCountsAsWork, true);
  await edit(file, (workbook) => {
    workbook.getWorksheet(INPUT_LAYOUT.rules.sheet).eachRow((row) => {
      if (String(row.getCell(1).value).startsWith("Cuti dihitung hari kerja")) row.getCell(2).value = "Tidak";
    });
  });
  assert.equal((await readInputWorkbook(file)).rules.leaveCountsAsWork, false, "the admin can switch it off");
});

test("an older Data Roster.xlsx gets the newer Aturan rows added, with defaults, and the admin's values untouched", async () => {
  const file = await freshWorkbook();
  await edit(file, (workbook) => {
    const sheet = workbook.getWorksheet(INPUT_LAYOUT.rules.sheet);
    let leaveRow = null;
    sheet.eachRow((row, rowNumber) => {
      const label = String(row.getCell(1).value);
      if (label.startsWith("Cuti dihitung hari kerja")) leaveRow = rowNumber;
      if (label.startsWith("Batas jam kerja bersih per minggu")) row.getCell(2).value = 42;
    });
    sheet.spliceRows(leaveRow, 1);
  });
  assert.equal((await readInputWorkbook(file)).rules.weeklyHoursLimit, 42);
  const added = await upgradeInputWorkbook(file);
  assert.deepEqual(added.map((label) => label.slice(0, 24)), ["Cuti dihitung hari kerja"]);
  const input = await readInputWorkbook(file);
  assert.equal(input.rules.leaveCountsAsWork, true, "the new row holds the default");
  assert.equal(input.rules.weeklyHoursLimit, 42, "the admin's own value is kept");
  assert.deepEqual(await upgradeInputWorkbook(file), [], "nothing to add the second time");
});

test("an older Data Roster gets the newer request kinds in its 'Jenis' list (Hindari Shift 1/2/3)", async () => {
  const file = await freshWorkbook();
  const OLD = '"Cuti,Sakit,Training/Dinas,Minta libur,Minta Shift 1,Minta Shift 2,Minta Shift 3"';
  const kindCell = (workbook, offset) => workbook.getWorksheet(INPUT_LAYOUT.requests.sheet).getRow(INPUT_LAYOUT.requests.firstRow + offset).getCell(5);
  await edit(file, (workbook) => {
    for (let offset = 0; offset < INPUT_LAYOUT.requests.rows; offset += 1) kindCell(workbook, offset).dataValidation = { ...kindCell(workbook, offset).dataValidation, formulae: [OLD] };
  });
  const added = await upgradeInputWorkbook(file);
  assert.ok(added.some((label) => /Hindari Shift 3/.test(label)), added.join(" | "));
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(file);
  for (const offset of [0, INPUT_LAYOUT.requests.rows - 1]) assert.match(kindCell(workbook, offset).dataValidation.formulae[0], /Hindari Shift 1,Hindari Shift 2,Hindari Shift 3/);
  assert.deepEqual(await upgradeInputWorkbook(file), [], "nothing to change the second time");
});

// Row number of the Aturan row whose label starts with `start`.
function ruleRow(workbook, start) {
  let found = null;
  workbook.getWorksheet(INPUT_LAYOUT.rules.sheet).eachRow((row, rowNumber) => {
    if (found === null && String(row.getCell(1).value ?? "").startsWith(start)) found = rowNumber;
  });
  return found;
}
const SHORT_SICK = "Hari tanpa Shift 3 setelah sakit singkat";
const LONG_SICK = "Hari tanpa Shift 3 setelah sakit lama";
const HOURS_CAP = "Target hari kerja yang boleh Shift 3 mengikuti batas jam";

test("the Aturan sheet has the two choices of 5 Oct next to their related rows, with a dropdown or a number range, off by default", async () => {
  const file = await freshWorkbook();
  const input = await readInputWorkbook(file);
  assert.equal(input.rules.workDaysTargetHoursCap, false, "the same target for everyone unless chosen");
  assert.equal(input.rules.nightFreeDaysAfterShortSick, 5, "a short sickness the same as a long one unless chosen");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(file);
  const sheet = workbook.getWorksheet(INPUT_LAYOUT.rules.sheet);
  assert.equal(ruleRow(workbook, HOURS_CAP), ruleRow(workbook, "Target hari kerja per orang") + 1);
  assert.equal(ruleRow(workbook, SHORT_SICK), ruleRow(workbook, LONG_SICK) + 1);
  assert.deepEqual(sheet.getCell(ruleRow(workbook, HOURS_CAP), 2).dataValidation.formulae, ['"Ya,Tidak"']);
  const number = sheet.getCell(ruleRow(workbook, SHORT_SICK), 2).dataValidation;
  assert.deepEqual([number.type, number.formulae, number.showErrorMessage], ["whole", [0, 14], true]);
  await edit(file, (book) => {
    const rules = book.getWorksheet(INPUT_LAYOUT.rules.sheet);
    rules.getCell(ruleRow(book, HOURS_CAP), 2).value = "Ya";
    rules.getCell(ruleRow(book, SHORT_SICK), 2).value = 2;
  });
  const changed = await readInputWorkbook(file);
  assert.deepEqual([changed.rules.workDaysTargetHoursCap, changed.rules.nightFreeDaysAfterShortSick], [true, 2]);
  await edit(file, (book) => (book.getWorksheet(INPUT_LAYOUT.rules.sheet).getCell(ruleRow(book, SHORT_SICK), 2).value = 7));
  await assert.rejects(readInputWorkbook(file), /sakit singkat.*tidak boleh lebih besar/);
});

test("an older Data Roster.xlsx: the upgrade puts the new rows next to their related rows and keeps every value the admin typed", async () => {
  const file = await freshWorkbook();
  await edit(file, (workbook) => {
    const sheet = workbook.getWorksheet(INPUT_LAYOUT.rules.sheet);
    sheet.getCell(ruleRow(workbook, LONG_SICK), 2).value = 4;
    sheet.getCell(ruleRow(workbook, LONG_SICK), 1).value = "Hari tanpa Shift 3 setelah sakit"; // its name before 5 Oct
    sheet.getCell(ruleRow(workbook, "Batas jam kerja bersih per minggu"), 2).value = 42;
    sheet.spliceRows(ruleRow(workbook, SHORT_SICK), 1);
    sheet.spliceRows(ruleRow(workbook, HOURS_CAP), 1);
  });
  const added = await upgradeInputWorkbook(file);
  assert.equal(added.length, 2, added.join(" | "));
  const input = await readInputWorkbook(file);
  assert.deepEqual([input.rules.nightFreeDaysAfterSick, input.rules.weeklyHoursLimit], [4, 42], "the admin's values are kept");
  assert.deepEqual([input.rules.nightFreeDaysAfterShortSick, input.rules.workDaysTargetHoursCap], [4, false], "defaults: no change in behaviour");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(file);
  assert.equal(ruleRow(workbook, SHORT_SICK), ruleRow(workbook, LONG_SICK) + 1, "next to its related row");
  assert.equal(ruleRow(workbook, HOURS_CAP), ruleRow(workbook, "Target hari kerja per orang") + 1);
  // Every value cell carries the validation of its own row (no dropdown left over from the row that was there before).
  const sheet = workbook.getWorksheet(INPUT_LAYOUT.rules.sheet);
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber < 5 || !row.getCell(1).value) return;
    const limits = String(row.getCell(3).value);
    const validation = row.getCell(2).dataValidation;
    const expected = limits.startsWith("Ya / Tidak") ? "list" : /^\d+–\d+$/.test(limits) ? "whole" : undefined;
    assert.equal(validation?.type, expected, `${row.getCell(1).value}: ${JSON.stringify(validation)}`);
  });
  assert.deepEqual(await upgradeInputWorkbook(file), [], "nothing to change the second time");
});

test("the Aturan sheet has a row for 3-night blocks only when forced (Ya by default)", async () => {
  const file = await freshWorkbook();
  assert.equal((await readInputWorkbook(file)).rules.longNightBlockOnlyIfNeeded, true);
  await edit(file, (workbook) => {
    workbook.getWorksheet(INPUT_LAYOUT.rules.sheet).eachRow((row) => {
      if (String(row.getCell(1).value).startsWith("Blok 3 malam hanya bila terpaksa")) row.getCell(2).value = "Tidak";
    });
  });
  assert.equal((await readInputWorkbook(file)).rules.longNightBlockOnlyIfNeeded, false);
});

test("a temporary member from outside the team can be added for a few dates; a bad row leaves the file untouched", async () => {
  const file = await freshWorkbook();
  const added = await appendMember(file, { name: "Doni", gender: "L", shifts: ["3"], from: "2026-10-05", to: "2026-10-06" });
  const input = await readInputWorkbook(file);
  const doni = input.members.find((member) => member.name === "Doni");
  assert.ok(doni, `row ${added.row}`);
  assert.deepEqual(doni.eligibleShifts, ["3"]);
  assert.equal(doni.activeFrom, "2026-10-05");
  assert.equal(doni.activeUntil, "2026-10-06");
  const before = (await readInputWorkbook(file)).members.length;
  await assert.rejects(appendMember(file, { name: "Doni", gender: "L", shifts: ["3"], from: "2026-10-07", to: "2026-10-07" }), /ganda|sama dengan/);
  assert.equal((await readInputWorkbook(file)).members.length, before, "the duplicate was not kept");
});

test("the Aturan sheet has the daily hours limit for the HR overtime summary (8 by default), next to the weekly one", async () => {
  const file = await freshWorkbook();
  assert.equal((await readInputWorkbook(file)).rules.dailyHoursLimit, 8);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(file);
  const row = ruleRow(workbook, "Batas jam kerja bersih per hari");
  assert.equal(row, ruleRow(workbook, "Batas jam kerja bersih per minggu") + 1);
  assert.deepEqual(workbook.getWorksheet(INPUT_LAYOUT.rules.sheet).getCell(row, 2).dataValidation.formulae, [6, 12]);
  await edit(file, (book) => (book.getWorksheet(INPUT_LAYOUT.rules.sheet).getCell(ruleRow(book, "Batas jam kerja bersih per hari"), 2).value = 7));
  assert.equal((await readInputWorkbook(file)).rules.dailyHoursLimit, 7, "the 6-day scheme");
});
