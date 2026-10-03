import assert from "node:assert/strict";
import test from "node:test";
import { overtimeCover } from "../src/backup-plan.mjs";

const SHIFTS = [
  { id: "1", start: "07:00", end: "16:00" },
  { id: "2", start: "13:00", end: "21:00" },
  { id: "3", start: "21:00", end: "07:00", night: true }
];
const people = ["ani", "budi", "cici", "dodi"].map((id) => ({ id, name: id[0].toUpperCase() + id.slice(1) }));
// Timelines: one string of codes per person, day 0 first. Hours count from day 0, 00:00.
const cover = (timeline, dayIndex, shiftId, overtimeHours = 4) => overtimeCover({
  dayIndex, shiftId, timeline: Object.fromEntries(Object.entries(timeline).map(([id, codes]) => [id, [...codes]])),
  members: people, shifts: SHIFTS, minimumRestHours: 11, overtimeHours
});

test("Shift 1 with one person: the night stays until 11:00 and Shift 2 comes at 09:00, so the gap is covered", () => {
  const plan = cover({ ani: "H1HH", budi: "H2HH", cici: "3HHH", dodi: "HHHH" }, 1, "1");
  assert.deepEqual(plan.gap, { from: 31, to: 37 }, "07:00-13:00 on day 1; from 13:00 Shift 2 is there");
  assert.deepEqual(plan.extension, { id: "cici", name: "Cici", from: 31, to: 35 });
  assert.deepEqual(plan.early, { id: "budi", name: "Budi", from: 33, to: 37 });
  assert.deepEqual(plan.uncovered, []);
});

test("a night that continues the same evening may stay only until 10:00 (11 hours rest before 21:00)", () => {
  const plan = cover({ ani: "H1HH", budi: "H2HH", cici: "333H", dodi: "HHHH" }, 1, "1");
  assert.deepEqual(plan.extension, { id: "cici", name: "Cici", from: 31, to: 34 });
  assert.deepEqual(plan.uncovered, [], "Shift 2 from 09:00 still closes the gap");
});

test("Shift 2 with one person: Shift 1 stays until 20:00 and the night comes early", () => {
  const plan = cover({ ani: "H1HH", budi: "H2HH", cici: "H3HH", dodi: "HHHH" }, 1, "2");
  assert.deepEqual(plan.gap, { from: 40, to: 45 }, "16:00-21:00 on day 1");
  assert.deepEqual(plan.extension, { id: "ani", name: "Ani", from: 40, to: 44 });
  assert.deepEqual(plan.early, { id: "cici", name: "Cici", from: 41, to: 45 });
  assert.deepEqual(plan.uncovered, []);
});

test("a night person who also worked last night may come only 3 hours early (11 hours rest after 07:00)", () => {
  const plan = cover({ ani: "H1HH", budi: "H2HH", cici: "33HH", dodi: "HHHH" }, 1, "2");
  assert.deepEqual(plan.early, { id: "cici", name: "Cici", from: 42, to: 45 });
  assert.deepEqual(plan.uncovered, []);
});

test("Shift 3 can never be covered by overtime alone: 01:00-03:00 stays open", () => {
  const plan = cover({ ani: "H11H", budi: "H2HH", cici: "H3HH", dodi: "HHHH" }, 1, "3");
  assert.deepEqual(plan.gap, { from: 45, to: 55 }, "21:00 day 1 to 07:00 day 2");
  assert.deepEqual(plan.extension, { id: "budi", name: "Budi", from: 45, to: 49 });
  assert.deepEqual(plan.early, { id: "ani", name: "Ani", from: 51, to: 55 });
  assert.deepEqual(plan.uncovered, [{ from: 49, to: 51 }]);
});

test("the overtime limit comes from the settings: with 2 hours, one hour of a Shift 2 gap stays open", () => {
  const plan = cover({ ani: "H1HH", budi: "H2HH", cici: "H3HH", dodi: "HHHH" }, 1, "2", 2);
  assert.deepEqual(plan.uncovered, [{ from: 42, to: 43 }]);
});

test("a shift with two people is safe: no gap at all", () => {
  const plan = cover({ ani: "H1HH", budi: "H1HH", cici: "H3HH", dodi: "H2HH" }, 1, "1");
  assert.equal(plan.safe, true);
  assert.deepEqual(plan.people, ["Ani", "Budi"]);
  assert.equal(plan.gap, null);
});

test("people who may not work Shift 3 are never asked to cover night hours with overtime", () => {
  const team = [
    { id: "ani", name: "Ani", eligibleShifts: ["1", "2"] },
    { id: "budi", name: "Budi", eligibleShifts: ["1", "2"] },
    { id: "cici", name: "Cici", eligibleShifts: ["1", "2", "3"] },
    { id: "dodi", name: "Dodi", eligibleShifts: ["1", "2", "3"] },
    { id: "eko", name: "Eko", eligibleShifts: ["1", "2", "3"] }
  ];
  const night = (timeline) => overtimeCover({ dayIndex: 1, shiftId: "3", members: team, shifts: SHIFTS, minimumRestHours: 11, overtimeHours: 4, timeline });
  // Shift 2 on day 1: Budi and Dodi. Shift 1 on day 2: Ani and Eko. Cici's night is open.
  const mixed = night({ ani: [..."H11H"], budi: [..."H2HH"], cici: [..."H3HH"], dodi: [..."H2HH"], eko: [..."H11H"] });
  assert.deepEqual(mixed.extension, { id: "dodi", name: "Dodi", from: 45, to: 49 }, "Dodi stays until 01:00, not Budi");
  assert.deepEqual(mixed.early, { id: "eko", name: "Eko", from: 51, to: 55 }, "Eko comes at 03:00, not Ani");
  const womenOnly = night({ ani: [..."H11H"], budi: [..."H2HH"], cici: [..."H3HH"], dodi: [..."HHHH"], eko: [..."HHHH"] });
  assert.equal(womenOnly.extension, null);
  assert.equal(womenOnly.early, null);
  assert.deepEqual(womenOnly.uncovered, [{ from: 45, to: 55 }], "the whole night stays open");
});
