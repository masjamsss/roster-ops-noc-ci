// Proof-backed polishing: parts of a roster searched completely.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { DEFAULT_TEAM, makeConfig } from "../src/defaults.mjs";
import { prepareMonth } from "../src/engine.mjs";
import { scoreSchedule } from "../src/objective.mjs";
import { judge, polishByCompleteParts, rebuildPart } from "../src/refine.mjs";
import { parseRosterCsv } from "../src/roster-csv.mjs";
import { runVariant } from "../src/variant-run.mjs";

const september = parseRosterCsv(readFileSync(new URL("./fixtures/september-2026.csv", import.meta.url), "utf8"));
const history = { key: "2026-09", dates: september.dates, codesById: september.codesById, source: "csv" };
const calendars = [{ year: 2026, days: [] }];
const month = (search) => prepareMonth({ config: makeConfig({ year: 2026, month: 10, search }), calendars, history }).input;

test("rebuilding with nothing freed gives back the same roster, searched completely", () => {
  const input = month({ beamWidth: 300 });
  const start = runVariant(input, {});
  const rebuilt = rebuildPart(input, start.codes, () => false);
  assert.deepEqual(rebuilt.codes, start.codes);
  assert.equal(rebuilt.complete, true);
});

test("a weak roster is improved by searching parts completely, and every rule still holds", { timeout: 600_000 }, () => {
  const input = month({ beamWidth: 60, minBeamWidth: 60, nightChoices: 1 });
  input.withQuality = true;
  const weak = runVariant(input, {});
  const result = polishByCompleteParts(input, weak, { budgetMs: 60_000 });
  assert.ok(result.improved >= 1, "a narrow search leaves room");
  assert.ok(result.total < weak.total, `${Math.round(result.total)} < ${Math.round(weak.total)}`);
  const { members, days, fixed, initialStates, ctx, config, env } = input;
  assert.equal(scoreSchedule({ codes: result.codes, members, days, initialStates, ctx, config, fixed, env }).valid, true);
  assert.ok(judge(input, result.codes).serious <= weak.serious, "never more serious findings");
  assert.ok(result.checked["satu-orang"].complete >= 1 && result.checked["dua-hari"].complete >= 1, JSON.stringify(result.checked));
});

test("the part-by-part check keeps to its time limit, also when one part is large", { timeout: 300_000 }, () => {
  const team = [...DEFAULT_TEAM, { id: "budi", name: "Budi", gender: "L", eligibleShifts: ["1", "2", "3"] }, { id: "citra", name: "Citra", gender: "P", eligibleShifts: ["1", "2"] }];
  const input = prepareMonth({ config: makeConfig({ year: 2026, month: 10, team, search: { beamWidth: 300 } }), calendars, history }).input;
  input.withQuality = true;
  const start = runVariant(input, {});
  const started = Date.now();
  const result = polishByCompleteParts(input, start, { budgetMs: 3000, width: 60_000, maxCandidates: 400_000 });
  assert.ok(Date.now() - started < 6000, `${Date.now() - started} ms for a 3-second limit`);
  assert.equal(result.finished, false, "not every part was checked in 3 seconds");
});
