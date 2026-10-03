# Roster engine v3 (developer notes)

Admins do not need this folder: see `../../PANDUAN-ADMIN.md`. Maintainers and Claude should read `../../CLAUDE.md` first.

## Setup and tests

```
npm install          # once: installs exceljs
npm test             # node --test, all *.test.mjs files
node roster-cli.mjs bantuan
```

## How a month is generated

1. **Input:**
   - `readInputWorkbook("Data Roster.xlsx")` gives members, requests, coverage, rules and shift times.
   - `buildConfig` adds `pengaturan/lanjutan.json` overrides and keeps only members active in the month.
2. **History:** `buildHistory` loads month M-1 (Excel → JSON → CSV) and derives each member's state from the last 21 days of codes (`history.mjs`). Nothing is hand-typed. It also computes `rollingStats` for M-1 and M-2: nights, weekend days and *available* days per person (a shift or H). `fairnessOffsets` (`objective.mjs`) turns them into per-person offsets: the team's rate × the person's available days − what they did, halved, capped at ±2.
3. **Holidays:** `resolveHolidays` uses the official cache, then an automatic Google cache (refreshed after 30 days), then a fresh Google download. Otherwise it stops with instructions.
4. **Search** (`search.mjs`): beam search over the month plus a 7-day look-ahead.
   - Each node holds every member's state and the night rotation state.
   - Shift 3 options come from `night-rotation.mjs`: continue the block, or hand over to the first available person in the queue.
   - Day patterns come from `patterns.mjs`.
   - Nodes are deduplicated by future-relevant state.
   - Survivors are chosen by score, with a cap per "rest profile" for diversity and a one-day staffing look-ahead.
   - The width adapts to team size (`maxTransitionsPerDay`).
5. **Polish** (`local-search.mjs`): best-improvement moves, one per pass. Swaps of two people's codes over 1–3 days keep the counts per shift. Single-day changes on weekdays (H ↔ Shift 1/2, Shift 1 ↔ Shift 2) keep every day shift between its minimum and ideal count; they found 2 extra IDEAL weekdays in November of the six-month backtest (score −9 %), with no other month changed. Nights, requests and inactive days are never touched. (A swap of two non-adjacent days was tried for stranded single days off. It was evaluated but never improved the result, so it was removed.)
6. **Best-result mode** (`search.portfolio`; the default in the CLI and the admin menu, `--cepat` = one search) repeats steps 4–5 for each variant in `DEFAULT_PORTFOLIO` (1.5× width, 3 night choices, lighter rhythm, stronger fairness, lighter hours).
   - `variant-run.mjs` runs one variant; `variant-worker.mjs` runs it in a worker thread. Pool size = min(variants, cores / 2, RAM / 2.8 GB): on an 8-core, 8.6 GB Mac, 3 workers took 60 s against 151 s in sequence (5 workers were slower, from memory pressure). Results are identical to a sequential run.
   - Each result is scored with the normal weights and reviewed by `quality.mjs`. The winner has the fewest *penting* findings (weeks > limit + 4 h, nobody without a full weekend off, 1-1-1 weekdays, Shift 1 < Shift 2, Friday without a woman on Shift 1 while one is free), then the lowest score. A variant that dead-ends is skipped while another succeeds.
