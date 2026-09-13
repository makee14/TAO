'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { esc, truncatePrompt } = require('./formatter');
const { card, kv } = require('./ui');

// Even, non-overlapping rows: chunk a flat button list into rows of perRow.
const wrap = (items, perRow = 2) => {
  const rows = [];
  for (let i = 0; i < items.length; i += perRow) rows.push(items.slice(i, i + perRow));
  return rows;
};

// Every wizard step must carry a way back out — nothing is a dead end (DESIGN.md §4).
const menu = () => [{ text: '🏠 Menu', callback_data: 'cmd:help' }];
const cancel = () => [{ text: '🚫 Cancel', callback_data: 'cancel' }];

// Quick-start prompt templates (Task: suggestions). Tapping one pastes the
// template into the user's writing DRAFT — it is never sent or queued.
const SUGGESTIONS = [
  'Refactor the code for clarity',
  'Add unit tests for the changes',
  'Fix the bug',
  'Write documentation',
  'Review and improve the code',
  'Create a new feature',
];

const MODE_LABEL = { plan: '📐 Plan', act: '⚡ Act' };

function detectGitRemote(workspacePath) {
  try {
    if (!workspacePath) return null;
    const gitConfigPath = path.join(workspacePath, '.git', 'config');
    if (!fs.existsSync(gitConfigPath)) return null;
    const content = fs.readFileSync(gitConfigPath, 'utf8');
    const match = content.match(/url\s*=\s*.*github\.com[/:]([^/\s]+)\/([^/\s.]+)/i);
    if (match) {
      return { owner: match[1], repo: match[2], name: `${match[1]}-${match[2]}` };
    }
  } catch { /* git config read swallow */ }
  return null;
}

// Auto-resolve the publish repo for a workspace: prefer a configured repo whose
// owner/repo match the detected git remote; fall back to an ad-hoc binding.
// Returns null when the workspace has no GitHub remote — the composer then
// never asks the repo question at all.
function resolveRepoForWorkspace(ws, deps = {}) {
  const detected = detectGitRemote(ws?.path);
  if (!detected) return null;
  const configured = (deps.repos ?? []).find(r =>
    r.owner === detected.owner && r.repo === detected.repo &&
    (!r.ws || r.ws === ws.name));
  return configured
    ? { ...configured, ws: ws.name }
    : { name: `${detected.owner}-${detected.repo}`, owner: detected.owner, repo: detected.repo, branch: 'main', ws: ws.name };
}

// Pure state machine. flow = { step, ws, repo, name, prompt, photoFileId, mode, publish, dflag }
// Steps: mode → workspace → publish → (repo/repo_confirm/repo_custom) → name → prompt → preview
function createFlow(deps) {
  return {
    step: 'mode', deps,
    ws: null, repo: null, name: null, prompt: null, photoFileId: null, photos: [],
    mode: deps?.defaults?.mode || 'act',
    publish: 'no',
  };
}

