[CmdletBinding()]
param(
    [string]$Release = $(if ($null -ne $env:AIOLM_RELEASE) { $env:AIOLM_RELEASE } elseif ($null -ne $env:LLAMA_BOARD_RELEASE) { $env:LLAMA_BOARD_RELEASE } else { "latest" }),
    [ValidateSet("nsis", "msi")]
    [string]$Installer = $(if ($null -ne $env:AIOLM_INSTALLER) { $env:AIOLM_INSTALLER } elseif ($null -ne $env:LLAMA_BOARD_INSTALLER) { $env:LLAMA_BOARD_INSTALLER } else { "nsis" }),
    [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$Repository = "joowon-jang/AioLM"
$ApiHeaders = @{
    Accept = "application/vnd.github+json"
    "User-Agent" = "aiolm-installer"
}

if ($Release -ne "latest" -and $Release -notmatch "^[A-Za-z0-9._-]+$") {
    throw "Invalid release value: $Release"
}

$dryRunSetting = if ($null -ne $env:AIOLM_DRY_RUN) { $env:AIOLM_DRY_RUN } else { $env:LLAMA_BOARD_DRY_RUN }
if (-not $DryRun -and $dryRunSetting -match "^(?i:1|true|yes)$") {
    $DryRun = $true
}

$releaseUri = if ($Release -eq "latest") {
    "https://api.github.com/repos/$Repository/releases/latest"
} else {
    "https://api.github.com/repos/$Repository/releases/tags/$Release"
}

Write-Host "==> Resolving AioLM release ($Release)"
$releaseMetadata = Invoke-RestMethod -UseBasicParsing -Uri $releaseUri -Headers $ApiHeaders

$assetPattern = if ($Installer -eq "msi") {
    "AioLM_*_x64_en-US.msi"
} else {
    "AioLM_*_x64-setup.exe"
}
$asset = @($releaseMetadata.assets | Where-Object { $_.name -like $assetPattern }) | Select-Object -First 1
if ($null -eq $asset) {
    throw "Could not find installer asset matching '$assetPattern' in release '$($releaseMetadata.tag_name)'."
}

$downloadUri = [Uri]$asset.browser_download_url
if ($downloadUri.Scheme -ne "https" -or ($downloadUri.Host -ne "github.com" -and $downloadUri.Host -notlike "*.githubusercontent.com")) {
    throw "Release asset URL is not a trusted HTTPS GitHub URL: $($asset.browser_download_url)"
}

$expectedDigest = $null
if ($asset.PSObject.Properties['digest'] -and -not [string]::IsNullOrWhiteSpace($asset.digest)) {
    $digestMatch = [regex]::Match([string]$asset.digest, "^sha256:([0-9a-fA-F]{64})$")
    if ($digestMatch.Success) {
        $expectedDigest = $digestMatch.Groups[1].Value.ToLowerInvariant()
    }
}

if ([string]::IsNullOrWhiteSpace($expectedDigest)) {
    $checksumAsset = @($releaseMetadata.assets | Where-Object { $_.name -eq "checksums.txt" }) | Select-Object -First 1
    if ($null -ne $checksumAsset) {
        $checksumUri = [Uri]$checksumAsset.browser_download_url
        if ($checksumUri.Scheme -eq "https" -and ($checksumUri.Host -eq "github.com" -or $checksumUri.Host -like "*.githubusercontent.com")) {
            $checksumContent = (Invoke-WebRequest -UseBasicParsing -MaximumRedirection 5 -Uri $checksumUri).Content
            $checksumLines = $checksumContent -split "[\r\n]+"
            foreach ($line in $checksumLines) {
                $lineMatch = [regex]::Match($line.Trim(), "^([0-9a-fA-F]{64})\s+(.+)$")
                if ($lineMatch.Success -and $lineMatch.Groups[2].Value.Trim() -eq $asset.name) {
                    $expectedDigest = $lineMatch.Groups[1].Value.ToLowerInvariant()
                    break
                }
            }
        }
    }
}

if ([string]::IsNullOrWhiteSpace($expectedDigest)) {
    throw "Release asset '$($asset.name)' does not provide a SHA-256 digest and no matching hash was found in checksums.txt."
}

$tempDir = Join-Path ([IO.Path]::GetTempPath()) ("aiolm-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $tempDir | Out-Null
$installerPath = Join-Path $tempDir $asset.name

try {
    Write-Host "==> Downloading $($asset.name)"
    Invoke-WebRequest -UseBasicParsing -MaximumRedirection 5 -Uri $downloadUri -OutFile $installerPath

    $actualDigest = (Get-FileHash -LiteralPath $installerPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualDigest -ne $expectedDigest) {
        throw "Installer SHA-256 mismatch. Expected $expectedDigest but received $actualDigest."
    }
    Write-Host "==> SHA-256 verified: $actualDigest"
    Unblock-File -LiteralPath $installerPath

    if ($DryRun) {
        Write-Host "==> Dry run complete: $installerPath"
        return
    }

    if ($Installer -eq "msi") {
        $process = Start-Process -FilePath "msiexec.exe" -ArgumentList @("/i", $installerPath, "/qn", "/norestart") -Wait -PassThru
    } else {
        $process = Start-Process -FilePath $installerPath -ArgumentList @("/S") -Wait -PassThru
    }

    if ($process.ExitCode -ne 0) {
        throw "Installer exited with code $($process.ExitCode)."
    }
    Write-Host "AioLM installed successfully."
} finally {
    Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue
}
