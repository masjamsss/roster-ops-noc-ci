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

// Best of the best (user, 6 Oct). Besides the standard attempts, attempts steered in
// random directions: some goals weighted 0.6-1.8 times while searching (rhythm,
// fairness, hours, staffing), 2 or 3 night choices; every result is still judged
// with the normal weights. Seeded by the month, so a month gives the same attempts
// every time. Measured on the real November 2026: 24 such attempts found a better
// roster than the 6 standard ones (score 20,533 vs 20,634, work-life 82 vs 80),
// reached by 3 different attempts.
export const DIVERSE_PATIENCE = 9;
export const DIVERSE_WAVE = 3;
const DIVERSE_KEYS = Object.freeze([
  "isolatedOff", "singleWorkDay", "shortWorkBlock", "weekendSpread", "weekendSpreadDaily", "nightSpreadDaily",
  "fullWeekendOffFirst", "weeklyHoursOver", "underWorkDaysTargetDaily", "dayShiftSwitchInBlock", "weekdayMinimal", "shift1BelowShift2"
]);

function seeded(seed) {
  let value = seed >>> 0;
  return () => {
    value = (value + 0x6d2b79f5) >>> 0;
    let t = Math.imul(value ^ (value >>> 15), 1 | value);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function diverseVariants(seedText, from, count) {
  let base = 2166136261;
  for (const char of String(seedText)) base = Math.imul(base ^ char.charCodeAt(0), 16777619) >>> 0;
  return Array.from({ length: count }, (_, offset) => {
    const random = seeded(base ^ Math.imul(from + offset + 1, 2654435761));
    const weightScale = {};
    for (const key of DIVERSE_KEYS) if (random() < 0.6) weightScale[key] = Math.round((0.6 + random() * 1.2) * 100) / 100;
    return { weightScale, search: { nightChoices: random() < 0.5 ? 2 : 3 }, diverse: from + offset + 1 };
  });
}
