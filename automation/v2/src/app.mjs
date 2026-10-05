// Admin actions used by the CLI and the double-click menu.
import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { auditTimeline } from "./audit.mjs";
import { addMonths, isWeekend, monthBounds, monthKey as toMonthKey, parseMonthKey } from "./date-utils.mjs";
import { buildDays } from "./days.mjs";
import { DEFAULT_PORTFOLIO } from "./defaults.mjs";
import { generateRoster } from "./engine.mjs";
import { explainFileError, RosterError } from "./errors.mjs";
import { writeRosterWorkbook } from "./excel-export.mjs";
import { resolveHolidays } from "./holiday-calendar.mjs";
import { createInputWorkbook, KINDS_UPGRADE, readInputWorkbook, upgradeInputWorkbook } from "./input-workbook.mjs";
import { formatPeriode, formatTanggal } from "./labels-id.mjs";
import { formatRosterCsv } from "./roster-csv.mjs";
import { buildConfig } from "./settings.mjs";
import { archiveMonth, buildHistory, horizonYears, latestResultMonth, loadMonthCodes, monthFiles, monthLabel, workspacePaths } from "./workspace.mjs";

async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

function relative(paths, file) {
  return path.relative(paths.root, file).split(path.sep).join("/");
}

export async function siapkanData({ root }) {
  const paths = workspacePaths(root);
  if (await exists(paths.inputWorkbook)) {
    // Add Aturan rows introduced since the file was made; if it is open in
    // Excel (Windows lock), try again next time instead of stopping.
    let upgraded = [];
    try {
      upgraded = await upgradeInputWorkbook(paths.inputWorkbook);
    } catch (error) {
      if (!explainFileError(error)) throw error;
    }
    return { created: false, file: paths.inputWorkbook, upgraded };
  }
  await createInputWorkbook(paths.inputWorkbook);
  return { created: true, file: paths.inputWorkbook };
}

const upgradeNote = (labels) => {
  const rules = labels.filter((label) => !label.startsWith(KINDS_UPGRADE));
  const parts = [
    ...(rules.length ? [`baris baru di sheet Aturan: ${rules.map((label) => `"${label}"`).join(", ")} (isinya nilai bawaan; ubah bila perlu)`] : []),
    ...labels.filter((label) => label.startsWith(KINDS_UPGRADE))
  ];
  return `Data Roster.xlsx dilengkapi ${parts.join("; ")}.`;
};

async function readAdvanced(paths) {
  if (!(await exists(paths.advancedSettings))) return {};
  try {
    return JSON.parse(await readFile(paths.advancedSettings, "utf8"));
  } catch {
    throw new RosterError(`File ${relative(paths, paths.advancedSettings)} rusak (bukan JSON yang valid). Perbaiki atau hapus file itu.`);
  }
}

export async function nextMonthKey({ root, today = new Date() }) {
  const latest = await latestResultMonth(workspacePaths(root));
  if (latest) return addMonths(latest, 1);
  return addMonths(toMonthKey(today.getFullYear(), today.getMonth() + 1), 1);
}

