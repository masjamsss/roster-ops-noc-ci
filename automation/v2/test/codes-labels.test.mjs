import assert from "node:assert/strict";
import test from "node:test";
import { CODE, isOffLike, isShiftCode, isWorkLike, normalizeCode } from "../src/codes.mjs";
import { formatTanggal, namaBulan, namaHariPendek } from "../src/labels-id.mjs";
import { addMonths, daysInMonth, monthKey, parseMonthKey } from "../src/date-utils.mjs";

const SHIFTS = ["1", "2", "3"];

test("normalizeCode maps legacy and messy codes", () => {
  assert.equal(normalizeCode("T2"), "T");
  assert.equal(normalizeCode("t1"), "T");
  assert.equal(normalizeCode("OFF"), "-");
  assert.equal(normalizeCode("R"), "H");
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
