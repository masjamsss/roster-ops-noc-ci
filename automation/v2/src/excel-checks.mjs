// Double validation (user, 30 Sep): every rule check, the quality review and the
// work-life balance score are written as live Excel formulas over the Roster
// sheet, next to the program's own result. The formulas recompute after manual
// edits; the program's column keeps what it found when the roster was made, so
// "Sama?" shows at a glance whether the roster changed since.
//
// Sheet "Pemeriksaan" (visible) holds the results; sheet "Hitungan" (hidden)
// holds the parameters and one helper grid per person over a timeline of the
// last 10 days of last month, the month, and 6 look-ahead days (last month's
// days carry streaks and night rest across the boundary; the look-ahead
// completes the last Monday-Sunday week, as the program does). Violations are
// counted on the month's days only. Every formula also gets its cached result,
// computed here with the same logic, so the file shows values before Excel
// recalculates. The definitions follow audit.mjs, quality.mjs and wellbeing.mjs;
// keep them in step.
import { WLB_POINTS } from "./wellbeing.mjs";

const HISTORY_DAYS = 10;
const LOOKAHEAD_DAYS = 6;
const FIRST = 2; // the timeline starts in column B of "Hitungan"
const PARAM = { maxWork: 2, nightMax: 3, recovery: 4, minRest: 5, maxOff: 6, sickFree: 7, limit: 8, leaveAsWork: 9, backward: 10, friday: 11 };
const SHIFT_ROW = { 1: 13, 2: 14, 3: 15, T: 16 }; // A code | B start | C end (night +24) | D level | E net hours
const COVER_ROW = { weekdayMin: 18, specialExact: 19, specialMin: 20 }; // B, C, D = Shift 1, 2, 3
const TL = { date: 23, inMonth: 24, weekend: 25, saturday: 26, friday: 27, special: 28, cover: 29, exact: 30, fridayMiss: 31 };
const MEMBER_FIRST_ROW = 34;
const ROWS = ["code", "work", "stretch", "streak", "nightRun", "lastNight", "rest", "offRun", "hours", "offLike", "req", "active",
  "vStreak", "vNightMax", "vRecovery", "vRest", "vBackward", "vEligible", "vOffMax", "vRequest", "vInactive", "vSick",
  "single", "isolated", "switch", "fullBlock", "longBlock", "weeks"];
const R = Object.fromEntries(ROWS.map((name, index) => [name, index]));
const K = ROWS.length;
// Member parameters: G name | H allow 1 | I allow 2 | J allow 3 | K woman | L target | M day-only; row 2 + index.
const MP = { name: 7, allow1: 8, allow2: 9, allow3: 10, woman: 11, target: 12, dayOnly: 13 };
// Work-life balance points: column P (labels in O), rows 2..
const WLB_ROWS = Object.fromEntries(Object.keys(WLB_POINTS).map((key, index) => [key, 2 + index]));

const RULE_VIOLATIONS = {
  "maks-hari-kerja": "vStreak", "maks-malam": "vNightMax", "istirahat-malam": "vRecovery", "istirahat-11-jam": "vRest",
  "shift-mundur": "vBackward", "shift-diizinkan": "vEligible", "maks-libur": "vOffMax", permintaan: "vRequest",
  "tidak-aktif": "vInactive", "setelah-sakit": "vSick"
};
export const QUALITY_CHECKS = [
  ["jam-berat", "penting", "Minggu dengan jam kerja bersih di atas batas + 4 jam"],
  ["akhir-pekan", "penting", "Tidak mendapat libur Sabtu–Minggu penuh"],
  ["minimal", "penting", "Hari kerja hanya 1-1-1 (tanpa cadangan)"],
  ["terbalik", "penting", "Shift 2 lebih banyak dari Shift 1 di hari kerja"],
  ["jumat", "penting", "Jumat tanpa agen perempuan di Shift 1, padahal ada yang libur"],
  ["malam-adil", "perhatian", "Pembagian Shift 3 kurang merata (malam atau blok 3 malam)"],
  ["seimbang-perempuan", "perhatian", "Shift 1 dan Shift 2 belum seimbang (selisih lebih dari 2)"],
  ["sehari-kerja", "perhatian", "Masuk kerja hanya 1 hari di antara libur"],
  ["target", "perhatian", "Hari kerja lebih dari 1 hari di bawah target"]
];
const WLB_COLUMNS = [
  ["nights", "Shift 3 (malam)"], ["longBlocks", "Blok 3 malam"], ["weekendDays", "Kerja Sabtu/ Minggu"], ["fullWeekends", "Libur Sabtu–Minggu penuh"],
  ["fullBlocks", "Hari ke-5 berturut-turut"], ["isolated", "Libur hanya 1 hari"], ["singles", "Masuk hanya 1 hari"],
  ["hoursOver", "Jam di atas batas"], ["hoursHeavy", "Jam di atas batas + 4"], ["switches", "Pindah Shift 1↔2 dalam blok"], ["overTarget", "Hari di atas target"]
];

// Row numbers of the "Pemeriksaan" sheet, shared with the Ringkasan sheet.
export function checksLayout(result) {
  const ruleFirst = 6;
  const ruleTotal = ruleFirst + result.audit.checks.length;
  const qualityHeader = ruleTotal + 4;
  const qualityFirst = qualityHeader + 1;
  const qualityTotal = qualityFirst + QUALITY_CHECKS.length;
  const wlbHeader = qualityTotal + 4;
  const wlbFirst = wlbHeader + 1;
  const wlbTeam = wlbFirst + result.members.length;
  const rules = Object.fromEntries(result.audit.checks.map((check, index) => [check.id, ruleFirst + index]));
  const quality = Object.fromEntries(QUALITY_CHECKS.map(([id], index) => [id, qualityFirst + index]));
  const wlb = Object.fromEntries(result.members.map((member, index) => [member.id, wlbFirst + index]));
  return { ruleFirst, ruleTotal, qualityHeader, qualityFirst, qualityTotal, wlbHeader, wlbFirst, wlbTeam, rules, quality, wlb, lastColumn: 17, perfectText: perfectText(result) };
}

// "Perfect" (perfect.mjs): every rule met, no serious finding, nobody's work-life
// score below 65. The same sentence is built by a formula on the Pemeriksaan sheet.
const PERFECT = "✔ HASIL SEMPURNA: semua aturan terpenuhi, tidak ada temuan penting, tidak ada skor kerja–hidup di bawah 65.";
function perfectText(result) {
  const rulesFailed = result.audit.checks.filter((check) => !check.ok).length;
  const serious = result.quality?.serious ?? 0;
  const low = (result.wellbeing?.members ?? []).filter((item) => item.score !== null && item.score < 65).length;
  return rulesFailed === 0 && serious === 0 && low === 0 ? PERFECT : `Belum sempurna: ${rulesFailed} aturan tidak terpenuhi, ${serious} temuan penting, ${low} orang dengan skor kerja–hidup di bawah 65.`;
}

