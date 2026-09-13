'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { execFile } = require('node:child_process');
const { loadConfig } = require('./config');
const { TaskStore } = require('./task-store');
const { Scheduler } = require('./scheduler');
const { CliRunner, resolveSpawn } = require('./cli-runner');
const { Publisher } = require('./publisher');
const { ShutdownCtl } = require('./safety');
const { closeOpenWindows } = require('./close-windows');
const { createBot } = require('./bot');
const { createRunTask, bootSequence } = require('./orchestrator');
const { createCardSession } = require('./card-session');
const { kb, healthKeyboard } = require('./ui');
const { healthText } = require('./commands-safety');

const cfgPath = path.join(__dirname, '..', 'config.json');
const cfg = loadConfig(cfgPath); // exits with a friendly ConfigError if missing/invalid
const saveConfig = c => fs.writeFileSync(cfgPath, JSON.stringify(c, null, 2));

const store = new TaskStore(path.resolve(cfg.paths.taskStore));
// The agent hook (managed via /hook) is loaded once and injected into every
// task prompt until TAO restarts.
const hook = (() => {
  try {
    const p = path.resolve(cfg.paths.hook ?? './data/hook.md');
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
  } catch { return ''; }
})();
const publisher = new Publisher({ mirrorDir: path.resolve(cfg.paths.publishMirror), pat: cfg.github.pat, defaultBranch: cfg.github.defaultBranch, allowCreate: cfg.github.allowCreate });
const runner = new CliRunner({
  clineBin: cfg.cline.bin,
  provider: cfg.cline.provider, model: cfg.cline.model,
  visionProvider: cfg.cline.visionProvider, visionModel: cfg.cline.visionModel,
  retries: cfg.cline.retries, timeoutSec: cfg.cline.timeoutSec,
  thinking: cfg.cline.thinking, planThinking: cfg.cline.planThinking, actThinking: cfg.cline.actThinking,
  runsDir: path.resolve(cfg.paths.runs), hook,
});
const shutdown = new ShutdownCtl({
  graceSec: cfg.safety.shutdownGraceSec,
  closeWindows: cfg.safety.closeWindowsBeforeShutdown
    ? async () => closeOpenWindows({
        exec: (cmd, args) => new Promise((res, rej) =>
          execFile(cmd, args, { windowsHide: true }, e => e ? rej(new Error(String(e))) : res(''))),
      })
    : null,
});
const registry = { flows: new Map(), msgIds: [], lastTexts: new Map() }; // lastTexts: taskId -> last agent text (live /status tail)

let botRef = null; // bot and scheduler reference each other -> assign refs in order
const telegram = { // fail-safe proxy so the orchestrator works before/without a live bot
  sendMessage: (...a) => (botRef ? botRef.telegram.sendMessage(...a) : Promise.resolve({ message_id: null })),
  sendDocument: (...a) => (botRef ? botRef.telegram.sendDocument(...a) : Promise.resolve({ message_id: null })),
  getFileLink: (...a) => (botRef ? botRef.telegram.getFileLink(...a) : Promise.reject(new Error('Bot not live'))),
  editMessageText: (...a) => (botRef ? botRef.telegram.editMessageText(...a) : Promise.resolve({ message_id: null })),
  deleteMessage: (...a) => (botRef ? botRef.telegram.deleteMessage(...a) : Promise.resolve()),
};

const eventCards = createCardSession(); // one card per task lifecycle
const runTask = createRunTask({ cfg, store, runner, publisher, telegram, eventCards, lastTexts: registry.lastTexts, saveConfig });

const scheduler = new Scheduler({
  store, maxParallel: cfg.orchestration.maxParallel,
  circuitBreaker: cfg.orchestration.circuitBreaker,
  onCircuitOpen: streak => botRef?.telegram.sendMessage(cfg.telegram.userId,
    `🔌 Circuit breaker OPEN after ${streak} consecutive failures — queue paused. Fix, then /resume.`).catch(() => {}),
  onRun: runTask,
});

const bot = createBot({ cfg, store, scheduler, runner, publisher, shutdown, registry, saveConfig });
botRef = bot;

// boot preflight: warn when the installed cline drifts from the pinned version
const preflight = resolveSpawn(cfg.cline.bin, ['--version']);
execFile(preflight.command, preflight.spawnArgs, { windowsHide: true }, (e, out) => {
  const v = (out ?? '').trim();
  if (!e && v && !v.includes(cfg.cline.version)) console.warn(`WARN: cline ${v} != pinned ${cfg.cline.version}`);
});

let healthInterval = null;
if (cfg.heartbeat?.enabled && (cfg.heartbeat?.intervalMin ?? 0) > 0) {
  const ms = cfg.heartbeat.intervalMin * 60 * 1000;
  healthInterval = setInterval(async () => {
    try {
      await telegram.sendMessage(cfg.telegram.userId, await healthText(scheduler),
        { parse_mode: 'HTML', reply_markup: kb(...healthKeyboard()) }).catch(() => {});
    } catch { /* health ping send swallow */ }
  }, ms);
}

// Telegraf's launch promise resolves only when the bot STOPS — pass the boot
// sequence as the onLaunch callback so it actually runs while the bot is alive.
bot.launch({}, async () => {
  // Native "/" command menu: typing a slash shows tap-to-fill suggestions —
  // the closest Bot API equivalent to "as I type, paste a suggestion".
  await bot.telegram.setMyCommands([
    { command: 'newtask', description: '🆕 Guided task composer (mode → workspace → publish)' },
    { command: 'do', description: '⚡ Quick task in the active workspace' },
    { command: 'status', description: '📊 Live progress and agent tail' },
    { command: 'list', description: '📋 Recent tasks and states' },
    { command: 'file', description: '📁 Browse or download a task’s changed files' },
    { command: 'resume', description: '▶️ Resume the paused queue' },
    { command: 'settings', description: '⚙️ All settings and controls in one place (buttons)' },
    { command: 'mode', description: '📐 Plan vs act mode' },
    { command: 'provider', description: '🔌 Switch AI provider' },
    { command: 'model', description: '✨ Switch model' },
    { command: 'health', description: '🩺 PC health, disk, and queue status' },
    { command: 'help', description: '🏠 Full command menu' },
  ]).catch(() => {});
  await bootSequence({ store, scheduler, telegram, userId: cfg.telegram.userId });
});

process.on('SIGINT', () => {
  if (healthInterval) clearInterval(healthInterval);
  bot.stop();
  process.exit(0);
});
