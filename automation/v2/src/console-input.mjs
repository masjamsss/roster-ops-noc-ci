// Dates as admins type them in the console: 16/11/2026, 16-11-2026, 16.11.2026,
// 2026-11-16, or 16/11 (the year of the month being worked on). Returns the ISO
// date, or null when it is not a real date.
export function parseTanggal(text, { year = new Date().getFullYear() } = {}) {
  const value = String(text ?? "").trim();
  let match = value.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  let parts = match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
  if (!parts) {
    match = value.match(/^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{4}))?$/);
    if (match) parts = [match[3] ? Number(match[3]) : year, Number(match[2]), Number(match[1])];
  }
  if (!parts) return null;
  const [y, m, d] = parts;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return date.toISOString().slice(0, 10);
}

// Several dates at once, as admins type them for a Dispensasi or leave on
// scattered days: "5/11, 12/11-14/11, 20/11". Items are separated by "," or ";";
// a range is "a-b", "a - b", "a – b", "a sampai b" or "a s/d b". Touching or
// overlapping days become one period. With `today`, a date typed without a year
// that is more than two months ago means next year (as the single-date question).
// Returns { periods } in date order, or { periods: null, invalid } naming the item.
export function parseDaftarTanggal(text, { year = new Date().getFullYear(), today = null } = {}) {
  const items = String(text ?? "").split(/[,;]/).map((item) => item.trim());
  if (items.every((item) => item === "")) return { periods: null, invalid: "" };
  const dayAfter = (iso) => new Date(Date.parse(`${iso}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  const recent = today ? new Date(Date.parse(`${today}T00:00:00Z`) - 60 * 86_400_000).toISOString().slice(0, 10) : null;
  // `start`: the end of a range typed without a year may cross New Year
  // (28/12-3/1), but not by more than two months (14/11-12/11 is a typo).
  const date = (part, start = null) => {
    let value = parseTanggal(part, { year });
    if (!value || /\d{4}/.test(part)) return value;
    if (recent && value < recent) value = parseTanggal(part, { year: year + 1 });
    if (start && value < start) {
      const next = parseTanggal(part, { year: Number(value.slice(0, 4)) + 1 });
      if (Date.parse(next) - Date.parse(start) <= 62 * 86_400_000) value = next;
    }
    return value;
  };
  const range = (item) => {
    const single = date(item);
    if (single) return { from: single, to: single };
    const words = item.split(/\s*(?:–|—|\bsampai\b|\bs\/d\b|\bs\.d\.?)\s*|\s+-\s+/i);
    const splits = words.length === 2 ? [words] : [...item.matchAll(/-/g)].map((match) => [item.slice(0, match.index), item.slice(match.index + 1)]);
    for (const [left, right] of splits) {
      const from = date(left.trim());
      const to = from && date(right.trim(), from);
      if (from && to) return to >= from ? { from, to } : null;
    }
    return null;
  };
  const periods = [];
  for (const item of items.filter(Boolean)) {
    const period = range(item);
    if (!period) return { periods: null, invalid: item };
    periods.push(period);
  }
  periods.sort((a, b) => a.from.localeCompare(b.from));
  const merged = [];
  for (const period of periods) {
    const last = merged.at(-1);
    if (last && period.from <= dayAfter(last.to)) last.to = period.to > last.to ? period.to : last.to;
    else merged.push({ ...period });
  }
  return { periods: merged };
}
