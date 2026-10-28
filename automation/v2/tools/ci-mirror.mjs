// Builds the code-only copy that is pushed to the public GitHub repository
// for the real Windows test (.github/workflows/windows.yml). Only what is listed
// here is copied: the program, its tests, the launchers, the public holiday data
// and the workflow. Data Roster.xlsx, hasil/, arsip/, docs/ and CLAUDE.md never
// leave this computer (the owner's decision, 3 Oct 2026). The repository is public
// (28 Oct), so every real name is swapped for a neutral one (pengaturan/nama-ci.json,
// never copied) and the copy is refused if one is left.
//   node tools/ci-mirror.mjs <empty target folder>
import { cp, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const ALLOWED = [
  "automation/v2", "Buat Roster.bat", "Buat Roster.command", "Uji Program.bat", ".gitattributes",
  ".github/workflows/windows.yml", "pengaturan/hari-libur", "pengaturan/lanjutan.json"
];
const SKIP = new Set(["node_modules", ".DS_Store"]);
const TEXT = /\.(mjs|js|json|csv|md|txt|yml|bat|command|ics)$|^\.git(attributes|ignore)$/;

// Name as a word or at the start of an identifier (rudiNights), keeping case;
// "adding" or "readdir" are not names.
function namePatterns(real) {
  return [[real, "[a-z]"], [real.toLowerCase(), "[a-z]"], [real.toUpperCase(), "[A-Za-z]"]]
    .map(([variant, after]) => [new RegExp(`(?<![A-Za-z])${variant}(?!${after})`, "g"), variant]);
}

async function filesUnder(folder) {
  const out = [];
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const full = path.join(folder, entry.name);
    if (entry.isDirectory()) out.push(...(await filesUnder(full)));
    else if (TEXT.test(entry.name)) out.push(full);
  }
  return out;
}

async function swapNames(target) {
  const names = Object.entries(JSON.parse(await readFile(path.join(ROOT, "pengaturan", "nama-ci.json"), "utf8"))).filter(([real]) => real !== "_");
  const left = [];
  for (const file of await filesUnder(target)) {
    const before = await readFile(file, "utf8");
    let text = before;
    for (const [real, neutral] of names) {
      for (const [pattern, variant] of namePatterns(real)) {
        const swap = variant === real ? neutral : variant === real.toLowerCase() ? neutral.toLowerCase() : neutral.toUpperCase();
        text = text.replace(pattern, swap);
      }
    }
    if (text !== before) await writeFile(file, text, "utf8");
    for (const [real] of names) if (new RegExp(`(?<![a-z])${real}(?![a-z])`, "i").test(text)) left.push(`${path.relative(target, file)}: ${real}`);
  }
  if (left.length > 0) throw new Error(`Real names left in the copy:\n${left.join("\n")}`);
}

export async function buildMirror(target) {
  if ((await readdir(target).catch(() => [])).length > 0) throw new Error(`${target} is not empty`);
  for (const item of ALLOWED) {
    await cp(path.join(ROOT, item), path.join(target, item), { recursive: true, filter: (source) => !SKIP.has(path.basename(source)) });
  }
  await writeFile(path.join(target, ".gitignore"), "node_modules/\n.DS_Store\nhasil/\nData Roster.xlsx\n~$*\n");
  await writeFile(path.join(target, "README.md"), [
    "# Roster Ops + NOC: code-only copy for the Windows test",
    "",
    "This repository holds only the program, its tests and the launchers, so",
    "GitHub Actions can run them on real Windows (`.github/workflows/windows.yml`).",
    "The team's Data Roster.xlsx and rosters are not here. It is rebuilt from the main",
    "project with `node automation/v2/tools/ci-mirror.mjs`.",
    ""
  ].join("\n"));
  await mkdir(path.join(target, "hasil"), { recursive: true });
  await swapNames(target);
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
