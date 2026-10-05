import { isOffLike, isWorkLike } from "./codes.mjs";
import { shiftWindow, weekdayIndex } from "./date-utils.mjs";
import { NO_HISTORY } from "./history.mjs";
import { KODE_LABEL } from "./labels-id.mjs";

export function isActive(member, date) {
  return (!member.activeFrom || date >= member.activeFrom) && (!member.activeUntil || date <= member.activeUntil);
}

export function initialMemberState(carry, member) {
  return {
    ...carry,
    nightStreak: carry.nightStreakAtEnd ?? 0,
    workCount: 0,
    s1Count: 0,
    s2Count: 0,
    nightCount: 0,
    weekendWorkCount: 0,
    holidayWorkCount: 0,
    fullWeekendsOff: 0,
    availableDays: 0,
    excusedCount: 0,
    memberId: member.id
  };
}

function workWindow(code, dayIndex, ctx) {
  return shiftWindow(ctx.shiftById.get(code) ?? ctx.trainingWindow, dayIndex);
}

// First hard rule the move would break, or null. Order matters: it decides
// which reason the admin sees when several rules block the same move.
function hardViolation(state, member, code, day, ctx, requested) {
  if (!isActive(member, day.date)) return code === "-" ? null : { rule: "inactive" };
  if (code === "-") return { rule: "must-be-active" };
  const shift = ctx.shiftById.get(code);
  const night = code === ctx.nightShiftId;
  if (shift && !member.eligibleShifts.includes(code)) return { rule: "eligibility" };
  if (shift && ctx.avoid?.[day.dayIndex]?.[member.id]?.has(code)) return { rule: "avoid" };
  if (shift || code === "T") {
    const rules = ctx.rules;
    if (state.previousCode === ctx.nightShiftId && !night) return { rule: "after-night" };
    if (state.lastWorkWasNight && isOffLike(state.previousCode) && state.restStreak < rules.nightRecoveryOffDays) {
      return { rule: "night-recovery" };
    }
    if (state.lastWorkEnd !== null) {
      const rest = workWindow(code, day.dayIndex, ctx).start - state.lastWorkEnd;
      if (rest < rules.minimumRestHours) return { rule: "rest", hours: rest };
    }
    if (state.workStreak + 1 > rules.maxConsecutiveWorkDays) return { rule: "streak" };
    const previousShift = ctx.shiftById.get(state.previousCode);
    if (rules.forbidBackwardShiftWithoutOff && previousShift && shift && shift.level < previousShift.level) {
      return { rule: "backward", from: previousShift.id };
    }
    if (night && state.previousCode === ctx.nightShiftId && state.nightStreak + 1 > rules.nightBlock.max) return { rule: "night-max" };
    // Back from sick leave (e.g. hospital): day shifts first, no nights yet.
    if (night && !requested && (state.daysSinceSick ?? NO_HISTORY) + 1 <= (rules.nightFreeDaysAfterSick ?? 0)) return { rule: "after-sick" };
  } else if (code === "H" && !requested && state.offStreak + 1 > ctx.rules.maxConsecutiveOffDays) {
    return { rule: "off-max" };
  }
  return null;
}

export function canTransition(state, member, code, day, ctx, requested = false) {
  return hardViolation(state, member, code, day, ctx, requested) === null;
}

// The hard rule a move breaks, as { rule, ... }, or null when it is allowed.
export function transitionViolation(state, member, code, day, ctx, { requested = false } = {}) {
  return hardViolation(state, member, code, day, ctx, requested);
}

