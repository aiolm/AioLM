import { describe, expect, it } from 'vitest';
import { commandLineWarning, detectCommandSyntax, formatCommandLine } from './commandLine';

// The Rust import tests split these exact lines back into the same arguments
// (`powershell_lines_split_into_literal_arguments`, `posix_lines_round_trip_the_copied_form`).
// They were also run in Windows PowerShell 5.1, PowerShell 7 (Windows, Legacy
// and Standard argument passing), cmd and bash against a program that records
// the argv it receives.
describe('copyable launch command lines', () => {
  it('runs a quoted PowerShell program with the call operator and keeps plain arguments bare', () => {
    expect(formatCommandLine(['C:\\Engines\\synthetic engine\\serve.exe', '--port', '8080', '--name', 'a b'], 'powershell'))
      .toBe("& 'C:\\Engines\\synthetic engine\\serve.exe' --port '8080' --name 'a b'");
    expect(formatCommandLine(['C:\\Engines\\serve.exe', '--port=8080'], 'powershell'))
      .toBe('C:\\Engines\\serve.exe --port=8080');
    expect(formatCommandLine(['C:\\Engines\\synthetic engine\\serve.exe'], 'powershell'))
      .toBe("& 'C:\\Engines\\synthetic engine\\serve.exe'");
  });

  it('single-quotes PowerShell words the shell would expand, read as numbers or split in 5.1', () => {
    expect(formatCommandLine(['serve', '--chat-template={x}', '$HOME', 'a,b', '@file', "it's", '1e5', '-1', '.5', '-Dname=1.2', '-a:b', 'curly‘q’'], 'powershell'))
      .toBe("serve '--chat-template={x}' '$HOME' 'a,b' '@file' 'it''s' '1e5' '-1' '.5' '-Dname=1.2' '-a:b' 'curly‘‘q’’'");
    expect(formatCommandLine([], 'powershell')).toBe('');
  });

  it('passes what Windows PowerShell 5.1 would drop or break through Start-Process', () => {
    // 5.1 drops '', breaks embedded quotes and escapes a trailing backslash of
    // a spaced argument. Start-Process hands its one string to the program as
    // the raw command line in 5.1 and in every PowerShell 7 mode.
    expect(formatCommandLine(['C:\\Engines\\synthetic engine\\serve.exe', '--empty', '', '--say', 'say "hi"', '--dir', 'C:\\dir with space\\', '--pipe', 'a|b', '--env', '%PATH%', "it's", 'x'], 'powershell'))
      .toBe("Start-Process -FilePath 'C:\\Engines\\synthetic engine\\serve.exe' -ArgumentList '--empty \"\" --say \"say \\\"hi\\\"\" --dir \"C:\\dir with space\\\\\" --pipe a|b --env %PATH% it''s x' -NoNewWindow -Wait");
  });

  it('single-quotes POSIX words for bash and zsh and spells control characters as $-escapes', () => {
    expect(formatCommandLine(['/opt/engine', '--name', "it's $HOME", '--chat-template={x}', '', '=x', '~/m'], 'posix'))
      .toBe("/opt/engine --name 'it'\\''s $HOME' '--chat-template={x}' '' '=x' '~/m'");
    expect(formatCommandLine(['/opt/engine', '--prompt', 'line one\r\nline two\tend', "it's \\ \u001b"], 'posix'))
      .toBe("/opt/engine --prompt $'line one\\r\\nline two\\tend' $'it\\'s \\\\ \\x1b'");
  });

  it('puts each option on its own continued line when asked', () => {
    const args = ['C:\\Engines\\gufo.exe', 'serve', 'llm', '--model', 'C:\\models\\m one.gguf', '--top-k', '20', '--flag'];
    expect(formatCommandLine(args, 'powershell', { multiline: true }))
      .toBe("C:\\Engines\\gufo.exe serve llm `\n  --model 'C:\\models\\m one.gguf' `\n  --top-k '20' `\n  --flag");
    expect(formatCommandLine(['/opt/gufo', 'serve', '--model', '/m/a b.gguf'], 'posix', { multiline: true }))
      .toBe("/opt/gufo serve \\\n  --model '/m/a b.gguf'");
    // Negative numeric values stay on the same line as their option; `--` starts its own line.
    expect(formatCommandLine(['serve', '--sleep-idle-seconds', '-1', '--n-gpu-layers', '-1', '--scale', '-0.5', '--flag'], 'posix', { multiline: true }))
      .toBe("serve \\\n  --sleep-idle-seconds -1 \\\n  --n-gpu-layers -1 \\\n  --scale -0.5 \\\n  --flag");
    expect(formatCommandLine(['C:\\Engines\\serve.exe', '--sleep-idle-seconds', '-1', '--', 'helper'], 'powershell', { multiline: true }))
      .toBe("C:\\Engines\\serve.exe `\n  --sleep-idle-seconds '-1' `\n  -- helper");
    // cmd and the Start-Process form stay on one line.
    expect(formatCommandLine(['serve.exe', '--a', 'b'], 'windows', { multiline: true })).toBe('serve.exe --a b');
    expect(formatCommandLine(['serve.exe', '--a', ''], 'powershell', { multiline: true })).toContain('Start-Process');
    expect(formatCommandLine(['serve.exe'], 'posix', { multiline: true })).toBe('serve.exe');
  });

  it('uses C runtime quoting for cmd', () => {
    expect(formatCommandLine(['C:\\dir with space\\serve.exe', 'say "hi"', 'a&b', 'C:\\dir with space\\', ''], 'windows'))
      .toBe('"C:\\dir with space\\serve.exe" "say \\"hi\\"" "a&b" "C:\\dir with space\\\\" ""');
  });

  it('warns only where cmd changes %NAME% or ends at a line break', () => {
    expect(commandLineWarning(['serve', '--value', '%PATH%'], 'windows')).toBe('environment');
    expect(commandLineWarning(['serve', '--ratio', '50%', '100% sure'], 'windows')).toBeNull();
    expect(commandLineWarning(['serve', 'line\nbreak'], 'windows')).toBe('newline');
    for (const syntax of ['powershell', 'posix'] as const) {
      expect(commandLineWarning(['serve', '', '%PATH%', 'line\nbreak'], syntax)).toBeNull();
    }
  });
});

describe('the syntax a pasted command proves', () => {
  it('reads line continuations and copied forms, and leaves the rest to the user', () => {
    expect(detectCommandSyntax('python -m engine \\\n  --port 8080 \\\r\n  --x y')).toBe('posix');
    expect(detectCommandSyntax('serve.exe `\n  --port 8080')).toBe('powershell');
    expect(detectCommandSyntax('serve.exe ^\r\n  --port 8080')).toBe('windows');
    expect(detectCommandSyntax("/opt/engine --prompt $'a\\nb'")).toBe('posix');
    expect(detectCommandSyntax("& 'C:\\x y\\serve.exe' --port 1")).toBe('powershell');
    expect(detectCommandSyntax("start-process -FilePath 'x' -ArgumentList 'y'")).toBe('powershell');
    expect(detectCommandSyntax('serve --port 8080')).toBeNull();
    expect(detectCommandSyntax('C:\\models\\ --port 1')).toBeNull();
    expect(detectCommandSyntax('a \\\nb `\nc')).toBeNull();
  });
});
