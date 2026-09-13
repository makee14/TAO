$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$watchdog = Join-Path $dir 'watchdog.ps1'
if (-not (Test-Path -LiteralPath $watchdog)) {
  Write-Error "watchdog.ps1 not found at $watchdog - aborting install."
  exit 1
}
schtasks /Create /TN "TAO-Orchestrator" `
  /TR "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$watchdog`"" `
  /SC ONLOGON /RL LIMITED /F
Write-Host "Installed (least privilege /RL LIMITED). TAO starts at logon. Test: schtasks /Run /TN TAO-Orchestrator"
