#Requires -Version 7.4
# Run against a built desktop executable with no existing AioLM instance:
# pwsh -NoProfile -File tests/windows/single-instance-startup.ps1 -Exe .codex-target/debug/aiolm.exe
# All app data belongs to a fresh repository-local tmp directory. Only the
# processes launched here are closed; fixture files remain available to inspect.
param([Parameter(Mandatory)][string] $Exe)
$ErrorActionPreference = 'Stop'
if (!$IsWindows) { throw 'This integration check requires Windows.' }
$Exe = (Resolve-Path -LiteralPath $Exe).Path
if (Get-Process -Name aiolm -ErrorAction SilentlyContinue) { throw 'An AioLM process is already running.' }
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class SingleInstanceWindow {
  delegate bool Callback(IntPtr window, IntPtr context);
  [DllImport("user32.dll")] static extern bool EnumWindows(Callback callback, IntPtr context);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr window, StringBuilder text, int capacity);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr window, uint message, IntPtr w, IntPtr l);
  public static IntPtr Find(uint process, string expected) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((window, context) => {
      uint owner; GetWindowThreadProcessId(window, out owner);
      if (owner != process) return true;
      var title = new StringBuilder(256); GetWindowText(window, title, 256);
      if (title.ToString() == expected) { found = window; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
'@
function Wait-For([scriptblock] $Condition, [string] $Failure) {
    $until = [DateTime]::UtcNow.AddSeconds(20)
    while ([DateTime]::UtcNow -lt $until) {
        if (& $Condition) { return }
        Start-Sleep -Milliseconds 50
    }
    throw $Failure
}
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "../../tmp/single-instance-startup/$([Guid]::NewGuid())"))
$childEnvironment = @{
    APPDATA = (Join-Path $root 'Roaming')
    LOCALAPPDATA = (Join-Path $root 'Local')
    USERPROFILE = (Join-Path $root 'home')
    WEBVIEW2_USER_DATA_FOLDER = (Join-Path $root 'webview2')
}
foreach ($directory in $childEnvironment.Values) { New-Item -ItemType Directory -Path $directory -Force | Out-Null }
$configDirectory = Join-Path $childEnvironment.APPDATA 'aiolm'
New-Item -ItemType Directory -Path $configDirectory -Force | Out-Null
$configPath = Join-Path $configDirectory 'config.json'
[IO.File]::WriteAllText($configPath, '{"config_version":12,"close_to_tray":true}')
$processes = [Collections.Generic.List[Diagnostics.Process]]::new()
$legacyLock = $null
try {
    $primary = Start-Process -FilePath $Exe -WindowStyle Hidden -Environment $childEnvironment -PassThru
    $null = $primary.Handle
    $processes.Add($primary)
    $script:window = [IntPtr]::Zero
    Wait-For {
        $script:window = [SingleInstanceWindow]::Find([uint32]$primary.Id, 'AioLM')
        $script:window -ne [IntPtr]::Zero -and [SingleInstanceWindow]::IsWindowVisible($script:window)
    } 'Primary launch did not show its window.'
    [void][SingleInstanceWindow]::PostMessage($window, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
    Wait-For { -not [SingleInstanceWindow]::IsWindowVisible($window) } 'Primary window did not hide to tray.'

    # A secondary launch should only notify the running app, even when unrelated
    # legacy data becomes locked after the primary has finished initializing.
    $legacyProfile = Join-Path $childEnvironment.LOCALAPPDATA 'com.llamaboard.desktop/EBWebView'
    New-Item -ItemType Directory -Path $legacyProfile -Force | Out-Null
    $legacyLock = [IO.File]::Open((Join-Path $legacyProfile 'LOCK'), [IO.FileMode]::Create, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    $secondary = Start-Process -FilePath $Exe -WindowStyle Hidden -Environment $childEnvironment -PassThru
    $null = $secondary.Handle
    $processes.Add($secondary)
    Wait-For { $secondary.HasExited -or [SingleInstanceWindow]::Find([uint32]$secondary.Id, 'AioLM — Data migration') -ne [IntPtr]::Zero } 'Secondary launch neither exited nor displayed an error.'
    if (!$secondary.HasExited) { throw 'Secondary launch entered data initialization and displayed a migration error instead of restoring the existing window.' }
    if ($secondary.ExitCode -ne 0) { throw 'Secondary launch failed.' }
    Wait-For { [SingleInstanceWindow]::IsWindowVisible($window) } 'Primary window was not restored.'
    # A genuine new primary must still report initialization errors and allow
    # cancellation before opening its webview, even though the plugin is ready.
    [IO.File]::WriteAllText($configPath, '{"config_version":12,"close_to_tray":false}')
    [void][SingleInstanceWindow]::PostMessage($window, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
    Wait-For { $primary.HasExited } 'Primary launch did not exit normally.'
    if ($primary.ExitCode -ne 0) { throw 'Primary launch failed during shutdown.' }
    $cancelled = Start-Process -FilePath $Exe -WindowStyle Hidden -Environment $childEnvironment -PassThru
    $null = $cancelled.Handle
    $processes.Add($cancelled)
    $script:dialog = [IntPtr]::Zero
    Wait-For {
        $script:dialog = [SingleInstanceWindow]::Find([uint32]$cancelled.Id, 'AioLM — Data migration')
        $script:dialog -ne [IntPtr]::Zero
    } 'New primary did not report its initialization error.'
    if ([SingleInstanceWindow]::Find([uint32]$cancelled.Id, 'AioLM') -ne [IntPtr]::Zero) { throw 'New primary created its webview before initialization finished.' }
    [void][SingleInstanceWindow]::PostMessage($dialog, 0x0111, [IntPtr]2, [IntPtr]::Zero)
    Wait-For { $cancelled.HasExited } 'Cancelling initialization did not exit.'
    if ($cancelled.ExitCode -ne 0) { throw 'Cancelling initialization failed.' }
    [pscustomobject]@{ SecondaryExitCode=$secondary.ExitCode; ExistingWindowRestored=$true; SecondaryInitializationSkipped=$true; CancelledPrimaryExitCode=$cancelled.ExitCode } | ConvertTo-Json -Compress
} finally {
    [IO.File]::WriteAllText($configPath, '{"config_version":12,"close_to_tray":false}')
    foreach ($process in $processes) {
        if (!$process.HasExited) {
            $dialog = [SingleInstanceWindow]::Find([uint32]$process.Id, 'AioLM — Data migration')
            if ($dialog -ne [IntPtr]::Zero) {
                [void][SingleInstanceWindow]::PostMessage($dialog, 0x0111, [IntPtr]2, [IntPtr]::Zero)
            } else {
                $window = [SingleInstanceWindow]::Find([uint32]$process.Id, 'AioLM')
                if ($window -ne [IntPtr]::Zero) { [void][SingleInstanceWindow]::PostMessage($window, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) }
            }
            if (!$process.WaitForExit(4000)) { $process.Kill(); $process.WaitForExit() }
        }
        $process.Dispose()
    }
    if ($legacyLock) { $legacyLock.Dispose() }
}
