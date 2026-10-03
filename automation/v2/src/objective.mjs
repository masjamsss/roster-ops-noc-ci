// The roster objective (lower is better). The beam search adds these terms day
// by day; scoreSchedule() recomputes the same total for a finished roster, so
// the search and the local improvement always optimize the same thing.
import { weekdayIndex } from "./date-utils.mjs";
import { transitionMember } from "./rules.mjs";
import { staffingPenalty } from "./staffing.mjs";

const UNAVAILABLE = new Set(["-", "C", "S", "T"]);
const SHIFT_IDS = ["1", "2", "3"];

// Friday prayer coverage: a female agent on Shift 1, when one is available.
export function fridayWithoutFemale(codes, day, members, config) {
  if (!config.rules.fridayShift1Female) return false;
  if (!(day.isFriday ?? weekdayIndex(day.date) === 5)) return false;
  let available = false;
  for (let index = 0; index < members.length; index += 1) {
    if (members[index].gender !== "P" || UNAVAILABLE.has(codes[index])) continue;
    if (codes[index] === "1") return false;
    available = true;
  }
  return available;
}

const EXCUSED = new Set(["C", "S", "T"]);

// Per-person workday target. "auto": the month's ideal work (preferred
// staffing on every published day) shared evenly by the team, but at most
// 5 workdays per week (22 in a 31-day month): the same number a clean
// 5-on-2-off rhythm gives. A number in the Aturan sheet fixes it instead.
// Either way, every cuti, sakit or training day lowers the target by one.
export function makeEnv(config, days, members = [], fixed = []) {
  const published = days.filter((day) => day.published);
  const publishedCount = published.length;
  const numeric = typeof config.rules.workDaysTarget === "number";
  const sum = (counts) => Object.values(counts).reduce((total, value) => total + value, 0);
  const need = published.reduce((total, day) => total + sum(day.isSpecial ? config.coverage.special.preferred : config.coverage.weekday.preferred), 0);
  const memberTargets = members.map((member) => {
    let activeDays = 0;
    let excused = 0;
    for (const day of published) {
      const code = fixed[day.dayIndex]?.[member.id];
      if (code === "-") continue;
      activeDays += 1;
      if (EXCUSED.has(code)) excused += 1;
    }
    return { activeDays, excused, rosterable: activeDays - excused };
  });
  const team = memberTargets.reduce((total, goal) => total + goal.activeDays / Math.max(1, publishedCount), 0);
  const share = need / Math.max(1, team);
  const weekCap = (publishedCount * 5) / 7;
  const monthTarget = numeric ? config.rules.workDaysTarget : Math.min(share, weekCap);
  for (const goal of memberTargets) {
    goal.base = (monthTarget * goal.activeDays) / Math.max(1, publishedCount);
    goal.target = Math.max(0, goal.base - goal.excused);
  }
  return {
    publishedCount, lastPublishedIndex: publishedCount - 1, mode: "fixed", basis: numeric ? "aturan" : "auto",
    target: monthTarget, detail: { need, team, share, weekCap }, memberTargets
  };
}

// Fairness over three months: how many more (+) or fewer (-) nights / weekend
// days each person should get this month to even out the previous two months.
// Measured per available day (see rollingStats), so leave creates no debt.
// Half of the difference is repaid per month, at most 2 days: a lighter month
// that later drops out of the window then doesn't swing back as a heavy one.
const FAIRNESS_REPAY = 0.5;
const FAIRNESS_CAP = 2;

export function fairnessOffsets(members, stats) {
  const offsets = (count, available, include) => {
    const counted = (member) => include(member) && available(stats?.[member.id] ?? {}) > 0;
    const rows = members.filter(counted).map((member) => stats[member.id]);
    const days = rows.reduce((sum, stat) => sum + available(stat), 0);
    const rate = days ? rows.reduce((sum, stat) => sum + count(stat), 0) / days : 0;
    return members.map((member) => {
      if (!counted(member)) return 0;
      const stat = stats[member.id];
      return Math.max(-FAIRNESS_CAP, Math.min(FAIRNESS_CAP, FAIRNESS_REPAY * (rate * available(stat) - count(stat))));
    });
  };
  return {
    nights: offsets((stat) => stat.nightDays, (stat) => stat.availableDays ?? 0, (member) => !member.dayOnly),
    weekends: offsets((stat) => stat.weekendDays, (stat) => stat.availableWeekendDays ?? 0, () => true),
    longBlocks: offsets((stat) => stat.longNightBlocks ?? 0, (stat) => stat.availableDays ?? 0, (member) => !member.dayOnly)
  };
}

function targetOf(env, index) {
  return env.memberTargets?.[index] ?? { target: env.target, base: env.target, activeDays: env.publishedCount, excused: 0, rosterable: env.publishedCount };
}

// Displayed per-person target: the month's target for the days in the team,
// minus that person's own cuti, sakit and training days.
export function displayTargets(env) {
  return (env.memberTargets ?? []).map((goal) => ({ target: Math.round(goal.target), base: Math.round(goal.base) }));
}

function spread(states, value, include) {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < states.length; index += 1) {
    if (!include(index)) continue;
    const current = value(states[index], index);
    if (current < min) min = current;
    if (current > max) max = current;
  }
  return max >= min ? max - min : 0;
}

