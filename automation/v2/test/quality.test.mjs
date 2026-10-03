import assert from "node:assert/strict";
import test from "node:test";
import { reviewQuality } from "../src/quality.mjs";

// A hand-made week, Thu 1 Oct - Wed 7 Oct 2026 (Fri = 2 Oct, weekend = 3-4 Oct).
const DATES = ["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07"];
const members = [
  { id: "ani", name: "Ani", gender: "P", eligibleShifts: ["1", "2"], dayOnly: true },
  { id: "bela", name: "Bela", gender: "P", eligibleShifts: ["1", "2"], dayOnly: true },
  { id: "cahyo", name: "Cahyo", gender: "L", eligibleShifts: ["1", "2", "3"], dayOnly: false },
  { id: "dodi", name: "Dodi", gender: "L", eligibleShifts: ["1", "2", "3"], dayOnly: false }
];
const table = (rows) => Object.fromEntries(Object.entries(rows).map(([id, codes]) => [id, Object.fromEntries(DATES.map((date, i) => [date, codes[i]]))]));
// Friday 2 Oct: Shift 1 is Cahyo only, while Ani is free (H). Ani works a single day on Sunday 4 Oct.
const messy = table({ ani: "1HH1H11", bela: "2222HH2", cahyo: "H1133HH", dodi: "33H2H33" });
const tidy = table({ ani: "11HH111", bela: "2222HH2", cahyo: "H2233HH", dodi: "33HH133" });
const summary = (overrides = {}) => ({
  workDays: 5, workTarget: 5, availableDays: 7, shifts: { 1: 2, 2: 2, 3: 1 }, fullWeekendsOff: 1, inactiveDays: 0,
  leaveDays: 0, sickDays: 0, trainingDays: 0, weeklyHours: [{ weekStart: "2026-09-28", hours: 38 }], ...overrides
});
const day = (date, special, counts, status) => ({ date, isSpecial: special, isWeekend: special, counts, status });
const calmDays = DATES.map((date, i) => day(date, i === 2 || i === 3, i === 2 || i === 3 ? { 1: 1, 2: 1, 3: 1 } : { 1: 2, 2: 1, 3: 1 }, i === 2 || i === 3 ? "OK" : "CUKUP"));
const base = {
  members,
  settings: { rules: { weeklyHoursLimit: 40 } },
  schedule: tidy,
  days: calmDays,
  memberSummary: {
    ani: summary({ shifts: { 1: 3, 2: 2, 3: 0 } }),
    bela: summary({ shifts: { 1: 2, 2: 3, 3: 0 } }),
    cahyo: summary({ shifts: { 1: 1, 2: 2, 3: 2 } }),
    dodi: summary({ shifts: { 1: 1, 2: 1, 3: 3 } })
  }
};

test("a clean roster gets no findings", () => {
  assert.deepEqual(reviewQuality(base).findings.map((finding) => finding.id), []);
});

