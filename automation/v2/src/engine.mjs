// generateRoster: from settings + holidays + last month's real codes to a
// validated monthly roster (result JSON, schema 3).
import os from "node:os";
import { Worker } from "node:worker_threads";
import { auditTimeline } from "./audit.mjs";
import { addDays, diffDays, isoDate, isWeekend, monthBounds, monthKey, parseClock, weekdayIndex } from "./date-utils.mjs";
import { buildDays } from "./days.mjs";
import { RosterError } from "./errors.mjs";
import { deriveMemberState, deriveNightQueue, rollingStats } from "./history.mjs";
import { formatPeriode, formatTanggal, KODE_LABEL } from "./labels-id.mjs";
import { overtimeCover } from "./backup-plan.mjs";
import { buildNotes, computeDayRows, computeMemberSummary, findNightBlocks } from "./metrics.mjs";
import { explainMinimalDays } from "./minimal-days.mjs";
import { betterThan, isPerfect, PERFECT_BUDGET_MS, roundFits, targetedVariants } from "./perfect.mjs";
import { workLifeBalance } from "./wellbeing.mjs";
import { initialNightState } from "./night-rotation.mjs";
import { fairnessOffsets, makeEnv, scoreSchedule } from "./objective.mjs";
import { buildDayPatterns } from "./patterns.mjs";
import { explainTransition, initialMemberState, isActive, transitionMember } from "./rules.mjs";
import { describeCandidate, finishCandidate, runVariant } from "./variant-run.mjs";
import { EXHAUSTIVE_BUDGET_MS, exhaustiveSearch, nightCoverageCheck } from "./exhaustive.mjs";
import { diagnoseDeadEnd } from "./search.mjs";

export const ENGINE_VERSION = "3.0.0";
const HISTORY_DAYS = 21;

function checkConfig(config) {
  const nightShift = config.shifts.find((shift) => shift.night);
  if (!nightShift) throw new RosterError("Pengaturan shift tidak punya Shift 3 (malam).");
  const active = config.members;
  if (active.length < 3) throw new RosterError("Tim minimal 3 orang untuk mengisi Shift 1, 2 dan 3.");
  const nightCapable = active.filter((member) => member.eligibleShifts.includes(nightShift.id));
  if (nightCapable.length < 2) {
    throw new RosterError(`Minimal 2 orang harus boleh ${nightShift.label}, karena setelah blok malam wajib ada ${config.rules.nightRecoveryOffDays} hari libur. Sekarang: ${nightCapable.length} orang.`);
  }
  for (const policy of [config.coverage.weekday, config.coverage.special]) {
    if (policy.minimum[nightShift.id] !== 1 || policy.preferred[nightShift.id] !== 1) {
      throw new RosterError(`${nightShift.label} harus diisi tepat 1 orang per malam (sistem giliran malam dibuat untuk 1 orang).`);
    }
  }
  return nightShift;
}

function historyWindow(history, monthStart, members) {
  const dates = history?.dates ?? [];
  if (dates.length > 0) {
    const expected = isoDate(addDays(monthStart, -1));
    if (dates.at(-1) !== expected) {
      throw new RosterError(`Riwayat roster sebelumnya berakhir ${formatTanggal(dates.at(-1))}, padahal roster ini mulai ${formatTanggal(monthStart)}. Buat roster bulan sebelumnya terlebih dahulu.`);
    }
  }
  const windowDates = dates.slice(-HISTORY_DAYS);
  const codesById = {};
  for (const member of members) {
    const codes = history?.codesById?.[member.id];
    codesById[member.id] = codes ? codes.slice(-HISTORY_DAYS) : [];
  }
  return { dates: windowDates, codesById };
}

// Quick upper bound: can this team possibly staff the minimum every day?
// How a fixed cell reads in a message: "cuti", "minta Shift 1 (Pagi)", or, in
// update mode, "jadwal yang sudah dijalani" for days before `freezeBefore`.
function fixedLabel(config, days, d, code) {
  if (config.freezeBefore && days[d].date < config.freezeBefore && !["T", "C", "S"].includes(code)) return "jadwal yang sudah dijalani";
  return ({ T: "training/dinas", C: "cuti", S: "sakit", H: "minta libur" })[code] ?? `minta ${KODE_LABEL[code] ?? code}`;
}

