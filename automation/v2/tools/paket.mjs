// Builds "Roster siap pakai.zip" for a new computer (Windows or Mac): the
// launchers, the program WITH its node_modules (exceljs is plain JavaScript, so
// the same files work on Windows), Data Roster.xlsx, the current rosters (no
// archives) and the holiday data. The first double-click then needs no internet
// (no npm install), which also avoids office proxies.
//   npm run paket                      -> ../../Roster siap pakai.zip
//   node tools/paket.mjs <file.zip>
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const ITEMS = ["Buat Roster.bat", "Buat Roster.command", "Uji Program.bat", "PANDUAN-ADMIN.md", "Data Roster.xlsx", "pengaturan", "automation/v2"];
const SKIP = new Set([".DS_Store", "arsip", "log-kesalahan.txt", "uji-program.txt", ".git"]);

export async function buildPackageFolder(target) {
  const base = path.join(target, "Roster");
  await mkdir(base, { recursive: true });
  for (const item of ITEMS) {
    const source = path.join(ROOT, item);
    if (!(await stat(source).catch(() => null))) continue;
    await cp(source, path.join(base, item), { recursive: true, filter: (file) => !SKIP.has(path.basename(file)) });
  }
  // Rosters: every month's current files, without the archive folders.
  for (const month of (await readdir(path.join(ROOT, "hasil")).catch(() => [])).filter((name) => /^\d{4}-\d{2}$/.test(name))) {
    await cp(path.join(ROOT, "hasil", month), path.join(base, "hasil", month), { recursive: true, filter: (file) => !SKIP.has(path.basename(file)) });
  }
  if (!(await stat(path.join(base, "automation", "v2", "node_modules", "exceljs")).catch(() => null))) {
    throw new Error("automation/v2/node_modules/exceljs is missing: run npm install first");
  }
  return base;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const zipFile = path.resolve(process.argv[2] ?? path.join(ROOT, "..", "Roster siap pakai.zip"));
  const staging = await mkdtemp(path.join(tmpdir(), "roster-paket-"));
  try {
    await buildPackageFolder(staging);
    await rm(zipFile, { force: true });
    execFileSync("zip", ["-r", "-q", "-X", zipFile, "Roster"], { cwd: staging });
    const size = (await stat(zipFile)).size;
    console.log(`Paket dibuat: ${zipFile} (${(size / 1e6).toFixed(1)} MB). Ekstrak di komputer baru, lalu klik dua kali "Buat Roster" atau "Uji Program".`);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