export function dayScore(codes, day, states, members, config, env) {
  const weights = config.weights;
  let score = 0;
  if (!day.isSpecial) {
    const counts = { 1: 0, 2: 0, 3: 0 };
    for (const code of codes) if (counts[code] !== undefined) counts[code] += 1;
    score += staffingPenalty(counts, false, config.coverage, SHIFT_IDS, weights) * (day.published ? 1 : 0.25);
  }
  if (fridayWithoutFemale(codes, day, members, config)) score += (weights.fridayShift1WithoutFemale ?? 0) * (day.published ? 1 : 0.25);
  if (!day.published) return score;

  // Responsible days = days worked + excused days (cuti, sakit, training).
  const activeSoFar = (state) => state.availableDays + state.excusedCount;
  const seen = (minimum) => (index) => activeSoFar(states[index]) >= minimum;
  const daysSoFar = day.dayIndex + 1;
  score += weights.workloadSpreadDaily * daysSoFar * spread(states, (state) => (state.workCount + state.excusedCount) / Math.max(1, activeSoFar(state)), seen(5));
  // Offsets carry fairness over from the previous two months (see fairnessOffsets).
  const elapsed = Math.min(1, daysSoFar / env.publishedCount);
  const nightOffset = (index) => (env.nightOffset?.[index] ?? 0);
  const weekendOffset = (index) => (env.weekendOffset?.[index] ?? 0);
  if (day.isWeekend) score += (weights.weekendSpreadDaily ?? 0) * spread(states, (state, index) => state.weekendWorkCount - weekendOffset(index) * elapsed, seen(5));
  // Nights per available day so far, so someone back from leave or sickness is
  // not pushed to catch up in the rest of the month.
  score += (weights.nightSpreadDaily ?? 0) * spread(states, (state, index) => (state.nightCount * daysSoFar) / Math.max(1, state.availableDays) - nightOffset(index) * elapsed, (index) => !members[index].dayOnly && seen(5)(index));
  if (env.mode === "fixed") {
    // Keep everyone on pace for the monthly target, with 1.5 days of slack
    // either way (the natural swing of a 5-on-2-off rhythm).
    states.forEach((state, index) => {
      const goal = targetOf(env, index);
      const pace = (goal.target * state.availableDays) / Math.max(1, goal.rosterable);
      if (state.workCount > pace + 1.5) score += weights.overWorkDaysTargetDaily * (state.workCount - pace - 1.5);
      if (state.workCount < pace - 1.5) score += (weights.underWorkDaysTargetDaily ?? 0) * (pace - 1.5 - state.workCount);
    });
  }

  if (day.dayIndex === env.lastPublishedIndex) {
    if (env.mode === "fixed") {
      states.forEach((state, index) => {
        const goal = targetOf(env, index).target;
        if (state.workCount > goal) score += weights.overWorkDaysTarget * (state.workCount - goal);
        if (state.workCount < goal - 0.5) score += (weights.underWorkDaysTarget ?? 0) * (goal - state.workCount);
      });
    }
    const perActive = (count, index) => (count * env.publishedCount) / Math.max(1, targetOf(env, index).activeDays);
    const perRosterable = (count, index) => (count * env.publishedCount) / Math.max(1, targetOf(env, index).rosterable);
    const mostlyActive = (index) => targetOf(env, index).activeDays >= 10;
    const mostlyRosterable = (index) => targetOf(env, index).rosterable >= 10;
    const work = spread(states, (state, index) => perActive(state.workCount + state.excusedCount, index), mostlyActive);
    const tolerance = weights.workloadSpreadTolerance ?? 1;
    score += weights.workloadSpreadLight * Math.min(work, tolerance) + weights.workloadSpreadHeavy * Math.max(0, work - tolerance);
    score += weights.weekendSpread * spread(states, (state, index) => perRosterable(state.weekendWorkCount, index) - weekendOffset(index), mostlyRosterable);
    const nights = spread(states, (state, index) => perRosterable(state.nightCount, index) - nightOffset(index), (index) => mostlyRosterable(index) && !members[index].dayOnly);
    score += (weights.nightSpreadLight ?? 0) * Math.min(nights, 2) + (weights.nightSpreadHeavy ?? 0) * Math.max(0, nights - 2);
    // 3-night blocks per available day, balanced over three months like nights.
    const longOffset = (index) => env.longBlockOffset?.[index] ?? 0;
    score += (weights.longNightBlockSpread ?? 0) * spread(states, (state, index) => perRosterable(state.longNightBlocks ?? 0, index) - longOffset(index), (index) => mostlyRosterable(index) && !members[index].dayOnly);
    members.forEach((member, index) => {
      if (!member.dayOnly || !config.rules.balanceDayOnlyShifts) return;
      const drift = Math.abs(states[index].s1Count - states[index].s2Count);
      if (drift > 1) score += weights.dayShiftImbalanceFinal * (drift - 1);
    });
  }
  return score;
}

// codes[memberIndex][dayIndex]; fixed[dayIndex] = { memberId: requestedCode }.
export function scoreSchedule({ codes, members, days, initialStates, ctx, config, fixed, env }) {
  let states = initialStates;
  let total = 0;
  const dayCodes = new Array(members.length);
  for (let d = 0; d < days.length; d += 1) {
    const next = new Array(members.length);
    for (let i = 0; i < members.length; i += 1) {
      dayCodes[i] = codes[i][d];
      const moved = transitionMember(states[i], members[i], dayCodes[i], days[d], ctx, { requested: fixed[d][members[i].id] !== undefined });
      if (!moved) return { valid: false, total: Number.POSITIVE_INFINITY, failedAt: d, memberIndex: i };
      next[i] = moved.state;
      total += moved.score;
    }
    states = next;
    total += dayScore(dayCodes, days[d], states, members, config, env);
  }
  return { valid: true, total, states };
}
