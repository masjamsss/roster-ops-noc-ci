// Folder conventions and month-to-month continuity:
//   hasil/YYYY-MM/Roster <Bulan> <Tahun>.xlsx  (what the OM sees and may edit)
//   hasil/YYYY-MM/roster-YYYY-MM.json          (full result, machine readable)
//   hasil/YYYY-MM/roster-YYYY-MM.csv           (plain codes; also used for imported history)
// Next month continues from the Excel if it is readable (so manual swaps count),
// otherwise from the JSON, otherwise from the CSV.
import { mkdir, open, readdir, readFile, rename, stat } from "node:fs/promises";
import path from "node:path";
import { addMonths, eachDate, monthBounds, parseMonthKey } from "./date-utils.mjs";
import { RosterError, explainFileError } from "./errors.mjs";
import { readRosterWorkbook } from "./excel-read.mjs";
import { rollingStats } from "./history.mjs";
import { namaBulan } from "./labels-id.mjs";
import { parseRosterCsv } from "./roster-csv.mjs";

export function workspacePaths(root) {
  return {
    root,
    inputWorkbook: path.join(root, "Data Roster.xlsx"),
    advancedSettings: path.join(root, "pengaturan", "lanjutan.json"),
    holidaysDir: path.join(root, "pengaturan", "hari-libur"),
    resultsDir: path.join(root, "hasil")
  };
}

export function monthLabel(key) {
  const { year, month } = parseMonthKey(key);
  return `${namaBulan(month)} ${year}`;
}

export function monthFiles(paths, key) {
  const dir = path.join(paths.resultsDir, key);
  return {
    dir,
    excel: path.join(dir, `Roster ${monthLabel(key)}.xlsx`),
    json: path.join(dir, `roster-${key}.json`),
    csv: path.join(dir, `roster-${key}.csv`)
  };
}

async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

