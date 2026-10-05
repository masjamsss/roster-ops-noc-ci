import assert from "node:assert/strict";
import test from "node:test";
import { parseTanggal } from "../src/console-input.mjs";

test("dates as admins type them: 16/11/2026, 16-11-2026, 2026-11-16, or 16/11 in the month's year", () => {
  assert.equal(parseTanggal("16/11/2026"), "2026-11-16");
  assert.equal(parseTanggal(" 5-10-2026 "), "2026-10-05");
  assert.equal(parseTanggal("2026-10-05"), "2026-10-05");
  assert.equal(parseTanggal("16/11", { year: 2026 }), "2026-11-16");
  assert.equal(parseTanggal("31/02/2026"), null, "no such day");
  assert.equal(parseTanggal("besok"), null);
  assert.equal(parseTanggal(""), null);
});