// "Cek kesiapan": what must be in place before the next roster can be made, in
// plain Indonesian, so an admin can fix it without help. Levels: "ok",
// "perhatian" (works, but worth knowing), "masalah" (the roster cannot be made).
export async function periksaSistem({ root, now = new Date() }) {
  const paths = workspacePaths(root);
  const items = [];
  const add = (level, text) => items.push({ level, text });
  const major = Number(process.versions.node.split(".")[0]);
  add(major >= 20 ? "ok" : "masalah", major >= 20 ? `Node.js ${process.versions.node}` : `Node.js ${process.versions.node} terlalu lama. Pasang versi LTS terbaru dari https://nodejs.org.`);

  if (!(await exists(paths.inputWorkbook))) add("perhatian", "Data Roster.xlsx belum ada; akan dibuat otomatis saat membuat roster. Setelah itu periksa sheet Anggota.");
  else {
    try {
      const upgraded = await upgradeInputWorkbook(paths.inputWorkbook).catch(() => []);
      const input = await readInputWorkbook(paths.inputWorkbook);
      add("ok", `Data Roster.xlsx terbaca: ${input.members.length} anggota, ${input.requests.length} baris cuti/permintaan.`);
      if (upgraded.length) add("perhatian", upgradeNote(upgraded));
    } catch (error) {
      add("masalah", error instanceof RosterError ? error.message : `Data Roster.xlsx tidak bisa dibaca: ${error.message}`);
    }
  }

  const key = await nextMonthKey({ root, today: now });
  const previousKey = addMonths(key, -1);
  const previous = await loadMonthCodes(paths, previousKey).catch(() => null);
  if (previous) {
    add("ok", `Roster ${monthLabel(previousKey)} ada (sambungan untuk ${monthLabel(key)}).`);
    if (previous.manualChanges?.length) add("perhatian", `Roster ${monthLabel(previousKey)} diubah manual (${previous.manualChanges.length} perubahan); jalankan menu 3 (Cek roster) bila belum.`);
  } else add("masalah", `Roster ${monthLabel(previousKey)} belum ada di folder hasil/${previousKey}, padahal ${monthLabel(key)} melanjutkan darinya. Buat roster ${monthLabel(previousKey)} dulu.`);

  const { year } = parseMonthKey(key);
  for (const holidayYear of [year, year + 1]) {
    const file = path.join(paths.holidaysDir, `ID-${holidayYear}.json`);
    if (!(await exists(file))) {
      add(holidayYear === year ? "perhatian" : "ok", holidayYear === year
        ? `Data hari libur ${holidayYear} belum ada; akan diambil dari internet saat membuat roster. Bila tidak ada internet, buat manual (lihat Panduan bagian 7).`
        : `Data hari libur ${holidayYear} belum ada (belum dibutuhkan).`);
      continue;
    }
    try {
      const data = JSON.parse(await readFile(file, "utf8"));
      const official = data.status === "official-verified";
      add(official ? "ok" : "perhatian", `Data hari libur ${holidayYear}: ${official ? "resmi (sudah dicek)" : "otomatis dari Google, perlu dicek dengan SKB 3 Menteri"}, ${data.days?.length ?? 0} tanggal.`);
    } catch {
      add("masalah", `File pengaturan/hari-libur/ID-${holidayYear}.json rusak. Hapus file itu agar diambil ulang, atau perbaiki.`);
    }
  }

  try {
    await mkdir(paths.resultsDir, { recursive: true });
    const probe = path.join(paths.resultsDir, `.cek-tulis-${process.pid}`);
    await writeFile(probe, "ok");
    await unlink(probe);
    add("ok", "Folder hasil bisa ditulis.");
  } catch (error) {
    add("masalah", `Folder hasil tidak bisa ditulis (${error.code ?? error.message}). Periksa izin folder atau salin folder Roster ke Dokumen.`);
  }
  return { key, label: monthLabel(key), items, ok: items.every((item) => item.level !== "masalah") };
}

