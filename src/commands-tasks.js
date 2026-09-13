'use strict';
const { esc, fmtList, truncatePrompt } = require('./formatter');
const { card, kv, kb, btn, wrapBtn, listKeyboard, retryKeyboard, cancelConfirmKeyboard } = require('./ui');
const { cardReply } = require('./card-session');

async function doCancel(store, runner, scheduler, id) {
  const t = id && store.get(id);
  if (!t) return { ok: false, msg: 'Task not found — tap 📋 List to pick it.', buttons: [[btn('📋 List tasks', 'cmd:list'), btn('🏠 Menu', 'cmd:help')]] };
  if (!['queued', 'running', 'blocked'].includes(t.state)) return { ok: false, msg: `Task <b>${esc(t.id)}</b> is already <i>${esc(t.state)}</i>.`, buttons: [[btn('📊 Status', 'cmd:status'), btn('🏠 Menu', 'cmd:help')]] };
  if (t.state === 'running' && t.pid) await runner.abort(t.pid);
  store.update(t.id, { state: 'cancelled', pid: null });
  scheduler.pump();
  return { ok: true, msg: `🚫 Cancelled <b>${esc(t.id)}</b>.`, buttons: wrapBtn([btn('📊 Status', 'cmd:status'), btn('➕ New task', 'cmd:newtask'), btn('🏠 Menu', 'cmd:help')], 2) };
}

async function doRetry(store, scheduler, id) {
  const t = id && store.get(id);
  const failed = store.byState('failed');
  if (!t || t.state !== 'failed') {
    // no-hassle /retry: no id needed — offer a picker of failed tasks
    if (!failed.length) return { ok: false, msg: 'No failed tasks to retry.', buttons: wrapBtn([btn('📋 List tasks', 'cmd:list'), btn('🏠 Menu', 'cmd:help')], 2) };
    return { ok: false, msg: 'Pick a failed task to retry:', buttons: retryKeyboard(failed) };
  }
  const n = store.create({ name: t.name, prompt: t.prompt, workspace: t.workspace, repo: t.repo, imagePath: t.imagePath, photos: t.photos, after: t.after, mode: t.mode });
  scheduler.pump();
  return { ok: true, msg: `🔁 Retrying as <b>${esc(n.id)}</b>.`, buttons: wrapBtn([btn('📊 Status', 'cmd:status'), btn('➕ New task', 'cmd:newtask'), btn('🏠 Menu', 'cmd:help')], 2) };
}

