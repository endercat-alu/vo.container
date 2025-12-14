param(
  [string]$UpstreamUrl = "https://github.com/violentmonkey/violentmonkey",
  [string]$UpstreamDir = "upstream",
  [string]$Ref = "v2.31.3"
)

$ErrorActionPreference = "Stop"

function Exec($cmd) {
  Write-Host "`n> $cmd" -ForegroundColor Cyan
  pwsh -NoProfile -Command $cmd
  if ($LASTEXITCODE -ne 0) { throw "Command failed ($LASTEXITCODE): $cmd" }
}

if (-not (Test-Path $UpstreamDir)) {
  Exec "git clone --depth 1 --branch $Ref $UpstreamUrl $UpstreamDir"
}

Exec "yarn --cwd $UpstreamDir"
Exec "node tools/patch_firefox_container_ast.mjs $UpstreamDir"
Exec "yarn --cwd $UpstreamDir build"

$dist = Join-Path $UpstreamDir "dist"
$zip = Join-Path $UpstreamDir "violentmonkey-firefox.zip"
if (Test-Path $zip) { Remove-Item -Force $zip }

Exec "Compress-Archive -Path $dist\* -DestinationPath $zip"

Write-Host "`nBuilt: $zip" -ForegroundColor Green
Write-Host "To debug in Firefox: open about:debugging -> This Firefox -> Load Temporary Add-on -> select $dist\manifest.json" -ForegroundColor Yellow