// What the admin should confirm before a roster is generated: who is active,
// who joins or leaves, which leave/requests apply, and the holidays.
export async function previewRoster({ root, monthKey, online = true, fetchImpl, now = new Date() }) {
  const paths = workspacePaths(root);
  const prepared = await siapkanData({ root });
  const input = await readInputWorkbook(paths.inputWorkbook);
  const advanced = await readAdvanced(paths);
  const key = monthKey ?? (await nextMonthKey({ root, today: now }));
  const label = monthLabel(key);
  const config = buildConfig({ input, advanced, monthKey: key });
  const { year, month } = parseMonthKey(key);
  const bounds = monthBounds(year, month);
  const inMonth = (date) => date >= bounds.start && date <= bounds.end;
  const members = config.members.map((member) => ({
    name: member.name,
    shifts: member.eligibleShifts.join(", "),
    joining: Boolean(member.activeFrom && inMonth(member.activeFrom)),
    leaving: Boolean(member.activeUntil && inMonth(member.activeUntil)),
    activeFrom: member.activeFrom,
    activeUntil: member.activeUntil
  }));
  const previous = await loadMonthCodes(paths, addMonths(key, -1)).catch(() => null);
  const activeNames = new Set(members.map((member) => member.name.toLowerCase()));
  const notContinuing = previous ? Object.values(previous.names).filter((name) => !activeNames.has(String(name).toLowerCase())) : [];
  const requests = config.requests
    .filter((request) => request.to >= bounds.start && request.from <= bounds.end)
    .map((request) => {
      const from = request.from < bounds.start ? bounds.start : request.from;
      const to = request.to > bounds.end ? bounds.end : request.to;
      const days = Math.round((new Date(`${to}T00:00:00Z`) - new Date(`${from}T00:00:00Z`)) / 86_400_000) + 1;
      return { name: request.name, kind: request.kind, from, to, days, note: request.note ?? "", source: request.source };
    });
  let holidays = [];
  let holidayNotes = [];
  try {
    const resolved = await resolveHolidays({ years: horizonYears(key, 0), directory: paths.holidaysDir, online, fetchImpl, now });
    holidays = resolved.calendars.flatMap((calendar) => calendar.days).filter((day) => inMonth(day.date));
    holidayNotes = resolved.notes;
  } catch (error) {
    if (!(error instanceof RosterError)) throw error;
    holidayNotes = [error.message];
  }
  const lines = [`Periksa data untuk roster ${label} (dari Data Roster.xlsx):`, "", `Anggota aktif (${members.length}):`];
  for (const member of members) {
    const extra = [member.joining ? `mulai ${formatTanggal(member.activeFrom, { pendek: true })}` : "", member.leaving ? `terakhir ${formatTanggal(member.activeUntil, { pendek: true })}` : ""].filter(Boolean).join(", ");
    lines.push(`  • ${member.name} — Shift ${member.shifts}${extra ? ` (${extra})` : ""}`);
  }
  if (notContinuing.length) lines.push(`Tidak ikut lagi dibanding bulan lalu: ${notContinuing.join(", ")}`);
  lines.push("", `Cuti, sakit, training dan permintaan di bulan ini (${requests.length}):`);
  if (requests.length === 0) lines.push("  • Tidak ada");
  for (const request of requests) lines.push(`  • ${request.name} — ${request.kind} ${formatPeriode(request.from, request.to)} (${request.days} hari)${request.note ? ` — ${request.note}` : ""}`);
  if (requests.some((request) => ["Cuti", "Sakit", "Training/Dinas"].includes(request.kind))) lines.push("  Setiap hari cuti, sakit atau training mengurangi target hari kerja orang itu 1 hari.");
  lines.push("", "Tanggal merah dan cuti bersama:");
  if (holidays.length === 0) lines.push("  • Tidak ada");
  for (const day of holidays) lines.push(`  • ${formatTanggal(day.date, { pendek: true })} — ${day.name}${day.tentative ? " (belum pasti)" : ""}`);
  for (const note of holidayNotes) lines.push(`  ! ${note}`);
  lines.push("", ...ruleChoiceLines(config.rules));
  for (const warning of config.warnings) lines.push(`! ${warning}`);
  if (prepared.upgraded?.length) lines.push(`! ${upgradeNote(prepared.upgraded)}`);
  return {
    key, label, members, requests, holidays, lines,
    joining: members.filter((member) => member.joining),
    leaving: members.filter((member) => member.leaving),
    notContinuing
  };
}

// The policy choices of the Aturan sheet in plain words, shown before a roster
// is made so the admin can still change them (menu: "u").
function ruleChoiceLines(rules) {
  const yes = (value) => (value === false ? "Tidak" : "Ya");
  const longSick = rules.nightFreeDaysAfterSick ?? 0;
  const shortSick = rules.nightFreeDaysAfterShortSick ?? longSick;
  const sick = (days) => (days > 0 ? `tanpa Shift 3 selama ${days} hari` : "boleh langsung Shift 3");
  return [
    "Pilihan di sheet Aturan (diubah di Data Roster.xlsx):",
    `  • Target hari kerja: ${typeof rules.workDaysTarget === "number" ? `${rules.workDaysTarget} hari per orang` : "otomatis, pekerjaan dibagi rata (maksimal 5 hari kerja per minggu)"}`,
    `  • Target yang boleh Shift 3: ${rules.workDaysTargetHoursCap && typeof rules.workDaysTarget !== "number" ? `disesuaikan dengan batas ${rules.weeklyHoursLimit ?? 40} jam kerja per minggu (biasanya 1 hari lebih sedikit)` : "sama dengan yang lain"}`,
    `  • Setelah sakit 3 hari atau lebih: ${sick(longSick)}`,
    `  • Setelah sakit 1–2 hari: ${sick(shortSick)}`,
    `  • Blok 3 malam hanya bila terpaksa: ${yes(rules.longNightBlockOnlyIfNeeded)} · Cuti dihitung hari kerja: ${yes(rules.leaveCountsAsWork)}`
  ];
}

