'use strict';
const { esc } = require('./formatter');
const { card, kv, kb, btn, menuExitRow } = require('./ui');
const { settingsKeyboard, thinkingKeyboard, agentKeyboard, geminiKeysKeyboard, modeKeyboard } = require('./ui');
const { cardReply } = require('./card-session');
const { keysOf, activeGeminiKey, rotateGeminiKey, applyGeminiKey } = require('./gemini-keys');

const THINKING_LEVELS = ['none', 'low', 'medium', 'high', 'xhigh'];

// Update only the targeted thinking phase; returns null for invalid input so
// callers can reject instead of writing garbage into the config.
function applyThinking(cfg, name, level) {
  if (!THINKING_LEVELS.includes(level)) return null;
  const key = name === 'plan' ? 'planThinking' : name === 'act' ? 'actThinking' : null;
  if (!key) return null;
  cfg.cline[key] = level;
  return cfg.cline;
}

// ── Gemini key management (delegates to gemini-keys.js) ─────────────────────

function registerSettingsCommands(bot, { cfg, store, scheduler, registry, saveConfig }) {
  const persist = () => { if (typeof saveConfig === 'function') saveConfig(cfg); };

  const showSettings = ctx => {
    const body = card({
      icon: '⚙️',
      title: 'Settings',
      meta: 'everything the agent uses, one card away',
      rows: [
        kv('🤖 Agent mode', esc(cfg.cline.mode || 'act')),
        kv('🧠 Thinking', `plan ${esc(cfg.cline.planThinking || 'high')} · act ${esc(cfg.cline.actThinking || 'medium')}`),
        kv('✨ Model', esc(cfg.cline.model || '(cline default)')),
        kv('🔌 Provider', esc(cfg.cline.provider || '(cline default)')),
        kv('🔑 Gemini keys', String(keysOf(cfg).length)),
        kv('🧩 Skills', 'manage with /skill'),
        kv('🪝 Hook', 'manage with /hook'),
      ],
      footer: '<i>Pick a group below. Every sub-card can return here.</i>',
    });
    return cardReply(ctx, ctx.cards, body, { parse_mode: 'HTML', reply_markup: kb(...settingsKeyboard()) });
  };

  const showThinking = ctx => {
    const body = card({
      icon: '🧠',
      title: 'Thinking Mode',
      rows: [
        kv('🧠 Plan phase', esc(cfg.cline.planThinking || 'high')),
        kv('🎯 Act phase', esc(cfg.cline.actThinking || 'medium')),
        '',
        '<i>If your model doesn\'t expose a thinking toggle, Cline simply ignores this level — safe to try anything.</i>',
      ],
      footer: '<i>Plan thinking drives how the agent designs; Act thinking drives how it codes.</i>',
    });
    return cardReply(ctx, ctx.cards, body, {
      parse_mode: 'HTML',
      reply_markup: kb(...thinkingKeyboard(cfg.cline.actThinking || 'medium', cfg.cline.planThinking || 'high')),
    });
  };

  const showAgent = ctx => {
    const body = card({
      icon: '🤖',
      title: 'Agent Behavior',
      rows: [
        kv('📐 Mode', esc(cfg.cline.mode || 'act')),
        kv('🧠 Thinking', `plan ${esc(cfg.cline.planThinking || 'high')} · act ${esc(cfg.cline.actThinking || 'medium')}`),
        kv('🔌 Provider', esc(cfg.cline.provider || '(cline default)')),
        kv('✨ Model', esc(cfg.cline.model || '(cline default)')),
        kv('📊 Queue', (() => { try { const s = scheduler.stats(); return `running ${s.running} · queued ${s.queued}`; } catch { return 'n/a'; } })()),
      ],
      footer: '<i>These apply to NEW tasks; running tasks keep their settings.</i>',
    });
    return cardReply(ctx, ctx.cards, body, { parse_mode: 'HTML', reply_markup: kb(...agentKeyboard()) });
  };

  const showGeminiKeys = ctx => {
    const keys = keysOf(cfg);
    const body = card({
      icon: '🔑',
      title: 'Gemini API Keys',
      rows: [
        keys.length ? kv('🔑 Active', `***${String(keys[0]).slice(-6)}`) : 'No keys configured.',
        keys.length > 1 ? kv('🗃 Pool', `${keys.length} keys — Rotate switches to the next`) : (keys.length ? 'Add a second key to enable rotation.' : ''),
        '',
        '<i>On quota errors the orchestrator can rotate automatically (add 2+ keys).</i>',
      ],
      footer: '<i>Keys are stored in config.json and applied to Cline\'s credentials file.</i>',
    });
    return cardReply(ctx, ctx.cards, body, { parse_mode: 'HTML', reply_markup: kb(...geminiKeysKeyboard(keys, 0)) });
  };

  bot.command('settings', ctx => showSettings(ctx));

  bot.action('cmd:settings', async ctx => { await ctx.answerCbQuery(); return showSettings(ctx); });
  bot.action('settings:main', async ctx => { await ctx.answerCbQuery(); return showSettings(ctx); });
  bot.action('settings:agent', async ctx => { await ctx.answerCbQuery(); return showAgent(ctx); });
  bot.action('settings:thinking', async ctx => { await ctx.answerCbQuery(); return showThinking(ctx); });
  bot.action('settings:gemini', async ctx => { await ctx.answerCbQuery(); return showGeminiKeys(ctx); });

  // The engine module owns setmode: actions; the hub just renders the picker
  // so mode changes come back through it.
  bot.action('settings:mode', async ctx => {
    await ctx.answerCbQuery();
    return cardReply(ctx, ctx.cards, card({
      icon: '📐', title: 'Execution Mode',
      rows: [`Current: <code>${esc(cfg.cline.mode || 'act')}</code>`, 'Plan analyzes first; Act implements right away.'],
    }), { parse_mode: 'HTML', reply_markup: kb(...modeKeyboard(cfg.cline.mode || 'act')) });
  });
  bot.action('settings:github', async ctx => {
    await ctx.answerCbQuery();
    const repos = cfg.github?.repos ?? [];
    return cardReply(ctx, ctx.cards, card({
      icon: '🚀', title: 'GitHub',
      rows: [
        kv('📦 Repos', String(repos.length)),
        kv('🌿 Default branch', esc(cfg.github?.defaultBranch ?? 'main')),
        kv('➕ Create missing repos', cfg.github?.allowCreate === false ? 'off' : 'on (PAT)'),
        '',
        'Publish targets are chosen per task in /newtask (or by using the publish command).',
      ],
    }), { parse_mode: 'HTML', reply_markup: kb([btn('🚀 Publish a task', 'cmd:publishMenu'), btn('🏠 Menu', 'cmd:help')]) });
  });

  bot.action(/^think:set:(act|plan):(low|medium|high)$/, async ctx => {
    const [, phase, level] = ctx.match;
    const next = applyThinking(cfg, phase, level);
    if (!next) return ctx.answerCbQuery('Invalid level');
    persist();
    await ctx.answerCbQuery(`${phase} thinking → ${level}`);
    return showThinking(ctx);
  });

  // ── Gemini key management ────────────────────────────────────────────────
  bot.action('gemini:add', async ctx => {
    await ctx.answerCbQuery();
    const chatId = ctx.chat?.id || ctx.callbackQuery?.message?.chat?.id || 0;
    registry.pendingInput = {
      type: 'geminiKey',
      chatId,
      handler: (inputCtx, text) => {
        const key = String(text || '').trim();
        if (!/^[\w-]{20,}$/.test(key)) {
          return cardReply(inputCtx, inputCtx.cards, '⚠️ That doesn\'t look like an API key. Send the key text itself (20+ characters), or tap below:', { parse_mode: 'HTML', reply_markup: kb(...menuExitRow()) });
        }
        cfg.cline.geminiKeys = [...keysOf(cfg), key];
        persist();
        applyGeminiKey(cfg);
        return showGeminiKeys(inputCtx);
      },
    };
    return cardReply(ctx, ctx.cards, card({
      icon: '➕', title: 'Add Gemini Key',
      rows: ['Send the API key in your next message.', 'It is stored locally in config.json only.'],
    }), { parse_mode: 'HTML', reply_markup: kb(...menuExitRow()) });
  });

  bot.action('gemini:rotate', async ctx => {
    const next = rotateGeminiKey(cfg, { saveConfig });
    await ctx.answerCbQuery(next ? 'Rotated ✅' : 'Add a second key first');
    return showGeminiKeys(ctx);
  });

  bot.action('gemini:remove', async ctx => {
    const keys = keysOf(cfg);
    if (keys.length) {
      cfg.cline.geminiKeys = keys.slice(1);
      persist();
    }
    await ctx.answerCbQuery(keys.length ? 'Removed active key' : 'No keys');
    return showGeminiKeys(ctx);
  });

  bot.action(/^gemini:pick:(\d+)$/, async ctx => {
    const i = parseInt(ctx.match[1], 10);
    const keys = keysOf(cfg);
    if (i > 0 && i < keys.length) {
      cfg.cline.geminiKeys = [keys[i], ...keys.filter((_, j) => j !== i)];
      persist();
      applyGeminiKey(cfg);
    }
    await ctx.answerCbQuery('Key activated');
    return showGeminiKeys(ctx);
  });
}

module.exports = { registerSettingsCommands, applyThinking, keysOf, activeGeminiKey, rotateGeminiKey, applyGeminiKey };