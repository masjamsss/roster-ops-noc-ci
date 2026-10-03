// Work-life balance score per person for the month (user, 30 Sep): 100 minus
// clear, named burdens: nights, 3-night blocks, weekends, long work stretches,
// broken rest, hours above the weekly limit, days above target, and switching
// between Shift 1 and Shift 2 inside a work block. It reports; it does not steer
// the search. Labels are for the OM, in plain Indonesian.
const WORK = new Set(["1", "2", "3", "T"]);
const DAY_SHIFTS = new Set(["1", "2"]);

export const WLB_POINTS = Object.freeze({
  overTarget: 4, night: 1, longBlock: 2, noFullWeekend: 10, oneFullWeekend: 3, weekendDay: 1,
  fullBlock: 2, singleOff: 3, singleWork: 3, hourOver: 1, hourHeavy: 2, shiftSwitch: 2
});
export const WLB_LEVELS = Object.freeze([[80, "Baik"], [65, "Cukup"], [0, "Perlu perhatian"]]);
const MIN_DAYS = 10;

// How many days of the month (index >= `offset`) a running count of `test`
// days, carried in from last month, reaches exactly `length`.
function reached(codes, offset, test, length) {
  let run = 0;
  let count = 0;
  codes.forEach((code, index) => {
    run = test(code) ? run + 1 : 0;
    if (index >= offset && run === length) count += 1;
  });
  return count;
}

// The same definitions are written as formulas on the Excel "Pemeriksaan" sheet
// (excel-checks.mjs); keep both in step.
export function workLifeBalance({ members, days, schedule, memberSummary, settings = {}, history = null }) {
  const rules = settings.rules ?? {};
  const limit = rules.weeklyHoursLimit ?? 40;
  const maxRun = rules.maxConsecutiveWorkDays ?? 5;
  // Leave counts as a work day for the stretch, as in the rules (leaveCountsAsWork).
  const stretchDay = (code) => WORK.has(code) || (code === "C" && rules.leaveCountsAsWork !== false);
  const P = WLB_POINTS;

  const scored = members.map((member) => {
    const summary = memberSummary[member.id];
    const codes = days.map((day) => schedule[member.id]?.[day.date] ?? "-");
    const past = (history?.codesById?.[member.id] ?? []).slice(-10);
    const timeline = [...past, ...codes];
    if (!summary || codes.length - (summary.inactiveDays ?? 0) < MIN_DAYS) return { id: member.id, name: member.name, score: null, level: null, factors: [] };
    const factors = [];
    const add = (points, label) => {
      if (points > 0) factors.push({ points, label });
    };
    const over = Math.round(summary.workDays - summary.workTarget);
    add(P.overTarget * over, `Hari kerja di atas target: ${over} hari`);
    const nights = summary.shifts?.["3"] ?? 0;
    add(P.night * nights, `Shift 3: ${nights} malam`);
    const long = reached(timeline, past.length, (code) => code === "3", 3);
    add(P.longBlock * long, `Blok 3 malam: ${long}`);
    if (summary.fullWeekendsOff === 0) add(P.noFullWeekend, "Tidak ada libur Sabtu–Minggu penuh");
    else if (summary.fullWeekendsOff === 1) add(P.oneFullWeekend, "Libur Sabtu–Minggu penuh hanya 1 kali");
    add(P.weekendDay * summary.weekendWorkDays, `Kerja Sabtu/Minggu: ${summary.weekendWorkDays} hari`);
    const full = reached(timeline, past.length, stretchDay, maxRun);
    add(P.fullBlock * full, `${maxRun} hari kerja berturut-turut: ${full} kali`);
    // Within the month, not on its first or last day (they continue elsewhere).
    const inside = (i) => i > 0 && i < codes.length - 1;
    const isolated = codes.filter((code, i) => code === "H" && inside(i) && WORK.has(codes[i - 1]) && WORK.has(codes[i + 1])).length;
    add(P.singleOff * isolated, `Libur hanya 1 hari di antara hari kerja: ${isolated} kali`);
    const singles = codes.filter((code, i) => WORK.has(code) && inside(i) && !WORK.has(codes[i - 1]) && !WORK.has(codes[i + 1])).length;
    add(P.singleWork * singles, `Masuk hanya 1 hari di antara libur: ${singles} kali`);
    add(P.hourOver * summary.hoursOverLimit, `Jam di atas ${limit} per minggu: ${summary.hoursOverLimit} jam`);
    const heavy = (summary.weeklyHours ?? []).reduce((sum, week) => sum + Math.max(0, week.hours - (limit + 4)), 0);
    add(P.hourHeavy * heavy, `Jam di atas ${limit + 4} per minggu: ${heavy} jam (tambahan)`);
    const switches = codes.filter((code, i) => i > 0 && DAY_SHIFTS.has(code) && DAY_SHIFTS.has(codes[i - 1]) && code !== codes[i - 1]).length;
    add(P.shiftSwitch * switches, `Pindah Shift 1 ↔ 2 di dalam satu blok kerja: ${switches} kali`);
    factors.sort((a, b) => b.points - a.points);
    const score = Math.max(0, 100 - factors.reduce((sum, factor) => sum + factor.points, 0));
    return { id: member.id, name: member.name, score, level: levelOf(score), factors };
  });

  const counted = scored.filter((item) => item.score !== null);
  const team = counted.length ? Math.round(counted.reduce((sum, item) => sum + item.score, 0) / counted.length) : null;
  return { members: scored, team, teamLevel: team === null ? null : levelOf(team) };
}

export function levelOf(score) {
  return WLB_LEVELS.find(([minimum]) => score >= minimum)[1];
}
