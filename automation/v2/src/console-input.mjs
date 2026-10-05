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
