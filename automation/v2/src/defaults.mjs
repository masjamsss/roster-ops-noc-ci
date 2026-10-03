// Defaults for a new "Data Roster.xlsx" and for tests. The admin changes team,
// staffing and rules in the workbook; weights and search limits live in
// pengaturan/lanjutan.json for maintainers only.

export const DEFAULT_SHIFTS = Object.freeze([
  { id: "1", label: "Shift 1", name: "Pagi", start: "07:00", end: "16:00", level: 1, night: false },
  { id: "2", label: "Shift 2", name: "Siang", start: "13:00", end: "21:00", level: 2, night: false },
  { id: "3", label: "Shift 3", name: "Malam", start: "21:00", end: "07:00", level: 3, night: true }
]);

export const DEFAULT_TRAINING_WINDOW = Object.freeze({ start: "08:00", end: "17:00" });

// Row order matters only as a tie-break for the night rotation when there is no history.
export const DEFAULT_TEAM = Object.freeze([
  { id: "hilvani", name: "Hilvani", gender: "P", eligibleShifts: ["1", "2"] },
  { id: "pavitasari", name: "Pavitasari", gender: "P", eligibleShifts: ["1", "2"] },
  { id: "rizky", name: "Rizky", gender: "L", eligibleShifts: ["1", "2", "3"] },
  { id: "willy", name: "Willy", gender: "L", eligibleShifts: ["1", "2", "3"] },
  { id: "arman", name: "Arman", gender: "L", eligibleShifts: ["1", "2", "3"] },
  { id: "addin", name: "Addin", gender: "L", eligibleShifts: ["1", "2", "3"] }
]);

export const DEFAULT_COVERAGE = Object.freeze({
  weekday: { minimum: { 1: 1, 2: 1, 3: 1 }, preferred: { 1: 2, 2: 2, 3: 1 } },
  special: { minimum: { 1: 1, 2: 1, 3: 1 }, preferred: { 1: 1, 2: 1, 3: 1 } },
  collectiveLeaveIsSpecial: true
});

export const DEFAULT_RULES = Object.freeze({
  maxConsecutiveWorkDays: 5,
  maxConsecutiveOffDays: 2,
  minimumRestHours: 11,
  forbidBackwardShiftWithoutOff: true,
  nightRecoveryOffDays: 2,
  nightBlock: { min: 2, preferred: 2, max: 3 },
  balanceDayOnlyShifts: true,
  // Back from sick leave (e.g. hospital): no Shift 3 for the first days back.
  nightFreeDaysAfterSick: 5,
  // Friday prayer coverage: at least one female agent on Shift 1 every Friday.
  fridayShift1Female: true,
  // Leave counts as a work day for the consecutive-day limit and night recovery (user, 30 Sep).
  leaveCountsAsWork: true,
  // 3-night blocks only when forced (user, 30 Sep: healthier). 2-night blocks are
  // the norm; a 31-day month still needs one 3-night block, since blocks do not
  // cross the month boundary. Sets nightBlockExtension to LONG_BLOCK_FORCED_WEIGHT.
  longNightBlockOnlyIfNeeded: true,
  // Hours: unpaid break per shift, and the weekly limit for net hours (PP 35/2021: 40).
  breakHours: 1,
  weeklyHoursLimit: 40,
  // Backup plan: overtime per person to cover someone who cannot come (the
  // previous shift stays longer / the next shift comes earlier; user, 29 Sep 2026).
  overtimeHours: 4,
  // "auto" = the month's ideal work (2-2-1 weekdays, 1-1-1 weekends and
  // tanggal merah) shared evenly, at most 5 workdays per week (22 in a 31-day
  // month). A number (e.g. 21) fixes it instead. Cuti/sakit/training lower
  // the person's target 1:1 either way.
  workDaysTarget: "auto"
});

