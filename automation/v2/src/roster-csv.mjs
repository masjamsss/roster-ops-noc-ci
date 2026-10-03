import { normalizeCode } from "./codes.mjs";
import { RosterError } from "./errors.mjs";

// Excel with Indonesian regional settings saves CSV with ";" instead of ",".
function detectDelimiter(headerLine) {
  return headerLine.includes(";") && !headerLine.includes(",") ? ";" : ",";
}

function splitCsvLine(line, delimiter) {
  const cells = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quoted) {
      if (char === '"' && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else if (char === '"') quoted = false;
      else current += char;
    } else if (char === '"') quoted = true;
    else if (char === delimiter) {
      cells.push(current);
      current = "";
    } else current += char;
  }
  cells.push(current);
  return cells.map((cell) => cell.trim());
}

export function parseRosterCsv(text, { source = "file CSV" } = {}) {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter((line) => line.trim() !== "");
  if (lines.length === 0) throw new RosterError(`${source} kosong.`);
  const delimiter = detectDelimiter(lines[0]);
  const header = splitCsvLine(lines[0], delimiter);
  const idHeader = header[0]?.toLowerCase();
  const nameHeader = header[1]?.toLowerCase();
  if (!["id", "member_id"].includes(idHeader) || !["nama", "name", "member_name"].includes(nameHeader)) {
    throw new RosterError(`${source}: baris pertama harus diawali kolom "id" dan "nama".`);
  }
  const dates = header.slice(2);
  for (const date of dates) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new RosterError(`${source}: judul kolom "${date}" bukan tanggal (format 2026-09-30).`);
  }
  const memberIds = [];
  const names = {};
  const codesById = {};
  lines.slice(1).forEach((line, index) => {
    const cells = splitCsvLine(line, delimiter);
    const id = cells[0].toLowerCase();
    if (!id) throw new RosterError(`${source} baris ${index + 2}: kolom id kosong.`);
    memberIds.push(id);
    names[id] = cells[1] || id;
    codesById[id] = dates.map((date, dateIndex) => {
      try {
        return normalizeCode(cells[dateIndex + 2]);
      } catch (error) {
        throw new RosterError(`${source} baris ${index + 2} (${names[id]}, ${date}): ${error.message}`);
      }
    });
  });
  return { dates, memberIds, names, codesById };
}

function quote(value) {
  const text = String(value);
  return /[",;\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function formatRosterCsv({ dates, memberIds, names, codesById }) {
  const header = ["id", "nama", ...dates].join(",");
  const rows = memberIds.map((id) => [id, quote(names[id] ?? id), ...codesById[id]].join(","));
  return `${header}\n${rows.join("\n")}\n`;
}
