'use strict';
const { buildShutdownPlan } = require('./safety');
const { diskFree } = require('./system-info');
const { esc } = require('./formatter');
const { card, kv, kb, healthKeyboard, menuExitRow } = require('./ui');
const { cardReply } = require('./card-session');

async function healthText(scheduler) {
  const s = scheduler.stats();
  let disk = '?';
  try { disk = `${((await diskFree('C:')) / 1073741824).toFixed(1)} GB free`; } catch { /* wmi hiccup */ }
  return card({
    icon: '🩺',
    title: 'Health',
    rows: [
      kv('💾', `Disk C: ${disk}`),
      kv('⏱', `Uptime: ${Math.round(process.uptime() / 60)} min (this process)`),
      `📊 Queue: running ${s.running} · queued ${s.queued} · blocked ${s.blocked}` +
        (s.pauseReason === 'breaker' ? `\n🛑 CIRCUIT OPEN (${s.failStreak} fails) — auto-retries; check the last run log` :
          s.pauseReason === 'manual' ? '\n⏸ PAUSED (manual) — /resume to continue' : s.paused ? '\n⏸ PAUSED' : ''),
    ],
  });
}

function registerSafetyCommands(bot, { cfg, store, runner, scheduler, shutdown }) {
  bot.command('shutdown', async ctx => {
    if (!cfg.safety.allowShutdownPc) return cardReply(ctx, ctx.cards, '⛔ PC shutdown disabled in config (safety.allowShutdownPc).', { parse_mode: 'HTML', reply_markup: kb(...menuExitRow()) });
    if (ctx.message.text.includes('now')) {
      const plan = buildShutdownPlan(store, 'force');
      await Promise.all(plan.pids.map(pid => runner.abort(pid)));
      for (const id of plan.cancelIds) store.update(id, { state: 'cancelled', pid: null });
      scheduler.pause();
      await cardReply(ctx, ctx.cards, `💣 FORCED shutdown: killed ${plan.pids.length}, cancelled ${plan.cancelIds.length}. Down in ${cfg.safety.shutdownGraceSec}s — /abortshutdown to stop.`);
      return shutdown.forceShutdown();
    }
    const plan = buildShutdownPlan(store, 'drain');
    const lines = plan.runningIds.length ? plan.runningIds.map(id => `• ${esc(store.get(id).name)} (${esc(id)})`).join('\n') : '(nothing running)';
    await cardReply(ctx, ctx.cards, card({
      icon: '🔌',
      title: 'Shutdown requested',
      rows: [`Running (must finish first):\n${lines}`, kv('⏳', `Queued ${plan.queuedIds.length} will NOT run after shutdown`)],
      footer: '<i>Proceed?</i>',
    }), {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '✅ Confirm shutdown', callback_data: 'shutdown:confirm' }, { text: '❌ Cancel', callback_data: 'shutdown:abort' }]] },
    });
  });

  bot.action(/^(shutdown:confirm|shutdown:abort)$/, async ctx => {
    await ctx.answerCbQuery();
    if (ctx.callbackQuery.data === 'shutdown:abort') return cardReply(ctx, ctx.cards, '❌ Shutdown cancelled.', { parse_mode: 'HTML', reply_markup: kb(...menuExitRow()) });
    scheduler.pause(); // refuse new tasks while draining
    await cardReply(ctx, ctx.cards, '⏳ Draining running tasks…');
    await shutdown.requestDrain(store);
    await cardReply(ctx, ctx.cards, `🔌 All agents finished. Shutting down in ${cfg.safety.shutdownGraceSec}s — /abortshutdown to cancel.`, { parse_mode: 'HTML', reply_markup: kb(...menuExitRow()) });
    return shutdown.forceShutdown();
  });

  bot.command('abortshutdown', async ctx => {
    await shutdown.abort();
    return cardReply(ctx, ctx.cards, '🛑 Pending shutdown aborted.', { parse_mode: 'HTML', reply_markup: kb(...menuExitRow()) });
  });

  bot.command('health', async ctx => cardReply(ctx, ctx.cards, await healthText(scheduler), { parse_mode: 'HTML', reply_markup: kb(...healthKeyboard()) }));
  bot.action('cmd:health', async ctx => {
    await ctx.answerCbQuery();
    return cardReply(ctx, ctx.cards, await healthText(scheduler), { parse_mode: 'HTML', reply_markup: kb(...healthKeyboard()) });
  });
}

module.exports = { registerSafetyCommands, healthText };