export function checkSheets(workbook, result, L, ui) {
  const { setCell, columnLetter } = ui;
  const layout = checksLayout(result);
  const members = result.members;
  const rules = result.settings.rules;
  const M = result.days.length;

  // ---------- timeline ----------
  const historyDates = (result.history?.dates ?? []).slice(-HISTORY_DAYS);
  const lookDates = Object.keys(result.horizonSchedule?.[members[0]?.id] ?? {}).filter((date) => date > result.period.end).sort().slice(0, LOOKAHEAD_DAYS);
  const H = historyDates.length;
  const dates = [...historyDates, ...result.days.map((day) => day.date), ...lookDates];
  const T = dates.length;
  const inMonth = (t) => t >= H && t < H + M;
  const monthCols = [H, H + M - 1];
  const col = (t) => columnLetter(FIRST + t);
  const weekdayOf = (date) => new Date(`${date}T00:00:00Z`).getUTCDay();
  const dayInfo = new Map(result.days.map((day) => [day.date, day]));

  const sheet = workbook.addWorksheet("Hitungan");
  sheet.state = "hidden";
  const put = (row, column, value) => {
    sheet.getCell(row, column).value = value;
  };
  const f = (row, column, formula, value) => put(row, column, { formula, result: value });
  put(1, 1, "Hitungan untuk sheet Pemeriksaan (jangan diubah)");

  // ---------- parameters (inputs from Data Roster.xlsx, not results) ----------
  const paramValues = {
    maxWork: rules.maxConsecutiveWorkDays, nightMax: rules.nightBlock.max, recovery: rules.nightRecoveryOffDays, minRest: rules.minimumRestHours,
    maxOff: rules.maxConsecutiveOffDays, sickFree: rules.nightFreeDaysAfterSick ?? 0, limit: rules.weeklyHoursLimit ?? 40,
    leaveAsWork: rules.leaveCountsAsWork === false ? 0 : 1, backward: rules.forbidBackwardShiftWithoutOff === false ? 0 : 1, friday: rules.fridayShift1Female === false ? 0 : 1
  };
  const paramLabels = {
    maxWork: "Maksimal hari kerja berturut-turut", nightMax: "Shift 3 maksimal berturut-turut", recovery: "Libur setelah blok Shift 3", minRest: "Istirahat minimal (jam)",
    maxOff: "Maksimal libur (H) berturut-turut", sickFree: "Hari tanpa Shift 3 setelah sakit", limit: "Batas jam kerja bersih per minggu",
    leaveAsWork: "Cuti dihitung hari kerja (1 = ya)", backward: "Larangan pindah shift mundur (1 = ya)", friday: "Jumat: agen perempuan di Shift 1 (1 = ya)"
  };
  for (const [key, row] of Object.entries(PARAM)) {
    put(row, 1, paramLabels[key]);
    put(row, 2, paramValues[key]);
  }
  const p = (key) => `$B$${PARAM[key]}`;
  const clock = (text) => Number(text.slice(0, 2)) + Number(text.slice(3, 5)) / 60;
  const breakHours = rules.breakHours ?? 1;
  const windows = {};
  for (const shift of result.shifts) {
    const start = clock(shift.start);
    let end = clock(shift.end);
    if (end <= start) end += 24;
    windows[shift.id] = { start, end, level: shift.level, net: Math.max(0, end - start - breakHours) };
  }
  const training = result.trainingWindow ?? { start: "08:00", end: "17:00" };
  windows.T = { start: clock(training.start), end: clock(training.end), level: 0, net: Math.max(0, clock(training.end) - clock(training.start) - breakHours) };
  put(12, 1, "Kode");
  ["Mulai", "Selesai", "Tingkat", "Jam bersih"].forEach((label, index) => put(12, 2 + index, label));
  for (const [code, row] of Object.entries(SHIFT_ROW)) {
    put(row, 1, code);
    put(row, 2, windows[code].start);
    put(row, 3, windows[code].end);
    put(row, 4, windows[code].level);
    put(row, 5, windows[code].net);
  }
  const coverage = result.settings.coverage;
  const coverRows = { weekdayMin: coverage.weekday.minimum, specialExact: coverage.special.preferred, specialMin: coverage.special.minimum };
  for (const [key, row] of Object.entries(COVER_ROW)) {
    put(row, 1, { weekdayMin: "Minimal hari kerja", specialExact: "Tepat Sabtu/Minggu/tanggal merah", specialMin: "Minimal Sabtu/Minggu/tanggal merah" }[key]);
    ["1", "2", "3"].forEach((id, index) => put(row, 2 + index, coverRows[key][id]));
  }
  put(1, MP.name, "Nama");
  ["Boleh S1", "Boleh S2", "Boleh S3", "Perempuan", "Target", "Tanpa S3"].forEach((label, index) => put(1, MP.allow1 + index, label));
  members.forEach((member, index) => {
    const row = 2 + index;
    put(row, MP.name, member.name);
    ["1", "2", "3"].forEach((id, offset) => put(row, MP.allow1 + offset, member.eligibleShifts.includes(id) ? 1 : 0));
    put(row, MP.woman, member.gender === "P" ? 1 : 0);
    put(row, MP.target, result.memberSummary[member.id].workTarget);
    put(row, MP.dayOnly, member.dayOnly ? 1 : 0);
  });
  const mp = (key, index) => `$${columnLetter(MP[key])}$${2 + index}`;
  put(1, 15, "Poin keseimbangan kerja–hidup");
  for (const [key, row] of Object.entries(WLB_ROWS)) {
    put(row, 15, key);
    put(row, 16, WLB_POINTS[key]);
  }
  const pts = (key) => `$P$${WLB_ROWS[key]}`;
  const monthRange = (row) => `$${col(monthCols[0])}$${row}:$${col(monthCols[1])}$${row}`;

  // ---------- timeline rows ----------
  put(TL.date, 1, "Tanggal");
  put(TL.inMonth, 1, "Bulan ini");
  put(TL.weekend, 1, "Sabtu/Minggu");
  put(TL.saturday, 1, "Sabtu");
  put(TL.friday, 1, "Jumat");
  put(TL.special, 1, "Sabtu/Minggu/tanggal merah");
  dates.forEach((date, t) => {
    const column = FIRST + t;
    const weekday = weekdayOf(date);
    put(TL.date, column, date);
    put(TL.inMonth, column, inMonth(t) ? 1 : 0);
    put(TL.weekend, column, weekday === 0 || weekday === 6 ? 1 : 0);
    put(TL.saturday, column, weekday === 6 ? 1 : 0);
    put(TL.friday, column, weekday === 5 ? 1 : 0);
    put(TL.special, column, dayInfo.get(date)?.isSpecial ? 1 : 0);
  });

  // ---------- per-person grids ----------
  const grids = members.map((member, m) => {
    const base = MEMBER_FIRST_ROW + m * K;
    const row = (name) => base + R[name];
    const at = (name, t) => `${col(t)}${row(name)}`;
    ROWS.forEach((name) => put(row(name), 1, `${member.name} · ${name}`));
    const pastCodes = (result.history?.codesById?.[member.id] ?? []).slice(-HISTORY_DAYS);
    const past = historyDates.map((_, i) => pastCodes[i - (historyDates.length - pastCodes.length)] ?? "-");
    const codes = [...past, ...result.days.map((day) => result.schedule[member.id][day.date]), ...lookDates.map((date) => result.horizonSchedule[member.id][date])];
    const requested = {};
    for (const request of result.requests ?? []) {
      if (request.memberId !== member.id) continue;
      for (const date of result.days.map((day) => day.date)) if (date >= request.from && date <= request.to) requested[date] = request.code;
    }
    const activeOn = (date) => (!member.activeFrom || date >= member.activeFrom) && (!member.activeUntil || date <= member.activeUntil);
    const g = Object.fromEntries(ROWS.map((name) => [name, new Array(T).fill(0)]));
    const W = (code) => (["1", "2", "3", "T"].includes(code) ? 1 : 0);
    const levelOf = (code) => (["1", "2", "3"].includes(code) ? windows[code].level : 0);
    const levelFormula = (ref) => `IFERROR(INDEX($D$13:$D$15,MATCH(${ref},$A$13:$A$15,0)),0)`;
    const startFormula = (ref) => `INDEX($B$13:$B$16,MATCH(${ref},$A$13:$A$16,0))`;
    const endFormula = (ref) => `INDEX($C$13:$C$16,MATCH(${ref},$A$13:$A$16,0))`;
    const rosterRow = L.firstMemberRow + m;
    // Work flags first: the single-day checks look at the next day too.
    const work = codes.map(W);

    for (let t = 0; t < T; t += 1) {
      const column = FIRST + t;
      const code = codes[t];
      const date = dates[t];
      const prev = t > 0 ? (name) => at(name, t - 1) : null;
      const c = at("code", t);
      // code
      if (inMonth(t)) f(row("code"), column, `UPPER(TRIM(Roster!${columnLetter(L.firstDayColumn + t - H)}${rosterRow}&""))`, code);
      else put(row("code"), column, code);
      g.code[t] = code;
      // work, stretch, streak, night run, last work was night, rest since work, off run
      g.work[t] = W(code);
      f(row("work"), column, `IF(OR(${c}="1",${c}="2",${c}="3",${c}="T"),1,0)`, g.work[t]);
      g.stretch[t] = g.work[t] || (code === "C" && paramValues.leaveAsWork) ? 1 : 0;
      f(row("stretch"), column, `IF(OR(${at("work", t)}=1,AND(${c}="C",${p("leaveAsWork")}=1)),1,0)`, g.stretch[t]);
      g.streak[t] = g.stretch[t] ? (t > 0 ? g.streak[t - 1] : 0) + 1 : 0;
      f(row("streak"), column, t > 0 ? `IF(${at("stretch", t)}=1,${prev("streak")}+1,0)` : `IF(${at("stretch", t)}=1,1,0)`, g.streak[t]);
      g.nightRun[t] = code === "3" ? (t > 0 ? g.nightRun[t - 1] : 0) + 1 : 0;
      f(row("nightRun"), column, t > 0 ? `IF(${c}="3",${prev("nightRun")}+1,0)` : `IF(${c}="3",1,0)`, g.nightRun[t]);
      g.lastNight[t] = g.work[t] ? (code === "3" ? 1 : 0) : t > 0 ? g.lastNight[t - 1] : 0;
      f(row("lastNight"), column, `IF(${at("work", t)}=1,IF(${c}="3",1,0),${t > 0 ? prev("lastNight") : 0})`, g.lastNight[t]);
      g.rest[t] = g.work[t] ? 0 : t === 0 ? 9 : code === "C" && paramValues.leaveAsWork ? g.rest[t - 1] : g.rest[t - 1] + 1;
      f(row("rest"), column, t > 0 ? `IF(${at("work", t)}=1,0,IF(AND(${c}="C",${p("leaveAsWork")}=1),${prev("rest")},${prev("rest")}+1))` : `IF(${at("work", t)}=1,0,9)`, g.rest[t]);
      g.offRun[t] = code === "H" ? (t > 0 ? g.offRun[t - 1] : 0) + 1 : 0;
      f(row("offRun"), column, t > 0 ? `IF(${c}="H",${prev("offRun")}+1,0)` : `IF(${c}="H",1,0)`, g.offRun[t]);
      g.hours[t] = W(code) ? windows[code].net : 0;
      f(row("hours"), column, `IF(${at("work", t)}=1,INDEX($E$13:$E$16,MATCH(${c},$A$13:$A$16,0)),0)`, g.hours[t]);
      g.offLike[t] = ["H", "C", "S"].includes(code) ? 1 : 0;
      f(row("offLike"), column, `IF(OR(${c}="H",${c}="C",${c}="S"),1,0)`, g.offLike[t]);
      g.req[t] = inMonth(t) ? requested[date] ?? "" : "";
      put(row("req"), column, g.req[t]);
      g.active[t] = activeOn(date) ? 1 : 0;
      put(row("active"), column, g.active[t]);
      if (!inMonth(t)) continue;

      // violations, month days only
      const pc = t > 0 ? codes[t - 1] : "-";
      const r = g.req[t];
      const v = (name, value, formula) => {
        g[name][t] = value;
        f(row(name), column, formula, value);
      };
      v("vStreak", g.work[t] && g.streak[t] > paramValues.maxWork ? 1 : 0, `IF(AND(${at("work", t)}=1,${at("streak", t)}>${p("maxWork")}),1,0)`);
      v("vNightMax", g.nightRun[t] > paramValues.nightMax ? 1 : 0, `IF(${at("nightRun", t)}>${p("nightMax")},1,0)`);
      const recovery = t > 0 && g.work[t] && !(code === "3" && pc === "3") && g.lastNight[t - 1] === 1 && g.rest[t - 1] < paramValues.recovery ? 1 : 0;
      v("vRecovery", recovery, t > 0 ? `IF(AND(${at("work", t)}=1,NOT(AND(${c}="3",${prev("code")}="3")),${prev("lastNight")}=1,${prev("rest")}<${p("recovery")}),1,0)` : "0");
      const restHours = t > 0 && g.work[t] && g.work[t - 1] ? 24 + windows[code].start - windows[pc].end : 99;
      v("vRest", restHours < paramValues.minRest ? 1 : 0, t > 0 ? `IF(AND(${at("work", t)}=1,${prev("work")}=1),IF(24+${startFormula(c)}-${endFormula(prev("code"))}<${p("minRest")},1,0),0)` : "0");
      const backward = paramValues.backward && t > 0 && levelOf(code) > 0 && levelOf(pc) > 0 && levelOf(code) < levelOf(pc) ? 1 : 0;
      v("vBackward", backward, t > 0 ? `IF(AND(${p("backward")}=1,${levelFormula(c)}>0,${levelFormula(prev("code"))}>0,${levelFormula(c)}<${levelFormula(prev("code"))}),1,0)` : "0");
      const eligible = ["1", "2", "3"].includes(code) && !member.eligibleShifts.includes(code) ? 1 : 0;
      v("vEligible", eligible, `IF(OR(AND(${c}="1",${mp("allow1", m)}=0),AND(${c}="2",${mp("allow2", m)}=0),AND(${c}="3",${mp("allow3", m)}=0)),1,0)`);
      v("vOffMax", code === "H" && g.offRun[t] > paramValues.maxOff && r !== "H" ? 1 : 0, `IF(AND(${c}="H",${at("offRun", t)}>${p("maxOff")},${at("req", t)}<>"H"),1,0)`);
      v("vRequest", r !== "" && r !== code ? 1 : 0, `IF(AND(${at("req", t)}<>"",${at("req", t)}<>${c}),1,0)`);
      v("vInactive", (!g.active[t] && code !== "-") || (g.active[t] && code === "-") ? 1 : 0, `IF(OR(AND(${at("active", t)}=0,${c}<>"-"),AND(${at("active", t)}=1,${c}="-")),1,0)`);
      const from = Math.max(0, t - paramValues.sickFree);
      const sick = paramValues.sickFree > 0 && code === "3" && r !== "3" && codes.slice(from, t).includes("S") ? 1 : 0;
      v("vSick", sick, paramValues.sickFree > 0 && t > 0 ? `IF(AND(${p("sickFree")}>0,${c}="3",${at("req", t)}<>"3",COUNTIF(${col(from)}${row("code")}:${col(t - 1)}${row("code")},"S")>0),1,0)` : "0");
      // work-life balance and quality counts (inside the month, not its first or last day for singles)
      const inside = t > H && t < H + M - 1;
      v("single", inside && work[t] && !work[t - 1] && !work[t + 1] ? 1 : 0, inside ? `IF(AND(${at("work", t)}=1,${prev("work")}=0,${at("work", t + 1)}=0),1,0)` : "0");
      v("isolated", inside && code === "H" && work[t - 1] && work[t + 1] ? 1 : 0, inside ? `IF(AND(${c}="H",${prev("work")}=1,${at("work", t + 1)}=1),1,0)` : "0");
      const day12 = (x) => x === "1" || x === "2";
      v("switch", t > H && day12(code) && day12(pc) && code !== pc ? 1 : 0, t > H ? `IF(AND(OR(${c}="1",${c}="2"),OR(${prev("code")}="1",${prev("code")}="2"),${c}<>${prev("code")}),1,0)` : "0");
      v("fullBlock", g.stretch[t] && g.streak[t] === paramValues.maxWork ? 1 : 0, `IF(AND(${at("stretch", t)}=1,${at("streak", t)}=${p("maxWork")}),1,0)`);
      v("longBlock", g.nightRun[t] === 3 ? 1 : 0, `IF(${at("nightRun", t)}=3,1,0)`);
    }

    // Monday-Sunday weeks touching the month (the first starts last month, the last ends next month).
    const weekStarts = (result.memberSummary[member.id].weeklyHours ?? []).map((week) => week.weekStart);
    const weeks = weekStarts.map((start, w) => {
      const from = dates.indexOf(start);
      const first = from >= 0 ? from : 0;
      let last = first;
      while (last + 1 < T && last + 1 - first < 7 && weekdayOf(dates[last + 1]) !== 1) last += 1;
      const hours = g.hours.slice(first, last + 1).reduce((sum, value) => sum + value, 0);
      f(row("weeks"), FIRST + w, `SUM(${col(first)}${row("hours")}:${col(last)}${row("hours")})`, hours);
      return hours;
    });
    return { base, row, codes, g, weeks, weekCount: weekStarts.length };
  });

  // ---------- day checks (coverage, special days, Friday) ----------
  put(TL.cover, 1, "Shift kurang dari minimal");
  put(TL.exact, 1, "Hari khusus tidak tepat");
  put(TL.fridayMiss, 1, "Jumat tanpa perempuan di Shift 1");
  const countRef = (offset, t) => `Roster!${columnLetter(L.firstDayColumn + t - H)}${L.countRow + offset}`;
  const womenRange = `$${columnLetter(MP.woman)}$2:$${columnLetter(MP.woman)}$${1 + members.length}`;
  const dayCells = { cover: [], exact: [], fridayMiss: [] };
  for (let t = H; t < H + M; t += 1) {
    const column = FIRST + t;
    const day = result.days[t - H];
    const counts = ["1", "2", "3"].map((id) => day.counts[id] ?? 0);
    const minimum = day.isSpecial ? coverRows.specialMin : coverRows.weekdayMin;
    const cover = ["1", "2", "3"].some((id, i) => counts[i] < minimum[id]) ? 1 : 0;
    const special = `${col(t)}$${TL.special}`;
    const below = (row) => ["1", "2", "3"].map((_, i) => `${countRef(i, t)}<$${columnLetter(2 + i)}$${row}`).join(",");
    f(TL.cover, column, `IF(${special}=1,IF(OR(${below(COVER_ROW.specialMin)}),1,0),IF(OR(${below(COVER_ROW.weekdayMin)}),1,0))`, cover);
    const exact = day.isSpecial && ["1", "2", "3"].some((id, i) => counts[i] !== coverRows.specialExact[id]) ? 1 : 0;
    f(TL.exact, column, `IF(${special}=1,IF(OR(${["1", "2", "3"].map((_, i) => `${countRef(i, t)}<>$${columnLetter(2 + i)}$${COVER_ROW.specialExact}`).join(",")}),1,0),0)`, exact);
    const women = members.map((member, m) => (member.gender === "P" ? m : -1)).filter((m) => m >= 0);
    const womenCodes = women.map((m) => grids[m].codes[t]);
    const miss = paramValues.friday && weekdayOf(dates[t]) === 5 && women.length > 0 && !womenCodes.includes("1") && womenCodes.includes("H") ? 1 : 0;
    const rosterColumn = columnLetter(L.firstDayColumn + t - H);
    const rosterRange = `Roster!${rosterColumn}$${L.firstMemberRow}:${rosterColumn}$${L.lastMemberRow}`;
    f(TL.fridayMiss, column, `IF(AND(${p("friday")}=1,${col(t)}$${TL.friday}=1,SUMPRODUCT(${womenRange}*(UPPER(TRIM(${rosterRange}&""))="1"))=0,SUMPRODUCT(${womenRange}*(UPPER(TRIM(${rosterRange}&""))="H"))>0),1,0)`, miss);
    dayCells.cover.push(cover);
    dayCells.exact.push(exact);
    dayCells.fridayMiss.push(miss);
  }

  return { layout, grids, dayCells, monthRange, pts, p, mp, dates, H, M, T, col, paramValues, sheetName: "Hitungan" };
}

