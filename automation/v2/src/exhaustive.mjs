// Last resort for very low availability (user, 5 Oct: "can the script still find
// a way, or say why not?"). The normal search keeps the best few thousand partial
// rosters day by day, and in a very tight month all of them can dead-end although
// a valid roster exists (measured: two night workers for half of November, where
// the only way needs 3-night blocks the normal search avoids). Two tools:
//  - nightCoverageCheck: a quick proof that a month cannot be covered, from the
//    night blocks (2-3 nights, then rest days, who is available) and the people
//    left for the day shifts each day (not on nights, not resting after them, not
//    away). It is deliberately more permissive than the real rules (the work-day
//    limit, days off in a row and rest hours are left out), so "impossible" here
//    is certain.
//  - exhaustiveSearch: depth-first over the hard-rule state only, anyone available
//    may start a night block, and every (day, state) that cannot be completed is
//    remembered so it is never tried twice. It finds a valid roster when one
//    exists, proves there is none, or stops at the time limit.
import { isOffLike } from "./codes.mjs";
import { SHORT_SICK_MAX_DAYS } from "./history.mjs";
import { daftarNama, formatTanggal } from "./labels-id.mjs";
import { nightOptions } from "./night-rotation.mjs";
import { dayScore } from "./objective.mjs";
import { isActive, nightBlockedAfterSick, transitionMember } from "./rules.mjs";

export const EXHAUSTIVE_BUDGET_MS = 120_000;
const MAX_REMEMBERED = 3_000_000;

const ABSENT = Object.freeze({ C: "cuti", S: "sakit", T: "training/dinas", H: "minta libur", 1: "minta Shift 1", 2: "minta Shift 2" });

