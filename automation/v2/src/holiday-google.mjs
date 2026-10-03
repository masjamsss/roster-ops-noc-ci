// Indonesian public holidays from Google Calendar's public holiday feed.
// Tested 29 Sep 2026: covers 2021-2027 and marks each event as
// "Hari libur nasional" (tanggal merah and cuti bersama) or "Perayaan" (observance).
import { addDays, isoDate } from "./date-utils.mjs";

export const GOOGLE_HOLIDAY_ICS = "https://calendar.google.com/calendar/ical/id.indonesian%23holiday%40group.v.calendar.google.com/public/basic.ics";

function unfold(text) {
  return text.replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "");
}

function unescapeValue(value) {
  return value.replace(/\\n/gi, "\n").replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\\\/g, "\\");
}

function toIso(compact) {
  return `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
}

function classify(summary, description) {
  if (/^cuti bersama|joint holiday/i.test(summary)) return "collective_leave";
  if (description.startsWith("hari libur nasional")) return "national";
  // The SKB lists Easter Sunday as tanggal merah; Google marks it as an observance.
  if (/paskah/i.test(summary)) return "national";
  return null;
}

export function parseGoogleIcs(text, year) {
  const byDate = new Map();
  for (const block of unfold(text).split("BEGIN:VEVENT").slice(1)) {
    const field = (name) => {
      const match = new RegExp(`^${name}(?:;[^:\\n]*)?:(.*)$`, "m").exec(block);
      return match ? unescapeValue(match[1].trim()) : "";
    };
    const start = field("DTSTART");
    if (!/^\d{8}$/.test(start)) continue;
    const rawSummary = field("SUMMARY");
    const description = field("DESCRIPTION").split("\n")[0].trim().toLowerCase();
    const type = classify(rawSummary, description);
    if (!type) continue;
    const tentative = /\(belum pasti\)/i.test(rawSummary);
    const name = rawSummary.replace(/\s*\(belum pasti\)\s*/i, " ").trim();
    const end = /^\d{8}$/.test(field("DTEND")) ? toIso(field("DTEND")) : isoDate(addDays(toIso(start), 1));
    for (let date = toIso(start); date < end; date = isoDate(addDays(date, 1))) {
      if (!date.startsWith(`${year}-`)) continue;
      const existing = byDate.get(date);
      if (!existing) {
        byDate.set(date, { date, type, name, tentative });
        continue;
      }
      existing.type = existing.type === "national" || type === "national" ? "national" : "collective_leave";
      if (!existing.name.includes(name)) existing.name = `${existing.name} / ${name}`;
      existing.tentative = existing.tentative && tentative;
    }
  }
  return [...byDate.values()].sort((left, right) => left.date.localeCompare(right.date));
}

export async function fetchGoogleIcs({ fetchImpl = globalThis.fetch, timeoutMs = 15_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(GOOGLE_HOLIDAY_ICS, { signal: controller.signal, headers: { "user-agent": "roster-ops-noc/3.0" } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}