// Each person's own requests, leave and training (and how last month ended) must
// fit the rules by themselves: "Shift 2 then Shift 1 the next day", or a day shift
// right after a requested night, can never be met whatever the others do. Checked
// per person over every possible sequence of that person's days (a relaxation of
// the whole roster: coverage and the night rotation are left out), so a conflict
// found here is certain and is named at once with the rule it breaks.
function checkPersonalRequests(config, members, days, fixed, initialStates, ctx) {
  const shiftIds = config.shifts.map((shift) => shift.id);
  const recovery = config.rules.nightRecoveryOffDays;
  const keyOf = (s) => `${s.previousCode}${s.workStreak}.${s.offStreak}.${s.nightStreak}.${s.lastWorkWasNight ? 1 : 0}.${Math.min(s.restStreak, recovery)}` +
    `.${Math.min(s.daysSinceSick ?? 99, 15)}.${Math.min(s.daysSinceLongSick ?? 99, 15)}.${Math.min(s.sickRun ?? 0, 3)}`;
  members.forEach((member, i) => {
    if (!days.some((_, d) => fixed[d][member.id] !== undefined && fixed[d][member.id] !== "-")) return;
    const options = (d) => (fixed[d][member.id] !== undefined
      ? [fixed[d][member.id]]
      : ["H", ...shiftIds.filter((id) => member.eligibleShifts.includes(id) && !ctx.avoid?.[d]?.[member.id]?.has(id))]);
    const failed = days.map(() => new Set());
    let deepest = { d: 0, state: initialStates[i] };
    const walk = (state, d) => {
      if (d === days.length) return true;
      if (d > deepest.d) deepest = { d, state };
      const key = keyOf(state);
      if (failed[d].has(key)) return false;
      for (const code of options(d)) {
        const moved = transitionMember(state, member, code, days[d], ctx, { requested: fixed[d][member.id] !== undefined });
        if (moved && walk(moved.state, d + 1)) return true;
      }
      failed[d].add(key);
      return false;
    };
    if (walk(initialStates[i], 0)) return;
    const d = deepest.d;
    const day = days[d];
    const code = fixed[d][member.id];
    const reason = code !== undefined
      ? explainTransition(deepest.state, member, code, day, ctx, { requested: true })
      : options(d).map((option) => explainTransition(deepest.state, member, option, day, ctx)).find(Boolean);
    const from = Math.max(0, d - 3);
    const near = days.slice(from, d + 1).map((item, k) => {
      const fixedCode = fixed[from + k][member.id];
      return fixedCode !== undefined && fixedCode !== "-" ? `${formatTanggal(item.date, { pendek: true })} ${fixedLabel(config, days, from + k, fixedCode)}` : null;
    }).filter(Boolean);
    throw new RosterError(
      `${member.name}: ${near.join(", ")} tidak bisa dipenuhi bersama aturan roster. Pada ${formatTanggal(day.date, { denganHari: true })}: ${reason}. ` +
        "Ubah salah satunya di sheet Cuti & Permintaan (misalnya beri 1 hari libur di antaranya).",
      { date: day.date, inputConflict: true }
    );
  });
}

// Leave, training or requested shifts that by themselves break the work-day
// limit (training and requested shifts count as work, leave too when the Aturan
// sheet says so), counting on from last month on the 1st. No roster can satisfy
// them, so they are named at once instead of after a long search.
function checkFixedStreaks(config, members, days, fixed, initialStates) {
  const max = config.rules.maxConsecutiveWorkDays;
  const leaveAsWork = config.rules.leaveCountsAsWork !== false;
  const shiftIds = new Set(config.shifts.map((shift) => shift.id));
  members.forEach((member, i) => {
    let run = 0;
    let first = 0;
    days.forEach((day, d) => {
      const code = fixed[d][member.id];
      const work = code === "T" || shiftIds.has(code);
      if (!(work || (code === "C" && leaveAsWork))) {
        run = 0;
        return;
      }
      if (run === 0) {
        first = d;
        run = d === 0 ? initialStates[i].workStreak : 0;
      }
      run += 1;
      if (!work || run <= max) return;
      const names = [...new Set(days.slice(first, d + 1).map((_, offset) => fixedLabel(config, days, first + offset, fixed[first + offset][member.id])))];
      throw new RosterError(
        `${member.name}: ${names.join(", ")} ${formatTanggal(days[first].date, { pendek: true })} – ${formatTanggal(day.date, { pendek: true })}` +
          `${first === 0 && initialStates[i].workStreak ? ` (sambungan ${initialStates[i].workStreak} hari kerja dari bulan lalu)` : ""} = ${run} hari kerja berturut-turut, padahal maksimal ${max} hari kerja berturut-turut ` +
          `(training/dinas${leaveAsWork ? " dan cuti" : ""} dihitung hari kerja). Beri 1 hari libur di antaranya di sheet Cuti & Permintaan, atau ubah "Maksimal hari kerja berturut-turut" di sheet Aturan bila memang diizinkan.`,
        { date: day.date, inputConflict: true }
      );
    });
  });
}

function checkCapacity(config, members, days, fixed) {
  const published = days.filter((day) => day.published);
  const needed = published.reduce((sum, day) => {
    const policy = day.isSpecial ? config.coverage.special : config.coverage.weekday;
    return sum + config.shifts.reduce((total, shift) => total + policy.minimum[shift.id], 0);
  }, 0);
  const max = config.rules.maxConsecutiveWorkDays;
  const available = published.reduce((sum, day) => sum + members.filter((member) => !["-", "C", "S", "T", "H"].includes(fixed[day.dayIndex][member.id])).length, 0);
  const capacity = Math.floor((available * max) / (max + 1));
  if (needed > capacity) {
    const perDay = config.shifts.reduce((total, shift) => total + config.coverage.weekday.minimum[shift.id], 0);
    throw new RosterError(
      `Tim terlalu kecil untuk bulan ini: setiap hari butuh minimal ${perDay} orang (total ${needed} hari-orang), ` +
        `tetapi ${members.length} anggota paling banyak bisa bekerja sekitar ${capacity} hari-orang (maksimal ${max} hari kerja berturut-turut, sudah dikurangi cuti). ` +
        "Tambahkan anggota di sheet Anggota, atau kurangi cuti/training yang bersamaan."
    );
  }
}

// "Hindari Shift X" requests: avoid[dayIndex][memberId] = Set of shifts the
// person must not get that day (a hard rule in rules.mjs).
function buildAvoid(config, members, days) {
  const avoid = days.map(() => ({}));
  const known = new Set(members.map((member) => member.id));
  for (const request of config.requests) {
    if (!request.code.startsWith("!")) continue;
    if (!known.has(request.memberId)) throw new RosterError(`${request.source ?? "Permintaan"}: "${request.memberId}" tidak ada di daftar anggota aktif.`);
    days.forEach((day, d) => {
      if (day.date >= request.from && day.date <= request.to) (avoid[d][request.memberId] ??= new Set()).add(request.code.slice(1));
    });
  }
  return avoid;
}