export function nightCoverageCheck({ days, members, fixed, initialStates, initialNight, ctx, config }) {
  const nightId = ctx.nightShiftId;
  const { nightBlock: block, nightRecoveryOffDays: recovery } = ctx.rules;
  const men = members.map((_, i) => i).filter((i) => members[i].eligibleShifts.includes(nightId));
  // Sickness only comes from fixed "S" cells, so the no-night days after it are known in advance.
  const sickBlocked = men.map((i) => {
    let state = { daysSinceSick: initialStates[i].daysSinceSick, daysSinceLongSick: initialStates[i].daysSinceLongSick, sickRun: initialStates[i].sickRun ?? 0 };
    return days.map((day, d) => {
      const blocked = nightBlockedAfterSick(state, ctx.rules);
      const sick = fixed[d][members[i].id] === "S";
      const sickRun = sick ? state.sickRun + 1 : 0;
      state = {
        daysSinceSick: sick ? 0 : Math.min(99, (state.daysSinceSick ?? 99) + 1),
        sickRun,
        daysSinceLongSick: sick && sickRun > SHORT_SICK_MAX_DAYS ? 0 : Math.min(99, (state.daysSinceLongSick ?? 99) + 1)
      };
      return blocked;
    });
  });
  // Why man k cannot hold Shift 3 on day d (null = he can, as far as fixed cells tell).
  const why = (k, d) => {
    const member = members[men[k]];
    const code = fixed[d][member.id];
    if (!isActive(member, days[d].date)) return "tidak aktif";
    if (code !== undefined && code !== nightId) return ABSENT[code] ?? `kode ${code}`;
    if (ctx.avoid?.[d]?.[member.id]?.has(nightId)) return "minta tidak Shift 3";
    if (code !== nightId && sickBlocked[k][d]) return "baru kembali dari sakit";
    return null;
  };
  const can = days.map((_, d) => men.map((_, k) => why(k, d) === null));
  const must = days.map((_, d) => men.findIndex((i) => fixed[d][members[i].id] === nightId));

  // Day shifts: everyone who may work a day shift today, given who holds the night
  // and who rests after one. Each day shift needs its minimum of distinct people
  // (Hall's condition over every set of day shifts).
  const dayShifts = config.shifts.filter((shift) => !shift.night).map((shift) => shift.id);
  const subsets = [];
  for (let mask = 1; mask < 1 << dayShifts.length; mask += 1) subsets.push(dayShifts.filter((_, bit) => mask & (1 << bit)));
  const manOf = new Map(men.map((i, k) => [i, k]));
  const dayPool = (d, nightK, resting) => members.map((member, i) => {
    const code = fixed[d][member.id];
    if (!isActive(member, days[d].date) || (code !== undefined && !dayShifts.includes(code))) return null;
    const k = manOf.get(i);
    if (k !== undefined && (k === nightK || resting(k))) return null;
    const allowed = dayShifts.filter((id) => member.eligibleShifts.includes(id) && !ctx.avoid?.[d]?.[member.id]?.has(id) && (code === undefined || code === id));
    return allowed.length ? { name: member.name, allowed } : null;
  }).filter(Boolean);
  const daysCovered = (d, pool) => {
    const minimum = (days[d].isSpecial ? config.coverage.special : config.coverage.weekday).minimum;
    return subsets.every((set) => pool.filter((person) => person.allowed.some((id) => set.includes(id))).length >= set.reduce((sum, id) => sum + (minimum[id] ?? 0), 0));
  };

  const start = {
    owner: men.findIndex((i) => members[i].id === initialNight.owner),
    length: initialNight.owner ? initialNight.length : 0,
    rest: men.map((i) => {
      const s = initialStates[i];
      if (s.previousCode === nightId) return 0; // still in the block; the rest days start when it ends
      return s.lastWorkWasNight && isOffLike(s.previousCode) ? Math.max(0, recovery - s.restStreak) : 0;
    })
  };
  const keyOf = (state) => `${state.owner}:${state.length}:${state.rest.join("")}`;
  let frontier = new Map([[keyOf(start), start]]);
  for (let d = 0; d < days.length; d += 1) {
    const day = days[d];
    const next = new Map();
    let nightsOnly = false;
    let bestPool = [];
    for (const state of frontier.values()) {
      // Today the night holder works nights, and whoever rests (still, or because
      // his block ended yesterday) cannot work a day shift.
      const add = (candidate) => {
        const ended = state.owner >= 0 && state.length > 0 && candidate.owner !== state.owner ? state.owner : -1;
        const pool = dayPool(d, candidate.owner, (k) => state.rest[k] > 0 || k === ended);
        if (pool.length > bestPool.length) bestPool = pool;
        if (daysCovered(d, pool)) next.set(keyOf(candidate), candidate);
        else nightsOnly = true;
      };
      const restAfter = (owner) => state.rest.map((left, k) => (k === owner ? 0 : k === state.owner && state.length > 0 ? recovery - 1 : Math.max(0, left - 1)));
      const carryOn = () => add({ owner: state.owner, length: state.length + 1, rest: state.rest.map((left, k) => (k === state.owner ? 0 : Math.max(0, left - 1))) });
      const startBlock = (k) => add({ owner: k, length: 1, rest: restAfter(k) });
      if (must[d] >= 0) {
        // A requested night (also the requested continuation on the 1st).
        if (must[d] === state.owner && state.length > 0) carryOn();
        else if (state.rest[must[d]] === 0) startBlock(must[d]);
        continue;
      }
      const continuing = state.owner >= 0 && state.length > 0 && !day.isFirstOfMonth;
      if (continuing) {
        const canContinue = state.length < block.max && can[d][state.owner];
        if (canContinue) carryOn();
        if (state.length < block.min) continue;
      }
      if (day.isLastOfMonth && block.min > 1) continue;
      men.forEach((_, k) => {
        if (k === state.owner && state.length > 0) return;
        if (!can[d][k] || state.rest[k] > 0) return;
        if (block.min > 1 && day.hasTomorrow && can[d + 1] && !can[d + 1][k]) return;
        startBlock(k);
      });
    }
    if (next.size === 0 && nightsOnly) {
      const labels = config.shifts.filter((shift) => !shift.night).map((shift) => shift.label);
      const away = members.map((member) => {
        const code = fixed[d][member.id];
        if (!isActive(member, day.date)) return `${member.name} (tidak aktif)`;
        return code !== undefined && !dayShifts.includes(code) && code !== nightId ? `${member.name} (${ABSENT[code] ?? `kode ${code}`})` : null;
      }).filter(Boolean);
      return {
        ok: false, dayIndex: d, date: day.date,
        reason: `${labels.join(" dan ")} tidak mungkin terisi pada ${formatTanggal(day.date, { denganHari: true })}: yang memegang Shift 3 atau baru selesai Shift 3 (wajib libur ${recovery} hari) tidak bisa masuk pagi/siang` +
          `${away.length ? `, dan ${away.join(", ")}` : ""}. Paling banyak yang bisa masuk pagi/siang: ${bestPool.length ? daftarNama(bestPool.map((person) => person.name)) : "tidak ada"}.`
      };
    }
    if (next.size === 0) {
      const from = Math.max(0, d - block.max - recovery);
      const able = days.slice(from, d + 1).map((item, offset) => {
        const names = men.filter((_, k) => can[from + offset][k]).map((i) => members[i].name);
        return `${formatTanggal(item.date, { pendek: true })} ${names.length ? daftarNama(names) : "tidak ada"}`;
      });
      const away = men.map((i, k) => (why(k, d) ? `${members[i].name} (${why(k, d)})` : null)).filter(Boolean);
      return {
        ok: false, dayIndex: d, date: day.date,
        reason: `Shift 3 tidak mungkin terisi pada ${formatTanggal(day.date, { denganHari: true })}. Satu orang paling banyak ${block.max} malam berturut-turut, lalu wajib ${recovery} hari libur, ` +
          `sedangkan yang bisa Shift 3 hanya: ${able.join("; ")}.${away.length ? ` Pada tanggal itu: ${away.join(", ")}.` : ""}`
      };
    }
    frontier = next;
  }
  return { ok: true };
}

