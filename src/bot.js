'use strict';
const { Telegraf } = require('telegraf');
const { createFlow, advance, stepReply, resolveRepoForWorkspace } = require('./compose-flow');
const { fmtStatus, fmtHelp, fmtWelcome, esc } = require('./formatter');
const { card, kb, btn, wrapBtn, statusKeyboard, helpKeyboard, welcomeKeyboard, queueTaskKeyboard } = require('./ui');
const { createCardSession, cardReply, sendCard, deleteCard } = require('./card-session');

function ownerOnly(cfg) {
  return (ctx, next) => (ctx.from?.id === cfg.telegram.userId ? next() : undefined); // silently drop others
}

// Clamp an error description so a raw exception (e.g. a huge LLM/path string in
// its message) can never push the error card past Telegram's message-length cap.
function formatError(err) {
  const text = String(err?.message ?? err ?? '');
  return text.length > 500 ? `${text.slice(0, 500)}… (truncated)` : text;
}

function createBot(deps) {
  const { cfg, store, scheduler, registry } = deps;
  const bot = new Telegraf(cfg.telegram.botToken);
  bot.use(ownerOnly(cfg));

  // Anti-spam double-click deduplication
  const recentCallbacks = new Map();
  const cards = createCardSession();
  bot.use((ctx, next) => { ctx.cards = cards; return next(); });

  bot.use(async (ctx, next) => {
    if (ctx.callbackQuery) {
      const msgId = ctx.callbackQuery.message?.message_id;
      const data = ctx.callbackQuery.data;
      const key = `${ctx.from?.id}:${msgId}:${data}`;
      const now = Date.now();
      const last = recentCallbacks.get(key);
      if (last && (now - last) < 1200) {
        return ctx.answerCbQuery().catch(() => {});
      }
      recentCallbacks.set(key, now);
      if (recentCallbacks.size > 200) {
        for (const [k, t] of recentCallbacks) {
          if (now - t > 5000) recentCallbacks.delete(k);
        }
      }
    }
    return next();
  });

  const statusText = () =>
    fmtStatus(scheduler.stats(), store.byState('running'), store.byState('queued'), registry.lastTexts ?? new Map());
  const statusExtra = () => ({
    parse_mode: 'HTML',
    reply_markup: kb(
      ...statusKeyboard(scheduler.stats()),
      ...queueTaskKeyboard(store.byState('running'), store.byState('queued')),
    ),
  });

  bot.start(ctx => cardReply(ctx, ctx.cards, fmtWelcome(), { parse_mode: 'HTML', reply_markup: kb(...welcomeKeyboard()) }));
  bot.help(ctx => cardReply(ctx, ctx.cards, fmtHelp(), { parse_mode: 'HTML', reply_markup: kb(...helpKeyboard()) }));

  // back-to-menu: any card that edited this message back to the help menu lands here
  bot.action('cmd:help', async ctx => {
    await ctx.answerCbQuery();
    return cardReply(ctx, ctx.cards, fmtHelp(), { parse_mode: 'HTML', reply_markup: kb(...helpKeyboard()) });
  });

  bot.action('card:close', async ctx => {
    await ctx.answerCbQuery('Card closed');
    return deleteCard(ctx, cards, ctx.chat?.id || ctx.callbackQuery?.message?.chat?.id);
  });

  bot.command('status', ctx => cardReply(ctx, ctx.cards, statusText(), statusExtra()));

  // interactive status card: refresh / pause / resume edit the message in place
  bot.action('status:refresh', async ctx => {
    await ctx.answerCbQuery();
    return cardReply(ctx, ctx.cards, statusText(), statusExtra());
  });

  bot.action(/^(queue:pause|queue:resume)$/, async ctx => {
    await ctx.answerCbQuery();
    if (ctx.match[1] === 'queue:pause') scheduler.pause();
    else { scheduler.resume(); scheduler.pump(); }
    return cardReply(ctx, ctx.cards, statusText(), statusExtra());
  });

  // help-menu buttons: status edits in place, newtask starts a flow
  bot.action('cmd:status', async ctx => {
    await ctx.answerCbQuery();
    return cardReply(ctx, ctx.cards, statusText(), statusExtra());
  });

  // Start the guided task composer. `presetWs` (a workspace object) skips the
  // workspace picker and lands on the repo step — used by the "➕ New task here"
  // loop button so the next task reuses the SAME workspace (circular flow).
  async function startCompose(ctx, presetWs = null) {
    await deleteCard(ctx, cards, ctx.chat.id);
    const base = createFlow({ workspaces: cfg.workspaces, repos: cfg.github.repos, defaults: { mode: cfg.cline.mode } });
    let flow = base;
    if (presetWs) {
      // loop entry: reuse the workspace — always re-ask the GitHub publish
      // question so the owner can change the target between tasks.
      flow = { ...base, step: 'publish', ws: presetWs };
    }
    registry.flows.set(ctx.chat.id, flow);
    const sr = stepReply(flow);
    const head = presetWs
      ? `📂 <b>${esc(presetWs.name)}</b> · <code>${esc(presetWs.path)}</code>\n\n${sr.text}`
      : sr.text;
    const sent = await sendCard(ctx, cards, head, { parse_mode: 'HTML', reply_markup: { inline_keyboard: sr.buttons } });
    return sent;
  }
  bot.command('newtask', ctx => startCompose(ctx));
  bot.action('cmd:newtask', async ctx => {
    await ctx.answerCbQuery();
    return startCompose(ctx);
  });

  // Active-workspace picker: selects which workspace /do (and quick tasks) use.
  const wsRows = () => cfg.workspaces.map(w => ({
    text: w.name + (w.default ? ' ⭐' : '') + (registry.selectedWs === w.name ? ' ✓' : ''),
    callback_data: `selws:${w.name}`,
  }));
  const wsKeyboard = () => [...wsRows().map(r => [r]), [{ text: '🏠 Menu', callback_data: 'cmd:help' }]];

  bot.action('cmd:workspace', async ctx => {
    await ctx.answerCbQuery();
    return cardReply(ctx, ctx.cards, (registry.selectedWs
      ? `📂 Active workspace: <b>${esc(registry.selectedWs)}</b>\n`
      : 'Pick the workspace that <b>/do</b> uses (default has ⭐):'),
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: wsKeyboard() } });
  });

  bot.action(/^selws:(.+)$/, async ctx => {
    await ctx.answerCbQuery();
    const ws = cfg.workspaces.find(w => w.name === ctx.match[1]);
    if (!ws) return cardReply(ctx, ctx.cards, 'Unknown workspace.', { parse_mode: 'HTML' });
    registry.selectedWs = ws.name;
    return cardReply(ctx, ctx.cards,
      `✅ Active workspace: <b>${esc(ws.name)}</b> · <code>${esc(ws.path)}</code>\n\n` +
      `Quick path: /do &lt;prompt&gt;\n` +
      `Guided path: /newtask\n` +
      `Tap a button below to run either.`,
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: wsKeyboard() } });
  });

  // "➕ New task here" — the loop back to the top of the task lifecycle in the
  // same workspace, making the flow circular instead of a dead-end.
  bot.action(/^t:(.+):loop$/, async ctx => {
    await ctx.answerCbQuery();
    const id = ctx.match[1];
    const t = store.get(id);
    if (!t) return ctx.reply('Unknown task.', { parse_mode: 'HTML' });
    const ws = cfg.workspaces.find(w => w.path === t.workspace)
      ?? cfg.workspaces.find(w => w.default) ?? cfg.workspaces[0];
    if (ws) registry.selectedWs = ws.name; // keep /do on the same workspace
    return startCompose(ctx, ws);
  });

  // command modules must be registered BEFORE the catch-all text/photo handlers below,
  // otherwise bot.on('text') consumes command messages and the commands never fire
  require('./commands-tasks').registerTaskCommands(bot, { cfg, store, scheduler, runner: deps.runner, registry });
  require('./commands-engine').registerEngineCommands(bot, { cfg, store, runner: deps.runner, scheduler, registry, saveConfig: deps.saveConfig, omniroute: deps.omniroute });
  require('./commands-settings').registerSettingsCommands(bot, { cfg, store, scheduler, registry, saveConfig: deps.saveConfig });
  require('./commands-safety').registerSafetyCommands(bot, { cfg, store, runner: deps.runner, scheduler, shutdown: deps.shutdown });
  require('./commands-files').registerFileCommands(bot, { cfg, store });
  require('./commands-data').registerDataCommands(bot, { cfg, store, paths: cfg.paths });
  require('./commands-publish').registerPublishCommands(bot, { cfg, store, publisher: deps.publisher, registry });
  require('./commands-skills').registerSkillCommands(bot, { cfg, registry });

  async function runStep(ctx, input) {
    if (input.type === 'callback' && input.data?.startsWith('photo:start:')) {
      const fileId = input.data.slice('photo:start:'.length);
      const flow = { ...createFlow({ workspaces: cfg.workspaces, repos: cfg.github.repos }), photos: [fileId], photoFileId: fileId };
      registry.flows.set(ctx.chat.id, flow);
      const r = stepReply(flow);
      await sendCard(ctx, cards, r.text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: r.buttons } });
      return true;
    }
    const flow = registry.flows.get(ctx.chat.id);
    if (!flow) return false;
    const result = advance(flow, input);
    // compose-flow is a pure state machine: persist the advanced flow or it never leaves the first step
    registry.flows.set(ctx.chat.id, result.flow);
    const { reply, done } = result;
    if (done) {
      registry.flows.delete(ctx.chat.id);
      await deleteCard(ctx, cards, ctx.chat.id);
      const task = store.create(done);
      await scheduler.pump();
      const sent = await sendCard(ctx, cards, `🚀 Queued <b>${esc(task.id)}</b> — ${esc(task.name)}`, {
        parse_mode: 'HTML',
        reply_markup: kb([btn('📊 Status', 'cmd:status'), btn('✖️ Cancel', `t:${task.id}:cancel`)], [btn('➕ Another task', 'cmd:newtask'), btn('🏠 Menu', 'cmd:help')]),
      });
    } else if (reply.text) {
      // every wizard step edits the single active card in place — no message spam
      await sendCard(ctx, cards, reply.text,
        reply.buttons ? { parse_mode: 'HTML', reply_markup: { inline_keyboard: reply.buttons } } : { parse_mode: 'HTML' });
    }
    return true;
  }

  bot.on('callback_query', async ctx => {
    if (!(await runStep(ctx, { type: 'callback', data: ctx.callbackQuery.data }))) return ctx.answerCbQuery();
    return ctx.answerCbQuery();
  });

  bot.on('photo', async ctx => {
    const photo = ctx.message.photo?.[ctx.message.photo.length - 1]; // largest size
    if (!photo) return;

    // 1. Follow-up: photo reply to a done task's card
    const replied = ctx.message.reply_to_message?.message_id;
    if (replied) {
      const orig = store.all().find(t => t.tgMessageId === replied && t.state === 'done');
      if (orig) {
        const promptText = ctx.message.caption || 'Follow-up with attached image';
        const t = store.create({
          name: `follow-up: ${orig.name}`.slice(0, 60),
          prompt: promptText,
          workspace: orig.workspace,
          repo: orig.repo,
          followUpOf: orig.id,
          prevSummary: orig.summary,
          photos: [photo.file_id],
          imagePath: photo.file_id,
          mode: cfg.cline?.mode,
        });
        await scheduler.pump();
        return ctx.reply(`🔁 Follow-up queued as <b>${esc(t.id)}</b> with attached photo in the same workspace.`, {
          parse_mode: 'HTML',
          reply_markup: kb([btn('📊 Status', 'cmd:status'), btn('🏠 Menu', 'cmd:help')]),
        });
      }
    }

    // 2. Compose flow: capture photo during /newtask
    const handled = await runStep(ctx, { type: 'photo', fileId: photo.file_id });
    if (handled) {
      if (ctx.message.caption) await runStep(ctx, { type: 'text', text: ctx.message.caption });
      return;
    }

    // 3. Standalone photo outside compose flow: present interactive card
    return cardReply(ctx, cards, card({
      icon: '📷',
      title: 'Photo received',
      rows: [
        'Photo captured. Tap below to start a task with this photo attached:',
      ],
    }), {
      parse_mode: 'HTML',
      reply_markup: kb(
        [btn('➕ Start task with photo', `photo:start:${photo.file_id}`)],
        [btn('🏠 Menu', 'cmd:help')]
      ),
    });
  });

  bot.on('text', async ctx => {
    if (registry.pendingInput && registry.pendingInput.chatId === ctx.chat.id) {
      const pending = registry.pendingInput;
      const type = pending.type;
      const text = ctx.message.text.trim();
      registry.pendingInput = null;
      if (type === 'provider') {
        cfg.cline.provider = text;
        if (deps.runner) deps.runner.provider = text;
        deps.saveConfig(cfg);
        registry.modelListCache?.clear();
        const body = card({
          icon: '✅',
          title: 'Provider Updated',
          rows: [
            `Provider set to: <code>${esc(text)}</code>`,
            'Applies to NEW tasks.',
          ],
        });
        return cardReply(ctx, ctx.cards, body, {
          parse_mode: 'HTML',
          reply_markup: kb([btn('🧠 Pick Model', 'cmd:model'), btn('⬅️ Back to menu', 'cmd:help')]),
        });
      } else if (type === 'model') {
        cfg.cline.model = text;
        if (deps.runner) deps.runner.model = text;
        deps.saveConfig(cfg);
        registry.modelListCache?.clear();
        const body = card({
          icon: '✅',
          title: 'Model Updated',
          rows: [
            `Model set to: <code>${esc(text)}</code>`,
            `Provider: <code>${esc(cfg.cline.provider || 'default')}</code>`,
            'Applies to NEW tasks.',
          ],
        });
        return cardReply(ctx, ctx.cards, body, {
          parse_mode: 'HTML',
          reply_markup: kb(...wrapBtn([btn('🧠 Change Model', 'cmd:model'), btn('🔌 Provider', 'cmd:provider'), btn('⬅️ Back to menu', 'cmd:help')], 2)),
        });
      } else if (typeof pending.handler === 'function') {
        // custom input flows (e.g. publish "owner/repo") own their rendering
        return pending.handler(ctx, text);
      }
    }

    const { handleSkillMention } = require('./commands-skills');
    if (await handleSkillMention(ctx, ctx.message.text, cfg)) return;

    // follow-up: reply to a done task's message
    const replied = ctx.message.reply_to_message?.message_id;
    if (replied) {
      const orig = store.all().find(t => t.tgMessageId === replied && t.state === 'done');
      if (orig) {
        const t = store.create({ name: `follow-up: ${orig.name}`.slice(0, 60), prompt: ctx.message.text, workspace: orig.workspace, repo: orig.repo, followUpOf: orig.id, prevSummary: orig.summary, mode: cfg.cline?.mode });
        await scheduler.pump();
        return ctx.reply(`🔁 Follow-up queued as <b>${esc(t.id)}</b> in the same workspace.`, {
          parse_mode: 'HTML',
          reply_markup: kb([btn('📊 Status', 'cmd:status'), btn('🏠 Menu', 'cmd:help')]),
        });
      }
    }
    return runStep(ctx, { type: 'text', text: ctx.message.text });
  });

  bot.catch(err => {
    // tolerate both Telegraf shapes: the error itself, or { ctx, error }
    const e = err instanceof Error ? err : (err?.error ?? err);
    const chatId = err?.ctx?.chat?.id ?? cfg.telegram.userId;
    console.error('[bot]', e.message || e);
    bot.telegram.sendMessage(chatId,
      `⚠️ <b>TAO hit an error</b>\n<blockquote>${esc(formatError(e))}</blockquote>\n<i>The queue keeps running — check /status for progress.</i>`,
      { parse_mode: 'HTML', reply_markup: kb([btn('📊 Status', 'cmd:status'), btn('🏠 Menu', 'cmd:help')]) }).catch(() => {});
  });
  return bot;
}

module.exports = { createBot, ownerOnly, formatError };