7. **Update mode** (`--pertahankan`, or the menu's "Pertahankan jadwal lama" prompt): `config.reference` holds the current month codes (manual Excel edits included). Every changed cell costs `changeFromReference` (150), days before `config.freezeBefore` (today, or `--mulai`) are fixed, and `result.changes` lists the differences. Two extra variants scale the change cost ×0.5 and ×2.
8. **Check:** `audit.mjs` re-checks every rule with separate code over history + month + look-ahead. Any failure aborts.
   - Backup plan: `backup-plan.mjs` computes, per day and shift, how one absence is covered: a second person, overtime of ≤ 4 h per neighbour within rest limits (night hours only by night-eligible people), a replacement from `findBackups`, or nothing.
   - `minimal-days.mjs` explains each 1-1-1 weekday per person: away, blocked that day (rest after nights, streak, 11 h, backward), free but a later day would then break a rule, or the side effects (Shift 2 > Shift 1, weekly hours, rhythm, target).
9. **Output:** JSON (schema 3), CSV, and the Excel from `excel-export.mjs`. The Ringkasan carries the quality review ("Pemeriksaan kualitas otomatis"); changed cells carry a "Sebelumnya: …" note and Info Admin lists the changes.

Sick-return rule: `nightFreeDaysAfterSick` (5, Aturan row "Hari tanpa Shift 3 setelah sakit"). `daysSinceSick` is derived from history like every other state; `hardViolation` blocks unrequested nights, `canStartBlock` skips the person in the rotation, and the audit re-checks it ("setelah-sakit").

## Tuning

- Weights live in `src/defaults.mjs` (`DEFAULT_WEIGHTS`) and can be overridden in `pengaturan/lanjutan.json`.
- The October 2026 defaults were chosen by comparing variants on the real September history; see the design doc in `docs/superpowers/specs/`.
- `nightBlockExtension` (50) sets how often 3-night blocks appear. Lower means more 3-night blocks and fewer understaffed weekdays; raising it strictly caps them.
- `fullWeekendOffFirst`, `weekendSpread*` and `nightSpread*` control fairness.
- The rhythm weights were chosen on the six-month backtest (29 Sep 2026, evening), together with the new target (ideal work shared evenly, max 5 days a week = 22 in October):
  - `nightBlockExtension` 50;
  - `singleWorkDay` 1000, `isolatedOff` 150, `shortWorkBlock` 40;
  - `underWorkDaysTargetDaily` 80;
  - `weekendSpread` 400 / `weekendSpreadDaily` 300;
  - `weeklyHoursOver` 150 + `weeklyHoursHeavy` 400 (raised to 1200 on 30 Sep: no week above 44 h in the backtest).

  Compared with the earlier defaults over six months:
  - IDEAL weekdays 24 → 54, MINIMAL 1 → 0;
  - single days off 65 → 26, single work days in October 8 → 0;
  - weekends 24–26 per person, heaviest week 43 h.

  The cost: 24 person-weeks over 40 h (was 15), because people work 20–21 days instead of 19–20.
- `shift1BelowShift2` 500 (never 1-2-1 on weekdays, morning traffic) and `weekdayMinimal` 920 (0 MINIMAL days in the six-month backtest). `dayShiftImbalance` 30 / `dayShiftImbalanceFinal` 100 keep the women balanced now that Shift 1 needs more people.
- `dayShiftSwitchInBlock` 400 (30 Sep): same day shift through a work block. Backtest: mixed Shift 1/2 blocks 52 → 0 of 228; IDEAL 59 → 55, single days off 33 → 45, weeks > 40 h 28 → 37. Also penalising day→night inside a block (tested at 400/1500) doubled single days off and gave a MINIMAL day, so it is not used.
- `fridayShift1WithoutFemale` 1000 keeps Friday prayer coverage from being traded for rest comfort. `nightBlockTooSoon` (150 per day a new night block starts fewer than 6 days after the last night) keeps night spacing humane.
- Any weight change: run the six-month backtest (leave, joiner, leaver, Natal, Lebaran) and compare audit, MINIMAL days, Friday misses, target gaps, cumulative nights and weekends, weeks over 40 and single days off.

## Verifying Excel changes

After touching `excel-export.mjs`:
1. Regenerate a month.
2. Recalculate a copy with LibreOffice (`soffice`) and confirm 0 formula errors.
3. Confirm every cached formula value equals LibreOffice's value.
4. Render to PDF/PNG and look at it.

LibreOffice is more lenient than Excel. Keep colour rules to their own sheet (see `test/excel.test.mjs`). When a feature is new to the exporter, have someone open the file in real Excel once.