async function listFiles(dir) {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

export async function listResultMonths(paths) {
  const months = [];
  for (const name of (await listFiles(paths.resultsDir)).sort()) {
    if (!/^\d{4}-\d{2}$/.test(name)) continue;
    const files = await listFiles(path.join(paths.resultsDir, name));
    if (files.some((file) => /\.(xlsx|json|csv)$/i.test(file) && !file.startsWith("~$"))) months.push(name);
  }
  return months;
}

export async function latestResultMonth(paths) {
  return (await listResultMonths(paths)).at(-1) ?? null;
}

// The newest readable roster workbook for this month (the file may have been renamed).
async function findRosterExcel(dir, key) {
  const candidates = [];
  for (const name of await listFiles(dir)) {
    if (!name.toLowerCase().endsWith(".xlsx") || name.startsWith("~$")) continue;
    const file = path.join(dir, name);
    candidates.push({ file, modified: (await stat(file)).mtimeMs });
  }
  candidates.sort((left, right) => right.modified - left.modified);
  const skipped = [];
  for (const candidate of candidates) {
    try {
      const read = await readRosterWorkbook(candidate.file);
      if (read.monthKey === key) return { ...read, file: candidate.file, skipped };
    } catch (error) {
      skipped.push(`${path.basename(candidate.file)}: ${error.message}`);
    }
  }
  return skipped.length ? { skipped } : null;
}

export async function loadMonthCodes(paths, key) {
  const files = monthFiles(paths, key);
  let json = null;
  if (await exists(files.json)) json = JSON.parse(await readFile(files.json, "utf8"));
  const excel = await findRosterExcel(files.dir, key);
  const notes = excel?.skipped?.length ? [`File Excel yang tidak bisa dibaca dilewati: ${excel.skipped.join("; ")}`] : [];

  if (excel?.codesById) {
    if (excel.problems.length > 0) {
      throw new RosterError(`Roster ${monthLabel(key)} (${path.basename(excel.file)}) punya sel yang perlu diperbaiki dulu:\n- ${excel.problems.slice(0, 10).join("\n- ")}`);
    }
    const names = Object.fromEntries(excel.members.map((member) => [member.id, member.name]));
    const manualChanges = [];
    if (json) {
      for (const member of excel.members) {
        const before = json.schedule?.[member.id];
        if (!before) continue;
        excel.dates.forEach((date, index) => {
          const from = before[date];
          const to = excel.codesById[member.id][index];
          if (from !== undefined && from !== to) manualChanges.push({ memberId: member.id, name: member.name, date, from, to });
        });
      }
    }
    return { key, source: "excel", sourceFile: excel.file, dates: excel.dates, codesById: excel.codesById, names, manualChanges, result: json, notes, approval: excel.approval };
  }
  if (json) {
    const dates = Object.keys(json.schedule[json.members[0].id]);
    const codesById = Object.fromEntries(json.members.map((member) => [member.id, dates.map((date) => json.schedule[member.id][date])]));
    const names = Object.fromEntries(json.members.map((member) => [member.id, member.name]));
    return { key, source: "json", sourceFile: files.json, dates, codesById, names, manualChanges: [], result: json, notes };
  }
  if (await exists(files.csv)) {
    const csv = parseRosterCsv(await readFile(files.csv, "utf8"), { source: `hasil/${key}/roster-${key}.csv` });
    return { key, source: "csv", sourceFile: files.csv, dates: csv.dates, codesById: csv.codesById, names: csv.names, manualChanges: [], result: null, notes };
  }
  return null;
}

// History for generating `key`: the previous month's real codes (+ fairness stats of up to 3 months).
export async function buildHistory(paths, key, { statsMonths = 2 } = {}) {
  const previousKey = addMonths(key, -1);
  const previous = await loadMonthCodes(paths, previousKey);
  if (!previous) {
    throw new RosterError(
      `Roster ${monthLabel(previousKey)} belum ada di folder hasil/${previousKey}. ` +
        `Buat roster ${monthLabel(previousKey)} dulu, atau simpan roster aktualnya sebagai hasil/${previousKey}/roster-${previousKey}.csv.`
    );
  }
  const { year, month } = parseMonthKey(previousKey);
  const bounds = monthBounds(year, month);
  if (previous.dates.at(-1) !== bounds.end) {
    throw new RosterError(`Roster ${monthLabel(previousKey)} (${path.basename(previous.sourceFile)}) tidak sampai tanggal ${Number(bounds.end.slice(8))}. Lengkapi dulu roster bulan itu.`);
  }
  const months = [previous];
  for (let back = 2; back <= statsMonths; back += 1) {
    const older = await loadMonthCodes(paths, addMonths(key, -back)).catch(() => null);
    if (older) months.push(older);
  }
  const memberIds = [...new Set(months.flatMap((item) => Object.keys(item.codesById)))];
  const stats = rollingStats(months.map((item) => ({ key: item.key, dates: item.dates, codesById: item.codesById })), memberIds, ["1", "2", "3"]);
  return {
    key: previousKey,
    source: previous.source,
    sourceFile: previous.sourceFile,
    dates: previous.dates,
    codesById: previous.codesById,
    names: previous.names,
    manualChanges: previous.manualChanges,
    notes: previous.notes,
    stats
  };
}

export async function archiveMonth(paths, key, now = new Date()) {
  const dir = path.join(paths.resultsDir, key);
  const entries = (await listFiles(dir)).filter((name) => name !== "arsip" && !name.startsWith("~$"));
  if (entries.length === 0) return null;
  // Check every file first, so a file still open in Excel (Windows) stops the
  // archive before anything is moved instead of leaving it half done.
  for (const name of entries) {
    const file = path.join(dir, name);
    if (!(await stat(file)).isFile()) continue;
    try {
      await (await open(file, "r+")).close();
    } catch (error) {
      throw explainFileError(error) ?? error;
    }
  }
  // Local clock time, e.g. 2026-09-29_20-05-13 (what the admin sees on their computer).
  const two = (value) => String(value).padStart(2, "0");
  const stamp = `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}_${two(now.getHours())}-${two(now.getMinutes())}-${two(now.getSeconds())}`;
  const target = path.join(dir, "arsip", stamp);
  try {
    await mkdir(target, { recursive: true });
    for (const name of entries) await rename(path.join(dir, name), path.join(target, name));
  } catch (error) {
    throw explainFileError(error) ?? error;
  }
  return target;
}

export function horizonYears(key, lookaheadDays) {
  const { year, month } = parseMonthKey(key);
  const bounds = monthBounds(year, month);
  const last = eachDate(bounds.end, bounds.end)[0];
  const end = new Date(`${last}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() + lookaheadDays);
  return [...new Set([year, end.getUTCFullYear()])];
}
