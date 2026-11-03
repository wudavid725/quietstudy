# Opens Shy Safari in a browser profile kept next to this script. Classroom computers
# wipe everything on restart except one drive, so the profile (extension, sign-in,
# Shy Safari's own data) lives there. Before opening, the latest extension is fetched
# from GitHub; when that fails (offline, blocked), the copy already here is used.
param(
  [string]$Source = 'https://github.com/wudavid725/quietstudy/archive/refs/heads/main.zip',
  # Extra browser flags, only needed for testing.
  [string[]]$BrowserArgs = @()
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$extensionDir = Join-Path $root 'extension'
$profileDir = Join-Path $root 'profile'
$startUrl = 'https://www.shysafari.com/'

function Find-Browser {
  # Chrome first: syncing uses the Chrome account.
  @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
  ) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
}

function Get-ReleaseVersion($dir) {
  $file = Join-Path $dir 'release.json'
  if (Test-Path $file) { (Get-Content $file -Raw -Encoding UTF8 | ConvertFrom-Json).version }
}

function Update-Extension {
  $temp = Join-Path ([IO.Path]::GetTempPath()) ('shysafari-' + [guid]::NewGuid())
  New-Item -ItemType Directory $temp | Out-Null
  try {
    $zip = Join-Path $temp 'source.zip'
    if ($Source -match '^https?://') {
      [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
      Invoke-WebRequest $Source -OutFile $zip -UseBasicParsing -TimeoutSec 20
    } else {
      Copy-Item $Source $zip
    }
    Expand-Archive $zip (Join-Path $temp 'source')
    $new = Get-ChildItem (Join-Path $temp 'source') -Directory |
      ForEach-Object { Join-Path $_.FullName 'extension' } |
      Where-Object { Test-Path (Join-Path $_ 'release.json') } |
      Select-Object -First 1
    if (-not $new) { throw '下載的檔案裡找不到擴充功能' }
    $newVersion = Get-ReleaseVersion $new
    if ($newVersion -eq (Get-ReleaseVersion $extensionDir)) { return "擴充功能已是最新版 $newVersion" }
    New-Item -ItemType Directory -Force $extensionDir | Out-Null
    # release.json goes last, so an already running extension never sees a release before its files.
    Get-ChildItem $new -File | Where-Object Name -ne 'release.json' | Copy-Item -Destination $extensionDir -Force
    Copy-Item (Join-Path $new 'release.json') $extensionDir -Force
    return "擴充功能已更新到 $newVersion"
  } finally {
    Remove-Item $temp -Recurse -Force -ErrorAction SilentlyContinue
  }
}

try {
  Write-Host (Update-Extension)
} catch {
  Write-Host "這次沒有更新擴充功能（$($_.Exception.Message)），使用目前的版本。"
}

$browser = Find-Browser
if (-not $browser) {
  Write-Host '這台電腦找不到 Chrome 或 Edge。'
  Read-Host '按 Enter 關閉'
  exit 1
}

$arguments = @("--user-data-dir=`"$profileDir`"", '--no-first-run', '--no-default-browser-check')
if (Test-Path (Join-Path $extensionDir 'manifest.json')) {
  # Newer Chrome ignores --load-extension; there the one-time manual load kept in the profile takes over.
  $arguments += "--load-extension=`"$extensionDir`""
  $arguments += '--disable-features=DisableLoadExtensionCommandLineSwitch'
}
$arguments += $BrowserArgs
$arguments += $startUrl
Start-Process $browser -ArgumentList $arguments
