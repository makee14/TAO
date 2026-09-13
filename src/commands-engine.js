'use strict';
const { exec, execFile } = require('node:child_process');
const { fmtOmniroute, esc } = require('./formatter');
const { card, kv, kb, btn, wrapBtn, providerKeyboard, modelKeyboard, omnirouteKeyboard, modeKeyboard, panicConfirmKeyboard } = require('./ui');
const { cardReply, deleteCard } = require('./card-session');
const {
  OMNI_URL, OMNI_PROVIDER, BASE_PATH,
  checkHealth, waitForHealth, startService, stopService, ensureProviderConfigured,
} = require('./omniroute');
const { getAvailableProviders, getAvailableModels, getClineSettingsDir } = require('./cline-discovery');

function parseModelArg(text = '') {
  const val = text.split(/\s+/)[1];
  if (!val) return { show: true };
  return { value: val === 'none' ? '' : val };
}

function buildPanicPlan(store) {
  const running = store.byState('running');
  const queued = store.byState('queued');
  return { pids: running.map(t => t.pid).filter(Boolean), cancelIds: [...running, ...queued].map(t => t.id) };
}

// exec wrapper for the omniroute controller: resolves stdout, rejects on error.
const omniExec = () => async (cmd, args) => new Promise((res, rej) =>
  execFile(cmd, args, { windowsHide: true }, (e, o) => (e ? rej(new Error(String(o || e))) : res(o ?? ''))));

