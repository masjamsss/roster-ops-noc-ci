// "Data Roster.xlsx": the only file admin staff edit. Yellow cells are inputs,
// grey cells are filled by the tool. Every read error names the sheet and row.
import { readFile, writeFile } from "node:fs/promises";
import ExcelJS from "exceljs";
import { DEFAULT_COVERAGE, DEFAULT_RULES, DEFAULT_SHIFTS, DEFAULT_TEAM } from "./defaults.mjs";
import { RosterError } from "./errors.mjs";
import { formatTanggal, KODE_LABEL } from "./labels-id.mjs";

export const INPUT_LAYOUT = Object.freeze({
  guide: { sheet: "Petunjuk" },
  members: { sheet: "Anggota", headerRow: 4, firstRow: 5, rows: 30 },
  requests: { sheet: "Cuti & Permintaan", headerRow: 5, firstRow: 6, rows: 300 },
  coverage: { sheet: "Kebutuhan Shift" },
  externalBackups: { sheet: "Cadangan Luar Tim", headerRow: 4, firstRow: 5, rows: 20 },
  rules: { sheet: "Aturan" }
});

export const REQUEST_KINDS = Object.freeze([
  ["Cuti", "C"],
  ["Sakit", "S"],
  ["Training/Dinas", "T"],
  ["Minta libur", "H"],
  ["Minta Shift 1", "1"],
  ["Minta Shift 2", "2"],
  ["Minta Shift 3", "3"],
  // Special requests (3 Oct): can work that day, but not this shift (an evening
  // class, a morning appointment). Several may cover the same day.
  ["Hindari Shift 1", "!1"],
  ["Hindari Shift 2", "!2"],
  ["Hindari Shift 3", "!3"]
]);

const RULE_ROWS = Object.freeze([
  { key: "maxConsecutiveWorkDays", label: "Maksimal hari kerja berturut-turut", min: 3, max: 7, explain: "Termasuk sambungan dari bulan sebelumnya. Training/dinas dihitung hari kerja." },
  { key: "nightPreferred", label: "Blok Shift 3 normal (malam berturut-turut)", min: 1, max: 3, explain: "Jumlah malam berturut-turut yang diutamakan." },
  { key: "nightMax", label: "Blok Shift 3 maksimal", min: 1, max: 4, explain: "Blok 3 malam dipakai bila membuat jadwal lebih rapi atau hari kerja lebih terisi (dengan 4 orang di Shift 3, blok 2 malam saja membatasi hari kerja mereka sekitar 19-20 hari). Isi sama dengan blok normal agar tidak pernah lebih panjang." },
  { key: "nightRecoveryOffDays", label: "Hari libur setelah blok Shift 3", min: 1, max: 3, explain: "Libur wajib sesudah malam terakhir, sebelum masuk kerja lagi." },
  { key: "minimumRestHours", label: "Istirahat minimal antar shift (jam)", min: 8, max: 16, explain: "Dihitung dari jam selesai satu shift ke jam mulai shift berikutnya." },
  { key: "maxConsecutiveOffDays", label: "Maksimal libur (H) berturut-turut", min: 1, max: 4, explain: "Tidak berlaku untuk cuti, sakit atau libur yang diminta." },
  { key: "workDaysTarget", label: "Target hari kerja per orang per bulan", kind: "auto", min: 15, max: 26, explain: "\"Otomatis\" = pekerjaan ideal bulan itu (2-2-1 di hari kerja, 1-1-1 di Sabtu/Minggu/tanggal merah) dibagi rata ke semua anggota, maksimal 5 hari kerja per minggu: 22 hari di bulan 31 hari, 21 di bulan 30 hari, 20 di Februari. Cuti, sakit dan training mengurangi target orang itu 1:1. Isi angka (misalnya 21) bila ada target tetap." },
  { key: "workDaysTargetHoursCap", label: "Target hari kerja yang boleh Shift 3 mengikuti batas jam per minggu", kind: "yesno", optional: true, explain: "Tidak = semua orang targetnya sama (misalnya 22 hari). Ya = target orang yang boleh Shift 3 diturunkan supaya rata-rata jam kerja bersihnya per minggu tidak melewati \"Batas jam kerja bersih per minggu\", karena Shift 3 lebih panjang (9 jam bersih, Shift 1/2 8 jam). Contoh bulan 31 hari: 21 hari, bukan 22. Hanya berlaku bila target = Otomatis. Uji 6 bulan: temuan penting sedikit berkurang, tetapi ada 2 hari IDEAL lebih sedikit. Saran pengelola: Tidak." },
  { key: "balanceDayOnlyShifts", label: "Seimbangkan Shift 1 dan Shift 2 untuk yang tidak boleh Shift 3", kind: "yesno", explain: "Ya = kira-kira separuh Shift 1 dan separuh Shift 2 setiap bulan." },
  { key: "breakHours", label: "Istirahat tidak dibayar per shift (jam)", min: 0, max: 2, optional: true, explain: "Dipakai untuk menghitung jam kerja bersih. Contoh: Shift 1 07:00-16:00 dengan istirahat 1 jam = 8 jam kerja." },
  { key: "weeklyHoursLimit", label: "Batas jam kerja bersih per minggu", min: 35, max: 48, optional: true, explain: "Senin-Minggu. Roster berusaha tidak melewati batas ini; kelebihannya dilaporkan untuk HR (bisa menjadi lembur)." },
  { key: "dailyHoursLimit", label: "Batas jam kerja bersih per hari (rekap lembur HR)", min: 6, max: 12, optional: true, explain: "Hanya untuk laporan HR, tidak mengubah roster. 8 = skema 5 hari kerja (8 jam sehari, 40 jam seminggu); 7 = skema 6 hari kerja. Shift 3 = 9 jam bersih, jadi setiap malam ada 1 jam di atas 8 jam yang bisa menjadi lembur." },
  { key: "nightFreeDaysAfterSick", label: "Hari tanpa Shift 3 setelah sakit lama (3 hari atau lebih)", aliases: ["Hari tanpa Shift 3 setelah sakit"], min: 0, max: 14, optional: true, explain: "Setelah sakit 3 hari atau lebih berturut-turut (misalnya rawat inap), orang itu mulai lagi dengan shift pagi/siang: tidak Shift 3 selama sekian hari, dihitung dari hari sakit terakhir. 0 = tanpa aturan ini." },
  { key: "nightFreeDaysAfterShortSick", label: "Hari tanpa Shift 3 setelah sakit singkat (1–2 hari)", min: 0, max: 14, optional: true, explain: "Untuk sakit 1–2 hari berturut-turut (misalnya flu). Isi sama dengan baris di atas bila tidak ingin dibedakan. Saran pengelola: 2. Tidak boleh lebih besar dari baris di atas." },
  { key: "overtimeHours", label: "Lembur maksimal per orang untuk menutup yang berhalangan (jam)", min: 0, max: 6, optional: true, explain: "Untuk rencana di sheet Cadangan: shift sebelumnya boleh pulang lebih lambat dan/atau shift berikutnya datang lebih awal, masing-masing paling lama sekian jam. Lembur tidak pernah menggantikan satu shift penuh." },
  { key: "longNightBlockOnlyIfNeeded", label: "Blok 3 malam hanya bila terpaksa", kind: "yesno", optional: true, explain: "Ya = Shift 3 dibuat blok 2 malam; blok 3 malam hanya dipakai bila tidak ada jalan lain (misalnya bulan 31 hari biasanya butuh satu). Tidak = blok 3 malam dipakai bila membuat hari kerja lebih terisi." },
  { key: "leaveCountsAsWork", label: "Cuti dihitung hari kerja (batas hari berturut-turut dan istirahat setelah Shift 3)", kind: "yesno", optional: true, explain: "Ya = cuti dianggap seperti hari masuk: tidak memutus hitungan maksimal hari kerja berturut-turut, dan tidak dihitung sebagai 2 hari libur setelah Shift 3. Jadi cuti tidak mengurangi libur yang seharusnya didapat. Sakit tetap dihitung libur." },
  { key: "fridayShift1Female", label: "Jumat: Shift 1 diutamakan ada agen perempuan (sholat Jumat)", kind: "yesno", optional: true, explain: "Ya = setiap Jumat minimal 1 agen perempuan di Shift 1, agar tetap ada yang jaga saat agen laki-laki sholat Jumat." },
  { key: "shift1", label: "Jam Shift 1 (Pagi)", kind: "time", explain: "Format jam mulai-selesai, contoh 07:00-16:00." },
  { key: "shift2", label: "Jam Shift 2 (Siang)", kind: "time", explain: "Format jam mulai-selesai, contoh 13:00-21:00." },
  { key: "shift3", label: "Jam Shift 3 (Malam)", kind: "time", explain: "Format jam mulai-selesai, contoh 21:00-07:00 (selesai besok pagi)." }
]);

