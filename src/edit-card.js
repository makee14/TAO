'use strict';
// Guards Telegram in-place edits against the well-known benign "already up to
// date" rejections. Without this, a harmless double-tap of 🔄 Refresh / ⬅️ Back
// to menu throws 400 "message is not modified", bubbles to bot.catch, and the
// owner gets a scary ⚠️ error card for a no-op tap (BUG B2).
const BENIGN = [
  'message is not modified',
  'query is too old',
  'message to edit not found',
  'there is no text in the message to edit',
];

function isBenignEditError(e) {
  const msg = String(e?.description || e?.message || e || '').toLowerCase();
  return BENIGN.some(b => msg.includes(b));
}

// Returns the edit result, or undefined when the edit was a benign no-op.
// Any other error is re-thrown so real failures still reach bot.catch.
async function editCard(ctx, text, extra) {
  try { return await ctx.editMessageText(text, extra); }
  catch (e) { if (isBenignEditError(e)) return undefined; throw e; }
}

module.exports = { editCard, isBenignEditError };