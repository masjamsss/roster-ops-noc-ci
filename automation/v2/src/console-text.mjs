// The old Windows console (conhost with Consolas, Windows 10) has no glyphs for
// ✔ ✖ ⚠ and shows boxes. There, and only there, the CLI writes plain ASCII.
// Windows Terminal (Windows 11) sets WT_SESSION and shows the symbols fine.
const REPLACEMENTS = [["✔", "OK"], ["✖", "X"], ["⚠", "!"], ["•", "-"], ["→", "->"], ["↔", "<->"], ["—", "-"], ["–", "-"], ["…", "..."], ["█", "#"], ["░", "-"]];

export function needsPlainText({ platform = process.platform, env = process.env } = {}) {
  return platform === "win32" && !env.WT_SESSION;
}

export function plainText(text) {
  let out = String(text);
  for (const [symbol, ascii] of REPLACEMENTS) out = out.split(symbol).join(ascii);
  return out;
}
