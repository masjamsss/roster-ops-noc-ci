// Beam search over days. Each node carries every member's state and the night
// rotation state; nodes with identical future-relevant state are merged, and
// only the best `width` nodes survive each day.
import { RosterError } from "./errors.mjs";
import { formatTanggal, KODE_LABEL } from "./labels-id.mjs";
import { nightOptions } from "./night-rotation.mjs";
import { dayScore } from "./objective.mjs";
import { canTransition, explainTransition, transitionMember } from "./rules.mjs";

function category(code, shiftIds) {
  if (shiftIds.includes(code) || code === "T") return "w";
  return code === "H" ? "h" : "o";
}

// cyrb53: a fast 53-bit string hash. Candidates are indexed by the hash of their
// state text instead of the text itself, which keeps memory low on wide searches
// (collision chance for a million candidates is about 1 in 10,000).
function hash53(text) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

function stateKey(states, night, members, shiftIds, blockCap) {
  let key = `${night.owner}:${night.length}:${night.queue.join(",")}`;
  for (let index = 0; index < states.length; index += 1) {
    const s = states[index];
    key += `|${s.previousCode}${category(s.previousPreviousCode, shiftIds)}${s.workStreak}.${s.offStreak}.${Math.min(s.restStreak, 3)}.${Math.min(s.shiftStreak, 3)}.${s.lastWorkedShift ?? "x"}${s.lastWorkWasNight ? "n" : ""}${s.nightStreak}.${Math.min(s.lastWorkBlockLength, blockCap)}.${s.workCount}.${s.weekendWorkCount}.${Math.min(s.fullWeekendsOff, 2)}`;
    if (members[index].dayOnly) key += `.${s.s1Count - s.s2Count}`;
    else key += `.${Math.min(s.daysSinceNight ?? 99, 7)}`;
    key += `w${Math.min(s.weekHours ?? 0, 41)}`;
  }
  return key;
}

// Rest pattern of a node: who is how deep into a work streak, who is resting.
// Keeping a variety of these stops the beam from committing everyone to the
// same rest days (e.g. both day-only members working Mon-Fri before a weekend
// that needs exactly one of them).
function restProfile(node) {
  let key = `${node.night.owner}${node.night.length}`;
  for (const s of node.states) key += `,${s.workStreak}${s.offStreak > 0 ? "h" : ""}`;
  return key;
}

// Cheap necessary condition for staffing the next day from this node.
function canStaffNextDay({ node, day, fixedToday, fixedTomorrow, members, ctx, config, memberById, indexById }) {
  if (!day) return true;
  const states = { get: (id) => node.states[indexById.get(id)] };
  const options = nightOptions({ night: node.night, day, fixedToday, fixedTomorrow, states, members, ctx, memberById });
  if (options.length === 0) return false;
  const policy = day.isSpecial ? config.coverage.special : config.coverage.weekday;
  const dayShifts = config.shifts.filter((shift) => !shift.night);
  const slots = dayShifts.reduce((sum, shift) => sum + policy.minimum[shift.id], 0);
  for (const option of options) {
    const able = Object.fromEntries(dayShifts.map((shift) => [shift.id, 0]));
    let anyShift = 0;
    let mustWork = 0;
    members.forEach((member, i) => {
      if (member.id === option.owner) return;
      const fixed = fixedToday[member.id];
      if (fixed !== undefined) {
        if (able[fixed] !== undefined) {
          able[fixed] += 1;
          anyShift += 1;
        }
        return;
      }
      let can = false;
      for (const shift of dayShifts) {
        if (member.eligibleShifts.includes(shift.id) && canTransition(node.states[i], member, shift.id, day, ctx)) {
          able[shift.id] += 1;
          can = true;
        }
      }
      if (can) anyShift += 1;
      if (!canTransition(node.states[i], member, "H", day, ctx)) mustWork += can ? 1 : 0;
    });
    const enough = dayShifts.every((shift) => able[shift.id] >= policy.minimum[shift.id]) && anyShift >= slots;
    const exactOk = !day.isSpecial || mustWork <= dayShifts.reduce((sum, shift) => sum + policy.preferred[shift.id], 0);
    if (enough && exactOk) return true;
  }
  return false;
}

function withoutName(reason, name) {
  return reason.startsWith(`${name} `) ? reason.slice(name.length + 1) : reason;
}

