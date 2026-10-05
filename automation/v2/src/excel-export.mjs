// The roster workbook for the admin and the Operations Manager (Bahasa Indonesia).
// Totals, daily counts, status and the daily list are live formulas, and colors
// come from conditional formatting, so a manual swap in the Roster sheet updates
// everything. Formula results are also cached so previews show numbers.
import ExcelJS from "exceljs";
import { checkSheets, checksSheet, QUALITY_CHECKS } from "./excel-checks.mjs";
import { formatPeriode, formatTanggal, HARI, KODE_LABEL, namaBulan, namaHari, namaHariPendek } from "./labels-id.mjs";

const FONT = "Arial";
const C = {
  navy: "FF17324D", white: "FFFFFFFF", note: "FF595959", border: "FFBFBFBF", weekend: "FFF2F2F2", holiday: "FFFCE4E4",
  okFill: "FFC6EFCE", okText: "FF006100", warnFill: "FFFFEB9C", warnText: "FF9C5700", badFill: "FFFFC7CE", badText: "FF9C0006"
};
// The team's familiar roster colours (from their live September workbook):
// 1 yellow, 2 cyan, 3 black, H pink, C coral. S, T and "-" follow the same style.
export const CODE_STYLE = Object.freeze({
  "1": { fill: "FFFFF200", font: "FF111827", bold: true },
  "2": { fill: "FF22D3EE", font: "FF111827", bold: true },
  "3": { fill: "FF111827", font: "FFFFFFFF", bold: true },
  H: { fill: "FFFECACA", font: "FF991B1B", bold: true },
  C: { fill: "FFF87171", font: "FFFFFFFF", bold: true },
  S: { fill: "FFFB923C", font: "FFFFFFFF", bold: true },
  T: { fill: "FF7E57C2", font: "FFFFFFFF", bold: true },
  "-": { fill: "FFD1D5DB", font: "FF6B7280" }
});
const HEADER = Object.freeze({ day: "FF244A66", weekend: "FF0F6B78", holiday: "FF8B1E1E" });
const thin = { style: "thin", color: { argb: C.border } };
const box = { top: thin, left: thin, bottom: thin, right: thin };
const TOTALS = ["Hari Kerja", "Libur (H)", "Cuti / Sakit / Training", "Shift 1", "Shift 2", "Shift 3", "Kerja Sabtu / Minggu", "Kerja Tgl Merah"];

export function columnLetter(index) {
  let letters = "";
  for (let n = index; n > 0; n = Math.floor((n - 1) / 26)) letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters;
  return letters;
}

export const ROSTER_LAYOUT = (dayCount, memberCount) => {
  const firstMemberRow = 8;
  const lastMemberRow = firstMemberRow + memberCount - 1;
  const countRow = lastMemberRow + 2;
  const statusRow = countRow + 3;
  const helperRow = statusRow + 3;
  const firstDayColumn = 3;
  const lastDayColumn = firstDayColumn + dayCount - 1;
  const totalsColumn = lastDayColumn + 1;
  return {
    titleRow: 1, subtitleRow: 2, legendRow: 3, holidayRow: 5, weekdayRow: 6, headerRow: 7,
    firstMemberRow, lastMemberRow, countRow, statusRow, statusNoteRow: statusRow + 1,
    helperRow, weekendRow: helperRow + 1, holidayFlagRow: helperRow + 2, specialRow: helperRow + 3,
    firstDayColumn, lastDayColumn, totalsColumn, idColumn: totalsColumn + TOTALS.length
  };
};

const fill = (argb) => ({ type: "pattern", pattern: "solid", fgColor: { argb } });

function setCell(cell, value, { bold = false, size = 10, color, bg, align = "center", wrap = false, numFmt, italic = false, border = true } = {}) {
  cell.value = value;
  cell.font = { name: FONT, size, bold, italic, ...(color ? { color: { argb: color } } : {}) };
  cell.alignment = { horizontal: align, vertical: "middle", wrapText: wrap };
  if (bg) cell.fill = fill(bg);
  if (numFmt) cell.numFmt = numFmt;
  if (border) cell.border = box;
}

function title(sheet, text, subtitle, lastColumn, subtitleLastColumn = lastColumn) {
  sheet.mergeCells(1, 1, 1, lastColumn);
  setCell(sheet.getCell(1, 1), text, { bold: true, size: 15, color: C.navy, align: "left", border: false });
  sheet.getRow(1).height = 26;
  if (subtitle) {
    sheet.mergeCells(2, 1, 2, subtitleLastColumn);
    setCell(sheet.getCell(2, 1), subtitle, { size: 10, italic: true, color: C.note, align: "left", border: false, wrap: true });
    sheet.getRow(2).height = subtitle.length > 110 ? 28 : 16;
  }
}

function heading(sheet, row, text, lastColumn) {
  sheet.mergeCells(row, 1, row, lastColumn);
  setCell(sheet.getCell(row, 1), text, { bold: true, size: 12, color: C.navy, align: "left", border: false });
  sheet.getRow(row).height = 20;
}

function headerCells(row, columns) {
  for (const column of columns) {
    const cell = row.getCell(column);
    cell.font = { name: FONT, size: 10, bold: true, color: { argb: C.white } };
    cell.fill = fill(C.navy);
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    cell.border = box;
  }
}

function paragraph(sheet, row, text, lastColumn, options = {}) {
  sheet.mergeCells(row, 1, row, lastColumn);
  setCell(sheet.getCell(row, 1), text, { align: "left", wrap: true, border: false, size: 10, ...options });
  sheet.getRow(row).height = Math.max(16, 15 * Math.ceil(String(text).length / (options.charsPerLine ?? 130)));
}

function holidayShort(holiday) {
  return holiday.type === "national" ? "Libur" : "Cuti Bsm";
}

function monthTitle(result) {
  return `${namaBulan(result.period.month)} ${result.period.year}`;
}

function createdText(date) {
  const local = new Date(date);
  const pad = (value) => String(value).padStart(2, "0");
  return `${local.getDate()} ${namaBulan(local.getMonth() + 1).slice(0, 3)} ${local.getFullYear()} pukul ${pad(local.getHours())}:${pad(local.getMinutes())}`;
}

// ---------------- Roster ----------------

