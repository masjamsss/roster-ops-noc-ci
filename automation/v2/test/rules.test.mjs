import assert from "node:assert/strict";
import test from "node:test";
import { deriveMemberState } from "../src/history.mjs";
import { explainTransition, initialMemberState, transitionMember } from "../src/rules.mjs";

const SHIFTS = [
  { id: "1", start: "07:00", end: "16:00", level: 1 },
  { id: "2", start: "13:00", end: "21:00", level: 2 },
  { id: "3", start: "21:00", end: "07:00", level: 3, night: true }
];
const WEIGHTS = {
  adjacentShiftChange: 10, directDayToNightJump: 60, postRestShiftChange: 6, postRestBackwardJump: 14,
  isolatedOff: 30, shortRecoveryAfterMaxWork: 40, singletonShiftRun: 20, singleWorkDay: 25, shortWorkBlock: 50,
  dayShiftImbalance: 12, nightBlockExtension: 250, consecutiveOffReward: 8,
  fullWeekendOffFirst: 60, fullWeekendOffNext: 15
};
const ctx = {
  shiftById: new Map(SHIFTS.map((shift) => [shift.id, shift])),
  shiftIds: ["1", "2", "3"],
  nightShiftId: "3",
  trainingWindow: { start: "08:00", end: "17:00" },
  rules: {
    maxConsecutiveWorkDays: 5, maxConsecutiveOffDays: 2, minimumRestHours: 11, forbidBackwardShiftWithoutOff: true,
    nightRecoveryOffDays: 2, nightBlock: { min: 2, preferred: 2, max: 3 }, balanceDayOnlyShifts: true, leaveCountsAsWork: true
  },
  weights: WEIGHTS
};
const man = { id: "rizky", name: "Rizky", eligibleShifts: ["1", "2", "3"], dayOnly: false, activeFrom: null, activeUntil: null };
const woman = { id: "hilvani", name: "Hilvani", eligibleShifts: ["1", "2"], dayOnly: true, activeFrom: null, activeUntil: null };

function day(dayIndex) {
  const date = new Date(Date.UTC(2026, 9, 1 + dayIndex)).toISOString().slice(0, 10);
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  return { date, dayIndex, isWeekend: weekday === 0 || weekday === 6, isSunday: weekday === 0, published: true };
}

// Runs codes from day 0; returns { ok, failedAt, state, scores }.
function run(member, codes, history = ["H", "H"]) {
  let state = initialMemberState(deriveMemberState(history, ctx), member);
  const scores = [];
  for (let index = 0; index < codes.length; index += 1) {
    const next = transitionMember(state, member, codes[index], day(index), ctx);
    if (!next) return { ok: false, failedAt: index, state, scores };
    scores.push(next.score);
    state = next.state;
  }
  return { ok: true, failedAt: -1, state, scores };
}

test("two off days are required after a night block before any work", () => {
  assert.equal(run(man, ["3", "3", "1"]).failedAt, 2);
  assert.equal(run(man, ["3", "3", "H", "1"]).failedAt, 3);
  assert.equal(run(man, ["3", "3", "H", "3"]).failedAt, 3);
  assert.equal(run(man, ["3", "3", "H", "T"]).failedAt, 3);
  assert.equal(run(man, ["3", "3", "H", "H", "1"]).ok, true);
  // Sickness is rest; leave is not since 30 Sep (see the leave test below).
  assert.equal(run(man, ["3", "3", "S", "H", "1"]).ok, true);
});

test("night recovery also applies to a block that ended in the previous month", () => {
  const armanHistory = ["H", "3", "3"];
  assert.equal(run(man, ["1"], armanHistory).ok, false);
  assert.equal(run(man, ["H", "1"], armanHistory).ok, false);
  assert.equal(run(man, ["H", "H", "1"], armanHistory).ok, true);
});

