// Verifies a roster workbook the way every Excel change must be verified:
//   node tools/verify-excel.mjs "../../hasil/2026-10/Roster Oktober 2026.xlsx"
// 1. A copy is recalculated by LibreOffice: no formula may end in an error.
// 2. Every cached formula value (written by the program) equals LibreOffice's.
// 3. Colour rules only read their own sheet (Excel deletes them otherwise).
// The original file is not changed.
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import { recalculate } from "./recalc.mjs";

const valueOf = (value) => {
  if (value && typeof value === "object" && "result" in value) return value.result;
  if (value && typeof value === "object" && ("formula" in value || "sharedFormula" in value)) return undefined;
  return value;
};
const isFormula = (value) => value && typeof value === "object" && ("formula" in value || "sharedFormula" in value);
const same = (a, b) => {
  const left = a === undefined || a === null ? "" : a;
  const right = b === undefined || b === null ? "" : b;
  if (typeof left === "number" && typeof right === "number") return Math.abs(left - right) < 1e-9;
  if (typeof left === "boolean" || typeof right === "boolean") return Number(left) === Number(right);
  return String(left) === String(right);
};

export async function verifyWorkbook(file) {
  const dir = mkdtempSync(path.join(tmpdir(), "roster-verify-"));
  const copy = path.join(dir, "salinan.xlsx");
  try {
    copyFileSync(file, copy);
    recalculate(copy);
    const original = new ExcelJS.Workbook();
    await original.xlsx.readFile(file);
    const computed = new ExcelJS.Workbook();
    await computed.xlsx.readFile(copy);
    const report = { formulas: 0, errors: [], mismatches: [], crossSheetColourRules: [] };
    original.eachSheet((sheet) => {
      const other = computed.getWorksheet(sheet.name);
      sheet.eachRow((row, rowNumber) => row.eachCell((cell, columnNumber) => {
        if (!isFormula(cell.value)) return;
        report.formulas += 1;
        const after = valueOf(other.getCell(rowNumber, columnNumber).value);
        if (after && typeof after === "object" && "error" in after) report.errors.push(`${sheet.name}!${cell.address} ${after.error}`);
        else if (!same(valueOf(cell.value), after)) report.mismatches.push(`${sheet.name}!${cell.address}: tersimpan ${JSON.stringify(valueOf(cell.value))}, LibreOffice ${JSON.stringify(after)}`);
      }));
      for (const block of sheet.conditionalFormattings ?? []) {
        for (const rule of block.rules ?? []) {
          for (const formula of rule.formulae ?? []) if (/!/.test(formula)) report.crossSheetColourRules.push(`${sheet.name} ${block.ref}: ${formula}`);
        }
      }
    });
    report.ok = report.errors.length === 0 && report.mismatches.length === 0 && report.crossSheetColourRules.length === 0;
    return report;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const file = process.argv[2];
  if (!file) {
    console.error('Pakai: node tools/verify-excel.mjs "<file roster .xlsx>"');
    process.exit(2);
  }
  const report = await verifyWorkbook(file);
  console.log(`Rumus: ${report.formulas} · error: ${report.errors.length} · beda dengan LibreOffice: ${report.mismatches.length} · aturan warna lintas sheet: ${report.crossSheetColourRules.length}`);
  for (const line of [...report.errors, ...report.mismatches, ...report.crossSheetColourRules].slice(0, 30)) console.log(`  - ${line}`);
  process.exit(report.ok ? 0 : 1);
}
