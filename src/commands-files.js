'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { esc, fmtTaskCard, fmtFileBrowser, fileTreeRows } = require('./formatter');
const { card, kv, btn, kb, taskKeyboard, fileBrowserKeyboard, menuExitRow } = require('./ui');
const { cardReply } = require('./card-session');

const backToTask = id => [[btn('⬅️ Back to task', `t:${id}:back`)]];

function safeJoin(workspace, rel) {
  const resolved = path.resolve(workspace, rel);
  if (resolved.toLowerCase() !== path.resolve(workspace).toLowerCase()
    && !resolved.toLowerCase().startsWith(path.resolve(workspace).toLowerCase() + path.sep))
    throw new Error('path escapes the workspace');
  return resolved;
}

function filesText(store, id) {
  const t = store.get(id);
  if (!t) return { ok: false, msg: 'Task not found — pick one from 📋 List.', buttons: [[btn('📋 List tasks', 'cmd:list'), btn('🏠 Menu', 'cmd:help')]] };
  const list = (t.fileChanges ?? []).length ? fileTreeRows(t.fileChanges ?? []) : ['(none recorded)'];
  return { ok: true, msg: card({ icon: '📄', title: `${esc(t.id)} changed files`, rows: list }), buttons: backToTask(id) };
}

function getLatestTaskWithFiles(store) {
  const all = store.all();
  return all.slice().reverse().find(t => t.fileChanges && t.fileChanges.length > 0)
    ?? all.slice().reverse().find(t => ['done', 'failed'].includes(t.state))
    ?? all[all.length - 1]
    ?? null;
}

function fileBrowserCard(task, page = 1) {
  const files = task.fileChanges ?? [];
  const pageSize = 6;
  const totalPages = Math.max(1, Math.ceil(files.length / pageSize));
  const currentPage = Math.min(Math.max(1, page), totalPages);
  const msg = fmtFileBrowser(task, files, currentPage, totalPages);
  const buttons = fileBrowserKeyboard(task, files, currentPage, pageSize);
  return { ok: true, msg, buttons, totalPages, currentPage };
}

async function sendFileDocument(ctx, task, relPath) {
  try {
    const abs = safeJoin(task.workspace, relPath);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      return cardReply(ctx, ctx.cards, `⚠️ File not found on disk: <code>${esc(relPath)}</code>`, { parse_mode: 'HTML', reply_markup: kb(...menuExitRow()) });
    }
    const size = fs.statSync(abs).size;
    if (size > 50 * 1024 * 1024) {
      return cardReply(ctx, ctx.cards, `⚠️ File exceeds Telegram 50 MB limit (${(size / 1024 / 1024).toFixed(1)} MB): <code>${esc(relPath)}</code>`, { parse_mode: 'HTML', reply_markup: kb(...menuExitRow()) });
    }
    await ctx.replyWithDocument({ source: abs, filename: path.basename(abs) }, {
      caption: `📄 <b>${esc(task.id)}</b> · <code>${esc(relPath)}</code>`,
      parse_mode: 'HTML',
    });
  } catch (e) {
    await cardReply(ctx, ctx.cards, `⚠️ ${esc(e.message)}`, { parse_mode: 'HTML', reply_markup: kb(...menuExitRow()) });
  }
}

async function diffText(cfg, store, id) {
  const t = store.get(id);
  if (!t?.commitUrl) return { ok: false, msg: 'No commit yet — tap 📊 Diff on the done card after a successful publish.', buttons: [[btn('⬅️ Back to task', `t:${id}:back`), btn('🏠 Menu', 'cmd:help')]] };
  const mirror = path.join(path.resolve(cfg.paths.publishMirror), `${t.repo.owner}-${t.repo.repo}`);
  const out = await new Promise(res => execFile('git', ['show', '--stat', 'HEAD'], { cwd: mirror, windowsHide: true }, (e, o) => res(e ? 'diff unavailable' : o)));
  return { ok: true, msg: card({ icon: '📊', title: `${esc(t.id)} diff (last commit)`, rows: [`<pre>${esc(String(out).slice(-3000))}</pre>`] }), buttons: backToTask(id) };
}

