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

test("Dispensasi Shift 3 days are not counted when the review compares nights (user, 28 Oct)", () => {
  const dates = Array.from({ length: 30 }, (_, i) => `2026-11-${String(i + 1).padStart(2, "0")}`);
  const row = (nights, fill = "1") => dates.map((_, i) => (nights.includes(i) ? "3" : fill)).join("");
  const rows = { ani: row([]), bela: row([], "2"), cahyo: row([0, 1, 5, 6, 10]), dodi: row([0, 1, 5, 6, 10, 11, 15, 16, 20, 21]) };
  const schedule = Object.fromEntries(Object.entries(rows).map(([id, codes]) => [id, Object.fromEntries(dates.map((date, i) => [date, codes[i]]))]));
  const input = (cahyo) => ({
    ...base, schedule, days: dates.map((date) => day(date, false, { 1: 2, 2: 1, 3: 1 }, "CUKUP")),
    memberSummary: { ...base.memberSummary, cahyo: summary({ shifts: { 1: 25, 2: 0, 3: 5 }, ...cahyo }), dodi: summary({ shifts: { 1: 20, 2: 0, 3: 10 } }) }
  });
  // Cahyo had Dispensasi Shift 3 for 15 days: 5 nights in 15 days is the same rate as Dodi's 10 in 30.
  assert.equal(reviewQuality(input({ dispensationDays: { 3: 15 } })).findings.find((finding) => finding.id === "malam-adil"), undefined);
  assert.ok(reviewQuality(input({})).findings.find((finding) => finding.id === "malam-adil"), "without it, 5 vs 10 nights is uneven");
});

// November 2026 as generated on 21 Oct (screenshot): every rule met, but the
// night workers' day shifts very uneven (Rudi 10 Shift 1 / 1 Shift 2, Agus 6 / 7).
const NOVEMBER = {
  hana: "111HH2222H111HH22H111H222H11HH",
  putri: "CH1111HH22HH222H222HH11111HH22",
  rudi: "H133HH1133HH11H11133HH11H233HH",
  wawan: "33HH11HH1133HH1133HH2233HH22H1",
  ardi: "22H133HH1111HH33HH2233HH111H33",
  agus: "HH222H33HH2233HH1111HH2233HH11"
};
const team = [
  { id: "hana", name: "Hana", gender: "P", eligibleShifts: ["1", "2"], dayOnly: true },
  { id: "putri", name: "Putri", gender: "P", eligibleShifts: ["1", "2"], dayOnly: true },
  ...["Rudi", "Wawan", "Ardi", "Agus"].map((name) => ({ id: name.toLowerCase(), name, gender: "L", eligibleShifts: ["1", "2", "3"], dayOnly: false }))
];
function november(rows, extra = {}) {
  const dates = Array.from({ length: 30 }, (_, i) => `2026-11-${String(i + 1).padStart(2, "0")}`);
  const schedule = Object.fromEntries(Object.entries(rows).map(([id, codes]) => [id, Object.fromEntries(dates.map((date, i) => [date, codes[i]]))]));
  const days = dates.map((date) => {
    const weekend = [0, 6].includes(new Date(`${date}T00:00:00Z`).getUTCDay());
    const counts = { 1: 0, 2: 0, 3: 0 };
    for (const id of Object.keys(rows)) if (counts[schedule[id][date]] !== undefined) counts[schedule[id][date]] += 1;
    return day(date, weekend, counts, "OK");
  });
  const count = (id, code) => [...rows[id]].filter((item) => item === code).length;
  const memberSummary = Object.fromEntries(Object.keys(rows).map((id) => [id, summary({
    workDays: 20, workTarget: 20, shifts: { 1: count(id, "1"), 2: count(id, "2"), 3: count(id, "3") }, leaveDays: count(id, "C"), weeklyHours: []
  })]));
  return { ...base, members: team, schedule, days, memberSummary, ...extra };
}
const splitFinding = (review) => review.findings.find((finding) => finding.id === "shift2-merata");

test("night workers: an uneven Shift 1 / Shift 2 split is flagged with each person's fair share (user, 28 Oct)", () => {
  const finding = splitFinding(reviewQuality(november(NOVEMBER)));
  assert.ok(finding, "November 2026: Rudi 10 / 1 and Agus 6 / 7 while the others are 7 / 4 and 8 / 4");
  assert.equal(finding.level, "perhatian");
  assert.match(finding.title, /yang boleh Shift 3/);
  // The men do 16 of their 47 day shifts on Shift 2: about 4 for 11 or 13 day shifts.
  assert.deepEqual(finding.details, ["Rudi Shift 1 10 / Shift 2 1 (wajar sekitar 4 Shift 2)", "Agus Shift 1 6 / Shift 2 7 (wajar sekitar 4 Shift 2)"]);
});

test("night workers: a split within 1.5 days of the fair share is fine", () => {
  // Rudi takes Agus's Shift 2 on 23-24 Nov and gives back two Shift 1 days: 8/3, 7/4, 8/4, 8/5.
  const rows = { ...NOVEMBER, rudi: "H133HH1133HH11H11133HH22H233HH", agus: "HH222H33HH2233HH1111HH1133HH11" };
  assert.equal(splitFinding(reviewQuality(november(rows))), undefined);
});

test("night workers: someone away most of the month is left out of the comparison", () => {
  // Wawan on leave from 8 Nov: his 1 Shift 2 in a week is not uneven, and does not change the others' share.
  const rows = { ...NOVEMBER, wawan: `33HH112${"C".repeat(23)}` };
  const finding = splitFinding(reviewQuality(november(rows)));
  assert.ok(finding);
  assert.ok(!finding.details.some((text) => text.startsWith("Wawan")), finding.details.join(" | "));
});

test("night workers: no finding when the Aturan row switches the balance off", () => {
  const review = reviewQuality(november(NOVEMBER, { settings: { rules: { weeklyHoursLimit: 40, balanceNightWorkerDayShifts: false } } }));
  assert.equal(splitFinding(review), undefined);
});

test("Dispensasi Shift 1/2 days are left out when the review compares Shift 1 and Shift 2 (user, 28 Oct)", () => {
  // Ani had Dispensasi Shift 2 on 8 days (she worked Shift 1); Cahyo on 6 days.
  const review = (split) => reviewQuality({
    ...base,
    memberSummary: {
      ...base.memberSummary,
      ani: summary({ shifts: { 1: 14, 2: 6, 3: 0 }, ...(split ? { splitShifts: { 1: 6, 2: 6 } } : {}) }),
      cahyo: summary({ shifts: { 1: 12, 2: 0, 3: 4 }, ...(split ? { splitShifts: { 1: 6, 2: 0 } } : {}) }),
      dodi: summary({ shifts: { 1: 8, 2: 4, 3: 4 }, ...(split ? { splitShifts: { 1: 8, 2: 4 } } : {}) })
    }
  }).findings.map((finding) => finding.id);
  assert.deepEqual(review(true).filter((id) => ["seimbang-perempuan", "shift2-merata"].includes(id)), []);
  assert.deepEqual(review(false).filter((id) => ["seimbang-perempuan", "shift2-merata"].includes(id)), ["seimbang-perempuan", "shift2-merata"], "counted in full, both look uneven");
});
