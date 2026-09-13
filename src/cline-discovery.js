'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

function getClineDataDir() {
  const home = os.homedir();
  return path.join(home, '.cline', 'data');
}

function getClineSettingsDir() {
  return path.join(getClineDataDir(), 'settings');
}

// Providers come ONLY from Cline's own providers.json — never an assumed list.
// An id offered here is guaranteed to be one Cline can actually run (-P <id>).
function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function getAvailableProviders(settingsDir = getClineSettingsDir()) {
  const result = [];
  const data = readJson(path.join(settingsDir, 'providers.json'));
  const map = (data && data.providers && typeof data.providers === 'object') ? data.providers : {};
  for (const [id, info] of Object.entries(map)) {
    const settings = (info && typeof info === 'object' && info.settings) ? info.settings : {};
    result.push({ id, name: id, model: settings.model || '', configured: true, reasoning: settings.reasoning });
  }
  return result;
}

function getAvailableModels(provider = '', settingsDir = getClineSettingsDir()) {
  const p = (provider || '').trim();
  const models = [];
  const seen = new Set();
  const add = m => {
    if (!m || typeof m !== 'string') return;
    const clean = m.trim();
    if (clean && !seen.has(clean)) { seen.add(clean); models.push(clean); }
  };

  // 1. The provider's active model — the one Cline is actually using (always valid).
  const provData = readJson(path.join(settingsDir, 'providers.json'));
  add(provData?.providers?.[p]?.settings?.model);

  // 2. The provider's real persisted catalog (models.json) if present.
  const mData = readJson(path.join(settingsDir, 'models.json'));
  const cat = mData?.providers?.[p]?.models;
  if (cat && typeof cat === 'object') {
    for (const id of Object.keys(cat)) add(id);
  }

  return models;
}

module.exports = {
  getClineDataDir,
  getClineSettingsDir,
  getAvailableProviders,
  getAvailableModels,
};
