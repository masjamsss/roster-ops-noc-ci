import { addDays, daysInMonth, eachDate, isoDate, isWeekend, monthBounds, weekdayIndex } from "./date-utils.mjs";

export function holidayIndex(calendars) {
  const index = new Map();
  for (const calendar of calendars) {
    for (const day of calendar.days ?? []) {
      index.set(day.date, { ...day, source: calendar.status ?? "unknown" });
    }
  }
  return index;
}

// The generated horizon = the month plus a look-ahead into next month. The
// look-ahead is solved too, so the month never ends in a state next month
// cannot continue from, but only the month itself is published.
export function buildDays(config, calendars) {
  const { year, month, lookaheadDays } = config.period;
  const bounds = monthBounds(year, month);
  const horizonEnd = isoDate(addDays(bounds.end, lookaheadDays));
  const horizonDates = eachDate(bounds.start, horizonEnd);
  const holidays = holidayIndex(calendars);
  const days = horizonDates.map((date, dayIndex) => {
    const holiday = holidays.get(date) ?? null;
    const weekend = isWeekend(date);
    const national = holiday?.type === "national";
    const collective = holiday?.type === "collective_leave";
    const dayOfMonth = Number(date.slice(8, 10));
    const nextDate = dayIndex + 1 < horizonDates.length ? horizonDates[dayIndex + 1] : null;
    return {
      date,
      dayIndex,
      isWeekend: weekend,
      isSunday: weekdayIndex(date) === 0,
      isFriday: weekdayIndex(date) === 5,
      isMonday: weekdayIndex(date) === 1,
      holiday,
      isHoliday: national || collective,
      isSpecial: weekend || national || (collective && config.coverage.collectiveLeaveIsSpecial !== false),
      published: date <= bounds.end,
      isFirstOfMonth: dayOfMonth === 1,
      isLastOfMonth: dayOfMonth === daysInMonth(Number(date.slice(0, 4)), Number(date.slice(5, 7))),
      hasTomorrow: nextDate !== null,
      nextDate
    };
  });
  return { bounds, horizonEnd, horizonDates, publishedDates: horizonDates.filter((date) => date <= bounds.end), days };
}
