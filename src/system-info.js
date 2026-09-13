'use strict';
const { execFile } = require('node:child_process');
const os = require('node:os');
const { esc } = require('./formatter');
const { card, kv } = require('./ui');

const exec = (cmd, args) => new Promise((res, rej) =>
  execFile(cmd, args, { windowsHide: true }, (e, out) => e ? rej(e) : res(out.trim())));

// The drive letter is interpolated into a powershell -Command string. Only a
// single ASCII drive letter (optionally with ':' or a trailing slash) may ever
// reach that string — anything else is rejected outright so a caller-supplied
// drive can never inject PowerShell.
function sanitizeDrive(drive) {
  const s = String(drive ?? '').trim().replace(/[:/]+$/, '');
  if (!/^[A-Za-z]$/.test(s)) throw new Error(`invalid drive letter: ${drive}`);
  return `${s.toUpperCase()}:`;
}

async function diskFree(drive = 'C:', execImpl = exec) {
  const out = await execImpl('powershell', ['-NoProfile', '-Command',
    `(Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='${sanitizeDrive(drive)}'").FreeSpace`]);
  return Number(out);
}

function bootMessage({ running, queued }) {
  return card({
    icon: '✅',
    title: 'TAO online',
    meta: `node ${process.version} · host ${esc(os.hostname())}`,
    rows: [kv('📊', `running: ${running} · queued: ${queued}`)],
    footer: '<i>(If you didn\'t just start this yourself, the PC likely rebooted — Windows Update?)</i>',
  });
}

module.exports = { diskFree, sanitizeDrive, bootMessage };
