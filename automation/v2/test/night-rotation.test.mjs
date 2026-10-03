import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { deriveMemberState } from "../src/history.mjs";
import { initialNightState, nightOptions } from "../src/night-rotation.mjs";
import { initialMemberState } from "../src/rules.mjs";
import { parseRosterCsv } from "../src/roster-csv.mjs";

const SHIFTS = [
  { id: "1", start: "07:00", end: "16:00", level: 1 },
  { id: "2", start: "13:00", end: "21:00", level: 2 },
  { id: "3", start: "21:00", end: "07:00", level: 3, night: true }
];
const ctx = {
  shiftById: new Map(SHIFTS.map((shift) => [shift.id, shift])),
  shiftIds: ["1", "2", "3"],
  nightShiftId: "3",
  trainingWindow: { start: "08:00", end: "17:00" },
  rules: { maxConsecutiveWorkDays: 5, minimumRestHours: 11, nightRecoveryOffDays: 2, nightBlock: { min: 2, preferred: 2, max: 3 } }
};
const all = ["1", "2", "3"];
const MEMBERS = [
  { id: "hilvani", name: "Hilvani", eligibleShifts: ["1", "2"] },
  { id: "pavitasari", name: "Pavitasari", eligibleShifts: ["1", "2"] },
  { id: "rizky", name: "Rizky", eligibleShifts: all },
  { id: "willy", name: "Willy", eligibleShifts: all },
  { id: "arman", name: "Arman", eligibleShifts: all },
  { id: "addin", name: "Addin", eligibleShifts: all }
];
const september = parseRosterCsv(readFileSync(new URL("./fixtures/september-2026.csv", import.meta.url), "utf8"));
const octoberStates = new Map(MEMBERS.map((member) => [member.id, initialMemberState(deriveMemberState(september.codesById[member.id], ctx), member)]));
const QUEUE = ["addin", "rizky", "willy", "arman"];
const plainDay = (date, dayIndex, extra = {}) => ({ date, dayIndex, isFirstOfMonth: false, isLastOfMonth: false, hasTomorrow: true, ...extra });
const rested = new Map(MEMBERS.map((member) => [member.id, initialMemberState(deriveMemberState(["1", "H", "H"], ctx), member)]));

test("initial night state comes from the history's last night block", () => {
  const night = initialNightState(september.codesById, QUEUE, "3");
  assert.deepEqual(night, { owner: "arman", length: 2, queue: QUEUE });
});

test("1 Oct: Addin cannot start (4-day streak), so Rizky takes the first block", () => {
  const night = initialNightState(september.codesById, QUEUE, "3");
  const options = nightOptions({ night, day: plainDay("2026-10-01", 0, { isFirstOfMonth: true }), fixedToday: {}, fixedTomorrow: {}, states: octoberStates, members: MEMBERS, ctx });
  assert.equal(options.length, 1);
  assert.equal(options[0].owner, "rizky");
  assert.deepEqual(options[0].night, { owner: "rizky", length: 1, queue: ["addin", "willy", "arman", "rizky"] });
});

test("a block shorter than the minimum must continue", () => {
  const options = nightOptions({ night: { owner: "rizky", length: 1, queue: ["addin", "willy", "arman", "rizky"] }, day: plainDay("2026-10-02", 1), fixedToday: {}, fixedTomorrow: {}, states: rested, members: MEMBERS, ctx });
  assert.deepEqual(options.map((option) => option.owner), ["rizky"]);
  assert.equal(options[0].night.length, 2);
});

test("after 2 nights the search may extend to 3 or hand over to the next person", () => {
  const options = nightOptions({ night: { owner: "rizky", length: 2, queue: ["addin", "willy", "arman", "rizky"] }, day: plainDay("2026-10-03", 2), fixedToday: {}, fixedTomorrow: {}, states: rested, members: MEMBERS, ctx });
  assert.deepEqual(options.map((option) => option.owner), ["rizky", "addin"]);
  assert.deepEqual(options[1].night, { owner: "addin", length: 1, queue: ["willy", "arman", "rizky", "addin"] });
});

test("after 3 nights the block must hand over", () => {
  const options = nightOptions({ night: { owner: "rizky", length: 3, queue: ["addin", "willy", "arman", "rizky"] }, day: plainDay("2026-10-04", 3), fixedToday: {}, fixedTomorrow: {}, states: rested, members: MEMBERS, ctx });
  assert.deepEqual(options.map((option) => option.owner), ["addin"]);
});

test("blocks never cross into a new month and never start on the last day", () => {
  const first = nightOptions({ night: { owner: "rizky", length: 2, queue: ["addin", "willy", "arman", "rizky"] }, day: plainDay("2026-11-01", 31, { isFirstOfMonth: true }), fixedToday: {}, fixedTomorrow: {}, states: rested, members: MEMBERS, ctx });
  assert.deepEqual(first.map((option) => option.owner), ["addin"]);
  const last = nightOptions({ night: { owner: "rizky", length: 2, queue: ["addin", "willy", "arman", "rizky"] }, day: plainDay("2026-10-31", 30, { isLastOfMonth: true }), fixedToday: {}, fixedTomorrow: {}, states: rested, members: MEMBERS, ctx });
  assert.deepEqual(last.map((option) => option.owner), ["rizky"]);
  const stuck = nightOptions({ night: { owner: "rizky", length: 3, queue: ["addin", "willy", "arman", "rizky"] }, day: plainDay("2026-10-31", 30, { isLastOfMonth: true }), fixedToday: {}, fixedTomorrow: {}, states: rested, members: MEMBERS, ctx });
  assert.deepEqual(stuck, []);
});

test("someone with leave tomorrow is skipped and keeps their place in the queue", () => {
  const options = nightOptions({ night: { owner: "rizky", length: 3, queue: ["addin", "willy", "arman", "rizky"] }, day: plainDay("2026-10-04", 3), fixedToday: {}, fixedTomorrow: { addin: "C" }, states: rested, members: MEMBERS, ctx });
  assert.deepEqual(options.map((option) => option.owner), ["willy"]);
  assert.deepEqual(options[0].night.queue, ["addin", "arman", "rizky", "willy"]);
});

test("a requested Shift 3 overrides the queue", () => {
  const options = nightOptions({ night: { owner: "rizky", length: 3, queue: ["addin", "willy", "arman", "rizky"] }, day: plainDay("2026-10-04", 3), fixedToday: { arman: "3" }, fixedTomorrow: {}, states: rested, members: MEMBERS, ctx });
  assert.deepEqual(options.map((option) => option.owner), ["arman"]);
  assert.deepEqual(options[0].night.queue, ["addin", "willy", "rizky", "arman"]);
});

test("members outside their active dates are skipped", () => {
  const members = MEMBERS.map((member) => (member.id === "addin" ? { ...member, activeFrom: "2026-10-10" } : member));
  const options = nightOptions({ night: { owner: "rizky", length: 3, queue: ["addin", "willy", "arman", "rizky"] }, day: plainDay("2026-10-04", 3), fixedToday: {}, fixedTomorrow: {}, states: rested, members, ctx });
  assert.deepEqual(options.map((option) => option.owner), ["willy"]);
});