export function explainTransition(state, member, code, day, ctx, { requested = false } = {}) {
  const violation = hardViolation(state, member, code, day, ctx, requested);
  if (!violation) return "";
  const name = member.name;
  const rules = ctx.rules;
  switch (violation.rule) {
    case "inactive":
      return `${name} tidak aktif di tim pada tanggal ini`;
    case "must-be-active":
      return `${name} masih aktif di tim, jadi harus dijadwalkan`;
    case "eligibility":
      return `${name} tidak boleh ${KODE_LABEL[code] ?? code}`;
    case "avoid":
      return `${name} minta tidak ${KODE_LABEL[code] ?? code} pada tanggal ini`;
    case "after-night":
      return `${name} baru selesai Shift 3 kemarin`;
    case "night-recovery":
      return `${name} masih istirahat setelah Shift 3 (baru ${state.restStreak} dari ${rules.nightRecoveryOffDays} hari libur)`;
    case "rest":
      return `jeda istirahat ${name} hanya ${violation.hours} jam (minimal ${rules.minimumRestHours} jam)`;
    case "streak":
      return `${name} sudah bekerja ${state.workStreak} hari berturut-turut (maksimal ${rules.maxConsecutiveWorkDays})`;
    case "backward":
      return `${name} tidak boleh pindah mundur dari Shift ${violation.from} ke Shift ${code} tanpa libur`;
    case "night-max":
      return `${name} sudah ${state.nightStreak} malam berturut-turut (maksimal ${rules.nightBlock.max})`;
    case "after-sick":
      return `${name} baru kembali dari sakit (belum ${rules.nightFreeDaysAfterSick} hari), jadi belum boleh Shift 3`;
    case "off-max":
      return `${name} sudah libur ${state.offStreak} hari berturut-turut (maksimal ${rules.maxConsecutiveOffDays})`;
    default:
      return `${name}: aturan ${violation.rule}`;
  }
}

