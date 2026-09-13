'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const OMNI_URL = 'http://localhost:20128';
const OMNI_PROVIDER = 'openai-compatible';
const BASE_PATH = '/v1';

// Root endpoint answers on any status in [200,500) — "the proxy process is up".
function checkHealth(url = OMNI_URL, timeoutMs = 1500) {
  return new Promise(resolve => {
    const req = http.get(url + '/', res => {
      resolve(res.statusCode >= 200 && res.statusCode < 500);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(false); });
  });
}

async function waitForHealth({ url = OMNI_URL, timeoutMs = 20000, stepMs = 500, checkHealthImpl = checkHealth } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await checkHealthImpl(url, 1500)) return true;
    await new Promise(r => setTimeout(r, stepMs));
  }
  return false;
}

async function startService(exec) { await exec('omniroute', ['serve']); }
async function stopService(exec)  { await exec('omniroute', ['stop']); }

// Merge (never clobber) an `openai-compatible` entry into cline's
// providers.json so tasks can point at OmniRoute. Written with both field
// spellings (apiUrl + baseUrl) so either cline schema accepts it — this repo's
// cline-discovery.js only reads `providers[id].settings.model`, which stays
// compatible either way.
function ensureProviderConfigured({ settingsDir, baseUrl = OMNI_URL + BASE_PATH, model = null }) {
  const provPath = path.join(settingsDir, 'providers.json');
  let data = {};
  try { data = JSON.parse(fs.readFileSync(provPath, 'utf8')); } catch { /* fresh file */ }
  const providers = data.providers = data.providers ?? {};
  const entry = providers[OMNI_PROVIDER] = providers[OMNI_PROVIDER] ?? {};
  const settings = entry.settings = entry.settings ?? {};
  settings.apiUrl = baseUrl;
  settings.baseUrl = baseUrl;
  if (model) settings.model = model;
  settings.apiKey = settings.apiKey || 'omniroute';
  fs.writeFileSync(provPath, JSON.stringify(data, null, 2));
  return provPath;
}

module.exports = {
  OMNI_URL, OMNI_PROVIDER, BASE_PATH,
  checkHealth, waitForHealth, startService, stopService, ensureProviderConfigured,
};