function buildFixed(config, members, days, nightId, shiftIds) {
  const fixed = days.map(() => ({}));
  const byId = new Map(members.map((member) => [member.id, member]));
  for (const request of config.requests) {
    if (request.code.startsWith("!")) continue; // "Hindari Shift X": see buildAvoid
    const member = byId.get(request.memberId);
    const where = request.source ?? "Permintaan";
    if (!member) throw new RosterError(`${where}: "${request.memberId}" tidak ada di daftar anggota aktif.`);
    days.forEach((day, d) => {
      if (day.date < request.from || day.date > request.to) return;
      if (!isActive(member, day.date)) throw new RosterError(`${where}: ${member.name} tidak aktif pada ${formatTanggal(day.date)}.`);
      if (shiftIds.includes(request.code) && !member.eligibleShifts.includes(request.code)) {
        throw new RosterError(`${where}: ${member.name} tidak boleh ${KODE_LABEL[request.code]}.`);
      }
      const existing = fixed[d][member.id];
      if (existing !== undefined && existing !== request.code) {
        throw new RosterError(`${where}: bentrok dengan permintaan lain untuk ${member.name} pada ${formatTanggal(day.date)} (${KODE_LABEL[existing]} dan ${KODE_LABEL[request.code]}).`);
      }
      fixed[d][member.id] = request.code;
    });
  }
  days.forEach((day, d) => {
    for (const member of members) if (!isActive(member, day.date)) fixed[d][member.id] = "-";
    // Updating a month: days before `freezeBefore` stay exactly as they were
    // (already worked), unless a new request (e.g. sick leave) says otherwise.
    if (config.freezeBefore && day.date < config.freezeBefore) {
      for (const member of members) {
        const current = config.reference?.[member.id]?.[day.date];
        if (current !== undefined && fixed[d][member.id] === undefined) fixed[d][member.id] = current;
      }
    }
    const nights = members.filter((member) => fixed[d][member.id] === nightId);
    if (nights.length > 1) {
      throw new RosterError(`${nights.map((member) => member.name).join(" dan ")} sama-sama diminta Shift 3 pada ${formatTanggal(day.date)}, padahal Shift 3 hanya 1 orang.`);
    }
  });
  return fixed;
}

function timelineValid(state, member, codes, days, ctx, fixed) {
  let current = state;
  for (let d = 0; d < days.length; d += 1) {
    const moved = transitionMember(current, member, codes[d], days[d], ctx, { requested: fixed[d][member.id] !== undefined });
    if (!moved) return false;
    current = moved.state;
  }
  return true;
}

// "Cadangan": for each day and shift, who is on a normal day off (not leave,
// not a requested day off) and could step in without breaking any rule
// through the rest of the horizon.
// `stretched` = emergency-only options when nobody fits every rule: people who
// could step in by working one day more than the consecutive-day limit. Rest
// rules (11 hours, rest after nights, no backward shift) are never relaxed.
function findBackups({ members, days, codes, initialStates, ctx, fixed, shifts }) {
  const stretchedCtx = { ...ctx, rules: { ...ctx.rules, maxConsecutiveWorkDays: ctx.rules.maxConsecutiveWorkDays + 1 } };
  const backups = [];
  for (const day of days.filter((item) => item.published)) {
    const d = day.dayIndex;
    for (const shift of shifts) {
      const names = [];
      const stretched = [];
      members.forEach((member, i) => {
        if (codes[i][d] !== "H" || fixed[d][member.id] !== undefined || !member.eligibleShifts.includes(shift.id)) return;
        const trial = codes[i].slice();
        trial[d] = shift.id;
        if (timelineValid(initialStates[i], member, trial, days, ctx, fixed)) names.push(member.name);
        else if (timelineValid(initialStates[i], member, trial, days, stretchedCtx, fixed)) stretched.push(member.name);
      });
      backups.push({ date: day.date, shift: shift.id, names, stretched: names.length ? [] : stretched });
    }
  }
  return backups;
}

const clock = (hours) => `${String(Math.floor(hours) % 24).padStart(2, "0")}:${String(Math.round((hours % 1) * 60)).padStart(2, "0")}`;

