// The double-click launchers are checked statically: they cannot be run here
// (no Windows), but the mistakes that break them are visible in the file.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = new URL("../../../", import.meta.url);
const bat = readFileSync(new URL("Buat Roster.bat", root));
const selftestBat = readFileSync(new URL("Uji Program.bat", root));
const command = new URL("Buat Roster.command", root);

test("Buat Roster.bat: CRLF line endings and plain ASCII (cmd.exe misreads labels with LF)", () => {
  const text = bat.toString("latin1");
  assert.equal(text.split("\n").length - 1, text.split("\r\n").length - 1, "every line ends with CRLF");
  assert.ok([...bat].every((byte) => byte < 128), "ASCII only: the file is read before chcp 65001 applies");
});

test("Buat Roster.bat: every goto has its label, npm is called, and every exit shows its message first", () => {
  const lines = bat.toString("latin1").split("\r\n");
  const labels = new Set(lines.filter((line) => line.startsWith(":")).map((line) => line.slice(1).trim().toLowerCase()));
  for (const line of lines) {
    const target = line.match(/goto\s+(\S+)/i)?.[1];
    if (target) assert.ok(labels.has(target.toLowerCase()), `label :${target} exists`);
  }
  assert.ok(lines.some((line) => /^call npm install/i.test(line.trim())), "npm is a .cmd: without call the script stops after it");
  lines.forEach((line, index) => {
    if (/^exit \/b/i.test(line.trim())) assert.match(lines[index - 1].trim(), /^pause$/i, `a pause before "${line.trim()}" (line ${index + 1})`);
  });
});

test("Buat Roster.bat works from a network folder (\\\\server\\share): pushd, not cd /d", () => {
  const text = bat.toString("latin1");
  assert.match(text, /pushd "%~dp0"/i);
  assert.doesNotMatch(text, /cd \/d "%~dp0"/i);
});

test("Buat Roster.command: valid bash, LF line endings, executable", { skip: process.platform === "win32" ? "Mac launcher; Windows has no executable bit" : false }, () => {
  const text = readFileSync(command, "utf8");
  assert.ok(!text.includes("\r"), "LF only");
  execFileSync("bash", ["-n", fileURLToPath(command)]);
  assert.ok(statSync(command).mode & 0o100, "executable bit set");
});

test("Uji Program.bat follows the same rules: CRLF, ASCII, labels, pushd, a pause before every exit", () => {
  const text = selftestBat.toString("latin1");
  assert.equal(text.split("\n").length - 1, text.split("\r\n").length - 1);
  assert.ok([...selftestBat].every((byte) => byte < 128));
  const lines = text.split("\r\n");
  const labels = new Set(lines.filter((line) => line.startsWith(":")).map((line) => line.slice(1).trim().toLowerCase()));
  for (const line of lines) {
    const target = line.match(/goto\s+(\S+)/i)?.[1];
    if (target) assert.ok(labels.has(target.toLowerCase()), `label :${target}`);
  }
  assert.match(text, /pushd "%~dp0"/);
  assert.match(text, /node automation\\v2\\tools\\selftest\.mjs/);
  lines.forEach((line, index) => {
    if (/^exit \/b/i.test(line.trim())) assert.match(lines[index - 1].trim(), /^pause$/i);
  });
});
