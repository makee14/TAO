# Guard: no user-facing line may contain two or more slash commands.
$commands = 'newtask','do','status','list','resume','file','files','skip','model','provider','mode','settings','health','purge','shutdown','panic','abortshutdown','help','start','clearchat'
$root = Join-Path $PSScriptRoot '..'
$paths = @((Join-Path $root 'src'), (Join-Path $root 'GUIDE.md'), (Join-Path $root 'README.md'))
$bad = @()
foreach ($p in $paths) {
  $files = if (Test-Path $p -PathType Container) { Get-ChildItem $p -Filter *.js } else { Get-Item $p }
  foreach ($f in $files) {
    $i = 0
    foreach ($line in Get-Content $f.FullName) {
      $i++
      if ($line -match '[a-zA-Z]+://' -or $line -match '^[a-zA-Z]:[\\/]' -or $line -match '\.git[\\/]') { continue }
      $found = @()
      foreach ($cmd in $commands) { if ($line -match '/' + [regex]::Escape($cmd) + '\b') { $found += $cmd } }
      if ($found.Count -ge 2) { $bad += "$($f.Name):$i [$($found -join ', ')] $line" }
    }
  }
}
if ($bad.Count) { Write-Host 'VIOLATIONS:'; $bad | ForEach-Object { Write-Host $_ }; exit 1 }
Write-Host 'OK: no line contains two or more slash commands.'
