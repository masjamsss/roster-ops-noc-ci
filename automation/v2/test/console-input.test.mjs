import assert from "node:assert/strict";
import test from "node:test";
import { parseDaftarTanggal, parseTanggal } from "../src/console-input.mjs";

test("dates as admins type them: 16/11/2026, 16-11-2026, 2026-11-16, or 16/11 in the month's year", () => {
  assert.equal(parseTanggal("16/11/2026"), "2026-11-16");
  assert.equal(parseTanggal(" 5-10-2026 "), "2026-10-05");
  assert.equal(parseTanggal("2026-10-05"), "2026-10-05");
  assert.equal(parseTanggal("16/11", { year: 2026 }), "2026-11-16");
  assert.equal(parseTanggal("31/02/2026"), null, "no such day");
  assert.equal(parseTanggal("besok"), null);
  assert.equal(parseTanggal(""), null);
});

test("several dates at once: single days and ranges, separated by commas (e.g. exam days of a certification)", () => {
  assert.deepEqual(parseDaftarTanggal("5/11, 12/11-14/11, 20/11", { year: 2026 }), {
    periods: [{ from: "2026-11-05", to: "2026-11-05" }, { from: "2026-11-12", to: "2026-11-14" }, { from: "2026-11-20", to: "2026-11-20" }]
  });
  // Dashes inside dates still work; "sampai", "s/d" and "–" also mark a range; ";" also separates.
  assert.deepEqual(parseDaftarTanggal("16-11-2026 - 18-11-2026; 24/11 sampai 25/11; 27/11 s/d 28/11", { year: 2026 }).periods, [
    { from: "2026-11-16", to: "2026-11-18" }, { from: "2026-11-24", to: "2026-11-25" }, { from: "2026-11-27", to: "2026-11-28" }
  ]);
  assert.deepEqual(parseDaftarTanggal("20/11, 5/11", { year: 2026 }).periods.map((period) => period.from), ["2026-11-05", "2026-11-20"], "in date order");
  assert.deepEqual(parseDaftarTanggal("12/11, 13/11, 14/11, 13/11", { year: 2026 }).periods, [{ from: "2026-11-12", to: "2026-11-14" }], "touching days become one row");
  assert.deepEqual(parseDaftarTanggal("16/11", { year: 2026 }).periods, [{ from: "2026-11-16", to: "2026-11-16" }]);
});

test("several dates at once: a wrong item is named, and dates without a year roll into next year when long past", () => {
  assert.deepEqual(parseDaftarTanggal("5/11, besok", { year: 2026 }), { periods: null, invalid: "besok" });
  assert.deepEqual(parseDaftarTanggal("14/11-12/11", { year: 2026 }), { periods: null, invalid: "14/11-12/11" }, "end before start");
  assert.deepEqual(parseDaftarTanggal("", { year: 2026 }), { periods: null, invalid: "" });
  // Typed in late November: January means next January; a range over New Year ends next year.
  assert.deepEqual(parseDaftarTanggal("5/1, 28/12-3/1", { year: 2026, today: "2026-11-28" }).periods, [
    { from: "2026-12-28", to: "2027-01-03" }, { from: "2027-01-05", to: "2027-01-05" }
  ]);
  assert.deepEqual(parseDaftarTanggal("5/1/2026", { year: 2026, today: "2026-11-28" }).periods, [{ from: "2026-01-05", to: "2026-01-05" }], "a typed year is kept");
});
