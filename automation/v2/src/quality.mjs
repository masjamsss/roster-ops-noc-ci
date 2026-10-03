// Automatic quality review: what a careful planner checks after every rule
// passes. "penting" findings decide which candidate roster wins in best-result
// mode (fewest first); "perhatian" findings are reported only. Text is for the
// OM, in plain Indonesian.
import { weekdayIndex } from "./date-utils.mjs";
import { formatTanggal } from "./labels-id.mjs";

const WORK = new Set(["1", "2", "3", "T"]);

export function reviewQuality(result) {
  const { members, days, schedule } = result;
  const rules = result.settings?.rules ?? {};
  const limit = rules.weeklyHoursLimit ?? 40;
  const summaryOf = (member) => result.memberSummary[member.id];
  const tgl = (date) => formatTanggal(date, { pendek: true });
  const available = (member) => {
    const item = summaryOf(member);
    return days.length - (item.leaveDays ?? 0) - (item.sickDays ?? 0) - (item.trainingDays ?? 0) - (item.inactiveDays ?? 0);
  };
  const presentMostOfMonth = (member) => available(member) >= days.length / 2;
  const findings = [];
  const add = (id, level, title, details) => {
    if (details.length > 0) findings.push({ id, level, title, details, count: details.length });
  };

  add("jam-berat", "penting", `Minggu dengan lebih dari ${limit + 4} jam kerja bersih`,
    members.flatMap((member) => (summaryOf(member).weeklyHours ?? []).filter((week) => week.hours > limit + 4).map((week) => `${member.name} minggu ${tgl(week.weekStart)}: ${week.hours} jam`)));

  add("akhir-pekan", "penting", "Tidak mendapat libur Sabtu–Minggu penuh",
    members.filter((member) => presentMostOfMonth(member) && summaryOf(member).fullWeekendsOff === 0).map((member) => member.name));

  add("minimal", "penting", "Hari kerja hanya 1-1-1 (tanpa cadangan)",
    days.filter((day) => day.status === "MINIMAL").map((day) => tgl(day.date)));

  add("terbalik", "penting", "Shift 2 lebih banyak dari Shift 1 (pagi lebih ramai)",
    days.filter((day) => !day.isSpecial && day.counts["1"] < day.counts["2"]).map((day) => `${tgl(day.date)} (${day.counts["1"]}-${day.counts["2"]}-${day.counts["3"]})`));

  const women = members.filter((member) => member.gender === "P");
  if (women.length > 0 && rules.fridayShift1Female !== false) {
    add("jumat", "penting", "Jumat tanpa agen perempuan di Shift 1, padahal ada yang sedang libur",
      days.filter((day) => weekdayIndex(day.date) === 5).filter((day) => {
        const codes = women.map((member) => schedule[member.id][day.date]);
        return !codes.includes("1") && codes.includes("H");
      }).map((day) => tgl(day.date)));
  }

  // Nights per available day (leave and sickness do not count against anyone).
  const nightMen = members.filter((member) => !member.dayOnly && presentMostOfMonth(member));
  const nightsOf = (member) => summaryOf(member).shifts?.["3"] ?? 0;
  const scaled = nightMen.map((member) => (nightsOf(member) * days.length) / Math.max(1, available(member)));
  // 3-night blocks counted in the month of their third night, so a block that
  // continues from last month counts here (as in the fairness and the Excel).
  const longOf = (member) => {
    let run = 0;
    for (const code of (result.history?.codesById?.[member.id] ?? []).slice(-10)) run = code === "3" ? run + 1 : 0;
    let count = 0;
    for (const day of days) {
      run = schedule[member.id][day.date] === "3" ? run + 1 : 0;
      if (run === 3) count += 1;
    }
    return count;
  };
  const longs = nightMen.map(longOf);
  if (nightMen.length > 1 && (Math.max(...scaled) - Math.min(...scaled) >= 3 || Math.max(...longs) - Math.min(...longs) >= 2)) {
    add("malam-adil", "perhatian", "Pembagian Shift 3 kurang merata (jumlah malam atau blok 3 malam)",
      [...nightMen].sort((a, b) => nightsOf(b) - nightsOf(a)).map((member) => `${member.name} ${nightsOf(member)} malam${longOf(member) ? ` (${longOf(member)} blok 3 malam)` : ""}`));
  }

  add("seimbang-perempuan", "perhatian", "Shift 1 dan Shift 2 belum seimbang",
    members.filter((member) => member.dayOnly && Math.abs((summaryOf(member).shifts?.["1"] ?? 0) - (summaryOf(member).shifts?.["2"] ?? 0)) > 2)
      .map((member) => `${member.name} Shift 1 ${summaryOf(member).shifts["1"]} / Shift 2 ${summaryOf(member).shifts["2"]}`));

  // A single work day between days off (not at the month edges, which continue).
  const singles = [];
  for (const member of members) {
    const codes = days.map((day) => schedule[member.id][day.date]);
    codes.forEach((code, i) => {
      if (WORK.has(code) && i > 0 && i < codes.length - 1 && !WORK.has(codes[i - 1]) && !WORK.has(codes[i + 1])) singles.push(`${member.name} ${tgl(days[i].date)}`);
    });
  }
  add("sehari-kerja", "perhatian", "Masuk kerja hanya 1 hari di antara libur", singles);

  add("target", "perhatian", "Hari kerja lebih dari 1 hari di bawah target",
    members.filter((member) => presentMostOfMonth(member) && summaryOf(member).workDays < summaryOf(member).workTarget - 1)
      .map((member) => `${member.name} ${summaryOf(member).workDays} hari (target ${summaryOf(member).workTarget})`));

  return {
    findings,
    serious: findings.filter((finding) => finding.level === "penting").reduce((sum, finding) => sum + finding.count, 0),
    notices: findings.filter((finding) => finding.level === "perhatian").reduce((sum, finding) => sum + finding.count, 0)
  };
}