function rosterSheet(workbook, result) {
  const sheet = workbook.addWorksheet("Roster", {
    views: [{ state: "frozen", xSplit: 2, ySplit: 7, zoomScale: 100 }],
    pageSetup: { orientation: "landscape", paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0, margins: { left: 0.3, right: 0.3, top: 0.4, bottom: 0.4, header: 0.2, footer: 0.2 } }
  });
  const members = result.members;
  const days = result.days;
  const L = ROSTER_LAYOUT(days.length, members.length);
  const lastColumn = L.totalsColumn + TOTALS.length - 1;
  const dayLetter = (index) => columnLetter(L.firstDayColumn + index);
  const firstLetter = dayLetter(0);
  const lastLetter = dayLetter(days.length - 1);
  const settings = result.settings.coverage;

  sheet.getColumn(1).width = 4;
  sheet.getColumn(2).width = 15;
  for (let index = 0; index < days.length; index += 1) sheet.getColumn(L.firstDayColumn + index).width = 4.4;
  for (let index = 0; index < TOTALS.length; index += 1) sheet.getColumn(L.totalsColumn + index).width = 8.6;
  sheet.getColumn(L.idColumn).width = 12;
  sheet.getColumn(L.idColumn).hidden = true;

  title(sheet, `ROSTER SHIFT TIM OPS + NOC — ${monthTitle(result).toUpperCase()}`,
    `Periode ${formatPeriode(result.period.start, result.period.end)} ${result.period.year}  ·  Dibuat ${createdText(result.generatedAt)}  ·  Persetujuan: lihat sheet Ringkasan`, lastColumn, L.lastDayColumn);
  sheet.mergeCells(2, L.totalsColumn, 2, lastColumn);

  // Legend
  const legend = [...result.shifts.map((shift) => [shift.id, `${shift.name} ${shift.start}–${shift.end}`]), ["H", "Libur"], ["C", "Cuti"], ["S", "Sakit"], ["T", "Training/Dinas"], ["-", "Tidak aktif"]];
  setCell(sheet.getCell(L.legendRow, 2), "Keterangan:", { bold: true, align: "left", border: false });
  let legendColumn = L.firstDayColumn;
  legend.forEach(([code, label]) => {
    const style = CODE_STYLE[code];
    const labelWidth = result.shifts.some((shift) => shift.id === code) ? 4 : code === "T" ? 3 : 2;
    setCell(sheet.getCell(L.legendRow, legendColumn), code, { bold: true, color: style.font, bg: style.fill ?? C.weekend });
    sheet.mergeCells(L.legendRow, legendColumn + 1, L.legendRow, legendColumn + labelWidth);
    setCell(sheet.getCell(L.legendRow, legendColumn + 1), label, { align: "left", size: 9, border: false });
    legendColumn += labelWidth + 1;
  });
  sheet.getRow(L.legendRow).height = 18;

  // Headers
  setCell(sheet.getCell(L.holidayRow, 2), "Tanggal merah", { size: 8, italic: true, color: C.note, align: "left", border: false });
  setCell(sheet.getCell(L.weekdayRow, 2), "Hari", { size: 9, color: C.note, align: "left", border: false });
  setCell(sheet.getCell(L.headerRow, 1), "No", { bold: true, color: C.white, bg: HEADER.day });
  setCell(sheet.getCell(L.headerRow, 2), "Nama", { bold: true, color: C.white, bg: HEADER.day, align: "left" });
  days.forEach((day, index) => {
    const column = L.firstDayColumn + index;
    const shade = day.isHoliday ? C.holiday : day.isWeekend ? C.weekend : null;
    if (day.holiday) {
      setCell(sheet.getCell(L.holidayRow, column), holidayShort(day.holiday), { size: 7, bold: true, color: C.badText, bg: C.holiday });
      sheet.getCell(L.holidayRow, column).note = `${day.holiday.name}${day.holiday.tentative ? " (tanggal belum pasti)" : ""}`;
    }
    setCell(sheet.getCell(L.weekdayRow, column), namaHariPendek(day.date), { size: 8, bold: day.isWeekend || day.isHoliday, color: day.isHoliday ? C.badText : C.note, bg: shade });
    setCell(sheet.getCell(L.headerRow, column), Number(day.date.slice(8, 10)), { bold: true, color: C.white, bg: day.isHoliday ? HEADER.holiday : day.isWeekend ? HEADER.weekend : HEADER.day });
  });
  TOTALS.forEach((label, index) => setCell(sheet.getCell(L.headerRow, L.totalsColumn + index), label, { bold: true, size: 8, color: C.white, bg: HEADER.day, wrap: true }));
  sheet.mergeCells(L.holidayRow, L.totalsColumn, L.weekdayRow, L.totalsColumn + TOTALS.length - 1);
  setCell(sheet.getCell(L.holidayRow, L.totalsColumn), "Jumlah bulan ini (otomatis)", { bold: true, size: 9, color: C.navy, bg: C.weekend });
  setCell(sheet.getCell(L.headerRow, L.idColumn), "ID", { size: 8 });
  sheet.getRow(L.headerRow).height = 32;

  // Member rows
  members.forEach((member, index) => {
    const rowNumber = L.firstMemberRow + index;
    const row = sheet.getRow(rowNumber);
    row.height = 19;
    const changed = new Map((result.changes ?? []).map((change) => [`${change.memberId}|${change.date}`, change]));
    setCell(row.getCell(1), index + 1, { color: C.note });
    setCell(row.getCell(2), member.name, { bold: true, align: "left" });
    days.forEach((day, dayIndex) => {
      const cell = row.getCell(L.firstDayColumn + dayIndex);
      const shade = day.isHoliday ? C.holiday : day.isWeekend ? C.weekend : null;
      setCell(cell, result.schedule[member.id][day.date], { size: 10, bg: shade, numFmt: "@" });
      const change = changed.get(`${member.id}|${day.date}`);
      if (change) cell.note = `Sebelumnya: ${KODE_LABEL[change.from] ?? change.from}`;
      cell.dataValidation = {
        type: "list", allowBlank: true, showErrorMessage: true, errorTitle: "Kode tidak dikenal",
        error: "Pakai salah satu kode: 1, 2, 3, H, C, S, T, -", formulae: ['"1,2,3,H,C,S,T,-"']
      };
    });
    const range = `${firstLetter}${rowNumber}:${lastLetter}${rowNumber}`;
    const count = (code) => `SUMPRODUCT(--(${range}&""="${code}"))`;
    const onFlag = (flagRow) => `SUMPRODUCT((${firstLetter}$${flagRow}:${lastLetter}$${flagRow}=1)*((${range}&""="1")+(${range}&""="2")+(${range}&""="3")))`;
    const summary = result.memberSummary[member.id];
    const totals = [
      [`${count("1")}+${count("2")}+${count("3")}`, summary.workDays],
      [count("H"), summary.offDays],
      [`${count("C")}+${count("S")}+${count("T")}`, summary.leaveDays + summary.sickDays + summary.trainingDays],
      [count("1"), summary.shifts["1"]],
      [count("2"), summary.shifts["2"]],
      [count("3"), summary.shifts["3"]],
      [onFlag(L.weekendRow), summary.weekendWorkDays],
      [onFlag(L.holidayFlagRow), summary.holidayWorkDays]
    ];
    totals.forEach(([formula, value], offset) => setCell(row.getCell(L.totalsColumn + offset), { formula, result: value }, { bold: offset === 0, bg: offset === 0 ? "FFDDEBF7" : null }));
    setCell(row.getCell(L.idColumn), member.id, { size: 8, color: C.note });
  });

  // Daily counts and status
  const labels = [`Jumlah ${result.shifts[0].label}`, `Jumlah ${result.shifts[1].label}`, `Jumlah ${result.shifts[2].label}`];
  labels.forEach((label, offset) => setCell(sheet.getCell(L.countRow + offset, 2), label, { bold: true, size: 9, align: "left" }));
  setCell(sheet.getCell(L.statusRow, 2), "Status hari", { bold: true, size: 9, align: "left" });
  days.forEach((day, index) => {
    const letter = dayLetter(index);
    result.shifts.forEach((shift, offset) => {
      const formula = `SUMPRODUCT(--(${letter}$${L.firstMemberRow}:${letter}$${L.lastMemberRow}&""="${shift.id}"))`;
      setCell(sheet.getCell(L.countRow + offset, L.firstDayColumn + index), { formula, result: day.counts[shift.id] }, { size: 9 });
    });
    const [c1, c2, c3] = [0, 1, 2].map((offset) => `${letter}${L.countRow + offset}`);
    const [s1, s2, s3] = ["1", "2", "3"].map((id) => settings.special.preferred[id]);
    const [m1, m2, m3] = ["1", "2", "3"].map((id) => settings.weekday.minimum[id]);
    const [i1, i2, i3] = ["1", "2", "3"].map((id) => settings.weekday.preferred[id]);
    const special = `${letter}$${L.specialRow}=1`;
    const formula = `IF(${special},IF(OR(${c1}<${s1},${c2}<${s2},${c3}<${s3}),"KURANG",IF(OR(${c1}>${s1},${c2}>${s2},${c3}>${s3}),"LEBIH","OK")),` +
      `IF(OR(${c1}<${m1},${c2}<${m2},${c3}<${m3}),"KURANG",IF(AND(${c1}>=${i1},${c2}>=${i2},${c3}>=${i3}),"IDEAL",IF(AND(${c1}=${m1},${c2}=${m2},${c3}=${m3}),"MINIMAL","CUKUP"))))`;
    const statusCell = sheet.getCell(L.statusRow, L.firstDayColumn + index);
    setCell(statusCell, { formula, result: day.status }, { size: 7, bold: true });
    statusCell.alignment = { horizontal: "center", vertical: "middle", textRotation: 90 };
  });
  sheet.getRow(L.statusRow).height = 50;
  sheet.mergeCells(L.statusNoteRow, 2, L.statusNoteRow, L.lastDayColumn);
  const ideal = ["1", "2", "3"].map((id) => settings.weekday.preferred[id]).join("-");
  const minimumText = ["1", "2", "3"].map((id) => settings.weekday.minimum[id]).join("-");
  setCell(sheet.getCell(L.statusNoteRow, 2),
    `Status hari kerja: IDEAL = ${ideal} · CUKUP = di atas minimal tetapi di bawah ideal (misalnya 2-1-1 atau 1-2-1), masih aman · MINIMAL = hanya ${minimumText}, tanpa cadangan · KURANG = ada shift kosong, harus diperbaiki. Sabtu/Minggu/tanggal merah: OK = tepat 1 orang per shift, LEBIH = lebih dari itu. Kolom abu-abu = Sabtu/Minggu, merah muda = tanggal merah/cuti bersama.`,
    { size: 8, italic: true, color: C.note, align: "left", wrap: true, border: false });
  sheet.getRow(L.statusNoteRow).height = 24;

  // Hidden helper rows (read back by the tool; do not delete)
  const helper = sheet.getRow(L.helperRow);
  helper.getCell(1).value = `ROSTER:${result.period.key}`;
  helper.getCell(2).value = "__tanggal__";
  sheet.getRow(L.weekendRow).getCell(2).value = "__akhir_pekan__";
  sheet.getRow(L.holidayFlagRow).getCell(2).value = "__tanggal_merah__";
  sheet.getRow(L.specialRow).getCell(2).value = "__hari_khusus__";
  days.forEach((day, index) => {
    const column = L.firstDayColumn + index;
    helper.getCell(column).value = day.date;
    sheet.getRow(L.weekendRow).getCell(column).value = day.isWeekend ? 1 : 0;
    sheet.getRow(L.holidayFlagRow).getCell(column).value = day.isHoliday ? 1 : 0;
    sheet.getRow(L.specialRow).getCell(column).value = day.isSpecial ? 1 : 0;
  });
  for (const rowNumber of [L.helperRow, L.weekendRow, L.holidayFlagRow, L.specialRow]) sheet.getRow(rowNumber).hidden = true;

  // Colors follow the codes, also after manual edits.
  const gridRef = `${firstLetter}${L.firstMemberRow}:${lastLetter}${L.lastMemberRow}`;
  const topLeft = `${firstLetter}${L.firstMemberRow}`;
  sheet.addConditionalFormatting({
    ref: gridRef,
    rules: Object.entries(CODE_STYLE).map(([code, style], priority) => ({
      type: "expression",
      priority: priority + 1,
      formulae: [`UPPER(${topLeft}&"")="${code}"`],
      style: { font: { color: { argb: style.font }, bold: Boolean(style.bold) }, ...(style.fill ? { fill: { type: "pattern", pattern: "solid", bgColor: { argb: style.fill } } } : {}) }
    }))
  });
  const statusRef = `${firstLetter}${L.statusRow}:${lastLetter}${L.statusRow}`;
  const statusTopLeft = `${firstLetter}${L.statusRow}`;
  sheet.addConditionalFormatting({
    ref: statusRef,
    rules: [
      ["IDEAL", C.okFill, C.okText],
      ["OK", C.okFill, C.okText],
      ["CUKUP", "FFE2EFDA", "FF375623"],
      ["MINIMAL", C.warnFill, C.warnText],
      ["KURANG", C.badFill, C.badText],
      ["LEBIH", C.warnFill, C.warnText]
    ].map(([text, bg, font], index) => ({
      type: "expression", priority: 20 + index, formulae: [`${statusTopLeft}="${text}"`],
      style: { font: { color: { argb: font }, bold: true }, fill: { type: "pattern", pattern: "solid", bgColor: { argb: bg } } }
    }))
  });
  sheet.pageSetup.printTitlesRow = `${L.holidayRow}:${L.headerRow}`;
  return L;
}

