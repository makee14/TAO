'use strict';
// TAO Telegram UI kit: card-layout primitives and inline-keyboard builders.
// Convention: every function here takes ALREADY-ESCAPED HTML strings —
// callers must run formatter.esc() on raw data (paths, names, ids) first.

// Card = bold header + optional italic meta + blockquote body (Telegram renders
// blockquotes with an accent bar + tinted background = the "card" look)
// + optional italic footer. Returns an HTML-safe string.
function card({ icon = '📄', title, meta = '', rows = [], footer = '' }) {
  const out = [];
  if (title) out.push(`${icon} <b>${title}</b>`);
  if (meta) out.push(`<i>${meta}</i>`);
  if (rows.length) out.push(`<blockquote>${rows.join('\n')}</blockquote>`);
  if (footer) out.push(footer);
  return out.join('\n');
}

// "label value" row for card bodies (value must already be escaped/formatted)
function kv(label, value) {
  return `${label} <code>${value}</code>`;
}

function btn(text, callback_data) { return { text, callback_data }; }

// Even, non-overlapping buttons: split a list into rows of at most maxPerRow
// buttons. Telegram renders rows with equal-width buttons, but rows wider
// than 2 buttons with long labels look cramped and wrap awkwardly on phones.
function wrapBtn(buttons, maxPerRow = 2) {
  const rows = [];
  for (let i = 0; i < buttons.length; i += maxPerRow) rows.push(buttons.slice(i, i + maxPerRow));
  return rows;
}

// Keyboard for the publish-confirmation gate on a done card.
function publishKeyboard(task) {
  return [[btn('✅ Publish', `pub:confirm:${task.id}`), btn('⏭️ Skip', `pub:skip:${task.id}`)]];
}

// kb(rowA, rowB, …) → { inline_keyboard: [...] }; empty/null rows are dropped.
// Spread into send options: ctx.reply(text, { parse_mode: 'HTML', ...kb(...taskKeyboard(task)) })
function kb(...rows) { return { inline_keyboard: rows.filter(r => r && r.length) }; }

// Keyboard for task lifecycle messages.
// 'started' → [Cancel]; 'done' → Files, Publish, Files(N), Diff wrapped ≤ 2 per row
// (+ [Retry?] when failed, always ➕ New task here).
function taskKeyboard(task, phase = 'started') {
  if (phase === 'done') {
    const actions = [btn('📄 Files', `t:${task.id}:files`)];
    if (task.publishState !== 'published') {
      actions.push(btn('🚀 Publish', `pub:start:${task.id}`));
    }
    if (task.fileChanges && task.fileChanges.length > 0) {
      actions.push(btn(`📦 Files (${task.fileChanges.length})`, `f:all:${task.id}`));
    }
    if (task.commitUrl) actions.push(btn('📊 Diff', `t:${task.id}:diff`));
    const rows = wrapBtn(actions, 2);
    if (task.exitCode != null && task.exitCode !== 0) rows.push([btn('🔁 Retry', `t:${task.id}:retry`)]);
    // The loop button makes the flow circular: start the next task in the same
    // workspace without going back to the top-level menu.
    rows.push([btn('➕ New task here', `t:${task.id}:loop`)]);
    rows.push(...menuExitRow());
    return rows;
  }
  return [[btn('✖️ Cancel', `t:${task.id}:cancel`)], ...menuExitRow()];
}

