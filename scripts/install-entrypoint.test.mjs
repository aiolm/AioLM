import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const entrypoint = fileURLToPath(new URL("../install.ps1", import.meta.url));
const payload = Buffer.from("Synthetic installer fixture: never executable.\n", "utf8");
const digest = createHash("sha256").update(payload).digest("hex");

// Only external effects are shadowed. The real entrypoint resolves metadata,
// downloads fixture bytes, hashes them, quotes its path, and interprets exits.
const harness = String.raw`
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8
if ($PSVersionTable.PSVersion.Major -ne 5) {
    throw 'This regression must run under Windows PowerShell 5.'
}
# Parent PowerShell 7 module paths can hide Windows PowerShell's Get-FileHash.
# Import the real utility module before installing the external-effect mocks.
Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1') -ErrorAction Stop
# The entrypoint has its own script scope. Keep mock state in this disposable
# PowerShell process's global scope so its inherited functions share the state.
$global:fixture = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:AIOLM_INSTALL_TEST_FIXTURE)) | ConvertFrom-Json
$global:metadataRequests = 0
$global:downloads = New-Object 'System.Collections.Generic.List[string]'
$global:unblocked = New-Object 'System.Collections.Generic.List[string]'
$global:processes = New-Object 'System.Collections.Generic.List[object]'

function Invoke-RestMethod {
    param([switch]$UseBasicParsing, [Uri]$Uri, [hashtable]$Headers)
    if ($Uri.AbsoluteUri -ne 'https://api.github.com/repos/aiolm/AioLM/releases/tags/v9.9.9') {
        throw "Unexpected synthetic metadata request: $Uri"
    }
    $global:metadataRequests++
    [pscustomobject]@{
        tag_name = 'v9.9.9'
        assets = @([pscustomobject]@{
            name = $global:fixture.assetName
            browser_download_url = $global:fixture.downloadUrl
            digest = "sha256:$($global:fixture.digest)"
        })
    }
}

function Invoke-WebRequest {
    param([switch]$UseBasicParsing, [int]$MaximumRedirection, [Uri]$Uri, [string]$OutFile)
    if ($Uri.AbsoluteUri -ne $global:fixture.downloadUrl -or [string]::IsNullOrWhiteSpace($OutFile)) {
        throw "Unexpected synthetic download request: $Uri"
    }
    [IO.File]::WriteAllBytes($OutFile, [Convert]::FromBase64String($global:fixture.payload))
    $global:downloads.Add($OutFile)
}

function Unblock-File {
    param([string]$LiteralPath)
    $global:unblocked.Add($LiteralPath)
}

function Start-Process {
    param([string]$FilePath, [string[]]$ArgumentList, [switch]$Wait, [switch]$PassThru)
    $global:processes.Add([pscustomobject]@{
        filePath = $FilePath
        argumentList = @($ArgumentList)
        wait = [bool]$Wait
        passThru = [bool]$PassThru
    })
    [pscustomobject]@{ ExitCode = [int]$global:fixture.exitCode }
}

$output = New-Object 'System.Collections.Generic.List[string]'
$failure = $null
try {
    & $env:AIOLM_INSTALL_TEST_ENTRYPOINT -Release 'v9.9.9' -Installer $global:fixture.installer *>&1 |
        ForEach-Object { $output.Add($_.ToString()) }
} catch {
    $failure = $_.Exception.Message
}
$result = [pscustomobject]@{
    succeeded = ($null -eq $failure)
    error = $failure
    stdout = ($output -join [Environment]::NewLine)
    metadataRequests = $global:metadataRequests
    downloads = @($global:downloads.ToArray())
    unblocked = @($global:unblocked.ToArray())
    processes = @($global:processes.ToArray())
}
# A UTF-8 result file avoids PowerShell 5's console code page and CLIXML streams.
[IO.File]::WriteAllText($env:AIOLM_INSTALL_TEST_RESULT, ($result | ConvertTo-Json -Depth 8 -Compress), $utf8)
if ($null -ne $failure) { exit 1 }
exit 0
`;

/**
 * @typedef {{
 *   succeeded: boolean, error: string | null, stdout: string,
 *   metadataRequests: number, downloads: string[], unblocked: string[],
 *   processes: { filePath: string, argumentList: string[], wait: boolean, passThru: boolean }[]
 * }} InstallResult
 * @param {import("node:test").TestContext} t
 * @param {"msi" | "nsis"} installer
 * @param {number} exitCode
 */