// For each day and shift, the plan when one person cannot come: "aman" (a
// second person is on the shift), "lembur" (overtime of the neighbouring shifts
// closes the gap), "pengganti" / "darurat" (someone off that day takes the
// whole shift, emergency = a 6th day in a row), "kosong" (nothing in the team).
function planBackups({ members, days, timeline, offset, backups, config }) {
  const byKey = new Map(backups.map((entry) => [`${entry.date}|${entry.shift}`, entry]));
  return days.filter((day) => day.published).flatMap((day) => config.shifts.map((shift) => {
    const plan = overtimeCover({
      dayIndex: offset + day.dayIndex, shiftId: shift.id, timeline, members, shifts: config.shifts,
      minimumRestHours: config.rules.minimumRestHours, overtimeHours: config.rules.overtimeHours ?? 4
    });
    const replacement = byKey.get(`${day.date}|${shift.id}`) ?? { names: [], stretched: [] };
    const status = plan.safe ? "aman" : plan.uncovered.length === 0 ? "lembur" : replacement.names.length ? "pengganti" : replacement.stretched.length ? "darurat" : "kosong";
    // When overtime closes the gap, split it fairly (e.g. 6 hours = 3 + 3) instead
    // of giving one person the maximum; otherwise show the most overtime can do.
    let { extension, early } = plan;
    if (status === "lembur") {
      const total = plan.gap.to - plan.gap.from;
      const most = (item) => (item ? item.to - item.from : 0);
      const stay = Math.min(most(extension), Math.max(total - most(early), Math.ceil(total / 2)));
      extension = stay > 0 ? { ...extension, to: plan.gap.from + stay } : null;
      early = total - stay > 0 ? { ...early, from: plan.gap.to - (total - stay) } : null;
    }
    const part = (item) => item && { name: item.name, from: clock(item.from), to: clock(item.to), hours: item.to - item.from };
    return {
      date: day.date, shift: shift.id, status, people: plan.people,
      gap: plan.gap && { from: clock(plan.gap.from), to: clock(plan.gap.to) },
      extension: part(extension), early: part(early),
      uncovered: plan.uncovered.map((item) => ({ from: clock(item.from), to: clock(item.to), hours: item.to - item.from })),
      names: replacement.names, stretched: replacement.stretched
    };
  }));
}

function spanHours(start, end) {
  let hours = parseClock(end) - parseClock(start);
  if (hours <= 0) hours += 24;
  return hours;
}

// Net (paid) hours per code: shift span minus the unpaid break.
export function netHoursByCode(config) {
  const breakHours = config.rules.breakHours ?? 1;
  const hours = Object.fromEntries(config.shifts.map((shift) => [shift.id, Math.max(0, spanHours(shift.start, shift.end) - breakHours)]));
  hours.T = Math.max(0, spanHours(config.trainingWindow.start, config.trainingWindow.end) - breakHours);
  return hours;
}

// Net hours already worked in the Monday-Sunday week in which the month starts.
function weekHoursAtStart(codes, monthStart, netHours) {
  const daysBefore = (weekdayIndex(monthStart) + 6) % 7;
  return codes.slice(codes.length - daysBefore).reduce((sum, code) => sum + (netHours[code] ?? 0), 0);
}

// Shift 3 per night person over the months the fairness looks at (up to two
// earlier months) and this month: nights, 3-night blocks and available days.
function nightFairness({ members, published, codes, history, nightId, shiftIds, key }) {
  const night = members.filter((member) => member.eligibleShifts.includes(nightId));
  const earlier = history?.stats ?? {};
  const earlierKeys = [...new Set(night.flatMap((member) => (earlier[member.id]?.perMonth ?? []).map((item) => item.key)))].sort();
  const current = { key, dates: published.map((day) => day.date), codesById: Object.fromEntries(members.map((member, i) => [member.id, published.map((day) => codes[i][day.dayIndex])])) };
  const months = history?.dates?.length ? [{ key: history.key, dates: history.dates, codesById: history.codesById }, current] : [current];
  const now = rollingStats(months, night.map((member) => member.id), shiftIds, nightId);
  const pick = (item, monthKeyValue) => (item ? { key: monthKeyValue, nights: item.nightDays, longBlocks: item.longNightBlocks, availableDays: item.availableDays } : null);
  return {
    months: [...earlierKeys, key],
    members: night.map((member) => ({
      id: member.id,
      name: member.name,
      months: [
        ...earlierKeys.map((earlierKey) => pick(earlier[member.id]?.perMonth.find((item) => item.key === earlierKey), earlierKey)),
        pick(now[member.id]?.perMonth.find((item) => item.key === key), key)
      ]
    }))
  };
}

// Everything the search needs for one month: rules context, days, fixed cells,
// carry-in states, day patterns and the objective's environment.
export function prepareMonth({ config, calendars, history }) {
  const nightShift = checkConfig(config);
  const nightId = nightShift.id;
  const shiftIds = config.shifts.map((shift) => shift.id);
  const ctx = {
    shiftById: new Map(config.shifts.map((shift) => [shift.id, shift])),
    shiftIds,
    nightShiftId: nightId,
    trainingWindow: config.trainingWindow,
    rules: config.rules,
    weights: config.weights,
    nightChoices: config.search.nightChoices ?? 1,
    netHours: netHoursByCode(config),
    weeklyHoursLimit: config.rules.weeklyHoursLimit ?? 40,
    dailyHoursLimit: config.rules.dailyHoursLimit ?? 8,
    reference: config.reference ?? null
  };
  const { bounds, horizonEnd, horizonDates, days } = buildDays(config, calendars);
  const members = config.members;
  const window = historyWindow(history, bounds.start, members);
  const historyCodes = members.map((member) => window.codesById[member.id]);
  const fixed = buildFixed(config, members, days, nightId, shiftIds);
  const avoid = buildAvoid(config, members, days);
  ctx.avoid = avoid;
  checkCapacity(config, members, days, fixed);

  const initialStates = members.map((member, i) => ({
    ...initialMemberState(deriveMemberState(historyCodes[i], ctx), member),
    weekHours: window.dates.length ? weekHoursAtStart(historyCodes[i], bounds.start, ctx.netHours) : 0
  }));
  checkFixedStreaks(config, members, days, fixed, initialStates);
  checkPersonalRequests(config, members, days, fixed, initialStates, ctx);
  const nightCapable = members.filter((member) => member.eligibleShifts.includes(nightId)).map((member) => member.id);
  const initialQueue = deriveNightQueue(window.codesById, nightCapable, nightId);
  const initialNight = initialNightState(window.codesById, initialQueue, nightId);
  const patternsPerDay = days.map((day, d) => buildDayPatterns({ day, fixedToday: fixed[d], avoidToday: avoid[d], members, config, nightId }));
  const env = makeEnv(config, days, members, fixed);
  const rolling = fairnessOffsets(members, history?.stats);
  env.nightOffset = rolling.nights;
  env.weekendOffset = rolling.weekends;
  env.longBlockOffset = rolling.longBlocks;

  // One search normally. In best-result mode (`search.portfolio`) the search
  // runs once per variant (another width, night choice or guiding weights), in
  // parallel worker threads when possible. Every result is polished, scored with
  // the normal weights and reviewed; the one with the fewest serious quality
  // findings wins, then the lowest score. A variant that dead-ends is skipped as
  // long as another one succeeds.
  const publishedDays = days.filter((day) => day.published);
  const variants = config.search.portfolio?.length ? config.search.portfolio : [{}];
  const input = {
    members, days, fixed, patternsPerDay, initialStates, initialNight, ctx, config, env,
    historyCodes, historyDates: window.dates, shiftIds, nightId, withQuality: variants.length > 1
  };
  return { nightId, shiftIds, ctx, bounds, horizonEnd, horizonDates, days, members, window, historyCodes, fixed, initialStates, initialQueue, env, publishedDays, variants, input };
}