test("the 5-day limit counts days carried in from last month", () => {
  const addinHistory = ["H", "H", "1", "2", "2", "2"];
  assert.equal(run(man, ["3"], addinHistory).ok, true);
  assert.equal(run(man, ["3", "3"], addinHistory).failedAt, 1);
  const state = run(man, ["3"], addinHistory).state;
  assert.match(explainTransition(state, man, "3", day(1), ctx), /5 hari berturut-turut/);
});

test("training counts as a working day for the 5-day limit", () => {
  assert.equal(run(man, ["T", "T", "T", "1", "1", "1"]).failedAt, 5);
});

test("no backward shift change without a day off", () => {
  assert.equal(run(man, ["2", "1"]).failedAt, 1);
  const result = run(man, ["2", "H", "1"]);
  assert.equal(result.ok, true);
  assert.ok(result.scores[2] > 0, "a backward move after one H is penalized");
});

test("members only work shifts they are allowed", () => {
  assert.equal(run(woman, ["3"]).failedAt, 0);
  const state = initialMemberState(deriveMemberState(["H"], ctx), woman);
  assert.match(explainTransition(state, woman, "3", day(0), ctx), /tidak boleh Shift 3/);
});

test("nights: at most 3 in a row, and the third costs a penalty", () => {
  const three = run(man, ["3", "3", "3"]);
  assert.equal(three.ok, true);
  assert.ok(three.scores[2] >= WEIGHTS.nightBlockExtension);
  assert.ok(three.scores[1] < WEIGHTS.nightBlockExtension);
  assert.equal(run(man, ["3", "3", "3", "3"]).failedAt, 3);
});

test("at most 2 rostered H in a row, unless the H was requested", () => {
  assert.equal(run(man, ["1", "H", "H", "H"]).failedAt, 3);
  let state = run(man, ["1", "H", "H"]).state;
  assert.notEqual(transitionMember(state, man, "H", day(3), ctx, { requested: true }), null);
  assert.equal(run(man, ["1", "H", "C", "H"]).ok, true);
});

test("inactive days only allow '-' and active days never allow '-'", () => {
  const leaver = { ...man, activeUntil: "2026-10-02" };
  assert.equal(run(leaver, ["1", "1", "-", "-"]).ok, true);
  assert.equal(run(leaver, ["1", "1", "1"]).failedAt, 2);
  assert.equal(run(man, ["-"]).failedAt, 0);
  const joiner = { ...man, activeFrom: "2026-10-03" };
  assert.equal(run(joiner, ["-", "-", "1"]).ok, true);
});

test("day-only members pay a growing penalty when Shift 1 and Shift 2 drift apart", () => {
  const balanced = run(woman, ["1", "1", "H", "2", "2"]);
  const lopsided = run(woman, ["2", "2", "H", "2", "2"]);
  const sum = (list) => list.reduce((total, value) => total + value, 0);
  assert.ok(sum(lopsided.scores) > sum(balanced.scores));
});

test("counters track published work, weekend work and full weekends off", () => {
  // 2026-10-03 is Saturday, 2026-10-04 Sunday.
  const result = run(man, ["1", "1", "H", "H", "2"]);
  assert.equal(result.state.workCount, 3);
  assert.equal(result.state.weekendWorkCount, 0);
  assert.equal(result.state.fullWeekendsOff, 1);
  assert.ok(result.scores[3] < 0, "a first full weekend off is rewarded");
});

test("a work block of only 2 days costs a penalty when it ends; 3 or more days do not", () => {
  const two = run(woman, ["1", "1", "H"]);
  const three = run(woman, ["1", "1", "1", "H"]);
  assert.equal(two.ok && three.ok, true);
  assert.equal(two.scores[2] - three.scores[3], WEIGHTS.shortWorkBlock);
  const one = run(woman, ["1", "H"]);
  assert.equal(one.scores[1], WEIGHTS.singleWorkDay, "a single work day keeps its own penalty");
});

