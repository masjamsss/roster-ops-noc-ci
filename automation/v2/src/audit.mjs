// Independent rule checker. It deliberately shares no logic with rules.mjs:
// it walks the finished timeline with plain loops, so a bug in the search
// rules cannot hide itself here. Titles and messages are for the OM (Indonesian).
import { formatTanggal, KODE_LABEL } from "./labels-id.mjs";

const OFF_LIKE = new Set(["H", "C", "S", "-"]);

function clockHours(text) {
  const [hours, minutes] = text.split(":").map(Number);
  return hours + minutes / 60;
}

function windowFor(code, dayIndex, shiftById, trainingWindow) {
  const shift = shiftById.get(code) ?? trainingWindow;
  const start = dayIndex * 24 + clockHours(shift.start);
  let end = dayIndex * 24 + clockHours(shift.end);
  if (end <= start) end += 24;
  return { start, end };
}

function isActiveOn(member, date) {
  return (!member.activeFrom || date >= member.activeFrom) && (!member.activeUntil || date <= member.activeUntil);
}

export function auditTimeline({ dates, codesById, members, shifts, rules, coverage, dayInfoByDate, requestsByDate = {}, generatedFrom, publishedTo, trainingWindow }) {
  const shiftById = new Map(shifts.map((shift) => [shift.id, shift]));
  const nightId = shifts.find((shift) => shift.night)?.id ?? shifts.at(-1).id;
  const isShift = (code) => shiftById.has(code);
  const isWork = (code) => isShift(code) || code === "T";
  const inRange = (date) => date >= generatedFrom && date <= publishedTo;
  const tgl = (date) => formatTanggal(date, { pendek: true });
  const checks = [];
  const add = (id, judul, pelanggaran) => checks.push({ id, judul, ok: pelanggaran.length === 0, pelanggaran });

  // 1 + 2. Coverage per published day.
  const gaps = [];
  const exact = [];
  for (const [index, date] of dates.entries()) {
    if (!inRange(date)) continue;
    const info = dayInfoByDate[date] ?? {};
    const policy = info.isSpecial ? coverage.special : coverage.weekday;
    for (const shift of shifts) {
      const count = members.filter((member) => codesById[member.id][index] === shift.id).length;
      if (count < policy.minimum[shift.id]) {
        gaps.push({ tanggal: date, anggota: "", pesan: `${tgl(date)}: Shift ${shift.id} hanya ${count} orang (minimal ${policy.minimum[shift.id]}).` });
      }
      if (info.isSpecial && count !== policy.preferred[shift.id]) {
        exact.push({ tanggal: date, anggota: "", pesan: `${tgl(date)}: Shift ${shift.id} ada ${count} orang (seharusnya tepat ${policy.preferred[shift.id]}).` });
      }
    }
  }
  add("cakupan", "Setiap shift terisi setiap hari (minimal 1 orang)", gaps);
  add("hari-khusus", "Sabtu, Minggu, tanggal merah dan cuti bersama: tepat 1 orang per shift", exact);

  const streaks = [];
  const nights = [];
  const recovery = [];
  const rest = [];
  const backward = [];
  const eligibility = [];
  const offRuns = [];
  const requests = [];
  const inactive = [];
  const afterSick = [];
  const sickFree = rules.nightFreeDaysAfterSick ?? 0;

  for (const member of members) {
    const codes = codesById[member.id];
    const name = member.name;
    let workRun = 0;
    let nightRun = 0;
    let offRun = 0;
    let offAfterNight = null;
    let lastEnd = null;
    let leaveInRun = false;
    let runReported = false;

    codes.forEach((code, index) => {
      const date = dates[index];
      const report = inRange(date);
      const dayIndex = index;
      if (isWork(code)) {
        workRun += 1;
        // One finding per run, updated while the run goes on. The first day over
        // the limit may be a leave day (leave counts), so check "> max", not "=".
        const withLeave = leaveInRun ? " termasuk cuti" : "";
        if (report && workRun > rules.maxConsecutiveWorkDays) {
          const pesan = `${name} bekerja ${workRun} hari berturut-turut${withLeave} sampai ${tgl(date)} (maksimal ${rules.maxConsecutiveWorkDays}).`;
          if (runReported) streaks.at(-1).pesan = pesan;
          else streaks.push({ tanggal: date, anggota: name, pesan });
          runReported = true;
        }
        nightRun = code === nightId ? nightRun + 1 : 0;
        if (report && nightRun === rules.nightBlock.max + 1) {
          nights.push({ tanggal: date, anggota: name, pesan: `${name} Shift 3 ${nightRun} malam berturut-turut sampai ${tgl(date)} (maksimal ${rules.nightBlock.max}).` });
        }
        const previous = index > 0 ? codes[index - 1] : null;
        if (previous === nightId && code !== nightId && report) {
          recovery.push({ tanggal: date, anggota: name, pesan: `${name} masuk ${KODE_LABEL[code]} tgl ${tgl(date)} langsung setelah Shift 3 tanpa libur.` });
        } else if (offAfterNight !== null && offAfterNight < rules.nightRecoveryOffDays && report) {
          recovery.push({ tanggal: date, anggota: name, pesan: `${name} masuk kerja tgl ${tgl(date)} setelah Shift 3 dengan libur hanya ${offAfterNight} hari (minimal ${rules.nightRecoveryOffDays}).` });
        }
        offAfterNight = null;
        const window = windowFor(code, dayIndex, shiftById, trainingWindow);
        if (lastEnd !== null && report && window.start - lastEnd < rules.minimumRestHours) {
          rest.push({ tanggal: date, anggota: name, pesan: `${name} hanya istirahat ${window.start - lastEnd} jam sebelum tgl ${tgl(date)} (minimal ${rules.minimumRestHours} jam).` });
        }
        lastEnd = window.end;
        if (report && isShift(code) && isShift(previous) && shiftById.get(code).level < shiftById.get(previous).level) {
          backward.push({ tanggal: date, anggota: name, pesan: `${name} pindah dari Shift ${previous} ke Shift ${code} tgl ${tgl(date)} tanpa libur.` });
        }
        offRun = 0;
      } else {
        // Leave counts as a work day and is not rest after nights (see rules.mjs).
        const leaveAsWork = code === "C" && rules.leaveCountsAsWork !== false;
        if (index > 0 && codes[index - 1] === nightId) offAfterNight = 0;
        if (offAfterNight !== null && OFF_LIKE.has(code) && !leaveAsWork) offAfterNight += 1;
        workRun = leaveAsWork ? workRun + 1 : 0;
        leaveInRun = leaveAsWork;
        if (!leaveAsWork) runReported = false;
        nightRun = 0;
        offRun = code === "H" ? offRun + 1 : 0;
        const requested = requestsByDate[date]?.[member.id] === "H";
        if (report && code === "H" && offRun > rules.maxConsecutiveOffDays && !requested) {
          offRuns.push({ tanggal: date, anggota: name, pesan: `${name} libur ${offRun} hari berturut-turut sampai ${tgl(date)} (maksimal ${rules.maxConsecutiveOffDays}).` });
        }
      }

      if (!report) return;
      if (code === nightId && sickFree > 0 && requestsByDate[date]?.[member.id] !== nightId) {
        const recent = codes.slice(Math.max(0, index - sickFree), index);
        if (recent.includes("S")) {
          afterSick.push({ tanggal: date, anggota: name, pesan: `${name} Shift 3 tgl ${tgl(date)}, padahal baru kembali dari sakit (tanpa Shift 3 selama ${sickFree} hari).` });
        }
      }
      if (isShift(code) && !member.eligibleShifts.includes(code)) {
        eligibility.push({ tanggal: date, anggota: name, pesan: `${name} mendapat Shift ${code} tgl ${tgl(date)}, padahal tidak boleh.` });
      }
      const wanted = requestsByDate[date]?.[member.id];
      if (wanted?.startsWith("!")) {
        if (isShift(code) && wanted.slice(1).includes(code)) requests.push({ tanggal: date, anggota: name, pesan: `${name} tgl ${tgl(date)}: minta tidak ${KODE_LABEL[code]}, tetapi dijadwalkan ${KODE_LABEL[code]}.` });
      } else if (wanted && wanted !== code) {
        requests.push({ tanggal: date, anggota: name, pesan: `${name} tgl ${tgl(date)}: diminta ${KODE_LABEL[wanted]}, tetapi dijadwalkan ${KODE_LABEL[code] ?? code}.` });
      }
      const active = isActiveOn(member, date);
      if (!active && code !== "-") {
        inactive.push({ tanggal: date, anggota: name, pesan: `${name} dijadwalkan tgl ${tgl(date)}, padahal tidak aktif di tim pada tanggal itu.` });
      } else if (active && code === "-") {
        inactive.push({ tanggal: date, anggota: name, pesan: `${name} masih aktif tgl ${tgl(date)}, tetapi tidak dijadwalkan sama sekali.` });
      }
    });
  }

  add("maks-hari-kerja", `Maksimal ${rules.maxConsecutiveWorkDays} hari kerja berturut-turut (termasuk sambungan dari bulan lalu)`, streaks);
  add("maks-malam", `Shift 3 maksimal ${rules.nightBlock.max} malam berturut-turut`, nights);
  add("istirahat-malam", `Setelah Shift 3, libur ${rules.nightRecoveryOffDays} hari sebelum masuk kerja lagi`, recovery);
  add("istirahat-11-jam", `Jeda istirahat minimal ${rules.minimumRestHours} jam antar shift`, rest);
  add("shift-mundur", "Tidak ada pindah shift mundur (2→1, 3→2, 3→1) tanpa libur", backward);
  add("shift-diizinkan", "Setiap orang hanya mendapat shift yang diizinkan", eligibility);
  add("maks-libur", `Tidak libur (H) lebih dari ${rules.maxConsecutiveOffDays} hari berturut-turut`, offRuns);
  add("permintaan", "Cuti, training dan permintaan dipenuhi", requests);
  add("tidak-aktif", "Anggota yang belum bergabung atau sudah keluar tidak dijadwalkan", inactive);
  add("setelah-sakit", `Setelah sakit, tidak Shift 3 selama ${sickFree} hari (mulai dengan shift siang/pagi)`, afterSick);
  return { ok: checks.every((item) => item.ok), checks };
}