export const DEFAULT_WEIGHTS = Object.freeze({
  // Weekday staffing: below ideal (2-2-1) is "cukup" and cheap per missing person;
  // the bare minimum (1-1-1) is expensive. Shift 1 never has fewer people than
  // Shift 2 (morning traffic is higher; user, 29 Sep 2026): 2-1-1, never 1-2-1.
  weekdayShortPerPerson: 80,
  // 1-1-1 costs 80 × 2 + 920: avoided unless the rules leave no other way.
  weekdayMinimal: 920,
  shift1BelowShift2: 500,
  // Fairness of workdays, weekends and nights (daily guides + month-end totals).
  // Workdays: responsible days (worked + cuti/sakit/training) should differ by at most 1.
  workloadSpreadDaily: 12,
  workloadSpreadTolerance: 1,
  workloadSpreadLight: 150,
  workloadSpreadHeavy: 800,
  // Only used when the Aturan sheet sets a fixed number as target.
  overWorkDaysTarget: 450,
  overWorkDaysTargetDaily: 20,
  underWorkDaysTarget: 350,
  // Daily guide that keeps everyone on pace for the monthly target.
  underWorkDaysTargetDaily: 80,
  weekendSpread: 400,
  weekendSpreadDaily: 300,
  // Nights shared evenly (user, 30 Sep: "some get two 3-night blocks, others only
  // 2-night blocks"). Six-month backtest: worst monthly gap in nights 3 -> 2, in
  // 3-night blocks per man 2 -> 1; IDEAL and MINIMAL days unchanged; weekend days
  // over six months 24-26 -> 22-28 per person.
  nightSpreadDaily: 60,
  nightSpreadLight: 60,
  nightSpreadHeavy: 800,
  repeatLongNightBlock: 300,
  longNightBlockSpread: 300,
  // Friday prayer coverage: stronger than one missing weekday slot and never
  // traded for rest comfort (checked on a six-month backtest).
  fridayShift1WithoutFemale: 1000,
  // Per net hour above the weekly limit (Monday-Sunday), and extra per hour
  // more than 4 above it, so overtime stays spread out instead of spiking.
  weeklyHoursOver: 150,
  weeklyHoursHeavy: 1200,
  // Updating an existing month (new leave, sickness): per day that differs from
  // the current roster. Keeps people's plans stable; changes happen only where
  // they are worth more than this (fair nights, hours, staffing).
  changeFromReference: 150,
  // Per day that a new night block starts earlier than 6 days after the last night.
  nightBlockTooSoon: 150,
  // A third night is allowed whenever it gives a cleaner rhythm or more staff
  // (user's decision, 29 Sep 2026): with 4 men, 2-night blocks alone cap the
  // men at about 19-20 workdays; D D N N N H H reaches 21-22.
  nightBlockExtension: 50,
  // Rest and regularity.
  adjacentShiftChange: 10,
  // Switching between Shift 1 and Shift 2 inside a work block (user, 30 Sep:
  // "the shift should stay the same until the day off"). Six-month backtest at
  // 400: mixed blocks 52 of 228 -> 0, all audits OK, 0 MINIMAL days; cost 4 fewer
  // IDEAL weekdays, 12 more single days off, women's Shift 1/2 gap up to 4 a month.
  dayShiftSwitchInBlock: 400,
  directDayToNightJump: 60,
  postRestShiftChange: 6,
  postRestBackwardJump: 14,
  // A single day off between work days (1-H-1), and a single work day between
  // days off (H-1-H, near-hard: only when nothing else fits). Chosen on the
  // six-month backtest together with the 22-day target (29 Sep 2026).
  isolatedOff: 150,
  shortRecoveryAfterMaxWork: 40,
  singletonShiftRun: 20,
  singleWorkDay: 1000,
  // A 2-day work block (H H 1 1 H H); 4-5 days then 2 off is the aim.
  shortWorkBlock: 40,
  // Hilvani/Pavitasari: Shift 1 and Shift 2 balanced (user's decision). Strong
  // enough to hold now that 2-1-1 days make Shift 1 need more people.
  dayShiftImbalance: 30,
  // 300 since 30 Sep: with the same shift through a work block the women's
  // balance needs whole blocks; six-month backtest: months with a Shift 1/2 gap
  // above 2 went 2 -> 1, IDEAL 55 -> 53, weeks above 40 h 38 -> 33.
  dayShiftImbalanceFinal: 300,
  consecutiveOffReward: 8,
  fullWeekendOffFirst: 450,
  fullWeekendOffNext: 15
});

export const DEFAULT_SEARCH = Object.freeze({
  beamWidth: 6000,
  // How many of the first available people in the night queue may start a block.
  nightChoices: 2,
  minBeamWidth: 400,
  maxTransitionsPerDay: 9_000_000,
  lookaheadDays: 7
});

export const DEFAULT_LOCAL_SEARCH = Object.freeze({ enabled: true, maxPasses: 40 });

// Best-result mode ("buat --terbaik"): the normal search plus 5 variants that
// steer it differently. Every result is scored with the normal weights and the
// best one is kept. About 6 times slower; for the final version of a month.
export const DEFAULT_PORTFOLIO = Object.freeze([
  {},
  { search: { beamScale: 1.5 } },
  { search: { nightChoices: 3 } },
  { weightScale: { singleWorkDay: 0.6, isolatedOff: 0.67, shortWorkBlock: 0.5 } },
  { weightScale: { weekendSpread: 1.5, weekendSpreadDaily: 1.5, nightSpreadLight: 2, nightSpreadHeavy: 1.5 } },
  { weightScale: { weeklyHoursOver: 0.53, weeklyHoursHeavy: 0.5 } }
]);

// Internal config consumed by the engine. `team` rows may carry activeFrom/activeUntil.
// Six-month backtest (30 Sep): 3-night blocks 28 -> 4 in six months (one per
// 31-day month), nights per man unchanged.
export const LONG_BLOCK_FORCED_WEIGHT = 3000;

export function makeConfig({ year, month, team = DEFAULT_TEAM, coverage = DEFAULT_COVERAGE, rules = DEFAULT_RULES, shifts = DEFAULT_SHIFTS, requests = [], weights = {}, search = {}, localSearch = {} }) {
  const nightId = shifts.find((shift) => shift.night)?.id;
  return {
    period: { year, month, lookaheadDays: search.lookaheadDays ?? DEFAULT_SEARCH.lookaheadDays },
    shifts: shifts.map((shift) => ({ ...shift })),
    trainingWindow: { ...DEFAULT_TRAINING_WINDOW },
    members: team.map((member, row) => ({
      id: member.id,
      name: member.name,
      gender: member.gender ?? "",
      eligibleShifts: [...member.eligibleShifts],
      dayOnly: !member.eligibleShifts.includes(nightId),
      activeFrom: member.activeFrom ?? null,
      activeUntil: member.activeUntil ?? null,
      row
    })),
    coverage: structuredClone(coverage),
    rules: structuredClone(rules),
    requests: requests.map((request) => ({ ...request })),
    // The Aturan switch sets the 3rd-night cost; explicit weights (lanjutan.json) still win.
    weights: { ...DEFAULT_WEIGHTS, ...(rules.longNightBlockOnlyIfNeeded === false ? {} : { nightBlockExtension: LONG_BLOCK_FORCED_WEIGHT }), ...weights },
    search: { ...DEFAULT_SEARCH, ...search },
    localSearch: { ...DEFAULT_LOCAL_SEARCH, ...localSearch }
  };
}