function fileBrowserKeyboard(task, files = [], page = 1, pageSize = 6) {
  const totalPages = Math.max(1, Math.ceil(files.length / pageSize));
  const startIndex = (page - 1) * pageSize;
  const pageFiles = files.slice(startIndex, startIndex + pageSize);
  const rows = [];
  for (let i = 0; i < pageFiles.length; i++) {
    const file = pageFiles[i];
    const absIndex = startIndex + i;
    const base = String(file.path).split(/[\\/]/).pop() || file.path;
    const label = (file.op === 'write' ? '➕ ' : '✏️ ') + (base.length > 25 ? base.slice(0, 22) + '…' : base);
    rows.push([btn(label, `f:dl:${task.id}:${absIndex}`)]);
  }
  if (files.length > 1) {
    rows.push([btn(`📦 Send all files (${files.length})`, `f:all:${task.id}`)]);
  }
  if (totalPages > 1) {
    const nav = [];
    if (page > 1) nav.push(btn('◀️ Prev', `f:p:${task.id}:${page - 1}`));
    nav.push(btn(`${page}/${totalPages}`, 'noop'));
    if (page < totalPages) nav.push(btn('▶️ Next', `f:p:${task.id}:${page + 1}`));
    rows.push(nav);
  }
  rows.push([btn('⬅️ Back to task', `t:${task.id}:back`), btn('🏠 Menu', 'cmd:help')]);
  return rows;
}

// Exit row: every card must offer a way back — nothing is a dead end.
function menuExitRow() {
  return [[btn('⬅️ Back to menu', 'cmd:help')]];
}

// Keyboard for pause/resume notices: the toggle action + the exit row.
function queueKeyboard(paused) {
  return [
    [paused ? btn('▶️ Resume queue', 'queue:resume') : btn('⏸ Pause queue', 'queue:pause')],
    menuExitRow()[0],
  ];
}

function statusKeyboard(stats) {
  return [
    [btn('🔄 Refresh', 'status:refresh')],
    [stats.paused ? btn('▶️ Resume queue', 'queue:resume') : btn('⏸ Pause queue', 'queue:pause')],
    ...menuExitRow(),
  ];
}

function helpKeyboard() {
  return [
    [btn('🆕 New task', 'cmd:newtask'), btn('📊 Status', 'cmd:status')],
    [btn('📋 List', 'cmd:list'), btn('🩺 Health', 'cmd:health')],
    ...menuExitRow(),
  ];
}

// Interactive /purge: pick what to delete, then confirm on a second card.
function purgeKeyboard() {
  return [
    [btn('📁 Run logs', 'purge:sel:logs'), btn('📎 Attachments', 'purge:sel:attachments')],
    [btn('🏷 Finished tasks', 'purge:sel:tasks'), btn('🧹 Purge All', 'purge:sel:all')],
    menuExitRow()[0],
  ];
}

function purgeConfirmKeyboard(target) {
  return [[btn('⚠️ Yes, Delete', `purge:exec:${target}`), btn('❌ Cancel', 'purge:cancel')]];
}

// 🚨 Emergency panic stop confirmation
function panicConfirmKeyboard() {
  return [[btn('🚨 Yes, Panic Stop', 'panic:confirm'), btn('❌ Cancel', 'card:close')]];
}

// ⚠️ Running-task cancellation confirmation
function cancelConfirmKeyboard(id) {
  return [[btn('🛑 Yes, Cancel Task', `t:${id}:cancel_confirm`), btn('▶️ Keep Running', `t:${id}:keep`)]];
}

function listKeyboard(tasks = []) {
  const rows = wrapBtn(tasks.slice(-8).reverse().map(t => btn(`${t.id} · ${String(t.name || '').slice(0, 18)}`, `t:${t.id}:card`)), 2);
  rows.push(...menuExitRow());
  return rows;
}

function retryKeyboard(failedTasks = []) {
  const rows = wrapBtn(failedTasks.map(t => btn(`${t.id} · ${String(t.name || '').slice(0, 18)}`, `t:${t.id}:retry`)), 2);
  rows.push(...menuExitRow());
  return rows;
}

// Queue card: one tappable card button per running/queued task (top of list).
function queueTaskKeyboard(runningTasks = [], queuedTasks = []) {
  const all = [...runningTasks.slice(0, 6), ...queuedTasks.slice(0, 6)];
  if (!all.length) return [];
  return wrapBtn(all.map(t => btn(`${t.id} ${String(t.name || '').slice(0, 14)}`, `t:${t.id}:card`)), 2);
}

