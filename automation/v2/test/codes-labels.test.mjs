import assert from "node:assert/strict";
import test from "node:test";
import { CODE, isOffLike, isShiftCode, isWorkLike, normalizeCode } from "../src/codes.mjs";
import { formatDaftarTanggal, formatTanggal, KODE_LABEL, namaBulan, namaHariPendek } from "../src/labels-id.mjs";
import { addMonths, daysInMonth, monthKey, parseMonthKey } from "../src/date-utils.mjs";

const SHIFTS = ["1", "2", "3"];

test("normalizeCode maps legacy and messy codes", () => {
  assert.equal(normalizeCode("T2"), "T");
  assert.equal(normalizeCode("t1"), "T");
  assert.equal(normalizeCode("OFF"), "-");
  assert.equal(normalizeCode(" h "), "H");
  assert.equal(normalizeCode(1), "1");
  assert.equal(normalizeCode("–"), "-");
  assert.equal(normalizeCode(""), "-");
});

test("normalizeCode rejects unknown codes in Indonesian", () => {
  assert.throws(() => normalizeCode("Q"), /Kode "Q" tidak dikenal/);
});

test("code classification separates work, training and off", () => {
  assert.equal(isShiftCode("3", SHIFTS), true);
  assert.equal(isShiftCode(CODE.TRAINING, SHIFTS), false);
  assert.equal(isWorkLike(CODE.TRAINING, SHIFTS), true);
  assert.equal(isWorkLike("2", SHIFTS), true);
  assert.equal(isWorkLike(CODE.OFF, SHIFTS), false);
  for (const code of [CODE.OFF, CODE.LEAVE, CODE.SICK, CODE.INACTIVE]) assert.equal(isOffLike(code), true);
  assert.equal(isOffLike("1"), false);
  assert.equal(isOffLike(CODE.TRAINING), false);
});

test("Indonesian labels", () => {
  assert.equal(namaBulan(10), "Oktober");
  assert.equal(namaHariPendek("2026-10-01"), "Kam");
  assert.equal(formatTanggal("2026-10-01", { denganHari: true }), "Kamis, 1 Oktober 2026");
  assert.equal(formatTanggal("2026-10-01", { pendek: true }), "1 Okt");
});

test("month helpers", () => {
  assert.equal(monthKey(2026, 9), "2026-09");
  assert.deepEqual(parseMonthKey("2026-10"), { year: 2026, month: 10 });
  assert.equal(addMonths("2026-12", 1), "2027-01");
  assert.equal(addMonths("2026-01", -1), "2025-12");
  assert.equal(daysInMonth(2028, 2), 29);
  assert.throws(() => parseMonthKey("2026-13"), /Bulan tidak valid/);
});

test("formatDaftarTanggal: scattered dates in plain Indonesian, the month once", () => {
  assert.equal(formatDaftarTanggal(["2026-11-05", "2026-11-12", "2026-11-13", "2026-11-14", "2026-11-20"]), "5, 12–14 dan 20 Nov");
  assert.equal(formatDaftarTanggal(["2026-11-16", "2026-11-17", "2026-11-18"]), "16–18 Nov");
  assert.equal(formatDaftarTanggal(["2026-11-30", "2026-12-01", "2026-12-05"]), "30 Nov – 1 Des dan 5 Des");
  assert.equal(formatDaftarTanggal(["2026-11-05"]), "5 Nov");
});

test("R is Shift Reguler (user, 28 Oct): a work day, not one of the 24/7 shifts", () => {
  assert.equal(normalizeCode("r"), "R", "no longer an old spelling of H: no roster used it");
  assert.equal(isWorkLike("R"), true);
  assert.equal(isShiftCode("R"), false);
  assert.equal(KODE_LABEL.R, "Shift Reguler");
});