test("weekly hours: every hour above 40 costs a penalty, and every hour above 44 costs much more", () => {
  const hoursCtx = { ...ctx, netHours: { 1: 8, 2: 7, 3: 9 }, weeklyHoursLimit: 40, weights: { ...WEIGHTS, weeklyHoursOver: 10, weeklyHoursHeavy: 100 } };
  const wednesday = day(6);
  const scoreFrom = (hoursSoFar) => {
    const state = { ...initialMemberState(deriveMemberState(["H", "H"], hoursCtx), woman), weekHours: hoursSoFar };
    return transitionMember(state, woman, "1", wednesday, hoursCtx).score;
  };
  assert.equal(scoreFrom(36) - scoreFrom(32), 10 * 4, "36 + 8 = 44 h: 4 hours over 40");
  assert.equal(scoreFrom(40) - scoreFrom(32), 10 * 8 + 100 * 4, "40 + 8 = 48 h: 8 hours over 40, 4 of them over 44");
});

test("after sick leave, no Shift 3 for the first days back (5 by default), unless it was asked for", () => {
  const sickCtx = { ...ctx, rules: { ...ctx.rules, nightFreeDaysAfterSick: 5 } };
  const afterSick = (codes) => {
    let state = initialMemberState(deriveMemberState(["H", "H", "S", "S", "S"], sickCtx), man);
    codes.forEach((code, index) => { state = transitionMember(state, man, code, day(index), sickCtx).state; });
    return state;
  };
  assert.equal(transitionMember(afterSick([]), man, "3", day(0), sickCtx), null, "first day back: no night");
  assert.equal(transitionMember(afterSick(["1", "1", "H", "1"]), man, "3", day(4), sickCtx), null, "fifth day back: still no night");
  assert.notEqual(transitionMember(afterSick(["1", "1", "H", "1", "1"]), man, "3", day(5), sickCtx), null, "sixth day back: nights allowed again");
  assert.notEqual(transitionMember(afterSick([]), man, "3", day(0), sickCtx, { requested: true }), null, "the admin may still ask for it");
  assert.notEqual(transitionMember(afterSick([]), man, "1", day(0), sickCtx), null, "day shifts are fine");
});

test("a short sickness (1-2 days) may have its own, shorter night-free period (Aturan row); a longer one keeps the normal period", () => {
  const sickCtx = { ...ctx, rules: { ...ctx.rules, nightFreeDaysAfterSick: 5, nightFreeDaysAfterShortSick: 2 } };
  const back = (history, codes, rulesCtx = sickCtx) => {
    let state = initialMemberState(deriveMemberState(history, rulesCtx), man);
    codes.forEach((code, index) => { state = transitionMember(state, man, code, day(index), rulesCtx).state; });
    return state;
  };
  const night = (history, codes, rulesCtx = sickCtx) => transitionMember(back(history, codes, rulesCtx), man, "3", day(codes.length), rulesCtx);
  assert.equal(night(["H", "H", "1", "1", "S"], ["1"]), null, "1 day sick: second day back, no night yet");
  assert.notEqual(night(["H", "H", "1", "1", "S"], ["1", "1"]), null, "1 day sick: third day back, nights allowed");
  assert.notEqual(night(["H", "1", "1", "S", "S"], ["1", "1"]), null, "2 days sick count as short");
  assert.equal(night(["H", "S", "S", "S"], ["1", "1", "H", "1"]), null, "3 days sick: the normal 5 days");
  assert.equal(night(["S", "S", "S", "1", "S"], ["1", "1"]), null, "a short sickness after a long one does not shorten the long one's period");
  const plain = { ...ctx, rules: { ...ctx.rules, nightFreeDaysAfterSick: 5 } };
  assert.equal(night(["H", "H", "1", "1", "S"], ["1", "1"], plain), null, "without the row: 5 days for any sickness, as before");
});

