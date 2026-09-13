'use strict';
const { esc, fmtDone } = require('./formatter');
const { kb, btn, card, taskKeyboard, menuExitRow } = require('./ui');
const { cardReply } = require('./card-session');

async function publishTask({ store, publisher, taskId, defaultBranch = 'main', force = false }) {
  const t = store.get(taskId);
  if (!t) return { ok: false, msg: 'Unknown task.' };
  if (t.publishState !== 'pending')
    return { ok: false, msg: `Task ${esc(t.id)} is not awaiting publish (${t.publishState ?? 'no repo'}).` };
  if (!t.repo) return { ok: false, msg: 'No GitHub repo is configured for this task.' };
  try {
    const { owner, repo } = t.repo;
    const branch = t.repo.branch || defaultBranch;
    await publisher.ensureRepo({ owner, repo, branch });
    const r = await publisher.publish({ taskId: t.id, taskName: t.name, workspace: t.workspace, owner, repo, branch, force });
    // Safety guard: the GitHub branch holds commits this publish would
    // overwrite. Nothing was pushed — the owner decides what happens next.
    if (r.refusedRemoteAhead) {
      return {
        ok: false,
        refusedRemoteAhead: true,
        taskId: t.id,
        remoteAheadCount: r.remoteAheadCount,
        msg: `🛑 <b>Publish stopped for ${esc(t.id)}</b> — the GitHub branch <code>${esc(owner)}/${esc(repo)}</code> has ${r.remoteAheadCount} commit${r.remoteAheadCount > 1 ? 's' : ''} that are not in this workspace.\n\nNothing was pushed. Publishing replaces the branch with this workspace's content — only continue if that remote work is safe to overwrite.`,
      };
    }
    const done = store.update(t.id, { publishState: 'published', commitUrl: r.commitUrl, publishError: null });
    return { ok: true, msg: '', done };
  } catch (e) {
    const message = typeof e.message === 'string' ? e.message : String(e);
    const done = store.update(t.id, { publishState: 'error', publishError: message });
    return { ok: false, msg: `⚠️ Publish failed for ${esc(t.id)}: ${esc(message)}. Tap ✅ Publish to retry.`, done };
  }
}

function replyPublishResult(ctx, r) {
  if (r.refusedRemoteAhead) {
    // The guard stopped the push. Offer the explicit overwrite choice —
    // the task stays pending so Publish can simply be retried later.
    return cardReply(ctx, ctx.cards, r.msg, {
      parse_mode: 'HTML',
      reply_markup: kb(
        [btn('💥 Force publish (overwrite remote)', `pub:force:${r.taskId ?? ctx.match?.[1] ?? ''}`)],
        [btn('⬅️ Leave it pending', 'cmd:help')],
      ),
    });
  }
  if (!r.ok) return cardReply(ctx, ctx.cards, r.msg, { parse_mode: 'HTML', reply_markup: kb(...menuExitRow()) });
  return cardReply(ctx, ctx.cards, fmtDone(r.done, { exitCode: r.done.exitCode, durationSec: null, error: null }),
    { parse_mode: 'HTML', reply_markup: kb(...taskKeyboard(r.done, 'done')) });
}

