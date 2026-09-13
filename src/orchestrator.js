'use strict';
// Task-lifecycle orchestration: everything between scheduler.pump() launching
// a task and its done/failed card. The runner is the injected CliRunner
// (cline --yolo --json) — this module never spawns processes and never talks
// to GitHub directly (publisher does).
const fs = require('node:fs');
const path = require('node:path');
const { EventRouter } = require('./event-router');
const { createCardSession, sendTaskCard } = require('./card-session');
const { fmtStarted, fmtFiles, fmtDone, fmtPendingPublishes, esc } = require('./formatter');
const { kb, btn, taskKeyboard, publishKeyboard } = require('./ui');
const { fmtAiFailure, classifyAiError } = require('./ai-errors');
const { keysOf, rotateGeminiKey } = require('./gemini-keys');
const { bootMessage } = require('./system-info');
const { saveTaskPhotos } = require('./photo-storage');
const { describeTaskPhotos } = require('./visual-analyzer');

function createRunTask({ cfg, store, runner, publisher, telegram, registry = {}, eventCards = createCardSession(), lastTexts = new Map(), fetchFn = globalThis.fetch, saveConfig }) {
  const progressMsgs = new Map();  // taskId -> [tg messageIds] (milestone messages)
  const milestoneIds = new Map(); // taskId -> last milestone message_id (edited in place)
  const milestoneFiles = new Map(); // taskId -> cumulative changed files (the milestone grows in place)

  async function pushMilestone(task, m) {
    try {
      if (m.type === 'files') {
        // The router emits per-batch deltas; the milestone card renders the
        // cumulative list so each in-place edit shows every file so far.
        const seen = new Map((milestoneFiles.get(task.id) ?? []).map(f => [f.path, f.op]));
        for (const f of m.files) seen.set(f.path, f.op); // latest op wins
        milestoneFiles.set(task.id, [...seen].map(([p, op]) => ({ path: p, op })));
      }
      const text = m.type === 'files' ? fmtFiles(task, milestoneFiles.get(task.id)) : `⚠️ ${esc(task.id)}: ${esc(m.text)}`;
      const prevId = milestoneIds.get(task.id);
      if (prevId && typeof telegram.editMessageText === 'function') {
        await telegram.editMessageText(cfg.telegram.userId, prevId, undefined, text, { parse_mode: 'HTML' });
        return; // one static milestone message that grows in place
      }
      const msg = await telegram.sendMessage(cfg.telegram.userId, text, { parse_mode: 'HTML' });
      milestoneIds.set(task.id, msg.message_id);
      progressMsgs.get(task.id)?.push(msg.message_id);
    } catch { /* offline Telegram: the run log still records everything */ }
  }

  return async function runTask(task) {
    // Long prompts can exceed the Windows ~8k argv cap; cli-runner spills them
    // to this file under the runs dir and tells the agent to read it first.
    const promptFile = cfg.paths?.runs ? path.join(path.resolve(cfg.paths.runs), `task-${task.id}.prompt`) : null;
    const router = new EventRouter({ debounceMs: cfg.progress.debounceSec * 1000, onMilestone: m => pushMilestone(task, m) });
    progressMsgs.set(task.id, []);

    const startTime = Date.now();
    let currentActivity = null;
    let currentThinking = null;
    let lastCardUpdate = 0;
    let liveTimer = null;

    let liveBusy = false;
    async function updateCardLive() {
      if (liveBusy) return;                    // a render is already in flight — coalesce
      const now = Date.now();
      if (now - lastCardUpdate < 3500) {
        if (!liveTimer) {
          liveTimer = setTimeout(() => {
            liveTimer = null;
            updateCardLive().catch(() => {});
          }, 3500 - (now - lastCardUpdate));
        }
        return;
      }
      if (liveTimer) { clearTimeout(liveTimer); liveTimer = null; }
      if (typeof telegram.editMessageText !== 'function') return; // legacy proxy: no live edits
      lastCardUpdate = now;
      liveBusy = true;
      try {
        const elapsedSec = Math.floor((Date.now() - startTime) / 1000);
        await sendTaskCard(telegram, eventCards, cfg.telegram.userId, task.id,
          fmtStarted(task, { elapsedSec, activity: currentActivity, thinking: currentThinking }),
          { parse_mode: 'HTML', reply_markup: kb(...taskKeyboard(task, 'started')) }).catch(() => {});
      } finally { liveBusy = false; }
    }

    try {
      await sendTaskCard(telegram, eventCards, cfg.telegram.userId, task.id, fmtStarted(task),
        { parse_mode: 'HTML', reply_markup: kb(...taskKeyboard(task, 'started')) }).catch(() => {});
      // Save photos exclusively to central attachments storage and generate visual analysis
      const photoIds = (Array.isArray(task.photos) && task.photos.length > 0)
        ? task.photos
        : (task.imagePath ? [task.imagePath] : []);
      if (photoIds.length > 0) {
        try {
          const savedPaths = await saveTaskPhotos({
            telegram,
            taskId: task.id,
            attachmentsDir: path.resolve(cfg.paths?.attachments || './data/attachments'),
            fileIds: photoIds,
            fetchFn,
          });
          if (savedPaths.length > 0) {
            task.photos = savedPaths;
            task.imagePath = savedPaths[0];
            const visualAnalysis = await describeTaskPhotos(savedPaths, {
              apiKey: process.env.GEMINI_API_KEY || cfg.vision?.apiKey,
              fetchFn,
            });
            task.visualAnalysis = visualAnalysis || null;
            store.update(task.id, { photos: savedPaths, imagePath: savedPaths[0], visualAnalysis: task.visualAnalysis });
          }
        } catch { /* the run proceeds even if photo saving or analysis fails */ }
      }
      const result = await runner.run(task, {
        promptFile,
        onEvent: e => {
          if (e.kind === 'text' && e.text) {
            lastTexts.set(task.id, e.text); // live tail for /status
            currentActivity = e.text;
          } else if (e.kind === 'thinking' && e.text) {
            currentThinking = e.text.slice(0, 200); // show the agent's reasoning live
          } else if (e.activity) {
            currentActivity = e.activity;
          } else if (e.text) {
            currentActivity = e.text;
          } else if (e.kind === 'file' && e.file) {
            currentActivity = `${e.op || 'modified'} ${e.file}`;
          }
          router.handle(e);
          updateCardLive().catch(() => {});
        },
      });
      // Flush BEFORE the terminal card: router.files is only populated by
      // flush/#emitFiles, and fileChanges below are persisted from it. (The
      // plan called this flush redundant — it is not; the finally flush runs
      // after the store.update and would drop trailing files.)
      router.flush();
      let commitUrl = null;
      const willPublish = task.repo && result.exitCode === 0;
      if (willPublish) {
        if (cfg.orchestration?.publishConfirmation === false) {
          // legacy auto-push path
          try {
            const { owner, repo } = task.repo;
            const branch = task.repo.branch || cfg.github.defaultBranch;
            await publisher.ensureRepo({ owner, repo, branch });
            commitUrl = (await publisher.publish({ taskId: task.id, taskName: task.name, workspace: task.workspace, owner, repo, branch })).commitUrl;
          } catch (e) {
            await telegram.sendMessage(cfg.telegram.userId, `⚠️ Publish failed for ${esc(task.id)}: ${esc(e.message)}`, { parse_mode: 'HTML' }).catch(() => {});
          }
        } else {
          // confirmation gate: stay unpushed until the owner reviews and taps ✅ Publish
          store.update(task.id, { publishState: 'pending' });
        }
      }
      // fileChanges were collected by the router but never persisted, so /files and the Files button always said "(none recorded)"
      const t = store.update(task.id, {
        state: result.exitCode === 0 ? 'done' : 'failed',
        exitCode: result.exitCode, error: result.error, summary: result.lastText ?? '',
        commitUrl, pid: null, fileChanges: router.files,
        publishState: willPublish
          ? (commitUrl ? 'published' : cfg.orchestration?.publishConfirmation === false ? 'error' : 'pending')
          : null,
      });
      const awaitingPublish = t.publishState === 'pending';
      const sent = await sendTaskCard(telegram, eventCards, cfg.telegram.userId, t.id,
        fmtDone(t, { exitCode: result.exitCode, durationSec: result.durationSec, error: result.error }),
        { parse_mode: 'HTML', reply_markup: kb(...taskKeyboard(t, 'done'), ...(awaitingPublish ? publishKeyboard(t) : [])) },
        { fresh: true });
      if (sent?.message_id) store.update(t.id, { tgMessageId: sent.message_id }); // enables reply-to-done-message follow-ups

      // Friendly AI-provider failures (quota / rate limit / auth / network) get
      // a guided card with concrete next steps instead of the raw scary error.
      if (result.exitCode !== 0 && result.error) {
        const aiKind = classifyAiError(result.error).kind;
        // Auto-rotate the Gemini key pool on quota exhaustion (Cline-CLI-style
        // combo): rotate, apply, and re-queue the SAME task once — the retry
        // spawns with the fresh key. Never loops: rotationRetried guard.
        if (aiKind === 'quota' && cfg.cline?.provider === 'gemini' && keysOf(cfg).length >= 2 && !task.rotationRetried) {
          const next = rotateGeminiKey(cfg, { saveConfig });
          if (next) {
            await telegram.sendMessage(cfg.telegram.userId,
              `🔄 <b>${esc(task.id)}</b> — Gemini key pool rotated to ***${esc(String(next).slice(-6))} after a quota error. Re-queuing the task once.`,
              { parse_mode: 'HTML', reply_markup: kb([btn('📊 Status', 'cmd:status'), btn('🏠 Menu', 'cmd:help')]) }).catch(() => {});
            store.update(task.id, { state: 'queued', rotationRetried: true, error: null, pid: null });
            // Returning 'queued' makes the scheduler's markFinished re-pump the
            // queue, which relaunches this same task with the fresh key.
            return { state: 'queued', exitCode: null, error: null, rotated: true };
          }
        }
        const ai = fmtAiFailure(t, result.error);
        if (ai) {
          await telegram.sendMessage(cfg.telegram.userId, ai.text,
            { parse_mode: 'HTML', reply_markup: kb(...ai.keyboardRows) }).catch(() => {});
        }
      }

      return { state: t.state, exitCode: result.exitCode, error: result.error };
    } finally {
      if (liveTimer) {
        clearTimeout(liveTimer);
        liveTimer = null;
      }
      router.flush();              // emit anything still debounced even if the run threw
      if (promptFile) { try { fs.unlinkSync(promptFile); } catch { /* too short to spill — never created */ } }
      lastTexts.delete(task.id);   // the run is over — the live tail is stale
      if (cfg.progress.autoDeleteProgress) {
        for (const id of progressMsgs.get(task.id) ?? []) telegram.deleteMessage(cfg.telegram.userId, id).catch(() => {});
      }
      progressMsgs.delete(task.id);
      milestoneIds.delete(task.id);
      milestoneFiles.delete(task.id);
    }
  };
}

// Runs once when the bot comes online: announce, heal interrupted runs, resume the queue.
async function bootSequence({ store, scheduler, telegram, userId }) {
  const s = scheduler.stats();
  await telegram.sendMessage(userId, bootMessage({ running: s.running, queued: s.queued }),
    { parse_mode: 'HTML', reply_markup: kb([btn('📊 Status', 'cmd:status'), btn('🏠 Menu', 'cmd:help')]) }).catch(() => {});
  for (const t of store.byState('running')) {
    store.update(t.id, { state: 'failed', pid: null, error: 'orchestrator restarted mid-run' });
  }
  const pending = store.all().filter(t => t.publishState === 'pending');
  if (pending.length) await telegram.sendMessage(userId, fmtPendingPublishes(pending),
    { parse_mode: 'HTML', reply_markup: kb([btn('📋 List tasks', 'cmd:list'), btn('🏠 Menu', 'cmd:help')]) }).catch(() => {});
  await scheduler.pump();
}

module.exports = { createRunTask, bootSequence };