'use strict';
// Gracefully close the owner's open desktop windows before a PC shutdown.
// PowerShell lists processes that own a visible window in the current console
// session; `taskkill /PID <pid>` (WITHOUT /F) sends a close request (WM_CLOSE)
// so apps can save and exit instead of blocking the shutdown dialog.

const DEFAULT_SKIP = new Set(['explorer.exe']);

function parseProcLines(stdout) {
  const out = [];
  for (const line of (stdout ?? '').split(/\r?\n/)) {
    const m = line.trim().match(/^(\d+)\s+(\S+)$/);
    if (m) out.push({ pid: Number(m[1]), name: m[2].toLowerCase() });
  }
  return out;
}

async function closeOpenWindows({ exec, skipNames = DEFAULT_SKIP, delayMs = 4000, selfPid = process.pid }) {
  const out = await exec('powershell', ['-NoProfile', '-Command',
    'Get-Process | Where-Object { $_.MainWindowTitle -ne "" } | ForEach-Object { "$($_.ProcessId) $($_.Name)" }']);
  const procs = parseProcLines(out);
  let closed = 0;
  for (const p of procs) {
    if (p.pid === selfPid || skipNames.has(p.name)) continue;
    try { await exec('taskkill', ['/PID', String(p.pid)]); closed++; } catch { /* already gone */ }
  }
  if (closed && delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
  return { closed };
}

module.exports = { parseProcLines, closeOpenWindows, DEFAULT_SKIP };