// The visible "Pemeriksaan" sheet: results side by side (Excel formulas and the program).
export function checksSheet(workbook, result, L, ui, calc) {
  const { setCell, title, heading, headerCells, paragraph, C } = ui;
  const { layout, grids, dayCells, monthRange, pts, p, mp, M, H } = calc;
  const members = result.members;
  const sheet = workbook.addWorksheet("Pemeriksaan", { pageSetup: { orientation: "landscape", paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
  [5, 14, 12, 12, 11, 11, 11, 11, 11, 11, 11, 11, 11, 10, 14, 10, 11].forEach((width, index) => (sheet.getColumn(index + 1).width = width));
  title(sheet, "PEMERIKSAAN ROSTER (dihitung ulang oleh Excel)",
    "Setiap angka di sheet ini adalah rumus Excel yang membaca sheet Roster, jadi ikut berubah bila roster diubah manual. Kolom \"program\" = hasil pemeriksaan program saat roster dibuat. Bila keduanya berbeda, roster sudah diubah sejak dibuat: jalankan Buat Roster → menu 3 (Cek roster).", layout.lastColumn);
  const sumRows = (name) => grids.map((grid) => `SUM(Hitungan!${monthRange(grid.row(name)).replaceAll("$", "")})`).join("+");
  const sumValues = (name) => grids.reduce((sum, grid) => sum + grid.g[name].reduce((a, b) => a + b, 0), 0);
  const okText = "✔ Terpenuhi";

  // ---------- perfect state (formula) ----------
  sheet.mergeCells(3, 1, 3, layout.lastColumn);
  const low = `COUNTIF(O${layout.wlbFirst}:O${layout.wlbTeam - 1},"Perlu perhatian")`;
  setCell(sheet.getCell(3, 1), {
    formula: `IF(AND(E${layout.ruleTotal}=0,F${layout.qualityTotal}=0,${low}=0),"${PERFECT}","Belum sempurna: "&E${layout.ruleTotal}&" aturan tidak terpenuhi, "&F${layout.qualityTotal}&" temuan penting, "&${low}&" orang dengan skor kerja–hidup di bawah 65.")`,
    result: layout.perfectText
  }, { bold: true, align: "left" });
  sheet.addConditionalFormatting({
    ref: "A3",
    rules: [
      { type: "expression", priority: 20, formulae: ['LEFT($A$3,1)="✔"'], style: { font: { color: { argb: C.okText }, bold: true }, fill: { type: "pattern", pattern: "solid", bgColor: { argb: C.okFill } } } },
      { type: "expression", priority: 21, formulae: ['LEFT($A$3,1)<>"✔"'], style: { font: { color: { argb: C.warnText }, bold: true }, fill: { type: "pattern", pattern: "solid", bgColor: { argb: C.warnFill } } } }
    ]
  });

  // ---------- rules ----------
  heading(sheet, 4, "Aturan wajib", layout.lastColumn);
  sheet.mergeCells(5, 2, 5, 4);
  ["No", "Aturan", null, null, "Pelanggaran (hari, Excel)", "Hasil (Excel)", "Hasil program", "Sama?"].forEach((label, index) => label && (sheet.getCell(5, index + 1).value = label));
  headerCells(sheet.getRow(5), [1, 2, 5, 6, 7, 8]);
  sheet.getRow(5).height = 30;
  const ruleCounts = [];
  result.audit.checks.forEach((check, index) => {
    const row = layout.rules[check.id];
    sheet.mergeCells(row, 2, row, 4);
    setCell(sheet.getCell(row, 1), index + 1, { color: C.note });
    setCell(sheet.getCell(row, 2), check.judul, { align: "left", wrap: true, size: 9 });
    let formula;
    let value;
    if (check.id === "cakupan" || check.id === "hari-khusus") {
      const dayRow = check.id === "cakupan" ? TL.cover : TL.exact;
      formula = `SUM(Hitungan!${monthRange(dayRow).replaceAll("$", "")})`;
      value = (check.id === "cakupan" ? dayCells.cover : dayCells.exact).reduce((a, b) => a + b, 0);
    } else {
      const name = RULE_VIOLATIONS[check.id];
      formula = name ? sumRows(name) : "0";
      value = name ? sumValues(name) : 0;
    }
    ruleCounts.push(value);
    setCell(sheet.getCell(row, 5), { formula, result: value }, { bold: true });
    const excel = value === 0 ? okText : `✖ Tidak (${value})`;
    setCell(sheet.getCell(row, 6), { formula: `IF(E${row}=0,"${okText}","✖ Tidak ("&E${row}&")")`, result: excel }, { bold: true });
    setCell(sheet.getCell(row, 7), check.ok ? okText : `✖ Tidak (${check.pelanggaran.length})`, { color: C.note });
    setCell(sheet.getCell(row, 8), { formula: `IF((E${row}=0)=(LEFT(G${row},1)="✔"),"✔ Sama","✖ Berbeda")`, result: (value === 0) === check.ok ? "✔ Sama" : "✖ Berbeda" }, { bold: true });
    sheet.getRow(row).height = Math.max(18, 12 * Math.ceil(check.judul.length / 45));
  });
  // Totals from the values themselves (exceljs does not read back a cached 0).
  const failedValue = ruleCounts.filter((count) => count > 0).length;
  sheet.mergeCells(layout.ruleTotal, 2, layout.ruleTotal, 4);
  setCell(sheet.getCell(layout.ruleTotal, 2), "Aturan yang tidak terpenuhi (Excel)", { bold: true, align: "left" });
  setCell(sheet.getCell(layout.ruleTotal, 5), { formula: `COUNTIF(E${layout.ruleFirst}:E${layout.ruleTotal - 1},">0")`, result: failedValue }, { bold: true });

  // ---------- quality ----------
  heading(sheet, layout.qualityHeader - 1, "Pemeriksaan kualitas", layout.lastColumn);
  const qh = layout.qualityHeader;
  sheet.mergeCells(qh, 2, qh, 4);
  ["No", "Temuan", null, null, "Tingkat", "Jumlah (Excel)", "Jumlah program", "Sama?"].forEach((label, index) => label && (sheet.getCell(qh, index + 1).value = label));
  headerCells(sheet.getRow(qh), [1, 2, 5, 6, 7, 8]);
  const programCount = (id) => result.quality?.findings?.find((finding) => finding.id === id)?.count ?? 0;
  const status = `Roster!$${ui.columnLetter(L.firstDayColumn)}$${L.statusRow}:$${ui.columnLetter(L.lastDayColumn)}$${L.statusRow}`;
  const special = `Roster!$${ui.columnLetter(L.firstDayColumn)}$${L.specialRow}:$${ui.columnLetter(L.lastDayColumn)}$${L.specialRow}`;
  const countRange = (offset) => `Roster!$${ui.columnLetter(L.firstDayColumn)}$${L.countRow + offset}:$${ui.columnLetter(L.lastDayColumn)}$${L.countRow + offset}`;
  // Per-person values for the quality and work-life balance formulas (Excel side).
  const person = members.map((member, m) => {
    const grid = grids[m];
    const month = grid.codes.slice(H, H + M);
    const codeRange = `Hitungan!${monthRange(grid.row("code")).replaceAll("$", "")}`;
    const count = (code) => month.filter((item) => item === code).length;
    const available = M - count("C") - count("S") - count("T") - count("-");
    const availableF = `(${M}-COUNTIF(${codeRange},"C")-COUNTIF(${codeRange},"S")-COUNTIF(${codeRange},"T")-COUNTIF(${codeRange},"-"))`;
    const nights = count("3");
    const workDays = count("1") + count("2") + count("3");
    const s1 = count("1");
    const s2 = count("2");
    const weekRange = grid.weekCount ? `Hitungan!B${grid.row("weeks")}:${calc.col(grid.weekCount - 1)}${grid.row("weeks")}` : null;
    // Full weekends off: Saturday and Sunday both H, C or S, with the Sunday in the month.
    let fullWeekends = 0;
    const pairs = [];
    for (let t = Math.max(0, H - 1); t < H + M - 1; t += 1) {
      if (calc.dates[t] && new Date(`${calc.dates[t]}T00:00:00Z`).getUTCDay() === 6 && t + 1 >= H) {
        pairs.push(t);
        if (grid.g.offLike[t] && grid.g.offLike[t + 1]) fullWeekends += 1;
      }
    }
    const fullWeekendsF = pairs.length ? pairs.map((t) => `Hitungan!${calc.col(t)}${grid.row("offLike")}*Hitungan!${calc.col(t + 1)}${grid.row("offLike")}`).join("+") : "0";
    const sumOf = (name) => grid.g[name].slice(H, H + M).reduce((a, b) => a + b, 0);
    const sumF = (name) => `SUM(Hitungan!${monthRange(grid.row(name)).replaceAll("$", "")})`;
    const limit = calc.paramValues.limit;
    return {
      member, available, availableF, nights, nightsF: `COUNTIF(${codeRange},"3")`, workDays, workDaysF: `(COUNTIF(${codeRange},"1")+COUNTIF(${codeRange},"2")+COUNTIF(${codeRange},"3"))`,
      s1, s2, s1F: `COUNTIF(${codeRange},"1")`, s2F: `COUNTIF(${codeRange},"2")`, fullWeekends, fullWeekendsF,
      longBlocks: sumOf("longBlock"), longBlocksF: sumF("longBlock"), singles: sumOf("single"), singlesF: sumF("single"),
      isolated: sumOf("isolated"), isolatedF: sumF("isolated"), switches: sumOf("switch"), switchesF: sumF("switch"), fullBlocks: sumOf("fullBlock"), fullBlocksF: sumF("fullBlock"),
      weekendDays: month.filter((code, i) => ["1", "2", "3"].includes(code) && [0, 6].includes(new Date(`${calc.dates[H + i]}T00:00:00Z`).getUTCDay())).length,
      weekendDaysF: `SUMPRODUCT(Hitungan!${monthRange(TL.weekend).replaceAll("$", "")}*((${codeRange}="1")+(${codeRange}="2")+(${codeRange}="3")))`,
      hoursOver: grid.weeks.reduce((sum, hours) => sum + Math.max(0, hours - limit), 0),
      hoursOverF: weekRange ? `SUMPRODUCT((${weekRange}>${p("limit").replace("$B$", "Hitungan!$B$")})*(${weekRange}-${p("limit").replace("$B$", "Hitungan!$B$")}))` : "0",
      hoursHeavy: grid.weeks.reduce((sum, hours) => sum + Math.max(0, hours - limit - 4), 0),
      hoursHeavyF: weekRange ? `SUMPRODUCT((${weekRange}>${p("limit").replace("$B$", "Hitungan!$B$")}+4)*(${weekRange}-${p("limit").replace("$B$", "Hitungan!$B$")}-4))` : "0",
      heavyWeeks: grid.weeks.filter((hours) => hours > limit + 4).length,
      heavyWeeksF: weekRange ? `COUNTIF(${weekRange},">"&(${p("limit").replace("$B$", "Hitungan!$B$")}+4))` : "0",
      target: result.memberSummary[member.id].workTarget, targetF: mp("target", m).replace("$", "Hitungan!$")
    };
  });
  const present = (item) => item.available >= M / 2;
  const presentF = (item) => `${item.availableF}>=${M}/2`;
  const nightMen = person.filter((item) => !item.member.dayOnly);
  const scaled = (item) => (item.nights * M) / Math.max(1, item.available);
  const menPresent = nightMen.filter(present);
  const spreadN = menPresent.length > 1 ? Math.max(...menPresent.map(scaled)) - Math.min(...menPresent.map(scaled)) : 0;
  const spreadL = menPresent.length > 1 ? Math.max(...menPresent.map((item) => item.longBlocks)) - Math.min(...menPresent.map((item) => item.longBlocks)) : 0;
  // Per-man values in cells (MAX/MIN over a range skip ""; "" typed into MAX is an error).
  const hitungan = workbook.getWorksheet("Hitungan");
  hitungan.getCell(1, 18).value = "Malam per bulan (hadir)";
  hitungan.getCell(1, 19).value = "Blok 3 malam (hadir)";
  person.forEach((item, m) => {
    const counted = !item.member.dayOnly && present(item);
    hitungan.getCell(2 + m, 18).value = { formula: `IF(AND(${mp("dayOnly", m)}=0,${presentF(item)}),${item.nightsF}*${M}/MAX(1,${item.availableF}),"")`, result: counted ? scaled(item) : "" };
    hitungan.getCell(2 + m, 19).value = { formula: `IF(AND(${mp("dayOnly", m)}=0,${presentF(item)}),${item.longBlocksF},"")`, result: counted ? item.longBlocks : "" };
  });
  const lastPerson = 1 + members.length;
  const nightsRange = `Hitungan!$R$2:$R$${lastPerson}`;
  const longRange = `Hitungan!$S$2:$S$${lastPerson}`;
  const qualityRows = {
    "jam-berat": [person.map((item) => item.heavyWeeksF).join("+"), person.reduce((sum, item) => sum + item.heavyWeeks, 0)],
    "akhir-pekan": [person.map((item) => `IF(AND(${presentF(item)},${item.fullWeekendsF}=0),1,0)`).join("+"), person.filter((item) => present(item) && item.fullWeekends === 0).length],
    minimal: [`COUNTIF(${status},"MINIMAL")`, result.days.filter((day) => day.status === "MINIMAL").length],
    terbalik: [`SUMPRODUCT((${special}=0)*(${countRange(0)}<${countRange(1)}))`, result.days.filter((day) => !day.isSpecial && day.counts["1"] < day.counts["2"]).length],
    jumat: [`SUM(Hitungan!${monthRange(TL.fridayMiss).replaceAll("$", "")})`, dayCells.fridayMiss.reduce((a, b) => a + b, 0)],
    "malam-adil": [
      `IF(AND(COUNT(${nightsRange})>1,OR(MAX(${nightsRange})-MIN(${nightsRange})>=3,MAX(${longRange})-MIN(${longRange})>=2)),COUNT(${nightsRange}),0)`,
      menPresent.length > 1 && (spreadN >= 3 || spreadL >= 2) ? menPresent.length : 0
    ],
    "seimbang-perempuan": [person.filter((item) => item.member.dayOnly).map((item) => `IF(ABS(${item.s1F}-${item.s2F})>2,1,0)`).join("+") || "0", person.filter((item) => item.member.dayOnly && Math.abs(item.s1 - item.s2) > 2).length],
    "sehari-kerja": [person.map((item) => item.singlesF).join("+"), person.reduce((sum, item) => sum + item.singles, 0)],
    target: [person.map((item) => `IF(AND(${presentF(item)},${item.workDaysF}<${item.targetF}-1),1,0)`).join("+"), person.filter((item) => present(item) && item.workDays < item.target - 1).length]
  };
  QUALITY_CHECKS.forEach(([id, level, label], index) => {
    const row = layout.quality[id];
    sheet.mergeCells(row, 2, row, 4);
    setCell(sheet.getCell(row, 1), index + 1, { color: C.note });
    setCell(sheet.getCell(row, 2), label, { align: "left", wrap: true, size: 9 });
    setCell(sheet.getCell(row, 5), level === "penting" ? "Penting" : "Perhatian", { color: level === "penting" ? C.warnText : C.note, bold: level === "penting" });
    const [formula, value] = qualityRows[id];
    setCell(sheet.getCell(row, 6), { formula, result: value }, { bold: true });
    setCell(sheet.getCell(row, 7), programCount(id), { color: C.note });
    setCell(sheet.getCell(row, 8), { formula: `IF((F${row}>0)=(G${row}>0),"✔ Sama","✖ Berbeda")`, result: (value > 0) === (programCount(id) > 0) ? "✔ Sama" : "✖ Berbeda" }, { bold: true });
    sheet.getRow(row).height = Math.max(18, 12 * Math.ceil(label.length / 45));
  });
  const penting = QUALITY_CHECKS.filter(([, level]) => level === "penting").map(([id]) => layout.quality[id]);
  sheet.mergeCells(layout.qualityTotal, 2, layout.qualityTotal, 4);
  setCell(sheet.getCell(layout.qualityTotal, 2), "Temuan penting (Excel)", { bold: true, align: "left" });
  const pentingValue = QUALITY_CHECKS.filter(([, level]) => level === "penting").reduce((sum, [id]) => sum + qualityRows[id][1], 0);
  setCell(sheet.getCell(layout.qualityTotal, 6), { formula: penting.map((row) => `F${row}`).join("+"), result: pentingValue }, { bold: true });

  // ---------- work-life balance ----------
  heading(sheet, layout.wlbHeader - 1, "Skor keseimbangan kerja–hidup (0–100)", layout.lastColumn);
  const wh = layout.wlbHeader;
  ["No", "Nama", ...WLB_COLUMNS.map(([, label]) => label), "Skor (Excel)", "Tingkat (Excel)", "Skor program", "Sama?"].forEach((label, index) => (sheet.getCell(wh, index + 1).value = label));
  headerCells(sheet.getRow(wh), Array.from({ length: 17 }, (_, index) => index + 1));
  sheet.getRow(wh).height = 42;
  const programWlb = new Map((result.wellbeing?.members ?? []).map((item) => [item.id, item]));
  const scores = [];
  person.forEach((item, index) => {
    const row = layout.wlb[item.member.id];
    const values = {
      nights: [item.nightsF, item.nights], longBlocks: [item.longBlocksF, item.longBlocks], weekendDays: [item.weekendDaysF, item.weekendDays],
      fullWeekends: [item.fullWeekendsF, item.fullWeekends], fullBlocks: [item.fullBlocksF, item.fullBlocks], isolated: [item.isolatedF, item.isolated],
      singles: [item.singlesF, item.singles], hoursOver: [item.hoursOverF, item.hoursOver], hoursHeavy: [item.hoursHeavyF, item.hoursHeavy],
      switches: [item.switchesF, item.switches], overTarget: [`MAX(0,ROUND(${item.workDaysF}-${item.targetF},0))`, Math.max(0, Math.round(item.workDays - item.target))]
    };
    setCell(sheet.getCell(row, 1), index + 1, { color: C.note });
    setCell(sheet.getCell(row, 2), item.member.name, { bold: true, align: "left" });
    WLB_COLUMNS.forEach(([key], offset) => setCell(sheet.getCell(row, 3 + offset), { formula: values[key][0], result: values[key][1] }, { size: 9 }));
    const cell = (key) => `${ui.columnLetter(3 + WLB_COLUMNS.findIndex(([name]) => name === key))}${row}`;
    const P = (key) => `Hitungan!${pts(key)}`;
    const deduction = [
      `${P("overTarget")}*${cell("overTarget")}`, `${P("night")}*${cell("nights")}`, `${P("longBlock")}*${cell("longBlocks")}`,
      `IF(${cell("fullWeekends")}=0,${P("noFullWeekend")},IF(${cell("fullWeekends")}=1,${P("oneFullWeekend")},0))`, `${P("weekendDay")}*${cell("weekendDays")}`,
      `${P("fullBlock")}*${cell("fullBlocks")}`, `${P("singleOff")}*${cell("isolated")}`, `${P("singleWork")}*${cell("singles")}`,
      `${P("hourOver")}*${cell("hoursOver")}`, `${P("hourHeavy")}*${cell("hoursHeavy")}`, `${P("shiftSwitch")}*${cell("switches")}`
    ].join("+");
    const W = WLB_POINTS;
    const points = W.overTarget * values.overTarget[1] + W.night * item.nights + W.longBlock * item.longBlocks + (item.fullWeekends === 0 ? W.noFullWeekend : item.fullWeekends === 1 ? W.oneFullWeekend : 0) +
      W.weekendDay * item.weekendDays + W.fullBlock * item.fullBlocks + W.singleOff * item.isolated + W.singleWork * item.singles + W.hourOver * item.hoursOver + W.hourHeavy * item.hoursHeavy + W.shiftSwitch * item.switches;
    const inTeam = grids[index].codes.slice(H, H + M).filter((code) => code !== "-").length >= 10;
    const presentDaysF = `(${M}-COUNTIF(Hitungan!${monthRange(grids[index].row("code")).replaceAll("$", "")},"-"))`;
    const score = inTeam ? Math.max(0, 100 - points) : "–";
    if (inTeam) scores.push(score);
    const level = inTeam ? (score >= 80 ? "Baik" : score >= 65 ? "Cukup" : "Perlu perhatian") : "–";
    setCell(sheet.getCell(row, 14), { formula: `IF(${presentDaysF}<10,"–",MAX(0,100-(${deduction})))`, result: score }, { bold: true });
    setCell(sheet.getCell(row, 15), { formula: `IF(ISNUMBER(N${row}),IF(N${row}>=80,"Baik",IF(N${row}>=65,"Cukup","Perlu perhatian")),"–")`, result: level }, { bold: true });
    const program = programWlb.get(item.member.id)?.score;
    setCell(sheet.getCell(row, 16), program ?? "–", { color: C.note });
    setCell(sheet.getCell(row, 17), { formula: `IF(N${row}&""=P${row}&"","✔ Sama","✖ Berbeda")`, result: String(score) === String(program ?? "–") ? "✔ Sama" : "✖ Berbeda" }, { bold: true });
  });
  const team = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : "–";
  setCell(sheet.getCell(layout.wlbTeam, 2), "Rata-rata tim", { bold: true, align: "left" });
  setCell(sheet.getCell(layout.wlbTeam, 14), { formula: `IFERROR(ROUND(AVERAGE(N${layout.wlbFirst}:N${layout.wlbTeam - 1}),0),"–")`, result: team }, { bold: true });
  setCell(sheet.getCell(layout.wlbTeam, 15), { formula: `IF(ISNUMBER(N${layout.wlbTeam}),IF(N${layout.wlbTeam}>=80,"Baik",IF(N${layout.wlbTeam}>=65,"Cukup","Perlu perhatian")),"–")`, result: typeof team === "number" ? (team >= 80 ? "Baik" : team >= 65 ? "Cukup" : "Perlu perhatian") : "–" }, { bold: true });
  setCell(sheet.getCell(layout.wlbTeam, 16), result.wellbeing?.team ?? "–", { color: C.note });
  const W = WLB_POINTS;
  paragraph(sheet, layout.wlbTeam + 2,
    `Skor = 100 dikurangi: ${W.night} per malam Shift 3, ${W.longBlock} per blok 3 malam, ${W.weekendDay} per hari kerja Sabtu/Minggu, ${W.noFullWeekend} bila tidak ada libur Sabtu–Minggu penuh (${W.oneFullWeekend} bila hanya 1 kali), ${W.fullBlock} per ${calc.paramValues.maxWork} hari kerja berturut-turut (cuti dihitung), ${W.singleOff} per libur hanya 1 hari, ${W.singleWork} per masuk hanya 1 hari, ${W.hourOver} per jam di atas batas mingguan dan ${W.hourHeavy} lagi per jam di atas batas + 4, ${W.shiftSwitch} per pindah Shift 1↔2 dalam satu blok, dan ${W.overTarget} per hari kerja di atas target. Baik = 80 ke atas, Cukup = 65–79, Perlu perhatian = di bawah 65. Orang yang kurang dari 10 hari di tim tidak diberi skor.`,
    layout.lastColumn, { italic: true, color: C.note, size: 9, charsPerLine: 170 });

  // Colours read only cells of this sheet (a colour rule that reads another sheet breaks Excel).
  const mark = (ref, topLeft, badTest) => sheet.addConditionalFormatting({
    ref,
    rules: [
      { type: "expression", priority: 1, formulae: [badTest(topLeft)], style: { font: { color: { argb: C.badText }, bold: true }, fill: { type: "pattern", pattern: "solid", bgColor: { argb: C.badFill } } } },
      { type: "expression", priority: 2, formulae: [`NOT(${badTest(topLeft)})`], style: { font: { color: { argb: C.okText }, bold: true }, fill: { type: "pattern", pattern: "solid", bgColor: { argb: C.okFill } } } }
    ]
  });
  const last = layout.ruleTotal - 1;
  mark(`F${layout.ruleFirst}:F${last}`, `F${layout.ruleFirst}`, (cell) => `LEFT(${cell},1)="✖"`);
  mark(`H${layout.ruleFirst}:H${last}`, `H${layout.ruleFirst}`, (cell) => `LEFT(${cell},1)="✖"`);
  mark(`H${layout.qualityFirst}:H${layout.qualityTotal - 1}`, `H${layout.qualityFirst}`, (cell) => `LEFT(${cell},1)="✖"`);
  mark(`Q${layout.wlbFirst}:Q${layout.wlbTeam - 1}`, `Q${layout.wlbFirst}`, (cell) => `LEFT(${cell},1)="✖"`);
  const levels = [["Baik", C.okFill, C.okText], ["Cukup", C.warnFill, C.warnText], ["Perlu perhatian", C.badFill, C.badText]];
  sheet.addConditionalFormatting({
    ref: `O${layout.wlbFirst}:O${layout.wlbTeam}`,
    rules: levels.map(([label, bg, text], index) => ({ type: "expression", priority: 10 + index, formulae: [`O${layout.wlbFirst}="${label}"`], style: { font: { color: { argb: text }, bold: true }, fill: { type: "pattern", pattern: "solid", bgColor: { argb: bg } } } }))
  });
  return layout;
}
