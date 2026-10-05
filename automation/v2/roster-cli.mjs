#!/usr/bin/env node
// Roster Ops + NOC — command line and double-click menu (Bahasa Indonesia).
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { buatRoster, cekRoster, nextMonthKey, perbaruiHariLibur, periksaSistem, previewRoster, siapkanData } from "./src/app.mjs";
import { appendMember, appendRequest, readInputWorkbook, REQUEST_KINDS } from "./src/input-workbook.mjs";
import { addDays, isoDate, monthBounds, parseMonthKey } from "./src/date-utils.mjs";
import { parseTanggal } from "./src/console-input.mjs";
import { needsPlainText, plainText } from "./src/console-text.mjs";
import { RosterError, explainFileError } from "./src/errors.mjs";
import { formatTanggal, KODE_LABEL } from "./src/labels-id.mjs";
import { loadMonthCodes, monthLabel, workspacePaths } from "./src/workspace.mjs";

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const LINE = "=".repeat(58);
// Older Windows consoles garble block characters; plain ASCII works everywhere.
// Old Windows console (no Windows Terminal): write plain ASCII instead of symbols
// it cannot show (✔ ✖ ⚠ …). Covers console output and the menu prompts.
if (needsPlainText()) {
  for (const name of ["log", "error", "warn"]) {
    const original = console[name].bind(console);
    console[name] = (...args) => original(...args.map((arg) => (typeof arg === "string" ? plainText(arg) : arg)));
  }
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => write(typeof chunk === "string" ? plainText(chunk) : chunk, ...rest);
}

const BAR_FULL = process.platform === "win32" ? "#" : "█";
const BAR_EMPTY = process.platform === "win32" ? "-" : "░";

function usage() {
  return [
    "Roster Tim Ops + NOC",
    "",
    "Cara termudah: klik dua kali \"Buat Roster\" di folder Roster.",
    "",
    "Perintah:",
    "  node roster-cli.mjs menu                         menu pilihan (dipakai oleh Buat Roster)",
    "  node roster-cli.mjs buat [--bulan 2026-11]       buat roster (tanpa --bulan: bulan berikutnya)",
    "        [--paksa]          buat ulang walaupun roster bulan itu sudah ada (versi lama diarsipkan)",
    "        [--offline]        jangan cek hari libur ke internet",
    "        [--tanpa-riwayat]  mulai tanpa roster bulan lalu (semua dianggap baru libur)",
    "        [--tidak-buka]     jangan buka file Excel setelah selesai",
    "        [--cepat]          satu percobaan saja (lebih cepat, untuk uji coba). Bawaan: 6 percobaan paralel,",
    "                           dipilih yang paling sedikit temuan penting (sekitar 1-2 menit)",
    "        [--pertahankan]    perbarui roster yang sudah ada: jadwal lama dipertahankan sebisa mungkin",
    "                           (untuk cuti/sakit baru); hari sebelum hari ini tidak diubah",
    "                           (tanpa ini, --paksa menyusun ulang bebas; keduanya menandai perubahan dan tidak mengubah hari yang sudah lewat)",
    "        [--mulai 2026-10-06]  saat membuat ulang: tanggal pertama yang boleh berubah (bawaan: hari ini)",
    "        [--kunci-manual]   saat membuat ulang: perubahan manual di file roster tidak diubah, sisanya disusun di sekitarnya",
    "  node roster-cli.mjs cek [--bulan 2026-10]        cek roster yang sudah diubah manual",
    "  node roster-cli.mjs libur [--tahun 2027]         perbarui dan tampilkan data hari libur",
    "  node roster-cli.mjs kesiapan                     cek apakah semua siap untuk membuat roster berikutnya",
    "  node roster-cli.mjs siapkan                      buat Data Roster.xlsx bila belum ada",
    "  node roster-cli.mjs cuti --nama Addin --dari 2026-11-16 [--sampai 2026-11-18]",
    "        [--jenis Cuti|Sakit|Training/Dinas|\"Minta libur\"|\"Minta Shift 1\"|\"Hindari Shift 3\"] [--keterangan \"...\"]",
    "                                                   tambah satu baris di sheet Cuti & Permintaan",
    "",
    "Pilihan umum: --folder <folder Roster> (bawaan: folder di atas automation/v2)"
  ].join("\n");
}

