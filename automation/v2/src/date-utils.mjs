import { RosterError } from "./errors.mjs";

const DAY_MS = 86_400_000;

export function monthKey(year, month) {
  return `${year}-${String(month).padStart(2, "0")}`;
}

export function parseMonthKey(key) {
  const match = /^(\d{4})-(\d{1,2})$/.exec(String(key).trim());
  const year = match ? Number(match[1]) : NaN;
  const month = match ? Number(match[2]) : NaN;
  if (!match || month < 1 || month > 12 || year < 2000 || year > 2200) {
    throw new RosterError(`Bulan tidak valid: "${key}". Gunakan format TAHUN-BULAN, contoh 2026-11.`);
  }
  return { year, month };
}

export function addMonths(key, count) {
  const { year, month } = parseMonthKey(key);
  const index = year * 12 + (month - 1) + count;
  return monthKey(Math.floor(index / 12), (index % 12) + 1);
}

export function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function parseIsoDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new Error(`Invalid ISO date: ${value}`);
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
}

export function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

export function addDays(value, days) {
  const date = typeof value === "string" ? parseIsoDate(value) : value;
  return new Date(date.getTime() + days * DAY_MS);
}

export function diffDays(left, right) {
  return Math.round((parseIsoDate(left).getTime() - parseIsoDate(right).getTime()) / DAY_MS);
}

export function eachDate(start, end) {
  const dates = [];
  for (let cursor = parseIsoDate(start); cursor <= parseIsoDate(end); cursor = addDays(cursor, 1)) {
    dates.push(isoDate(cursor));
  }
  return dates;
}

export function monthBounds(year, month) {
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 0));
  return { start: isoDate(start), end: isoDate(end) };
}

export function weekdayIndex(value) {
  return parseIsoDate(value).getUTCDay();
}

export function isWeekend(value) {
  const day = weekdayIndex(value);
  return day === 0 || day === 6;
}

export function parseClock(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new Error(`Invalid time: ${value}`);
  return Number(match[1]) + Number(match[2]) / 60;
}

export function shiftWindow(shift, dayIndex) {
  const start = dayIndex * 24 + parseClock(shift.start);
  let end = dayIndex * 24 + parseClock(shift.end);
  if (end <= start) end += 24;
  return { start, end };
}

export function formatDay(value, locale = "id-ID") {
  return new Intl.DateTimeFormat(locale, {
    timeZone: "UTC",
    weekday: "short",
    day: "2-digit",
    month: "short"
  }).format(parseIsoDate(value));
}
