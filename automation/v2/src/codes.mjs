import { RosterError } from "./errors.mjs";

export const CODE = Object.freeze({
  OFF: "H",
  LEAVE: "C",
  SICK: "S",
  TRAINING: "T",
  REGULAR: "R",
  INACTIVE: "-"
});

export const SHIFT_IDS = Object.freeze(["1", "2", "3"]);
export const ALL_CODES = Object.freeze([...SHIFT_IDS, CODE.OFF, CODE.LEAVE, CODE.SICK, CODE.TRAINING, CODE.REGULAR, CODE.INACTIVE]);

// Older rosters and hand-typed cells use other spellings for the same meaning.
// ("R" was once an alias of H; since 28 Oct it is Shift Reguler. No roster used it.)
const ALIASES = new Map([
  ["OFF", CODE.INACTIVE],
  ["–", CODE.INACTIVE],
  ["—", CODE.INACTIVE],
  ["X", CODE.INACTIVE],
  ["L", CODE.OFF],
  ["LIBUR", CODE.OFF],
  ["CUTI", CODE.LEAVE],
  ["CT", CODE.LEAVE],
  ["AL", CODE.LEAVE],
  ["SAKIT", CODE.SICK],
  ["SL", CODE.SICK],
  ["T1", CODE.TRAINING],
  ["T2", CODE.TRAINING],
  ["T3", CODE.TRAINING],
  ["TR", CODE.TRAINING],
  ["TRAINING", CODE.TRAINING],
  ["DINAS", CODE.TRAINING]
]);

export function normalizeCode(raw) {
  if (raw === null || raw === undefined) return CODE.INACTIVE;
  if (typeof raw === "number" && Number.isInteger(raw)) raw = String(raw);
  const text = String(raw).trim().toUpperCase();
  if (text === "") return CODE.INACTIVE;
  if (ALL_CODES.includes(text)) return text;
  if (/^[123]\.0+$/.test(text)) return text[0];
  if (ALIASES.has(text)) return ALIASES.get(text);
  throw new RosterError(`Kode "${String(raw).trim()}" tidak dikenal. Kode yang dipakai: 1, 2, 3, H, C, S, T, R, -.`);
}

export function isShiftCode(code, shiftIds = SHIFT_IDS) {
  return shiftIds.includes(code);
}

// Training/dinas and Shift Reguler are not on the 24/7 shifts, but they are
// working days for the fatigue rules (5 days in a row, rest, after nights).
export function isWorkLike(code, shiftIds = SHIFT_IDS) {
  return isShiftCode(code, shiftIds) || isFixedWork(code);
}

export function isFixedWork(code) {
  return code === CODE.TRAINING || code === CODE.REGULAR;
}

export function isOffLike(code) {
  return code === CODE.OFF || code === CODE.LEAVE || code === CODE.SICK || code === CODE.INACTIVE;
}
