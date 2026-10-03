// A RosterError carries a message written for the admin (Bahasa Indonesia).
// The CLI prints only the message for these, never a stack trace.
export class RosterError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "RosterError";
    this.details = details;
  }
}

// Windows locks a file while Excel has it open (EBUSY/EPERM/EACCES on rename
// or write). Turns that into a message the admin can act on; null otherwise.
const LOCK_CODES = new Set(["EBUSY", "EPERM", "EACCES"]);

export function explainFileError(error) {
  if (!error || !LOCK_CODES.has(error.code) || !error.path) return null;
  const name = String(error.path).split(/[\\/]/).at(-1);
  return new RosterError(`File "${name}" sedang dibuka di Excel (atau dikunci), jadi tidak bisa diubah atau dipindah. Tutup file itu, lalu coba lagi.`, { file: error.path });
}