// Hard-rule state only: what the rules look at, nothing the soft goals count.
function stateKey(states, night, recovery) {
  let key = `${night.owner}:${night.length}`;
  for (const s of states) {
    key += `|${s.previousCode}${s.workStreak}.${s.offStreak}.${s.nightStreak}.${s.lastWorkWasNight ? 1 : 0}.${Math.min(s.restStreak, recovery)}` +
      `.${Math.min(s.daysSinceSick ?? 99, 15)}.${Math.min(s.daysSinceLongSick ?? 99, 15)}.${Math.min(s.sickRun ?? 0, SHORT_SICK_MAX_DAYS + 1)}`;
  }
  return key;
}

export function exhaustiveSearch(input, { budgetMs = EXHAUSTIVE_BUDGET_MS, clock = Date.now } = {}) {
  const { days, members, fixed, patternsPerDay, initialStates, initialNight, ctx, config, env } = input;
  const fullCtx = { ...ctx, nightChoices: Infinity };
  const recovery = ctx.rules.nightRecoveryOffDays;
  const memberById = new Map(members.map((member) => [member.id, member]));
  const indexById = new Map(members.map((member, index) => [member.id, index]));
  const failed = days.map(() => new Set());
  const started = clock();
  let remembered = 0;
  let stopped = false;
  let deepest = { dayIndex: 0, node: { states: initialStates, night: initialNight } };
  const path = [];

  // Every valid next day from a node, cheapest first (the normal day score), so
  // the first complete roster found is a reasonable one.
  const successors = (node, d) => {
    const day = days[d];
    const fixedToday = fixed[d];
    const requested = members.map((member) => ({ requested: fixedToday[member.id] !== undefined }));
    const states = { get: (id) => node.states[indexById.get(id)] };
    const moves = members.map(() => new Map());
    const move = (i, code) => {
      let result = moves[i].get(code);
      if (result === undefined) {
        result = transitionMember(node.states[i], members[i], code, day, fullCtx, requested[i]);
        moves[i].set(code, result);
      }
      return result;
    };
    const list = [];
    const seen = new Set();
    for (const option of nightOptions({ night: node.night, day, fixedToday, fixedTomorrow: fixed[d + 1] ?? {}, states, members, ctx: fullCtx, memberById })) {
      for (const codes of patternsPerDay[d].get(option.owner) ?? []) {
        const nextStates = new Array(members.length);
        let score = 0;
        let valid = true;
        for (let i = 0; i < members.length; i += 1) {
          const moved = move(i, codes[i]);
          if (moved === null) {
            valid = false;
            break;
          }
          nextStates[i] = moved.state;
          score += moved.score;
        }
        if (!valid) continue;
        const key = stateKey(nextStates, option.night, recovery);
        if (seen.has(key) || failed[d + 1]?.has(key)) continue;
        seen.add(key);
        list.push({ states: nextStates, night: option.night, codes, key, score: score + dayScore(codes, day, nextStates, members, config, env) });
      }
    }
    return list.sort((left, right) => left.score - right.score);
  };

  const search = (node, d) => {
    if (d === days.length) return true;
    if (d > deepest.dayIndex) deepest = { dayIndex: d, node };
    if (clock() - started > budgetMs || remembered > MAX_REMEMBERED) {
      stopped = true;
      return false;
    }
    for (const next of successors(node, d)) {
      path[d] = next;
      if (search(next, d + 1)) return true;
      if (stopped) return false;
      if (d + 1 < days.length) {
        failed[d + 1].add(next.key);
        remembered += 1;
      }
    }
    return false;
  };

  const found = search({ states: initialStates, night: initialNight }, 0);
  const ms = clock() - started;
  if (found) {
    const codes = members.map((_, i) => path.map((step) => step.codes[i]));
    return { status: "found", codes, nights: path.map((step) => step.night), ms };
  }
  return { status: stopped ? "timeout" : "impossible", ms, deepest: { ...deepest, date: days[deepest.dayIndex].date } };
}
