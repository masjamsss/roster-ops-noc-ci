// "Perfect" roster (user, 3 Oct 2026): every rule met (always), no serious
// ("penting") quality finding, and nobody's work-life balance score below 65.
// When the best roster of the normal attempts is not perfect, the engine runs
// extra attempts aimed at what is left (targetedVariants), up to
// search.perfectRounds rounds, and keeps the best roster overall.

export const WLB_LOW = 65;

export function isPerfect(run) {
  return run.serious === 0 && (run.wlbLow ?? 0) === 0;
}

// Fewest serious findings, then fewest people below 65, then the best score.
export function betterThan(a, b) {
  if (!b) return true;
  if (a.serious !== b.serious) return a.serious < b.serious;
  if ((a.wlbLow ?? 0) !== (b.wlbLow ?? 0)) return (a.wlbLow ?? 0) < (b.wlbLow ?? 0);
  return a.total < b.total;
}

// Weight boosts per kind of finding (factors on the normal weights).
const AIMS = {
  "akhir-pekan": { fullWeekendOffFirst: 3, fullWeekendOffNext: 2, weekendSpread: 1.5, weekendSpreadDaily: 1.5 },
  jumat: { fridayShift1WithoutFemale: 3 },
  terbalik: { shift1BelowShift2: 2.5 },
  minimal: { weekdayMinimal: 1.6, weekdayShortPerPerson: 1.5 },
  "jam-berat": { weeklyHoursHeavy: 2, weeklyHoursOver: 1.5 },
  wlb: { isolatedOff: 2, singleWorkDay: 1.5, shortWorkBlock: 2, weekendSpread: 1.3 }
};

const stronger = (scale, round) => Object.fromEntries(Object.entries(scale).map(([key, factor]) => [key, round > 1 ? 1 + (factor - 1) * 1.5 : factor]));

export function targetedVariants(run, round, limit = 4) {
  if (isPerfect(run)) return [];
  const aims = [...new Set((run.findings ?? []).filter((finding) => finding.level === "penting" && AIMS[finding.id]).map((finding) => finding.id))];
  if ((run.wlbLow ?? 0) > 0) aims.push("wlb");
  if (aims.length === 0) return [];
  const search = round > 1 ? { beamScale: 2, nightChoices: 3 } : { beamScale: 1.5 };
  const variants = aims.map((aim) => ({ weightScale: stronger(AIMS[aim], round), search, aim: [aim] }));
  if (aims.length > 1) {
    const combined = Object.assign({}, ...aims.map((aim) => stronger(AIMS[aim], round)));
    variants.unshift({ weightScale: combined, search, aim: aims });
  }
  return variants.slice(0, limit);
}

// Whether one more round is expected to end within the time budget. A round's
// length is estimated from the first round: attempts run in waves of `workers`.
export const PERFECT_BUDGET_MS = 6 * 60 * 1000;

export function roundFits({ elapsedMs, firstRoundMs, firstRoundCount, workers, nextCount, budgetMs = PERFECT_BUDGET_MS }) {
  const waveMs = firstRoundMs / Math.max(1, Math.ceil(firstRoundCount / Math.max(1, workers)));
  return elapsedMs + Math.ceil(nextCount / Math.max(1, workers)) * waveMs <= budgetMs;
}
