// Every way to staff one day, grouped by who holds Shift 3 that day.
// A pattern is an array of codes aligned with `members`.
import { RosterError } from "./errors.mjs";
import { daftarNama, formatTanggal, KODE_LABEL } from "./labels-id.mjs";
import { isActive } from "./rules.mjs";

function combinations(items, count) {
  if (count === 0) return [[]];
  if (count > items.length) return [];
  const result = [];
  const pick = (start, chosen) => {
    if (chosen.length === count) {
      result.push([...chosen]);
      return;
    }
    for (let index = start; index <= items.length - (count - chosen.length); index += 1) {
      chosen.push(items[index]);
      pick(index + 1, chosen);
      chosen.pop();
    }
  };
  pick(0, []);
  return result;
}

function targetOptions(policy, isSpecial, dayShiftIds) {
  if (isSpecial) return [Object.fromEntries(dayShiftIds.map((id) => [id, policy.preferred[id]]))];
  const options = [];
  const recurse = (index, current) => {
    if (index === dayShiftIds.length) {
      options.push({ ...current });
      return;
    }
    const id = dayShiftIds[index];
    for (let count = policy.preferred[id]; count >= policy.minimum[id]; count -= 1) recurse(index + 1, { ...current, [id]: count });
  };
  recurse(0, {});
  return options;
}

export function buildDayPatterns({ day, fixedToday, avoidToday = {}, members, config, nightId }) {
  const policy = day.isSpecial ? config.coverage.special : config.coverage.weekday;
  const dayShiftIds = config.shifts.filter((shift) => !shift.night).sort((a, b) => a.level - b.level).map((shift) => shift.id);
  const base = members.map((member) => fixedToday[member.id] ?? null);
  const byOwner = new Map();

  members.forEach((owner, ownerIndex) => {
    if (!owner.eligibleShifts.includes(nightId) || !isActive(owner, day.date) || avoidToday[owner.id]?.has(nightId)) return;
    if (base[ownerIndex] !== null && base[ownerIndex] !== nightId) return;
    if (base.some((code, index) => index !== ownerIndex && code === nightId)) return;
    const assigned = [...base];
    assigned[ownerIndex] = nightId;
    const free = assigned.map((code, index) => (code === null ? index : -1)).filter((index) => index >= 0);
    const fixedCount = Object.fromEntries(dayShiftIds.map((id) => [id, assigned.filter((code) => code === id).length]));
    const seen = new Set();
    const patterns = [];
    for (const target of targetOptions(policy, day.isSpecial, dayShiftIds)) {
      const needs = dayShiftIds.map((id) => target[id] - fixedCount[id]);
      if (day.isSpecial && needs.some((need) => need < 0)) continue;
      const expand = (shiftIndex, remaining, codes) => {
        if (shiftIndex === dayShiftIds.length) {
          const finished = codes.map((code) => code ?? "H");
          const key = finished.join("");
          if (!seen.has(key)) {
            seen.add(key);
            patterns.push(finished);
          }
          return;
        }
        const id = dayShiftIds[shiftIndex];
        const need = Math.max(0, needs[shiftIndex]);
        const eligible = remaining.filter((index) => members[index].eligibleShifts.includes(id) && !avoidToday[members[index].id]?.has(id));
        for (const chosen of combinations(eligible, need)) {
          const next = [...codes];
          for (const index of chosen) next[index] = id;
          const chosenSet = new Set(chosen);
          expand(shiftIndex + 1, remaining.filter((index) => !chosenSet.has(index)), next);
        }
      };
      expand(0, free, assigned);
    }
    if (patterns.length > 0) byOwner.set(owner.id, patterns);
  });

  if (byOwner.size === 0) {
    throw new RosterError(
      `Tidak ada susunan yang mungkin pada ${formatTanggal(day.date, { denganHari: true })}: ${explainImpossibleDay({ day, fixedToday, avoidToday, members, policy, shiftIds: [...dayShiftIds, nightId] })}\n` +
        'Pilihan: geser salah satu cuti atau permintaan di tanggal itu, atau tambahkan orang luar tim sebagai anggota sementara di sheet Anggota (isi "Mulai Bergabung" dan "Terakhir Bekerja" dengan tanggal itu, lalu shift yang boleh).',
      { date: day.date }
    );
  }
  return byOwner;
}

const UNAVAILABLE_REASON = Object.freeze({ C: "cuti", S: "sakit", T: "training/dinas", H: "minta libur", "-": "tidak aktif" });

// Which shift cannot be filled on a day, and why each person is unavailable.
function explainImpossibleDay({ day, fixedToday, avoidToday = {}, members, policy, shiftIds }) {
  const reason = (member, shiftId) => {
    if (!isActive(member, day.date)) return "tidak aktif";
    const code = fixedToday[member.id];
    if (code === undefined && avoidToday[member.id]?.has(shiftId)) return `minta tidak ${KODE_LABEL[shiftId] ?? shiftId}`;
    return UNAVAILABLE_REASON[code] ?? (code ? `diminta ${KODE_LABEL[code] ?? code}` : null);
  };
  const lines = [];
  for (const shiftId of shiftIds) {
    const allowed = members.filter((member) => member.eligibleShifts.includes(shiftId));
    const free = allowed.filter((member) => isActive(member, day.date) && (fixedToday[member.id] === undefined || fixedToday[member.id] === shiftId) && !avoidToday[member.id]?.has(shiftId));
    if (free.length >= (policy.minimum[shiftId] ?? 1)) continue;
    const busy = allowed.map((member) => `${member.name} ${reason(member, shiftId) ?? "tidak tersedia"}`);
    const notAllowed = members.filter((member) => !member.eligibleShifts.includes(shiftId)).map((member) => member.name);
    lines.push(`Shift ${shiftId} tidak bisa diisi (${busy.join(", ")}${notAllowed.length ? `; ${daftarNama(notAllowed)} tidak boleh Shift ${shiftId}` : ""}).`);
  }
  if (lines.length > 0) return lines.join(" ");
  const free = members.filter((member) => isActive(member, day.date) && fixedToday[member.id] === undefined).map((member) => member.name);
  return `hanya ${free.length} orang yang bisa dijadwalkan (${daftarNama(free)}), tidak cukup untuk Shift 1, 2 dan 3 sekaligus.`;
}
