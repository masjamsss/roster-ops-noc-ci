// Self-test on this computer (Windows or Mac): makes the next month's roster in
// a temporary copy of the Roster folder, the same way the menu does (best-result
// mode with worker threads), and checks every step. The real data are not
// changed; the report is written to hasil/uji-program.txt so an admin can send it.
//   Windows: double-click "Uji Program.bat"     Mac/Claude: node tools/selftest.mjs
import { cp, mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ExcelJS from "exceljs";
import { buatRoster, cekRoster, nextMonthKey, periksaSistem } from "../src/app.mjs";
import { needsPlainText, plainText } from "../src/console-text.mjs";
import { readRosterWorkbook } from "../src/excel-read.mjs";
import { monthLabel } from "../src/workspace.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const lines = [];
let failures = 0;
const plain = needsPlainText();
const log = (text) => {
  console.log(plain ? plainText(text) : text); // old Windows console: ASCII
  lines.push(text);
};
const step = async (label, run) => {
  const started = Date.now();
  try {
    const detail = await run();
    log(`✔ ${label}${detail ? `: ${detail}` : ""} (${((Date.now() - started) / 1000).toFixed(1)} s)`);
  } catch (error) {
    failures += 1;
    log(`✖ ${label}: ${error.message.split("\n")[0]}`);
  }
};

log(`Uji program Roster · ${new Date().toISOString()} · ${os.type()} ${os.release()} · Node ${process.versions.node} · ${os.availableParallelism?.() ?? os.cpus().length} inti · ${(os.totalmem() / 1e9).toFixed(1)} GB`);
log(`Folder: ${ROOT}`);

const temp = await mkdtemp(path.join(os.tmpdir(), "roster-uji-"));
let key = null;
let done = null;
try {
  await step("Kesiapan (menu 7)", async () => {
    const report = await periksaSistem({ root: ROOT });
    key = report.key;
    const problems = report.items.filter((item) => item.level === "masalah");
    if (problems.length) throw new Error(problems.map((item) => item.text).join(" | "));
    return `siap untuk ${report.label}`;
  });
  await step("Salin data ke folder sementara", async () => {
    await mkdir(path.join(temp, "hasil"), { recursive: true });
    await cp(path.join(ROOT, "pengaturan"), path.join(temp, "pengaturan"), { recursive: true });
    // Without a Data Roster.xlsx (a fresh copy) the tool makes one, as on first use.
    await cp(path.join(ROOT, "Data Roster.xlsx"), path.join(temp, "Data Roster.xlsx")).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    for (const month of await readdir(path.join(ROOT, "hasil"))) {
      if (!/^\d{4}-\d{2}$/.test(month)) continue;
      const source = path.join(ROOT, "hasil", month);
      if (!(await stat(source)).isDirectory()) continue;
      await mkdir(path.join(temp, "hasil", month), { recursive: true });
      for (const file of await readdir(source)) if (file !== "arsip") await cp(path.join(source, file), path.join(temp, "hasil", month, file));
    }
    key ??= await nextMonthKey({ root: temp });
    return `bulan uji: ${monthLabel(key)}`;
  });
  await step("Buat roster (mode terbaik, beberapa percobaan paralel)", async () => {
    done = await buatRoster({ root: temp, monthKey: key, online: false, best: true, force: true });
    if (!done.result.audit.ok) throw new Error("pemeriksaan aturan gagal");
    const workers = done.result.search?.workers ?? 1;
    return `${done.result.audit.checks.length}/${done.result.audit.checks.length} aturan, ${done.result.search?.portfolio?.length ?? 1} percobaan, ${workers} proses paralel`;
  });
  await step("File Excel terbaca kembali sama persis", async () => {
    const back = await readRosterWorkbook(done.files.excel);
    let differences = 0;
    for (const member of done.result.members) {
      for (const day of done.result.days) if (back.codesById[member.id]?.[back.dates.indexOf(day.date)] !== done.result.schedule[member.id][day.date]) differences += 1;
    }
    if (differences) throw new Error(`${differences} sel berbeda`);
    return path.basename(done.files.excel);
  });
  await step("Pemeriksaan ganda di Excel (program = rumus)", async () => {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(done.files.excel);
    const verdicts = [];
    workbook.getWorksheet("Pemeriksaan").eachRow((row) => row.eachCell((cell) => {
      if (/Sama|Berbeda/.test(String(cell.value?.result ?? ""))) verdicts.push(cell.value.result);
    }));
    const different = verdicts.filter((verdict) => verdict !== "✔ Sama").length;
    if (!verdicts.length || different) throw new Error(`${different} dari ${verdicts.length} berbeda`);
    return `${verdicts.length}/${verdicts.length} sama`;
  });
  await step("Cek roster (menu 3)", async () => {
    const report = await cekRoster({ root: temp, monthKey: key });
    if (!report.ok) throw new Error("ada aturan yang tidak terpenuhi");
    return "semua aturan terpenuhi";
  });
  await step("Folder hasil dan arsip", async () => {
    const again = await buatRoster({ root: temp, monthKey: key, online: false, best: false, force: true, keep: true });
    if (!again.archived) throw new Error("versi lama tidak diarsipkan");
    return "buat ulang mengarsipkan versi lama";
  });
} finally {
  await rm(temp, { recursive: true, force: true }).catch(() => {});
}

log(failures === 0 ? "\nHASIL: ✔ Semua uji lulus. Program siap dipakai di komputer ini." : `\nHASIL: ✖ ${failures} uji gagal. Kirim file hasil/uji-program.txt ke pengelola roster.`);
try {
  await mkdir(path.join(ROOT, "hasil"), { recursive: true });
  await writeFile(path.join(ROOT, "hasil", "uji-program.txt"), `${lines.join("\n")}\n`);
  console.log("Laporan disimpan di hasil/uji-program.txt");
} catch (error) {
  console.log(`Laporan tidak bisa disimpan: ${error.message}`);
}
process.exitCode = failures === 0 ? 0 : 1;
