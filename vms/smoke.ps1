[CmdletBinding()]
param([string]$InstallDir = (Get-Location).Path)
$ErrorActionPreference = 'Stop'
$InstallDir = (Resolve-Path $InstallDir).Path
$Port = if ($env:VMTEST_PORT) { $env:VMTEST_PORT } else { $listener=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0); $listener.Start(); $p=$listener.LocalEndpoint.Port; $listener.Stop(); $p }
$TempHome = Join-Path ([IO.Path]::GetTempPath()) ("aperio-vms-home-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $TempHome | Out-Null
$Server = $null
$StdoutLog = Join-Path $InstallDir '.sqlite/vms-server.out.log'
$StderrLog = Join-Path $InstallDir '.sqlite/vms-server.err.log'
function Show-ServerLogs {
  foreach ($path in @($StdoutLog, $StderrLog)) {
    if (Test-Path $path) { Get-Content $path -ErrorAction SilentlyContinue | Write-Host }
  }
}
try {
  Set-Location $InstallDir
  # Windows PowerShell 5 strips nested quotes when this script is launched
  # through `powershell.exe -File`, so keep the Node expression quote-free.
  $major = [int](node -p 'process.versions.node.match(/^\d+/)[0]')
  if ($major -lt 22) { throw "Node.js 22+ required (found $major)" }
  if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { throw 'npm is not available' }
  Write-Host "+ toolchain: Node $(node --version), npm $(npm --version)"
  if (-not (Test-Path node_modules)) { throw 'node_modules is missing' }
  foreach ($module in @('better-sqlite3','sqlite-vec','sharp')) {
    node --input-type=module -e "await import('$module')"
    if ($LASTEXITCODE -ne 0) { throw "native module failed to load: $module" }
    Write-Host "+ native module: $module"
  }
  $env:HOME=$TempHome; $env:USERPROFILE=$TempHome; $env:DB_BACKEND='sqlite'
  $env:SQLITE_PATH='.sqlite/vms.db'; $env:EMBEDDING_PROVIDER='transformers'; $env:APERIO_LITE='on'; $env:APERIO_CONFIG_PRECEDENCE='env'
  npm run migrate:sqlite | Out-Null
  if (-not (Test-Path '.sqlite/vms.db')) { throw 'migration did not create .sqlite/vms.db' }
  Write-Host '+ SQLite migrations'
  $env:PORT=$Port; $env:HOST='127.0.0.1'
  $Server = Start-Process node -ArgumentList 'server.js' -RedirectStandardOutput $StdoutLog -RedirectStandardError $StderrLog -PassThru
  $ready=$false
  for ($i=0; $i -lt 90; $i++) {
    if ($Server.HasExited) { Show-ServerLogs; throw 'server exited before answering' }
    try { $state=Invoke-RestMethod "http://127.0.0.1:$Port/api/bootstrap/state" -TimeoutSec 2; $ready=$true; break } catch { Start-Sleep -Seconds 1 }
  }
  if (-not $ready) { Show-ServerLogs; throw 'no bootstrap response within 90 seconds' }
  Write-Host '+ HTTP bootstrap state'
  $html=Invoke-WebRequest "http://127.0.0.1:$Port/setup.html" -UseBasicParsing
  if ($html.Content -notmatch '<html' -or $html.Content -notmatch 'setup') { throw 'setup.html lacks expected UI markers' }
  Write-Host '+ UI shell: /setup.html'
  if (Test-Path (Join-Path $TempHome 'sqlite')) { throw 'runtime wrote outside install directory' }
  Write-Host '+ runtime hygiene'
} finally {
  if ($Server -and -not $Server.HasExited) { Stop-Process $Server.Id -Force -ErrorAction SilentlyContinue }
  Remove-Item $TempHome -Recurse -Force -ErrorAction SilentlyContinue
}