// How many attempts run at the same time. Measured on an 8-core, 8.6 GB Mac:
// 1 worker 151 s, 2 80 s, 3 60 s, 5 103 s (memory pressure). So: about 2.8 GB
// per worker and at most half the cores. The console uses it for its time estimate.
export function plannedWorkers(count, search = {}, { cores = typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length, memory = os.totalmem() } = {}) {
  if (count <= 1 || search.parallel === false) return 1;
  return Math.max(1, Math.min(count, search.workers ?? Infinity, Math.floor(cores / 2), Math.floor(memory / 2.8e9)));
}

export async function generateRoster({ config, calendars, history, onProgress }) {
  try {
    return await buildRoster({ config, calendars, history, onProgress });
  } catch (error) {
    // A month that cannot be made (not a mistake in Data Roster.xlsx): add the
    // concrete ways out that work, each one tried first, instead of general advice.
    if (!(error instanceof RosterError) || !error.details?.date || error.details.inputConflict || error.details.suggestions) throw error;
    onProgress?.({ step: "suggest" });
    const suggestions = suggestWaysOut({ config, calendars, history }, error.details.date);
    if (suggestions.length === 0) throw error;
    const message = error.message.split("\n").filter((line) => !/^(Saran|Pilihan):/.test(line)).join("\n");
    throw new RosterError(
      `${message}\nYang bisa dilakukan (sudah dicoba program; masing-masing membuat roster bisa disusun):\n${suggestions.map((text) => `- ${text}`).join("\n")}`,
      { ...error.details, suggestions }
    );
  }
}

// Ways out for a month that cannot be made, each tried before it is offered:
// without one of the leaves or requests around the date (nearest first), or with
// one temporary helper from outside the team (the narrowest that works).
const SUGGEST_BUDGET_MS = 3000;
const REQUEST_WORDS = Object.freeze({ C: "cuti", T: "training/dinas", H: "permintaan libur", 1: "permintaan Shift 1", 2: "permintaan Shift 2", 3: "permintaan Shift 3", "!1": "permintaan tidak Shift 1", "!2": "permintaan tidak Shift 2", "!3": "permintaan tidak Shift 3" });

// Can this configuration be made at all? The coverage proof, then a short
// complete search. Used to test a suggestion before it is offered.
export function canBeMade({ config, calendars, history }, { budgetMs = SUGGEST_BUDGET_MS } = {}) {
  try {
    const { input } = prepareMonth({ config, calendars, history });
    return nightCoverageCheck(input).ok && exhaustiveSearch(input, { budgetMs }).status === "found";
  } catch (error) {
    if (error instanceof RosterError) return false;
    throw error;
  }
}

// One temporary helper from outside the team around `date`: the narrowest that
// makes the month possible (nights only, day shifts only, then every shift).
export function helperSuggestion({ config, calendars, history }, date) {
  const { end: monthEnd } = monthBounds(Number(date.slice(0, 4)), Number(date.slice(5, 7)));
  const nextDay = isoDate(addDays(date, 1));
  const nights = nextDay <= monthEnd ? [date, nextDay] : [isoDate(addDays(date, -1)), date];
  const helpers = [
    { shifts: ["3"], from: nights[0], to: nights[1], label: "Shift 3" },
    { shifts: ["1", "2"], from: date, to: date, label: "Shift 1 atau Shift 2" },
    { shifts: ["1", "2", "3"], from: isoDate(addDays(date, -1)), to: nextDay, label: "semua shift" }
  ];
  for (const helper of helpers) {
    const member = { id: "orang-luar-tim", name: "Orang luar tim", gender: "L", eligibleShifts: helper.shifts, activeFrom: helper.from, activeUntil: helper.to };
    if (canBeMade({ config: { ...config, members: [...config.members, member] }, calendars, history })) {
      return `Tambahkan 1 orang luar tim yang bisa ${helper.label} sebagai anggota sementara untuk ${formatPeriode(helper.from, helper.to)} (pilihan 1 di menu, atau isi sheet Anggota dengan Mulai Bergabung dan Terakhir Bekerja).`;
    }
  }
  return null;
}