test("a switch between Shift 1 and Shift 2 inside a work block costs a penalty; after a day off or into nights it does not", () => {
  const strict = { ...ctx, weights: { ...WEIGHTS, dayShiftSwitchInBlock: 400 } };
  const scoresOf = (member, codes) => {
    let state = initialMemberState(deriveMemberState(["H", "H"], strict), member);
    return codes.map((code, index) => {
      const next = transitionMember(state, member, code, day(index), strict);
      state = next.state;
      return next.score;
    });
  };
  const mixed = scoresOf(woman, ["1", "1", "2", "2"]);
  assert.equal(mixed[2] - run(woman, ["1", "1", "2", "2"]).scores[2], 400, "the switch day pays the new penalty");
  assert.equal(mixed[3], run(woman, ["1", "1", "2", "2"]).scores[3], "only once per switch");
  const afterOff = scoresOf(woman, ["1", "1", "H", "2"]);
  const afterOffSame = scoresOf(woman, ["1", "1", "H", "1"]);
  assert.ok(afterOff[3] - afterOffSame[3] < 400, "a new block may start on another shift");
  const intoNights = scoresOf(man, ["1", "1", "3", "3"]);
  const plainNights = run(man, ["1", "1", "3", "3"]).scores;
  assert.equal(intoNights[2], plainNights[2], "day shifts then nights (D D N N) stay allowed at the normal cost");
});

test("leave counts as a work day for the 5-day limit and is not rest after nights (user, 30 Sep); switchable", () => {
  assert.equal(run(man, ["1", "1", "C", "1", "1"]).ok, true, "5 days counting the leave day");
  assert.equal(run(man, ["1", "1", "C", "1", "1", "1"]).failedAt, 5, "the 6th day counting the leave day is refused");
  assert.equal(run(man, ["3", "3", "C", "H", "1"]).failedAt, 4, "after nights, a leave day is not one of the 2 rest days");
  assert.equal(run(man, ["3", "3", "H", "C", "H", "1"]).ok, true);
  assert.equal(run(man, ["1", "1", "S", "1", "1", "1", "1"]).ok, true, "sick days stay days off");
  const state = deriveMemberState(["H", "1", "1", "1", "C"], ctx);
  assert.equal(state.workStreak, 4, "carried in from last month too");
  assert.equal(deriveMemberState(["3", "3", "H", "C"], ctx).restStreak, 1);
  const lenient = { ...ctx, rules: { ...ctx.rules, leaveCountsAsWork: false } };
  let current = initialMemberState(deriveMemberState(["H", "H"], lenient), man);
  for (const [index, code] of ["1", "1", "C", "1", "1", "1", "1"].entries()) {
    const next = transitionMember(current, man, code, day(index), lenient);
    assert.ok(next, `switched off: day ${index} allowed`);
    current = next.state;
  }
});

test("a person's second 3-night block in the month costs more than their first, so long blocks are shared", () => {
  const fair = { ...ctx, weights: { ...WEIGHTS, repeatLongNightBlock: 300 } };
  let state = initialMemberState(deriveMemberState(["H", "H"], fair), man);
  const scores = [];
  for (const [index, code] of ["3", "3", "3", "H", "H", "1", "1", "3", "3", "3"].entries()) {
    const next = transitionMember(state, man, code, day(index), fair);
    scores.push(next.score);
    state = next.state;
  }
  assert.equal(state.longNightBlocks, 2);
  assert.equal(scores[9] - scores[2], 300, "the second third night pays the repeat penalty once");
});

test("'Hindari Shift X' (avoid a shift on a date) is a hard rule; other shifts that day stay allowed", () => {
  const avoidCtx = { ...ctx, avoid: { 1: { rizky: new Set(["3"]) } } };
  let state = initialMemberState(deriveMemberState(["H", "H"], avoidCtx), man);
  state = transitionMember(state, man, "1", day(0), avoidCtx).state;
  assert.ok(transitionMember(state, man, "3", day(1), ctx), "without the request Shift 3 would be allowed");
  assert.equal(transitionMember(state, man, "3", day(1), avoidCtx), null, "no Shift 3 on the avoided day");
  assert.ok(transitionMember(state, man, "1", day(1), avoidCtx), "Shift 1 is still fine");
  assert.match(explainTransition(state, man, "3", day(1), avoidCtx), /Rizky minta tidak Shift 3/);
});
