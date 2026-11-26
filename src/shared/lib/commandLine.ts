import type { CommandSyntax } from '../api/runtimeHelp';

/** The shell a user's terminal most likely runs: PowerShell is the Windows
 * Terminal default; Linux and macOS shells (bash, zsh) follow POSIX quoting. */
export function hostCommandLineSyntax(): Exclude<CommandSyntax, 'windows'> {
  return typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent) ? 'powershell' : 'posix';
}

/** PowerShell expands `$`, braces, `@`, `;`, commas, parentheses, backticks
 * and more in bare words, and reads a word starting with a digit or sign as a
 * number. Windows PowerShell 5.1 also splits a bare `-name.part` or
 * `-name:part` into two arguments. A single-quoted literal avoids all of it. */
function quotePowerShell(arg: string): string {
  if (arg && /^[A-Za-z0-9_\-.:\\/=+]+$/.test(arg) && !/^[-+]?[0-9.]/.test(arg) && !/^-.*[.:]/.test(arg)) return arg;
  return powerShellLiteral(arg);
}

/** Microsoft C runtime quoting (`CommandLineToArgvW`): backslashes double only
 * before a quote. `quote` writes one literal quote inside a quoted argument. */
function quoteRuntime(arg: string, needsQuotes: RegExp, quote: (slashes: number) => string): string {
  if (arg && !needsQuotes.test(arg)) return arg;
  let out = '"';
  let slashes = 0;
  for (const char of arg) {
    if (char === '\\') { slashes += 1; continue; }
    if (char === '"') { out += quote(slashes); slashes = 0; continue; }
    out += '\\'.repeat(slashes) + char;
    slashes = 0;
  }
  return `${out}${'\\'.repeat(slashes * 2)}"`;
}

