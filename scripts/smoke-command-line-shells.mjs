/* global process, console */
// Runs copied launch command lines in the real shells installed here and
// checks that the program receives exactly the intended arguments.
// Usage: node --experimental-strip-types scripts/smoke-command-line-shells.mjs
// Shells that are not installed are reported as skipped. A line the app warns
// about (cmd.exe `%NAME%` expansion or line breaks) counts as expected.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { commandLineWarning, formatCommandLine } = await import("../src/shared/lib/commandLine.ts");

const windows = process.platform === "win32";
const temporary = mkdtempSync(join(tmpdir(), "aiolm-shells-"));
// The program sits in a folder with a space and non-ASCII characters.
const binDir = join(temporary, "bin dir 한글");
mkdirSync(binDir);
const node = join(binDir, windows ? "node.exe" : "node");
copyFileSync(process.execPath, node);
const dump = join(binDir, "dump.cjs");
writeFileSync(dump, "require('fs').writeFileSync(process.env.ARGV_OUT, JSON.stringify(process.argv.slice(2)), 'utf8');\n");
const output = join(temporary, "argv.json");

/** Synthetic argument sets covering each shell's special characters. */
const cases = {
  plain: ["--port", "8080", "--model", windows ? "C:\\models\\m.gguf" : "/models/m.gguf", "--flag"],
  spaces: ["--name", "a b", "--path", "C:\\dir with space\\x.bin", "--tab", "a\tb"],
  powershellSpecial: ["$HOME", "{x}", "--chat-template={x}", "a,b", "@file", "it's", "1e5", "-1", ".5", "+5", "0x10", "-Dname=1.2", "-a:b", "-a.b", "semi;colon", "(paren)", "back`tick", "#hash", "*", "q?"],
  realistic: ["serve", "llm", "--model", "C:\\models\\Qwen Flash\\model-00001-of-00004.gguf", "--served-model-name", "Qwen-Flash", "--top-k", "20", "--top-p", "0.95", "--min-p", "0", "--speculative", "mtp", "--draft-policy", "survival"],
  shellSpecial: ["a|b", "a&b", "a<b", "a>b", "a^b", "!bang", "~/m", "=x", "x=y", "--k=v w"],
  unicode: ["한글 값", "日本語", "emoji😀", "curly‘quote’"],
  emptyValue: ["--empty", "", "--after", "x"],
  embeddedQuotes: ["--say", 'say "hi"', "--json", '{"a":1,"b":"c d"}', 'a\\"b'],
  trailingBackslash: ["--dir", "C:\\dir with space\\", "--x", "C:\\plain\\"],
  mixed: ["", "a|b", 'say "hi" | there', "C:\\a b\\", "$HOME", "it's", "50%", "x"],
  percent: ["50%", "100% sure", "%", "%%"],
  environmentName: ["--path", "%PATH%", "--x", "x"],
  environmentNameMixed: ["", "%PATH%", 'say "hi"'],
  lineBreak: ["--prompt", "line one\nline two"],
  lineBreakMixed: ["", "line one\r\nline two"],
};

/** @param {string} command @param {string[]} args */
const available = (command, args) => {
  const result = spawnSync(command, args, { stdio: "ignore", windowsHide: true });
  return !result.error && result.status === 0;
};

/** @type {Array<{ name: string, syntax: "powershell" | "windows" | "posix", run: (line: string) => import("node:child_process").SpawnSyncReturns<Buffer> }>} */
const shells = [];
/** @param {string} name @param {string} executable @param {string} prefix */
const addPowerShell = (name, executable, prefix) => {
  if (!available(executable, ["-NoProfile", "-NonInteractive", "-Command", "exit 0"])) return;
  shells.push({ name, syntax: "powershell", run: line => {
    const file = join(temporary, "line.ps1");
    // Windows PowerShell 5.1 reads a script without a BOM as ANSI.
    writeFileSync(file, `\uFEFF${prefix}${line}\n`, "utf8");
    return spawnSync(executable, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file], { windowsHide: true });
  } });
};
/** @param {string} name @param {string} executable */
const addPosix = (name, executable) => {
  if (!available(executable, ["-c", "exit 0"])) return;
  shells.push({ name, syntax: "posix", run: line => {
    const file = join(temporary, "line.sh");
    writeFileSync(file, `${line}\n`, "utf8");
    return spawnSync(executable, [file], { windowsHide: true });
  } });
};

if (windows) addPowerShell("Windows PowerShell 5.1", "powershell.exe", "");
for (const mode of ["", "Legacy", "Standard", "Windows"]) {
  if (mode === "Windows" && !windows) continue;
  addPowerShell(`pwsh${mode ? ` (${mode})` : ""}`, "pwsh", mode ? `$PSNativeCommandArgumentPassing = '${mode}'\n` : "");
}
if (windows) {
  // A command-line cmd (not a batch file): /s keeps the line as typed at a prompt.
  shells.push({ name: "cmd", syntax: "windows", run: line => spawnSync("cmd.exe", ["/d", "/s", "/c", `"${line}"`], { windowsVerbatimArguments: true, windowsHide: true }) });
  addPosix("bash (Git)", "C:\\Program Files\\Git\\usr\\bin\\bash.exe");
} else {
  addPosix("bash", "bash");
  addPosix("zsh", "zsh");
}

let failures = 0;
let passed = 0;
let warned = 0;
process.env.ARGV_OUT = output;
for (const shell of shells) {
  // Both the one-line form and the one-option-per-line form are copied.
  for (const multiline of [false, true]) {
    for (const [name, args] of Object.entries(cases)) {
      const argv = [node, dump, ...args];
      const line = formatCommandLine(argv, shell.syntax, { multiline });
      const warning = commandLineWarning(argv, shell.syntax);
      const label = `${shell.name} / ${name}${multiline ? " (multiline)" : ""}`;
      rmSync(output, { force: true });
      const result = shell.run(line);
      let received;
      try { received = JSON.parse(readFileSync(output, "utf8")); } catch { received = `no output (status ${result.status}): ${String(result.stderr ?? "").trim().split("\n")[0]}`; }
      if (JSON.stringify(received) === JSON.stringify(args)) { passed += 1; continue; }
      if (warning) { warned += 1; console.log(`warned  ${label} (${warning})`); continue; }
      failures += 1;
      console.log(`FAIL    ${label}\n  line: ${line}\n  want: ${JSON.stringify(args)}\n  got:  ${JSON.stringify(received)}`);
    }
  }
}
rmSync(temporary, { recursive: true, force: true });
console.log(`shells: ${shells.map(shell => shell.name).join(", ") || "none"}`);
console.log(`${passed} exact, ${warned} warned in the app, ${failures} unexpected`);
if (!shells.length || failures) process.exit(1);