function registerFileCommands(bot, { cfg, store }) {
  const handleFilePicker = (ctx, taskId) => {
    const id = taskId || (ctx.message?.text ? ctx.message.text.split(/\s+/)[1] : null);
    const task = id ? store.get(id) : getLatestTaskWithFiles(store);
    if (!task) {
      return cardReply(ctx, ctx.cards, card({
        icon: '📁',
        title: 'Files',
        rows: ['(No tasks with files recorded yet)'],
        footer: '<i>Start a task first — its changed files appear here automatically.</i>',
      }), { parse_mode: 'HTML', reply_markup: kb([btn('🆕 New task', 'cmd:newtask'), btn('🏠 Menu', 'cmd:help')]) });
    }
    const r = fileBrowserCard(task, 1);
    return cardReply(ctx, ctx.cards, r.msg, { parse_mode: 'HTML', reply_markup: kb(...r.buttons) });
  };

  bot.command(['file', 'files'], ctx => handleFilePicker(ctx));

  // Download single file callback
  bot.action(/^f:dl:(.+):(\d+)$/, async ctx => {
    await ctx.answerCbQuery('Sending file…');
    const taskId = ctx.match[1];
    const fileIdx = Number(ctx.match[2]);
    const task = store.get(taskId);
    if (!task) return cardReply(ctx, ctx.cards, '⚠️ Task not found.', { parse_mode: 'HTML', reply_markup: kb([btn('🏠 Menu', 'cmd:help')]) });
    const file = task.fileChanges?.[fileIdx];
    if (!file) return cardReply(ctx, ctx.cards, '⚠️ File record not found.', { parse_mode: 'HTML', reply_markup: kb([btn('⬅️ Back to task', `t:${taskId}:back`), btn('🏠 Menu', 'cmd:help')]) });
    return sendFileDocument(ctx, task, file.path);
  });

  // Send all files callback
  bot.action(/^f:all:(.+)$/, async ctx => {
    await ctx.answerCbQuery('Sending all changed files…');
    const taskId = ctx.match[1];
    const task = store.get(taskId);
    if (!task) return cardReply(ctx, ctx.cards, '⚠️ Task not found.', { parse_mode: 'HTML' });
    const files = task.fileChanges ?? [];
    if (!files.length) return cardReply(ctx, ctx.cards, 'ℹ️ No files recorded for this task.', { parse_mode: 'HTML' });
    for (const f of files.slice(0, 10)) {
      await sendFileDocument(ctx, task, f.path);
    }
    if (files.length > 10) {
      await ctx.reply(`<i>(Sent first 10 files out of ${files.length}. Use /file to browse all files.)</i>`, { parse_mode: 'HTML' });
    }
  });

  // Pagination callback
  bot.action(/^f:p:(.+):(\d+)$/, async ctx => {
    await ctx.answerCbQuery();
    const taskId = ctx.match[1];
    const page = Number(ctx.match[2]);
    const task = store.get(taskId);
    if (!task) return cardReply(ctx, ctx.cards, '⚠️ Task not found.', { parse_mode: 'HTML' });
    const r = fileBrowserCard(task, page);
    return cardReply(ctx, ctx.cards, r.msg, { parse_mode: 'HTML', reply_markup: kb(...r.buttons) });
  });

  // inline-button actions on task cards
  bot.action(/^t:(.+):files$/, async ctx => {
    await ctx.answerCbQuery();
    const r = filesText(store, ctx.match[1]);
    return cardReply(ctx, ctx.cards, r.msg, r.buttons ? { parse_mode: 'HTML', reply_markup: kb(...r.buttons) } : { parse_mode: 'HTML' });
  });

  bot.action(/^t:(.+):diff$/, async ctx => {
    await ctx.answerCbQuery();
    const r = await diffText(cfg, store, ctx.match[1]);
    return cardReply(ctx, ctx.cards, r.msg, r.buttons ? { parse_mode: 'HTML', reply_markup: kb(...r.buttons) } : { parse_mode: 'HTML' });
  });

  // open the full task card from a list/status/queue button tap
  bot.action(/^t:(.+):card$/, async ctx => {
    await ctx.answerCbQuery();
    const t = store.get(ctx.match[1]);
    if (!t) return cardReply(ctx, ctx.cards, '⚠️ Task not found.', { parse_mode: 'HTML', reply_markup: kb(...menuExitRow()) });
    const phase = ['done', 'failed'].includes(t.state) ? 'done' : 'started';
    return cardReply(ctx, ctx.cards, fmtTaskCard(t), { parse_mode: 'HTML', reply_markup: kb(...taskKeyboard(t, phase)) });
  });

  // back-to-task: edit the Files/Diff view back into the task card it came from
  bot.action(/^t:(.+):back$/, async ctx => {
    await ctx.answerCbQuery();
    const t = store.get(ctx.match[1]);
    if (!t) return cardReply(ctx, ctx.cards, '⚠️ Task not found.', { parse_mode: 'HTML' });
    const phase = ['done', 'failed'].includes(t.state) ? 'done' : 'started';
    return cardReply(ctx, ctx.cards, fmtTaskCard(t), { parse_mode: 'HTML', reply_markup: kb(...taskKeyboard(t, phase)) });
  });
}

module.exports = { safeJoin, registerFileCommands, filesText, diffText, fileBrowserCard, getLatestTaskWithFiles };
