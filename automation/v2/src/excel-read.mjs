// Reads the Roster sheet back (e.g. after the OM typed a swap), using the hidden
// helper row (ISO dates + ROSTER:YYYY-MM marker) and the hidden ID column.
import ExcelJS from "exceljs";
import { normalizeCode } from "./codes.mjs";
import { RosterError } from "./errors.mjs";
import { columnLetter } from "./excel-export.mjs";

function text(cell) {
  const value = cell?.value;
  if (value === null || value === undefined) return "";
  if (typeof value === "object") {
    if (Array.isArray(value.richText)) return value.richText.map((part) => part.text).join("");
    if (value.result !== undefined) return String(value.result);
    if (value.text !== undefined) return String(value.text);
  }
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value);
}

export async function readRosterWorkbook(file) {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.readFile(file);
  } catch (error) {
    throw new RosterError(`File roster "${file}" tidak bisa dibuka (${error.message}). Pastikan file sudah ditutup di Excel.`);
  }
  const sheet = workbook.getWorksheet("Roster");
  if (!sheet) throw new RosterError(`File "${file}" tidak punya sheet "Roster".`);

  let helperRow = null;
  let monthKey = null;
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    const match = /^ROSTER:(\d{4}-\d{2})$/.exec(text(row.getCell(1)).trim());
    if (match && helperRow === null) {
      helperRow = rowNumber;
      monthKey = match[1];
    }
  });
  if (helperRow === null) throw new RosterError(`Sheet "Roster" di "${file}" tidak punya baris penanda tersembunyi. Jangan hapus baris tersembunyi di bawah tabel.`);

  const dates = [];
  const dateColumns = [];
  sheet.getRow(helperRow).eachCell((cell, column) => {
    const value = text(cell).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      dates.push(value);
      dateColumns.push(column);
    }
  });

  let idColumn = null;
  let headerRow = null;
  for (let rowNumber = 1; rowNumber < helperRow && idColumn === null; rowNumber += 1) {
    sheet.getRow(rowNumber).eachCell((cell, column) => {
      if (text(cell).trim() === "ID" && column > dateColumns.at(-1)) {
        idColumn = column;
        headerRow = rowNumber;
      }
    });
  }
  if (idColumn === null) throw new RosterError(`Sheet "Roster" di "${file}": kolom ID tersembunyi tidak ditemukan.`);

  const members = [];
  const codesById = {};
  const problems = [];
  for (let rowNumber = headerRow + 1; rowNumber < helperRow; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    const id = text(row.getCell(idColumn)).trim();
    if (!id) break;
    const name = text(row.getCell(2)).trim() || id;
    members.push({ id, name });
    codesById[id] = dateColumns.map((column, index) => {
      const raw = text(row.getCell(column));
      if (raw.trim() === "") {
        problems.push(`${name} tgl ${Number(dates[index].slice(8, 10))} (sel ${columnLetter(column)}${rowNumber}) kosong.`);
        return "-";
      }
      try {
        return normalizeCode(raw);
      } catch {
        problems.push(`${name} tgl ${Number(dates[index].slice(8, 10))} (sel ${columnLetter(column)}${rowNumber}) berisi "${raw.trim()}", bukan kode yang dikenal.`);
        return "-";
      }
    });
  }
  let approval = "";
  const summary = workbook.getWorksheet("Ringkasan");
  summary?.eachRow((row) => row.eachCell((cell, column) => {
    if (text(cell).trim() === "Status roster") approval = text(row.getCell(column + 2)).trim().toUpperCase();
  }));
  return { monthKey, dates, members, codesById, problems, approval };
}
