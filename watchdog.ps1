$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$logFile = Join-Path $dir 'data\watchdog.log'
$restarts = 0
$restartWindowStart = Get-Date

function Write-Log($msg) {
  $line = "[{0:yyyy-MM-dd HH:mm:ss}] {1}" -f (Get-Date), $msg
  try {
    [System.IO.Directory]::CreateDirectory((Split-Path -Parent $logFile)) | Out-Null
    Add-Content -Path $logFile -Value $line -Encoding UTF8
  } catch { }
}

while ($true) {
  $procs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue
  # Match ONLY this project entry script inside THIS folder (impostor-proof).
  $tao = $procs | Where-Object {
    $_.CommandLine -and
    $_.CommandLine -match 'src[\/]index\.js' -and
    $_.CommandLine -match [regex]::Escape($dir)
  }
  if (-not $tao) {
    if ($restarts -eq 0) { $restartWindowStart = Get-Date }
    try {
      Start-Process -FilePath 'node' -ArgumentList "$dir\src\index.js" -WorkingDirectory $dir -WindowStyle Hidden
      $restarts++
      Write-Log "TAO not running - started (restart #$restarts)."
    } catch {
      Write-Log "Start failed: $($_.Exception.Message)"
    }
  } else {
    $restarts = 0   # healthy checkpoint resets the crash-loop counter
  }
  if ($restarts -ge 3 -and ((Get-Date) - $restartWindowStart).TotalMinutes -le 10) {
    Start-Sleep -Seconds 300   # crash loop: pause before hammering restarts
  } else {
    Start-Sleep -Seconds 30
  }
}