function suggestWaysOut({ config, calendars, history }, date) {
  const works = (candidate) => canBeMade({ config: candidate, calendars, history });
  const suggestions = [];
  const reach = config.rules.nightBlock.max + config.rules.nightRecoveryOffDays + 1;
  const first = isoDate(addDays(date, -reach));
  const last = isoDate(addDays(date, 1));
  const away = (request) => Math.abs(diffDays(request.from > date ? request.from : (request.to ?? request.from) < date ? request.to ?? request.from : date, date));
  // Sickness cannot be moved, so it is never suggested.
  const nearby = config.requests
    .filter((request) => request.code !== "S" && request.from <= last && (request.to ?? request.from) >= first)
    .sort((left, right) => away(left) - away(right))
    .slice(0, 6);
  const nameOf = (request) => config.members.find((member) => member.id === request.memberId)?.name ?? request.name;
  for (let request of nearby) {
    if (suggestions.length >= 2) break;
    if (!works({ ...config, requests: config.requests.filter((item) => item !== request) })) continue;
    const when = formatPeriode(request.from, request.to ?? request.from);
    request = { ...request, name: nameOf(request) };
    if (request.kind === "Perubahan manual (dikunci)") suggestions.push(`Jangan kunci perubahan manual ${request.name} ${when} (pilihan 3 di menu): tanpa itu roster bisa disusun.`);
    else if (["C", "T"].includes(request.code)) suggestions.push(`Geser atau persingkat ${REQUEST_WORDS[request.code]} ${request.name} ${when}: tanpa itu roster bisa disusun.`);
    else suggestions.push(`Batalkan atau pindahkan ${REQUEST_WORDS[request.code] ?? "permintaan"} ${request.name} ${when}: tanpa itu roster bisa disusun.`);
  }
  const helper = helperSuggestion({ config, calendars, history }, date);
  if (helper) suggestions.push(helper);
  return suggestions;
}

