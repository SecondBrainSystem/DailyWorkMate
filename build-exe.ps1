$ErrorActionPreference = 'Stop'

Set-Location -LiteralPath $PSScriptRoot

Write-Host '=== DailyWorkMate Windows EXE Builder ===' -ForegroundColor Cyan

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw 'Node.js was not found. Install Node.js 20 or newer and run this script again.'
}

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  throw 'npm was not found. Reinstall Node.js with npm enabled.'
}

if (-not (Test-Path -LiteralPath 'node_modules')) {
  Write-Host 'Installing locked dependencies...' -ForegroundColor Yellow
  npm ci
  if ($LASTEXITCODE -ne 0) { throw "npm ci failed with exit code $LASTEXITCODE" }
}

Write-Host 'Building application bundles...' -ForegroundColor Yellow
npm run build
if ($LASTEXITCODE -ne 0) { throw "Application build failed with exit code $LASTEXITCODE" }

Write-Host 'Building installer EXE...' -ForegroundColor Yellow
npx --no-install electron-builder --win nsis --x64
if ($LASTEXITCODE -ne 0) { throw "Installer build failed with exit code $LASTEXITCODE" }

Write-Host 'Building portable EXE...' -ForegroundColor Yellow
npx --no-install electron-builder --win portable --x64
if ($LASTEXITCODE -ne 0) { throw "Portable build failed with exit code $LASTEXITCODE" }

$artifacts = Get-ChildItem -LiteralPath 'dist' -Filter '*.exe' -File -ErrorAction SilentlyContinue
if (-not $artifacts) {
  throw 'Build finished but no EXE was found in the dist directory.'
}

Write-Host ''
Write-Host 'Build complete:' -ForegroundColor Green
$artifacts | ForEach-Object { Write-Host "  $($_.FullName)" }
