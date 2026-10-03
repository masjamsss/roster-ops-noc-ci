// Builds the code-only copy that is pushed to the private GitHub repository
// for the real Windows test (.github/workflows/windows.yml). Only what is listed
// here is copied: the program, its tests, the launchers, the public holiday data
// and the workflow. Data Roster.xlsx, hasil/, arsip/, docs/ and CLAUDE.md never
// leave this computer (Jamal's decision, 3 Oct 2026).
//   node tools/ci-mirror.mjs <empty target folder>
import { cp, mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const ALLOWED = [
  "automation/v2", "Buat Roster.bat", "Buat Roster.command", "Uji Program.bat", ".gitattributes",
  ".github/workflows/windows.yml", "pengaturan/hari-libur", "pengaturan/lanjutan.json"
];
const SKIP = new Set(["node_modules", ".DS_Store"]);

export async function buildMirror(target) {
  if ((await readdir(target).catch(() => [])).length > 0) throw new Error(`${target} is not empty`);
  for (const item of ALLOWED) {
    await cp(path.join(ROOT, item), path.join(target, item), { recursive: true, filter: (source) => !SKIP.has(path.basename(source)) });
  }
  await writeFile(path.join(target, ".gitignore"), "node_modules/\n.DS_Store\nhasil/\nData Roster.xlsx\n~$*\n");
  await writeFile(path.join(target, "README.md"), [
    "# Roster Ops + NOC: code-only copy for the Windows test",
    "",
    "This private repository holds only the program, its tests and the launchers, so",
    "GitHub Actions can run them on real Windows (`.github/workflows/windows.yml`).",
    "The team's Data Roster.xlsx and rosters are not here. It is rebuilt from the main",
    "project with `node automation/v2/tools/ci-mirror.mjs`.",
    ""
  ].join("\n"));
  await mkdir(path.join(target, "hasil"), { recursive: true });
  return target;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const target = process.argv[2];
  if (!target) {
    console.error("Usage: node tools/ci-mirror.mjs <empty target folder>");
    process.exit(2);
  }
  await mkdir(target, { recursive: true });
  await buildMirror(path.resolve(target));
  console.log(`Code-only copy written to ${target}`);
}