function registerEngineCommands(bot, { cfg, store, runner, scheduler, registry, saveConfig, omniroute }) {
  // Resolve real-vs-injected controller: tests pass a fake omniroute so no
  // real process launch, HTTP call or health wait ever runs in the suite.
  const omni = omniroute ?? {
    checkHealth, waitForHealth, startService, stopService, ensureProviderConfigured,
  };
  registry.modelListCache = new Map(); // chatId -> models[] (exposed so bot.js can evict on provider change)
  const modelListCache = registry.modelListCache;
  const clearModelCache = () => modelListCache.clear();

  const showProviderCard = async (ctx, page = 1) => {
    const providers = getAvailableProviders();
    const current = cfg.cline.provider || '';
    const body = card({
      icon: '🔌',
      title: 'Cline Providers',
      meta: 'Select provider for your AI coding tasks',
      rows: [
        `Active provider: <code>${esc(current || '(cline auth default)')}</code>`,
        'Tap a provider below to set it:',
      ],
    });
    return cardReply(ctx, ctx.cards, body, {
      parse_mode: 'HTML',
      reply_markup: kb(...providerKeyboard(providers, current, page, 4)),
    });
  };

  const showModelCard = async (ctx, page = 1) => {
    const provider = cfg.cline.provider || 'openai-compatible';
    const models = getAvailableModels(provider);
    const chatId = ctx.chat?.id || ctx.callbackQuery?.message?.chat?.id || 0;

    if (models.length === 0) {
      const body = card({
        icon: '🧠',
        title: 'Cline Models',
        meta: `Provider: ${esc(provider)}`,
        rows: [
          `Active model: <code>${esc(cfg.cline.model || '(cline auth default)')}</code>`,
          `No model catalog for <code>${esc(provider)}</code> — set one with <code>/model &lt;model-id&gt;</code> or tap Write Model.`,
        ],
      });
      return cardReply(ctx, ctx.cards, body, {
        parse_mode: 'HTML',
        reply_markup: kb(...wrapBtn([btn('✏️ Write Model', 'model:custom'), btn('🏠 Menu', 'cmd:help')], 2)),
      });
    }

    modelListCache.set(chatId, models);

    const current = cfg.cline.model || '';
    const body = card({
      icon: '🧠',
      title: 'Cline Models',
      meta: `Provider: ${esc(provider)}`,
      rows: [
        `Active model: <code>${esc(current || '(cline auth default)')}</code>`,
        `Select a model for provider <code>${esc(provider)}</code>:`,
      ],
    });
    return cardReply(ctx, ctx.cards, body, {
      parse_mode: 'HTML',
      reply_markup: kb(...modelKeyboard(models, current, page, 5)),
    });
  };

  bot.command('provider', async ctx => {
    const a = parseModelArg(ctx.message.text);
    if (a.show) return showProviderCard(ctx);
    cfg.cline.provider = a.value;
    if (runner) runner.provider = a.value;
    saveConfig(cfg);
    const body = card({
      icon: '✅',
      title: 'Provider Updated',
      rows: [
        `Provider set to: <code>${esc(a.value || '(default)')}</code>`,
        'Applies to NEW tasks.',
      ],
    });
    return cardReply(ctx, ctx.cards, body, {
      parse_mode: 'HTML',
      reply_markup: kb([btn(`🧠 Pick Model for ${a.value || 'provider'}`, 'cmd:model')], [btn('⬅️ Back to menu', 'cmd:help')]),
    });
  });

  bot.action('cmd:provider', async ctx => {
    await ctx.answerCbQuery();
    return showProviderCard(ctx);
  });

  bot.action(/^selprov:(.+)$/, async ctx => {
    const provId = ctx.match[1];
    cfg.cline.provider = provId === 'none' ? '' : provId;
    if (runner) runner.provider = cfg.cline.provider;
    saveConfig(cfg);
    clearModelCache();
    await ctx.answerCbQuery(`Provider set to ${provId}`);
    return showProviderCard(ctx);
  });

  bot.command('model', async ctx => {
    const a = parseModelArg(ctx.message.text);
    if (a.show) return showModelCard(ctx, 1);
    cfg.cline.model = a.value;
    if (runner) runner.model = a.value;
    saveConfig(cfg);
    const body = card({
      icon: '✅',
      title: 'Model Updated',
      rows: [
        `Model set to: <code>${esc(a.value || '(default)')}</code>`,
        'Applies to NEW tasks.',
      ],
    });
    return cardReply(ctx, ctx.cards, body, {
      parse_mode: 'HTML',
      reply_markup: kb([btn('🔌 Switch Provider', 'cmd:provider'), btn('⬅️ Back to menu', 'cmd:help')]),
    });
  });

  bot.action('cmd:model', async ctx => {
    await ctx.answerCbQuery();
    return showModelCard(ctx, 1);
  });

  bot.action(/^selmod:(\d+)$/, async ctx => {
    const idx = parseInt(ctx.match[1], 10);
    const chatId = ctx.chat?.id || ctx.callbackQuery?.message?.chat?.id || 0;
    let models = registry.modelListCache?.get(chatId);
    if (!models) {
      models = getAvailableModels(cfg.cline.provider);
    }
    const chosen = models[idx];
    if (!chosen) {
      await ctx.answerCbQuery('Model selection expired. Please try again.');
      return showModelCard(ctx, 1);
    }
    cfg.cline.model = chosen;
    if (runner) runner.model = chosen;
    saveConfig(cfg);
    await ctx.answerCbQuery(`Model set to ${chosen}`);
    const body = card({
      icon: '✅',
      title: 'Model Selected',
      rows: [
        `Model set to: <code>${esc(chosen)}</code>`,
        `Provider: <code>${esc(cfg.cline.provider || 'default')}</code>`,
        'Applies to NEW tasks.',
      ],
    });
    return cardReply(ctx, ctx.cards, body, {
      parse_mode: 'HTML',
      reply_markup: kb(...wrapBtn([btn('🧠 Change Model', 'cmd:model'), btn('🔌 Provider', 'cmd:provider'), btn('⬅️ Back to menu', 'cmd:help')], 2)),
    });
  });

  bot.action(/^modp:(\d+)$/, async ctx => {
    await ctx.answerCbQuery();
    const page = parseInt(ctx.match[1], 10) || 1;
    return showModelCard(ctx, page);
  });

  bot.action(/^provp:(\d+)$/, async ctx => {
    await ctx.answerCbQuery();
    const page = parseInt(ctx.match[1], 10) || 1;
    return showProviderCard(ctx, page);
  });

  bot.action('prov:custom', async ctx => {
    await ctx.answerCbQuery();
    const chatId = ctx.chat?.id || ctx.callbackQuery?.message?.chat?.id || 0;
    registry.pendingInput = { type: 'provider', chatId };
    const body = card({
      icon: '✏️',
      title: 'Write Custom Provider',
      rows: [
        'Send provider ID as text message now.',
        'Example: <code>anthropic</code> or <code>openai-compatible</code>',
      ],
    });
    return cardReply(ctx, ctx.cards, body, {
      parse_mode: 'HTML',
      reply_markup: kb([btn('✖️ Cancel', 'prov:cancel_input'), btn('🔌 Back to providers', 'cmd:provider')]),
    });
  });

  bot.action('prov:cancel_input', async ctx => {
    await ctx.answerCbQuery('Cancelled input');
    registry.pendingInput = null;
    return showProviderCard(ctx);
  });

  bot.action('model:custom', async ctx => {
    await ctx.answerCbQuery();
    const chatId = ctx.chat?.id || ctx.callbackQuery?.message?.chat?.id || 0;
    registry.pendingInput = { type: 'model', chatId };
    const body = card({
      icon: '✏️',
      title: 'Write Custom Model',
      rows: [
        'Send model ID as text message now.',
        'Example: <code>claude-3-7-sonnet-20250219</code>',
      ],
    });
    return cardReply(ctx, ctx.cards, body, {
      parse_mode: 'HTML',
      reply_markup: kb([btn('✖️ Cancel', 'model:cancel_input'), btn('🧠 Back to models', 'cmd:model')]),
    });
  });

  bot.action('model:cancel_input', async ctx => {
    await ctx.answerCbQuery('Cancelled input');
    registry.pendingInput = null;
    return showModelCard(ctx);
  });

  const showOmnirouteCard = async (ctx, { error = null } = {}) => {
    let isRunning = false;
    try { isRunning = await omni.checkHealth(); } catch { /* rendered as Stopped */ }
    const rows = error ? [`⚠️ ${esc(error)}`] : [];
    return cardReply(ctx, ctx.cards, `${rows.join('\n')}\n${fmtOmniroute({ running: isRunning, url: OMNI_URL })}`, {
      parse_mode: 'HTML',
      reply_markup: kb(...omnirouteKeyboard(isRunning)),
    });
  };

  bot.action('cmd:omniroute', async ctx => {
    await ctx.answerCbQuery();
    return showOmnirouteCard(ctx);
  });

  bot.action('omni:refresh', async ctx => {
    await ctx.answerCbQuery('Refreshing status...');
    return showOmnirouteCard(ctx);
  });

  bot.action('omni:start', async ctx => {
    await ctx.answerCbQuery('Starting OmniRoute…');
    try {
      await omni.startService(omniExec());
      const up = await omni.waitForHealth({});
      return showOmnirouteCard(ctx, up ? {} : { error: 'process launched but never answered on ' + OMNI_URL });
    } catch (e) {
      return showOmnirouteCard(ctx, { error: `failed to start: ${e.message}` });
    }
  });

  bot.action('omni:stop', async ctx => {
    await ctx.answerCbQuery('Stopping OmniRoute…');
    try {
      await omni.stopService(omniExec());
    } catch (e) {
      return showOmnirouteCard(ctx, { error: `failed to stop: ${e.message}` });
    }
    return showOmnirouteCard(ctx);
  });

  bot.action('omni:use', async ctx => {
    await ctx.answerCbQuery('Switching provider…');
    try {
      omni.ensureProviderConfigured({ settingsDir: getClineSettingsDir(), baseUrl: OMNI_URL + BASE_PATH, model: cfg.cline.model });
      cfg.cline.provider = OMNI_PROVIDER;
      if (runner) runner.provider = OMNI_PROVIDER;
      saveConfig(cfg);
    } catch (e) {
      return showOmnirouteCard(ctx, { error: `provider config failed: ${e.message}` });
    }
    return showModelCard(ctx);
  });

  // 🚨 Emergency panic stop: show confirmation card first, execute on panic:confirm
  const showPanicCard = ctx => cardReply(ctx, ctx.cards, card({
    icon: '🚨',
    title: 'Emergency Panic Stop',
    rows: ['Kill all running agents and pause the queue?', 'This cannot be undone.'],
  }), { parse_mode: 'HTML', reply_markup: kb(...panicConfirmKeyboard()) });

  bot.command('panic', ctx => showPanicCard(ctx));

  bot.action('panic:confirm', async ctx => {
    await ctx.answerCbQuery('Panic stopping…');
    const plan = buildPanicPlan(store);
    await Promise.all(plan.pids.map(pid => runner.abort(pid)));
    for (const id of plan.cancelIds) store.update(id, { state: 'cancelled', pid: null });
    if (scheduler?.pause) { scheduler.pause(); scheduler.pump(); }
    return cardReply(ctx, ctx.cards, card({
      icon: '🚨',
      title: 'Panic stop complete',
      rows: [
        kv('🛑', `${plan.pids.length} agent process(es) killed`),
        kv('🚫', `${plan.cancelIds.length} task(s) cancelled`),
        '⏸ Queue paused — /resume to continue.',
      ],
    }), { parse_mode: 'HTML', reply_markup: kb([btn('▶️ Resume queue', 'queue:resume'), btn('🏠 Menu', 'cmd:help')]) });
  });

  bot.command('mode', async ctx => {
    const current = cfg.cline.mode || 'act';
    const body = card({
      icon: '📐',
      title: 'Execution Mode',
      rows: [
        `Current mode: <code>${esc(current)}</code>`,
        'Plan mode forces agent to plan without modifying files. Act mode allows normal execution.',
      ],
    });
    return cardReply(ctx, ctx.cards, body, {
      parse_mode: 'HTML',
      reply_markup: kb(...modeKeyboard(current)),
    });
  });

  bot.action(/^setmode:(plan|act)$/, async ctx => {
    const mode = ctx.match[1];
    cfg.cline.mode = mode;
    saveConfig(cfg);
    await ctx.answerCbQuery(`Mode set to ${mode}`);
    const body = card({
      icon: '📐',
      title: 'Execution Mode',
      rows: [
        `Mode set to: <code>${esc(mode)}</code>`,
        'Applies to NEW tasks.',
      ],
    });
    return cardReply(ctx, ctx.cards, body, {
      parse_mode: 'HTML',
      reply_markup: kb(...modeKeyboard(mode)),
    });
  });
}

module.exports = { parseModelArg, buildPanicPlan, registerEngineCommands };
