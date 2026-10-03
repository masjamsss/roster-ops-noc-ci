import { isOffLike, isShiftCode, isWorkLike } from "./codes.mjs";
import { addDays, isoDate, isWeekend, shiftWindow } from "./date-utils.mjs";

// Used for "long enough ago that it no longer matters" (no work / no night in the window).
export const NO_HISTORY = 99;

function countFromEnd(codes, predicate, endIndex = codes.length - 1) {
  let count = 0;
  for (let index = endIndex; index >= 0 && predicate(codes[index]); index -= 1) count += 1;
  return count;
}

function lastIndexWhere(codes, predicate) {
  for (let index = codes.length - 1; index >= 0; index -= 1) if (predicate(codes[index])) return index;
  return -1;
}

function workWindow(code, dayIndex, ctx) {
  const shift = ctx.shiftById.get(code);
  if (shift) return shiftWindow(shift, dayIndex);
  return shiftWindow(ctx.trainingWindow, dayIndex);
}

// State of one member at the end of the given codes (oldest first), measured
// against day index 0 = the first day being generated. All numbers come from
// real codes, never from hand-typed carry-in values.
export function deriveMemberState(codes, ctx) {
  const shiftIds = [...ctx.shiftById.keys()];
  const work = (code) => isWorkLike(code, shiftIds);
  const count = codes.length;
  const previousCode = count > 0 ? codes[count - 1] : "-";
  const lastWorkIndex = lastIndexWhere(codes, work);
  const lastShiftIndex = lastIndexWhere(codes, (code) => isShiftCode(code, shiftIds));
  const hasWork = lastWorkIndex >= 0;
  // Leave counts as a work day for the streak and is not rest after nights (see rules.mjs).
  const leaveAsWork = ctx.rules?.leaveCountsAsWork !== false;
  const trailingOff = countFromEnd(codes, isOffLike);
  const rest = leaveAsWork ? codes.slice(count - trailingOff).filter((code) => code !== "C").length : trailingOff;
  return {
    previousCode,
    previousPreviousCode: count > 1 ? codes[count - 2] : "-",
    workStreak: countFromEnd(codes, (code) => work(code) || (leaveAsWork && code === "C")),
    offStreak: countFromEnd(codes, (code) => code === "H"),
    restStreak: hasWork ? rest : NO_HISTORY,
    shiftStreak: isShiftCode(previousCode, shiftIds) ? countFromEnd(codes, (code) => code === previousCode) : 0,
    lastWorkedShift: lastShiftIndex >= 0 ? codes[lastShiftIndex] : null,
    daysSinceWork: hasWork ? count - 1 - lastWorkIndex : NO_HISTORY,
    lastWorkBlockLength: hasWork ? countFromEnd(codes, work, lastWorkIndex) : 0,
    lastWorkWasNight: hasWork && codes[lastWorkIndex] === ctx.nightShiftId,
    nightStreakAtEnd: previousCode === ctx.nightShiftId ? countFromEnd(codes, (code) => code === ctx.nightShiftId) : 0,
    daysSinceNight: codes.lastIndexOf(ctx.nightShiftId) === -1 ? NO_HISTORY : count - 1 - codes.lastIndexOf(ctx.nightShiftId),
    daysSinceSick: codes.lastIndexOf("S") === -1 ? NO_HISTORY : count - 1 - codes.lastIndexOf("S"),
    lastWorkEnd: hasWork ? workWindow(codes[lastWorkIndex], lastWorkIndex - count, ctx).end : null
  };
}

// Whoever did nights longest ago goes first; people without recent nights
// (newcomers, back from long leave) go before everyone, in row order.
export function deriveNightQueue(codesById, nightEligibleIds, nightShiftId = "3") {
  const daysSinceNight = (id) => {
    const codes = codesById[id] ?? [];
    const last = codes.lastIndexOf(nightShiftId);
    return last === -1 ? Number.POSITIVE_INFINITY : codes.length - 1 - last;
  };
  return nightEligibleIds
    .map((id, row) => ({ id, row, since: daysSinceNight(id) }))
    .sort((left, right) => right.since - left.since || left.row - right.row)
    .map((item) => item.id);
}

// Per-member totals of earlier months, used for fairness across months.
// Available days = days the person could be rostered (a shift or H); cuti,
// sakit, training and "-" are not available, so leave never creates a debt of
// nights or weekends. `months` is [{ key, dates, codesById }].
// `longNightBlocks`: 3-night blocks, counted in the month of their third night
// (a block may continue from the month before, e.g. 29-30 Sep + 1 Oct).
export function rollingStats(months, memberIds, shiftIds, nightShiftId = "3", longBlock = 3) {
  const fields = ["workDays", "nightDays", "weekendDays", "availableDays", "availableWeekendDays", "longNightBlocks"];
  const stats = Object.fromEntries(memberIds.map((id) => [id, { months: 0, ...Object.fromEntries(fields.map((field) => [field, 0])), perMonth: [] }]));
  const trailingNights = {};
  let previousEnd = null;
  for (const month of [...months].sort((a, b) => a.key.localeCompare(b.key))) {
    const continues = previousEnd !== null && isoDate(addDays(previousEnd, 1)) === month.dates[0];
    previousEnd = month.dates.at(-1);
    for (const id of memberIds) {
      const codes = month.codesById[id];
      let run = continues ? (trailingNights[id] ?? 0) : 0;
      trailingNights[id] = 0;
      if (!codes || codes.every((code) => code === "-")) continue;
      const item = { key: month.key, ...Object.fromEntries(fields.map((field) => [field, 0])) };
      codes.forEach((code, index) => {
        run = code === nightShiftId ? run + 1 : 0;
        if (run === longBlock) item.longNightBlocks += 1;
        const weekend = isWeekend(month.dates[index]);
        if (code === "H" || isShiftCode(code, shiftIds)) {
          item.availableDays += 1;
          if (weekend) item.availableWeekendDays += 1;
        }
        if (!isShiftCode(code, shiftIds)) return;
        item.workDays += 1;
        if (code === nightShiftId) item.nightDays += 1;
        if (weekend) item.weekendDays += 1;
      });
      trailingNights[id] = run;
      const total = stats[id];
      total.months += 1;
      for (const field of fields) total[field] += item[field];
      total.perMonth.push(item);
    }
  }
  return stats;
}