function parseArgs(argv) {
  const [command = "menu", ...tokens] = argv;
  const options = {};
  const flags = new Set(["paksa", "offline", "tanpa-riwayat", "tidak-buka", "terbaik", "cepat", "pertahankan", "kunci-manual"]);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith("--")) throw new RosterError(`Pilihan tidak dikenal: ${token}`);
    const name = token.slice(2);
    if (flags.has(name)) options[name] = true;
    else {
      if (index + 1 >= tokens.length) throw new RosterError(`Pilihan ${token} perlu nilai, contoh ${token} 2026-11`);
      options[name] = tokens[index + 1];
      index += 1;
    }
  }
  return { command, options };
}

function openPath(target) {
  const [command, args] = process.platform === "darwin" ? ["open", [target]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", target]] : ["xdg-open", [target]];
  try {
    spawn(command, args, { detached: true, stdio: "ignore" }).unref();
  } catch {
    // Opening is a convenience; the path is printed anyway.
  }
}

function progressPrinter(label) {
  const tty = process.stdout.isTTY;
  let lastPercent = -1;
  return ({ step, done, total, round, rounds }) => {
    if (step === "perfect") {
      console.log(`  Belum sempurna, mencari lagi dengan percobaan terarah (putaran ${round} dari ${rounds})...`);
      lastPercent = -1;
    } else if (step === "search" || step === "perfect-search") {
      const percent = Math.round((done / total) * 100);
      if (tty) {
        const width = 30;
        const filled = Math.round((percent / 100) * width);
        process.stdout.write(`\r  Menyusun roster ${label}  [${BAR_FULL.repeat(filled)}${BAR_EMPTY.repeat(width - filled)}] ${percent}%`);
        if (done === total) process.stdout.write("\n");
      } else if (percent >= lastPercent + 25 || done === total) {
        console.log(`  Menyusun roster ${label}: ${percent}%`);
        lastPercent = percent;
      }
    } else if (step === "improve") console.log("  Merapikan hasil...");
    else if (step === "check") console.log("  Memeriksa semua aturan...");
  };
}

async function logError(root, error) {
  const file = path.join(root, "hasil", "log-kesalahan.txt");
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${new Date().toISOString()}\n${error.stack ?? error.message}\n`, "utf8");
    return file;
  } catch {
    return null;
  }
}

async function printError(root, error) {
  const plain = error instanceof RosterError ? error : explainFileError(error);
  if (plain) {
    console.log(`\n✖ ${plain.message}`);
    return;
  }
  const file = await logError(root, error);
  console.log("\n✖ Terjadi kesalahan program.");
  console.log(`  Pesan: ${error.message}`);
  if (file) console.log(`  Detail disimpan di ${path.relative(root, file)}. Kirim file itu ke pengelola roster.`);
}

function printBuat(root, done) {
  const relativeExcel = path.relative(root, done.files.excel).split(path.sep).join("/");
  const checks = done.result.audit.checks;
  console.log(`\n✔ Roster ${done.label} selesai.`);
  console.log(`   File Excel : ${relativeExcel}`);
  console.log(`   Aturan     : ${checks.every((check) => check.ok) ? "semua terpenuhi" : "ADA YANG TIDAK TERPENUHI"} (${checks.filter((check) => check.ok).length}/${checks.length})`);
  if (done.archived) console.log(`   Versi lama : disimpan di ${path.relative(root, done.archived).split(path.sep).join("/")}`);
  const quality = done.result.quality ?? { findings: [] };
  const serious = quality.findings.filter((finding) => finding.level === "penting");
  const minor = quality.findings.filter((finding) => finding.level !== "penting");
  if (quality.findings.length === 0) console.log("   Kualitas   : ✔ tidak ada temuan");
  else {
    console.log(`   Kualitas   : ${serious.length} temuan penting, ${minor.length} perhatian (rincian di sheet Ringkasan)`);
    for (const finding of serious) console.log(`     ⚠ ${finding.title}: ${finding.details.join(", ")}`);
  }
  const perfect = done.result.search?.perfect;
  if (perfect) {
    const extra = (perfect.rounds ? `, termasuk ${perfect.rounds} putaran percobaan terarah` : "") + (perfect.stoppedByTime ? " (putaran tambahan dihentikan: komputer ini lambat, batas waktu 6 menit)" : "");
    if (perfect.reached) console.log(`   Hasil      : ✔ SEMPURNA (semua aturan, 0 temuan penting, tidak ada skor kerja–hidup di bawah 65); ${perfect.tried} susunan dicoba${extra}`);
    else {
      const left = [...serious.map((finding) => finding.title), ...(perfect.wlbLow ? [`${perfect.wlbLow} orang dengan skor kerja–hidup di bawah 65`] : [])];
      console.log(`   Hasil      : terbaik dari ${perfect.tried} susunan${extra}; belum sempurna karena ${left.join("; ")}. Penyebabnya dijelaskan di Ringkasan.`);
    }
  }
  const wellbeing = done.result.wellbeing;
  if (wellbeing?.team !== null && wellbeing?.team !== undefined) {
    const scored = wellbeing.members.filter((item) => item.score !== null).sort((a, b) => a.score - b.score);
    console.log(`   Kerja–hidup: tim ${wellbeing.team}/100 (${wellbeing.teamLevel}); per orang ${scored.map((item) => `${item.name} ${item.score}`).join(", ")}`);
  }
  const changes = done.result.changes ?? [];
  if (changes.length > 0) {
    console.log(`   Perubahan  : ${changes.length} sel dibanding versi sebelumnya (beri tahu orang-orang ini):`);
    for (const member of done.result.members) {
      const own = changes.filter((change) => change.memberId === member.id);
      if (own.length) console.log(`     - ${member.name}: ${own.map((change) => `${formatTanggal(change.date, { pendek: true })} ${change.from}→${change.to}`).join(", ")}`);
    }
  }
  console.log("   Hal yang perlu diperhatikan:");
  for (const note of done.result.notes) console.log(`     • ${note}`);
  const warnings = [...done.warnings, ...done.holidayNotes, ...done.holidayDifferences.map((item) => `Perlu dicek: ${item.message}`)];
  if (warnings.length > 0) {
    console.log("   Peringatan:");
    for (const warning of warnings) console.log(`     ! ${warning}`);
  }
}

// Line-based prompter: lines typed (or piped) before a prompt appears are
// queued instead of lost, and end of input returns null (treated as "exit").
function createPrompter() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) });
  const queued = [];
  const waiting = [];
  let closed = false;
  rl.on("line", (line) => (waiting.length ? waiting.shift()(line) : queued.push(line)));
  rl.on("close", () => {
    closed = true;
    while (waiting.length) waiting.shift()(null);
  });
  return {
    async question(text) {
      process.stdout.write(text);
      let line;
      if (queued.length) line = queued.shift();
      else if (closed) line = null;
      else line = await new Promise((resolve) => waiting.push(resolve));
      if (!process.stdin.isTTY) process.stdout.write(`${line ?? ""}\n`);
      return line;
    },
    close: () => rl.close()
  };
}

async function ask(rl, question) {
  const line = await rl.question(question);
  return line === null ? null : line.trim().toLowerCase();
}

// Shows who is active, who joins/leaves, leave and holidays; in the menu the
// admin confirms, edits Data Roster.xlsx (then sees the review again) or cancels.
async function reviewBeforeBuilding(root, key, options, rl) {
  for (;;) {
    const preview = await previewRoster({ root, monthKey: key, online: !options.offline });
    console.log(`\n${preview.lines.join("\n")}`);
    if (!rl) return true;
    const answer = await ask(rl, "\nLanjut membuat roster? Ketik y = lanjut, u = ubah Data Roster.xlsx, t = batal: ");
    if (answer === null || ["t", "tidak", "batal", "n"].includes(answer)) return false;
    if (["y", "ya", "yes", "l", "lanjut"].includes(answer)) return true;
    if (["u", "ubah", "e", "edit"].includes(answer)) {
      openPath(workspacePaths(root).inputWorkbook);
      const done = await rl.question("Data Roster.xlsx dibuka. Setelah selesai mengubah, SIMPAN dan TUTUP file itu, lalu tekan Enter di sini...");
      if (done === null) return false;
      continue;
    }
    console.log("Pilihan tidak dikenal. Ketik y, u, atau t.");
  }
}

const YES = ["y", "ya", "yes"];

// The month already exists: confirm, then ask how to rebuild it. `confirmed`:
// the admin already said yes (menu 8 after a new request), so a plain "it exists"
// needs no second question and the old plan is kept.
async function confirmRebuild(error, rl, confirmed) {
  const { reason, manualCount = 0 } = error.details;
  if (!(confirmed && reason === "exists")) console.log(`\n! ${error.message}`);
  if (!rl) {
    console.log("  Jalankan lagi dengan --paksa untuk membuat ulang.");
    return null;
  }
  if (!(confirmed && reason === "exists")) {
    const answer = await ask(rl, "  Buat ulang sekarang? Ketik y lalu Enter (atau Enter saja untuk batal): ");
    if (!YES.includes(answer ?? "")) {
      console.log("  Dibatalkan. Tidak ada yang diubah.");
      return null;
    }
  }
  let lock = false;
  if (manualCount > 0) {
    const answer = await ask(rl, `  Kunci ${manualCount} perubahan manual di file roster? Ketik y (perubahan itu tetap, sisa jadwal disusun di sekitarnya) atau n (boleh ikut diubah) [y]: `);
    lock = !["n", "tidak", "no"].includes(answer ?? "");
  }
  if (confirmed) return { keep: true, lock };
  // New leave or sudden sickness: keep everyone's plans stable by default.
  const keepAnswer = await ask(rl, "  Pertahankan jadwal lama sebisa mungkin? Ketik y (disarankan untuk cuti/sakit baru: hanya diubah seperlunya) atau n (susun ulang bebas, misalnya setelah aturan berubah). Keduanya: hari yang sudah lewat tidak diubah dan setiap perubahan ditandai [y]: ");
  return { keep: !["n", "tidak", "no"].includes(keepAnswer ?? ""), lock };
}

async function runBuat(root, options, rl, { confirmed = false } = {}) {
  const key = options.bulan ?? (await nextMonthKey({ root }));
  parseMonthKey(key);
  if (!(await reviewBeforeBuilding(root, key, options, rl))) {
    console.log("Dibatalkan. Tidak ada yang diubah.");
    return null;
  }
  if (options.mulai && !/^\d{4}-\d{2}-\d{2}$/.test(options.mulai)) throw new RosterError(`Tanggal --mulai "${options.mulai}" harus berformat TAHUN-BULAN-TANGGAL, contoh 2026-10-06.`);
  const base = { root, monthKey: key, online: !options.offline, withoutHistory: Boolean(options["tanpa-riwayat"]), best: !options.cepat, from: options.mulai ?? null };
  let { keep, lockManual, force } = { keep: Boolean(options.pertahankan), lockManual: Boolean(options["kunci-manual"]), force: Boolean(options.paksa) };
  if (base.best) console.log("Mencari susunan terbaik: beberapa percobaan sekaligus, dipilih yang paling sedikit temuan penting (sekitar 1-2 menit).");
  console.log(`\nMembuat roster ${monthLabel(key)}...`);
  let done;
  for (;;) {
    try {
      done = await buatRoster({ ...base, keep, lockManual, force, onProgress: progressPrinter(monthLabel(key)) });
      break;
    } catch (error) {
      if (!(error instanceof RosterError)) throw error;
      if (error.details?.needsConfirmation) {
        const answer = await confirmRebuild(error, rl, confirmed);
        if (!answer) return null;
        force = true;
        keep ||= answer.keep;
        lockManual ||= answer.lock;
        continue;
      }
      // A day nobody can cover: offer a way out instead of stopping.
      if (!rl || !error.details?.date) throw error;
      const next = await rescueImpossibleDay(root, error, rl, { locked: lockManual });
      if (next === "cancel") {
        console.log("Dibatalkan. Roster belum dibuat; data yang sudah ditambahkan tetap tersimpan di Data Roster.xlsx.");
        return null;
      }
      if (next === "unlock") lockManual = false;
      console.log(`\nMenyusun lagi roster ${monthLabel(key)}...`);
    }
  }
  printBuat(root, done);
  if (!options["tidak-buka"]) openPath(done.files.excel);
  return done;
}

// "Roster tidak bisa disusun pada tanggal X": the admin picks how to go on and
// the roster is made again. Nothing is changed without the admin's answer.
async function rescueImpossibleDay(root, error, rl, { locked = false } = {}) {
  const date = error.details.date;
  console.log(`\n✖ ${error.message}`);
  for (;;) {
    console.log("\nCara melanjutkan:");
    console.log(`  1. Tambah anggota sementara (orang luar tim) mulai ${formatTanggal(date, { denganHari: true })}, lalu susun lagi`);
    console.log("  2. Buka Data Roster.xlsx (geser cuti/permintaan atau ubah anggota), lalu susun lagi");
    if (locked) console.log("  3. Jangan kunci perubahan manual, lalu susun lagi");
    console.log("  0. Batal");
    const choice = await ask(rl, "Ketik nomor lalu tekan Enter: ");
    if (choice === null || choice === "0" || choice === "") return "cancel";
    if (choice === "1") {
      if (await addTemporaryMember(root, date, rl)) return "retry";
    } else if (choice === "2") {
      openPath(workspacePaths(root).inputWorkbook);
      if ((await rl.question("Data Roster.xlsx dibuka. Setelah selesai mengubah, SIMPAN dan TUTUP file itu, lalu tekan Enter di sini...")) === null) return "cancel";
      return "retry";
    } else if (choice === "3" && locked) return "unlock";
    else console.log("Pilihan tidak dikenal.");
  }
}

const shiftList = (shifts) => shifts.map((id) => `Shift ${id}`).join(", ");

// A person from outside the team for the days the team cannot cover: picked
// from "Cadangan Luar Tim" or typed in, then added to the Anggota sheet with
// "Mulai Bergabung"/"Terakhir Bekerja" so they appear only on those days.
async function addTemporaryMember(root, date, rl) {
  const file = workspacePaths(root).inputWorkbook;
  const input = await readInputWorkbook(file);
  const backups = input.externalBackups ?? [];
  if (backups.length) {
    console.log("Cadangan luar tim (sheet Cadangan Luar Tim):");
    backups.forEach((backup, index) => console.log(`  ${index + 1}. ${backup.name}${backup.origin ? ` (${backup.origin})` : ""}: boleh ${shiftList(backup.eligibleShifts)}`));
  }
  const answer = ((await rl.question(backups.length ? "Ketik nomor cadangan di atas, atau nama orang lain (Enter = kembali): " : "Nama orang luar tim (Enter = kembali): ")) ?? "").trim();
  if (!answer) return false;
  const picked = /^\d+$/.test(answer) ? backups[Number(answer) - 1] : backups.find((backup) => backup.name.toLowerCase() === answer.toLowerCase());
  if (/^\d+$/.test(answer) && !picked) {
    console.log(`Nomor ${answer} tidak ada di daftar.`);
    return false;
  }
  const name = picked?.name ?? answer;
  const existing = input.members.find((member) => member.name.toLowerCase() === name.toLowerCase());
  if (existing) {
    console.log(`${existing.name} sudah ada di sheet Anggota. Ubah tanggal atau shift-nya lewat pilihan 2, atau pilih orang lain.`);
    return false;
  }
  let shifts = picked?.eligibleShifts;
  if (!shifts) {
    const text = (await rl.question("Boleh shift apa? Ketik angkanya, contoh 3 (malam saja), 12 (pagi dan siang) atau 123: ")) ?? "";
    shifts = ["1", "2", "3"].filter((id) => text.includes(id));
    if (shifts.length === 0) {
      console.log("Isi minimal satu shift: 1, 2 atau 3.");
      return false;
    }
  }
  const gender = (await ask(rl, "Jenis kelamin? Ketik L atau P [L]: ")) === "p" ? "P" : "L";
  // Nights come in blocks of at least 2, so a night helper stays 2 days.
  const { year, month } = parseMonthKey(date.slice(0, 7));
  const monthEnd = monthBounds(year, month).end;
  const nextDay = isoDate(addDays(date, 1));
  const suggested = shifts.includes("3") && nextDay <= monthEnd ? nextDay : date;
  const example = `${suggested.slice(8)}/${suggested.slice(5, 7)}/${year}`;
  const untilText = ((await rl.question(`Sampai tanggal berapa? Contoh ${example} [Enter = ${formatTanggal(suggested)}]: `)) ?? "").trim();
  const until = untilText ? parseTanggal(untilText, { year }) : suggested;
  if (!until || until < date) {
    console.log(`Tanggal "${untilText}" tidak dikenal atau sebelum ${formatTanggal(date)}. Contoh yang benar: ${example}.`);
    return false;
  }
  try {
    const added = await appendMember(file, { name, gender, shifts, from: date, to: until });
    console.log(`✔ ${added.name} ditambahkan di sheet Anggota (baris ${added.row}) sebagai anggota sementara ${formatTanggal(date, { pendek: true })}${until !== date ? ` – ${formatTanggal(until, { pendek: true })}` : ""}, boleh ${shiftList(shifts)}.`);
    return true;
  } catch (failure) {
    if (!(failure instanceof RosterError)) throw failure;
    console.log(`✖ Tidak bisa ditambahkan: ${failure.message}`);
    return false;
  }
}

// Short help shown next to each kind in menu 8.
const KIND_HINT = Object.freeze({
  C: "cuti tahunan/khusus (dihitung hari kerja)",
  S: "sakit; setelahnya beberapa hari tanpa Shift 3",
  T: "training atau dinas luar (dihitung hari kerja)",
  H: "libur pada tanggal itu",
  1: "harus masuk Shift 1 (pagi)",
  2: "harus masuk Shift 2 (siang)",
  3: "harus masuk Shift 3 (malam)",
  "!1": "boleh masuk, tapi jangan Shift 1 (misalnya ada urusan pagi)",
  "!2": "boleh masuk, tapi jangan Shift 2",
  "!3": "boleh masuk, tapi jangan Shift 3 (misalnya kuliah malam)"
});

// Menu 8: leave or a special request by question and answer (no Excel needed),
// then, when that month already has a roster, rebuild it right away.
async function runPermintaan(root, rl) {
  await siapkanData({ root });
  const file = workspacePaths(root).inputWorkbook;
  const input = await readInputWorkbook(file);
  const pick = async (question, items) => {
    const answer = ((await rl.question(question)) ?? "").trim();
    if (!answer) return null;
    const chosen = /^\d+$/.test(answer) ? items[Number(answer) - 1] : items.find((item) => item.label.toLowerCase() === answer.toLowerCase());
    if (!chosen) console.log(`"${answer}" tidak ada di daftar.`);
    return chosen ?? null;
  };
  console.log("\nTambah cuti atau permintaan khusus. Tekan Enter saja untuk batal.");
  const members = input.members.map((member) => ({ label: member.name, member }));
  members.forEach((item, index) => console.log(`  ${index + 1}. ${item.label}${item.member.activeUntil ? ` (sampai ${formatTanggal(item.member.activeUntil, { pendek: true })})` : ""}`));
  const who = await pick("Siapa? Ketik nomor atau nama: ", members);
  if (!who) return null;
  const kinds = REQUEST_KINDS.map(([label, code]) => ({ label, code }));
  console.log("Jenis:");
  kinds.forEach((kind, index) => console.log(`  ${String(index + 1).padStart(2)}. ${kind.label.padEnd(16)} ${KIND_HINT[kind.code] ?? ""}`));
  const kind = await pick("Ketik nomor jenis: ", kinds);
  if (!kind) return null;
  const shiftId = kind.code.replace("!", "");
  if (/^\d$/.test(shiftId) && !who.member.eligibleShifts.includes(shiftId)) {
    console.log(kind.code.startsWith("!")
      ? `${who.label} memang tidak pernah dijadwalkan ${KODE_LABEL[shiftId]}, jadi permintaan ini tidak perlu. Tidak ada yang diubah.`
      : `${who.label} tidak boleh ${KODE_LABEL[shiftId]} (lihat sheet Anggota). Tidak ada yang diubah.`);
    return null;
  }
  // Dates as typed (16/11/2026, 16-11-2026, 2026-11-16 or 16/11 for this year,
  // or next year when that date is already more than two months ago).
  const today = new Date();
  const todayIso = isoDate(new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate())));
  const readDate = async (question, fallback) => {
    const text = ((await rl.question(question)) ?? "").trim();
    if (!text) return fallback;
    let date = parseTanggal(text, { year: today.getFullYear() });
    if (date && !/\d{4}/.test(text) && date < isoDate(addDays(todayIso, -60))) date = parseTanggal(text, { year: today.getFullYear() + 1 });
    if (!date) console.log(`Tanggal "${text}" tidak dikenal. Contoh: 16/11/2026 atau 2026-11-16.`);
    return date;
  };
  const from = await readDate("Dari tanggal? Contoh 16/11/2026: ", null);
  if (!from) return null;
  const to = await readDate(`Sampai tanggal? (Enter = ${formatTanggal(from, { pendek: true })} saja): `, from);
  if (!to) return null;
  if (to < from) {
    console.log("Tanggal akhir sebelum tanggal awal. Tidak ada yang diubah.");
    return null;
  }
  const note = ((await rl.question("Keterangan (boleh kosong): ")) ?? "").trim();
  const added = await appendRequest(file, { name: who.label, from, to, kind: kind.label, note });
  console.log(`✔ Ditambahkan di Data Roster.xlsx (sheet Cuti & Permintaan, baris ${added.row}): ${added.name}, ${added.kind}, ${formatTanggal(from, { denganHari: true })}${to !== from ? ` – ${formatTanggal(to, { denganHari: true })}` : ""}.`);
  if (from < todayIso) console.log("  Catatan: tanggal yang sudah lewat tidak diubah saat roster disusun ulang. Catat langsung di file roster, lalu jalankan menu 3 (Cek roster).");
  // Rebuild the months that already have a roster (an update: only what is needed changes).
  const keys = [...new Set([from, to].map((date) => date.slice(0, 7)))];
  for (const key of keys) {
    const exists = await loadMonthCodes(workspacePaths(root), key).then(() => true, () => false);
    if (!exists) {
      console.log(`  Permintaan ini dipakai saat roster ${monthLabel(key)} dibuat (menu 1 atau 2).`);
      continue;
    }
    const answer = await ask(rl, `Roster ${monthLabel(key)} sudah ada. Susun ulang sekarang agar permintaan ini dipakai? Ketik y (hanya diubah seperlunya; Enter = nanti): `);
    if (YES.includes(answer ?? "")) await runBuat(root, { bulan: key, pertahankan: true }, rl, { confirmed: true });
    else console.log(`  Nanti: pilih menu 2, bulan ${key}, lalu "buat ulang".`);
  }
  return added;
}

async function runCek(root, options) {
  const report = await cekRoster({ root, monthKey: options.bulan });
  console.log(`\nCek roster ${report.label} (${path.relative(root, report.file).split(path.sep).join("/")})`);
  if (report.manualChanges.length > 0) {
    console.log(`Perubahan manual dibanding hasil awal: ${report.manualChanges.length}`);
    for (const change of report.manualChanges.slice(0, 20)) {
      console.log(`  • ${change.name} ${formatTanggal(change.date, { pendek: true })}: ${KODE_LABEL[change.from] ?? change.from} → ${KODE_LABEL[change.to] ?? change.to}`);
    }
  } else console.log("Tidak ada perubahan manual dibanding hasil awal.");
  for (const note of report.notes) console.log(`  ! ${note}`);
  const failed = report.checks.filter((check) => !check.ok);
  if (failed.length === 0) {
    console.log("\n✔ Semua aturan terpenuhi. Roster aman dipakai.");
  } else {
    console.log(`\n✖ ${failed.length} aturan tidak terpenuhi:`);
    for (const check of failed) {
      console.log(`  • ${check.judul}`);
      for (const violation of check.pelanggaran.slice(0, 8)) console.log(`      - ${violation.pesan}`);
    }
    console.log("\nPerbaiki di sheet Roster, simpan, lalu cek lagi.");
  }
  return report;
}

async function runLibur(root, options) {
  const years = options.tahun ? String(options.tahun).split(",").map((year) => Number(year.trim())) : undefined;
  console.log("\nMemeriksa data hari libur...");
  const { calendars, notes, differences } = await perbaruiHariLibur({ root, years, online: !options.offline });
  for (const calendar of calendars) {
    const status = calendar.status === "official-verified" ? "resmi, sudah dicek" : calendar.status === "auto-google" ? "otomatis dari Google Calendar, perlu dicek" : calendar.status;
    console.log(`\n${calendar.year}: ${calendar.days.length} tanggal merah/cuti bersama (${status})`);
    for (const day of calendar.days) console.log(`   ${formatTanggal(day.date, { pendek: true }).padEnd(7)} ${day.type === "national" ? "Libur nasional" : "Cuti bersama  "}  ${day.name}${day.tentative ? " (belum pasti)" : ""}`);
  }
  for (const note of notes) console.log(`! ${note}`);
  if (differences.length > 0) {
    console.log("\nPerlu dicek (daftar resmi berbeda dengan Google Calendar):");
    for (const difference of differences) console.log(`  • ${difference.message}`);
  }
}

async function runKesiapan(root) {
  const report = await periksaSistem({ root });
  console.log(`\nKesiapan untuk membuat roster ${report.label}:`);
  const mark = { ok: "✔", perhatian: "!", masalah: "✖" };
  for (const item of report.items) console.log(`  ${mark[item.level]} ${item.text}`);
  console.log(report.ok ? "\n✔ Siap. Roster bisa dibuat." : "\n✖ Perbaiki yang bertanda ✖ dulu, lalu cek lagi.");
  return report;
}

async function runMenu(root) {
  const paths = workspacePaths(root);
  const rl = createPrompter();
  try {
    for (;;) {
      const next = await nextMonthKey({ root });
      console.log(`\n${LINE}\n  ROSTER TIM OPS + NOC\n${LINE}`);
      console.log(`  1. Buat roster bulan berikutnya (${monthLabel(next)})`);
      console.log("  2. Buat roster bulan lain / buat ulang");
      console.log("  3. Cek roster yang sudah diubah manual");
      console.log("  4. Perbarui data hari libur");
      console.log("  5. Buka Data Roster.xlsx (anggota, cuti, aturan)");
      console.log("  6. Buka folder hasil");
      console.log("  7. Cek kesiapan program");
      console.log("  8. Tambah cuti / permintaan khusus (tanya-jawab)");
      console.log("  0. Keluar");
      const choice = await ask(rl, "\nKetik nomor lalu tekan Enter: ");
      if (choice === null || choice === "0" || choice === "q" || choice === "keluar") break;
      try {
        if (choice === "1") await runBuat(root, { bulan: next }, rl);
        else if (choice === "2") {
          const key = ((await rl.question("Bulan berapa? Ketik TAHUN-BULAN, contoh 2026-12: ")) ?? "").trim();
          parseMonthKey(key);
          await runBuat(root, { bulan: key }, rl);
        } else if (choice === "3") {
          const key = ((await rl.question("Bulan berapa? Ketik TAHUN-BULAN (Enter = roster terakhir): ")) ?? "").trim();
          if (key) parseMonthKey(key);
          await runCek(root, { bulan: key || undefined });
        } else if (choice === "4") {
          await runLibur(root, {});
        } else if (choice === "5") {
          const prepared = await siapkanData({ root });
          if (prepared.created) console.log("Data Roster.xlsx dibuat dengan tim saat ini.");
          openPath(paths.inputWorkbook);
          console.log("Data Roster.xlsx dibuka. Setelah mengubah, simpan dan tutup file itu sebelum membuat roster.");
        } else if (choice === "6") {
          await mkdir(paths.resultsDir, { recursive: true });
          openPath(paths.resultsDir);
        } else if (choice === "7") {
          await runKesiapan(root);
        } else if (choice === "8") {
          await runPermintaan(root, rl);
        } else {
          console.log("Pilihan tidak dikenal. Ketik salah satu nomor di menu.");
          continue;
        }
      } catch (error) {
        await printError(root, error);
      }
      if ((await rl.question("\nTekan Enter untuk kembali ke menu...")) === null) break;
    }
  } finally {
    rl.close();
  }
}

async function main() {
  let root = DEFAULT_ROOT;
  try {
    const { command, options } = parseArgs(process.argv.slice(2));
    if (options.folder) root = path.resolve(options.folder);
    if (["bantuan", "help", "-h", "--help"].includes(command)) console.log(usage());
    else if (["menu"].includes(command)) await runMenu(root);
    else if (["buat", "generate"].includes(command)) {
      const done = await runBuat(root, options, null);
      if (done === null) process.exitCode = 2;
    } else if (["cek", "check"].includes(command)) {
      const report = await runCek(root, options);
      if (!report.ok) process.exitCode = 1;
    } else if (["libur", "holidays"].includes(command)) await runLibur(root, options);
    else if (["kesiapan", "doctor"].includes(command)) {
      const report = await runKesiapan(root);
      if (!report.ok) process.exitCode = 1;
    }
    else if (["cuti", "permintaan"].includes(command)) {
      if (!options.nama || !options.dari) throw new RosterError('Perintah cuti butuh --nama dan --dari, contoh: cuti --nama Addin --dari 2026-11-16 --sampai 2026-11-18');
      for (const date of [options.dari, options.sampai].filter(Boolean)) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new RosterError(`Tanggal "${date}" harus berformat TAHUN-BULAN-TANGGAL, contoh 2026-11-16.`);
      }
      await siapkanData({ root });
      const added = await appendRequest(workspacePaths(root).inputWorkbook, { name: options.nama, from: options.dari, to: options.sampai, kind: options.jenis ?? "Cuti", note: options.keterangan ?? "" });
      console.log(`✔ Ditambahkan di Data Roster.xlsx (sheet Cuti & Permintaan, baris ${added.row}): ${added.name}, ${added.kind}, ${formatTanggal(options.dari, { pendek: true })}${options.sampai ? ` – ${formatTanggal(options.sampai, { pendek: true })}` : ""}.`);
      console.log("  Buat ulang roster bulan itu agar perubahan dipakai.");
    } else if (["siapkan", "init"].includes(command)) {
      const prepared = await siapkanData({ root });
      console.log(prepared.created ? "✔ Data Roster.xlsx dibuat." : "Data Roster.xlsx sudah ada.");
    } else {
      console.log(`Perintah "${command}" tidak dikenal.\n`);
      console.log(usage());
      process.exitCode = 1;
    }
  } catch (error) {
    await printError(root, error);
    process.exitCode = 1;
  }
}

main();