/** cmd.exe: characters cmd itself interprets are quoted too. */
const quoteWindows = (arg: string) => quoteRuntime(arg, /[\s"&|<>^()!]/, slashes => `${'\\'.repeat(slashes * 2 + 1)}"`);

/** One argument of a raw command line the program splits itself. */
const quoteRaw = (arg: string) => quoteRuntime(arg, /[\s"]/, slashes => `${'\\'.repeat(slashes * 2 + 1)}"`);

/** A PowerShell single-quoted literal; PowerShell also closes one on curly quotes. */
const powerShellLiteral = (text: string) => `'${text.replace(/['‘’‚‛]/g, quote => quote + quote)}'`;

/** bash and zsh: a leading `=` or `~` expands in zsh, so only plain words
 * stay bare. */
function quotePosix(arg: string): string {
  if (arg && /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) && !arg.startsWith('=')) return arg;
  if (/[\x00-\x1f\x7f]/.test(arg)) return ansiCQuote(arg);
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

const ANSI_C_ESCAPES: Record<string, string> = { '\n': '\\n', '\r': '\\r', '\t': '\\t', '\\': '\\\\', "'": "\\'" };

/** bash and zsh `$'…'`: control characters are written as escapes, so a line
 * break or carriage return survives pasting into a terminal and running a
 * saved script, which may drop a raw carriage return. */
function ansiCQuote(arg: string): string {
  let out = "$'";
  for (const char of arg) {
    const code = char.codePointAt(0)!;
    out += ANSI_C_ESCAPES[char] ?? (code < 0x20 || code === 0x7f ? `\\x${code.toString(16).padStart(2, '0')}` : char);
  }
  return `${out}'`;
}

const expandsEnvironment = (args: readonly string[]) => args.some(arg => /%[^%\s]+%/.test(arg));

/** Windows PowerShell 5.1 (and PowerShell 7 in Legacy mode) drops empty
 * arguments, breaks embedded quotes and turns a trailing backslash of a spaced
 * argument into an escaped quote when it passes arguments to a program. */
function legacyPowerShellUnsafe(args: readonly string[]): boolean {
  return args.some(arg => arg === '' || arg.includes('"') || (/\s/.test(arg) && arg.endsWith('\\')));
}

/** Arguments joined into one line that a terminal of `syntax` runs as the same
 * program and arguments, and that the import parser of the same syntax splits
 * back into them.
 *
 * PowerShell output runs the same in Windows PowerShell 5.1 and PowerShell 7
 * in every `$PSNativeCommandArgumentPassing` mode. Arguments 5.1 would break go
 * through `Start-Process -ArgumentList`, whose single string reaches the
 * program as its raw command line in every version; `--%` was not used
 * because PowerShell 7.3+ re-quotes the text after it.
 *
 * `multiline` starts each option (an argument beginning with `-`) on its own
 * line with the shell's line continuation: a trailing backtick in PowerShell
 * and `\` in bash and zsh. cmd and the `Start-Process` form stay on one line,
 * since neither continues a line in a way every paste keeps. */
export function formatCommandLine(args: readonly string[], syntax: CommandSyntax, { multiline = false } = {}): string {
  if (!args.length) return '';
  if (syntax === 'windows') return args.map(quoteWindows).join(' ');
  if (syntax === 'posix') return joinWords(args, args.map(quotePosix), multiline ? ' \\' : null);
  const [first, ...rest] = args as [string, ...string[]];
  if (legacyPowerShellUnsafe(rest)) {
    return `Start-Process -FilePath ${powerShellLiteral(first)} -ArgumentList ${powerShellLiteral(rest.map(quoteRaw).join(' '))} -NoNewWindow -Wait`;
  }
  const program = quotePowerShell(first);
  // A quoted program is only a string to PowerShell; `&` runs it.
  const head = program.startsWith("'") ? `& ${program}` : program;
  return joinWords(args, [head, ...rest.map(quotePowerShell)], multiline ? ' `' : null);
}

const NEGATIVE_NUMBER = /^-(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:e[+-]?\d+)?$/i;
const startsOption = (arg: string) => arg.startsWith('-') && !NEGATIVE_NUMBER.test(arg);

/** Words joined by spaces, or with `continuation` before each option. */
function joinWords(args: readonly string[], words: readonly string[], continuation: string | null): string {
  if (!continuation) return words.join(' ');
  let out = words[0] ?? '';
  for (let index = 1; index < words.length; index += 1) {
    out += startsOption(args[index]!) ? `${continuation}\n  ${words[index]}` : ` ${words[index]}`;
  }
  return out;
}

export type CommandLineWarning = 'environment' | 'newline';

/** Why the formatted line may not run as shown. cmd.exe replaces `%NAME%` with
 * a defined environment variable even inside quotes and ends the command at a
 * line break, and has no escape for either. PowerShell literals and POSIX
 * single quotes keep both as written. */
export function commandLineWarning(args: readonly string[], syntax: CommandSyntax): CommandLineWarning | null {
  if (syntax !== 'windows') return null;
  if (args.some(arg => /[\r\n]/.test(arg))) return 'newline';
  return expandsEnvironment(args) ? 'environment' : null;
}

/** The syntax a pasted command proves: a line continuation with a trailing
 * `\` (bash, zsh), backtick (PowerShell) or `^` (cmd), a bash/zsh `$'…'`
 * string, or the PowerShell forms this app copies (`& '…'`, `Start-Process`).
 * When nothing or conflicting evidence is found the choice stays with the user. */
export function detectCommandSyntax(text: string): CommandSyntax | null {
  const found = new Set<CommandSyntax>();
  for (const match of text.matchAll(/([\\`^])[ \t]*\r?\n/g)) {
    found.add(match[1] === '\\' ? 'posix' : match[1] === '`' ? 'powershell' : 'windows');
  }
  if (/(^|\s)\$'/.test(text)) found.add('posix');
  if (/^\s*(&\s*['‘’"]|Start-Process\s)/i.test(text)) found.add('powershell');
  return found.size === 1 ? [...found][0]! : null;
}