async function buildRoster({ config, calendars, history, onProgress }) {
  const started = Date.now();
  const { nightId, shiftIds, ctx, bounds, horizonEnd, horizonDates, days, members, window, historyCodes, fixed, initialStates, initialQueue, env, publishedDays, variants, input } = prepareMonth({ config, calendars, history });
  const workers = plannedWorkers(variants.length, config.search);
  // A month the coverage proof rules out is reported at once, before any search.
  const proof = nightCoverageCheck(input);
  if (!proof.ok) throw new RosterError(`Roster tidak bisa disusun (sudah dipastikan): ${proof.reason}\n${ADVICE}`, { date: proof.date, proven: true });
  const runAll = async (list, step) => {
    const fractions = list.map(() => 0);
    const progressOf = (index) => (done, total) => {
      fractions[index] = done / Math.max(1, total);
      onProgress?.({ step, done: Math.round(fractions.reduce((sum, value) => sum + value, 0) * 1000), total: list.length * 1000 });
    };
    const size = Math.min(workers, list.length);
    return size > 1
      ? await runInWorkers(input, list, size, progressOf)
      : list.map((variant, index) => {
        try {
          return { ok: true, result: runVariant(input, variant, progressOf(index)) };
        } catch (error) {
          return { ok: false, error };
        }
      });
  };
  const searchStarted = Date.now();
  const outcomes = (await runAll(variants, "search")).map((outcome) => ({ ...outcome, round: 0 }));
  const firstRoundMs = Date.now() - searchStarted;
  // Every attempt dead-ended (very low availability): before saying the month
  // cannot be made, make sure (exhaustive.mjs). Program errors are not dead-ends.
  let lastResort = null;
  if (!outcomes.some((outcome) => outcome.ok)) {
    const deadEnd = outcomes.find((outcome) => outcome.error instanceof RosterError && outcome.error.details?.date)?.error;
    if (!deadEnd) throw outcomes[0].error;
    lastResort = completeSearch(input, deadEnd, config.search.exhaustiveBudgetMs ?? EXHAUSTIVE_BUDGET_MS, onProgress);
    outcomes.push(lastResort);
  }
  let chosenIndex = -1;
  const choose = () => outcomes.forEach((outcome, index) => {
    if (outcome.ok && betterThan(outcome.result, chosenIndex >= 0 ? outcomes[chosenIndex].result : null)) chosenIndex = index;
  });
  choose();
  // Not perfect yet (a serious finding, or someone's work-life score below 65):
  // extra attempts aimed at what is left, up to search.perfectRounds rounds.
  const perfectRounds = variants.length > 1 && !lastResort ? config.search.perfectRounds ?? 2 : 0;
  let rounds = 0;
  let stoppedByTime = false;
  for (let round = 1; round <= perfectRounds && !isPerfect(outcomes[chosenIndex].result); round += 1) {
    const aimed = targetedVariants(outcomes[chosenIndex].result, round);
    if (aimed.length === 0) break;
    // Slow computers (e.g. 2 cores: attempts one by one) skip rounds that would
    // push the whole search past the time budget (6 minutes).
    const budgetMs = config.search.perfectBudgetMs ?? PERFECT_BUDGET_MS;
    if (!roundFits({ elapsedMs: Date.now() - searchStarted, firstRoundMs, firstRoundCount: variants.length, workers: Math.min(workers, variants.length), nextCount: aimed.length, budgetMs })) {
      stoppedByTime = true;
      break;
    }
    rounds = round;
    onProgress?.({ step: "perfect", round, rounds: perfectRounds });
    const extra = await runAll(aimed.map(({ aim, ...variant }) => variant), "perfect-search");
    extra.forEach((outcome, index) => outcomes.push({ ...outcome, round, aim: aimed[index].aim }));
    choose();
  }
  const portfolio = outcomes.map((outcome, index) => (outcome.ok
    ? { variant: index + 1, round: outcome.round, ...(outcome.aim ? { aim: outcome.aim } : {}), score: Math.round(outcome.result.total), serious: outcome.result.serious, wlbLow: outcome.result.wlbLow, wlbTeam: outcome.result.wlbTeam }
    : { variant: index + 1, round: outcome.round, failed: true }));
  const chosen = outcomes[chosenIndex].result;
  // Only best-result mode reviews candidates, so only it can say "perfect".
  const perfect = variants.length < 2 ? null : { reached: isPerfect(chosen), rounds, tried: outcomes.filter((outcome) => outcome.ok).length, remaining: (chosen.findings ?? []).filter((finding) => finding.level === "penting").map((finding) => finding.id), wlbLow: chosen.wlbLow ?? 0, stoppedByTime };
  onProgress?.({ step: "improve" });
  const codes = chosen.codes;
  const nightQueueAfterMonth = chosen.nightQueueAfterMonth;
  const searchScore = chosen.before;
  const localLog = chosen.localLog;
  const final = scoreSchedule({ codes, members, days, initialStates, ctx, config, fixed, env });
  if (!final.valid) throw new RosterError("Terjadi kesalahan program: roster akhir tidak lolos aturan. Hubungi pengelola roster.");

  onProgress?.({ step: "check" });
  const dayInfoByDate = {};
  for (const date of window.dates) dayInfoByDate[date] = { isSpecial: isWeekend(date), isWeekend: isWeekend(date) };
  for (const day of days) dayInfoByDate[day.date] = day;
  const requestsByDate = {};
  days.forEach((day, d) => {
    requestsByDate[day.date] = Object.fromEntries(Object.entries(fixed[d]).filter(([, code]) => code !== "-"));
    for (const [id, codes] of Object.entries(ctx.avoid?.[d] ?? {})) if (requestsByDate[day.date][id] === undefined) requestsByDate[day.date][id] = `!${[...codes].sort().join("")}`;
  });
  const timeline = Object.fromEntries(members.map((member, i) => [member.id, [...(historyCodes[i].length === window.dates.length ? historyCodes[i] : window.dates.map((_, k) => historyCodes[i][k - (window.dates.length - historyCodes[i].length)] ?? "-")), ...codes[i]]]));
  const audit = auditTimeline({
    dates: [...window.dates, ...horizonDates], codesById: timeline, members, shifts: config.shifts, rules: config.rules,
    coverage: config.coverage, dayInfoByDate, requestsByDate, generatedFrom: bounds.start, publishedTo: bounds.end, trainingWindow: config.trainingWindow
  });
  if (!audit.ok) {
    const problems = audit.checks.filter((item) => !item.ok).flatMap((item) => item.pelanggaran.map((violation) => violation.pesan));
    throw new RosterError(`Terjadi kesalahan program: pemeriksaan akhir menemukan pelanggaran.\n- ${problems.slice(0, 8).join("\n- ")}`, { audit });
  }

  const published = publishedDays;
  const { summary, dayRows, quality } = describeCandidate({ ...input, withQuality: true }, codes);
  const nightBlocks = findNightBlocks({ members, days, codes, nightId });
  const changes = config.reference
    ? published.flatMap((day) => members.map((member, i) => ({ member, from: config.reference[member.id]?.[day.date], to: codes[i][day.dayIndex], date: day.date })))
      .filter((item) => item.from !== undefined && item.from !== item.to)
      .map((item) => ({ memberId: item.member.id, name: item.member.name, date: item.date, from: item.from, to: item.to }))
    : [];
  const backups = findBackups({ members, days, codes, initialStates, ctx, fixed, shifts: config.shifts });
  const backupPlan = planBackups({ members, days, timeline, offset: window.dates.length, backups, config });

  const minimalReasons = explainMinimalDays({
    members, days, codes, initialStates, ctx, fixed, dayRows, timeline, dates: [...window.dates, ...horizonDates], offset: window.dates.length, summary
  });

  const requestCount = config.requests.filter((request) => request.to >= bounds.start && request.from <= bounds.end).length;
  const notes = buildNotes({
    members, days, codes, historyDates: window.dates, historyCodes, initialStates, initialQueue, nightBlocks, summary, dayRows,
    config, env, requestCount, nightId, backups, backupPlan, changes, externalBackups: config.externalBackups ?? [], minimalReasons
  });
  if (lastResort) {
    notes.unshift("Bulan ini sangat ketat: pencarian biasa tidak menemukan susunan, jadi program memeriksa semua kemungkinan dan memakai susunan yang memenuhi semua aturan (lalu dirapikan). Polanya bisa berat bagi beberapa orang; bila bisa, kurangi cuti atau permintaan yang bersamaan, atau tambahkan cadangan.");
  }
  const toSchedule = (dayList) => Object.fromEntries(members.map((member, i) => [member.id, Object.fromEntries(dayList.map((day) => [day.date, codes[i][day.dayIndex]]))]));
  const widths = chosen.searchLog.map((item) => item.width);

  return {
    schemaVersion: 3,
    engineVersion: ENGINE_VERSION,
    generatedAt: new Date().toISOString(),
    period: { key: monthKey(config.period.year, config.period.month), year: config.period.year, month: config.period.month, start: bounds.start, end: bounds.end, horizonEnd, lookaheadDays: config.period.lookaheadDays },
    members: members.map(({ id, name, gender, eligibleShifts, dayOnly, activeFrom, activeUntil, row }) => ({ id, name, gender, eligibleShifts, dayOnly, activeFrom, activeUntil, row })),
    shifts: config.shifts,
    trainingWindow: config.trainingWindow,
    settings: { coverage: config.coverage, rules: config.rules, workDaysTarget: Math.round(env.target), targetMode: env.mode, targetBasis: env.basis, targetDetail: env.detail },
    schedule: toSchedule(published),
    horizonSchedule: toSchedule(days),
    history: { key: history?.key ?? null, source: history?.source ?? "none", dates: window.dates, codesById: window.codesById },
    fairness: nightFairness({ members, published, codes, history, nightId, shiftIds, key: monthKey(config.period.year, config.period.month) }),
    wellbeing: workLifeBalance({ members, days: dayRows, schedule: toSchedule(published), memberSummary: summary, settings: { rules: config.rules }, history: { codesById: window.codesById } }),
    days: dayRows,
    memberSummary: summary,
    nightBlocks,
    backups,
    backupPlan,
    quality,
    changes,
    freezeBefore: config.freezeBefore ?? null,
    externalBackups: config.externalBackups ?? [],
    nightQueue: { start: initialQueue, afterMonth: nightQueueAfterMonth },
    requests: config.requests.filter((request) => request.to >= bounds.start && request.from <= bounds.end),
    holidays: published.filter((day) => day.holiday).map((day) => ({ date: day.date, ...day.holiday, isSpecial: day.isSpecial })),
    audit,
    notes,
    search: {
      beamWidthMax: widths.length ? Math.max(...widths) : null,
      beamWidthMin: widths.length ? Math.min(...widths) : null,
      exhaustive: lastResort ? { found: true, ms: lastResort.ms } : null,
      searchScore: Math.round(searchScore),
      finalScore: Math.round(final.total),
      localSwaps: localLog.length,
      localLog,
      portfolio,
      perfect,
      chosenVariant: chosenIndex + 1,
      workers,
      runtimeMs: Date.now() - started
    }
  };
}