function runInstaller(t, installer, exitCode) {
  const root = mkdtempSync(join(tmpdir(), "aiolm installer regression "));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const resultPath = join(root, "result.json");
  const assetName = installer === "msi" ? "AioLM_9.9.9_x64_en-US.msi" : "AioLM_9.9.9_x64-setup.exe";
  const fixture = {
    installer, exitCode, assetName, digest, payload: payload.toString("base64"),
    downloadUrl: `https://github.com/aiolm/AioLM/releases/download/v9.9.9/${assetName}`,
  };
  const powershell = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const child = spawnSync(powershell, [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-EncodedCommand", Buffer.from(harness, "utf16le").toString("base64"),
  ], {
    cwd: root,
    env: {
      ...process.env, TEMP: root, TMP: root, AIOLM_DRY_RUN: "0", LLAMA_BOARD_DRY_RUN: "0",
      AIOLM_INSTALL_TEST_ENTRYPOINT: entrypoint,
      AIOLM_INSTALL_TEST_RESULT: resultPath,
      AIOLM_INSTALL_TEST_FIXTURE: Buffer.from(JSON.stringify(fixture), "utf8").toString("base64"),
    },
    encoding: "utf8", timeout: 30_000, windowsHide: true,
  });
  assert.ifError(child.error);
  assert.equal(child.signal, null, child.stderr);
  /** @type {InstallResult} */
  const result = JSON.parse(readFileSync(resultPath, "utf8"));
  const diagnostics = JSON.stringify({ status: child.status, ...result, stderr: child.stderr });
  assert.equal(result.metadataRequests, 1, diagnostics);
  assert.equal(result.downloads.length, 1, diagnostics);
  const [installerPath] = result.downloads;
  assert.ok(installerPath);
  assert.equal(dirname(dirname(installerPath)), root, "the consumer-visible installer path uses the temporary directory with spaces");
  assert.ok(installerPath.includes(" "));
  assert.equal(result.unblocked.length, 1, diagnostics);
  assert.deepEqual(result.unblocked, [installerPath], diagnostics);
  assert.match(result.stdout, new RegExp(`SHA-256 verified: ${digest}`), diagnostics);
  assert.equal(result.processes.length, 1, diagnostics);
  const [invocation] = result.processes;
  assert.ok(invocation);
  assert.equal(invocation.wait, true);
  assert.equal(invocation.passThru, true);
  if (installer === "msi") {
    assert.equal(invocation.filePath, "msiexec.exe");
    assert.deepEqual(invocation.argumentList, [`/i "${installerPath}" /qn /norestart`], "Start-Process must receive one string with the installer path quoted");
  } else {
    assert.equal(invocation.filePath, installerPath);
    assert.deepEqual(invocation.argumentList, ["/S"]);
  }
  return { result, status: child.status };
}

for (const exitCode of [0, 3010, 1641]) {
  test(`install.ps1 accepts MSI exit ${exitCode} with a spaced temporary path`, { skip: process.platform !== "win32" }, t => {
    const { result, status } = runInstaller(t, "msi", exitCode);
    assert.equal(status, 0, result.error ?? result.stdout);
    assert.equal(result.succeeded, true);
    assert.equal(result.error, null);
    assert.match(result.stdout, /AioLM installed successfully\./);
    if (exitCode === 0) {
      assert.doesNotMatch(result.stdout, /Restart Windows/);
    } else {
      assert.ok(result.stdout.includes(`Restart Windows to finish the installation (installer exit code ${exitCode}).`));
    }
  });
}

/** @type {{ installer: "msi" | "nsis", exitCode: number }[]} */
const failures = [
  { installer: "msi", exitCode: 1603 },
  { installer: "nsis", exitCode: 1603 },
  { installer: "nsis", exitCode: 3010 },
  { installer: "nsis", exitCode: 1641 },
];
for (const { installer, exitCode } of failures) {
  test(`install.ps1 rejects ${installer.toUpperCase()} exit ${exitCode}`, { skip: process.platform !== "win32" }, t => {
    const { result, status } = runInstaller(t, installer, exitCode);
    assert.equal(status, 1, result.stdout);
    assert.equal(result.succeeded, false);
    assert.equal(result.error, `Installer exited with code ${exitCode}.`);
    assert.doesNotMatch(result.stdout, /AioLM installed successfully\.|Restart Windows/);
  });
}
