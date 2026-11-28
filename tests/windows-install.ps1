$ErrorActionPreference = 'Stop'
$version = (Get-Content package.json -Raw | ConvertFrom-Json).version
$installer = Join-Path $PWD "release/windows/Omarkie-$version-windows-x64-Setup.exe"
$destination = Join-Path $env:RUNNER_TEMP 'OmarkieInstalled'
$env:OMARKIE_QA_DIR = Join-Path $env:RUNNER_TEMP 'omarkie-windows-qa'
New-Item -ItemType Directory -Force $env:OMARKIE_QA_DIR | Out-Null
$process = Start-Process -FilePath $installer -ArgumentList @('/S', "/D=$destination") -Wait -PassThru
if ($process.ExitCode -ne 0) { throw "Installer failed: $($process.ExitCode)" }
$env:OMARKIE_EXECUTABLE = Join-Path $destination 'Omarkie.exe'
if (!(Test-Path $env:OMARKIE_EXECUTABLE)) { throw 'Installer did not produce the application executable' }
# Each test runs with its own app debug log (startup steps, Glass, saves, dirty flips, main/renderer stalls).
# The log prints after every test: open on failure, folded on success so green runs still show Windows timings.
# Output goes to Out-Host/Write-Host so the function's return value is only the exit code.
function Invoke-AppTest([string]$name, [string]$script) {
  $log = Join-Path $env:OMARKIE_QA_DIR "$name-app.log"
  $env:OMARKIE_DEBUG_LOG = $log
  node $script | Out-Host
  $exit = $LASTEXITCODE
  Remove-Item Env:OMARKIE_DEBUG_LOG
  if (Test-Path $log) {
    if ($exit -ne 0) { Write-Host "$name failed; app debug log:" } else { Write-Host "::group::$name app debug log" }
    Get-Content $log -Encoding UTF8 | Out-Host
    if ($exit -eq 0) { Write-Host '::endgroup::' }
  }
  return $exit
}
$desktopExit = Invoke-AppTest 'desktop' 'tests/desktop.mjs'
$shellExit = Invoke-AppTest 'shell' 'tests/electron-shell.mjs'
$parityExit = Invoke-AppTest 'parity' 'tests/parity-desktop.mjs'
$compatibilityExit = Invoke-AppTest 'compatibility' 'tests/compatibility-desktop.mjs'
$imeExit = Invoke-AppTest 'ime' 'tests/ime-desktop.mjs'
$packageExit = Invoke-AppTest 'plugin-package' 'tests/plugin-package-desktop.mjs'
if ($packageExit -ne 0) { throw 'Installed plugin package regression failed' }
if ($imeExit -ne 0) { throw 'Installed composition and plugin regression failed' }
if ($desktopExit -ne 0) { throw 'Installed desktop regression failed' }
if ($shellExit -ne 0) { throw 'Windows shell and plugin regression failed' }
if ($compatibilityExit -ne 0) { throw 'Installed image and office-format regression failed' }
if ($parityExit -ne 0) { throw 'Installed editing parity regression failed' }
$extension = Get-ItemPropertyValue 'HKCU:\Software\Classes\.md' '(default)'
$command = Get-ItemPropertyValue "HKCU:\Software\Classes\$extension\shell\open\command" '(default)'
if (!$command.Contains($env:OMARKIE_EXECUTABLE) -or !$command.Contains('%1')) { throw "Invalid Markdown file association: $command" }
$retained = (Get-Content (Join-Path $env:OMARKIE_QA_DIR 'desktop-results.json') -Raw | ConvertFrom-Json).dataDir
$sessionFile = Join-Path $retained 'session.json'
$sessionHash = (Get-FileHash $sessionFile -Algorithm SHA256).Hash
$uninstaller = Join-Path $destination 'Uninstall Omarkie.exe'
Start-Process -FilePath $uninstaller -ArgumentList '/S' -Wait | Out-Null
for ($attempt = 0; $attempt -lt 60 -and (Test-Path $env:OMARKIE_EXECUTABLE); $attempt++) { Start-Sleep -Milliseconds 500 }
if (Test-Path $env:OMARKIE_EXECUTABLE) { throw 'Uninstaller left the application executable behind' }
if ((Get-FileHash $sessionFile -Algorithm SHA256).Hash -ne $sessionHash) { throw 'Uninstall changed document recovery data' }
@{ install = 'passed'; installedRegression = 'passed'; fileAssociation = 'passed'; uninstall = 'passed'; recoveryPreserved = $true } | ConvertTo-Json | Set-Content (Join-Path $env:OMARKIE_QA_DIR 'installer-results.json')
Write-Output 'PASS: NSIS install, installed application tests, Markdown association and uninstall with retained recovery data'