function healthKeyboard() {
  return menuExitRow();
}

function providerKeyboard(providers = [], currentProvider = '', page = 1, pageSize = 4) {
  const totalPages = Math.max(1, Math.ceil(providers.length / pageSize));
  const currentPage = Math.min(Math.max(1, page), totalPages);
  const startIndex = (currentPage - 1) * pageSize;
  const pageProviders = providers.slice(startIndex, startIndex + pageSize);
  const rows = [];
  let currentRow = [];
  for (const p of pageProviders) {
    const isCurrent = p.id === currentProvider;
    const label = (p.id.length > 18 ? p.id.slice(0, 16) + '…' : p.id) + (isCurrent ? ' ✓' : '');
    currentRow.push(btn(label, `selprov:${p.id}`));
    if (currentRow.length === 2) {
      rows.push(currentRow);
      currentRow = [];
    }
  }
  if (currentRow.length) rows.push(currentRow);

  if (totalPages > 1) {
    const nav = [];
    if (currentPage > 1) nav.push(btn('◀️ Prev', `provp:${currentPage - 1}`));
    nav.push(btn(`${currentPage}/${totalPages}`, 'noop'));
    if (currentPage < totalPages) nav.push(btn('▶️ Next', `provp:${currentPage + 1}`));
    rows.push(nav);
  }

  rows.push([btn('✏️ Write Provider', 'prov:custom'), btn('🧠 Pick Model', 'cmd:model')]);
  rows.push([btn('🌐 Use OmniRoute', 'cmd:omniroute')]);
  rows.push(...menuExitRow());
  return rows;
}

function modelKeyboard(models = [], currentModel = '', page = 1, pageSize = 5) {
  const totalPages = Math.max(1, Math.ceil(models.length / pageSize));
  const currentPage = Math.min(Math.max(1, page), totalPages);
  const startIndex = (currentPage - 1) * pageSize;
  const pageModels = models.slice(startIndex, startIndex + pageSize);
  const rows = [];

  for (let i = 0; i < pageModels.length; i++) {
    const m = pageModels[i];
    const absIdx = startIndex + i;
    const isCurrent = m === currentModel;
    const label = (m.length > 28 ? m.slice(0, 25) + '…' : m) + (isCurrent ? ' ✓' : '');
    rows.push([btn(label, `selmod:${absIdx}`)]);
  }

  if (totalPages > 1) {
    const nav = [];
    if (currentPage > 1) nav.push(btn('◀️ Prev', `modp:${currentPage - 1}`));
    nav.push(btn(`${currentPage}/${totalPages}`, 'noop'));
    if (currentPage < totalPages) nav.push(btn('▶️ Next', `modp:${currentPage + 1}`));
    rows.push(nav);
  }

  rows.push([btn('🔌 Provider', 'cmd:provider'), btn('✏️ Write Model', 'model:custom')]);
  rows.push(...menuExitRow());
  return rows;
}

function omnirouteKeyboard(running = true) {
  if (running) {
    return [
      [btn('🛑 Stop OmniRoute', 'omni:stop'), btn('✅ Use as provider', 'omni:use')],
      [btn('🔄 Refresh', 'omni:refresh'), btn('✖️ Close', 'card:close')],
      [btn('⬅️ Back to menu', 'cmd:help')],
    ];
  }
  return [
    [btn('▶️ Start OmniRoute', 'omni:start'), btn('🔄 Refresh', 'omni:refresh')],
    [btn('✖️ Close', 'card:close'), btn('⬅️ Back to menu', 'cmd:help')],
  ];
}

function welcomeKeyboard() {
  return [
    [btn('🆕 New task', 'cmd:newtask'), btn('📊 Status', 'cmd:status')],
    [btn('📋 Full help', 'cmd:help')],
  ];
}