function registerPublishCommands(bot, { cfg, store, publisher, registry = { publishFlow: null } }) {
  const escRow = () => [btn('❌ Cancel', 'pub:cancel'), btn('🏠 Menu', 'cmd:help')];

  // ---- interactive publish flow (workspace/task -> repo -> confirm) ----

  const showPublishMenu = async ctx => {
    const rows = (cfg.workspaces || []).map(w => [btn(`📁 ${esc(w.name)}`, `pub:ws:${w.name}`)]);
    const recent = (typeof store.all === 'function' ? store.all() : [])
      .filter(t => t.state === 'done').slice(-3).reverse()
      .map(t => [btn(`🧩 ${esc(t.id)} · ${esc((t.name || '').slice(0, 24))}`, `pub:start:${t.id}`)]);
    const body = card({
      icon: '🚀',
      title: 'Publish',
      meta: 'Push a workspace or a finished task to GitHub',
      rows: [
        rows.length ? 'Pick a workspace:' : 'No workspaces configured.',
        recent.length ? '…or a recent finished task:' : '',
      ].filter(Boolean),
    });
    return cardReply(ctx, ctx.cards, body, {
      parse_mode: 'HTML',
      reply_markup: kb(...rows, ...recent, escRow()),
    });
  };

  const showRepoPicker = async ctx => {
    const flow = registry.publishFlow;
    if (!flow) return showPublishMenu(ctx);
    const wsName = (cfg.workspaces || []).find(w => w.path === flow.workspace)?.name;
    const repos = (cfg.github?.repos || []).filter(r => !wsName || !r.ws || r.ws === wsName);
    const rows = repos.map((r, i) => [btn(`📦 ${esc(r.owner)}/${esc(r.repo)}${r.branch ? ` (${esc(r.branch)})` : ''}`, `pub:pick:${i}`)]);
    const body = card({
      icon: '📦',
      title: 'Choose Repository',
      meta: flow.taskId ? `Publish task ${esc(flow.taskId)}` : `Publish ${esc(wsName || flow.workspace)}`,
      rows: [
        repos.length ? 'Pick a configured repo:' : 'No configured repos match this workspace.',
        'Or create a brand-new repo below.',
      ],
    });
    return cardReply(ctx, ctx.cards, body, {
      parse_mode: 'HTML',
      reply_markup: kb(...rows, [btn('➕ Create new repo', 'pub:new_repo')], escRow()),
    });
  };

  const showConfirmCard = async ctx => {
    const flow = registry.publishFlow;
    if (!flow?.owner) return showRepoPicker(ctx);
    const body = card({
      icon: '🚀',
      title: 'Confirm Publish',
      rows: [
        `Workspace: <code>${esc(flow.workspace)}</code>`,
        `Target: <b>${esc(flow.owner)}/${esc(flow.repo)}</b>`,
        `Branch: <code>${esc(flow.branch || cfg.github?.defaultBranch || 'main')}</code>`,
      ],
      footer: '<i>Files are mirrored (secrets skipped) and committed with the PAT.</i>',
    });
    return cardReply(ctx, ctx.cards, body, {
      parse_mode: 'HTML',
      reply_markup: kb(
        [btn('✅ Confirm Publish', 'pub:go')],
        escRow(),
      ),
    });
  };

  const runFlowPublish = async ctx => {
    const flow = registry.publishFlow;
    registry.publishFlow = null;
    if (!flow?.owner) return showPublishMenu(ctx);
    const branch = flow.branch || cfg.github?.defaultBranch || 'main';
    if (flow.taskId) {
      if (!store.get(flow.taskId)) return cardReply(ctx, ctx.cards, 'Unknown task.', { parse_mode: 'HTML', reply_markup: kb(...escRow()) });
      store.update(flow.taskId, { repo: { owner: flow.owner, repo: flow.repo, branch }, publishState: 'pending', publishError: null });
      const r = await publishTask({ store, publisher, taskId: flow.taskId, defaultBranch: cfg.github?.defaultBranch ?? 'main' });
      return replyPublishResult(ctx, r);
    }
    try {
      await publisher.ensureRepo({ owner: flow.owner, repo: flow.repo, branch });
      const r = await publisher.publish({ taskId: 'adhoc', taskName: 'manual publish', workspace: flow.workspace, owner: flow.owner, repo: flow.repo, branch });
      const body = card({
        icon: '✅',
        title: 'Publish Complete',
        rows: [
          `Repo: <b>${esc(flow.owner)}/${esc(flow.repo)}</b>`,
          r.commitUrl ? `Commit: ${esc(r.commitUrl)}` : 'Nothing new to commit — mirror already up to date.',
        ],
      });
      return cardReply(ctx, ctx.cards, body, { parse_mode: 'HTML', reply_markup: kb(...escRow()) });
    } catch (e) {
      const message = typeof e.message === 'string' ? e.message : String(e);
      return cardReply(ctx, ctx.cards, `⚠️ Publish failed: ${esc(message)}`, { parse_mode: 'HTML', reply_markup: kb(...escRow()) });
    }
  };

  bot.action('pub:cancel', async ctx => {
    await ctx.answerCbQuery('Publish cancelled');
    registry.publishFlow = null;
    return showPublishMenu(ctx);
  });

  bot.action('cmd:publishMenu', async ctx => {
    await ctx.answerCbQuery();
    return showPublishMenu(ctx);
  });

  bot.action(/^pub:ws:(.+)$/, async ctx => {
    await ctx.answerCbQuery();
    const ws = (cfg.workspaces || []).find(w => w.name === ctx.match[1]);
    if (!ws) return showPublishMenu(ctx);
    registry.publishFlow = { workspace: ws.path };
    return showRepoPicker(ctx);
  });

  bot.action(/^pub:start:(.+)$/, async ctx => {
    await ctx.answerCbQuery();
    const t = store.get(ctx.match[1]);
    if (!t) return showPublishMenu(ctx);
    if (t.publishState === 'pending' && t.repo) {
      const r = await publishTask({ store, publisher, taskId: t.id, defaultBranch: cfg.github?.defaultBranch ?? 'main' });
      return replyPublishResult(ctx, r);
    }
    registry.publishFlow = { taskId: t.id, workspace: t.workspace };
    return showRepoPicker(ctx);
  });

  bot.action(/^pub:pick:(\d+)$/, async ctx => {
    await ctx.answerCbQuery();
    const flow = registry.publishFlow;
    const r = (cfg.github?.repos || [])[parseInt(ctx.match[1], 10)];
    if (!flow || !r) return showRepoPicker(ctx);
    Object.assign(flow, { owner: r.owner, repo: r.repo, branch: r.branch });
    return showConfirmCard(ctx);
  });

  bot.action('pub:new_repo', async ctx => {
    await ctx.answerCbQuery();
    const flow = registry.publishFlow;
    if (!flow) return showPublishMenu(ctx);
    const chatId = ctx.chat?.id || ctx.callbackQuery?.message?.chat?.id || 0;
    registry.pendingInput = {
      type: 'repo',
      chatId,
      handler: (inputCtx, text) => {
        const m = text.match(/^([\w.-]+)\/([\w.-]+)$/);
        if (!m) {
          return cardReply(inputCtx, inputCtx.cards, '⚠️ Send the repo as <code>owner/repo</code> — e.g. <code>myuser/my-project</code>.', { parse_mode: 'HTML', reply_markup: kb(...escRow()) });
        }
        Object.assign(registry.publishFlow, { owner: m[1], repo: m[2] });
        return showConfirmCard(inputCtx);
      },
    };
    const body = card({
      icon: '➕',
      title: 'Create New Repo',
      rows: [
        'Send the new repo as <code>owner/repo</code> in your next message.',
        'Example: <code>myuser/my-project</code>',
      ],
      footer: '<i>The repo is created private on first publish (needs PAT with Administration permission).</i>',
    });
    return cardReply(ctx, ctx.cards, body, { parse_mode: 'HTML', reply_markup: kb(...escRow()) });
  });

  bot.action('pub:go', async ctx => {
    await ctx.answerCbQuery('Publishing…');
    return runFlowPublish(ctx);
  });

  bot.action(/^pub:confirm:(.+)$/, async ctx => {
    await ctx.answerCbQuery();
    const r = await publishTask({ store, publisher, taskId: ctx.match[1], defaultBranch: cfg.github?.defaultBranch ?? 'main' });
    return replyPublishResult(ctx, r);
  });

  // Explicit owner choice to overwrite remote-only commits (publishGuard refused first).
  bot.action(/^pub:force:(.+)$/, async ctx => {
    await ctx.answerCbQuery('Force publishing…');
    const r = await publishTask({ store, publisher, taskId: ctx.match[1], defaultBranch: cfg.github?.defaultBranch ?? 'main', force: true });
    return replyPublishResult(ctx, r);
  });

  bot.action(/^pub:skip:(.+)$/, async ctx => {
    await ctx.answerCbQuery();
    const t = store.get(ctx.match[1]);
    if (!t) return cardReply(ctx, ctx.cards, 'Unknown task.', { parse_mode: 'HTML', reply_markup: kb(...menuExitRow()) });
    store.update(t.id, { publishState: 'skipped', publishError: null });
    return cardReply(ctx, ctx.cards, `⏭️ Skipped publish for <b>${esc(t.id)}</b> — the workspace stays local.`, { parse_mode: 'HTML', reply_markup: kb(...menuExitRow()) });
  });

  bot.command('skip', async ctx => {
    const id = ctx.message.text.split(/\s+/)[1];
    if (!id) return cardReply(ctx, ctx.cards, 'Usage: /skip <task-id>', { parse_mode: 'HTML', reply_markup: kb(...menuExitRow()) });
    const t = store.get(id);
    if (!t) return cardReply(ctx, ctx.cards, 'Unknown task.', { parse_mode: 'HTML', reply_markup: kb(...menuExitRow()) });
    store.update(t.id, { publishState: 'skipped', publishError: null });
    return cardReply(ctx, ctx.cards, `⏭️ Skipped publish for <b>${esc(t.id)}</b> — the workspace stays local.`, { parse_mode: 'HTML', reply_markup: kb(...menuExitRow()) });
  });
}

module.exports = { registerPublishCommands, publishTask };