function registerTaskCommands(bot, { cfg, store, scheduler, runner, registry }) {
  const defaultWs = () => cfg.workspaces.find(w => w.default) ?? cfg.workspaces[0];
  const wsForDo = () => (registry?.selectedWs ? cfg.workspaces.find(w => w.name === registry.selectedWs) : null)
    ?? defaultWs();
  const defaultRepo = wsName => {
    const eligible = cfg.github.repos.filter(r => !r.ws || r.ws === wsName); // one repo = one workspace
    return eligible.find(r => r.default) ?? eligible[0] ?? null;
  };

  bot.command('do', async ctx => {
    const prompt = ctx.message.text.replace(/^\/do\s*/, '').trim();
    if (!prompt) {
      const ws = wsForDo();
      const repo = defaultRepo(ws.name);
      return cardReply(ctx, ctx.cards, card({
        icon: '⚡',
        title: 'Quick Task (/do)',
        rows: [
          kv('📂 Active Workspace', esc(ws.name)),
          kv('📁 Path', esc(ws.path)),
          kv('📦 Target Repo', repo ? `${esc(repo.owner)}/${esc(repo.repo)}` : 'none (local only)'),
          '',
          'Usage: <code>/do &lt;your instructions&gt;</code>',
          'Runs immediately with current defaults.',
        ],
        footer: '<i>Tap New task wizard below, or tap 📂 Change workspace below.</i>',
      }), {
        parse_mode: 'HTML',
        reply_markup: kb([btn('🆕 New task wizard', 'cmd:newtask'), btn('📂 Change workspace', 'cmd:workspace')], [btn('🏠 Menu', 'cmd:help')]),
      });
    }

    const ws = wsForDo();
    const repo = defaultRepo(ws.name);
    const t = store.create({ name: truncatePrompt(prompt, 40), prompt, workspace: ws.path, repo, mode: cfg.cline?.mode });
    await scheduler.pump();
    const text = card({
      icon: '🚀',
      title: `Queued ${esc(t.id)}`,
      rows: [
        kv('🏷 Task', esc(t.name)),
        kv('📂 Workspace', `${esc(ws.name)} (<code>${esc(ws.path)}</code>)`),
        kv('📦 Repo', repo ? `<b>${esc(repo.owner)}/${esc(repo.repo)}</b>` : 'none (local only)'),
      ],
      footer: '<i>Scheduler will launch as soon as a slot is available.</i>',
    });
    return cardReply(ctx, ctx.cards, text, {
      parse_mode: 'HTML',
      reply_markup: kb([btn('📊 Status', 'cmd:status'), btn('✖️ Cancel', `t:${t.id}:cancel`)], [btn('➕ Another task', 'cmd:newtask'), btn('🏠 Menu', 'cmd:help')]),
    });
  });

  bot.command('list', ctx => cardReply(ctx, ctx.cards, fmtList(store.all()), { parse_mode: 'HTML', reply_markup: kb(...listKeyboard(store.all())) }));

  bot.action('cmd:list', async ctx => {
    await ctx.answerCbQuery();
    return cardReply(ctx, ctx.cards, fmtList(store.all()), { parse_mode: 'HTML', reply_markup: kb(...listKeyboard(store.all())) });
  });

  bot.command('resume', ctx => {
    scheduler.resume();
    scheduler.pump();
    return cardReply(ctx, ctx.cards, '▶️ <b>Queue resumed</b>.', {
      parse_mode: 'HTML',
      reply_markup: kb(...wrapBtn([btn('⏸ Pause queue', 'queue:pause'), btn('📊 Status', 'cmd:status'), btn('🏠 Menu', 'cmd:help')], 2)),
    });
  });

  // inline-button actions on task cards
  bot.action(/^t:(.+):cancel$/, async ctx => {
    await ctx.answerCbQuery();
    const t = store.get(ctx.match[1]);
    if (t && t.state === 'running') {
      return cardReply(ctx, ctx.cards, card({
        icon: '⚠️',
        title: `Cancel Task ${esc(t.id)}?`,
        rows: ['This will terminate the running agent process.'],
      }), { parse_mode: 'HTML', reply_markup: kb(...cancelConfirmKeyboard(t.id)) });
    }
    const r = await doCancel(store, runner, scheduler, ctx.match[1]);
    return cardReply(ctx, ctx.cards, r.msg, { parse_mode: 'HTML', ...(r.buttons ? { reply_markup: kb(...r.buttons) } : {}) });
  });

  bot.action(/^t:(.+):cancel_confirm$/, async ctx => {
    await ctx.answerCbQuery('Cancelling…');
    const r = await doCancel(store, runner, scheduler, ctx.match[1]);
    return cardReply(ctx, ctx.cards, r.msg, { parse_mode: 'HTML', ...(r.buttons ? { reply_markup: kb(...r.buttons) } : {}) });
  });

  bot.action(/^t:(.+):keep$/, async ctx => {
    await ctx.answerCbQuery('Task keeps running');
    return cardReply(ctx, ctx.cards, `▶️ <b>${esc(ctx.match[1])}</b> keeps running.`, {
      parse_mode: 'HTML',
      reply_markup: kb([btn('📊 Status', 'cmd:status'), btn('🏠 Menu', 'cmd:help')]),
    });
  });

  bot.action(/^t:(.+):retry$/, async ctx => {
    await ctx.answerCbQuery();
    const r = await doRetry(store, scheduler, ctx.match[1]);
    return cardReply(ctx, ctx.cards, r.msg, { parse_mode: 'HTML', ...(r.buttons ? { reply_markup: kb(...r.buttons) } : {}) });
  });
}

module.exports = { registerTaskCommands, doCancel, doRetry };
