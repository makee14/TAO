'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

class ConfigError extends Error {
  constructor(key, message) { super(`${key}: ${message}`); this.key = key; }
}

const DEFAULTS = {
  telegram: { parseMode: 'HTML' },
  cline: { bin: 'cline', version: '3.0.61', provider: 'gemini', model: 'gemini-3.5-flash', visionProvider: 'gemini', visionModel: 'gemini-3.5-flash', retries: 3, timeoutSec: 1800, thinking: 'medium', planThinking: 'high', actThinking: 'medium', mode: 'act', autoApprove: 'all', geminiKeys: [] },
  github: { defaultBranch: 'main', allowCreate: true, repos: [] },
  orchestration: { maxParallel: 3, circuitBreaker: { enabled: true, maxConsecutiveFailures: 3, cooldownSec: 90 }, publishConfirmation: true },
  paths: { taskStore: './data/tasks.json', runs: './data/runs', attachments: './data/attachments', publishMirror: './data/publish', skills: path.join(os.homedir(), '.cline', 'skills'), hook: './data/hook.md' },
  retention: { days: 30 },
  progress: { debounceSec: 30, autoDeleteProgress: true },
  safety: { allowShutdownPc: true, shutdownGraceSec: 60, closeWindowsBeforeShutdown: true },
  heartbeat: { enabled: false, intervalMin: 60 },
};

function isNonEmptyString(v) { return typeof v === 'string' && v.trim().length > 0; }

function validateConfig(raw) {
  const errors = [];
  const err = (key, message) => errors.push({ key, message });
  if (!raw || typeof raw !== 'object') { err('$', 'config must be a JSON object'); return { errors }; }
  if (!isNonEmptyString(raw.telegram?.botToken)) err('telegram.botToken', 'required — get it from @BotFather');
  if (!Number.isInteger(raw.telegram?.userId) || raw.telegram.userId <= 0) err('telegram.userId', 'must be your numeric Telegram user ID');
  if (!Array.isArray(raw.workspaces) || raw.workspaces.length === 0) {
    err('workspaces', 'at least one workspace is required');
  } else {
    raw.workspaces.forEach((w, i) => {
      if (!isNonEmptyString(w.name)) err(`workspaces[${i}].name`, 'required');
      else if (!isNonEmptyString(w.path)) err(`workspaces[${i}].path`, 'required');
      else if (!fs.existsSync(w.path) || !fs.statSync(w.path).isDirectory())
        err(`workspaces[${i}].path`, `directory does not exist: ${w.path}`);
    });
  }
  if (!Number.isInteger(raw.orchestration?.maxParallel) || raw.orchestration.maxParallel < 1 || raw.orchestration.maxParallel > 5)
    err('orchestration.maxParallel', 'must be an integer 1-5');
  if (raw.retention?.days != null && (!Number.isInteger(raw.retention.days) || raw.retention.days < 1))
    err('retention.days', 'must be a positive integer');
  const wsNames = new Set((raw.workspaces || []).map(w => w.name).filter(Boolean));
  const seenRepos = new Set();
  (raw.github?.repos || []).forEach((r, i) => {
    if (!isNonEmptyString(r.owner)) err(`github.repos[${i}].owner`, 'required');
    if (!isNonEmptyString(r.repo)) err(`github.repos[${i}].repo`, 'required');
    if (r.ws != null && !wsNames.has(r.ws))
      err(`github.repos[${i}].ws`, `unknown workspace "${r.ws}" — must match a workspaces[].name`);
    if (isNonEmptyString(r.owner) && isNonEmptyString(r.repo)) {
      const full = `${r.owner}/${r.repo}`;
      if (seenRepos.has(full)) err(`github.repos[${i}]`, `duplicate repo ${full} — one GitHub repo maps to one workspace (publish mirror is per-repo)`);
      seenRepos.add(full);
    }
  });

  const THINKING_LEVELS = ['none', 'low', 'medium', 'high', 'xhigh'];
  for (const key of ['thinking', 'planThinking', 'actThinking']) {
    const v = raw.cline?.[key];
    if (v != null && !THINKING_LEVELS.includes(v)) err(`cline.${key}`, `must be one of ${THINKING_LEVELS.join(', ')}`);
  }

  return { errors };
}

function deepMerge(base, over) {
  if (Array.isArray(base) || Array.isArray(over) || typeof base !== 'object' || typeof over !== 'object' || !base || !over) return over ?? base;
  const out = { ...base };
  for (const k of Object.keys(over)) out[k] = deepMerge(base[k], over[k]);
  return out;
}

function loadConfig(configPath) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(configPath, 'utf8')); }
  catch (e) { throw new ConfigError('$', `cannot read/parse ${configPath}: ${e.message} — run "npm run setup"`); }
  const merged = deepMerge(DEFAULTS, raw);
  const { errors } = validateConfig(merged);
  if (errors.length) throw new ConfigError(errors[0].key, errors[0].message);
  return Object.freeze(merged);
}

module.exports = { loadConfig, validateConfig, ConfigError, DEFAULTS };