// Applies one day's code. Returns { state, score } or null when a hard rule breaks.
// `score` holds the soft penalties (positive) and rewards (negative) of this move.
export function transitionMember(state, member, code, day, ctx, { requested = false } = {}) {
  if (hardViolation(state, member, code, day, ctx, requested)) return null;
  const weights = ctx.weights;
  const rules = ctx.rules;
  const shift = ctx.shiftById.get(code);
  const night = code === ctx.nightShiftId;
  const workLike = Boolean(shift) || code === "T";
  const previousShift = ctx.shiftById.get(state.previousCode);
  const next = { ...state, previousPreviousCode: state.previousCode, previousCode: code };
  let score = 0;
  // Updating an existing month: every day that differs from the current roster
  // costs a penalty, so people's plans change only where it is worth it.
  const current = ctx.reference?.[member.id]?.[day.date];
  if (current !== undefined && current !== code) score += weights.changeFromReference ?? 0;

  // Net hours in the Monday-Sunday week; hours above the limit cost a penalty.
  const monday = day.isMonday ?? weekdayIndex(day.date) === 1;
  const weekBefore = monday ? 0 : (state.weekHours ?? 0);
  const hours = ctx.netHours?.[code] ?? 0;
  next.weekHours = weekBefore + hours;
  const limit = ctx.weeklyHoursLimit;
  if (hours > 0 && limit && next.weekHours > limit) score += (weights.weeklyHoursOver ?? 0) * (next.weekHours - Math.max(weekBefore, limit));
  // Hours far above the limit (more than 4 over, i.e. a heavy overtime week) cost much more.
  if (hours > 0 && limit && next.weekHours > limit + 4) score += (weights.weeklyHoursHeavy ?? 0) * (next.weekHours - Math.max(weekBefore, limit + 4));

  if (workLike) {
    if (previousShift && shift && previousShift.id !== shift.id) {
      score += weights.adjacentShiftChange;
      // Same day shift through a work block (user, 30 Sep): Shift 1 <-> Shift 2
      // only after a day off. Day shifts followed by nights (D D N N N) stay allowed.
      if (!night && !previousShift.night) score += weights.dayShiftSwitchInBlock ?? 0;
      if (state.shiftStreak === 1) score += weights.singletonShiftRun;
    }
    if (previousShift?.level === 1 && night) score += weights.directDayToNightJump;
    if (isOffLike(state.previousCode) && shift && state.lastWorkedShift && state.lastWorkedShift !== code && !state.lastWorkWasNight) {
      score += weights.postRestShiftChange;
      if (shift.level < ctx.shiftById.get(state.lastWorkedShift).level && state.restStreak === 1) score += weights.postRestBackwardJump;
    }
    if (state.previousCode === "H" && isWorkLike(state.previousPreviousCode, ctx.shiftIds)) score += weights.isolatedOff;
    if (isOffLike(state.previousCode) && state.restStreak === 1 && state.lastWorkBlockLength >= rules.maxConsecutiveWorkDays) {
      score += weights.shortRecoveryAfterMaxWork;
    }

    next.workStreak = state.workStreak + 1;
    next.offStreak = 0;
    next.restStreak = 0;
    next.shiftStreak = shift ? (state.previousCode === code ? state.shiftStreak + 1 : 1) : 0;
    next.daysSinceWork = 0;
    next.lastWorkBlockLength = next.workStreak;
    next.lastWorkWasNight = night;
    next.nightStreak = night ? (state.previousCode === code ? state.nightStreak + 1 : 1) : 0;
    next.lastWorkEnd = workWindow(code, day.dayIndex, ctx).end;
    if (shift) next.lastWorkedShift = code;
    if (night && next.nightStreak > rules.nightBlock.preferred) score += weights.nightBlockExtension * (next.nightStreak - rules.nightBlock.preferred);
    // 3-night blocks shared out (user, 30 Sep): each further long block in the
    // month costs more for the same person.
    next.longNightBlocks = state.longNightBlocks ?? 0;
    if (night && day.published && next.nightStreak === rules.nightBlock.preferred + 1) {
      score += (weights.repeatLongNightBlock ?? 0) * next.longNightBlocks;
      next.longNightBlocks += 1;
    }
    // A new night block soon after the previous one (e.g. N N H H N N) is legal but tiring.
    if (night && state.previousCode !== code) score += (weights.nightBlockTooSoon ?? 0) * Math.max(0, 6 - (state.daysSinceNight ?? NO_HISTORY));
    next.daysSinceNight = night ? 0 : Math.min(NO_HISTORY, (state.daysSinceNight ?? NO_HISTORY) + 1);

    if (day.published && shift) {
      next.workCount = state.workCount + 1;
      if (night) next.nightCount = state.nightCount + 1;
      if (day.isWeekend) next.weekendWorkCount = state.weekendWorkCount + 1;
      if (day.isHoliday) next.holidayWorkCount = state.holidayWorkCount + 1;
      if (member.dayOnly && rules.balanceDayOnlyShifts && !night) {
        next.s1Count = state.s1Count + (code === "1" ? 1 : 0);
        next.s2Count = state.s2Count + (code === "2" ? 1 : 0);
        const drift = Math.abs(next.s1Count - next.s2Count);
        if (drift > 2) score += weights.dayShiftImbalance * (drift - 2);
      }
    }
  } else {
    // Leave counts as a work day (user, 30 Sep: leave is the person's own time,
    // not the roster's rest): it never resets the consecutive-day count and is
    // not one of the rest days after nights. Days off and sickness are rest.
    const leaveAsWork = code === "C" && rules.leaveCountsAsWork !== false;
    if (!leaveAsWork && previousShift && state.workStreak === 1 && isOffLike(state.previousPreviousCode)) score += weights.singleWorkDay;
    // A 2-day work block (e.g. H H 1 1 H H) fragments the rhythm; 4-5 days then 2 off is the aim.
    if (!leaveAsWork && previousShift && state.workStreak === 2) score += weights.shortWorkBlock ?? 0;
    if (code === "H" && state.previousCode === "H") score -= weights.consecutiveOffReward;
    next.workStreak = leaveAsWork ? state.workStreak + 1 : 0;
    next.daysSinceNight = Math.min(NO_HISTORY, (state.daysSinceNight ?? NO_HISTORY) + 1);
    next.offStreak = code === "H" ? state.offStreak + 1 : 0;
    next.restStreak = leaveAsWork ? state.restStreak : Math.min(NO_HISTORY, state.restStreak + 1);
    next.shiftStreak = 0;
    next.nightStreak = 0;
    next.daysSinceWork = Math.min(NO_HISTORY, state.daysSinceWork + 1);
    if (day.published && day.isSunday && code !== "-" && isOffLike(state.previousCode) && state.previousCode !== "-") {
      score -= state.fullWeekendsOff === 0 ? weights.fullWeekendOffFirst : weights.fullWeekendOffNext;
      next.fullWeekendsOff = state.fullWeekendsOff + 1;
    }
  }
  next.daysSinceSick = code === "S" ? 0 : Math.min(NO_HISTORY, (state.daysSinceSick ?? NO_HISTORY) + 1);
  // Rosterable days exclude leave, sickness and training; those are "excused"
  // days that count 1:1 against the person's monthly workday target.
  if (day.published && (code === "C" || code === "S" || code === "T")) next.excusedCount = state.excusedCount + 1;
  else if (day.published && code !== "-") next.availableDays = state.availableDays + 1;
  return { state: next, score };
}
