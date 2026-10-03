import assert from "node:assert/strict";
import test from "node:test";
import { betterThan, isPerfect, targetedVariants } from "../src/perfect.mjs";

const run = (overrides) => ({ serious: 0, wlbLow: 0, total: 1000, findings: [], ...overrides });

test("perfect = no serious finding and nobody's work-life score below 65", () => {
  assert.equal(isPerfect(run({})), true);
  assert.equal(isPerfect(run({ serious: 1 })), false);
  assert.equal(isPerfect(run({ wlbLow: 1 })), false);
});

test("the winner has the fewest serious findings, then the fewest people below 65, then the best score", () => {
  assert.ok(betterThan(run({ serious: 0, total: 9000 }), run({ serious: 1, total: 10 })));
  assert.ok(betterThan(run({ wlbLow: 0, total: 9000 }), run({ wlbLow: 1, total: 10 })));
  assert.ok(betterThan(run({ total: 10 }), run({ total: 11 })));
  assert.ok(!betterThan(run({ total: 11 }), run({ total: 10 })));
});

test("extra attempts aim at what is left: weekends, Friday, Shift 1 vs 2, 1-1-1 days, heavy weeks, low work-life", () => {
  assert.deepEqual(targetedVariants(run({}), 1), [], "nothing to aim at when perfect");
  const weekend = targetedVariants(run({ serious: 1, findings: [{ id: "akhir-pekan", level: "penting" }] }), 1);
  assert.ok(weekend.some((variant) => variant.weightScale?.fullWeekendOffFirst > 1), JSON.stringify(weekend));
  const mixed = targetedVariants(run({ serious: 3, wlbLow: 1, findings: [{ id: "jumat", level: "penting" }, { id: "terbalik", level: "penting" }, { id: "minimal", level: "penting" }] }), 1);
  assert.ok(mixed.some((variant) => variant.weightScale?.fridayShift1WithoutFemale > 1));
  assert.ok(mixed.some((variant) => variant.weightScale?.shift1BelowShift2 > 1));
  assert.ok(mixed.some((variant) => variant.weightScale?.weekdayMinimal > 1));
  assert.ok(mixed.some((variant) => variant.weightScale?.isolatedOff > 1), "low work-life: cleaner rhythm");
  assert.ok(mixed.length <= 4, "at most 4 extra attempts per round");
  const second = targetedVariants(run({ serious: 1, findings: [{ id: "akhir-pekan", level: "penting" }] }), 2);
  assert.ok(second.some((variant) => variant.weightScale?.fullWeekendOffFirst > weekend[0].weightScale.fullWeekendOffFirst), "the second round pushes harder");
  assert.ok(second.some((variant) => (variant.search?.beamScale ?? 1) >= 2), "and searches wider");
});

test("an extra round runs only if it fits the time budget (slow 2-core PCs skip it)", async () => {
  const { roundFits } = await import("../src/perfect.mjs");
  // Fast Mac: first round of 6 attempts on 3 workers took 60 s; 4 more attempts fit easily.
  assert.equal(roundFits({ elapsedMs: 60_000, firstRoundMs: 60_000, firstRoundCount: 6, workers: 3, nextCount: 4, budgetMs: 360_000 }), true);
  // 2-core PC: 6 attempts one by one took 5 minutes; 4 more would end near 8 minutes.
  assert.equal(roundFits({ elapsedMs: 300_000, firstRoundMs: 300_000, firstRoundCount: 6, workers: 1, nextCount: 4, budgetMs: 360_000 }), false);
});
