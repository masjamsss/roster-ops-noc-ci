// Recalculates every formula of an .xlsx with LibreOffice (headless) and saves
// the file in place. This is the independent check that the Excel formulas
// compute what the program cached. Uses a throw-away LibreOffice profile with a
// one-line macro (calculateAll, store), so the user's own LibreOffice settings
// are never touched. Needs LibreOffice installed.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const MACRO = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE script:module PUBLIC "-//OpenOffice.org//DTD OfficeDocument 1.0//EN" "module.dtd">
<script:module xmlns:script="http://openoffice.org/2000/script" script:name="Module1" script:language="StarBasic">
Sub Recalculate()
  ThisComponent.calculateAll()
  ThisComponent.store()
  ThisComponent.close(True)
End Sub
</script:module>`;

export function findSoffice() {
  const candidates = [
    "/Applications/LibreOffice.app/Contents/MacOS/soffice",
    "/opt/homebrew/bin/soffice",
    "/usr/local/bin/soffice",
    "/usr/bin/soffice",
    "C:\\Program Files\\LibreOffice\\program\\soffice.exe"
  ];
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  try {
    const found = execFileSync(process.platform === "win32" ? "where" : "which", ["soffice"], { encoding: "utf8" }).split(/\r?\n/)[0].trim();
    return found || null;
  } catch {
    return null;
  }
}

export function recalculate(file, { timeout = 180_000 } = {}) {
  const soffice = findSoffice();
  if (!soffice) throw new Error("LibreOffice (soffice) tidak ditemukan; rumus tidak bisa dihitung ulang.");
  const profile = mkdtempSync(path.join(tmpdir(), "roster-lo-"));
  const profileUrl = pathToFileURL(profile).href;
  try {
    execFileSync(soffice, ["--headless", "--terminate_after_init", `-env:UserInstallation=${profileUrl}`], { timeout, stdio: "ignore" });
    const macroDir = path.join(profile, "user", "basic", "Standard");
    if (!existsSync(macroDir)) throw new Error("LibreOffice tidak membuat profilnya; rumus tidak dihitung ulang.");
    writeFileSync(path.join(macroDir, "Module1.xba"), MACRO);
    execFileSync(soffice, ["--headless", "--norestore", `-env:UserInstallation=${profileUrl}`,
      "vnd.sun.star.script:Standard.Module1.Recalculate?language=Basic&location=application", path.resolve(file)], { timeout, stdio: "ignore" });
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
}
