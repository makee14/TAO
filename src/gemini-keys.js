'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// ── Gemini key rotation (Cline-CLI-style combo) ─────────────────────────────
// Keys live in cfg.cline.geminiKeys; the ACTIVE key is always keys[0].
// Rotation moves keys[0] to the back and applies the new head to cline's
// credentials file, so spawned agents pick it up without a restart.

function keysOf(cfg) { return Array.isArray(cfg.cline?.geminiKeys) ? cfg.cline.geminiKeys.filter(Boolean) : []; }
function activeGeminiKey(cfg) { return keysOf(cfg)[0] ?? null; }

function rotateGeminiKey(cfg, { saveConfig } = {}) {
  const keys = keysOf(cfg);
  if (keys.length < 2) return null; // nothing to rotate to
  cfg.cline.geminiKeys = [...keys.slice(1), keys[0]];
  if (typeof saveConfig === 'function') saveConfig(cfg);
  applyGeminiKey(cfg);
  return cfg.cline.geminiKeys[0];
}

function applyGeminiKey(cfg) {
  const key = activeGeminiKey(cfg);
  if (!key) return null;
  const credPath = path.join(os.homedir(), '.cline', '.credentials.json');
  let data = {};
  try { data = JSON.parse(fs.readFileSync(credPath, 'utf8')); } catch { /* fresh file */ }
  data.gemini = data.gemini ?? {};
  data.gemini.apiKey = key;
  fs.mkdirSync(path.dirname(credPath), { recursive: true });
  fs.writeFileSync(credPath, JSON.stringify(data, null, 2));
  return key;
}

module.exports = { keysOf, activeGeminiKey, rotateGeminiKey, applyGeminiKey };