export async function buatRoster({ root, monthKey, force = false, online = true, withoutHistory = false, best = false, keep = false, from = null, lockManual = false, onProgress, fetchImpl, now = new Date() }) {
  const paths = workspacePaths(root);
  const prepared = await siapkanData({ root });
  const input = await readInputWorkbook(paths.inputWorkbook);
  const advanced = await readAdvanced(paths);
  const key = monthKey ?? (await nextMonthKey({ root, today: now }));
  const label = monthLabel(key);
  const config = buildConfig({ input, advanced, monthKey: key });
  const warnings = [...config.warnings];
  if (prepared.created) warnings.push("Data Roster.xlsx belum ada, jadi dibuat otomatis dengan tim saat ini. Periksa sheet Anggota.");
  if (prepared.upgraded?.length) warnings.push(upgradeNote(prepared.upgraded));

  if (!force) {
    let existing = null;
    try {
      existing = await loadMonthCodes(paths, key);
    } catch (error) {
      if (!(error instanceof RosterError)) throw error;
      existing = { manualChanges: [{}] };
    }
    if (existing?.approval === "DISETUJUI") {
      throw new RosterError(
        `Roster ${label} sudah DISETUJUI oleh Operations Manager. Membuat ulang akan mengganti roster yang sudah disetujui ` +
          `(versi lama tetap disimpan di hasil/${key}/arsip). Pilih "buat ulang" hanya bila OM memintanya.`,
        { needsConfirmation: true, reason: "approved", manualCount: existing.manualChanges?.length ?? 0 }
      );
    }
    if (existing && existing.manualChanges.length > 0) {
      throw new RosterError(
        `Roster ${label} sudah ada dan sudah diubah manual (${existing.manualChanges.length} perubahan). Membuat ulang akan menggantinya dengan roster baru. ` +
          `Pilih "buat ulang" bila memang ingin mengganti; versi lama tetap disimpan di hasil/${key}/arsip.`,
        { needsConfirmation: true, reason: "edited", manualCount: existing.manualChanges.length }
      );
    }
    if (existing) {
      throw new RosterError(`Roster ${label} sudah ada. Pilih "buat ulang" bila ingin membuatnya lagi (misalnya karena ada cuti baru); versi lama disimpan di hasil/${key}/arsip.`, { needsConfirmation: true, reason: "exists" });
    }
  }
  // A month that already exists is always compared with its current roster
  // (manual swaps included): every changed cell is listed and marked, and days
  // before `from` (default: today) are already worked and stay exactly as they
  // are. `keep` also prefers the old plan (a small update after new leave or
  // sickness); without it the rest of the month is rebuilt freely.
  let current = null;
  try {
    current = await loadMonthCodes(paths, key);
  } catch (error) {
    if (keep || !(error instanceof RosterError)) throw error;
  }
  // "Kunci perubahan manual": the admin's own edits in the roster file become
  // fixed cells (like requests) and the rest of the month is arranged around them.
  // A leave or request in Data Roster.xlsx for the same person and day is newer
  // information than the old edit, so that cell is left to the request.
  let locked = 0;
  let unlocked = 0;
  if (current && lockManual) {
    const requested = (memberId, date) => config.requests.some((request) => request.memberId === memberId && request.from <= date && date <= (request.to ?? request.from));
    for (const change of current.manualChanges ?? []) {
      if (change.to === "-") continue;
      if (requested(change.memberId, change.date)) {
        unlocked += 1;
        continue;
      }
      config.requests.push({ memberId: change.memberId, name: change.name, from: change.date, to: change.date, code: change.to, kind: "Perubahan manual (dikunci)", source: `Perubahan manual ${change.name} ${formatTanggal(change.date, { pendek: true })}` });
      locked += 1;
    }
    if (locked) warnings.push(`${locked} perubahan manual dikunci; sisa jadwal disusun di sekitarnya.`);
    if (unlocked) warnings.push(`${unlocked} perubahan manual tidak dikunci karena di tanggal itu sudah ada cuti atau permintaan baru di Data Roster.xlsx (yang baru dipakai).`);
  }
  if (current) {
    config.reference = Object.fromEntries(Object.keys(current.codesById).map((id) => [id, Object.fromEntries(current.dates.map((date, index) => [date, current.codesById[id][index]]))]));
    config.referenceMode = keep ? "keep" : "rebuild";
    if (!keep) config.weights = { ...config.weights, changeFromReference: 0 };
    const pad = (value) => String(value).padStart(2, "0");
    const start = from ?? `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const { start: monthStart, end: monthEnd } = monthBounds(parseMonthKey(key).year, parseMonthKey(key).month);
    if (start > monthEnd) throw new RosterError(`Roster ${label} sudah lewat semua (tanggal mulai ${start}). Perubahan untuk hari yang sudah lewat dicatat langsung di file roster, lalu jalankan "Cek roster".`);
    config.freezeBefore = start > monthStart ? start : null;
  } else if (keep) warnings.push(`Roster ${label} belum ada, jadi dibuat dari awal.`);
  // Best-result mode: the normal search plus variants; the roster with the fewest
  // serious quality findings (then the best score) wins. When updating, also a
  // lighter and a stronger "keep the old roster" setting.
  if (best && !config.search.portfolio?.length) {
    config.search.portfolio = structuredClone(DEFAULT_PORTFOLIO);
    if (config.reference && keep) config.search.portfolio.push({ weightScale: { changeFromReference: 0.5 } }, { weightScale: { changeFromReference: 2 } });
  }
  const later = await loadMonthCodes(paths, addMonths(key, 1)).catch(() => null);
  if (later) warnings.push(`Roster ${monthLabel(addMonths(key, 1))} sudah ada dan dibuat dari versi lama ${label}. Buat ulang ${monthLabel(addMonths(key, 1))} setelah ini agar sambungannya benar.`);

  const history = withoutHistory ? { key: null, source: "none", dates: [], codesById: {}, manualChanges: [], notes: [] } : await buildHistory(paths, key);
  if (withoutHistory) warnings.push("Dibuat tanpa riwayat bulan lalu: semua orang dianggap baru selesai libur.");
  if (history.manualChanges?.length) warnings.push(`Roster ${monthLabel(history.key)} diubah manual (${history.manualChanges.length} perubahan); roster ini melanjutkan dari versi yang sudah diubah.`);
  const { year, month } = parseMonthKey(key);
  const bounds = monthBounds(year, month);
  const holidays = await resolveHolidays({
    years: horizonYears(key, config.period.lookaheadDays), directory: paths.holidaysDir, online, fetchImpl, now,
    compareFrom: bounds.start, compareTo: bounds.end
  });
  const result = await generateRoster({ config, calendars: holidays.calendars, history, onProgress });
  const historyLabel = history.sourceFile ? `${relative(paths, history.sourceFile)}${history.source === "excel" ? " (Excel, termasuk perubahan manual)" : ""}` : "tanpa riwayat";
  result.inputs = { workbook: "Data Roster.xlsx", warnings, holidayNotes: holidays.notes, holidayDifferences: holidays.differences, history: historyLabel };

  const archived = await archiveMonth(paths, key, now);
  const files = monthFiles(paths, key);
  await mkdir(files.dir, { recursive: true });
  await writeFile(files.json, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  const dates = Object.keys(result.schedule[result.members[0].id]);
  await writeFile(files.csv, formatRosterCsv({
    dates,
    memberIds: result.members.map((member) => member.id),
    names: Object.fromEntries(result.members.map((member) => [member.id, member.name])),
    codesById: Object.fromEntries(result.members.map((member) => [member.id, dates.map((date) => result.schedule[member.id][date])]))
  }), "utf8");
  await writeRosterWorkbook(result, files.excel, {
    holidayCalendars: holidays.calendars, holidayNotes: holidays.notes, holidayDifferences: holidays.differences,
    inputFile: "Data Roster.xlsx", historyLabel, manualChanges: history.manualChanges ?? []
  });
  return { key, label, files, result, archived, warnings, locked, holidayNotes: holidays.notes, holidayDifferences: holidays.differences };
}

// Re-checks a roster Excel that someone edited by hand.
export async function cekRoster({ root, monthKey }) {
  const paths = workspacePaths(root);
  const key = monthKey ?? (await latestResultMonth(paths));
  if (!key) throw new RosterError("Belum ada roster di folder hasil.");
  const label = monthLabel(key);
  const loaded = await loadMonthCodes(paths, key);
  if (!loaded) throw new RosterError(`Roster ${label} tidak ditemukan di folder hasil/${key}.`);
  let setup = loaded.result;
  if (!setup) {
    const config = buildConfig({ input: await readInputWorkbook(paths.inputWorkbook), advanced: await readAdvanced(paths), monthKey: key });
    const holidays = await resolveHolidays({ years: horizonYears(key, 0), directory: paths.holidaysDir, online: false });
    const { days } = buildDays({ ...config, period: { ...config.period, lookaheadDays: 0 } }, holidays.calendars);
    setup = { members: config.members, shifts: config.shifts, trainingWindow: config.trainingWindow, settings: { coverage: config.coverage, rules: config.rules }, days, requests: config.requests };
  }
  let history = { dates: [], codesById: {} };
  const notes = [...(loaded.notes ?? [])];
  try {
    history = await buildHistory(paths, key);
  } catch (error) {
    if (!(error instanceof RosterError)) throw error;
    notes.push("Riwayat bulan sebelumnya tidak ada; sambungan dari bulan lalu tidak diperiksa.");
  }
  const historyDates = history.dates.slice(-21);
  const members = setup.members.filter((member) => loaded.codesById[member.id]);
  const codesById = Object.fromEntries(members.map((member) => {
    const past = (history.codesById[member.id] ?? []).slice(-21);
    const padded = [...historyDates.slice(0, historyDates.length - past.length).map(() => "-"), ...past];
    return [member.id, [...padded, ...loaded.codesById[member.id]]];
  }));
  const dayInfoByDate = {};
  for (const date of historyDates) dayInfoByDate[date] = { isSpecial: isWeekend(date), isWeekend: isWeekend(date) };
  for (const day of setup.days) dayInfoByDate[day.date] = day;
  const requestsByDate = {};
  for (const request of setup.requests ?? []) {
    for (const date of loaded.dates) {
      if (date < request.from || date > request.to) continue;
      const day = (requestsByDate[date] ??= {});
      const before = day[request.memberId];
      // Several "Hindari Shift X" requests on one day combine ("!1" + "!3" = "!13").
      day[request.memberId] = before?.startsWith("!") && request.code.startsWith("!") ? before + request.code.slice(1) : request.code;
    }
  }
  const audit = auditTimeline({
    dates: [...historyDates, ...loaded.dates], codesById, members, shifts: setup.shifts, rules: setup.settings.rules,
    coverage: setup.settings.coverage, dayInfoByDate, requestsByDate, generatedFrom: loaded.dates[0], publishedTo: loaded.dates.at(-1),
    trainingWindow: setup.trainingWindow ?? { start: "08:00", end: "17:00" }
  });
  return { key, label, file: loaded.sourceFile, source: loaded.source, ok: audit.ok, checks: audit.checks, manualChanges: loaded.manualChanges, notes };
}

export async function perbaruiHariLibur({ root, years, online = true, fetchImpl, now = new Date() }) {
  const paths = workspacePaths(root);
  const wanted = years?.length ? years : [now.getFullYear(), now.getFullYear() + 1];
  return resolveHolidays({ years: wanted, directory: paths.holidaysDir, online, fetchImpl, now, refreshDays: 0, compareFrom: `${Math.min(...wanted)}-01-01`, compareTo: `${Math.max(...wanted)}-12-31` });
}
