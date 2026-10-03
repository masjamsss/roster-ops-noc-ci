// Turns the admin's workbook + the maintainer-only advanced file into the
// engine config for one month.
import { addDays, isoDate, monthBounds, parseMonthKey } from "./date-utils.mjs";
import { DEFAULT_SEARCH, DEFAULT_SHIFTS, makeConfig } from "./defaults.mjs";
import { RosterError } from "./errors.mjs";

export function buildConfig({ input, advanced = {}, monthKey }) {
  const { year, month } = parseMonthKey(monthKey);
  const bounds = monthBounds(year, month);
  const lookahead = advanced.search?.lookaheadDays ?? DEFAULT_SEARCH.lookaheadDays;
  const horizonEnd = isoDate(addDays(bounds.end, lookahead));
  const team = input.members.filter((member) => (!member.activeFrom || member.activeFrom <= horizonEnd) && (!member.activeUntil || member.activeUntil >= bounds.start));
  if (team.length === 0) throw new RosterError(`Tidak ada anggota yang aktif pada bulan ${monthKey}. Periksa sheet "Anggota".`);
  const teamIds = new Set(team.map((member) => member.id));
  const shifts = DEFAULT_SHIFTS.map((shift) => ({ ...shift, ...(input.shiftTimes?.[shift.id] ?? {}) }));
  const warnings = [];
  const requests = input.requests.filter((request) => {
    if (teamIds.has(request.memberId)) return true;
    if (request.to >= bounds.start && request.from <= bounds.end) warnings.push(`${request.source}: ${request.name} tidak aktif bulan ini, baris diabaikan.`);
    return false;
  });
  const config = makeConfig({
    year,
    month,
    team,
    coverage: input.coverage,
    rules: input.rules,
    shifts,
    requests,
    weights: advanced.weights ?? {},
    search: advanced.search ?? {},
    localSearch: advanced.localSearch ?? {}
  });
  config.warnings = warnings;
  config.externalBackups = input.externalBackups ?? [];
  return config;
}