const COLORS = { navy: "FF17324D", input: "FFFFF2CC", auto: "FFE7E6E6", note: "FF595959", white: "FFFFFFFF", border: "FFBFBFBF", example: "FF7F7F7F" };
const FONT = "Arial";
const thin = { style: "thin", color: { argb: COLORS.border } };
const box = { top: thin, left: thin, bottom: thin, right: thin };

// ---------- helpers ----------

export function slugify(name) {
  return String(name).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function cellText(cell) {
  const value = cell?.value;
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object") {
    if (Array.isArray(value.richText)) return value.richText.map((part) => part.text).join("").trim();
    if (value.text !== undefined) return String(value.text).trim();
    if (value.result !== undefined) return value.result instanceof Date ? value.result.toISOString().slice(0, 10) : String(value.result).trim();
    return "";
  }
  return String(value).trim();
}

function excelSerialToIso(serial) {
  return new Date(Math.round((serial - 25569) * 86_400_000)).toISOString().slice(0, 10);
}

// Accepts real Excel dates, Excel serial numbers, 16/11/2026, 16-11-2026 and 2026-11-16.
function cellDate(cell) {
  const value = cell?.value;
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object" && value.result instanceof Date) return value.result.toISOString().slice(0, 10);
  if (typeof value === "number") return excelSerialToIso(value);
  const text = cellText(cell);
  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  if (match) return `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
  match = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(text);
  if (match) return `${match[3]}-${match[2].padStart(2, "0")}-${match[1].padStart(2, "0")}`;
  return undefined;
}

function yesNo(text) {
  const value = text.toLowerCase();
  if (["ya", "y", "yes", "true", "1", "iya"].includes(value)) return true;
  if (["tidak", "t", "no", "n", "false", "0", ""].includes(value)) return false;
  return undefined;
}

function styleTitle(sheet, text, subtitle) {
  sheet.getCell("A1").value = text;
  sheet.getCell("A1").font = { name: FONT, size: 14, bold: true, color: { argb: COLORS.navy } };
  if (subtitle) {
    sheet.getCell("A2").value = subtitle;
    sheet.getCell("A2").font = { name: FONT, size: 10, italic: true, color: { argb: COLORS.note } };
  }
}

function styleHeader(row) {
  row.eachCell((cell) => {
    cell.font = { name: FONT, bold: true, color: { argb: COLORS.white } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLORS.navy } };
    cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
    cell.border = box;
  });
  row.height = 44;
}

function styleCell(cell, kind, extra = {}) {
  cell.font = { name: FONT, size: 11, ...(extra.font ?? {}) };
  cell.border = box;
  if (kind === "input") cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLORS.input } };
  if (kind === "auto") cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLORS.auto } };
  cell.alignment = { vertical: "middle", ...(extra.alignment ?? {}) };
  if (extra.numFmt) cell.numFmt = extra.numFmt;
}

function utcDate(iso) {
  return new Date(`${iso}T00:00:00Z`);
}

// ---------- create ----------

export async function createInputWorkbook(file, { team = DEFAULT_TEAM, coverage = DEFAULT_COVERAGE, rules = DEFAULT_RULES, shifts = DEFAULT_SHIFTS } = {}) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Roster Ops + NOC";
  workbook.created = new Date();

  const guide = workbook.addWorksheet(INPUT_LAYOUT.guide.sheet, { properties: { tabColor: { argb: COLORS.navy } } });
  guide.getColumn(1).width = 110;
  styleTitle(guide, "DATA ROSTER — TIM OPS + NOC", "File ini adalah satu-satunya tempat admin mengisi data. Jangan ubah nama sheet atau judul kolom.");
  const lines = [
    ["Setiap bulan", true],
    ["1. Buka sheet \"Cuti & Permintaan\". Isi satu baris untuk setiap cuti, sakit, training/dinas, atau permintaan libur/shift.", false],
    ["2. Simpan file ini (Ctrl+S di Windows, Cmd+S di Mac), lalu tutup.", false],
    ["3. Klik dua kali \"Buat Roster\" (Mac: Buat Roster.command, Windows: Buat Roster.bat) lalu pilih menu 1.", false],
    ["4. Hasil ada di folder hasil/TAHUN-BULAN. Periksa sheet Ringkasan, lalu kirim ke Operations Manager.", false],
    ["5. Setelah Operations Manager setuju: di file roster, sheet Ringkasan bagian \"Persetujuan\", ubah Status roster menjadi DISETUJUI lalu simpan.", false],
    ["", false],
    ["Cadangan dari luar tim (boleh dikosongkan)", true],
    ["• Isi sheet \"Cadangan Luar Tim\" dengan orang di luar tim yang bisa dihubungi bila ada yang sakit mendadak dan tidak ada cadangan dalam tim.", false],
    ["• Mereka tidak dijadwalkan, hanya ditampilkan di sheet Cadangan pada file roster.", false],
    ["", false],
    ["Kalau ada anggota baru atau keluar", true],
    ["• Anggota baru: isi baris kosong di sheet \"Anggota\" (Nama, Jenis Kelamin, Boleh Shift 1/2/3, Mulai Bergabung).", false],
    ["• Anggota keluar: isi kolom \"Terakhir Bekerja\". Jangan hapus barisnya supaya riwayatnya tetap tercatat.", false],
    ["• Kolom ID diisi otomatis. Jangan diubah, karena ID menghubungkan riwayat roster antarbulan.", false],
    ["", false],
    ["Warna sel", true],
    ["• Kuning = boleh diisi atau diubah.   • Abu-abu = diisi otomatis, jangan diubah.", false],
    ["", false],
    ["Kode di roster", true],
    ...shifts.map((shift) => [`• ${shift.id} = ${shift.label} (${shift.name}) ${shift.start}–${shift.end}`, false]),
    ["• H = Libur   • C = Cuti   • S = Sakit   • T = Training/Dinas   • - = Belum/sudah tidak aktif di tim", false],
    ["", false],
    ["Bantuan", true],
    ["Lihat file PANDUAN-ADMIN.md di folder Roster untuk arti setiap pesan dan langkah bila ada masalah.", false]
  ];
  lines.forEach(([text, heading], index) => {
    const cell = guide.getCell(`A${index + 4}`);
    cell.value = text;
    cell.font = { name: FONT, size: heading ? 12 : 11, bold: heading, color: { argb: heading ? COLORS.navy : "FF000000" } };
    cell.alignment = { wrapText: true, vertical: "top" };
  });

  // Anggota
  const membersLayout = INPUT_LAYOUT.members;
  const members = workbook.addWorksheet(membersLayout.sheet, { views: [{ state: "frozen", ySplit: membersLayout.headerRow }] });
  styleTitle(members, "ANGGOTA TIM", "Satu baris per orang. Urutan baris = urutan di roster. Kuning boleh diubah, abu-abu diisi otomatis.");
  const memberHeaders = ["No", "Nama", "ID (otomatis)", "Jenis Kelamin (L/P)", "Boleh Shift 1", "Boleh Shift 2", "Boleh Shift 3", "Mulai Bergabung", "Terakhir Bekerja", "Catatan"];
  [5, 18, 16, 13, 10, 10, 10, 15, 15, 36].forEach((width, index) => (members.getColumn(index + 1).width = width));
  members.getRow(membersLayout.headerRow).values = memberHeaders;
  styleHeader(members.getRow(membersLayout.headerRow));
  for (let offset = 0; offset < membersLayout.rows; offset += 1) {
    const row = members.getRow(membersLayout.firstRow + offset);
    const member = team[offset];
    row.getCell(1).value = offset + 1;
    styleCell(row.getCell(1), "auto", { alignment: { horizontal: "center" } });
    if (member) {
      row.getCell(2).value = member.name;
      row.getCell(3).value = member.id;
      row.getCell(4).value = member.gender ?? "";
      ["1", "2", "3"].forEach((shiftId, index) => (row.getCell(5 + index).value = member.eligibleShifts.includes(shiftId) ? "Ya" : "Tidak"));
      if (member.activeFrom) row.getCell(8).value = utcDate(member.activeFrom);
      if (member.activeUntil) row.getCell(9).value = utcDate(member.activeUntil);
    }
    styleCell(row.getCell(2), "input");
    styleCell(row.getCell(3), "auto", { font: { color: { argb: COLORS.note } } });
    for (const column of [4, 5, 6, 7]) styleCell(row.getCell(column), "input", { alignment: { horizontal: "center" } });
    for (const column of [8, 9]) styleCell(row.getCell(column), "input", { numFmt: "dd/mm/yyyy", alignment: { horizontal: "center" } });
    styleCell(row.getCell(10), "input");
    row.getCell(4).dataValidation = { type: "list", allowBlank: true, formulae: ['"L,P"'] };
    for (const column of [5, 6, 7]) row.getCell(column).dataValidation = { type: "list", allowBlank: true, formulae: ['"Ya,Tidak"'] };
    for (const column of [8, 9]) {
      row.getCell(column).dataValidation = { type: "date", operator: "greaterThan", allowBlank: true, showErrorMessage: true, errorTitle: "Tanggal", error: "Isi tanggal, contoh 16/11/2026.", formulae: [new Date(Date.UTC(2020, 0, 1))] };
    }
  }

  // Cuti & Permintaan
  const requestsLayout = INPUT_LAYOUT.requests;
  const requests = workbook.addWorksheet(requestsLayout.sheet, { views: [{ state: "frozen", ySplit: requestsLayout.headerRow }] });
  styleTitle(requests, "CUTI, TRAINING DAN PERMINTAAN", "Satu baris per orang per rentang tanggal. Baris di luar bulan yang dibuat diabaikan otomatis, jadi baris lama boleh dibiarkan.");
  [6, 18, 15, 15, 18, 48].forEach((width, index) => (requests.getColumn(index + 1).width = width));
  const example = requests.getRow(3);
  example.values = ["Contoh:", "Addin", utcDate("2026-11-16"), utcDate("2026-11-18"), "Cuti", "Cuti tahunan (baris contoh ini tidak dibaca)"];
  example.eachCell((cell) => {
    cell.font = { name: FONT, italic: true, color: { argb: COLORS.example } };
    if (cell.value instanceof Date) cell.numFmt = "dd/mm/yyyy";
  });
  requests.getRow(requestsLayout.headerRow).values = ["No", "Nama", "Dari Tanggal", "Sampai Tanggal", "Jenis", "Keterangan"];
  styleHeader(requests.getRow(requestsLayout.headerRow));
  const memberList = `Anggota!$B$${membersLayout.firstRow}:$B$${membersLayout.firstRow + membersLayout.rows - 1}`;
  const kinds = `"${REQUEST_KINDS.map(([label]) => label).join(",")}"`;
  for (let offset = 0; offset < requestsLayout.rows; offset += 1) {
    const row = requests.getRow(requestsLayout.firstRow + offset);
    row.getCell(1).value = offset + 1;
    styleCell(row.getCell(1), "auto", { alignment: { horizontal: "center" } });
    styleCell(row.getCell(2), "input");
    for (const column of [3, 4]) styleCell(row.getCell(column), "input", { numFmt: "dd/mm/yyyy", alignment: { horizontal: "center" } });
    styleCell(row.getCell(5), "input");
    styleCell(row.getCell(6), "input");
    row.getCell(2).dataValidation = { type: "list", allowBlank: true, showErrorMessage: true, error: "Pilih nama dari daftar (sheet Anggota).", formulae: [memberList] };
    for (const column of [3, 4]) {
      row.getCell(column).dataValidation = { type: "date", operator: "greaterThan", allowBlank: true, showErrorMessage: true, errorTitle: "Tanggal", error: "Isi tanggal, contoh 16/11/2026.", formulae: [new Date(Date.UTC(2020, 0, 1))] };
    }
    row.getCell(5).dataValidation = { type: "list", allowBlank: true, showErrorMessage: true, error: "Pilih jenis dari daftar.", formulae: [kinds] };
  }

  // Cadangan Luar Tim
  const outsideLayout = INPUT_LAYOUT.externalBackups;
  const outside = workbook.addWorksheet(outsideLayout.sheet, { views: [{ state: "frozen", ySplit: outsideLayout.headerRow }] });
  styleTitle(outside, "CADANGAN DARI LUAR TIM", "Orang yang bisa dihubungi bila tidak ada cadangan dalam tim (misalnya anggota NOC atau Team Lead). Tidak dijadwalkan di roster.");
  [5, 18, 22, 10, 10, 10, 34].forEach((width, index) => (outside.getColumn(index + 1).width = width));
  outside.getRow(outsideLayout.headerRow).values = ["No", "Nama", "Asal tim / jabatan", "Boleh Shift 1", "Boleh Shift 2", "Boleh Shift 3", "Kontak / catatan"];
  styleHeader(outside.getRow(outsideLayout.headerRow));
  for (let offset = 0; offset < outsideLayout.rows; offset += 1) {
    const row = outside.getRow(outsideLayout.firstRow + offset);
    row.getCell(1).value = offset + 1;
    styleCell(row.getCell(1), "auto", { alignment: { horizontal: "center" } });
    for (const column of [2, 3, 7]) styleCell(row.getCell(column), "input");
    for (const column of [4, 5, 6]) {
      styleCell(row.getCell(column), "input", { alignment: { horizontal: "center" } });
      row.getCell(column).dataValidation = { type: "list", allowBlank: true, formulae: ['"Ya,Tidak"'] };
    }
  }

  // Kebutuhan Shift
  const need = workbook.addWorksheet(INPUT_LAYOUT.coverage.sheet);
  styleTitle(need, "KEBUTUHAN ORANG PER SHIFT", "Shift 3 selalu tepat 1 orang (sistem giliran malam). Minimal wajib terpenuhi; ideal diusahakan bila orangnya cukup.");
  [46, 16, 16, 16].forEach((width, index) => (need.getColumn(index + 1).width = width));
  need.getRow(4).values = ["Hari", "Shift 1 (Pagi)", "Shift 2 (Siang)", "Shift 3 (Malam)"];
  styleHeader(need.getRow(4));
  const coverageRows = [
    ["Senin–Jumat: minimal", coverage.weekday.minimum],
    ["Senin–Jumat: ideal", coverage.weekday.preferred],
    ["Sabtu, Minggu & tanggal merah: jumlah pasti", coverage.special.preferred]
  ];
  coverageRows.forEach(([label, values], index) => {
    const row = need.getRow(5 + index);
    row.getCell(1).value = label;
    styleCell(row.getCell(1), null, { font: { bold: true } });
    ["1", "2", "3"].forEach((shiftId, column) => {
      const cell = row.getCell(2 + column);
      cell.value = values[shiftId];
      styleCell(cell, shiftId === "3" ? "auto" : "input", { alignment: { horizontal: "center" } });
      if (shiftId !== "3") cell.dataValidation = { type: "whole", operator: "between", allowBlank: false, showErrorMessage: true, error: "Isi angka 0 sampai 6.", formulae: [0, 6] };
    });
  });
  need.getCell("A9").value = "Cuti bersama diperlakukan seperti tanggal merah?";
  styleCell(need.getCell("A9"), null, { font: { bold: true } });
  need.getCell("B9").value = coverage.collectiveLeaveIsSpecial === false ? "Tidak" : "Ya";
  styleCell(need.getCell("B9"), "input", { alignment: { horizontal: "center" } });
  need.getCell("B9").dataValidation = { type: "list", allowBlank: false, formulae: ['"Ya,Tidak"'] };
  need.getCell("A10").value = "Ya = pada hari cuti bersama cukup 1 orang per shift, sama seperti Sabtu/Minggu.";
  need.getCell("A10").font = { name: FONT, italic: true, size: 10, color: { argb: COLORS.note } };

  // Aturan
  const rulesSheet = workbook.addWorksheet(INPUT_LAYOUT.rules.sheet);
  styleTitle(rulesSheet, "ATURAN ROSTER", "Ubah hanya bila kebijakan tim berubah. Nilai di luar batas akan ditolak dengan pesan yang jelas.");
  [58, 16, 26, 80].forEach((width, index) => (rulesSheet.getColumn(index + 1).width = width));
  rulesSheet.getRow(4).values = ["Aturan", "Nilai", "Batas yang diizinkan", "Penjelasan"];
  styleHeader(rulesSheet.getRow(4));
  const shiftText = (id) => {
    const shift = shifts.find((item) => item.id === id);
    return `${shift.start}-${shift.end}`;
  };
  const values = ruleValues(rules, shifts);
  RULE_ROWS.forEach((rule, index) => writeRuleRow(rulesSheet.getRow(5 + index), rule, values[rule.key]));

  await workbook.xlsx.writeFile(file);
  return file;
}

// The value each Aturan row shows for the given rules and shift times.
function ruleValues(rules, shifts) {
  const shiftText = (id) => {
    const shift = shifts.find((item) => item.id === id);
    return `${shift.start}-${shift.end}`;
  };
  return {
    maxConsecutiveWorkDays: rules.maxConsecutiveWorkDays,
    nightPreferred: rules.nightBlock.preferred,
    nightMax: rules.nightBlock.max,
    nightRecoveryOffDays: rules.nightRecoveryOffDays,
    minimumRestHours: rules.minimumRestHours,
    maxConsecutiveOffDays: rules.maxConsecutiveOffDays,
    workDaysTarget: rules.workDaysTarget === "auto" ? "Otomatis" : rules.workDaysTarget,
    workDaysTargetHoursCap: rules.workDaysTargetHoursCap ? "Ya" : "Tidak",
    balanceDayOnlyShifts: rules.balanceDayOnlyShifts ? "Ya" : "Tidak",
    fridayShift1Female: rules.fridayShift1Female === false ? "Tidak" : "Ya",
    leaveCountsAsWork: rules.leaveCountsAsWork === false ? "Tidak" : "Ya",
    longNightBlockOnlyIfNeeded: rules.longNightBlockOnlyIfNeeded === false ? "Tidak" : "Ya",
    breakHours: rules.breakHours ?? 1,
    weeklyHoursLimit: rules.weeklyHoursLimit ?? 40,
    dailyHoursLimit: rules.dailyHoursLimit ?? 8,
    overtimeHours: rules.overtimeHours ?? 4,
    nightFreeDaysAfterSick: rules.nightFreeDaysAfterSick ?? 5,
    nightFreeDaysAfterShortSick: rules.nightFreeDaysAfterShortSick ?? rules.nightFreeDaysAfterSick ?? 5,
    shift1: shiftText("1"),
    shift2: shiftText("2"),
    shift3: shiftText("3")
  };
}

function writeRuleRow(row, rule, value) {
  row.getCell(1).value = rule.label;
  row.getCell(2).value = value;
  row.getCell(3).value = rule.kind === "yesno" ? "Ya / Tidak" : rule.kind === "time" ? "jam:menit-jam:menit" : rule.kind === "auto" ? `Otomatis, atau ${rule.min}–${rule.max}` : `${rule.min}–${rule.max}`;
  row.getCell(4).value = rule.explain;
  styleCell(row.getCell(1), null, { font: { bold: true } });
  styleCell(row.getCell(2), "input", { alignment: { horizontal: "center" } });
  styleCell(row.getCell(3), null, { alignment: { horizontal: "center" } });
  styleCell(row.getCell(4), null, { alignment: { wrapText: true } });
  // Excel refuses a wrong value as it is typed: a Ya/Tidak dropdown, or a whole number in range.
  const input = row.getCell(2);
  removeValidation(input);
  if (rule.kind === "yesno") {
    input.dataValidation = { type: "list", allowBlank: false, showErrorMessage: true, error: "Pilih Ya atau Tidak.", showInputMessage: true, prompt: "Pilih Ya atau Tidak dari daftar.", formulae: ['"Ya,Tidak"'] };
  } else if (!rule.kind) {
    input.dataValidation = { type: "whole", operator: "between", allowBlank: false, showErrorMessage: true, error: `Isi angka ${rule.min} sampai ${rule.max}.`, showInputMessage: true, prompt: `Isi angka ${rule.min} sampai ${rule.max}.`, formulae: [rule.min, rule.max] };
  }
}

function clearRuleRow(row) {
  for (let column = 1; column <= 4; column += 1) {
    const cell = row.getCell(column);
    cell.value = null;
    cell.style = {};
  }
  removeValidation(row.getCell(2));
}

// ExcelJS's own remove() leaves an empty <dataValidation> element in the file;
// deleting the entry writes nothing at all.
function removeValidation(cell) {
  delete cell.worksheet.dataValidations.model[cell.address];
}

// Data Roster.xlsx files made by an older version lack the Aturan rows added
// since (they still work, with the default values). This adds those rows next
// to the rows they belong with, holding the default, so the admin can see and
// change them, and gives renamed rows their current name. Values the admin typed
// are kept; the file is written only when something is missing, and put back as
// it was if the result does not read back cleanly.
// What an upgrade added besides Aturan rows (shown to the admin after the labels).
export const KINDS_UPGRADE = "pilihan Jenis baru di sheet Cuti & Permintaan";

export async function upgradeInputWorkbook(file) {
  const original = await readFile(file);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(original);
  const sheet = workbook.getWorksheet(INPUT_LAYOUT.rules.sheet);
  // Aturan values by rule (also under an older name), and rows the program does not know.
  const found = new Map();
  const unknown = [];
  let last = 4;
  let renamed = false;
  sheet?.eachRow((row, rowNumber) => {
    const label = cellText(row.getCell(1));
    if (rowNumber <= 4 || !label) return;
    last = Math.max(last, rowNumber);
    const rule = RULE_ROWS.find((item) => item.label === label) ?? RULE_ROWS.find((item) => item.aliases?.includes(label));
    if (!rule) unknown.push([1, 2, 3, 4].map((column) => row.getCell(column).value));
    else {
      renamed ||= rule.label !== label;
      found.set(rule.key, row.getCell(2).value);
    }
  });
  const missing = sheet ? RULE_ROWS.filter((rule) => rule.optional && !found.has(rule.key)) : [];
  // Request kinds added after the workbook was made: its "Jenis" dropdown would
  // refuse them (for example "Hindari Shift 3").
  const kindList = `"${REQUEST_KINDS.map(([label]) => label).join(",")}"`;
  const requests = workbook.getWorksheet(INPUT_LAYOUT.requests.sheet);
  const header = requests ? findHeaderRow(requests, "no", "nama") : null;
  const staleCells = [];
  if (header) {
    for (let rowNumber = header + 1; rowNumber <= Math.max(requests.rowCount, header + INPUT_LAYOUT.requests.rows); rowNumber += 1) {
      const cell = requests.getRow(rowNumber).getCell(5);
      const formula = cell.dataValidation?.type === "list" ? String(cell.dataValidation.formulae?.[0] ?? "") : "";
      if (formula.includes("Cuti") && formula !== kindList) staleCells.push(cell);
    }
  }
  if (missing.length === 0 && !renamed && staleCells.length === 0) return [];
  try {
    await readInputWorkbook(file);
  } catch {
    return []; // the admin has something to fix first; reading the workbook will say what
  }
  if (missing.length > 0 || renamed) {
    // The Aturan table is written again in the standard order, so a new row sits
    // next to the row it belongs with. Every value the admin typed is kept.
    const values = ruleValues(DEFAULT_RULES, DEFAULT_SHIFTS);
    // A short sickness starts with the same period as a long one: no change until the admin chooses.
    if (found.has("nightFreeDaysAfterSick")) values.nightFreeDaysAfterShortSick = found.get("nightFreeDaysAfterSick");
    const rows = RULE_ROWS.filter((rule) => found.has(rule.key) || missing.includes(rule));
    for (let rowNumber = 5; rowNumber <= last; rowNumber += 1) clearRuleRow(sheet.getRow(rowNumber));
    rows.forEach((rule, index) => writeRuleRow(sheet.getRow(5 + index), rule, found.has(rule.key) ? found.get(rule.key) : values[rule.key]));
    unknown.forEach((cells, index) => cells.forEach((value, column) => (sheet.getRow(5 + rows.length + index).getCell(column + 1).value = value)));
  }
  const known = new Set(staleCells.flatMap((cell) => String(cell.dataValidation.formulae[0]).replace(/"/g, "").split(",")));
  const newKinds = REQUEST_KINDS.map(([label]) => label).filter((label) => !known.has(label));
  for (const cell of staleCells) cell.dataValidation = { ...cell.dataValidation, formulae: [kindList] };
  await workbook.xlsx.writeFile(file);
  try {
    await readInputWorkbook(file);
  } catch {
    await writeFile(file, original);
    return [];
  }
  return [...missing.map((rule) => rule.label), ...(staleCells.length ? [`${KINDS_UPGRADE}: ${newKinds.join(", ")}`] : [])];
}

// ---------- append (used by the CLI "cuti" command and by Claude) ----------

// Adds one row to "Cuti & Permintaan", validates the whole workbook, and puts
// the original file back untouched if the new row is invalid.
export async function appendRequest(file, { name, from, to, kind = "Cuti", note = "" }) {
  const original = await readFile(file);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(file);
  const sheet = workbook.getWorksheet(INPUT_LAYOUT.requests.sheet);
  const members = workbook.getWorksheet(INPUT_LAYOUT.members.sheet);
  if (!sheet || !members) throw new RosterError('Data Roster.xlsx tidak punya sheet "Cuti & Permintaan" atau "Anggota".');
  const header = findHeaderRow(sheet, "no", "nama");
  let rowNumber = header + 1;
  while ([2, 3, 4, 5].some((column) => cellText(sheet.getRow(rowNumber).getCell(column)) !== "")) rowNumber += 1;
  let canonical = String(name).trim();
  members.eachRow((row) => {
    const candidate = cellText(row.getCell(2));
    if (candidate && (candidate.toLowerCase() === canonical.toLowerCase() || slugify(candidate) === slugify(canonical))) canonical = candidate;
  });
  const kindByCode = new Map(REQUEST_KINDS.map(([label, code]) => [code.toLowerCase(), label]));
  const kindLabel = REQUEST_KINDS.find(([label]) => label.toLowerCase() === String(kind).trim().toLowerCase())?.[0] ?? kindByCode.get(String(kind).trim().toLowerCase()) ?? String(kind);
  const row = sheet.getRow(rowNumber);
  row.getCell(2).value = canonical;
  row.getCell(3).value = utcDate(from);
  row.getCell(4).value = utcDate(to ?? from);
  row.getCell(5).value = kindLabel;
  row.getCell(6).value = note || null;
  for (const column of [3, 4]) row.getCell(column).numFmt = "dd/mm/yyyy";
  await workbook.xlsx.writeFile(file);
  try {
    await readInputWorkbook(file);
  } catch (error) {
    await writeFile(file, original);
    throw error;
  }
  return { row: rowNumber, name: canonical, kind: kindLabel };
}

// Adds a member to the "Anggota" sheet, e.g. someone from outside the team for
// the dates the team cannot cover (the console offers this when a month cannot
// be made). Validates the whole workbook and puts the original file back if the
// new row is invalid.
export async function appendMember(file, { name, gender = "L", shifts = ["1", "2", "3"], from = null, to = null }) {
  const original = await readFile(file);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(original);
  const sheet = workbook.getWorksheet(INPUT_LAYOUT.members.sheet);
  if (!sheet) throw new RosterError('Data Roster.xlsx tidak punya sheet "Anggota".');
  const header = findHeaderRow(sheet, "no", "nama");
  let rowNumber = header + 1;
  while ([2, 3].some((column) => cellText(sheet.getRow(rowNumber).getCell(column)) !== "")) rowNumber += 1;
  const row = sheet.getRow(rowNumber);
  if (cellText(row.getCell(1)) === "") row.getCell(1).value = rowNumber - header;
  row.getCell(2).value = String(name).trim();
  row.getCell(4).value = gender;
  ["1", "2", "3"].forEach((shiftId, index) => (row.getCell(5 + index).value = shifts.includes(shiftId) ? "Ya" : "Tidak"));
  for (const [column, date] of [[8, from], [9, to]]) {
    if (!date) continue;
    row.getCell(column).value = utcDate(date);
    row.getCell(column).numFmt = "dd/mm/yyyy";
  }
  await workbook.xlsx.writeFile(file);
  try {
    await readInputWorkbook(file);
  } catch (error) {
    await writeFile(file, original);
    throw error;
  }
  return { row: rowNumber, name: String(name).trim() };
}

// ---------- read ----------

function findHeaderRow(sheet, firstHeader, secondHeader, limit = 12) {
  for (let rowNumber = 1; rowNumber <= limit; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    if (cellText(row.getCell(1)).toLowerCase() === firstHeader && cellText(row.getCell(2)).toLowerCase() === secondHeader) return rowNumber;
  }
  return null;
}

export async function readInputWorkbook(file) {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.readFile(file);
  } catch (error) {
    if (error.code === "ENOENT") throw new RosterError(`File "Data Roster.xlsx" tidak ditemukan (${file}).`);
    throw new RosterError(`File "Data Roster.xlsx" tidak bisa dibuka. Pastikan file tidak rusak dan sudah ditutup di Excel. (${error.message})`);
  }
  const problems = [];
  const sheetOf = (name) => {
    const sheet = workbook.getWorksheet(name);
    if (!sheet) problems.push(`Sheet "${name}" tidak ada. Jangan ganti nama sheet.`);
    return sheet;
  };

  // Anggota
  const members = [];
  const membersSheet = sheetOf(INPUT_LAYOUT.members.sheet);
  if (membersSheet) {
    const header = findHeaderRow(membersSheet, "no", "nama");
    if (!header) problems.push('Sheet "Anggota": judul kolom "No" dan "Nama" tidak ditemukan.');
    else {
      const seen = new Map();
      for (let rowNumber = header + 1; rowNumber <= Math.max(membersSheet.rowCount, header + 1); rowNumber += 1) {
        const row = membersSheet.getRow(rowNumber);
        const where = `Sheet "Anggota" baris ${rowNumber}`;
        const name = cellText(row.getCell(2));
        const filled = [3, 4, 5, 6, 7, 8, 9].some((column) => cellText(row.getCell(column)) !== "" && !(column >= 5 && column <= 7 && cellText(row.getCell(column)).toLowerCase() === "tidak"));
        if (!name) {
          if (filled && [8, 9].some((column) => cellText(row.getCell(column)) !== "")) problems.push(`${where}: nama kosong, padahal baris ini berisi data.`);
          continue;
        }
        const id = slugify(cellText(row.getCell(3)) || name);
        if (!id) {
          problems.push(`${where}: nama "${name}" tidak bisa dipakai sebagai ID.`);
          continue;
        }
        if (seen.has(id)) problems.push(`${where}: ${name} sama dengan baris ${seen.get(id)} (nama/ID ganda).`);
        seen.set(id, rowNumber);
        const gender = cellText(row.getCell(4)).toUpperCase();
        if (gender && !["L", "P"].includes(gender)) problems.push(`${where}: jenis kelamin "${gender}" harus L atau P.`);
        const eligibleShifts = [];
        ["1", "2", "3"].forEach((shiftId, index) => {
          const answer = yesNo(cellText(row.getCell(5 + index)));
          if (answer === undefined) problems.push(`${where}: kolom "Boleh Shift ${shiftId}" harus Ya atau Tidak.`);
          if (answer) eligibleShifts.push(shiftId);
        });
        if (eligibleShifts.length === 0) problems.push(`${where}: ${name} tidak boleh shift apa pun. Isi "Ya" minimal di satu kolom Boleh Shift.`);
        const activeFrom = cellDate(row.getCell(8));
        const activeUntil = cellDate(row.getCell(9));
        if (activeFrom === undefined) problems.push(`${where}: "Mulai Bergabung" bukan tanggal (contoh 01/11/2026).`);
        if (activeUntil === undefined) problems.push(`${where}: "Terakhir Bekerja" bukan tanggal (contoh 30/11/2026).`);
        if (activeFrom && activeUntil && activeUntil < activeFrom) problems.push(`${where}: "Terakhir Bekerja" sebelum "Mulai Bergabung".`);
        members.push({ id, name, gender, eligibleShifts, activeFrom: activeFrom || null, activeUntil: activeUntil || null, note: cellText(row.getCell(10)), row: rowNumber });
      }
      if (members.length === 0) problems.push('Sheet "Anggota" belum berisi nama.');
    }
  }

  // Cuti & Permintaan
  const requests = [];
  const requestsSheet = sheetOf(INPUT_LAYOUT.requests.sheet);
  if (requestsSheet) {
    const header = findHeaderRow(requestsSheet, "no", "nama");
    if (!header) problems.push('Sheet "Cuti & Permintaan": judul kolom "No" dan "Nama" tidak ditemukan.');
    else {
      const byName = new Map(members.map((member) => [member.name.toLowerCase(), member]));
      const byId = new Map(members.map((member) => [member.id, member]));
      const kinds = new Map(REQUEST_KINDS.map(([label, code]) => [label.toLowerCase(), code]));
      for (let rowNumber = header + 1; rowNumber <= requestsSheet.rowCount; rowNumber += 1) {
        const row = requestsSheet.getRow(rowNumber);
        const where = `Sheet "Cuti & Permintaan" baris ${rowNumber}`;
        const name = cellText(row.getCell(2));
        const rawFrom = row.getCell(3).value;
        const kindText = cellText(row.getCell(5));
        if (!name && !cellText(row.getCell(3)) && !cellText(row.getCell(4)) && !kindText) continue;
        const member = byName.get(name.toLowerCase()) ?? byId.get(slugify(name));
        if (!name) {
          problems.push(`${where}: nama kosong.`);
          continue;
        }
        if (!member) {
          problems.push(`${where}: nama "${name}" tidak ada di sheet Anggota.`);
          continue;
        }
        const from = cellDate(row.getCell(3));
        let to = cellDate(row.getCell(4));
        if (rawFrom === null || rawFrom === undefined || from === null) {
          problems.push(`${where}: tanggal mulai kosong.`);
          continue;
        }
        if (from === undefined || to === undefined) {
          problems.push(`${where}: tanggal tidak dikenali (contoh 16/11/2026).`);
          continue;
        }
        if (to === null) to = from;
        if (to < from) {
          problems.push(`${where}: tanggal selesai (${formatTanggal(to)}) sebelum tanggal mulai (${formatTanggal(from)}).`);
          continue;
        }
        const code = kinds.get(kindText.toLowerCase());
        if (!code) {
          problems.push(`${where}: jenis "${kindText}" tidak dikenal. Pilih: ${REQUEST_KINDS.map(([label]) => label).join(", ")}.`);
          continue;
        }
        if (["1", "2", "3"].includes(code) && !member.eligibleShifts.includes(code)) {
          problems.push(`${where}: ${member.name} tidak boleh ${KODE_LABEL[code]}.`);
          continue;
        }
        const avoid = (value) => value.startsWith("!");
        const clash = requests.find((other) => other.memberId === member.id && other.code !== code && !(avoid(other.code) && avoid(code)) && other.from <= to && from <= other.to);
        if (clash) {
          const day = from > clash.from ? from : clash.from;
          problems.push(`${where}: bentrok dengan baris ${clash.row} (${member.name} ${formatTanggal(day, { pendek: true })}: ${clash.kind} dan ${REQUEST_KINDS.find(([, value]) => value === code)[0]}).`);
          continue;
        }
        requests.push({ memberId: member.id, name: member.name, from, to, code, kind: REQUEST_KINDS.find(([, value]) => value === code)[0], note: cellText(row.getCell(6)), source: where, row: rowNumber });
      }
    }
  }

  // Cadangan Luar Tim (optional sheet; older workbooks do not have it)
  const externalBackups = [];
  const outsideSheet = workbook.getWorksheet(INPUT_LAYOUT.externalBackups.sheet);
  if (outsideSheet) {
    const header = findHeaderRow(outsideSheet, "no", "nama");
    for (let rowNumber = (header ?? INPUT_LAYOUT.externalBackups.headerRow) + 1; rowNumber <= outsideSheet.rowCount; rowNumber += 1) {
      const row = outsideSheet.getRow(rowNumber);
      const name = cellText(row.getCell(2));
      const shifts = ["1", "2", "3"].filter((shiftId, index) => yesNo(cellText(row.getCell(4 + index))) === true);
      const anything = [3, 4, 5, 6, 7].some((column) => cellText(row.getCell(column)) !== "" && cellText(row.getCell(column)).toLowerCase() !== "tidak");
      if (!name) {
        if (anything) problems.push(`Sheet "Cadangan Luar Tim" baris ${rowNumber}: nama kosong, padahal baris ini berisi data.`);
        continue;
      }
      if (shifts.length === 0) problems.push(`Sheet "Cadangan Luar Tim" baris ${rowNumber}: ${name} belum diisi boleh shift apa (isi "Ya" minimal di satu kolom).`);
      externalBackups.push({ name, origin: cellText(row.getCell(3)), eligibleShifts: shifts, contact: cellText(row.getCell(7)) });
    }
  }

  // Kebutuhan Shift
  const coverage = structuredClone(DEFAULT_COVERAGE);
  const needSheet = sheetOf(INPUT_LAYOUT.coverage.sheet);
  if (needSheet) {
    const rows = new Map();
    needSheet.eachRow((row, rowNumber) => rows.set(cellText(row.getCell(1)).toLowerCase(), { row, rowNumber }));
    const readCounts = (prefix, target) => {
      const found = [...rows.entries()].find(([label]) => label.startsWith(prefix));
      if (!found) {
        problems.push(`Sheet "Kebutuhan Shift": baris "${prefix}" tidak ditemukan.`);
        return;
      }
      const { row, rowNumber } = found[1];
      ["1", "2", "3"].forEach((shiftId, index) => {
        const value = Number(cellText(row.getCell(2 + index)));
        if (!Number.isInteger(value) || value < 0 || value > 6) problems.push(`Sheet "Kebutuhan Shift" baris ${rowNumber}: jumlah Shift ${shiftId} harus angka 0 sampai 6.`);
        else target[shiftId] = value;
      });
    };
    readCounts("senin–jumat: minimal", coverage.weekday.minimum);
    readCounts("senin–jumat: ideal", coverage.weekday.preferred);
    const special = {};
    readCounts("sabtu, minggu", special);
    coverage.special = { minimum: { ...special }, preferred: { ...special } };
    for (const shiftId of ["1", "2"]) {
      if (coverage.weekday.preferred[shiftId] < coverage.weekday.minimum[shiftId]) problems.push(`Sheet "Kebutuhan Shift": ideal Shift ${shiftId} lebih kecil dari minimal.`);
      if (coverage.weekday.minimum[shiftId] < 1 || special[shiftId] < 1) problems.push(`Sheet "Kebutuhan Shift": Shift ${shiftId} minimal harus 1 orang.`);
    }
    const collective = [...rows.entries()].find(([label]) => label.startsWith("cuti bersama"));
    if (collective) {
      const answer = yesNo(cellText(collective[1].row.getCell(2)));
      if (answer === undefined) problems.push(`Sheet "Kebutuhan Shift" baris ${collective[1].rowNumber}: isi Ya atau Tidak.`);
      else coverage.collectiveLeaveIsSpecial = answer;
    }
  }

  // Aturan
  const rules = structuredClone(DEFAULT_RULES);
  const shiftTimes = Object.fromEntries(DEFAULT_SHIFTS.map((shift) => [shift.id, { start: shift.start, end: shift.end }]));
  const rulesSheet = sheetOf(INPUT_LAYOUT.rules.sheet);
  if (rulesSheet) {
    const byLabel = new Map();
    rulesSheet.eachRow((row, rowNumber) => byLabel.set(cellText(row.getCell(1)), { row, rowNumber }));
    const parsed = {};
    for (const rule of RULE_ROWS) {
      // A row renamed in a later version is still found under its older name.
      const found = byLabel.get(rule.label) ?? (rule.aliases ?? []).map((label) => byLabel.get(label)).find(Boolean);
      if (!found) {
        // Rows added in later versions are optional so older workbooks keep working.
        if (!rule.optional) problems.push(`Sheet "Aturan": baris "${rule.label}" tidak ditemukan.`);
        continue;
      }
      const where = `Sheet "Aturan" baris ${found.rowNumber} (${rule.label})`;
      const text = cellText(found.row.getCell(2));
      if (rule.kind === "yesno") {
        const answer = yesNo(text);
        if (answer === undefined) problems.push(`${where}: isi Ya atau Tidak.`);
        else parsed[rule.key] = answer;
      } else if (rule.kind === "time") {
        const match = /^(\d{1,2})[:.](\d{2})\s*[-–]\s*(\d{1,2})[:.](\d{2})$/.exec(text);
        if (!match) problems.push(`${where}: format jam harus seperti 07:00-16:00.`);
        else parsed[rule.key] = { start: `${match[1].padStart(2, "0")}:${match[2]}`, end: `${match[3].padStart(2, "0")}:${match[4]}` };
      } else if (rule.kind === "auto" && ["otomatis", "auto", ""].includes(text.toLowerCase())) {
        parsed[rule.key] = "auto";
      } else {
        const value = Number(text);
        if (!Number.isInteger(value) || value < rule.min || value > rule.max) problems.push(`${where}: harus angka antara ${rule.min} dan ${rule.max} (sekarang "${text}").`);
        else parsed[rule.key] = value;
      }
    }
    for (const key of ["maxConsecutiveWorkDays", "nightRecoveryOffDays", "minimumRestHours", "maxConsecutiveOffDays", "workDaysTarget", "balanceDayOnlyShifts", "fridayShift1Female", "leaveCountsAsWork", "longNightBlockOnlyIfNeeded", "breakHours", "weeklyHoursLimit", "overtimeHours", "nightFreeDaysAfterSick", "workDaysTargetHoursCap", "nightFreeDaysAfterShortSick", "dailyHoursLimit"]) {
      if (parsed[key] !== undefined) rules[key] = parsed[key];
    }
    if ((rules.nightFreeDaysAfterShortSick ?? 0) > (rules.nightFreeDaysAfterSick ?? 0)) {
      const label = (key) => RULE_ROWS.find((rule) => rule.key === key).label;
      problems.push(`Sheet "Aturan": "${label("nightFreeDaysAfterShortSick")}" (${rules.nightFreeDaysAfterShortSick}) tidak boleh lebih besar dari "${label("nightFreeDaysAfterSick")}" (${rules.nightFreeDaysAfterSick}).`);
    }
    if (parsed.nightPreferred !== undefined) rules.nightBlock.preferred = parsed.nightPreferred;
    if (parsed.nightMax !== undefined) rules.nightBlock.max = parsed.nightMax;
    rules.nightBlock.min = Math.min(2, rules.nightBlock.preferred);
    if (rules.nightBlock.max < rules.nightBlock.preferred) problems.push('Sheet "Aturan": "Blok Shift 3 maksimal" tidak boleh lebih kecil dari blok normal.');
    for (const shiftId of ["1", "2", "3"]) if (parsed[`shift${shiftId}`]) shiftTimes[shiftId] = parsed[`shift${shiftId}`];
  }

  if (problems.length > 0) {
    const shown = problems.slice(0, 12);
    const more = problems.length > shown.length ? `\n- ...dan ${problems.length - shown.length} masalah lain.` : "";
    throw new RosterError(`Ada ${problems.length} masalah di Data Roster.xlsx:\n- ${shown.join("\n- ")}${more}`, { problems });
  }
  return { members, requests, coverage, rules, shiftTimes, externalBackups, warnings: [] };
}
