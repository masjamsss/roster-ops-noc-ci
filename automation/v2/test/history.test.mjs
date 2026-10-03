import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { deriveMemberState, deriveNightQueue, NO_HISTORY } from "../src/history.mjs";
import { parseRosterCsv } from "../src/roster-csv.mjs";

const SHIFTS = [
  { id: "1", start: "07:00", end: "16:00", level: 1 },
  { id: "2", start: "13:00", end: "21:00", level: 2 },
  { id: "3", start: "21:00", end: "07:00", level: 3, night: true }
];
const ctx = { shiftById: new Map(SHIFTS.map((shift) => [shift.id, shift])), nightShiftId: "3", trainingWindow: { start: "08:00", end: "17:00" } };
const september = parseRosterCsv(readFileSync(new URL("./fixtures/september-2026.csv", import.meta.url), "utf8"));

test("parseRosterCsv reads ids, names, dates and normalized codes", () => {
  assert.equal(september.dates.length, 30);
  assert.equal(september.dates[0], "2026-09-01");
  assert.deepEqual(september.memberIds, ["hilvani", "pavitasari", "rizky", "willy", "arman", "addin"]);
  assert.equal(september.names.addin, "Addin");
  assert.deepEqual(september.codesById.addin.slice(-4), ["1", "2", "2", "2"]);
});

test("Addin carries a 4-day work streak into October (the bug Codex missed)", () => {
  const state = deriveMemberState(september.codesById.addin, ctx);
  assert.equal(state.previousCode, "2");
  assert.equal(state.workStreak, 4);
  assert.equal(state.shiftStreak, 3);
  assert.equal(state.lastWorkBlockLength, 4);
  assert.equal(state.lastWorkWasNight, false);
  assert.equal(state.lastWorkEnd, -3);
});

test("Pavitasari ends September on a single Shift 2 day", () => {
  const state = deriveMemberState(september.codesById.pavitasari, ctx);
  assert.equal(state.workStreak, 3);
  assert.equal(state.shiftStreak, 1);
});

test("Arman ends September inside a night block that needs recovery", () => {
  const state = deriveMemberState(september.codesById.arman, ctx);
  assert.equal(state.previousCode, "3");
  assert.equal(state.nightStreakAtEnd, 2);
  assert.equal(state.lastWorkWasNight, true);
  assert.equal(state.restStreak, 0);
  assert.equal(state.lastWorkEnd, 7);
});

test("Willy has finished his night recovery on 29-30 Sep", () => {
  const state = deriveMemberState(september.codesById.willy, ctx);
  assert.equal(state.workStreak, 0);
  assert.equal(state.offStreak, 2);
  assert.equal(state.restStreak, 2);
  assert.equal(state.lastWorkedShift, "3");
  assert.equal(state.lastWorkWasNight, true);
  assert.equal(state.daysSinceWork, 2);
});

test("Hilvani ends on one H after a two-day block", () => {
  const state = deriveMemberState(september.codesById.hilvani, ctx);
  assert.equal(state.previousCode, "H");
  assert.equal(state.previousPreviousCode, "2");
  assert.equal(state.offStreak, 1);
  assert.equal(state.lastWorkBlockLength, 2);
  assert.equal(state.daysSinceWork, 1);
});

test("training counts toward the work streak but not the shift streak", () => {
  const state = deriveMemberState(["H", "T", "T", "1", "1"], ctx);
  assert.equal(state.workStreak, 4);
  assert.equal(state.shiftStreak, 2);
});

test("a member without history starts fully rested", () => {
  const state = deriveMemberState([], ctx);
  assert.equal(state.workStreak, 0);
  assert.equal(state.offStreak, 0);
  assert.equal(state.restStreak, NO_HISTORY);
  assert.equal(state.lastWorkedShift, null);
  assert.equal(state.lastWorkEnd, null);
  assert.equal(state.lastWorkWasNight, false);
});

test("October night queue follows September's rotation: oldest night first", () => {
  const queue = deriveNightQueue(september.codesById, ["rizky", "willy", "arman", "addin"]);
  assert.deepEqual(queue, ["addin", "rizky", "willy", "arman"]);
});

test("a newcomer without nights joins the queue first, in row order among equals", () => {
  const codes = { ...september.codesById, budi: [], citra: [] };
  const queue = deriveNightQueue(codes, ["rizky", "willy", "arman", "addin", "budi", "citra"]);
  assert.deepEqual(queue, ["budi", "citra", "addin", "rizky", "willy", "arman"]);
});
