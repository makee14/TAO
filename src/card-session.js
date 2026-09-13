'use strict';
// Single-active-card engine.
// Guarantee: at most ONE interactive card per chat and at most ONE card per task
// lifecycle. A newer render edits the older card in place (which also replaces
// its keyboard, so duplicated buttons vanish); if the old card cannot be edited
// it is deleted before a fresh card is sent.
const { isBenignEditError } = require('./edit-card');

// "message to edit not found" is benign for error-reporting (edit-card.js) but
// it means the card is GONE from Telegram — the session must recover by
// deleting the stale record and sending a fresh card instead of keeping it.
function isMissingCardError(e) {
  const msg = String(e?.description || e?.message || e || '').toLowerCase();
  return msg.includes('message to edit not found');
}

function createCardSession() {
  const state = new Map();
  return {
    get(key) { return state.get(key) ?? null; },
    set(key, messageId) { state.set(key, { message_id: messageId }); },
    delete(key) { state.delete(key); },
  };
}

async function sendCard(ctx, session, text, extra = {}) {
  const chatId = ctx.chat?.id ?? ctx.callbackQuery?.message?.chat?.id;
  if (!chatId) return { message_id: null };
  const prev = session.get(chatId);
  if (prev) {
    try {
      await ctx.telegram.editMessageText(chatId, prev.message_id, undefined, text, extra);
      return { message_id: prev.message_id }; // same card, newer content + keyboard
    } catch (e) {
      if (isBenignEditError(e) && !isMissingCardError(e)) return { message_id: prev.message_id };
      await ctx.telegram.deleteMessage(chatId, prev.message_id).catch(() => {});
      session.delete(chatId);
    }
  }
  const sent = await ctx.telegram.sendMessage(chatId, text, extra);
  if (sent?.message_id) session.set(chatId, sent.message_id);
  return sent;
}

async function cardReply(ctx, session, text, extra = {}) {
  const msg = ctx.callbackQuery?.message;
  if (msg) {
    const chatId = msg.chat.id;
    const msgId = msg.message_id;
    try {
      const res = await ctx.telegram.editMessageText(chatId, msgId, undefined, text, extra);
      session.set(chatId, msgId); // the tapped card is now the active card
      return res;
    } catch (e) {
      if (isMissingCardError(e)) { // tapped card is gone: recover with a fresh card
        session.delete(chatId);
        return sendCard(ctx, session, text, extra);
      }
      if (isBenignEditError(e)) { session.set(chatId, msgId); return undefined; }
      throw e;
    }
  }
  return sendCard(ctx, session, text, extra);
}

async function deleteCard(ctx, session, chatId) {
  const prev = session.get(chatId);
  if (!prev) return;
  session.delete(chatId);
  await ctx.telegram.deleteMessage(chatId, prev.message_id).catch(() => {});
}

// Task-lifecycle cards (Started -> Done): one card per task, edited in place —
// unless opts.fresh is set (terminal phase), in which case the old card is
// deleted and the new card is sent as the NEWEST message so it becomes the
// current card instead of staying buried up the chat.
async function sendTaskCard(telegram, session, chatId, taskId, text, extra = {}, opts = {}) {
  const key = `${chatId}:${taskId}`;
  const prev = session.get(key);
  if (prev) {
    if (!opts.fresh) {
      try {
        await telegram.editMessageText(chatId, prev.message_id, undefined, text, extra);
        return { message_id: prev.message_id };
      } catch (e) {
        if (isBenignEditError(e) && !isMissingCardError(e)) return { message_id: prev.message_id };
      }
    }
    await telegram.deleteMessage(chatId, prev.message_id).catch(() => {});
    session.delete(key);
  }
  const sent = await telegram.sendMessage(chatId, text, extra).catch(() => null);
  if (sent?.message_id) session.set(key, sent.message_id);
  return sent;
}

module.exports = { createCardSession, sendCard, cardReply, deleteCard, sendTaskCard };