function modeKeyboard(currentMode = 'act') {
  return [
    [
      btn(`Plan Mode${currentMode === 'plan' ? ' ✓' : ''}`, 'setmode:plan'),
      btn(`Act Mode${currentMode === 'act' ? ' ✓' : ''}`, 'setmode:act'),
    ],
    ...menuExitRow(),
  ];
}

// ── Settings hub (Task 7) ────────────────────────────────────────────────

function settingsKeyboard() {
  return [
    [btn('🤖 Agent', 'settings:agent'), btn('📐 Mode', 'settings:mode')],
    [btn('🧠 Thinking', 'settings:thinking'), btn('🔌 Provider', 'cmd:provider')],
    [btn('✨ Model', 'cmd:model'), btn('🌐 OmniRoute', 'cmd:omniroute')],
    [btn('📂 Workspace', 'cmd:workspace'), btn('🚀 GitHub', 'settings:github')],
    [btn('🔑 Gemini keys', 'settings:gemini'), btn('🧩 Skills', 'cmd:skill')],
    [btn('🪝 Agent hook', 'cmd:hook')],
    ...menuExitRow(),
  ];
}

function thinkingKeyboard(actLevel = 'medium', planLevel = 'high') {
  // Two-phase thinking: high for making a plan, lower for implementing.
  // `think:set:<phase>:<level>` — phase disambiguates act vs plan.
  const pick = (phase, level, cur) => btn(`${level}${cur === level ? ' ✓' : ''}`, `think:set:${phase}:${level}`);
  const levelRows = (phase, cur) => wrapBtn(['none', 'low', 'medium', 'high', 'xhigh'].map(l => pick(phase, l, cur)), 2);
  return [
    [btn(`🎯 Act thinking: ${actLevel}`, 'noop')],
    ...levelRows('act', actLevel),
    [btn(`🧠 Plan thinking: ${planLevel}`, 'noop')],
    ...levelRows('plan', planLevel),
    [btn('⚙️ All settings', 'settings:main'), ...menuExitRow()[0]],
  ];
}

function agentKeyboard() {
  return [
    [btn('📐 Mode', 'settings:mode'), btn('🧠 Thinking', 'settings:thinking')],
    [btn('🧠 Thinking', 'settings:thinking'), btn('🔌 Provider', 'cmd:provider')],
    [btn('✨ Model', 'cmd:model'), btn('🧩 Skills', 'cmd:skill')],
    [btn('🪝 Agent hook', 'cmd:hook')],
    ...menuExitRow(),
  ];
}

function geminiKeysKeyboard(keys = [], activeIndex = 0) {
  const rows = [];
  keys.forEach((k, i) => {
    const label = `🔑 ***${String(k).slice(-6)}${i === activeIndex ? ' (active)' : ''}`;
    rows.push([btn(label, `gemini:pick:${i}`)]);
  });
  rows.push([btn('➕ Add key', 'gemini:add'), btn('🔄 Rotate', 'gemini:rotate')]);
  if (keys.length > 0) rows.push([btn('🗑 Remove active', 'gemini:remove')]);
  rows.push(menuExitRow()[0]);
  return rows;
}

module.exports = {
  card, kv, btn, kb, wrapBtn, taskKeyboard, publishKeyboard,
  statusKeyboard, helpKeyboard, welcomeKeyboard, listKeyboard,
  healthKeyboard, fileBrowserKeyboard,
  providerKeyboard, modelKeyboard, omnirouteKeyboard,
  modeKeyboard,
  purgeKeyboard, purgeConfirmKeyboard, panicConfirmKeyboard, cancelConfirmKeyboard,
  menuExitRow, queueKeyboard, retryKeyboard, queueTaskKeyboard,
  settingsKeyboard, thinkingKeyboard, agentKeyboard, geminiKeysKeyboard,
};