// ---------------- Jadwal Harian ----------------

function dailySheet(workbook, result, L) {
  const sheet = workbook.addWorksheet("Jadwal Harian", { views: [{ state: "frozen", ySplit: 4 }], pageSetup: { orientation: "landscape", paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
  const widths = [13, 9, 24, 28, 28, 24, 42];
  widths.forEach((width, index) => (sheet.getColumn(index + 1).width = width));
  title(sheet, `JADWAL HARIAN — ${monthTitle(result).toUpperCase()}`, "Siapa masuk setiap hari. Diambil otomatis dari sheet Roster: bila ada tukar shift, ubah di sheet Roster dan sheet ini ikut berubah.", widths.length);
  const shiftHeaders = result.shifts.map((shift) => `${shift.label} (${shift.name})\n${shift.start}–${shift.end}`);
  sheet.getRow(4).values = ["Tanggal", "Hari", "Keterangan", ...shiftHeaders, "Libur / Cuti / Sakit / Training"];
  headerCells(sheet.getRow(4), [1, 2, 3, 4, 5, 6, 7]);
  sheet.getRow(4).height = 32;
  const members = result.members;
  const OFF_LABEL = { H: "Libur", C: "Cuti", S: "Sakit", T: "Training" };
  result.days.forEach((day, index) => {
    const rowNumber = 5 + index;
    const row = sheet.getRow(rowNumber);
    const letter = columnLetter(L.firstDayColumn + index);
    const shade = day.isHoliday ? C.holiday : day.isWeekend ? C.weekend : null;
    const note = day.holiday ? `${day.holiday.name}${day.holiday.tentative ? " (belum pasti)" : ""}` : day.isWeekend ? "Akhir pekan" : "";
    setCell(row.getCell(1), formatTanggal(day.date, { pendek: true }) + ` ${result.period.year}`, { align: "left", bg: shade });
    setCell(row.getCell(2), namaHari(day.date), { align: "left", bg: shade, bold: day.isWeekend || day.isHoliday });
    setCell(row.getCell(3), note, { align: "left", bg: shade, size: 9, color: day.holiday ? C.badText : C.note, wrap: true });
    result.shifts.forEach((shift, offset) => {
      const parts = members.map((member, memberIndex) => `IF(Roster!${letter}$${L.firstMemberRow + memberIndex}&""="${shift.id}",", "&Roster!$B$${L.firstMemberRow + memberIndex},"")`);
      const names = members.filter((member) => result.schedule[member.id][day.date] === shift.id).map((member) => member.name).join(", ");
      setCell(row.getCell(4 + offset), { formula: `MID(${parts.join("&")},3,500)`, result: names }, { align: "left", bg: shade, wrap: true });
    });
    const offParts = members.flatMap((member, memberIndex) => Object.entries(OFF_LABEL).map(([code, label]) => `IF(UPPER(Roster!${letter}$${L.firstMemberRow + memberIndex}&"")="${code}",", "&Roster!$B$${L.firstMemberRow + memberIndex}&" (${label})","")`));
    const offText = members.flatMap((member) => {
      const code = result.schedule[member.id][day.date];
      return OFF_LABEL[code] ? [`${member.name} (${OFF_LABEL[code]})`] : [];
    }).join(", ");
    setCell(row.getCell(7), { formula: `MID(${offParts.join("&")},3,500)`, result: offText }, { align: "left", bg: shade, wrap: true, size: 9, color: C.note });
    row.height = 30;
  });
}

// ---------------- Cadangan ----------------

const PLAN_STYLE = Object.freeze({
  aman: { bg: "FFC6EFCE", color: "FF006100", label: "Aman", chip: "Aman = masih ada orang kedua" },
  lembur: { bg: "FFE2EFDA", color: "FF375623", label: "Lembur", chip: "Lembur = ditutup lembur" },
  pengganti: { bg: "FFFFF2CC", color: "FF7F6000", label: "Pengganti", chip: "Pengganti = orang yang sedang libur" },
  darurat: { bg: "FFFFEB9C", color: "FF9C5700", label: "Darurat", chip: "Darurat = pengganti jadi hari kerja ke-6" },
  kosong: { bg: "FFFFC7CE", color: "FF9C0006", label: "Tidak ada", chip: "Tidak ada = hubungi cadangan luar tim" }
});

function planText(entry, result, external) {
  const overtime = [entry.extension && `${entry.extension.name} s/d ${entry.extension.to}`, entry.early && `${entry.early.name} mulai ${entry.early.from}`].filter(Boolean).join(" + ");
  const open = entry.uncovered.map((part) => `${part.from}–${part.to}`).join(", ");
  switch (entry.status) {
    case "aman": return `Aman (${entry.people.join(" + ")})`;
    case "lembur": return `Lembur: ${overtime}`;
    case "pengganti": return `Pengganti: ${entry.names.join(" / ")}`;
    case "darurat": return `Darurat: ${entry.stretched.join(" / ")} (hari ke-${result.settings.rules.maxConsecutiveWorkDays + 1})`;
    default: {
      const outside = external.filter((item) => item.eligibleShifts.includes(entry.shift)).map((item) => item.name);
      return [`Kosong ${open}${outside.length ? ` · luar tim: ${outside.join(" / ")}` : ""}`, overtime && `Lembur: ${overtime}`].filter(Boolean).join("\n");
    }
  }
}

function backupSheet(workbook, result) {
  const sheet = workbook.addWorksheet("Cadangan", { views: [{ state: "frozen", ySplit: 7 }], pageSetup: { orientation: "landscape", paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
  const widths = [11, 9, 38, 38, 46];
  widths.forEach((width, index) => (sheet.getColumn(index + 1).width = width));
  const rules = result.settings.rules;
  title(sheet, `RENCANA BILA ADA YANG BERHALANGAN — ${monthTitle(result).toUpperCase()}`,
    `Bila 1 orang tidak bisa masuk mendadak. Lembur maksimal ${rules.overtimeHours ?? 4} jam per orang: shift sebelumnya pulang lebih lambat dan/atau shift berikutnya datang lebih awal. Lembur tidak pernah menggantikan satu shift penuh, dan istirahat minimal ${rules.minimumRestHours} jam tetap dijaga.`, widths.length);
  const plan = result.backupPlan ?? [];
  const count = (status) => plan.filter((entry) => entry.status === status).length;
  // Counts per plan type, then how to use the sheet.
  sheet.mergeCells(3, 1, 3, widths.length);
  setCell(sheet.getCell(3, 1), `Bulan ini (${plan.length} shift): ${Object.entries(PLAN_STYLE).map(([status, style]) => `${style.label} ${count(status)}`).join("  ·  ")}`, { size: 10, bold: true, align: "left", color: C.navy, border: false });
  paragraph(sheet, 4, 'Cara pakai: cari tanggal dan shift orang yang berhalangan. Hijau = tidak perlu apa-apa. Hijau muda = minta lembur ke nama dan jam yang tertulis. Kuning = hubungi pengganti; setelah sepakat, ubah kodenya di sheet Roster lalu jalankan "Buat Roster" → menu 3 (Cek roster). Merah = hubungi cadangan luar tim atau tukar jadwal. Shift 3 tidak bisa ditutup lembur saja: lembur dari kedua sisi tetap menyisakan jam kosong.', widths.length, { size: 9, italic: true, color: C.note, charsPerLine: 125 });
  const external = result.externalBackups ?? [];
  paragraph(sheet, 5, external.length
    ? `Cadangan luar tim: ${external.map((item) => `${item.name}${item.origin ? ` (${item.origin})` : ""} — Shift ${item.eligibleShifts.join("/")}${item.contact ? `, ${item.contact}` : ""}`).join("; ")}.`
    : 'Belum ada cadangan luar tim. Isi sheet "Cadangan Luar Tim" di Data Roster.xlsx, terutama orang yang bisa dipanggil untuk Shift 3.', widths.length, { size: 9, bold: true, color: external.length ? C.okText : C.warnText, charsPerLine: 125 });
  // Colour chips.
  Object.entries(PLAN_STYLE).forEach(([status, style], index) => {
    if (index >= widths.length) return;
    setCell(sheet.getCell(6, index + 1), index < 2 ? style.label : style.chip, { bold: true, size: 9, bg: style.bg, color: style.color });
  });
  sheet.getRow(7).values = ["Tanggal", "Hari", ...result.shifts.map((shift) => `Bila ${shift.label} (${shift.name}) berhalangan`)];
  headerCells(sheet.getRow(7), [1, 2, 3, 4, 5]);
  const byKey = new Map(plan.map((entry) => [`${entry.date}|${entry.shift}`, entry]));
  result.days.forEach((day, index) => {
    const row = sheet.getRow(8 + index);
    const shade = day.isHoliday ? C.holiday : day.isWeekend ? C.weekend : null;
    setCell(row.getCell(1), formatTanggal(day.date, { pendek: true }), { align: "left", bg: shade });
    setCell(row.getCell(2), namaHari(day.date), { align: "left", bg: shade, bold: day.isWeekend || day.isHoliday });
    let lines = 1;
    result.shifts.forEach((shift, offset) => {
      const entry = byKey.get(`${day.date}|${shift.id}`);
      if (!entry) return;
      const style = PLAN_STYLE[entry.status];
      const text = planText(entry, result, external);
      // About 1.2 characters per unit of column width at font size 9.
      lines = Math.max(lines, text.split("\n").reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / (widths[2 + offset] * 1.2))), 0));
      setCell(row.getCell(3 + offset), text, { align: "left", wrap: true, size: 9, bg: style.bg, color: style.color, bold: entry.status === "kosong" });
    });
    row.height = Math.max(17, 13 * lines + 2);
  });
}

// ---------------- Ringkasan ----------------

// Red when a cell starts with ✖ (the check failed), green otherwise. Reads only
// the cell itself: a colour rule that reads another sheet breaks Excel.
function passFail(sheet, ref, topLeft, priority) {
  sheet.addConditionalFormatting({
    ref,
    rules: [
      { type: "expression", priority, formulae: [`LEFT(${topLeft},1)="✖"`], style: { font: { color: { argb: C.badText }, bold: true }, fill: { type: "pattern", pattern: "solid", bgColor: { argb: C.badFill } } } },
      { type: "expression", priority: priority + 1, formulae: [`LEFT(${topLeft},1)<>"✖"`], style: { font: { color: { argb: C.okText }, bold: true }, fill: { type: "pattern", pattern: "solid", bgColor: { argb: C.okFill } } } }
    ]
  });
}

function summarySheet(workbook, result, L, checks) {
  const sheet = workbook.addWorksheet("Ringkasan", { pageSetup: { orientation: "landscape", paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
  const lastColumn = 14;
  [5, 16, 10, 10, 11, 9, 12, 9, 9, 9, 10, 11, 12, 10].forEach((width, index) => (sheet.getColumn(index + 1).width = width));
  title(sheet, `RINGKASAN ROSTER ${monthTitle(result).toUpperCase()}`, `Untuk Operations Manager  ·  dibuat ${createdText(result.generatedAt)}`, lastColumn);

  let row = 4;
  heading(sheet, row, "Kesimpulan", lastColumn);
  row += 1;
  const failed = result.audit.checks.filter((check) => !check.ok);
  sheet.mergeCells(row, 1, row, lastColumn);
  const okConclusion = "✔ Roster memenuhi semua aturan utama. Siap diperiksa dan disetujui.";
  const conclusion = failed.length === 0 ? okConclusion : `✖ Ada ${failed.length} aturan yang tidak terpenuhi — lihat sheet Pemeriksaan dan perbaiki sebelum dipakai.`;
  const failedCell = `Pemeriksaan!$E$${checks.ruleTotal}`;
  setCell(sheet.getCell(row, 1), { formula: `IF(${failedCell}=0,"${okConclusion}","✖ Ada "&${failedCell}&" aturan yang tidak terpenuhi — lihat sheet Pemeriksaan dan perbaiki sebelum dipakai.")`, result: conclusion }, { bold: true, size: 12, align: "left" });
  passFail(sheet, `A${row}`, `$A$${row}`, 70);
  sheet.getRow(row).height = 28;
  row += 1;
  sheet.mergeCells(row, 1, row, lastColumn);
  setCell(sheet.getCell(row, 1), { formula: "Pemeriksaan!$A$3", result: checks.perfectText }, { bold: true, align: "left", size: 10 });
  sheet.addConditionalFormatting({
    ref: `A${row}`,
    rules: [
      { type: "expression", priority: 68, formulae: [`LEFT($A$${row},1)="✔"`], style: { font: { color: { argb: C.okText }, bold: true }, fill: { type: "pattern", pattern: "solid", bgColor: { argb: C.okFill } } } },
      { type: "expression", priority: 69, formulae: [`LEFT($A$${row},1)<>"✔"`], style: { font: { color: { argb: C.warnText }, bold: true }, fill: { type: "pattern", pattern: "solid", bgColor: { argb: C.warnFill } } } }
    ]
  });

  row += 2;
  heading(sheet, row, "Pemeriksaan aturan", lastColumn);
  row += 1;
  sheet.mergeCells(row, 2, row, 6);
  sheet.mergeCells(row, 8, row, lastColumn);
  sheet.getCell(row, 1).value = "No";
  sheet.getCell(row, 2).value = "Aturan";
  sheet.getCell(row, 7).value = "Hasil (dihitung Excel)";
  sheet.getCell(row, 8).value = "Keterangan (saat roster dibuat)";
  headerCells(sheet.getRow(row), [1, 2, 7, 8]);
  const firstRuleRow = row + 1;
  result.audit.checks.forEach((check, index) => {
    row += 1;
    sheet.mergeCells(row, 2, row, 6);
    sheet.mergeCells(row, 8, row, lastColumn);
    setCell(sheet.getCell(row, 1), index + 1, { color: C.note });
    setCell(sheet.getCell(row, 2), check.judul, { align: "left", wrap: true });
    const excelRow = checks.rules[check.id];
    setCell(sheet.getCell(row, 7), { formula: `Pemeriksaan!F${excelRow}`, result: check.ok ? "✔ Terpenuhi" : `✖ Tidak (${check.pelanggaran.length})` }, { bold: true, size: 9 });
    const detail = check.ok ? "" : check.pelanggaran.slice(0, 3).map((item) => item.pesan).join(" ") + (check.pelanggaran.length > 3 ? ` (+${check.pelanggaran.length - 3} lainnya)` : "");
    setCell(sheet.getCell(row, 8), detail, { align: "left", wrap: true, size: 9 });
    sheet.getRow(row).height = Math.max(20, 13 * Math.ceil(Math.max(check.judul.length / 60, detail.length / 55)));
  });
  passFail(sheet, `G${firstRuleRow}:G${row}`, `G${firstRuleRow}`, 72);
  row += 1;
  paragraph(sheet, row, `Kolom Hasil dihitung ulang oleh Excel dari sheet Roster (rinciannya di sheet Pemeriksaan), jadi ikut berubah bila roster diubah manual. Keterangan = temuan program saat roster dibuat (${createdText(result.generatedAt)}). Setelah mengubah roster, jalankan juga "Buat Roster" → menu 3 "Cek roster".`, lastColumn, { italic: true, color: C.note, size: 9 });

  // Automatic quality review: what a careful planner checks after the rules.
  // Counts come from the Excel formulas on the Pemeriksaan sheet; the details
  // are what the program found when the roster was made.
  const quality = result.quality ?? { findings: [] };
  row += 2;
  heading(sheet, row, "Pemeriksaan kualitas otomatis", lastColumn);
  const tries = result.search?.portfolio?.length ?? 1;
  if (tries > 1) {
    row += 1;
    paragraph(sheet, row, `Program mencoba ${tries} susunan dan memilih yang paling sedikit temuan penting, lalu yang skornya paling baik.`, lastColumn, { size: 9, color: C.note });
  }
  row += 1;
  sheet.mergeCells(row, 1, row, lastColumn);
  const seriousNow = quality.findings.filter((finding) => finding.level === "penting").reduce((sum, finding) => sum + finding.count, 0);
  const seriousCell = `Pemeriksaan!$F$${checks.qualityTotal}`;
  setCell(sheet.getCell(row, 1), {
    formula: `IF(${seriousCell}=0,"✔ Tidak ada temuan penting.","✖ "&${seriousCell}&" temuan penting — lihat tabel di bawah.")`,
    result: seriousNow === 0 ? "✔ Tidak ada temuan penting." : `✖ ${seriousNow} temuan penting — lihat tabel di bawah.`
  }, { align: "left", bold: true });
  passFail(sheet, `A${row}`, `$A$${row}`, 74);
  row += 1;
  sheet.mergeCells(row, 2, row, 6);
  sheet.mergeCells(row, 9, row, lastColumn);
  ["No", "Temuan"].forEach((label, index) => (sheet.getCell(row, index + 1).value = label));
  sheet.getCell(row, 7).value = "Tingkat";
  sheet.getCell(row, 8).value = "Jumlah (Excel)";
  sheet.getCell(row, 9).value = "Rincian (saat roster dibuat)";
  headerCells(sheet.getRow(row), [1, 2, 7, 8, 9]);
  const firstQualityRow = row + 1;
  QUALITY_CHECKS.forEach(([id, level, label], index) => {
    row += 1;
    sheet.mergeCells(row, 2, row, 6);
    sheet.mergeCells(row, 9, row, lastColumn);
    const finding = quality.findings.find((item) => item.id === id);
    const detail = finding ? finding.details.slice(0, 8).join(", ") + (finding.details.length > 8 ? ` (+${finding.details.length - 8} lainnya)` : "") : "–";
    setCell(sheet.getCell(row, 1), index + 1, { color: C.note });
    setCell(sheet.getCell(row, 2), label, { align: "left", wrap: true, size: 9 });
    setCell(sheet.getCell(row, 7), level === "penting" ? "Penting" : "Perhatian", { bold: level === "penting", color: level === "penting" ? C.warnText : C.note, size: 9 });
    setCell(sheet.getCell(row, 8), { formula: `Pemeriksaan!F${checks.quality[id]}`, result: finding?.count ?? 0 }, { bold: true });
    setCell(sheet.getCell(row, 9), detail, { align: "left", wrap: true, size: 9 });
    sheet.getRow(row).height = Math.max(18, 13 * Math.ceil(Math.max(label.length / 60, detail.length / 60)));
  });
  // Amber when a check finds something now (reads only this sheet).
  sheet.addConditionalFormatting({
    ref: `H${firstQualityRow}:H${row}`,
    rules: [{ type: "expression", priority: 76, formulae: [`H${firstQualityRow}>0`], style: { font: { color: { argb: C.warnText }, bold: true }, fill: { type: "pattern", pattern: "solid", bgColor: { argb: C.warnFill } } } }]
  });
  row += 1;
  paragraph(sheet, row, "Temuan penting sudah diusahakan dihindari; yang tersisa biasanya terpaksa karena cuti, sakit atau aturan istirahat (lihat \"Hal yang perlu diperhatikan\"). Jumlah dihitung ulang oleh Excel.", lastColumn, { italic: true, color: C.note, size: 9 });

  // Work-life balance per person (formulas on the Pemeriksaan sheet).
  const wellbeing = result.wellbeing;
  if (wellbeing) {
    row += 2;
    heading(sheet, row, "Skor keseimbangan kerja–hidup (0–100)", lastColumn);
    row += 1;
    sheet.mergeCells(row, 2, row, 3);
    sheet.mergeCells(row, 6, row, lastColumn);
    sheet.getCell(row, 1).value = "No";
    sheet.getCell(row, 2).value = "Nama";
    sheet.getCell(row, 4).value = "Skor";
    sheet.getCell(row, 5).value = "Tingkat";
    sheet.getCell(row, 6).value = "Beban terbesar (saat roster dibuat)";
    headerCells(sheet.getRow(row), [1, 2, 4, 5, 6]);
    const firstWlbRow = row + 1;
    result.members.forEach((member, index) => {
      row += 1;
      const item = wellbeing.members.find((entry) => entry.id === member.id);
      const excelRow = checks.wlb[member.id];
      sheet.mergeCells(row, 2, row, 3);
      sheet.mergeCells(row, 6, row, lastColumn);
      setCell(sheet.getCell(row, 1), index + 1, { color: C.note });
      setCell(sheet.getCell(row, 2), member.name, { bold: true, align: "left" });
      setCell(sheet.getCell(row, 4), { formula: `Pemeriksaan!N${excelRow}`, result: item?.score ?? "–" }, { bold: true });
      setCell(sheet.getCell(row, 5), { formula: `Pemeriksaan!O${excelRow}`, result: item?.level ?? "–" }, { bold: true, size: 9 });
      const burdens = (item?.factors ?? []).slice(0, 3).map((factor) => `${factor.label} (−${factor.points})`).join("; ") || "–";
      setCell(sheet.getCell(row, 6), burdens, { align: "left", size: 9, wrap: true });
    });
    row += 1;
    sheet.mergeCells(row, 2, row, 3);
    setCell(sheet.getCell(row, 2), "Rata-rata tim", { bold: true, align: "left" });
    setCell(sheet.getCell(row, 4), { formula: `Pemeriksaan!N${checks.wlbTeam}`, result: wellbeing.team ?? "–" }, { bold: true });
    setCell(sheet.getCell(row, 5), { formula: `Pemeriksaan!O${checks.wlbTeam}`, result: wellbeing.teamLevel ?? "–" }, { bold: true, size: 9 });
    const levelColors = [["Baik", C.okFill, C.okText], ["Cukup", C.warnFill, C.warnText], ["Perlu perhatian", C.badFill, C.badText]];
    sheet.addConditionalFormatting({
      ref: `E${firstWlbRow}:E${row}`,
      rules: levelColors.map(([label, bg, text], index) => ({ type: "expression", priority: 80 + index, formulae: [`E${firstWlbRow}="${label}"`], style: { font: { color: { argb: text }, bold: true }, fill: { type: "pattern", pattern: "solid", bgColor: { argb: bg } } } }))
    });
    row += 1;
    paragraph(sheet, row, "Skor 100 dikurangi beban yang nyata: malam, blok 3 malam, kerja Sabtu/Minggu, tanpa libur Sabtu–Minggu penuh, libur atau masuk hanya 1 hari (lebih berat bila libur 1 hari itu setelah 5 hari kerja), jam di atas batas, pindah Shift 1↔2 dalam satu blok, dan hari di atas target. Baik = 80 ke atas, Cukup = 65–79, Perlu perhatian = di bawah 65. Rumus dan angka tiap beban ada di sheet Pemeriksaan.", lastColumn, { italic: true, color: C.note, size: 9, charsPerLine: 160 });
  }

  // Print: page 1 = conclusion and rule checks, page 2 = workload and notes.
  sheet.getRow(row).addPageBreak();
  row += 2;
  heading(sheet, row, "Beban kerja per orang", lastColumn);
  row += 1;
  const workloadHeaders = ["No", "Nama", "Hari kerja", "Target hari kerja", "Cuti/ Sakit/ Training", "Libur (H)", "Istirahat wajib setelah Shift 3", "Shift 1", "Shift 2", "Shift 3", "Jam kerja bersih", "Kerja Sabtu/ Minggu", "Libur Sabtu–Minggu penuh", "Kerja tgl merah"];
  sheet.getRow(row).values = workloadHeaders;
  headerCells(sheet.getRow(row), workloadHeaders.map((_, index) => index + 1));
  sheet.getRow(row).height = 42;
  const weekendPairs = [];
  result.days.forEach((day, index) => {
    if (day.isWeekend && new Date(`${day.date}T00:00:00Z`).getUTCDay() === 6 && index + 1 < result.days.length) weekendPairs.push([index, index + 1]);
  });
  const startsOnSunday = new Date(`${result.days[0].date}T00:00:00Z`).getUTCDay() === 0;
  result.members.forEach((member, index) => {
    row += 1;
    const rosterRow = L.firstMemberRow + index;
    const summary = result.memberSummary[member.id];
    const ref = (offset) => `Roster!${columnLetter(L.totalsColumn + offset)}${rosterRow}`;
    const off = (cell) => `OR(UPPER(${cell}&"")="H",UPPER(${cell}&"")="C",UPPER(${cell}&"")="S")`;
    const pairTerms = weekendPairs.map(([sat, sun]) => `(${off(`Roster!${columnLetter(L.firstDayColumn + sat)}${rosterRow}`)}*${off(`Roster!${columnLetter(L.firstDayColumn + sun)}${rosterRow}`)})`);
    const previousSaturday = result.history.codesById[member.id]?.at(-1);
    if (startsOnSunday && ["H", "C", "S"].includes(previousSaturday)) pairTerms.push(`(${off(`Roster!${columnLetter(L.firstDayColumn)}${rosterRow}`)}*1)`);
    const breakHours = result.settings.rules.breakHours ?? 1;
    const spans = result.shifts.map((shift) => {
      const [startHour, startMinute] = shift.start.split(":").map(Number);
      const [endHour, endMinute] = shift.end.split(":").map(Number);
      let hours = endHour + endMinute / 60 - (startHour + startMinute / 60);
      if (hours <= 0) hours += 24;
      return Math.max(0, hours - breakHours);
    });
    const hours = spans.reduce((sum, span, offset) => sum + span * summary.shifts[result.shifts[offset].id], 0) + summary.trainingDays * Math.max(0, 9 - breakHours);
    const values = [
      index + 1,
      member.name,
      { formula: ref(0), result: summary.workDays },
      summary.workTarget,
      { formula: ref(2), result: summary.leaveDays + summary.sickDays + summary.trainingDays },
      { formula: ref(1), result: summary.offDays },
      summary.nightRecoveryDays,
      { formula: ref(3), result: summary.shifts["1"] },
      { formula: ref(4), result: summary.shifts["2"] },
      { formula: ref(5), result: summary.shifts["3"] },
      { formula: `${spans.map((span, offset) => `${ref(3 + offset)}*${span}`).join("+")}${summary.trainingDays ? `+${summary.trainingDays * Math.max(0, 9 - breakHours)}` : ""}`, result: hours },
      { formula: ref(6), result: summary.weekendWorkDays },
      pairTerms.length ? { formula: pairTerms.join("+"), result: summary.fullWeekendsOff } : 0,
      { formula: ref(7), result: summary.holidayWorkDays }
    ];
    values.forEach((value, column) => setCell(sheet.getCell(row, column + 1), value, { align: column === 1 ? "left" : "center", bold: column === 1 || column === 2, color: column === 3 || column === 6 ? C.note : undefined }));
    // Amber when someone's workdays differ from their target by more than 1 (also after manual edits).
    sheet.addConditionalFormatting({
      ref: `C${row}`,
      rules: [{ type: "expression", priority: 40 + index, formulae: [`ABS(C${row}-D${row})>1`], style: { font: { color: { argb: C.warnText }, bold: true }, fill: { type: "pattern", pattern: "solid", bgColor: { argb: C.warnFill } } } }]
    });
  });
  row += 1;
  const pattern = (counts) => ["1", "2", "3"].map((id) => counts[id] ?? 0).join("-");
  const targetText = result.settings.targetBasis === "aturan"
    ? `Target hari kerja = ${result.settings.workDaysTarget} hari per orang (diatur di Data Roster.xlsx)`
    : `Target hari kerja = pekerjaan ideal bulan ini (${pattern(result.settings.coverage.weekday.preferred)} di hari kerja, ${pattern(result.settings.coverage.special.preferred)} di Sabtu/Minggu/tanggal merah) dibagi rata, maksimal 5 hari kerja per minggu: ${result.settings.workDaysTarget} hari per orang`;
  paragraph(sheet, row, `${targetText}, dikurangi 1 hari untuk setiap hari cuti, sakit atau training. Hari kerja berwarna kuning = selisih lebih dari 1 hari dari target. Istirahat wajib = 2 hari libur setelah setiap blok Shift 3 (bukan libur bebas). Jam kerja bersih = jam shift dikurangi istirahat tidak dibayar. Angka di tabel ini ikut berubah bila sheet Roster diubah.`,
    lastColumn, { italic: true, color: C.note, size: 9, charsPerLine: 160 });

  // Hours for HR: weekly net hours, weeks above the limit, hours on tanggal merah.
  const limit = result.settings.rules.weeklyHoursLimit ?? 40;
  row += 2;
  heading(sheet, row, "Jam kerja untuk HR", lastColumn);
  row += 1;
  sheet.mergeCells(row, 2, row, 3);
  sheet.mergeCells(row, 4, row, 5);
  sheet.mergeCells(row, 6, row, 7);
  sheet.mergeCells(row, 8, row, 9);
  sheet.mergeCells(row, 10, row, lastColumn);
  sheet.getCell(row, 1).value = "No";
  sheet.getCell(row, 2).value = "Nama";
  sheet.getCell(row, 4).value = "Minggu di atas batas";
  sheet.getCell(row, 6).value = "Jam di atas batas";
  sheet.getCell(row, 8).value = "Jam kerja di tanggal merah";
  sheet.getCell(row, 10).value = "Jam kerja bersih per minggu (Senin–Minggu)";
  headerCells(sheet.getRow(row), [1, 2, 4, 6, 8, 10]);
  sheet.getRow(row).height = 30;
  result.members.forEach((member, index) => {
    row += 1;
    const summary = result.memberSummary[member.id];
    sheet.mergeCells(row, 2, row, 3);
    sheet.mergeCells(row, 4, row, 5);
    sheet.mergeCells(row, 6, row, 7);
    sheet.mergeCells(row, 8, row, 9);
    sheet.mergeCells(row, 10, row, lastColumn);
    setCell(sheet.getCell(row, 1), index + 1, { color: C.note });
    setCell(sheet.getCell(row, 2), member.name, { bold: true, align: "left" });
    const over = summary.weeksOverLimit > 0;
    setCell(sheet.getCell(row, 4), summary.weeksOverLimit, { bold: over, color: over ? C.warnText : undefined, bg: over ? C.warnFill : null });
    setCell(sheet.getCell(row, 6), summary.hoursOverLimit, { color: over ? C.warnText : undefined });
    setCell(sheet.getCell(row, 8), summary.holidayHours);
    const weeks = summary.weeklyHours.map((week) => `${formatTanggal(week.weekStart, { pendek: true })}: ${week.hours}`).join("  ·  ");
    setCell(sheet.getCell(row, 10), weeks, { align: "left", size: 9 });
  });
  row += 1;
  paragraph(sheet, row, `Jam kerja bersih = jam shift dikurangi istirahat tidak dibayar ${result.settings.rules.breakHours ?? 1} jam per shift. Batas ${limit} jam per minggu (Senin–Minggu; minggu pertama termasuk hari-hari akhir bulan lalu). Jam di atas batas dan jam kerja di tanggal merah bisa menjadi lembur — cek dengan kebijakan HR. Keduanya bisa diatur di sheet Aturan (Data Roster.xlsx).`, lastColumn, { italic: true, color: C.note, size: 9, charsPerLine: 160 });

  // Shift 3 over the months the fairness looks at: what the OM needs to see that
  // nights and 3-night blocks even out across months (per available day).
  const fairness = result.fairness;
  if (fairness?.members?.length) {
    const shown = fairness.months.slice(-3);
    const monthName = (key) => `${namaBulan(Number(key.slice(5, 7)))} ${key.slice(0, 4)}`;
    const totalStart = 4 + shown.length * 3;
    row += 2;
    heading(sheet, row, "Pembagian Shift 3 selama 3 bulan", lastColumn);
    row += 1;
    const top = row;
    sheet.mergeCells(top, 1, top + 1, 1);
    sheet.mergeCells(top, 2, top + 1, 3);
    sheet.mergeCells(top, totalStart, top + 1, lastColumn);
    sheet.getCell(top, 1).value = "No";
    sheet.getCell(top, 2).value = "Nama";
    sheet.getCell(top, totalStart).value = "Malam per 30 hari tersedia (semua bulan)";
    shown.forEach((key, index) => {
      const first = 4 + index * 3;
      sheet.mergeCells(top, first, top, first + 2);
      sheet.getCell(top, first).value = monthName(key);
      ["Malam", "Blok 3 malam", "Hari tersedia"].forEach((label, offset) => (sheet.getCell(top + 1, first + offset).value = label));
    });
    headerCells(sheet.getRow(top), [1, 2, ...shown.map((_, index) => 4 + index * 3), totalStart]);
    headerCells(sheet.getRow(top + 1), shown.flatMap((_, index) => [4, 5, 6].map((column) => column + index * 3)));
    sheet.getRow(top + 1).height = 30;
    row = top + 1;
    fairness.members.forEach((item, index) => {
      row += 1;
      const rosterRow = L.firstMemberRow + result.members.findIndex((member) => member.id === item.id);
      sheet.mergeCells(row, 2, row, 3);
      sheet.mergeCells(row, totalStart, row, lastColumn);
      setCell(sheet.getCell(row, 1), index + 1, { color: C.note });
      setCell(sheet.getCell(row, 2), item.name, { bold: true, align: "left" });
      const months = item.months.slice(-shown.length);
      months.forEach((month, offset) => {
        const first = 4 + offset * 3;
        const current = offset === months.length - 1;
        if (!month) {
          [0, 1, 2].forEach((step) => setCell(sheet.getCell(row, first + step), "–", { color: C.note }));
          return;
        }
        // This month's nights follow the Roster sheet, so manual swaps show here too.
        setCell(sheet.getCell(row, first), current ? { formula: `Roster!${columnLetter(L.totalsColumn + 5)}${rosterRow}`, result: month.nights } : month.nights, { bold: current });
        setCell(sheet.getCell(row, first + 1), month.longBlocks);
        setCell(sheet.getCell(row, first + 2), month.availableDays, { color: C.note });
      });
      const cells = (step) => months.map((month, offset) => (month ? `${columnLetter(4 + offset * 3 + step)}${row}` : null)).filter(Boolean);
      const nights = months.reduce((sum, month) => sum + (month?.nights ?? 0), 0);
      const available = months.reduce((sum, month) => sum + (month?.availableDays ?? 0), 0);
      setCell(sheet.getCell(row, totalStart), { formula: `ROUND((${cells(0).join("+")})*30/MAX(1,${cells(2).join("+")}),1)`, result: Math.round((nights * 30 / Math.max(1, available)) * 10) / 10 }, { bold: true, numFmt: "0.0" });
    });
    row += 1;
    paragraph(sheet, row, "Shift 3 dan blok 3 malam dibagi adil per hari tersedia (cuti, sakit dan training tidak dihitung). Selisih dari bulan-bulan sebelumnya dicicil: setengahnya diimbangi bulan ini, paling banyak 2 malam. Kolom terakhir membandingkan beban malam antarorang, termasuk yang banyak cuti.", lastColumn, { italic: true, color: C.note, size: 9, charsPerLine: 160 });
  }

  row += 2;
  heading(sheet, row, "Hal yang perlu diperhatikan", lastColumn);
  for (const note of result.notes) {
    row += 1;
    paragraph(sheet, row, note, lastColumn, { charsPerLine: 115 });
  }
  row += 2;
  heading(sheet, row, "Giliran Shift 3 awal bulan depan", lastColumn);
  row += 1;
  const names = new Map(result.members.map((member) => [member.id, member.name]));
  paragraph(sheet, row, `Urutan giliran: ${result.nightQueue.afterMonth.map((id) => names.get(id) ?? id).join(" → ")} (yang paling lama tidak Shift 3 didahulukan).`, lastColumn);

  row += 2;
  heading(sheet, row, "Persetujuan", lastColumn);
  row += 1;
  sheet.mergeCells(row, 1, row, 2);
  setCell(sheet.getCell(row, 1), "Status roster", { bold: true, align: "left" });
  sheet.mergeCells(row, 3, row, 4);
  const statusCell = sheet.getCell(row, 3);
  setCell(statusCell, "DRAF", { bold: true, bg: "FFFFF2CC" });
  statusCell.dataValidation = { type: "list", allowBlank: false, formulae: ['"DRAF,DISETUJUI"'], showErrorMessage: true, error: "Pilih DRAF atau DISETUJUI." };
  sheet.mergeCells(row, 5, row, lastColumn);
  setCell(sheet.getCell(row, 5), "Ganti menjadi DISETUJUI setelah Operations Manager menyetujui. Status ini ikut tampil di sheet Roster.", { size: 9, italic: true, color: C.note, align: "left", border: false });
  const statusAddress = `$C$${row}`;
  row += 1;
  sheet.getRow(row).values = [];
  sheet.mergeCells(row, 1, row, 3);
  sheet.mergeCells(row, 4, row, 7);
  sheet.mergeCells(row, 8, row, 9);
  sheet.mergeCells(row, 10, row, lastColumn);
  sheet.getCell(row, 1).value = "Peran";
  sheet.getCell(row, 4).value = "Nama";
  sheet.getCell(row, 8).value = "Tanggal";
  sheet.getCell(row, 10).value = "Tanda tangan / catatan";
  headerCells(sheet.getRow(row), [1, 4, 8, 10]);
  for (const role of ["Dibuat oleh (Admin)", "Diperiksa oleh (Team Lead)", "Disetujui oleh (Operations Manager)"]) {
    row += 1;
    sheet.mergeCells(row, 1, row, 3);
    sheet.mergeCells(row, 4, row, 7);
    sheet.mergeCells(row, 8, row, 9);
    sheet.mergeCells(row, 10, row, lastColumn);
    setCell(sheet.getCell(row, 1), role, { align: "left", bold: true, wrap: true });
    for (const column of [4, 8, 10]) setCell(sheet.getCell(row, column), "", { bg: "FFFFF2CC" });
    sheet.getRow(row).height = 26;
  }
  return statusAddress;
}

// ---------------- Hari Libur ----------------

function holidaySheet(workbook, result, { holidayCalendars = [], holidayNotes = [], holidayDifferences = [] }) {
  const sheet = workbook.addWorksheet("Hari Libur", { pageSetup: { orientation: "portrait", paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
  const widths = [14, 11, 52, 18];
  widths.forEach((width, index) => (sheet.getColumn(index + 1).width = width));
  title(sheet, `TANGGAL MERAH DAN CUTI BERSAMA ${result.period.year}`, "Tanggal merah dan cuti bersama diisi 1 orang per shift (sama seperti Sabtu/Minggu), sesuai pengaturan di Data Roster.xlsx.", widths.length);
  let row = 4;
  heading(sheet, row, `Di bulan ${monthTitle(result)}`, widths.length);
  row += 1;
  if (result.holidays.length === 0) {
    paragraph(sheet, row, "Tidak ada tanggal merah atau cuti bersama di bulan ini.", widths.length);
  } else {
    for (const holiday of result.holidays) {
      paragraph(sheet, row, `${formatTanggal(holiday.date, { denganHari: true })}: ${holiday.name} (${holiday.type === "national" ? "libur nasional" : "cuti bersama"}${holiday.tentative ? ", tanggal belum pasti" : ""}).`, widths.length);
      row += 1;
    }
  }
  if (holidayDifferences.length > 0) {
    row += 1;
    heading(sheet, row, "Perlu dicek (daftar resmi berbeda dengan Google Calendar)", widths.length);
    for (const difference of holidayDifferences) {
      row += 1;
      paragraph(sheet, row, difference.message, widths.length, { color: C.badText });
    }
  }
  for (const note of holidayNotes) {
    row += 1;
    paragraph(sheet, row, note, widths.length, { italic: true, color: C.note });
  }
  const calendar = holidayCalendars.find((item) => item.year === result.period.year);
  row += 2;
  heading(sheet, row, `Daftar lengkap tahun ${result.period.year}`, widths.length);
  row += 1;
  const verified = calendar?.status === "official-verified";
  const source = calendar?.officialSource?.title ?? calendar?.source?.title ?? "-";
  paragraph(sheet, row, `Sumber: ${source}. Status: ${verified ? "resmi, sudah dicek" : "diambil otomatis dari Google Calendar — mohon dicek dengan SKB 3 Menteri"}.`, widths.length, {
    size: 9, italic: true, color: verified ? C.okText : C.warnText, charsPerLine: 100
  });
  row += 1;
  sheet.getRow(row).values = ["Tanggal", "Hari", "Nama", "Jenis"];
  headerCells(sheet.getRow(row), [1, 2, 3, 4]);
  for (const day of calendar?.days ?? []) {
    row += 1;
    const inMonth = day.date >= result.period.start && day.date <= result.period.end;
    const bg = inMonth ? C.holiday : null;
    setCell(sheet.getCell(row, 1), formatTanggal(day.date, { pendek: true }), { align: "left", bg, bold: inMonth });
    setCell(sheet.getCell(row, 2), namaHari(day.date), { align: "left", bg });
    setCell(sheet.getCell(row, 3), `${day.name}${day.tentative ? " (belum pasti)" : ""}`, { align: "left", bg, wrap: true });
    setCell(sheet.getCell(row, 4), day.type === "national" ? "Libur nasional" : "Cuti bersama", { bg });
  }
}

// ---------------- Info Admin ----------------

function adminSheet(workbook, result, { inputFile, historyLabel, manualChanges = [] }) {
  const sheet = workbook.addWorksheet("Info Admin");
  const history = result.history;
  const lastDays = history.dates.slice(-7);
  const widths = [34, ...lastDays.map(() => 7), 40];
  const lastColumn = Math.max(widths.length, 9);
  for (let index = 0; index < lastColumn; index += 1) sheet.getColumn(index + 1).width = widths[index] ?? 12;
  title(sheet, "INFO UNTUK ADMIN", "Data teknis untuk pengecekan. Operations Manager tidak perlu membaca sheet ini.", lastColumn);
  const names = new Map(result.members.map((member) => [member.id, member.name]));
  const facts = [
    ["Dibuat", createdText(result.generatedAt)],
    ["Versi pembuat roster", result.engineVersion],
    ["File input", inputFile ?? "Data Roster.xlsx"],
    ["Riwayat bulan lalu dari", historyLabel ?? history.source],
    ["Target hari kerja bulan ini", result.settings.targetBasis === "aturan" || !result.settings.targetDetail
      ? `${result.settings.workDaysTarget} hari (diatur di Data Roster.xlsx)`
      : `${result.settings.workDaysTarget} hari (pekerjaan ideal ${result.settings.targetDetail.need} hari-orang ÷ ${result.settings.targetDetail.team.toFixed(1).replace(".", ",")} orang = ${result.settings.targetDetail.share.toFixed(1).replace(".", ",")}; maksimal 5 hari per minggu = ${result.settings.targetDetail.weekCap.toFixed(1).replace(".", ",")})`],
    ["Urutan giliran Shift 3 awal bulan", result.nightQueue.start.map((id) => names.get(id) ?? id).join(" → ")],
    ["Urutan giliran Shift 3 bulan depan", result.nightQueue.afterMonth.map((id) => names.get(id) ?? id).join(" → ")],
    ["Perbaikan otomatis (tukar jadwal atau ubah satu hari)", `${result.search.localSwaps} kali`],
    ["Percobaan pencarian", (result.search.portfolio?.length ?? 1) > 1 ? `${result.search.portfolio.length} percobaan${result.search.perfect?.rounds ? ` (termasuk ${result.search.perfect.rounds} putaran terarah)` : ""}, dipilih nomor ${result.search.chosenVariant} (skor ${result.search.portfolio.map((item) => item.score ?? "gagal").join(" / ")}; makin kecil makin baik)` : "1 (normal)"],
    ["Hasil sempurna", result.search.perfect ? (result.search.perfect.reached ? "Ya" : `Belum: ${[...result.search.perfect.remaining, ...(result.search.perfect.wlbLow ? [`${result.search.perfect.wlbLow} orang skor kerja–hidup < 65`] : [])].join(", ")}`) : "Tidak dinilai (pencarian cepat)"],
    ["Waktu proses", `${Math.round(result.search.runtimeMs / 1000)} detik`]
  ];
  let row = 4;
  for (const [label, value] of facts) {
    setCell(sheet.getCell(row, 1), label, { bold: true, align: "left" });
    sheet.mergeCells(row, 2, row, lastColumn);
    setCell(sheet.getCell(row, 2), value, { align: "left" });
    row += 1;
  }

  row += 1;
  heading(sheet, row, "Sambungan dari bulan lalu (7 hari terakhir)", lastColumn);
  row += 1;
  sheet.getRow(row).values = ["Nama", ...lastDays.map((date) => `${Number(date.slice(8, 10))} ${namaBulan(Number(date.slice(5, 7))).slice(0, 3)}`)];
  headerCells(sheet.getRow(row), [1, ...lastDays.map((_, index) => index + 2)]);
  for (const member of result.members) {
    row += 1;
    setCell(sheet.getCell(row, 1), member.name, { align: "left", bold: true });
    const codes = history.codesById[member.id] ?? [];
    lastDays.forEach((date, index) => {
      const code = codes[codes.length - lastDays.length + index] ?? "-";
      const style = CODE_STYLE[code] ?? CODE_STYLE["-"];
      setCell(sheet.getCell(row, index + 2), code, { bold: true, color: style.font, bg: style.fill ?? null });
    });
  }
  if (manualChanges.length > 0) {
    row += 2;
    heading(sheet, row, "Perubahan manual yang ditemukan di roster bulan lalu", lastColumn);
    for (const change of manualChanges) {
      row += 1;
      paragraph(sheet, row, `${change.name} tgl ${formatTanggal(change.date, { pendek: true })}: ${KODE_LABEL[change.from] ?? change.from} → ${KODE_LABEL[change.to] ?? change.to}`, lastColumn);
    }
  }

  if (result.changes?.length) {
    row += 2;
    heading(sheet, row, `Perubahan dibanding versi sebelumnya (${result.changes.length})`, lastColumn);
    for (const member of result.members) {
      const own = result.changes.filter((change) => change.memberId === member.id);
      if (own.length === 0) continue;
      row += 1;
      paragraph(sheet, row, `${member.name}: ${own.map((change) => `${formatTanggal(change.date, { pendek: true })} ${KODE_LABEL[change.from] ?? change.from} → ${KODE_LABEL[change.to] ?? change.to}`).join("; ")}`, lastColumn);
    }
  }

  row += 2;
  heading(sheet, row, "Blok Shift 3 bulan ini", lastColumn);
  for (const block of result.nightBlocks) {
    row += 1;
    paragraph(sheet, row, `${block.name}: ${formatPeriode(block.start, block.end)} (${block.length} malam)`, lastColumn);
  }

  row += 2;
  heading(sheet, row, "Cuti dan permintaan yang dipakai", lastColumn);
  if (result.requests.length === 0) {
    row += 1;
    paragraph(sheet, row, "Tidak ada.", lastColumn);
  }
  for (const request of result.requests) {
    row += 1;
    paragraph(sheet, row, `${request.name ?? names.get(request.memberId)}: ${request.kind ?? KODE_LABEL[request.code]} ${formatPeriode(request.from, request.to)}${request.note ? ` — ${request.note}` : ""} (${request.source})`, lastColumn);
  }
}

export async function writeRosterWorkbook(result, file, options = {}) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Roster Ops + NOC";
  workbook.created = new Date(result.generatedAt);
  workbook.calcProperties = { fullCalcOnLoad: true };
  const layout = rosterSheet(workbook, result);
  dailySheet(workbook, result, layout);
  backupSheet(workbook, result);
  const ui = { setCell, columnLetter, title, heading, headerCells, paragraph, C };
  const calc = checkSheets(workbook, result, layout, ui);
  const statusAddress = summarySheet(workbook, result, layout, calc.layout);
  checksSheet(workbook, result, layout, ui, calc);
  // Roster sheet header shows the approval status live from the Ringkasan sheet.
  // Its colour rules test the cell itself: Excel treats a colour rule that reads
  // another sheet as damaged and deletes every colour rule on the sheet.
  const rosterStatus = workbook.getWorksheet("Roster").getCell(2, layout.totalsColumn);
  setCell(rosterStatus, { formula: `"Status roster: "&Ringkasan!${statusAddress}`, result: "Status roster: DRAF" }, { bold: true, size: 10, align: "center" });
  const self = `$${columnLetter(layout.totalsColumn)}$2`;
  workbook.getWorksheet("Roster").addConditionalFormatting({
    ref: rosterStatus.address,
    rules: [
      { type: "expression", priority: 60, formulae: [`${self}="Status roster: DISETUJUI"`], style: { font: { color: { argb: C.okText }, bold: true }, fill: { type: "pattern", pattern: "solid", bgColor: { argb: C.okFill } } } },
      { type: "expression", priority: 61, formulae: [`${self}<>"Status roster: DISETUJUI"`], style: { font: { color: { argb: C.warnText }, bold: true }, fill: { type: "pattern", pattern: "solid", bgColor: { argb: C.warnFill } } } }
    ]
  });
  holidaySheet(workbook, result, options);
  adminSheet(workbook, result, options);
  workbook.getWorksheet("Hitungan").orderNo = 1000; // hidden helper sheet goes last
  await workbook.xlsx.writeFile(file);
  return file;
}

export { HARI };
