'use strict';

// A dependency is "settled" once it will never run again — done, failed,
// cancelled — or is absent from the store. Only an ACTIVE dependency keeps
// its successor blocked. This is what un-dead-locks pipeline steps whose
// upstream failed or was cancelled (previously: stuck `blocked` forever).
const TERMINAL = new Set(['done', 'failed', 'cancelled']);

function pickReadyTasks(tasks, runningWorkspaces, maxParallel) {
  const byId = new Map(tasks.map(t => [t.id, t]));
  const depSettled = after => {
    if (!after) return true;
    const dep = byId.get(after);
    return !dep || TERMINAL.has(dep.state);
  };
  const slots = Math.max(0, maxParallel - tasks.filter(t => t.state === 'running').length);
  const ready = [];
  // occupiedWorkspaces starts from ALL running workspaces (ponytail: the extra
  // per-task `tasks.some(o => state==='running' && ws)` scan this replaced was
  // O(n²) and fully redundant — same set, computed once by the caller).
  const occupiedWorkspaces = new Set(runningWorkspaces);
  for (const t of tasks) {
    if (ready.length >= slots) break;
    if (t.state !== 'queued' && t.state !== 'blocked') continue;
    if (!depSettled(t.after)) continue;
    if (occupiedWorkspaces.has(t.workspace)) continue;
    ready.push(t);
    occupiedWorkspaces.add(t.workspace);
  }
  return ready;
}

class Scheduler {
  constructor({ store, maxParallel, circuitBreaker, onRun, onCircuitOpen = () => {}, now = () => Date.now() }) {
    this.store = store; this.maxParallel = maxParallel;
    this.circuitBreaker = circuitBreaker ?? { enabled: false };
    this.onRun = onRun; this.onCircuitOpen = onCircuitOpen;
    this.now = now;
    this.paused = false; this.pauseReason = null; this.failStreak = 0;
    this.breakerOpenedAt = null; this.pumping = false; this.repump = false;
  }
  cooldownMs() { return (this.circuitBreaker.cooldownSec ?? 90) * 1000; }
  pause(reason = 'manual') { this.paused = true; this.pauseReason = reason; }
  resume() { this.paused = false; this.pauseReason = null; this.failStreak = 0; }
  isPaused() { return this.paused; }
  stats() {
    const all = this.store.all();
    return { running: all.filter(t => t.state === 'running').length,
      queued: all.filter(t => t.state === 'queued').length,
      blocked: all.filter(t => t.state === 'blocked').length,
      paused: this.paused, pauseReason: this.pauseReason, failStreak: this.failStreak };
  }
  markFinished(id, { state, exitCode = null, error = null }) {
    const t = this.store.update(id, { state, exitCode, error, finishedAt: new Date().toISOString(), pid: null });
    if (state === 'failed') {
      this.failStreak++;
      if (this.circuitBreaker.enabled && this.failStreak >= this.circuitBreaker.maxConsecutiveFailures) {
        this.breakerOpenedAt = this.now();
        this.pause('breaker');
        this.onCircuitOpen(this.failStreak);
      }
    } else if (state === 'done') this.failStreak = 0;
    this.pump();
    return t;
  }
  async pump() {
    // A breaker pause is self-healing: once the cooldown elapses, resume and
    // retry. A manual pause (pause or panic command, drain) is never auto-resumed.
    if (this.paused && this.pauseReason === 'breaker' && (this.now() - this.breakerOpenedAt) >= this.cooldownMs()) {
      this.resume();
    }
    if (this.paused) return;
    if (this.pumping) { this.repump = true; return; } // never drop the request — the in-flight pump loops again
    this.pumping = true;
    try {
      do {
        this.repump = false;
        const running = this.store.byState('running');
        const workspaces = new Set(running.map(t => t.workspace));
        for (const t of pickReadyTasks(this.store.all(), workspaces, this.maxParallel)) {
          this.store.update(t.id, { state: 'running', startedAt: new Date().toISOString(), attempts: t.attempts + 1 });
          this.onRun(this.store.get(t.id))
            .then(r => this.markFinished(t.id, r ?? { state: 'done' }))
            .catch(e => this.markFinished(t.id, { state: 'failed', error: String(e.message || e) }));
        }
      } while (this.repump); // work created during this pump is launched without waiting for the next event
    } finally { this.pumping = false; }
  }
}

module.exports = { Scheduler, pickReadyTasks };
