// Six-month backtest (Oct 2026 - Mar 2027) with realistic events: leave,
// training, a joiner (Budi, 11 Jan), a leaver (Willy, 15 Feb), two people on
// leave together in March, Christmas and Lebaran. Every weight or rule change
// must be checked with it (see CLAUDE.md): the audit must pass every month and
// staffing, Friday coverage, fairness, hours and work-life balance must not get
// worse. Runs in a temporary folder; the real Roster folder is not touched.
//
//   npm run backtest
//   npm run backtest -- --weights '{"nightSpreadHeavy":800}'   (try other weights)
//   npm run backtest -- --best                                  (best-result mode, slower)
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ExcelJS from "exceljs";
import { buatRoster, siapkanData } from "../src/app.mjs";
import { appendRequest, INPUT_LAYOUT } from "../src/input-workbook.mjs";

const REAL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const MONTHS = ["2026-10", "2026-11", "2026-12", "2027-01", "2027-02", "2027-03"];
const EVENTS = [
  ["Addin", "2026-11-16", "2026-11-18", "Cuti"], ["Willy", "2026-11-09", "2026-11-09", "Training/Dinas"],
  ["Hilvani", "2026-12-28", "2026-12-31", "Cuti"],
  ["Rizky", "2027-03-12", "2027-03-16", "Cuti"], ["Pavitasari", "2027-03-12", "2027-03-16", "Cuti"]
];

const args = process.argv.slice(2);
const weightsArg = args.includes("--weights") ? JSON.parse(args[args.indexOf("--weights") + 1]) : null;
const best = args.includes("--best");

const root = await mkdtemp(path.join(tmpdir(), "roster-backtest-"));
try {
  await mkdir(path.join(root, "pengaturan"), { recursive: true });
  await cp(path.join(REAL_ROOT, "pengaturan", "hari-libur"), path.join(root, "pengaturan", "hari-libur"), { recursive: true });
  await mkdir(path.join(root, "hasil", "2026-09"), { recursive: true });
  await cp(path.join(REAL_ROOT, "hasil", "2026-09", "roster-2026-09.csv"), path.join(root, "hasil", "2026-09", "roster-2026-09.csv"));
  if (weightsArg) await writeFile(path.join(root, "pengaturan", "lanjutan.json"), JSON.stringify({ weights: weightsArg }));
  await siapkanData({ root });
  const book = path.join(root, "Data Roster.xlsx");
  for (const [name, from, to, kind] of EVENTS) await appendRequest(book, { name, from, to, kind });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(book);
  const members = workbook.getWorksheet(INPUT_LAYOUT.members.sheet);
  const budi = members.getRow(INPUT_LAYOUT.members.firstRow + 6);
  budi.getCell(2).value = "Budi";
  budi.getCell(4).value = "L";
  for (const column of [5, 6, 7]) budi.getCell(column).value = "Ya";
  budi.getCell(8).value = new Date("2027-01-11T00:00:00Z");
  members.getRow(INPUT_LAYOUT.members.firstRow + 3).getCell(9).value = new Date("2027-02-15T00:00:00Z"); // Willy leaves
  await workbook.xlsx.writeFile(book);

  const totals = { nights: {}, longBlocks: {}, weekends: {}, ideal: 0, minimal: 0, serious: 0, weeksOver: 0, heaviest: 0, wlb: [] };
  console.log(`Backtest ${MONTHS[0]} .. ${MONTHS.at(-1)}${weightsArg ? ` with ${JSON.stringify(weightsArg)}` : ""}${best ? " (best-result mode)" : ""}`);
  for (const key of MONTHS) {
    const started = Date.now();
    const { result } = await buatRoster({ root, monthKey: key, online: false, force: true, best, now: new Date("2026-09-30T08:00:00") });
    const night = result.members.filter((member) => !member.dayOnly);
    const nightsOf = (member) => result.memberSummary[member.id].shifts["3"];
    const longOf = (member) => result.fairness.members.find((item) => item.id === member.id)?.months.at(-1)?.longBlocks ?? 0;
    const status = result.days.reduce((counts, day) => ({ ...counts, [day.status]: (counts[day.status] ?? 0) + 1 }), {});
    const weeks = result.members.flatMap((member) => result.memberSummary[member.id].weeklyHours.map((week) => week.hours));
    const women = result.members.filter((member) => member.dayOnly).map((member) => `${result.memberSummary[member.id].shifts["1"]}/${result.memberSummary[member.id].shifts["2"]}`);
    for (const member of night) {
      totals.nights[member.name] = (totals.nights[member.name] ?? 0) + nightsOf(member);
      totals.longBlocks[member.name] = (totals.longBlocks[member.name] ?? 0) + longOf(member);
    }
    for (const member of result.members) totals.weekends[member.name] = (totals.weekends[member.name] ?? 0) + result.memberSummary[member.id].weekendWorkDays;
    totals.ideal += status.IDEAL ?? 0;
    totals.minimal += status.MINIMAL ?? 0;
    totals.serious += result.quality.serious;
    totals.weeksOver += result.members.reduce((sum, member) => sum + result.memberSummary[member.id].weeksOverLimit, 0);
    totals.heaviest = Math.max(totals.heaviest, ...weeks);
    if (result.wellbeing?.team != null) totals.wlb.push(result.wellbeing.team);
    console.log([
      key, result.audit.ok ? "audit OK" : "AUDIT FAIL",
      `IDEAL ${status.IDEAL ?? 0} CUKUP ${status.CUKUP ?? 0} MINIMAL ${status.MINIMAL ?? 0}`,
      `nights ${night.map(nightsOf).join(",")}`, `3-night ${night.map(longOf).join(",")}`, `women S1/S2 ${women.join(" ")}`,
      `quality ${result.quality.serious}p/${result.quality.notices}n${result.quality.serious ? ` (${result.quality.findings.filter((finding) => finding.level === "penting").map((finding) => `${finding.id} ${finding.details.join(", ")}`).join("; ")})` : ""}`, `max week ${Math.max(...weeks)} h`,
      `work-life ${result.wellbeing?.team ?? "-"}`, `${Math.round((Date.now() - started) / 1000)} s`
    ].join(" | "));
  }
  console.log(`Six months: IDEAL ${totals.ideal}, MINIMAL ${totals.minimal}, serious findings ${totals.serious}, person-weeks > 40 h ${totals.weeksOver}, heaviest week ${totals.heaviest} h, work-life (team, monthly) ${totals.wlb.join(" ")}`);
  console.log(`Nights: ${JSON.stringify(totals.nights)}  3-night blocks: ${JSON.stringify(totals.longBlocks)}`);
  console.log(`Weekend days worked: ${JSON.stringify(totals.weekends)}`);
} catch (error) {
  console.error(`Backtest failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  await rm(root, { recursive: true, force: true });
}
