// Why a weekday is only 1-1-1. For each person not working that day: away
// (leave, sickness, training, a requested day off), blocked by a rule that day
// (rest after nights, the consecutive-day limit, 11 hours of rest, no backward
// shift), or free that day but then a later day of their schedule breaks a rule
// (e.g. a 6th day in a row). Otherwise, the side effects that made the program
// keep them off. Plain Indonesian for the OM.
import { weekdayIndex } from "./date-utils.mjs";
import { daftarNama, formatRentang, formatTanggal } from "./labels-id.mjs";
import { explainTransition, transitionMember, transitionViolation } from "./rules.mjs";

const AWAY = Object.freeze({ C: "cuti", S: "sakit", T: "training/dinas" });
const WORK = new Set(["1", "2", "3", "T"]);
const OFF = new Set(["H", "C", "S"]);
const MAX_DAYS = 8;

// `timeline[memberId]` holds history then month codes, over `dates`; the month
// starts at `offset`. `summary` is computeMemberSummary's result.
export function explainMinimalDays({ members, days, codes, initialStates, ctx, fixed, dayRows, timeline, dates, offset, summary }) {
  const minimalDates = new Set(dayRows.filter((row) => row.status === "MINIMAL").map((row) => row.date));
  if (minimalDates.size === 0) return [];
  const rules = ctx.rules;
  const nightId = ctx.nightShiftId;
  const dayShifts = ctx.shiftIds.filter((id) => id !== nightId);
  const tgl = (date) => formatTanggal(date, { pendek: true });
  const requested = (d, member) => fixed[d][member.id] !== undefined;

  const statesAt = [initialStates];
  for (let d = 0; d < days.length; d += 1) {
    statesAt.push(members.map((member, i) => transitionMember(statesAt[d][i], member, codes[i][d], days[d], ctx, { requested: requested(d, member) }).state));
  }

  // The run of days just before `index` whose codes pass `test` (after skipping `skip` codes).
  const runBefore = (row, index, test, skip = () => false) => {
    let end = index - 1;
    while (end >= 0 && skip(row[end])) end -= 1;
    let start = end;
    while (start >= 0 && test(row[start])) start -= 1;
    return dates.slice(start + 1, end + 1);
  };
  const why = (violation, state, member, row, index, code, day) => {
    switch (violation.rule) {
      case "after-night":
      case "night-recovery": {
        const nights = runBefore(row, index, (item) => item === nightId, (item) => OFF.has(item));
        return `masih istirahat setelah Shift 3${nights.length ? ` (${formatRentang(nights)})` : ""}`;
      }
      case "streak": {
        // Leave counts as a work day for the limit (rules.mjs), so it belongs to the run.
        const counted = (item) => WORK.has(item) || (item === "C" && rules.leaveCountsAsWork !== false);
        const run = runBefore(row, index, counted);
        const withLeave = row.slice(index - run.length, index).includes("C") ? ", termasuk cuti" : "";
        return `sudah ${state.workStreak} hari kerja berturut-turut (${formatRentang(run)}${withLeave}), maksimal ${rules.maxConsecutiveWorkDays}`;
      }
      case "rest":
        return ctx.shiftById.has(state.previousCode)
          ? `kemarin Shift ${state.previousCode}, jeda ke Shift ${code} hanya ${violation.hours} jam (minimal ${rules.minimumRestHours} jam)`
          : `jeda istirahat hanya ${violation.hours} jam (minimal ${rules.minimumRestHours} jam)`;
      case "backward":
        return `kemarin Shift ${violation.from}, tidak boleh langsung mundur ke Shift ${code}`;
      default: {
        const text = explainTransition(state, member, code, day, ctx, { requested: false });
        return text.startsWith(`${member.name} `) ? text.slice(member.name.length + 1) : text;
      }
    }
  };

  // Side effects of adding `member` on Shift `shift` that the objective penalises.
  const sideEffects = (i, d, shift, trialStates) => {
    const member = members[i];
    const day = days[d];
    const effects = [];
    const onDay = (id) => members.filter((_, k) => codes[k][d] === id).length + (id === shift ? 1 : 0);
    if (!day.isSpecial && dayShifts.length >= 2 && onDay(dayShifts[0]) < onDay(dayShifts[1])) {
      effects.push(`Shift ${dayShifts[1]} jadi lebih ramai dari Shift ${dayShifts[0]}`);
    }
    // Hours of the Monday-Sunday week of this day.
    let last = d;
    while (last + 1 < days.length && weekdayIndex(days[last + 1].date) !== 1) last += 1;
    const hours = trialStates[last + 1].weekHours ?? 0;
    if (ctx.weeklyHoursLimit && hours > ctx.weeklyHoursLimit) effects.push(`minggu itu jadi ${hours} jam kerja (batas ${ctx.weeklyHoursLimit} jam)`);
    const row = [...timeline[member.id]];
    row[offset + d] = shift;
    const at = (k) => row[offset + k];
    const requestedOff = (k) => k >= 0 && k < days.length && requested(k, member);
    if (!WORK.has(at(d - 1)) && !WORK.has(at(d + 1)) && at(d - 1) !== undefined && at(d + 1) !== undefined) effects.push("jadi masuk hanya 1 hari di antara libur");
    for (const [gap, beyond] of [[d + 1, d + 2], [d - 1, d - 2]]) {
      if (at(gap) === "H" && WORK.has(at(beyond)) && !requestedOff(gap)) effects.push(`libur tgl ${tgl(days[gap]?.date ?? dates[offset + gap])} jadi hanya 1 hari`);
    }
    const counts = summary[member.id];
    if (counts && counts.workDays + 1 > counts.workTarget) effects.push(`hari kerjanya jadi ${counts.workDays + 1} (target ${counts.workTarget})`);
    return effects;
  };

  const reasonFor = (i, d) => {
    const member = members[i];
    const day = days[d];
    const code = codes[i][d];
    if (AWAY[code]) return `${member.name} ${AWAY[code]}`;
    if (requested(d, member)) return `${member.name} minta libur`;
    const state = statesAt[d][i];
    const row = timeline[member.id];
    const options = dayShifts.filter((shift) => member.eligibleShifts.includes(shift));
    if (options.length === 0) return `${member.name} hanya boleh Shift 3`;
    const blocked = options.map((shift) => ({ shift, violation: transitionViolation(state, member, shift, day, ctx) }));
    const open = blocked.filter((item) => !item.violation).map((item) => item.shift);
    if (open.length === 0) {
      const recovery = blocked.find((item) => item.violation.rule === "after-night" || item.violation.rule === "night-recovery");
      if (recovery) return `${member.name} ${why(recovery.violation, state, member, row, offset + d, recovery.shift, day)}`;
      if (state.workStreak + 1 > rules.maxConsecutiveWorkDays) return `${member.name} ${why({ rule: "streak" }, state, member, row, offset + d, options[0], day)}`;
      return `${member.name} ${[...new Set(blocked.map((item) => why(item.violation, state, member, row, offset + d, item.shift, day)))].join("; ")}`;
    }
    // Free that day: does working it break a later day of their schedule?
    const trials = open.map((shift) => {
      const trial = codes[i].slice();
      trial[d] = shift;
      const trialStates = statesAt.map((states) => states[i]).slice(0, d + 1);
      for (let e = d; e < days.length; e += 1) {
        const violation = transitionViolation(trialStates[e], member, trial[e], days[e], ctx, { requested: requested(e, member) });
        if (violation) return { shift, e, violation, state: trialStates[e], trial };
        trialStates.push(transitionMember(trialStates[e], member, trial[e], days[e], ctx, { requested: requested(e, member) }).state);
      }
      return { shift, trialStates };
    });
    const free = trials.find((trial) => !trial.violation);
    if (free) {
      const effects = sideEffects(i, d, free.shift, free.trialStates);
      return effects.length
        ? `${member.name} bisa Shift ${free.shift}, tetapi ${daftarNama(effects)}`
        : `${member.name} sebenarnya bisa Shift ${free.shift}, tetapi program menilai libur lebih baik untuk keseluruhan`;
    }
    const { shift, e, violation, state: later, trial } = trials[0];
    const trialRow = [...row];
    trialRow[offset + d] = shift;
    const planned = trial[e];
    return `${member.name} bisa Shift ${shift}, tetapi lalu tgl ${tgl(days[e].date)} (${ctx.shiftById.has(planned) ? `Shift ${planned}` : planned}) melanggar aturan: ${why(violation, later, member, trialRow, offset + e, planned, days[e])}`;
  };

  const notes = [];
  const listed = days.filter((day) => day.published && minimalDates.has(day.date));
  for (const day of listed.slice(0, MAX_DAYS)) {
    const d = day.dayIndex;
    const working = members.map((member, i) => [member, codes[i][d]]).filter(([, code]) => ctx.shiftById.has(code)).map(([member, code]) => `${member.name} (Shift ${code})`);
    const reasons = members.map((member, i) => [member, codes[i][d]]).filter(([, code]) => code !== "-" && !ctx.shiftById.has(code)).map(([member]) => reasonFor(members.indexOf(member), d));
    notes.push(`${tgl(day.date)} hanya 1-1-1: yang masuk ${daftarNama(working)}. Tidak bisa ditambah: ${reasons.join("; ")}.`);
  }
  if (listed.length > MAX_DAYS) notes.push(`Masih ada ${listed.length - MAX_DAYS} hari 1-1-1 lain (${listed.slice(MAX_DAYS).map((day) => tgl(day.date)).join(", ")}); alasannya serupa.`);
  return notes;
}
