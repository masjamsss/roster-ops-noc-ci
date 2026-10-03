import { parseIsoDate } from "./date-utils.mjs";

export const BULAN = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];
export const BULAN_PENDEK = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];
export const HARI = ["Minggu", "Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu"];
export const HARI_PENDEK = ["Min", "Sen", "Sel", "Rab", "Kam", "Jum", "Sab"];

export const KODE_LABEL = Object.freeze({
  "1": "Shift 1 (Pagi)",
  "2": "Shift 2 (Siang)",
  "3": "Shift 3 (Malam)",
  H: "Libur",
  C: "Cuti",
  S: "Sakit",
  T: "Training/Dinas",
  "-": "Tidak aktif"
});

export function namaBulan(month) {
  return BULAN[month - 1];
}

export function namaHari(iso) {
  return HARI[parseIsoDate(iso).getUTCDay()];
}

export function namaHariPendek(iso) {
  return HARI_PENDEK[parseIsoDate(iso).getUTCDay()];
}

export function formatTanggal(iso, { denganHari = false, pendek = false } = {}) {
  const date = parseIsoDate(iso);
  const day = date.getUTCDate();
  const text = pendek
    ? `${day} ${BULAN_PENDEK[date.getUTCMonth()]}`
    : `${day} ${BULAN[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
  return denganHari ? `${HARI[date.getUTCDay()]}, ${text}` : text;
}

// "1–3 Okt" for consecutive dates in one month, otherwise a comma list of short dates.
export function formatRentang(isoDates) {
  if (isoDates.length === 0) return "";
  if (isoDates.length === 1) return formatTanggal(isoDates[0], { pendek: true });
  const first = parseIsoDate(isoDates[0]);
  const last = parseIsoDate(isoDates.at(-1));
  const consecutive = isoDates.every((iso, index) => parseIsoDate(iso).getTime() === first.getTime() + index * 86_400_000);
  if (consecutive && first.getUTCMonth() === last.getUTCMonth()) {
    return `${first.getUTCDate()}–${last.getUTCDate()} ${BULAN_PENDEK[first.getUTCMonth()]}`;
  }
  if (consecutive) return `${formatTanggal(isoDates[0], { pendek: true })} – ${formatTanggal(isoDates.at(-1), { pendek: true })}`;
  return isoDates.map((iso) => formatTanggal(iso, { pendek: true })).join(", ");
}

// "1–3 Okt" for a start/end pair (inclusive).
export function formatPeriode(start, end) {
  if (start === end) return formatTanggal(start, { pendek: true });
  const dates = [];
  for (let time = parseIsoDate(start).getTime(); time <= parseIsoDate(end).getTime(); time += 86_400_000) dates.push(new Date(time).toISOString().slice(0, 10));
  return formatRentang(dates);
}

export function daftarNama(names) {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} dan ${names.at(-1)}`;
}