function buttons(flow) {
  switch (flow.step) {
    case 'mode':
      return [
        [
          { text: `📐 Plan${flow.mode === 'plan' ? ' ✓' : ''}`, callback_data: 'mode:plan' },
          { text: `⚡ Act${flow.mode === 'act' ? ' ✓' : ''}`, callback_data: 'mode:act' },
        ],
        cancel(),
        menu(),
      ];
    case 'workspace':
      return [...wrap(flow.deps.workspaces.map(w => ({ text: w.name + (w.default ? ' ⭐' : ''), callback_data: `ws:${w.name}` })), 2), cancel(), menu()];
    case 'publish':
      return [
        [
          { text: '🚀 Publish to GitHub', callback_data: 'publish:yes' },
          { text: '💻 Local only', callback_data: 'publish:no' },
        ],
        [{ text: '⬅️ Back', callback_data: 'back' }],
        menu(),
      ];
    case 'repo_confirm':
      return [
        [{ text: `✅ Use ${flow.repo.owner}/${flow.repo.repo}`, callback_data: 'repo:use' }],
        [{ text: '✏️ Change target', callback_data: 'repo:change' }],
        [{ text: '🚫 Local only (no publish)', callback_data: 'repo:none' }],
        [{ text: '⬅️ Back', callback_data: 'back' }],
        menu(),
      ];
    case 'repo': {
      const eligible = flow.deps.repos.filter(r => !r.ws || r.ws === flow.ws?.name); // one repo = one workspace (mirror is per-repo)
      const rows = eligible.map(r => [{ text: `${r.owner}/${r.repo}`, callback_data: `repo:${r.name}` }]);
      const detected = detectGitRemote(flow.ws?.path);
      if (detected && !eligible.some(r => r.owner === detected.owner && r.repo === detected.repo)) {
        rows.push([{ text: `🔍 Detected: ${detected.owner}/${detected.repo}`, callback_data: `repo:remote:${detected.owner}:${detected.repo}` }]);
      }
      rows.push([{ text: '✏️ Type custom repo (owner/repo)', callback_data: 'repo:raw' }]);
      rows.push([{ text: '🚫 No GitHub publish (Local only)', callback_data: 'repo:none' }]);
      rows.push([{ text: '⬅️ Back', callback_data: 'back' }]);
      rows.push(menu());
      return rows;
    }
    case 'repo_custom':
      return [
        [{ text: '🚫 Skip GitHub publish', callback_data: 'repo:none' }],
        [{ text: '⬅️ Back', callback_data: 'back' }],
        menu(),
      ];
    case 'name':
      return [
        [{ text: '⚡ Skip name (use prompt summary)', callback_data: 'name:skip' }],
        [{ text: '⬅️ Back', callback_data: 'back' }],
        menu(),
      ];
    case 'prompt': {
      const rows = [
        [{ text: '✅ Done typing', callback_data: 'prompt:done' }],
        [{ text: '⬅️ Back', callback_data: 'back' }],
      ];
      // Quick-start suggestions: tapping one INSERTS the template into the
      // prompt DRAFT (not sent, not queued) — the Telegram API cannot paste
      // into the input field, so the draft card is the closest affordance.
      rows.push(...wrap(SUGGESTIONS.map((s, i) => ({ text: `✨ ${s.slice(0, 18)}`, callback_data: `suggest:${i}` })), 2));
      rows.push(menu());
      return rows;
    }
    case 'preview':
      return [
        [{ text: '▶️ Run', callback_data: 'run' }, { text: '✏️ Edit prompt', callback_data: 'edit' }],
        [{ text: '⬅️ Back', callback_data: 'back' }],
        menu(),
      ];
    default: return [cancel(), menu()];
  }
}

function previewText(flow) {
  const name = flow.name || (flow.prompt ? truncatePrompt(flow.prompt.replace(/\n/g, ' '), 40) : 'Task');
  const photoText = (flow.photos && flow.photos.length > 0)
    ? `${flow.photos.length} photo${flow.photos.length > 1 ? 's' : ''}`
    : (flow.photoFileId ? '1 photo' : 'no');
  return card({
    icon: '📋',
    title: 'Preview',
    rows: [
      kv('🏷', esc(name)),
      kv('📁', esc(flow.ws.path)),
      kv('📦', flow.repo ? `${esc(flow.repo.owner)}/${esc(flow.repo.repo)} · ${esc(flow.repo.branch || 'main')}` : 'none (no publish)'),
      kv('📐', MODE_LABEL[flow.mode] || flow.mode),
      kv('📷', photoText),
      '',
      `<pre>${esc(flow.prompt)}</pre>`,
    ],
  });
}

function stepReply(flow) {
  switch (flow.step) {
    case 'mode':
      return {
        text: '📐 <b>How should I run this?</b>\n📐 Plan — analyze and produce a plan first; no code changes without you.\n⚡ Act — go ahead and implement it and start right away.',
        buttons: buttons(flow),
      };
    case 'workspace': return { text: '🛠 <b>Choose a workspace:</b>', buttons: buttons(flow) };
    case 'publish':
      return {
        text: '🚀 <b>Publish the result to GitHub?</b>\nYou have a PAT — pick an existing repo or create a new one, or keep it local.',
        buttons: buttons(flow),
      };
    case 'repo_confirm': return {
      text: `📦 <b>Detected GitHub remote</b>\n<i>${esc(flow.repo.owner)}/${esc(flow.repo.repo)}</i>\n\nTap Use to publish results there, or Change target for another option.`,
      buttons: buttons(flow),
    };
    case 'repo': return { text: '📦 <b>Publish results to which GitHub repo?</b>\n<i>Choose a configured repo, use detected remote, type a custom repo, or skip publish.</i>', buttons: buttons(flow) };
    case 'repo_custom': return { text: '✏️ <b>Enter GitHub repository:</b>\nSend in the format <code>owner/repo</code> (e.g. <code>octocat/my-project</code>):', buttons: buttons(flow) };
    case 'name': return { text: '📝 <b>Task name?</b> (short, e.g. "Fix login bug")\n<i>Or tap below to skip and use your prompt as the name.</i>', buttons: buttons(flow) };
    case 'prompt': {
      const photoCount = flow.photos?.length || (flow.photoFileId ? 1 : 0);
      const photoNotice = photoCount > 0 ? `\n<i>📷 ${photoCount} photo${photoCount > 1 ? 's' : ''} attached.</i>` : '';
      const draftNotice = flow.prompt ? `\n<i>Draft: ${esc(truncatePrompt(flow.prompt, 60))}</i>` : '';
      const baseText = flow.prompt
        ? '💬 Keep typing or tap ✅ Done — your prompt is preserved.'
        : '💬 <b>Now the full prompt.</b> Send text (photo optional before tapping Done):';
      return { text: baseText + photoNotice + draftNotice + '\n\n✨ Tap a suggestion below to paste a template into your draft (nothing is sent).', buttons: buttons(flow) };
    }
    case 'preview': return { text: previewText(flow), buttons: buttons(flow) };
    default: return { text: '🛠 <b>Choose a workspace:</b>', buttons: buttons(createFlow(flow.deps)) };
  }
}