// The last resort when every attempt dead-ended (the coverage proof already ran
// before the search): the complete search, giving a valid roster polished like
// any other, or certainty that none exists, or the time limit. Returns an outcome
// like a variant's, or throws a RosterError that keeps the date for the console.
const ADVICE = "Saran: geser salah satu cuti atau permintaan di sekitar tanggal itu, atau tambahkan orang luar tim sebagai anggota sementara (menu Buat Roster menawarkannya).";

function completeSearch(input, deadEnd, budgetMs, onProgress) {
  onProgress?.({ step: "exhaustive", budgetMs });
  const found = exhaustiveSearch(input, { budgetMs });
  if (found.status === "found") {
    return { ok: true, round: 0, ms: found.ms, result: finishCandidate(input, found.codes, { nightQueueAfterMonth: found.nights[input.env.lastPublishedIndex].queue }) };
  }
  const { members, days, fixed, ctx, config } = input;
  const day = days[found.deepest.dayIndex];
  const diagnosis = diagnoseDeadEnd({
    node: found.deepest.node, day, fixedToday: fixed[found.deepest.dayIndex], fixedTomorrow: fixed[found.deepest.dayIndex + 1] ?? {},
    members, ctx: { ...ctx, nightChoices: Infinity }, config,
    memberById: new Map(members.map((member) => [member.id, member])), indexById: new Map(members.map((member, index) => [member.id, index]))
  });
  const reasons = diagnosis.message.split("\n").filter((line) => line.startsWith("- ")).join("\n");
  if (found.status === "impossible") {
    throw new RosterError(
      `Roster tidak bisa disusun (sudah diperiksa semua kemungkinan): tidak ada susunan yang memenuhi semua aturan. Susunan mana pun berhenti paling lambat pada ${formatTanggal(day.date, { denganHari: true })}.\n${reasons}\n${ADVICE}`,
      { date: day.date, proven: true }
    );
  }
  throw new RosterError(
    `${deadEnd.message}\nPemeriksaan semua kemungkinan dihentikan setelah ${Math.round(budgetMs / 60000)} menit tanpa menemukan susunan; kemungkinan besar memang tidak bisa dengan cuti dan permintaan ini.`,
    { ...deadEnd.details }
  );
}

// Runs variants in a small pool of worker threads (one variant per worker).
function runInWorkers(input, variants, size, progressOf) {
  const outcomes = new Array(variants.length);
  let next = 0;
  const runOne = (index) => new Promise((resolve) => {
    const worker = new Worker(new URL("./variant-worker.mjs", import.meta.url), { workerData: { input, variant: variants[index] } });
    const onProgress = progressOf(index);
    let settled = false;
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      outcomes[index] = outcome;
      worker.terminate();
      resolve();
    };
    worker.on("message", (message) => {
      if (message.type === "progress") onProgress(message.done, message.total);
      else if (message.type === "done") finish({ ok: true, result: message.result });
      else if (message.type === "error") {
        const error = message.name === "RosterError" ? new RosterError(message.message, message.details ?? {}) : new Error(message.message);
        finish({ ok: false, error });
      }
    });
    worker.on("error", (error) => finish({ ok: false, error }));
    worker.on("exit", (code) => finish({ ok: false, error: new Error(`Proses pencarian berhenti tiba-tiba (kode ${code}).`) }));
  });
  const lane = async () => {
    while (next < variants.length) await runOne(next++);
  };
  return Promise.all(Array.from({ length: Math.min(size, variants.length) }, lane)).then(() => outcomes);
}
