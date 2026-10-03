// Counts and plain-Indonesian notes about a finished roster, for the Excel.
import { isWorkLike } from "./codes.mjs";
import { addDays, isoDate, parseClock } from "./date-utils.mjs";
import { displayTargets, fridayWithoutFemale } from "./objective.mjs";
import { dayStatus } from "./staffing.mjs";
import { daftarNama, formatPeriode, formatRentang, formatTanggal, KODE_LABEL } from "./labels-id.mjs";

const restedOff = (code) => code === "H" || code === "C" || code === "S";

function weeklyHours(dates, codes, netHours, monthStart, monthEnd) {
  const weeks = [];
  dates.forEach((date, index) => {
    if (date > monthEnd) return;
    const weekday = (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;
    if (weekday === 0 || weeks.length === 0) weeks.push({ weekStart: date, hours: 0, days: 0 });
    const week = weeks.at(-1);
    week.hours += netHours[codes[index]] ?? 0;
    week.days += 1;
  });
  // Complete the last week with the look-ahead so every listed week is Monday-Sunday.
  const last = weeks.at(-1);
  if (last) {
    const start = dates.indexOf(last.weekStart);
    last.hours = 0;
    for (let k = start; k < Math.min(dates.length, start + 7); k += 1) last.hours += netHours[codes[k]] ?? 0;
  }
  return weeks.filter((week) => week.weekStart >= shiftStart(monthStart));
}

function shiftStart(monthStart) {
  const date = new Date(`${monthStart}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return date.toISOString().slice(0, 10);
}

export function computeMemberSummary({ members, days, codes, historyCodes, historyDates = [], shiftIds, nightId, env, netHours = {}, weeklyHoursLimit = 40 }) {
  const summary = {};
  members.forEach((member, i) => {
    const before = (d) => (d > 0 ? codes[i][d - 1] : (historyCodes[i].at(-1) ?? "-"));
    const item = {
      id: member.id,
      name: member.name,
      workDays: 0,
      offDays: 0,
      leaveDays: 0,
      sickDays: 0,
      trainingDays: 0,
      inactiveDays: 0,
      shifts: Object.fromEntries(shiftIds.map((id) => [id, 0])),
      weekendWorkDays: 0,
      holidayWorkDays: 0,
      fullWeekendsOff: 0,
      isolatedOffDays: 0,
      dayToNightJumps: [],
      nightRecoveryDays: 0,
      netHours: 0,
      holidayHours: 0,
      weeklyHours: [],
      weeksOverLimit: 0,
      hoursOverLimit: 0,
      workTarget: 0,
      workTargetBase: 0
    };
    days.forEach((day, d) => {
      if (!day.published) return;
      const code = codes[i][d];
      item.netHours += netHours[code] ?? 0;
      if (day.isHoliday) item.holidayHours += netHours[code] ?? 0;
      if (shiftIds.includes(code)) {
        item.workDays += 1;
        item.shifts[code] += 1;
        if (day.isWeekend) item.weekendWorkDays += 1;
        if (day.isHoliday) item.holidayWorkDays += 1;
      } else if (code === "H") item.offDays += 1;
      else if (code === "C") item.leaveDays += 1;
      else if (code === "S") item.sickDays += 1;
      else if (code === "T") item.trainingDays += 1;
      else if (code === "-") item.inactiveDays += 1;
      const previous = before(d);
      if (day.isSunday && restedOff(previous) && restedOff(code)) item.fullWeekendsOff += 1;
      if (code === "H" && isWorkLike(previous, shiftIds) && d + 1 < days.length && isWorkLike(codes[i][d + 1], shiftIds)) item.isolatedOffDays += 1;
      if (code === nightId && previous === "1") item.dayToNightJumps.push(day.date);
      const twoBefore = d > 1 ? codes[i][d - 2] : (historyCodes[i].at(d - 2) ?? "-");
      if (code === "H" && (previous === nightId || (["H", "C", "S"].includes(previous) && twoBefore === nightId))) item.nightRecoveryDays += 1;
    });
    const past = historyDates.slice(-7);
    const pastCodes = historyCodes[i].slice(-7);
    const paddedPast = past.map((_, k) => pastCodes[k - (past.length - pastCodes.length)] ?? "-");
    const monthStart = days.find((day) => day.published)?.date;
    const monthEnd = days.filter((day) => day.published).at(-1)?.date;
    if (monthStart) {
      item.weeklyHours = weeklyHours([...past, ...days.map((day) => day.date)], [...paddedPast, ...codes[i]], netHours, monthStart, monthEnd);
      item.weeksOverLimit = item.weeklyHours.filter((week) => week.hours > weeklyHoursLimit).length;
      item.hoursOverLimit = item.weeklyHours.reduce((sum, week) => sum + Math.max(0, week.hours - weeklyHoursLimit), 0);
    }
    summary[member.id] = item;
  });
  if (env) {
    const targets = displayTargets(env);
    members.forEach((member, i) => {
      summary[member.id].workTarget = targets[i].target;
      summary[member.id].workTargetBase = targets[i].base;
    });
  }
  return summary;
}

export function computeDayRows({ days, codes, members, config }) {
  return days
    .filter((day) => day.published)
    .map((day) => {
      const d = day.dayIndex;
      const counts = Object.fromEntries(config.shifts.map((shift) => [shift.id, members.filter((_, i) => codes[i][d] === shift.id).length]));
      const policy = day.isSpecial ? config.coverage.special : config.coverage.weekday;
      const status = dayStatus(counts, day.isSpecial, config.coverage, config.shifts.map((shift) => shift.id));
      return { date: day.date, isWeekend: day.isWeekend, isSpecial: day.isSpecial, isHoliday: day.isHoliday, holiday: day.holiday, counts, minimum: policy.minimum, preferred: policy.preferred, status };
    });
}

export function findNightBlocks({ members, days, codes, nightId }) {
  const blocks = [];
  members.forEach((member, i) => {
    let start = null;
    days.forEach((day, d) => {
      const isNight = day.published && codes[i][d] === nightId;
      if (isNight && start === null) start = d;
      const endsHere = start !== null && (!isNight || d === days.length - 1 || !days[d + 1].published || codes[i][d + 1] !== nightId);
      if (isNight && endsHere) {
        blocks.push({ memberId: member.id, name: member.name, start: days[start].date, end: day.date, length: d - start + 1 });
        start = null;
      } else if (!isNight) start = null;
    });
  });
  return blocks.sort((left, right) => left.start.localeCompare(right.start));
}

function trailingRun(codes, code) {
  let count = 0;
  for (let index = codes.length - 1; index >= 0 && codes[index] === code; index -= 1) count += 1;
  return count;
}

export function buildNotes({ members, days, codes, historyDates, historyCodes, initialStates, initialQueue, nightBlocks, summary, dayRows, config, env, requestCount, nightId, backups = [], backupPlan = [], changes = [], externalBackups = [], minimalReasons = [] }) {
  const notes = [];
  const recovery = config.rules.nightRecoveryOffDays;
  const published = days.filter((day) => day.published);

  // Updating an existing month: say first what changed for whom.
  if (config.reference) {
    const frozen = config.freezeBefore && config.freezeBefore > published[0].date ? ` Tanggal sebelum ${formatTanggal(config.freezeBefore, { pendek: true })} tidak diubah.` : "";
    const rebuilt = config.referenceMode === "rebuild";
    const intro = rebuilt ? "Roster disusun ulang; dibanding versi sebelumnya" : "Roster diperbarui dari versi sebelumnya:";
    if (changes.length === 0) notes.push(`${intro} tidak ada perubahan jadwal.${frozen}`);
    else {
      const perPerson = members.map((member) => [member.name, changes.filter((change) => change.memberId === member.id).length]).filter(([, count]) => count > 0);
      const kept = rebuilt ? "" : " Jadwal lama dipertahankan sebisa mungkin.";
      notes.push(`${intro} ${changes.length} perubahan (${perPerson.map(([name, count]) => `${name} ${count}`).join(", ")}).${kept} Rinciannya di sheet Info Admin dan sebagai catatan di sel yang berubah.${frozen}`);
    }
  }
  const memberIndex = new Map(members.map((member, index) => [member.id, index]));

  // Carried over from last month: a night block continued on request, recovery
  // after nights, and a skipped night turn.
  const continued = new Set();
  members.forEach((member, i) => {
    if (initialStates[i].previousCode !== nightId || codes[i][0] !== nightId) return;
    let length = 0;
    while (length < published.length && codes[i][length] === nightId) length += 1;
    const nightDates = historyDates.slice(historyDates.length - trailingRun(historyCodes[i], nightId));
    const restDates = published.slice(length, length + recovery).map((day) => day.date);
    continued.add(member.id);
    notes.push(`${member.name} melanjutkan blok Shift 3 dari ${formatRentang(nightDates)} sampai ${formatRentang(published.slice(0, length).map((day) => day.date))} (diminta), lalu libur ${formatRentang(restDates)} untuk istirahat.`);
  });
  members.forEach((member, i) => {
    const state = initialStates[i];
    if (continued.has(member.id) || !state.lastWorkWasNight || state.restStreak >= recovery) return;
    const history = historyCodes[i];
    const offAtEnd = state.restStreak;
    const nightRun = trailingRun(history.slice(0, history.length - offAtEnd), nightId);
    const nightDates = historyDates.slice(historyDates.length - offAtEnd - nightRun, historyDates.length - offAtEnd);
    const restDates = published.slice(0, recovery - offAtEnd).map((day) => day.date);
    if (nightDates.length > 0 && restDates.length > 0) {
      notes.push(`${member.name} libur ${formatRentang(restDates)} untuk istirahat setelah Shift 3 tgl ${formatRentang(nightDates)}.`);
    }
  });
  const head = initialQueue[0];
  const firstBlock = nightBlocks.find((block) => !(continued.has(block.memberId) && block.start === published[0].date));
  if (head && firstBlock && firstBlock.memberId !== head) {
    const i = memberIndex.get(head);
    const state = initialStates[i];
    const firstCode = codes[i][0];
    let reason = "belum bisa masuk di awal bulan";
    if (state.workStreak + config.rules.nightBlock.min > config.rules.maxConsecutiveWorkDays) {
      const workDates = historyDates.slice(historyDates.length - state.workStreak);
      reason = `${members[i].name} sudah bekerja ${state.workStreak} hari berturut-turut (${formatRentang(workDates)})`;
    } else if (["C", "S", "T", "-"].includes(firstCode)) reason = `${members[i].name} sedang ${KODE_LABEL[firstCode].toLowerCase()}`;
    else if (state.lastWorkWasNight && state.restStreak < recovery) reason = `${members[i].name} masih istirahat setelah Shift 3`;
    notes.push(`Giliran Shift 3 pertama seharusnya ${members[i].name}, tetapi ${reason}; ${firstBlock.name} menggantikan (${formatPeriode(firstBlock.start, firstBlock.end)}) dan ${members[i].name} masuk giliran berikutnya.`);
  }

  // Shift 1 straight into Shift 3.
  const dayShift = config.shifts.find((shift) => shift.id === "1");
  const nightShift = config.shifts.find((shift) => shift.id === nightId);
  const jumpRest = dayShift && nightShift ? 24 + parseClock(nightShift.start) - parseClock(dayShift.end) : null;
  for (const member of members) {
    for (const date of summary[member.id].dayToNightJumps) {
      notes.push(`${member.name} masuk Shift 3 tgl ${formatTanggal(date, { pendek: true })} langsung setelah Shift 1${jumpRest ? ` (jeda istirahat ${jumpRest} jam)` : ""}.`);
    }
  }

  const longBlocks = nightBlocks.filter((block) => block.length > config.rules.nightBlock.preferred);
  if (longBlocks.length > 0) {
    const why = config.rules.longNightBlockOnlyIfNeeded === false
      ? "agar pola kerja rapi dan hari kerja lebih terisi"
      : `hanya bila terpaksa; biasanya karena ${published.length} malam di bulan ini tidak habis dibagi blok ${config.rules.nightBlock.preferred} malam`;
    notes.push(`Blok Shift 3 selama ${config.rules.nightBlock.max} malam dipakai ${longBlocks.length} kali (${why}): ${longBlocks.map((block) => `${block.name} ${formatPeriode(block.start, block.end)}`).join(", ")}.`);
  } else {
    notes.push(`Semua blok Shift 3 berisi ${config.rules.nightBlock.preferred} malam.`);
  }

  // Back from sick leave: day shifts first, no nights for a few days.
  const sickFree = config.rules.nightFreeDaysAfterSick ?? 0;
  if (sickFree > 0) {
    members.forEach((member, i) => {
      const row = published.map((day) => codes[i][day.dayIndex]);
      row.forEach((code, d) => {
        if (code !== "S" || row[d + 1] === "S" || d + 1 >= row.length) return;
        let start = d;
        while (start > 0 && row[start - 1] === "S") start -= 1;
        const until = isoDate(addDays(published[d].date, sickFree));
        notes.push(`${member.name} sakit ${formatPeriode(published[start].date, published[d].date)}; kembali tgl ${formatTanggal(published[d + 1].date, { pendek: true })} dengan shift pagi/siang, tanpa Shift 3 sampai ${formatTanggal(until, { pendek: true })}.`);
      });
    });
  }

  const ideal = Object.values(config.coverage.weekday.preferred).join("-");
  const minimum = Object.values(config.coverage.weekday.minimum).join("-");
  const minimal = dayRows.filter((row) => row.status === "MINIMAL").map((row) => row.date);
  const weekdays = dayRows.filter((row) => !row.isSpecial);
  const idealCount = weekdays.filter((row) => row.status === "IDEAL").length;
  const enoughCount = weekdays.filter((row) => row.status === "CUKUP").length;
  notes.push(`Hari kerja (Senin–Jumat): IDEAL ${ideal} ${idealCount} hari, CUKUP (satu orang kurang dari ideal, misalnya 2-1-1) ${enoughCount} hari, MINIMAL ${minimum} ${minimal.length} hari.`);
  if (minimal.length > 0) notes.push(`Hari MINIMAL (${minimum}, tanpa cadangan): ${minimal.map((date) => formatTanggal(date, { pendek: true })).join(", ")}.`);
  notes.push(...minimalReasons);
  const upsideDown = weekdays.filter((row) => row.counts["1"] < row.counts["2"]);
  notes.push(upsideDown.length === 0
    ? "Setiap hari kerja, Shift 1 tidak pernah lebih sedikit dari Shift 2 (pagi lebih ramai): orang ke-4 masuk Shift 1 (2-1-1), baru orang ke-5 ke Shift 2."
    : `Shift 2 lebih banyak dari Shift 1 (tidak bisa dihindari karena aturan istirahat): ${upsideDown.map((row) => formatTanggal(row.date, { pendek: true })).join(", ")}.`);

  const holidays = published.filter((day) => day.holiday);
  if (holidays.length > 0) {
    const list = holidays.map((day) => `${formatTanggal(day.date, { pendek: true })} (${day.holiday.name}${day.holiday.tentative ? ", tanggal belum pasti" : ""})`);
    const special = holidays.every((day) => day.isSpecial);
    notes.push(`Tanggal merah dan cuti bersama bulan ini: ${list.join(", ")}.${special ? " Hari-hari ini diisi 1 orang per shift." : ""}`);
  } else notes.push("Tidak ada tanggal merah atau cuti bersama di bulan ini.");

  const active = members.filter((member) => summary[member.id].inactiveDays === 0);
  const workDays = active.map((member) => summary[member.id].workDays);
  if (workDays.length > 0) {
    const range = Math.min(...workDays) === Math.max(...workDays) ? `${workDays[0]}` : `${Math.min(...workDays)}–${Math.max(...workDays)}`;
    const target = Math.round(env.target);
    notes.push(env.basis === "aturan"
      ? `Hari kerja per orang: ${range} hari (target tetap ${target} hari per orang, diatur di Data Roster.xlsx).`
      : `Hari kerja per orang: ${range} hari (target ${target} hari: pekerjaan ideal bulan ini dibagi rata, maksimal 5 hari kerja per minggu). Cuti, sakit dan training dihitung 1:1 sebagai hari yang sudah dipenuhi.`);
    if (env.basis !== "aturan" && env.detail && env.detail.share <= env.detail.weekCap - 3) {
      notes.push(`Tim cukup besar: pekerjaan ideal dibagi rata hanya sekitar ${Math.round(env.detail.share)} hari per orang, di bawah 5 hari kerja per minggu (${Math.round(env.detail.weekCap)} hari). Bila semua perlu bekerja penuh, naikkan jumlah "ideal" di sheet Kebutuhan Shift (Data Roster.xlsx).`);
    }
  }
  const reduced = members.filter((member) => summary[member.id].workTarget < summary[member.id].workTargetBase);
  if (reduced.length > 0) {
    notes.push(`Target hari kerja dikurangi 1 hari untuk setiap hari cuti, sakit atau training: ${reduced.map((member) => {
      const item = summary[member.id];
      return `${member.name} ${item.workTargetBase} − ${item.workTargetBase - item.workTarget} = ${item.workTarget} hari`;
    }).join(", ")}.`);
  }
  const off = members.filter((member) => Math.abs(summary[member.id].workDays - summary[member.id].workTarget) > 1);
  if (off.length > 0) {
    notes.push(`Selisih lebih dari 1 hari dari target: ${daftarNama(off.map((member) => `${member.name} ${summary[member.id].workDays} hari (target ${summary[member.id].workTarget})`))}. Biasanya karena istirahat wajib setelah Shift 3 atau sambungan dari bulan lalu.`);
  }

  if (config.rules.fridayShift1Female && members.some((member) => member.gender === "P")) {
    const fridays = published.filter((day) => day.isFriday);
    const missing = fridays.filter((day) => fridayWithoutFemale(members.map((_, i) => codes[i][day.dayIndex]), day, members, config));
    // Fridays where every female agent is on leave, sick or not in the team.
    const noneAvailable = fridays.filter((day) => members.every((member, i) => member.gender !== "P" || ["C", "S", "T", "-"].includes(codes[i][day.dayIndex])));
    const day = (item) => formatTanggal(item.date, { pendek: true });
    if (fridays.length > 0 && missing.length === 0 && noneAvailable.length === 0) notes.push("Setiap Jumat, Shift 1 ada agen perempuan (untuk jaga saat sholat Jumat).");
    if (missing.length > 0) notes.push(`Jumat tanpa agen perempuan di Shift 1: ${missing.map(day).join(", ")}. Tidak bisa dipenuhi bersama aturan lain; bila perlu, tukar shift manual lalu jalankan menu 3 (Cek roster).`);
    if (noneAvailable.length > 0) notes.push(`Jumat ${noneAvailable.map(day).join(", ")}: tidak ada agen perempuan yang masuk (semua cuti/sakit), jadi Shift 1 tanpa agen perempuan saat sholat Jumat. Atur jaga bergantian atau cadangan luar tim.`);
  }

  const dayOnly = members.filter((member) => member.dayOnly && summary[member.id].inactiveDays === 0);
  if (dayOnly.length > 0) {
    notes.push(`Pembagian Shift 1 / Shift 2 untuk yang tidak masuk Shift 3: ${dayOnly.map((member) => `${member.name} ${summary[member.id].shifts["1"]} / ${summary[member.id].shifts["2"]}`).join(", ")}.`);
  }

  const noWeekend = active.filter((member) => summary[member.id].fullWeekendsOff === 0).map((member) => member.name);
  if (noWeekend.length > 0) notes.push(`Belum mendapat libur Sabtu–Minggu penuh bulan ini: ${daftarNama(noWeekend)}.`);
  else notes.push("Setiap orang mendapat minimal satu kali libur Sabtu–Minggu penuh.");

  if (backupPlan.length > 0) {
    const count = (status) => backupPlan.filter((entry) => entry.status === status).length;
    const overtime = config.rules.overtimeHours ?? 4;
    notes.push(`Bila 1 orang berhalangan mendadak (${backupPlan.length} shift bulan ini): ${count("aman")} aman karena masih ada orang kedua di shift itu, ` +
      `${count("lembur")} cukup ditutup lembur (maks. ${overtime} jam per orang: shift sebelumnya pulang lebih lambat dan/atau shift berikutnya datang lebih awal), ` +
      `${count("pengganti")} perlu pengganti dari yang sedang libur, ${count("darurat")} hanya darurat (hari kerja ke-${config.rules.maxConsecutiveWorkDays + 1}), ${count("kosong")} tanpa pengganti dalam tim. Rinciannya di sheet Cadangan.`);
    const nights = backupPlan.filter((entry) => entry.shift === nightId);
    const openHours = (entry) => entry.uncovered.reduce((sum, part) => sum + part.hours, 0);
    const least = nights.filter((entry) => entry.uncovered.length > 0).sort((a, b) => openHours(a) - openHours(b))[0];
    const noCover = nights.filter((entry) => entry.status === "kosong" || entry.status === "darurat").length;
    if (least) {
      notes.push(`Shift 3 tidak bisa ditutup lembur saja: paling sedikit jam ${least.uncovered.map((part) => `${part.from}–${part.to}`).join(", ")} tetap kosong (lebih lama bila yang bertugas di sekitarnya tidak boleh Shift 3), jadi malam yang ditinggal harus diisi pengganti. ${noCover} dari ${nights.length} malam tidak punya pengganti dalam tim sesuai aturan. ` +
        (externalBackups.length ? `Cadangan luar tim: ${daftarNama(externalBackups.map((item) => item.name))}.` : 'Isi sheet "Cadangan Luar Tim" (Data Roster.xlsx) dengan orang yang bisa dipanggil untuk malam.'));
    }
  }
  const overWeeks = members.filter((member) => summary[member.id].weeksOverLimit > 0);
  if (overWeeks.length > 0) {
    notes.push(`Minggu dengan jam kerja bersih di atas ${config.rules.weeklyHoursLimit ?? 40} jam: ${overWeeks.map((member) => `${member.name} (${summary[member.id].weeksOverLimit} minggu, +${summary[member.id].hoursOverLimit} jam)`).join(", ")}. Bisa menjadi lembur; cek dengan HR.`);
  } else notes.push(`Tidak ada minggu dengan jam kerja bersih di atas ${config.rules.weeklyHoursLimit ?? 40} jam.`);
  notes.push(requestCount > 0 ? `Cuti/permintaan yang dimasukkan: ${requestCount} baris, semua dipenuhi.` : "Tidak ada cuti atau permintaan untuk bulan ini.");
  return notes;
}

