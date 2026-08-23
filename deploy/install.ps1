# Orion AI — one-shot client installer (Windows).
# A client runs ONE line in PowerShell and gets the stack set up:
#
#   irm https://raw.githubusercontent.com/<you>/<repo>/main/deploy/install.ps1 | iex
#
# It clones the deployment repo, installs deps, seeds a .env from the template,
# and prints exactly what the client still needs to fill in. It never assumes
# secrets and never starts anything destructive.
param(
  [string]$Repo = $env:ORION_DEPLOY_REPO,      # e.g. https://github.com/you/client-acme.git
  [string]$Dir  = "$env:USERPROFILE\orion-ai"
)
$ErrorActionPreference = "Stop"
Write-Host "== Orion AI installer ==" -ForegroundColor Cyan

if (-not $Repo) { Write-Error "Set -Repo (or `$env:ORION_DEPLOY_REPO) to the client deployment repo URL."; exit 1 }
foreach ($tool in @("git","node")) {
  if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { Write-Error "$tool is required but not installed. Install it first (git-scm.com / nodejs.org), then re-run."; exit 1 }
}

if (Test-Path $Dir) { Write-Host "Updating existing install at $Dir"; git -C $Dir pull --ff-only }
else { Write-Host "Cloning into $Dir"; git clone --depth 1 $Repo $Dir }

Set-Location $Dir
if (Test-Path "package.json") { Write-Host "Installing dependencies..."; npm ci --no-audit --no-fund }

if ((Test-Path ".env.example") -and -not (Test-Path ".env")) {
  Copy-Item ".env.example" ".env"
  Write-Host "Seeded .env from .env.example" -ForegroundColor Yellow
}

# Report what still needs a value, without printing any secret.
if (Test-Path ".env") {
  $missing = Select-String -Path ".env" -Pattern "^\s*([A-Z0-9_]+)=\s*$" | ForEach-Object { $_.Matches[0].Groups[1].Value }
  if ($missing) { Write-Host "`nFill these in .env before starting:" -ForegroundColor Yellow; $missing | ForEach-Object { Write-Host "  - $_" } }
}

Write-Host "`nInstalled. Launching setup..." -ForegroundColor Green
if (Test-Path "deploy\orion-setup.mjs") { node deploy\orion-setup.mjs }
else {
  Write-Host "Next:"
  Write-Host "  1. Edit $Dir\.env with the keys above"
  Write-Host "  2. Run:  npm start   (or the command in the repo README)"
}
