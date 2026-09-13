'use strict';
const os = require('node:os');
const MAX = 4096;
const { card, kv } = require('./ui');

function esc(s) { return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function clamp4096(text) {
  if (text.length <= MAX) return text;
  const head = 2400, tail = MAX - head - 60;
  return text.slice(0, head) + `\n\n… [${text.length - MAX} chars cut] …\n\n` + text.slice(-tail);
}

// clamp, then re-close an unbalanced <blockquote> so Telegram never rejects the message
function clampCard(text) {
  const out = clamp4096(text);
  const opens = (out.match(/<blockquote>/g) || []).length;
  const closes = (out.match(/<\/blockquote>/g) || []).length;
  return closes < opens ? out + '</blockquote>' : out;
}

const OP_ICON = { write: '➕', edit: '✏️' };
const fileLine = f => `${OP_ICON[f.op] ?? '🔧'} <code>${esc(f.path)}</code>`;

function fileRows(files, limit = 12) {
  const rows = files.slice(0, limit).map(fileLine);
  if (files.length > limit) rows.push(`…and ${files.length - limit} more`);
  return rows;
}

// Render a file-change list as a folder tree. Files in the workspace root come
// first with their full relative path; deeper files are grouped under a once-per
// folder header showing only the base name. Returns ready-to-embed HTML rows.
function fileTreeRows(files, limit = 12) {
  if (!Array.isArray(files) || !files.length) return [];
  const root = [];
  const buckets = new Map(); // folder -> [{ path, name, op }]
  for (const f of files) {
    const rel = String(f.path).replace(/\\/g, '/');
    const i = rel.lastIndexOf('/');
    if (i < 0) { root.push({ path: rel, name: rel, op: f.op }); continue; }
    const dir = rel.slice(0, i), name = rel.slice(i + 1);
    if (!buckets.has(dir)) buckets.set(dir, []);
    buckets.get(dir).push({ path: rel, name, op: f.op });
  }
  const flat = [...root];
  for (const dir of [...buckets.keys()].sort()) {
    const items = buckets.get(dir).sort((a, b) => a.name.localeCompare(b.name));
    for (const item of items) item.dir = dir;
    flat.push(...items);
  }
  const shown = flat.slice(0, limit);
  const rows = [];
  let curDir = null;
  for (const f of shown) {
    if (f.dir !== curDir) { curDir = f.dir; if (curDir) rows.push(`📁 ${esc(curDir)}`); }
    rows.push(`${OP_ICON[f.op] ?? '🔧'} <code>${esc(f.name)}</code>`);
  }
  if (flat.length > limit) rows.push(`…and ${flat.length - limit} more`);
  return rows;
}

function truncatePrompt(text, max = 100) {
  if (!text) return '';
  const str = String(text);
  if (str.length <= max) return str;
  return str.slice(0, max) + '...';
}

function fmtStarted(task, live = {}) {
  const rows = [`📁 <code>${esc(task.workspace)}</code>`];
  if (task.repo) rows.push(`📦 <b>${esc(task.repo.owner)}/${esc(task.repo.repo)}</b> · <code>${esc(task.repo.branch)}</code>`);
  const photoCount = task.photos?.length || (task.imagePath ? 1 : 0);
  if (photoCount > 0) rows.push(`📷 <b>${photoCount} photo${photoCount > 1 ? 's' : ''}</b>`);
  if (task.prompt) rows.push(`💬 ${esc(truncatePrompt(task.prompt, 100))}`);
  if (live.activity) rows.push(`⚡ ${esc(live.activity)}`);
  if (live.thinking) rows.push(`💭 ${esc(truncatePrompt(live.thinking, 200))}`);
  const elapsedStr = (live.elapsedSec !== undefined && live.elapsedSec !== null) ? ` (${live.elapsedSec}s)` : '';
  return card({
    icon: '🚀',
    title: `${esc(task.id)} · ${esc(task.name)}`,
    meta: `running…${elapsedStr}`,
    rows,
    footer: '<i>Reply to this message to cancel or send a follow-up.</i>',
  });
}

function fmtFiles(task, files) {
  return clampCard(card({
    icon: '📝',
    title: `${esc(task.id)} · file changes`,
    meta: `${files.length} changed file(s)`,
    rows: fileTreeRows(files),
    footer: '<i>Full list & downloads are on the task card when it finishes.</i>',
  }));
}

function fmtDone(task, { exitCode, durationSec, error }) {
  const ok = exitCode === 0;
  const dur = durationSec ? `${Math.round(durationSec)}s` : '?';
  const changed = task.fileChanges ?? [];
  const rows = [kv('📁', esc(task.workspace))];
  if (task.repo) rows.push(`📦 <b>${esc(task.repo.owner)}/${esc(task.repo.repo)}</b> · <code>${esc(task.repo.branch)}</code>`);
  const photoCount = task.photos?.length || (task.imagePath ? 1 : 0);
  if (photoCount > 0) rows.push(`📷 <b>${photoCount} photo${photoCount > 1 ? 's' : ''}</b>`);
  if (error) rows.push('', `⚠️ <b>${esc(error)}</b>`);
  const tree = fileTreeRows(changed);
  rows.push('');
  rows.push(tree.length
    ? `📄 <b>${changed.length} file${changed.length === 1 ? '' : 's'} changed</b>`
    : '📄 <i>(no file changes recorded)</i>');
  rows.push(...tree);
  if (task.publishState === 'pending') rows.push('', '🚀 <i>Awaiting publish confirmation — review the files above, then tap ✅ Publish.</i>');
  else if (task.publishState === 'published' && task.commitUrl) rows.push('', `🔗 <a href="${esc(task.commitUrl)}">view commit on GitHub</a>`);
  else if (task.publishState === 'skipped') rows.push('', '⏭️ <i>Publish skipped — the workspace stays local.</i>');
  else if (task.publishState === 'error') rows.push('', `⚠️ <i>Publish failed: ${esc(task.publishError ?? 'unknown')}. Tap ✅ Publish to retry.</i>`);
  rows.push('', `💬 ${esc(task.summary) || '<i>(no summary from agent)</i>'}`);
  return clampCard(card({
    icon: ok ? '✅' : '❌',
    title: `${esc(task.id)} · ${esc(task.name)}`,
    meta: ok ? `finished in ${dur}` : `FAILED after ${dur}`,
    rows,
    footer: '<i>Reply to this message to send a follow-up.</i>',
  }));
}

function fmtStatus(stats, runningTasks, queuedTasks = [], lastTexts = new Map()) {
  const runRows = runningTasks.map(t =>
    `🏃 <b>${esc(t.id)}</b> ${esc(t.name)}${lastTexts.get(t.id) ? `\n   …${esc(lastTexts.get(t.id).slice(-120))}` : ''}`);
  const queueRows = queuedTasks.map(t => `⏳ <b>${esc(t.id)}</b> ${esc(t.name)}`);
  const rows = [...runRows, ...queueRows];
  const pause =
    stats.pauseReason === 'breaker' ? ` · 🛑 circuit open (${stats.failStreak ?? '?'} fails · auto-retry)`
    : stats.pauseReason === 'manual' ? ' · ⏸ PAUSED (manual)' : stats.paused ? ' · ⏸ PAUSED' : '';
  return clampCard(card({
    icon: '📊',
    title: 'Queue',
    meta: `running ${stats.running} · queued ${stats.queued} · blocked ${stats.blocked}${pause}`,
    rows: rows.length ? rows : ['(nothing running)'],
  }));
}

function fmtList(tasks) {
  const ICON = { queued: '⏳', running: '🏃', done: '✅', failed: '❌', cancelled: '🚫', blocked: '🔒' };
  const rows = tasks.slice(-15).reverse().map(t =>
    `${ICON[t.state] ?? '•'} <b>${esc(t.id)}</b> ${esc(t.name)} <i>(${esc(t.state)})</i>`);
  return clampCard(card({ icon: '📋', title: 'Tasks', rows: rows.length ? rows : ['(no tasks yet)'] }));
}

function fmtPendingPublishes(pending) {
  return card({
    icon: '⏳',
    title: `${pending.length} task(s) awaiting publish`,
    rows: pending.map(t => `• <b>${esc(t.id)}</b> ${esc(t.name)} — 🚀 publish pending`),
    footer: '<i>Review the files on the done card, then tap 🚀 Publish.</i>',
  });
}

function fmtHelp() {
  return card({
    icon: '🤖',
    title: 'TAO Commands',
    rows: [
      '<b>Tasks &amp; Coding</b>',
      '🆕 /newtask — Guided task composer',
      '⚡ /do &lt;prompt&gt; — Quick task in active workspace',
      '📊 /status — Live progress and agent tail',
      '📋 /list — Recent tasks and execution states',
      '📁 /file &lt;id&gt; — Browse &amp; download a task’s changed files',
      '',
      '<b>Queue &amp; Control</b>',
      '▶️ /resume — Resume task queue',
      '💬 Buttons — Pause, Cancel, Retry, Diff and Publish live on the status/task cards',
      '',
      '<b>Engine &amp; AI — tap ⚙️ Settings</b>',
      '⚙️ /settings — mode, thinking, provider, model, workspace, OmniRoute, GitHub, Gemini keys, skills, hook',
      '✨ /model [name] — View or switch model',
      '🔌 /provider [name] — View or switch provider',
      '',
      '<b>System &amp; Safety</b>',
      '🩺 /health — PC health, disk and queue status',
      '🧹 /purge — Clean up old task logs',
      '🔌 /shutdown — Safe PC shutdown with agent drain',
      '🚨 /panic — Emergency stop: kill all agents &amp; pause the queue',
    ],
    footer: '<i>Tip: reply to a done message to continue that task.</i>',
  });
}

function fmtFileBrowser(task, files = [], page = 1, totalPages = 1) {
  const pageSize = 6;
  const pageFiles = files.slice((page - 1) * pageSize, page * pageSize);
  const rows = pageFiles.length ? fileTreeRows(pageFiles) : ['(no files changed in this task)'];
  const meta = totalPages > 1 ? `page ${page}/${totalPages} · ${files.length} changed file(s)` : `${files.length} changed file(s)`;
  return clampCard(card({
    icon: '📁',
    title: `${esc(task.id)} Files`,
    meta,
    rows: [
      kv('📁 Workspace', esc(task.workspace)),
      ...(task.repo ? [kv('📦 Repo', `${esc(task.repo.owner)}/${esc(task.repo.repo)}`)] : []),
      '',
      ...rows,
    ],
    footer: '<i>Tap a file button below to download directly to Telegram.</i>',
  }));
}

function fmtWelcome() {
  return card({
    icon: '👋',
    title: 'Welcome to TAO',
    meta: `host ${esc(os.hostname())}`,
    rows: [
      '📁 Agents run in your allowed workspaces — up to 3 in parallel, one per workspace',
      '⚡ Tap <b>New task</b> to start, or <b>Full help</b> for every command',
    ],
    footer: '<i>Tip: reply to a done task message to send a follow-up.</i>',
  });
}

function fmtTaskCard(task) {
  const dur = task.startedAt && task.finishedAt
    ? Math.round((Date.parse(task.finishedAt) - Date.parse(task.startedAt)) / 1000) : null;
  if (['running', 'queued', 'blocked', 'started'].includes(task.state)) return fmtStarted(task);
  return fmtDone(task, { exitCode: task.exitCode ?? 1, durationSec: dur, error: task.error });
}

function fmtOmniroute(sys = {}) {
  const isRunning = sys.running ?? true;
  const statusStr = isRunning ? '🟢 Running' : '🔴 Stopped';
  const rows = [
    kv('🌐 Status', statusStr),
  ];
  if (isRunning) {
    rows.push(kv('🔌 Provider', 'openai-compatible'));
    rows.push('⚡ Tap <b>✅ Use as provider</b> to route NEW tasks through OmniRoute.');
  }
  return card({
    icon: '🌐',
    title: 'OmniRoute Hub',
    meta: 'AI proxy & model router',
    rows,
    footer: isRunning ? '<i>Tap 🌐 OmniRoute in Settings (or the Provider picker) to start it again after a reboot.</i>'
                      : '<i>Tap ▶️ Start OmniRoute to launch the local proxy.</i>',
  });
}

module.exports = {
  clamp4096, clampCard, esc, truncatePrompt, fmtStarted, fmtFiles, fileTreeRows, fmtDone,
  fmtStatus, fmtList, fmtHelp, fmtWelcome, fmtTaskCard, fmtPendingPublishes,
  fmtFileBrowser, fmtOmniroute,
};
