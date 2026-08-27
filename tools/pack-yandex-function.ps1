# Pack Yandex Cloud Function ZIP (Windows)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$fn = Join-Path $root 'yandex-cloud\function'
$out = Join-Path $root 'yandex-cloud\da-function.zip'
if (-not (Test-Path (Join-Path $fn 'node_modules'))) {
  Push-Location $fn
  npm ci
  Pop-Location
}
if (Test-Path $out) { Remove-Item $out -Force }
$stage = Join-Path $env:TEMP ('da-yc-pack-' + [guid]::NewGuid().ToString('n'))
New-Item -ItemType Directory -Path $stage | Out-Null
Copy-Item (Join-Path $fn 'index.js') $stage
Copy-Item (Join-Path $fn 'package.json') $stage
Copy-Item (Join-Path $fn 'package-lock.json') $stage -ErrorAction SilentlyContinue
Copy-Item (Join-Path $fn 'lib') (Join-Path $stage 'lib') -Recurse
Copy-Item (Join-Path $fn 'node_modules') (Join-Path $stage 'node_modules') -Recurse
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $out -Force
Remove-Item $stage -Recurse -Force
Write-Host "ZIP: $out"
Get-Item $out | Select-Object FullName, Length
