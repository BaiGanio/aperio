[CmdletBinding()]
param([Parameter(Mandatory)][string]$Stage)
$ErrorActionPreference = 'Stop'
$Log = 'C:\aperio-vmtest.log'
Start-Transcript -Path $Log -Force | Out-Null
try {
  $InstallDir = Join-Path $env:TEMP 'aperio-vmtest-install'
  if (Test-Path $InstallDir) { Remove-Item $InstallDir -Recurse -Force }
  New-Item -ItemType Directory -Path $InstallDir | Out-Null
  Copy-Item (Join-Path $Stage '.github\lite\*') $InstallDir -Recurse -Force
  Copy-Item (Join-Path $Stage 'package.json'), (Join-Path $Stage 'package-lock.json'), (Join-Path $Stage 'server.js'), (Join-Path $Stage 'db'), (Join-Path $Stage 'lib'), (Join-Path $Stage 'public'), (Join-Path $Stage 'vms') $InstallDir -Recurse -Force
  Push-Location $InstallDir
  $Launcher = Start-Process -FilePath 'cmd.exe' -WorkingDirectory $InstallDir -ArgumentList @('/d', '/c', "`"$InstallDir\START.bat`"") -PassThru
  Start-Sleep -Seconds 3
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $InstallDir 'vms\smoke.ps1') $InstallDir
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally {
  if ($Launcher -and -not $Launcher.HasExited) {
    & taskkill.exe /PID $Launcher.Id /T /F 2>$null
  }
  Pop-Location
  Stop-Transcript | Out-Null
}