export function diagnoseDeadEnd({ node, day, fixedToday, fixedTomorrow, members, ctx, config, memberById, indexById }) {
  const states = { get: (id) => node.states[indexById.get(id)] };
  const nightId = ctx.nightShiftId;
  const lines = [];
  const reasonFor = (member, code) => {
    const fixedCode = fixedToday[member.id];
    if (fixedCode !== undefined && fixedCode !== code) return KODE_LABEL[fixedCode] ?? fixedCode;
    const reason = explainTransition(node.states[indexById.get(member.id)], member, code, day, ctx, { requested: fixedCode !== undefined });
    return reason ? withoutName(reason, member.name) : "";
  };
  if (nightOptions({ night: node.night, day, fixedToday, fixedTomorrow, states, members, ctx, memberById }).length === 0) {
    const reasons = members
      .filter((member) => member.eligibleShifts.includes(nightId))
      .map((member) => `${member.name} (${reasonFor(member, nightId) || "tidak bisa menyelesaikan blok 2 malam berturut-turut"})`);
    lines.push(`- Shift 3: tidak ada yang bisa masuk. ${reasons.join("; ")}.`);
  }
  const policy = day.isSpecial ? config.coverage.special : config.coverage.weekday;
  for (const shift of config.shifts.filter((item) => !item.night)) {
    const able = [];
    const blocked = [];
    for (const member of members) {
      const reason = member.eligibleShifts.includes(shift.id) ? reasonFor(member, shift.id) : `tidak boleh ${shift.label}`;
      if (reason) blocked.push(`${member.name} (${reason})`);
      else able.push(member.name);
    }
    if (able.length < policy.minimum[shift.id]) lines.push(`- ${shift.label}: hanya ${able.length} orang yang bisa masuk. ${blocked.join("; ")}.`);
  }
  if (lines.length === 0) {
    lines.push("- Setiap shift punya calon, tetapi tidak ada kombinasi yang memenuhi semua aturan sekaligus (biasanya terlalu banyak orang harus libur di hari yang sama).");
  }
  return new RosterError(
    `Roster tidak bisa disusun: masalah pada ${formatTanggal(day.date, { denganHari: true })}.\n${lines.join("\n")}\n` +
      'Saran: periksa cuti, training dan permintaan di sekitar tanggal ini (terlalu banyak orang tidak tersedia bersamaan), atau kurangi jumlah orang per shift di sheet "Kebutuhan Shift".',
    { date: day.date }
  );
}

export function runBeamSearch({ members, days, fixed, patternsPerDay, initialStates, initialNight, ctx, config, env, onProgress }) {
  const count = members.length;
  const indexById = new Map(members.map((member, index) => [member.id, index]));
  const memberById = new Map(members.map((member) => [member.id, member]));
  const blockCap = config.rules.maxConsecutiveWorkDays;
  let beam = [{ score: 0, states: initialStates, night: initialNight, parent: null, codes: null }];
  const log = [];

  for (let d = 0; d < days.length; d += 1) {
    const day = days[d];
    const fixedToday = fixed[d];
    const fixedTomorrow = fixed[d + 1] ?? {};
    const byOwner = patternsPerDay[d];
    let largest = 1;
    for (const list of byOwner.values()) largest = Math.max(largest, list.length);
    const width = Math.max(config.search.minBeamWidth, Math.min(config.search.beamWidth, Math.floor(config.search.maxTransitionsPerDay / (largest * 2 * count))));
    const requested = members.map((member) => ({ requested: fixedToday[member.id] !== undefined }));
    const next = new Map();

    for (const node of beam) {
      const states = { get: (id) => node.states[indexById.get(id)] };
      // Each member has only a handful of possible codes today, so compute each
      // (member, code) move once per node instead of once per pattern.
      const moves = members.map(() => new Map());
      const move = (i, code) => {
        let result = moves[i].get(code);
        if (result === undefined) {
          result = transitionMember(node.states[i], members[i], code, day, ctx, requested[i]);
          moves[i].set(code, result);
        }
        return result;
      };
      for (const option of nightOptions({ night: node.night, day, fixedToday, fixedTomorrow, states, members, ctx, memberById })) {
        const patterns = byOwner.get(option.owner);
        if (!patterns) continue;
        for (const codes of patterns) {
          let score = node.score;
          const nextStates = new Array(count);
          let valid = true;
          for (let i = 0; i < count; i += 1) {
            const moved = move(i, codes[i]);
            if (moved === null) {
              valid = false;
              break;
            }
            nextStates[i] = moved.state;
            score += moved.score;
          }
          if (!valid) continue;
          score += dayScore(codes, day, nextStates, members, config, env);
          const key = hash53(stateKey(nextStates, option.night, members, ctx.shiftIds, blockCap));
          const existing = next.get(key);
          if (existing === undefined || score < existing.score) next.set(key, { score, states: nextStates, night: option.night, parent: node, codes });
        }
      }
    }

    if (next.size === 0) throw diagnoseDeadEnd({ node: beam[0], day, fixedToday, fixedTomorrow, members, ctx, config, memberById, indexById });
    const tomorrow = days[d + 1];
    const lookahead = { day: tomorrow, fixedToday: fixed[d + 1] ?? {}, fixedTomorrow: fixed[d + 2] ?? {}, members, ctx, config, memberById, indexById };
    const profileCap = config.search.profileCap ?? Math.max(3, Math.ceil(width / 100));
    const kept = [];
    const overflow = [];
    const perProfile = new Map();
    let pruned = 0;
    for (const node of [...next.values()].sort((left, right) => left.score - right.score)) {
      if (kept.length >= width) break;
      if (!canStaffNextDay({ node, ...lookahead })) {
        pruned += 1;
        continue;
      }
      const profile = restProfile(node);
      const used = perProfile.get(profile) ?? 0;
      if (used < profileCap) {
        kept.push(node);
        perProfile.set(profile, used + 1);
      } else overflow.push(node);
    }
    for (const node of overflow) {
      if (kept.length >= width) break;
      kept.push(node);
    }
    if (kept.length === 0) throw diagnoseDeadEnd({ node: [...next.values()][0], day: tomorrow, fixedToday: fixed[d + 1] ?? {}, fixedTomorrow: fixed[d + 2] ?? {}, members, ctx, config, memberById, indexById });
    beam = kept.sort((left, right) => left.score - right.score);
    log.push({ date: day.date, width, candidates: next.size, pruned, kept: beam.length, best: Math.round(beam[0].score) });
    onProgress?.(d + 1, days.length);
  }
  return { best: beam[0], log };
}