test("the automatic quality review finds what a careful planner would flag", () => {
  const review = reviewQuality({
    ...base,
    schedule: messy,
    days: calmDays.map((item, i) => (i === 0 ? { ...item, counts: { 1: 1, 2: 1, 3: 1 }, status: "MINIMAL" } : i === 4 ? { ...item, counts: { 1: 1, 2: 2, 3: 1 } } : item)),
    memberSummary: {
      ani: summary({ shifts: { 1: 5, 2: 0, 3: 0 } }),
      bela: summary({ fullWeekendsOff: 0, shifts: { 1: 2, 2: 3, 3: 0 } }),
      cahyo: summary({ weeklyHours: [{ weekStart: "2026-09-28", hours: 46 }], shifts: { 1: 2, 2: 1, 3: 1 } }),
      dodi: summary({ workDays: 2, workTarget: 5, shifts: { 1: 0, 2: 1, 3: 5 } })
    }
  });
  const byId = Object.fromEntries(review.findings.map((finding) => [finding.id, finding]));
  assert.match(byId["jam-berat"]?.details.join(" ") ?? "", /Cahyo.*46 jam/, "a 46-hour week");
  assert.match(byId["akhir-pekan"]?.details.join(" ") ?? "", /Bela/, "no full weekend off");
  assert.match(byId.minimal?.details.join(" ") ?? "", /1 Okt/, "a 1-1-1 weekday");
  assert.match(byId.terbalik?.details.join(" ") ?? "", /5 Okt/, "Shift 1 below Shift 2 on a weekday");
  assert.match(byId.jumat?.details.join(" ") ?? "", /2 Okt/, "a woman was free on Friday, but Shift 1 had none");
  assert.match(byId["malam-adil"]?.details.join(" ") ?? "", /Dodi 5/, "Dodi 5 nights vs Cahyo 1");
  assert.match(byId["seimbang-perempuan"]?.details.join(" ") ?? "", /Ani/, "Ani 5 / 0");
  assert.match(byId["sehari-kerja"]?.details.join(" ") ?? "", /Ani.*4 Okt/, "a single work day between days off");
  assert.match(byId.target?.details.join(" ") ?? "", /Dodi/, "Dodi 2 days vs target 5");
  for (const id of ["jam-berat", "akhir-pekan", "minimal", "terbalik", "jumat"]) assert.equal(byId[id].level, "penting", id);
  assert.equal(review.serious, 5, "one serious occurrence each for heavy week, weekend, 1-1-1, upside-down and Friday");
});

test("uneven 3-night blocks are flagged even when night totals look fair", () => {
  // Cahyo two 3-night blocks, Dodi none; 6 nights each over the fortnight.
  const dates = Array.from({ length: 14 }, (_, i) => `2026-10-${String(i + 1).padStart(2, "0")}`);
  const rows = { ani: "11HH11111HH111", bela: "22HH22222HH222", cahyo: "333HH333HH1111", dodi: "HH33HH33HH33HH" };
  const schedule = Object.fromEntries(Object.entries(rows).map(([id, codes]) => [id, Object.fromEntries(dates.map((date, i) => [date, codes[i]]))]));
  const review = reviewQuality({
    ...base, schedule, days: dates.map((date) => day(date, false, { 1: 1, 2: 1, 3: 1 }, "OK")),
    memberSummary: { ...base.memberSummary, cahyo: summary({ shifts: { 1: 4, 2: 0, 3: 6 } }), dodi: summary({ shifts: { 1: 0, 2: 0, 3: 6 } }) }
  });
  const night = review.findings.find((finding) => finding.id === "malam-adil");
  assert.ok(night, JSON.stringify(review.findings));
  assert.match(night.details.join(" "), /Cahyo 6 malam \(2 blok 3 malam\)/);
});

test("a 3-night block continued from last month counts in this month's review, as in the fairness", () => {
  const dates = Array.from({ length: 14 }, (_, i) => `2026-10-${String(i + 1).padStart(2, "0")}`);
  // Cahyo: 29-30 Sep + 1 Oct, and 6-8 Oct; Dodi: two 2-night blocks.
  const rows = { ani: "11HH11111HH111", bela: "22HH22222HH222", cahyo: "3HH11333HH111H", dodi: "HH33HH33HH11HH" };
  const schedule = Object.fromEntries(Object.entries(rows).map(([id, codes]) => [id, Object.fromEntries(dates.map((date, i) => [date, codes[i]]))]));
  const review = reviewQuality({
    ...base, schedule, days: dates.map((date) => day(date, false, { 1: 1, 2: 1, 3: 1 }, "OK")),
    history: { codesById: { cahyo: ["3", "3"], dodi: ["H", "H"] } },
    memberSummary: { ...base.memberSummary, cahyo: summary({ shifts: { 1: 6, 2: 0, 3: 4 } }), dodi: summary({ shifts: { 1: 2, 2: 0, 3: 4 } }) }
  });
  const night = review.findings.find((finding) => finding.id === "malam-adil");
  assert.match(night?.details.join(" ") ?? "", /Cahyo 4 malam \(2 blok 3 malam\)/);
});
