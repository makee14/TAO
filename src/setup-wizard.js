'use strict';
const prompts = require('prompts');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { validateConfig, DEFAULTS } = require('./config');

async function tgApi(method, token, fetchImpl = fetch) {
  const res = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`);
  const json = await res.json(); // read the body exactly once — a Response body can only be consumed once
  return { ok: res.ok && json.ok, status: res.status, json };
}
async function validateBotToken(token, fetchImpl = fetch) {
  try {
    const r = await tgApi('getMe', token, fetchImpl);
    if (!r.ok) return { ok: false, error: `Telegram rejected the token (HTTP ${r.status}) — paste it again from @BotFather` };
    return { ok: true, botUsername: r.json.result.username };
  } catch (e) { return { ok: false, error: `network error: ${e.message}` }; }
}
async function captureUserId(token, { timeoutMs = 120000, fetchImpl = fetch } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await tgApi('getUpdates', token, fetchImpl);
    if (r.ok) {
      const { result } = r.json;
      const msg = result.map(u => u.message).find(m => m && m.chat.type === 'private' && !m.from.is_bot);
      if (msg) return msg.from.id;
    }
    await new Promise(res => setTimeout(res, 2000));
  }
  throw new Error('timeout — send any message to your bot and rerun setup');
}
async function validatePat(pat, fetchImpl = fetch) {
  try {
    const res = await fetchImpl('https://api.github.com/user', { headers: { Authorization: `Bearer ${pat}`, 'X-GitHub-Api-Version': '2022-11-28' } });
    if (!res.ok) return { ok: false, error: `GitHub rejected the PAT (HTTP ${res.status})` };
    return { ok: true, login: (await res.json()).login };
  } catch (e) { return { ok: false, error: `network error: ${e.message}` }; }
}

function deepMerge(target, src) { // existing values become the defaults (edit mode)
  for (const [k, v] of Object.entries(src)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) deepMerge(target[k] ??= {}, v);
    else if (v !== '' && v != null) target[k] = v;
  }
  return target;
}
function readExistingConfig(configPath = path.join(__dirname, '..', 'config.json')) {
  try { return JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch { return null; }
}

function isBack(input) {
  const str = String(input ?? '').trim().toLowerCase();
  return str === 'back' || str === 'b' || str === ':back';
}

function detectGitRemote(workspacePath) {
  try {
    const gitConfigPath = path.join(workspacePath, '.git', 'config');
    if (!fs.existsSync(gitConfigPath)) return null;
    const content = fs.readFileSync(gitConfigPath, 'utf8');
    const match = content.match(/url\s*=\s*.*github\.com[/:]([^/\s]+)\/([^/\s.]+)/i);
    if (match) {
      return { owner: match[1], repo: match[2], name: `${match[1]}-${match[2]}` };
    }
  } catch { /* ignore read errors */ }
  return null;
}

const BANNER = `
╔══════════════════════════════════════════════════════════════════════╗
║                 TAO — Telegram Agent Orchestrator                    ║
║                     Setup & Configuration Wizard                     ║
╚══════════════════════════════════════════════════════════════════════╝`;

async function main() {
  console.log(BANNER);
  console.log('  Welcome! Configure TAO to orchestrate AI coding agents from Telegram.');
  console.log('  Tip: Type "back" or "b" at any prompt to return to the previous step.\n');

  const existing = readExistingConfig();
  if (existing) {
    console.log('  ┌──────────────────────────────────────────────────────────────┐');
    console.log('  │  Existing config.json detected — EDIT MODE                   │');
    console.log('  │  Press [Enter] to keep current values.                       │');
    console.log('  └──────────────────────────────────────────────────────────────┘\n');
  }

  const cfg = structuredClone(DEFAULTS);
  if (existing) deepMerge(cfg, existing);
  if (!Array.isArray(cfg.workspaces)) cfg.workspaces = [];
  if (!Array.isArray(cfg.github?.repos)) {
    if (!cfg.github) cfg.github = {};
    cfg.github.repos = [];
  }

  let step = 0; // 0: Token, 1: OwnerID, 2: GitHub PAT, 3: Workspaces & Repos, 4: Engine Defaults, 5: Summary & Confirm

  while (step <= 5) {
    if (step === 0) {
      console.log('\n─── [Step 1/5] Telegram Bot Token ──────────────────────────────────');
      console.log('  Create a bot with @BotFather on Telegram and paste your token.');
      const { token } = await prompts({
        type: 'password',
        name: 'token',
        message: cfg.telegram?.botToken ? 'Telegram bot token (Enter = keep current, or "back"):' : 'Telegram bot token:',
      });
      if (token === undefined) { process.exit(0); }
      if (isBack(token)) {
        console.log('  ℹ Already at the first step.');
        continue;
      }
      const tokenToTest = token || cfg.telegram?.botToken;
      if (!tokenToTest) {
        console.log('  ✖ Bot token cannot be empty.');
        continue;
      }
      process.stdout.write('  Validating token with Telegram API... ');
      const v = await validateBotToken(tokenToTest);
      if (v.ok) {
        console.log(`\n  ✔ VALIDATED: Connected as @${v.botUsername}`);
        cfg.telegram.botToken = tokenToTest;
        step = 1;
      } else {
        console.log(`\n  ✖ ${v.error}`);
      }
    } else if (step === 1) {
      console.log('\n─── [Step 2/5] Telegram Owner ID ───────────────────────────────────');
      if (cfg.telegram.userId) {
        console.log(`  Current owner user ID: ${cfg.telegram.userId}`);
        const { keep } = await prompts({
          type: 'text',
          name: 'keep',
          message: 'Press Enter to keep, type "new" to capture new ID, or "back":',
        });
        if (keep === undefined) { process.exit(0); }
        if (isBack(keep)) { step = 0; continue; }
        if (keep.trim().toLowerCase() !== 'new') {
          console.log(`  ✔ Owner user ID retained: ${cfg.telegram.userId}`);
          step = 2;
          continue;
        }
      }
      console.log('  Now open Telegram and send ANY message to your bot in private chat...');
      try {
        cfg.telegram.userId = await captureUserId(cfg.telegram.botToken);
        console.log(`  ✔ Owner user ID captured: ${cfg.telegram.userId}`);
        step = 2;
      } catch (err) {
        console.log(`  ✖ ${err.message}`);
        const { retry } = await prompts({ type: 'text', name: 'retry', message: 'Action (Enter = retry, "back"): ' });
        if (isBack(retry)) { step = 0; }
      }
    } else if (step === 2) {
      console.log('\n─── [Step 3/5] GitHub Personal Access Token (PAT) ───────────────────');
      console.log('  Optional for local tasks, required for auto-publishing git repos.');
      console.log('  Needs fine-grained token with Contents: RW and Administration: RW.');
      const { pat } = await prompts({
        type: 'password',
        name: 'pat',
        message: cfg.github?.pat ? 'GitHub PAT (Enter = keep current, "none" to skip, "back"):' : 'GitHub PAT (Enter = skip, "back"):',
      });
      if (pat === undefined) { process.exit(0); }
      if (isBack(pat)) { step = 1; continue; }
      if (pat.trim().toLowerCase() === 'none') {
        cfg.github.pat = '';
        console.log('  ℹ GitHub integration skipped (local workspace only).');
        step = 3;
        continue;
      }
      const patToTest = pat || cfg.github?.pat;
      if (!patToTest) {
        console.log('  ℹ No GitHub PAT provided. Local workspace mode.');
        cfg.github.pat = '';
        step = 3;
        continue;
      }
      process.stdout.write('  Validating PAT with GitHub API... ');
      const v = await validatePat(patToTest);
      if (v.ok) {
        console.log(`\n  ✔ VALIDATED: Authenticated as ${v.login}`);
        cfg.github.pat = patToTest;
        step = 3;
      } else {
        console.log(`\n  ✖ ${v.error}`);
        console.log('  (Enter "none" to skip GitHub or "back" to return)');
      }
    } else if (step === 3) {
      console.log('\n─── [Step 4/5] Workspace Folders & Repositories ────────────────────');
      console.log('  Workspaces are directories on this PC where AI coding agents will work.');
      if (cfg.workspaces.length) {
        console.log('  Current workspaces:');
        cfg.workspaces.forEach((w, i) => {
          const boundRepo = (cfg.github?.repos || []).find(r => r.ws === w.name);
          const repoStr = boundRepo ? ` -> GitHub: ${boundRepo.owner}/${boundRepo.repo}` : '';
          console.log(`    ${i + 1}. [${w.name}] ${w.path}${w.default ? ' (default)' : ''}${repoStr}`);
        });
      }
      let wsDone = false;
      while (!wsDone) {
        const { p } = await prompts({
          type: 'text',
          name: 'p',
          message: `Add workspace folder #${cfg.workspaces.length + 1} (Enter = finish, "back"):`,
        });
        if (p === undefined) { process.exit(0); }
        if (isBack(p)) {
          if (cfg.workspaces.length === 0) {
            step = 2;
            wsDone = true;
            break;
          } else {
            console.log('  ℹ Removed last workspace added.');
            const removed = cfg.workspaces.pop();
            if (cfg.github?.repos) {
              cfg.github.repos = cfg.github.repos.filter(r => r.ws !== removed.name);
            }
            continue;
          }
        }
        if (!p.trim()) {
          if (cfg.workspaces.length === 0) {
            console.log('  ✖ At least one workspace folder is required.');
            continue;
          }
          wsDone = true;
          step = 4;
          break;
        }
        const cleanPath = p.trim().replace(/^["']|["']$/g, '');
        if (!fs.existsSync(cleanPath) || !fs.statSync(cleanPath).isDirectory()) {
          console.log(`  ✖ "${cleanPath}" is not a valid directory.`);
          continue;
        }
        const wsName = path.basename(cleanPath);
        cfg.workspaces.push({ name: wsName, path: cleanPath, default: cfg.workspaces.length === 0 });
        console.log(`  ✔ Workspace "${wsName}" added.`);

        // Auto-detect git remote — same detection the /newtask composer uses for its one-tap confirm
        const detected = detectGitRemote(cleanPath);
        if (detected) {
          console.log(`  🔍 Detected Git remote: ${detected.owner}/${detected.repo}`);
          const { bind } = await prompts({
            type: 'confirm',
            name: 'bind',
            message: `Bind GitHub repo ${detected.owner}/${detected.repo} to "${wsName}"?`,
            initial: true,
          });
          if (bind) {
            if (!cfg.github.repos) cfg.github.repos = [];
            cfg.github.repos = cfg.github.repos.filter(r => r.ws !== wsName);
            cfg.github.repos.push({
              name: `${detected.owner}-${detected.repo}`,
              owner: detected.owner,
              repo: detected.repo,
              branch: 'main',
              default: true,
              ws: wsName,
            });
            console.log(`  ✔ Bound ${detected.owner}/${detected.repo} to "${wsName}".`);
          }
        }
      }
    } else if (step === 4) {
      console.log('\n─── [Step 5/5] Cline CLI & Engine Defaults ─────────────────────────');
      const detected = (() => {
        try { return execFileSync(cfg.cline.bin, ['--version'], { shell: true }).toString().trim(); }
        catch { return null; }
      })();
      console.log(`  Cline status: ${detected ? `✔ Found (${detected})` : '⚠️ NOT FOUND (run: npm i -g cline)'}`);

      const { provider, model } = await prompts([
        { type: 'text', name: 'provider', message: 'Default provider (Enter = use cline auth, "back"):', initial: cfg.cline.provider ?? '' },
        { type: 'text', name: 'model', message: 'Default model (Enter = use cline auth, "back"):', initial: cfg.cline.model ?? '' },
      ]);
      if (provider === undefined || model === undefined) { process.exit(0); }
      if (isBack(provider) || isBack(model)) {
        step = 3;
        continue;
      }
      Object.assign(cfg.cline, { provider: provider ?? cfg.cline.provider ?? '', model: model ?? cfg.cline.model ?? '' });
      step = 5;
    } else if (step === 5) {
      console.log('\n╔══════════════════════════════════════════════════════════════════════╗');
      console.log('║                     Configuration Summary                            ║');
      console.log('╚══════════════════════════════════════════════════════════════════════╝');
      console.log(`  • Telegram Bot:  ${cfg.telegram?.botToken ? 'Configured' : 'Missing'}`);
      console.log(`  • Owner ID:      ${cfg.telegram?.userId}`);
      console.log(`  • GitHub PAT:    ${cfg.github?.pat ? 'Configured' : 'None (Local only)'}`);
      console.log(`  • Workspaces:    ${cfg.workspaces.map(w => w.name + ` (${w.path})`).join(', ')}`);
      if (cfg.github?.repos?.length) {
        console.log(`  • Repositories:  ${cfg.github.repos.map(r => `${r.owner}/${r.repo} [${r.ws}]`).join(', ')}`);
      }
      console.log(`  • Engine:        provider: "${cfg.cline.provider || 'default'}", model: "${cfg.cline.model || 'default'}"`);

      const { action } = await prompts({
        type: 'select',
        name: 'action',
        message: 'Ready to write configuration?',
        choices: [
          { title: '💾 Save & Finish', value: 'save' },
          { title: '⬅️ Back to edit settings', value: 'back' },
          { title: '❌ Cancel without saving', value: 'cancel' },
        ],
      });
      if (action === 'back') { step = 4; continue; }
      if (action === 'cancel' || action === undefined) {
        console.log('\n  Setup cancelled.');
        process.exit(0);
      }

      const { errors } = validateConfig(cfg);
      if (errors.length) {
        console.error('\n  ✖ Config validation errors:');
        errors.forEach(e => console.error(`    - ${e.key}: ${e.message}`));
        console.log('  Returning to edit...');
        step = 0;
        continue;
      }

      const out = path.join(__dirname, '..', 'config.json');
      fs.writeFileSync(out, JSON.stringify(cfg, null, 2));
      console.log(`\n✔ Configuration successfully written to: ${out}`);
      console.log('\nYou can now start TAO with:');
      console.log('  npm start\n');
      break;
    }
  }
}

if (require.main === module) main();
module.exports = { validateBotToken, captureUserId, validatePat, readExistingConfig, detectGitRemote, isBack };