function advance(flow, input) {
  const d = flow.deps;
  if (input.type === 'callback' && input.data === 'cancel') {
    return {
      flow,
      reply: {
        text: '❌ <b>Task cancelled.</b>',
        buttons: [[{ text: '🆕 Start new task', callback_data: 'cmd:newtask' }, { text: '🏠 Back to menu', callback_data: 'cmd:help' }]],
      },
      done: null,
    };
  }
  if (input.type === 'callback' && input.data === 'back') {
    const next =
      flow.step === 'mode' ? null
      : flow.step === 'workspace' ? { ...flow, step: 'mode' }
      : flow.step === 'publish' ? { ...flow, step: 'workspace', ws: null, repo: null }
      : flow.step === 'repo_confirm' ? { ...flow, step: 'publish' }
      : flow.step === 'repo' ? { ...flow, step: 'repo_confirm' }
      : flow.step === 'repo_custom' ? { ...flow, step: 'repo', repo: null }
      : flow.step === 'name' ? (flow.repo ? { ...flow, step: 'repo_confirm' } : { ...flow, step: 'publish' })
      : flow.step === 'prompt' ? { ...flow, step: 'name' }
      : flow.step === 'preview' ? { ...flow, step: 'prompt' }
      : null;
    if (!next) return { flow, reply: stepReply(flow), done: null };
    return { flow: next, reply: stepReply(next), done: null };
  }
  switch (flow.step) {
    case 'mode': {
      if (input.type === 'callback' && (input.data === 'mode:plan' || input.data === 'mode:act')) {
        const next = { ...flow, mode: input.data.slice(5), step: 'workspace' };
        return { flow: next, reply: stepReply(next), done: null };
      }
      return { flow, reply: stepReply(flow), done: null };
    }
    case 'workspace': {
      if (input.type !== 'callback') return { flow, reply: stepReply(flow), done: null };
      const ws = d.workspaces.find(w => w.name === input.data?.slice(3));
      if (!ws) return { flow, reply: stepReply(flow), done: null };
      // Always ask the publish question — the owner has a PAT and may create
      // or choose a repo even when the workspace has no git remote.
      const next = { ...flow, ws, step: 'publish' };
      return { flow: next, reply: stepReply(next), done: null };
    }
    case 'publish': {
      if (input.type !== 'callback') return { flow, reply: stepReply(flow), done: null };
      if (input.data === 'publish:no') {
        const next = { ...flow, repo: null, step: 'name' };
        return { flow: next, reply: stepReply(next), done: null };
      }
      if (input.data === 'publish:yes') {
        const resolved = resolveRepoForWorkspace(flow.ws, d);
        const eligible = (d.repos ?? []).filter(r => !r.ws || r.ws === flow.ws?.name);
        if (resolved) {
          const next = { ...flow, repo: resolved, step: 'repo_confirm' };
          return { flow: next, reply: stepReply(next), done: null };
        }
        const s = eligible.length ? 'repo' : 'repo_custom';
        const next = { ...flow, step: s };
        return { flow: next, reply: stepReply(next), done: null };
      }
      return { flow, reply: stepReply(flow), done: null };
    }
    case 'repo_confirm': {
      const data = input.type === 'callback' ? input.data : '';
      if (data === 'repo:use')
        return { flow: { ...flow, step: 'name' }, reply: stepReply({ ...flow, step: 'name' }), done: null };
      if (data === 'repo:change')
        return { flow: { ...flow, step: 'repo', repo: null }, reply: stepReply({ ...flow, step: 'repo', repo: null }), done: null };
      if (data === 'repo:none')
        return { flow: { ...flow, step: 'name', repo: null }, reply: stepReply({ ...flow, step: 'name', repo: null }), done: null };
      return { flow, reply: stepReply(flow), done: null };
    }
    case 'repo': {
      const data = input.data || '';
      if (data === 'repo:none') {
        return { flow: { ...flow, step: 'name', repo: null }, reply: stepReply({ ...flow, step: 'name', repo: null }), done: null };
      }
      if (data === 'repo:raw') {
        return { flow: { ...flow, step: 'repo_custom', repo: null }, reply: stepReply({ ...flow, step: 'repo_custom', repo: null }), done: null };
      }
      if (data.startsWith('repo:remote:')) {
        const [, , owner, repo] = data.split(':');
        const rObj = { name: `${owner}-${repo}`, owner, repo, branch: 'main', ws: flow.ws?.name };
        return { flow: { ...flow, step: 'name', repo: rObj }, reply: stepReply({ ...flow, step: 'name', repo: rObj }), done: null };
      }
      const key = data.slice(5);
      const repo = d.repos.find(r => r.name === key && (!r.ws || r.ws === flow.ws?.name));
      if (!repo) return { flow, reply: stepReply(flow), done: null };
      return { flow: { ...flow, step: 'name', repo }, reply: stepReply({ ...flow, step: 'name', repo }), done: null };
    }
    case 'repo_custom': {
      if (input.type === 'callback' && input.data === 'repo:none') {
        return { flow: { ...flow, step: 'name', repo: null }, reply: stepReply({ ...flow, step: 'name', repo: null }), done: null };
      }
      if (input.type !== 'text' || !input.text.trim()) return { flow, reply: stepReply(flow), done: null };
      const raw = input.text.trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '');
      const parts = raw.split('/');
      if (parts.length !== 2 || !parts[0] || !parts[1]) {
        return {
          flow,
          reply: {
            text: '⚠️ Invalid format. Send <b>owner/repo</b> (e.g. <code>facebook/react</code>) or tap below:',
            buttons: buttons(flow),
          },
          done: null,
        };
      }
      const [owner, repo] = parts;
      const customRepo = { name: `${owner}-${repo}`, owner, repo, branch: 'main', ws: flow.ws?.name };
      return { flow: { ...flow, step: 'name', repo: customRepo }, reply: stepReply({ ...flow, step: 'name', repo: customRepo }), done: null };
    }
    case 'name': {
      if (input.type === 'callback' && input.data === 'name:skip') {
        return { flow: { ...flow, step: 'prompt', name: null }, reply: stepReply({ ...flow, step: 'prompt', name: null }), done: null };
      }
      if (input.type !== 'text' || !input.text.trim()) return { flow, reply: stepReply(flow), done: null };
      return { flow: { ...flow, step: 'prompt', name: input.text.trim() }, reply: stepReply({ ...flow, step: 'prompt', name: input.text.trim() }), done: null };
    }
    case 'prompt':
      if (input.type === 'photo') {
        const nextPhotos = [...(flow.photos || []), input.fileId];
        const next = { ...flow, photos: nextPhotos, photoFileId: input.fileId };
        return { flow: next, reply: stepReply(next), done: null };
      }
      if (input.type === 'text') {
        const next = { ...flow, prompt: (flow.prompt ? flow.prompt + '\n' : '') + input.text };
        return { flow: next, reply: stepReply(next), done: null };
      }
      if (input.data?.startsWith('suggest:')) {
        // Pastes the chosen template into the user's DRAFT — nothing is sent.
        const idx = Number(input.data.slice('suggest:'.length));
        const tpl = SUGGESTIONS[idx];
        if (tpl) {
          const next = { ...flow, prompt: (flow.prompt ? flow.prompt + '\n' : '') + tpl };
          return { flow: next, reply: stepReply(next), done: null };
        }
        return { flow, reply: stepReply(flow), done: null };
      }
      if (input.data === 'prompt:done') {
        if (!flow.prompt) return { flow, reply: stepReply(flow), done: null };
        return { flow: { ...flow, step: 'preview' }, reply: stepReply({ ...flow, step: 'preview' }), done: null };
      }
      return { flow, reply: stepReply(flow), done: null };
    case 'preview':
      if (input.data === 'run') {
        const name = flow.name || (flow.prompt ? truncatePrompt(flow.prompt.replace(/\n/g, ' '), 40) : 'Task');
        const taskDraft = {
          name,
          prompt: flow.prompt,
          workspace: flow.ws.path,
          repo: flow.repo,
          imagePath: flow.photos?.[0] || flow.photoFileId || null,
          photos: flow.photos || (flow.photoFileId ? [flow.photoFileId] : []),
          mode: flow.mode,
        };
        return { flow, reply: { text: `🚀 Queued "${name}"` }, done: taskDraft };
      }
      if (input.data === 'edit') return { flow: { ...flow, step: 'prompt', prompt: null }, reply: stepReply({ ...flow, step: 'prompt', prompt: null }), done: null };
      return { flow, reply: stepReply(flow), done: null };
    default:
      return { flow: createFlow(d), reply: stepReply(createFlow(d)), done: null };
  }
}

module.exports = { createFlow, advance, stepReply, buttons, detectGitRemote, resolveRepoForWorkspace, SUGGESTIONS };
