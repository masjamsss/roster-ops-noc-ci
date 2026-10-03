import assert from "node:assert/strict";
import test from "node:test";
import { needsPlainText, plainText } from "../src/console-text.mjs";

test("on the old Windows console (no Windows Terminal) symbols become plain ASCII; elsewhere text is unchanged", () => {
  assert.equal(needsPlainText({ platform: "win32", env: {} }), true, "Windows 10 conhost");
  assert.equal(needsPlainText({ platform: "win32", env: { WT_SESSION: "x" } }), false, "Windows Terminal shows the symbols");
  assert.equal(needsPlainText({ platform: "darwin", env: {} }), false);
  assert.equal(plainText("✔ Roster Oktober selesai — 12/12 aturan • ✖ 1 → ⚠ Shift 1↔2 …"), "OK Roster Oktober selesai - 12/12 aturan - X 1 -> ! Shift 1<->2 ...");
  assert.equal(plainText("Hari kerja (Senin–Jumat)"), "Hari kerja (Senin-Jumat)");
});
