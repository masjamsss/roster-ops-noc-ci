// One search variant: beam search, swap polishing, score with the normal
// weights, and the automatic quality review. Pure computation, so it gives the
// same result inline or inside a worker thread (best-result mode runs several
// variants in parallel).
import { improveBySwaps } from "./local-search.mjs";
import { computeDayRows, computeMemberSummary } from "./metrics.mjs";
import { scoreSchedule } from "./objective.mjs";
import { reviewQuality } from "./quality.mjs";
import { WLB_LOW } from "./perfect.mjs";
import { runBeamSearch } from "./search.mjs";
import { workLifeBalance } from "./wellbeing.mjs";

// Summary, day rows and quality review of a candidate roster (codes[member][day]).
export function describeCandidate(input, codes) {
  const { members, days, ctx, config, env, historyCodes, historyDates, shiftIds, nightId } = input;
  const summary = computeMemberSummary({ members, days, codes, historyCodes, historyDates, shiftIds, nightId, env, netHours: ctx.netHours, weeklyHoursLimit: ctx.weeklyHoursLimit, dailyHoursLimit: ctx.dailyHoursLimit });
  const dayRows = computeDayRows({ days, codes, members, config });
  const publishedDays = days.filter((day) => day.published);
  const schedule = Object.fromEntries(members.map((member, i) => [member.id, Object.fromEntries(publishedDays.map((day) => [day.date, codes[i][day.dayIndex]]))]));
  const history = { codesById: Object.fromEntries(members.map((member, i) => [member.id, historyCodes[i] ?? []])) };
  const quality = reviewQuality({ members, days: dayRows, schedule, memberSummary: summary, settings: { rules: config.rules }, history });
  const wellbeing = workLifeBalance({ members, days: dayRows, schedule, memberSummary: summary, settings: { rules: config.rules }, history });
  return { summary, dayRows, quality, wellbeing };
}

// `variant` steers the search: other search settings, weights scaled by a
// factor (`weightScale`) or set (`weights`). Scoring always uses the normal weights.
export function runVariant(input, variant, onProgress) {
  const { members, days, fixed, patternsPerDay, initialStates, initialNight, ctx, config, env } = input;
  const scaled = Object.fromEntries(Object.entries(variant.weightScale ?? {}).map(([key, factor]) => [key, (config.weights[key] ?? 0) * factor]));
  const runConfig = { ...config, weights: { ...config.weights, ...scaled, ...(variant.weights ?? {}) }, search: { ...config.search, ...(variant.search ?? {}) } };
  if (variant.search?.beamScale) runConfig.search.beamWidth = Math.round(config.search.beamWidth * variant.search.beamScale);
  const runCtx = { ...ctx, weights: runConfig.weights, nightChoices: runConfig.search.nightChoices ?? ctx.nightChoices };
  const run = runBeamSearch({ members, days, fixed, patternsPerDay, initialStates, initialNight, ctx: runCtx, config: runConfig, env, onProgress });
  const path = [];
  for (let node = run.best; node && node.codes; node = node.parent) path.push(node);
  path.reverse();
  const codes = members.map((_, i) => path.map((node) => node.codes[i]));
  return finishCandidate(input, codes, { searchLog: run.log, nightQueueAfterMonth: path[env.lastPublishedIndex].night.queue });
}

// Swap polishing, the score with the normal weights and (best-result mode) the
// quality review of a complete roster: a beam variant's, or the complete search's.
export function finishCandidate(input, startCodes, extra = {}) {
  const { members, days, fixed, initialStates, ctx, config, env } = input;
  let codes = startCodes;
  const before = scoreSchedule({ codes, members, days, initialStates, ctx, config, fixed, env }).total;
  let localLog = [];
  if (config.localSearch.enabled) {
    const improved = improveBySwaps({ codes, members, days, fixed, initialStates, ctx, config, env });
    codes = improved.codes;
    localLog = improved.log;
  }
  const total = scoreSchedule({ codes, members, days, initialStates, ctx, config, fixed, env }).total;
  // Best-result mode also reviews each candidate: serious findings and work-life
  // balance decide between candidates and aim the extra attempts (perfect.mjs).
  let serious = 0;
  let findings = [];
  let wlbLow = 0;
  let wlbTeam = null;
  if (input.withQuality) {
    const described = describeCandidate(input, codes);
    serious = described.quality.serious;
    findings = described.quality.findings.map(({ id, level, count }) => ({ id, level, count }));
    wlbLow = described.wellbeing.members.filter((item) => item.score !== null && item.score < WLB_LOW).length;
    wlbTeam = described.wellbeing.team;
  }
  return { codes, total, before, serious, findings, wlbLow, wlbTeam, localLog, searchLog: [], nightQueueAfterMonth: null, ...extra };
}
