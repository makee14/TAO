'use strict';
// Friendly classification of raw AI-provider errors so the owner never sees
// scary, raw provider text. Produces a guided card + optional actions.
const { card, btn, kb, menuExitRow, wrapBtn } = require('./ui');
const { esc } = require('./formatter');

const QUOTA_RE = /(exceed(?:ed)? (?:your )?(?:current )?quota|quota (?:exceeded|exhausted)|billing details|insufficient_quota)/i;
const RATE_RE = /(rate\s*limit|too many requests|resource exhausted)/i;
const AUTH_RE = /(invalid api key|unauthorized|permission denied|401|403|api key not found)/i;
const NET_RE = /(ECONNREFUSED|ENOTFOUND|ETIMEDOUT|fetch failed|network error|socket hang up)/i;

function classifyAiError(errorText = '') {
  const lower = String(errorText ?? '').toLowerCase();
  if (QUOTA_RE.test(lower)) {
    return {
      kind: 'quota',
      friendly: 'The AI provider has hit its usage quota for your account right now.',
      hint: 'Wait a bit and retry, lower the model to a cheaper tier, or switch provider/model.',
      rotateKey: true, retryable: true,
    };
  }
  if (RATE_RE.test(lower)) {
    return {
      kind: 'rate_limit',
      friendly: 'The AI provider is receiving too many requests right now.',
      hint: 'The task can be retried in a minute — the queue keeps working meanwhile.',
      rotateKey: true, retryable: true,
    };
  }
  if (AUTH_RE.test(lower)) {
    return {
      kind: 'auth',
      friendly: 'The AI provider rejected your API key or credentials.',
      hint: 'Re-check the API key in /settings → Gemini Keys, or pick another provider.',
      rotateKey: false, retryable: false,
    };
  }
  if (NET_RE.test(lower)) {
    return {
      kind: 'network',
      friendly: 'The AI provider could not be reached.',
      hint: 'Check the internet / proxy, then retry.',
      rotateKey: false, retryable: true,
    };
  }
  return { kind: 'generic', friendly: '', hint: '', rotateKey: false, retryable: false };
}

// Returns a friendly card + keyboard when the failure is AI-familial, null otherwise.
function fmtAiFailure(task, rawError) {
  const c = classifyAiError(rawError);
  if (c.kind === 'generic') return null;
  const rows = [
    `<b>${esc(task.id)} · ${esc(task.name)}</b>`,
    '',
    `🤖 ${c.friendly}`,
    `💡 ${c.hint}`,
    '',
    '<i>The full technical error is saved in the run log — unless you need it, you can ignore it.</i>',
  ];
  const actions = [];
  if (c.retryable) actions.push(btn('🔁 Retry task', `t:${task.id}:retry`));
  if (c.rotateKey) actions.push(btn('🔑 Manage keys', 'settings:gemini'));
  return {
    text: card({ icon: '😌', title: 'Provider hiccup, not your task', meta: 'friendly heads-up', rows }),
    keyboardRows: [...wrapBtn(actions, 2), ...menuExitRow()],
  };
}

module.exports = { classifyAiError, fmtAiFailure, QUOTA_RE, RATE_RE, AUTH_RE, NET_RE };