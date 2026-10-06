// Proof-backed polishing (user, 6 Oct: "find the best of the best"). After the
// best roster is chosen, parts of it are searched completely, every possibility,
// while the rest of the roster stays as it is:
//  - one person for the whole month (each person),
//  - everyone for 2 days in a row (every window),
//  - two people for the whole month (every pair),
//  - everyone for 3 days in a row (every window).
// A part is "complete" when no distinct state had to be dropped (exact state keys,
// nothing pruned); then "no better roster by changing only this part" is certain.
// A better roster (in the engine's order: serious findings, people below 65 on
// work-life, score) is kept and the round starts again. It ends when a whole
// round finds nothing better (a local optimum for all these parts) or at the time
// limit. Measured on the real November 2026: the normal result was already
// optimal for every part that could be searched completely.
import { scoreSchedule } from "./objective.mjs";
import { betterThan, WLB_LOW } from "./perfect.mjs";
import { runBeamSearch } from "./search.mjs";
import { describeCandidate } from "./variant-run.mjs";

export const REFINE_WIDTH = 30_000;
// More distinct states than this on one day: the part is skipped (memory stays
// within a few hundred MB, also on an 8 GB office PC).
export const REFINE_MAX_CANDIDATES = 120_000;

// The quality of a complete roster in the engine's order of preference.
export function judge(input, codes) {
  const { members, days, fixed, initialStates, ctx, config, env } = input;
  const scored = scoreSchedule({ codes, members, days, initialStates, ctx, config, fixed, env });
  if (!scored.valid) return null;
  const described = describeCandidate(input, codes);
  return {
    total: scored.total,
    serious: described.quality.serious,
    wlbLow: described.wellbeing.members.filter((item) => item.score !== null && item.score < WLB_LOW).length,
    wlbTeam: described.wellbeing.team
  };
}

// Search every possibility for the cells where `freed(memberIndex, dayIndex)` is
// true, every other cell keeping its code. Returns { codes, nights, complete } or
// { tooLarge: true } / null (no valid roster through the fixed cells).
export function rebuildPart(input, codes, freed, { width = REFINE_WIDTH, maxCandidates = REFINE_MAX_CANDIDATES, deadline = Infinity } = {}) {
  const { members, days, fixed, patternsPerDay, initialStates, initialNight, ctx, config, env } = input;
  const nightId = ctx.nightShiftId;
  const patterns = days.map((_, d) => {
    const current = members.map((__, i) => codes[i][d]);
    const pinned = members.map((__, i) => !freed(i, d));
    const owner = members[current.indexOf(nightId)]?.id;
    if (pinned.every(Boolean)) return new Map([[owner, [current]]]);
    const byOwner = new Map();
    for (const [nightOwner, list] of patternsPerDay[d]) {
      const kept = list.filter((pattern) => pattern.every((code, i) => !pinned[i] || code === current[i]));
      if (kept.length) byOwner.set(nightOwner, kept);
    }
    // The current day is always one of the options (it may come from the polish).
    if (!byOwner.get(owner)?.some((pattern) => pattern.every((code, i) => code === current[i]))) byOwner.set(owner, [...(byOwner.get(owner) ?? []), current]);
    return byOwner;
  });
  const runConfig = { ...config, search: { ...config.search, beamWidth: width, minBeamWidth: Math.min(width, config.search.minBeamWidth), maxTransitionsPerDay: Number.MAX_SAFE_INTEGER } };
  let run;
  try {
    run = runBeamSearch({ members, days, fixed, patternsPerDay: patterns, initialStates, initialNight, ctx: { ...ctx, nightChoices: Infinity }, config: runConfig, env, exactKeys: true, maxCandidates, deadline });
  } catch (error) {
    if (error.name === "RosterError") return null;
    throw error;
  }
  if (run.tooLarge) return { tooLarge: true, timedOut: Boolean(run.timedOut) };
  const path = [];
  for (let node = run.best; node && node.codes; node = node.parent) path.push(node);
  path.reverse();
  return {
    codes: members.map((_, i) => path.map((node) => node.codes[i])),
    nights: path.map((node) => node.night),
    complete: run.log.every((entry) => entry.candidates <= width)
  };
}

// Every part of the four kinds, in this order (quick ones first).
function partsOf(members, published) {
  const parts = [];
  members.forEach((_, i) => parts.push({ kind: "satu-orang", freed: (m, d) => m === i && d < published }));
  for (let from = 0; from + 2 <= published; from += 1) parts.push({ kind: "dua-hari", freed: (m, d) => d >= from && d < from + 2 });
  for (let a = 0; a < members.length; a += 1) {
    for (let b = a + 1; b < members.length; b += 1) parts.push({ kind: "dua-orang", freed: (m, d) => (m === a || m === b) && d < published });
  }
  for (let from = 0; from + 3 <= published; from += 1) parts.push({ kind: "tiga-hari", freed: (m, d) => d >= from && d < from + 3 });
  return parts;
}

export function polishByCompleteParts(input, start, { budgetMs = 90_000, width = REFINE_WIDTH, maxCandidates = REFINE_MAX_CANDIDATES, clock = Date.now } = {}) {
  const started = clock();
  const parts = partsOf(input.members, input.env.publishedCount);
  let best = { codes: start.codes.map((row) => [...row]), nights: null, ...judge(input, start.codes) };
  const first = { total: best.total, serious: best.serious, wlbLow: best.wlbLow };
  let improved = 0;
  let rounds = 0;
  let checked = null;
  let finished = false;
  while (!finished && clock() - started < budgetMs) {
    rounds += 1;
    checked = Object.fromEntries(["satu-orang", "dua-hari", "dua-orang", "tiga-hari"].map((kind) => [kind, { parts: 0, complete: 0, tooLarge: 0 }]));
    let changed = false;
    for (const part of parts) {
      if (clock() - started >= budgetMs) break;
      const tally = checked[part.kind];
      tally.parts += 1;
      const rebuilt = rebuildPart(input, best.codes, part.freed, { width, maxCandidates, deadline: started + budgetMs });
      if (!rebuilt) continue;
      if (rebuilt.timedOut) {
        tally.parts -= 1;
        break;
      }
      if (rebuilt.tooLarge) {
        tally.tooLarge += 1;
        continue;
      }
      if (rebuilt.complete) tally.complete += 1;
      const judged = judge(input, rebuilt.codes);
      if (judged && betterThan(judged, best) && (judged.serious < best.serious || judged.wlbLow < best.wlbLow || judged.total < best.total - 1e-6)) {
        best = { codes: rebuilt.codes, nights: rebuilt.nights, ...judged };
        improved += 1;
        changed = true;
      }
    }
    // A whole round over every part without a better roster: done.
    finished = !changed && Object.values(checked).reduce((sum, tally) => sum + tally.parts, 0) === parts.length;
  }
  return { ...best, first, improved, rounds, checked, finished, ms: clock() - started };
}
