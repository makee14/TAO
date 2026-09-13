'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { card, kv, kb, menuExitRow, purgeKeyboard, purgeConfirmKeyboard } = require('./ui');
const { cardReply } = require('./card-session');

const LOG_RE = /^task-.*\.(ndjson|prompt)$/;

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 / 1024).toFixed(1)} MiB`;
}

function dirSize(dir) {
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  for (const de of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, de.name);
    total += de.isDirectory() ? dirSize(p) : fs.statSync(p).size;
  }
  return total;
}

function purgeRunLogs(runsDir, olderThanMs) {
  let removedFiles = 0, freedBytes = 0;
  if (!fs.existsSync(runsDir)) return { removedFiles, freedBytes };
  for (const name of fs.readdirSync(runsDir)) {
    if (!LOG_RE.test(name)) continue;
    const p = path.join(runsDir, name);
    const st = fs.statSync(p);
    if (st.mtimeMs < olderThanMs) { freedBytes += st.size; fs.unlinkSync(p); removedFiles++; }
  }
  return { removedFiles, freedBytes };
}

function purgeAttachments(attachDir, olderThanMs) {
  let removedFolders = 0, freedBytes = 0;
  if (!fs.existsSync(attachDir)) return { removedFolders, freedBytes };
  for (const entry of fs.readdirSync(attachDir, { withFileTypes: true })) {
    const p = path.join(attachDir, entry.name);
    const st = fs.statSync(p);
    if (st.mtimeMs < olderThanMs) {
      freedBytes += entry.isDirectory() ? dirSize(p) : st.size;
      fs.rmSync(p, { recursive: true, force: true });
      removedFolders++;
    }
  }
  return { removedFolders, freedBytes };
}

function storageInfos({ taskStorePath, runsDir, attachDir, mirrorDir, store }) {
  const rows = [];
  const add = (label, bytes) => rows.push(kv(label, formatBytes(bytes)));
  add('🗂 Tasks (tasks.json)', fs.existsSync(taskStorePath) ? fs.statSync(taskStorePath).size : 0);
  add('📁 Run logs', dirSize(runsDir));
  add('📎 Attachments', dirSize(attachDir));
  add('💾 Publish mirror', dirSize(mirrorDir));
  if (store) rows.push(`🏷 Stored tasks: <code>${store.all().length}</code>`);
  return { rows };
}

function registerDataCommands(bot, { cfg, store, paths }) {
  const PURGE_LABELS = {
    logs: '📁 Run logs',
    attachments: '📎 Attachments',
    tasks: '🏷 Finished tasks',
    all: '🧹 EVERYTHING (logs + attachments + finished tasks)',
  };

  const execPurge = target => {
    const results = [];
    const doLogs = () => purgeRunLogs(path.resolve(paths.runs), Number.POSITIVE_INFINITY);
    const doAtts = () => purgeAttachments(path.resolve(paths.attachments), Number.POSITIVE_INFINITY);
    const doTasks = () => (store?.purge ? store.purge(new Date(0)) : { removed: 0 });
    if (target === 'logs' || target === 'all') {
      const r = doLogs();
      results.push(kv('📁', `${r.removedFiles} run log files removed (${formatBytes(r.freedBytes)})`));
    }
    if (target === 'attachments' || target === 'all') {
      const r = doAtts();
      results.push(kv('📎', `${r.removedFolders} attachment folders removed (${formatBytes(r.freedBytes)})`));
    }
    if (target === 'tasks' || target === 'all') {
      const r = doTasks();
      results.push(kv('🏷', `${r.removed ?? 0} finished tasks removed`));
    }
    return results;
  };

  const showPurgeMenu = ctx => cardReply(ctx, ctx.cards, card({
    icon: '🧹',
    title: 'Purge Data',
    meta: 'Choose what to delete — every option asks for confirmation',
    rows: ['Run logs & prompts, task attachments, and finished task records.'],
  }), { parse_mode: 'HTML', reply_markup: kb(...purgeKeyboard()) });

  bot.action('purge:cancel', async ctx => {
    await ctx.answerCbQuery('Cancelled');
    return showPurgeMenu(ctx);
  });

  bot.action(/^purge:sel:(.+)$/, async ctx => {
    await ctx.answerCbQuery();
    const target = ctx.match[1];
    if (!PURGE_LABELS[target]) return showPurgeMenu(ctx);
    return cardReply(ctx, ctx.cards, card({
      icon: '⚠️',
      title: 'Confirm Purge',
      rows: [
        `You are about to <b>permanently delete</b>:`,
        `<b>${PURGE_LABELS[target]}</b>`,
        'This cannot be undone.',
      ],
    }), { parse_mode: 'HTML', reply_markup: kb(...purgeConfirmKeyboard(target)) });
  });

  bot.action(/^purge:exec:(.+)$/, async ctx => {
    await ctx.answerCbQuery('Purging…');
    const target = ctx.match[1];
    if (!PURGE_LABELS[target]) return showPurgeMenu(ctx);
    const rows = execPurge(target);
    return cardReply(ctx, ctx.cards, card({
      icon: '🧹',
      title: 'Purge complete',
      rows,
      footer: `<i>Target: ${PURGE_LABELS[target]}</i>`,
    }), { parse_mode: 'HTML', reply_markup: kb(...menuExitRow()) });
  });

  bot.command('purge', ctx => showPurgeMenu(ctx));
}

module.exports = { registerDataCommands, purgeRunLogs, purgeAttachments, storageInfos };