[CmdletBinding()]
param(
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$RepositoryUrl = 'https://github.com/danielarif26/freerdc'
$InstallMarker = 'freerdc-source-installer-v1'
$FreeRdcRef = $env:FREERDC_REF

if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
    throw 'LOCALAPPDATA is not set; cannot choose a user-owned install location.'
}

$InstallRoot = if ($env:FREERDC_INSTALL_DIR) { $env:FREERDC_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'freerdc' }
$InstallRoot = [System.IO.Path]::GetFullPath($InstallRoot)
$LocalAppDataPath = [System.IO.Path]::GetFullPath($env:LOCALAPPDATA).TrimEnd('\')
if (-not $InstallRoot.StartsWith("$LocalAppDataPath\", [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing an install location outside LOCALAPPDATA: $InstallRoot"
}

$AppDir = Join-Path $InstallRoot 'app'
$MarkerFile = Join-Path $InstallRoot '.freerdc-install'
$Launcher = Join-Path $InstallRoot 'bin\freerdc-server.cmd'

function Normalize-RepositoryUrl([string]$Url) {
    return (($Url.Trim().TrimEnd('/') -replace '\.git$', '').ToLowerInvariant())
}

function Test-ManagedInstall {
    return (Test-Path -LiteralPath $MarkerFile -PathType Leaf) -and ((Get-Content -LiteralPath $MarkerFile -TotalCount 1) -eq $InstallMarker)
}

function Require-Command([string]$Name) {
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Required command not found: $Name"
    }
}

function Checkout-RequestedRef {
    & git -C $AppDir fetch --tags origin
    if ($LASTEXITCODE -ne 0) { throw 'Could not fetch the requested FreeRDC ref.' }
    [string]$RequestedCommit = (& git -C $AppDir rev-parse --verify "$FreeRdcRef^{commit}")
    if ($LASTEXITCODE -ne 0 -or -not $RequestedCommit) {
        throw "Requested FreeRDC ref is not a commit, tag, or reachable branch: $FreeRdcRef"
    }
    $RequestedCommit = $RequestedCommit.Trim()
    & git -C $AppDir checkout --detach $RequestedCommit
    if ($LASTEXITCODE -ne 0) { throw "Could not check out requested FreeRDC ref: $FreeRdcRef" }
}

if ($Uninstall) {
    if (-not (Test-Path -LiteralPath $InstallRoot)) {
        Write-Host "FreeRDC is not installed at $InstallRoot"
        exit 0
    }
    if (-not (Test-ManagedInstall)) {
        throw "Refusing to remove unmanaged directory: $InstallRoot"
    }
    if ((Get-Item -LiteralPath $InstallRoot).LinkType) {
        throw "Refusing to remove symlinked install location: $InstallRoot"
    }
    Remove-Item -LiteralPath $InstallRoot -Recurse -Force
    Write-Host "Removed FreeRDC from $InstallRoot"
    exit 0
}

Require-Command git
Require-Command node
Require-Command npm
if ([string]::IsNullOrWhiteSpace($FreeRdcRef)) {
    Write-Warning 'This source installer follows the mutable default repository branch. For higher assurance, set FREERDC_REF to a reviewed commit or tag.'
}
$NodeVersion = (& node -p 'process.versions.node')
if ($LASTEXITCODE -ne 0 -or $NodeVersion -notmatch '^(\d+)\.') {
    throw 'Could not determine the Node.js version.'
}
if ([int]$Matches[1] -lt 22) {
    throw "Node.js 22 or newer is required (found $NodeVersion)."
}

if (Test-Path -LiteralPath $InstallRoot) {
    if (-not (Test-Path -LiteralPath $InstallRoot -PathType Container)) {
        throw "Install location is not a directory: $InstallRoot"
    }
    if ((Get-Item -LiteralPath $InstallRoot).LinkType) {
        throw "Refusing to use symlinked install location: $InstallRoot"
    }
    if (-not (Test-ManagedInstall)) {
        throw "Refusing to update an unmanaged directory: $InstallRoot"
    }
    if (-not (Test-Path -LiteralPath $AppDir -PathType Container)) {
        throw "Install location is not a directory: $AppDir"
    }
    if ((Get-Item -LiteralPath $AppDir).LinkType) {
        throw "Refusing to use symlinked install location: $AppDir"
    }
    $TopLevel = (& git -C $AppDir rev-parse --show-toplevel 2>$null)
    if ($LASTEXITCODE -ne 0 -or -not $TopLevel -or -not ([System.IO.Path]::GetFullPath($TopLevel) -ieq $AppDir)) {
        throw "Install location already exists and is not the FreeRDC checkout root: $AppDir"
    }
    $Origin = (& git -C $AppDir remote get-url origin 2>$null)
    if ($LASTEXITCODE -ne 0 -or (Normalize-RepositoryUrl $Origin) -ne (Normalize-RepositoryUrl $RepositoryUrl)) {
        throw "Refusing to update checkout with unexpected origin: $Origin"
    }
    $Status = (& git -C $AppDir status --porcelain)
    if ($LASTEXITCODE -ne 0 -or $Status) {
        throw 'Checkout has local changes; update it manually before rerunning.'
    }
    if ([string]::IsNullOrWhiteSpace($FreeRdcRef)) {
        Write-Host 'Updating FreeRDC source checkout...'
        & git -C $AppDir pull --ff-only
        if ($LASTEXITCODE -ne 0) { throw 'Could not fast-forward the FreeRDC checkout.' }
    } else {
        Write-Host "Updating FreeRDC source checkout to $FreeRdcRef..."
        Checkout-RequestedRef
    }
} else {
    New-Item -ItemType Directory -Path (Split-Path -Parent $InstallRoot) -Force | Out-Null
    New-Item -ItemType Directory -Path $InstallRoot | Out-Null
    $FreshInstallRootCreated = $true
    try {
        Write-Host 'Cloning FreeRDC source checkout...'
        & git clone $RepositoryUrl $AppDir
        if ($LASTEXITCODE -ne 0) { throw 'Could not clone the FreeRDC checkout.' }
        if (-not [string]::IsNullOrWhiteSpace($FreeRdcRef)) {
            Checkout-RequestedRef
        }
    } catch {
        $CloneError = $_
        try {
            if (
                $FreshInstallRootCreated -and
                (Test-Path -LiteralPath $InstallRoot -PathType Container) -and
                -not (Get-Item -LiteralPath $InstallRoot).LinkType -and
                -not (Test-Path -LiteralPath $MarkerFile)
            ) {
                Remove-Item -LiteralPath $InstallRoot -Recurse -Force
            }
        } catch {
            Write-Warning "Could not clean failed install at ${InstallRoot}: $($_.Exception.Message)"
        }
        throw $CloneError
    }
    Set-Content -LiteralPath $MarkerFile -Value $InstallMarker -Encoding ascii -NoNewline
}

Write-Host 'Installing locked dependencies and building FreeRDC...'
Push-Location $AppDir
try {
    & npm ci
    if ($LASTEXITCODE -ne 0) { throw 'npm ci failed.' }
    & npm run build
    if ($LASTEXITCODE -ne 0) { throw 'npm run build failed.' }
} finally {
    Pop-Location
}

New-Item -ItemType Directory -Path (Split-Path -Parent $Launcher) -Force | Out-Null
if ((Test-Path -LiteralPath $Launcher) -and -not (Select-String -LiteralPath $Launcher -SimpleMatch -Quiet 'REM freerdc-source-installer-v1')) {
    throw "Refusing to overwrite an unmanaged launcher: $Launcher"
}
@"
@echo off
REM freerdc-source-installer-v1
node "%~dp0..\app\packages\server\dist\src\cli.js" %*
"@ | Set-Content -LiteralPath $Launcher -Encoding ascii -NoNewline

Write-Host "FreeRDC is ready. Run: `"$Launcher`" --root C:\absolute\allowed\root"
Write-Host "Add `"$(Split-Path -Parent $Launcher)`" to your user PATH to run freerdc-server by name."
Write-Host "To uninstall this managed install: .\install.ps1 -Uninstall"
