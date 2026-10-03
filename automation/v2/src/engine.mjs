// generateRoster: from settings + holidays + last month's real codes to a
// validated monthly roster (result JSON, schema 3).
import os from "node:os";
import { Worker } from "node:worker_threads";
import { auditTimeline } from "./audit.mjs";
import { addDays, isoDate, isWeekend, monthKey, parseClock, weekdayIndex } from "./date-utils.mjs";
import { buildDays } from "./days.mjs";
import { RosterError } from "./errors.mjs";
import { deriveMemberState, deriveNightQueue, rollingStats } from "./history.mjs";
import { formatTanggal, KODE_LABEL } from "./labels-id.mjs";
import { overtimeCover } from "./backup-plan.mjs";
import { buildNotes, computeDayRows, computeMemberSummary, findNightBlocks } from "./metrics.mjs";
import { explainMinimalDays } from "./minimal-days.mjs";
import { workLifeBalance } from "./wellbeing.mjs";
import { initialNightState } from "./night-rotation.mjs";
import { fairnessOffsets, makeEnv, scoreSchedule } from "./objective.mjs";
import { buildDayPatterns } from "./patterns.mjs";
import { initialMemberState, isActive, transitionMember } from "./rules.mjs";
import { describeCandidate, runVariant } from "./variant-run.mjs";

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

function buildFixed(config, members, days, nightId, shiftIds) {
  const fixed = days.map(() => ({}));
  const byId = new Map(members.map((member) => [member.id, member]));
  for (const request of config.requests) {
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
    reference: config.reference ?? null
  };
  const { bounds, horizonEnd, horizonDates, days } = buildDays(config, calendars);
  const members = config.members;
  const window = historyWindow(history, bounds.start, members);
  const historyCodes = members.map((member) => window.codesById[member.id]);
  const fixed = buildFixed(config, members, days, nightId, shiftIds);
  checkCapacity(config, members, days, fixed);

  const initialStates = members.map((member, i) => ({
    ...initialMemberState(deriveMemberState(historyCodes[i], ctx), member),
    weekHours: window.dates.length ? weekHoursAtStart(historyCodes[i], bounds.start, ctx.netHours) : 0
  }));
  const nightCapable = members.filter((member) => member.eligibleShifts.includes(nightId)).map((member) => member.id);
  const initialQueue = deriveNightQueue(window.codesById, nightCapable, nightId);
  const initialNight = initialNightState(window.codesById, initialQueue, nightId);
  const patternsPerDay = days.map((day, d) => buildDayPatterns({ day, fixedToday: fixed[d], members, config, nightId }));
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

export async function generateRoster({ config, calendars, history, onProgress }) {
  const started = Date.now();
  const { nightId, shiftIds, ctx, bounds, horizonEnd, horizonDates, days, members, window, historyCodes, fixed, initialStates, initialQueue, env, publishedDays, variants, input } = prepareMonth({ config, calendars, history });
  const cores = typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length;
  const workers = variants.length > 1 && config.search.parallel !== false
    // Measured on an 8-core, 8.6 GB Mac: 1 worker 151 s, 2 80 s, 3 60 s, 5 103 s
    // (memory pressure). So: about 2.8 GB per worker and at most half the cores.
    ? Math.max(1, Math.min(variants.length, config.search.workers ?? Infinity, Math.floor(cores / 2), Math.floor(os.totalmem() / 2.8e9)))
    : 1;
  const fractions = variants.map(() => 0);
  const progressOf = (index) => (done, total) => {
    fractions[index] = done / Math.max(1, total);
    onProgress?.({ step: "search", done: Math.round(fractions.reduce((sum, value) => sum + value, 0) * 1000), total: variants.length * 1000 });
  };
  const outcomes = workers > 1
    ? await runInWorkers(input, variants, workers, progressOf)
    : variants.map((variant, index) => {
      try {
        return { ok: true, result: runVariant(input, variant, progressOf(index)) };
      } catch (error) {
        return { ok: false, error };
      }
    });
  const done = outcomes.filter((outcome) => outcome.ok);
  if (done.length === 0) throw outcomes[0].error;
  const portfolio = outcomes.map((outcome, index) => (outcome.ok ? { variant: index + 1, score: Math.round(outcome.result.total), serious: outcome.result.serious } : { variant: index + 1, failed: true }));
  let chosenIndex = -1;
  outcomes.forEach((outcome, index) => {
    if (!outcome.ok) return;
    const best = chosenIndex >= 0 ? outcomes[chosenIndex].result : null;
    const run = outcome.result;
    if (!best || run.serious < best.serious || (run.serious === best.serious && run.total < best.total)) chosenIndex = index;
  });
  const chosen = outcomes[chosenIndex].result;
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
      beamWidthMax: Math.max(...widths),
      beamWidthMin: Math.min(...widths),
      searchScore: Math.round(searchScore),
      finalScore: Math.round(final.total),
      localSwaps: localLog.length,
      localLog,
      portfolio,
      chosenVariant: chosenIndex + 1,
      workers,
      runtimeMs: Date.now() - started
    }
  };
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
