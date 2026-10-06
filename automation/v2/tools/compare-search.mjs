// Fair month-by-month comparison of two search settings on identical inputs: for
// each month of the six-month backtest, the same history (the baseline's previous
// month) is given to both settings. Chained backtests drift apart after the first
// month (another October gives another November), which hides the method's effect.
//   node tools/compare-search.mjs '{"diverse":false,"polishMs":0}'   (baseline vs today's default)
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ExcelJS from "exceljs";
import { buatRoster, siapkanData } from "../src/app.mjs";
import { appendRequest, INPUT_LAYOUT } from "../src/input-workbook.mjs";

const REAL_ROOT = process.env.ROSTER_DATA ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const MONTHS = ["2026-10", "2026-11", "2026-12", "2027-01", "2027-02", "2027-03"];
const EVENTS = [
  ["Addin", "2026-11-16", "2026-11-18", "Cuti"], ["Willy", "2026-11-09", "2026-11-09", "Training/Dinas"],
  ["Hilvani", "2026-12-28", "2026-12-31", "Cuti"],
  ["Rizky", "2027-03-12", "2027-03-16", "Cuti"], ["Pavitasari", "2027-03-12", "2027-03-16", "Cuti"]
];
const baseline = JSON.parse(process.argv[2] ?? '{"diverse":false,"polishMs":0}');
const candidate = JSON.parse(process.argv[3] ?? "{}");
const root = await mkdtemp(path.join(tmpdir(), "roster-compare-"));
const describe = (result) => {
  const weekdays = result.days.filter((day) => !day.isSpecial);
  const scores = result.wellbeing.members.filter((item) => item.score !== null).map((item) => item.score);
  const weeks = result.members.flatMap((member) => result.memberSummary[member.id].weeklyHours.map((week) => week.hours));
  return {
    serious: result.quality.serious, ideal: weekdays.filter((day) => day.status === "IDEAL").length, minimal: weekdays.filter((day) => day.status === "MINIMAL").length,
    wlb: result.wellbeing.team, wlbMin: Math.min(...scores), over40: weeks.filter((hours) => hours > 40).length, maxWeek: Math.max(...weeks), score: result.search.finalScore
  };
};
try {
  await mkdir(path.join(root, "pengaturan"), { recursive: true });
  await cp(path.join(REAL_ROOT, "pengaturan", "hari-libur"), path.join(root, "pengaturan", "hari-libur"), { recursive: true });
  await mkdir(path.join(root, "hasil", "2026-09"), { recursive: true });
  await cp(path.join(REAL_ROOT, "hasil", "2026-09", "roster-2026-09.csv"), path.join(root, "hasil", "2026-09", "roster-2026-09.csv"));
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
  members.getRow(INPUT_LAYOUT.members.firstRow + 3).getCell(9).value = new Date("2027-02-15T00:00:00Z");
  await workbook.xlsx.writeFile(book);
  const totals = { a: {}, b: {} };
  const add = (target, row) => { for (const [key, value] of Object.entries(row)) target[key] = key === "maxWeek" ? Math.max(target[key] ?? 0, value) : key === "wlbMin" ? Math.min(target[key] ?? 100, value) : (target[key] ?? 0) + value; };
  console.log(`Per month on identical inputs: A = ${JSON.stringify(baseline)}, B = ${JSON.stringify(candidate)}`);
  for (const key of MONTHS) {
    // B on a copy of the folder as it is before this month (the same history as A).
    const fork = await mkdtemp(path.join(tmpdir(), "roster-compare-b-"));
    await cp(root, fork, { recursive: true });
    await writeFile(path.join(fork, "pengaturan", "lanjutan.json"), JSON.stringify({ search: candidate }));
    await writeFile(path.join(root, "pengaturan", "lanjutan.json"), JSON.stringify({ search: baseline }));
    let started = Date.now();
    const b = describe((await buatRoster({ root: fork, monthKey: key, online: false, force: true, best: true, now: new Date("2026-09-30T08:00:00") })).result);
    const bSeconds = Math.round((Date.now() - started) / 1000);
    await rm(fork, { recursive: true, force: true });
    started = Date.now();
    const a = describe((await buatRoster({ root, monthKey: key, online: false, force: true, best: true, now: new Date("2026-09-30T08:00:00") })).result);
    const aSeconds = Math.round((Date.now() - started) / 1000);
    add(totals.a, a);
    add(totals.b, b);
    const line = (row, seconds) => `penting ${row.serious} IDEAL ${row.ideal} MINIMAL ${row.minimal} kerja-hidup ${row.wlb} (min ${row.wlbMin}) minggu>40 ${row.over40} maks ${row.maxWeek} skor ${row.score} (${seconds} s)`;
    console.log(`${key}\n  A ${line(a, aSeconds)}\n  B ${line(b, bSeconds)}`);
  }
  console.log(`Total A: ${JSON.stringify(totals.a)}\nTotal B: ${JSON.stringify(totals.b)}`);
} finally {
  await rm(root, { recursive: true, force: true });
}
