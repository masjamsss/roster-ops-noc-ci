// Public holidays per year, in this order:
// 1. pengaturan/hari-libur/ID-YYYY.json with status "official-verified" (reviewed SKB list; never overwritten)
// 2. the same file with status "auto-google", refreshed when older than 30 days
// 3. no file: download Google Calendar's Indonesian holiday feed and save it as "auto-google"
// 4. no file and no internet: stop with instructions.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { RosterError } from "./errors.mjs";
import { fetchGoogleIcs, GOOGLE_HOLIDAY_ICS, parseGoogleIcs } from "./holiday-google.mjs";
import { formatTanggal } from "./labels-id.mjs";

const TYPES = new Set(["national", "collective_leave"]);
const TYPE_LABEL = { national: "libur nasional", collective_leave: "cuti bersama" };

function fileFor(directory, year) {
  return path.join(directory, `ID-${year}.json`);
}

function displayPath(year) {
  return `pengaturan/hari-libur/ID-${year}.json`;
}

async function readCalendar(directory, year) {
  let raw;
  try {
    raw = await readFile(fileFor(directory, year), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  let calendar;
  try {
    calendar = JSON.parse(raw);
  } catch {
    throw new RosterError(`File ${displayPath(year)} rusak (bukan JSON yang valid). Perbaiki atau hapus file itu agar diambil ulang otomatis.`);
  }
  if (calendar.year !== year || !Array.isArray(calendar.days)) {
    throw new RosterError(`File ${displayPath(year)} tidak sesuai format (tahun atau daftar "days" tidak cocok).`);
  }
  for (const day of calendar.days) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day.date) || !day.date.startsWith(`${year}-`) || !TYPES.has(day.type)) {
      throw new RosterError(`File ${displayPath(year)}: baris hari libur tidak valid (${JSON.stringify(day)}). Jenis harus "national" atau "collective_leave".`);
    }
  }
  return calendar;
}

async function saveCalendar(directory, calendar) {
  await mkdir(directory, { recursive: true });
  await writeFile(fileFor(directory, calendar.year), `${JSON.stringify(calendar, null, 2)}\n`, "utf8");
}

function autoCalendar(year, days, now) {
  return {
    schemaVersion: 1,
    country: "ID",
    year,
    timezone: "Asia/Jakarta",
    status: "auto-google",
    fetchedAt: now.toISOString(),
    source: { title: "Google Calendar — Hari libur di Indonesia", url: GOOGLE_HOLIDAY_ICS, authoritative: false },
    note: "Diambil otomatis. Belum diverifikasi dengan SKB 3 Menteri. Ubah status menjadi \"official-verified\" setelah dicek.",
    days
  };
}

export function compareHolidayDays(officialDays, googleDays, from, to) {
  const inRange = (day) => day.date >= from && day.date <= to;
  const official = new Map(officialDays.filter(inRange).map((day) => [day.date, day]));
  const google = new Map(googleDays.filter(inRange).map((day) => [day.date, day]));
  const differences = [];
  for (const date of [...new Set([...official.keys(), ...google.keys()])].sort()) {
    const mine = official.get(date);
    const theirs = google.get(date);
    if (mine && theirs && mine.type === theirs.type) continue;
    const tanggal = formatTanggal(date);
    let message;
    if (!theirs) message = `${tanggal}: daftar resmi mencatat ${TYPE_LABEL[mine.type]} (${mine.name}), tetapi Google Calendar tidak.`;
    else if (!mine) message = `${tanggal}: Google Calendar mencatat ${TYPE_LABEL[theirs.type]} (${theirs.name}), tetapi daftar resmi tidak.`;
    else message = `${tanggal}: daftar resmi mencatat ${TYPE_LABEL[mine.type]} (${mine.name}), Google Calendar mencatat ${TYPE_LABEL[theirs.type]} (${theirs.name}).`;
    differences.push({ date, message });
  }
  return differences;
}

export async function resolveHolidays({ years, directory, online = true, fetchImpl, now = new Date(), refreshDays = 30, compareFrom = null, compareTo = null }) {
  let icsText = null;
  let fetchError = null;
  const googleText = async () => {
    if (icsText !== null || fetchError !== null) return icsText;
    if (!online) {
      fetchError = new Error("mode offline");
      return null;
    }
    try {
      icsText = await fetchGoogleIcs({ fetchImpl });
    } catch (error) {
      fetchError = error;
    }
    return icsText;
  };

  const calendars = [];
  const notes = [];
  const differences = [];
  for (const year of [...new Set(years)].sort()) {
    let calendar = await readCalendar(directory, year);
    if (!calendar) {
      const text = await googleText();
      if (text === null) {
        throw new RosterError(
          `Data hari libur tahun ${year} belum ada dan tidak bisa diambil dari internet (${fetchError.message}). ` +
            `Sambungkan internet lalu coba lagi, atau buat file ${displayPath(year)} secara manual (contoh: ID-2026.json).`
        );
      }
      const days = parseGoogleIcs(text, year);
      if (days.length === 0) {
        throw new RosterError(
          `Google Calendar belum memuat hari libur tahun ${year} (SKB 3 Menteri biasanya terbit sekitar September tahun sebelumnya). ` +
            `Buat file ${displayPath(year)} secara manual (contoh: ID-2026.json).`
        );
      }
      calendar = autoCalendar(year, days, now);
      await saveCalendar(directory, calendar);
      notes.push(`Hari libur ${year} diambil otomatis dari Google Calendar (belum diverifikasi dengan SKB 3 Menteri). Cek sheet "Hari Libur".`);
    } else if (calendar.status === "auto-google") {
      const ageDays = (now.getTime() - new Date(calendar.fetchedAt ?? 0).getTime()) / 86_400_000;
      if (ageDays > refreshDays) {
        const text = await googleText();
        if (text === null) {
          notes.push(`Data hari libur ${year} tidak bisa diperbarui (tidak ada internet); memakai data tersimpan tanggal ${String(calendar.fetchedAt).slice(0, 10)}.`);
        } else {
          const days = parseGoogleIcs(text, year);
          if (days.length > 0) {
            const changed = JSON.stringify(days) !== JSON.stringify(calendar.days);
            calendar = autoCalendar(year, days, now);
            await saveCalendar(directory, calendar);
            if (changed) notes.push(`Data hari libur ${year} diperbarui dari Google Calendar.`);
          }
        }
      }
    }
    calendars.push(calendar);

    if (compareFrom && compareTo && calendar.status !== "auto-google" && compareTo >= `${year}-01-01` && compareFrom <= `${year}-12-31`) {
      const text = await googleText();
      if (text !== null) differences.push(...compareHolidayDays(calendar.days, parseGoogleIcs(text, year), compareFrom, compareTo));
    }
  }
  if (compareFrom && fetchError && online) notes.push("Tidak bisa membandingkan hari libur dengan Google Calendar (tidak ada internet); memakai data tersimpan.");
  return { calendars, notes, differences };
}
