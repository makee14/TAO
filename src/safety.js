'use strict';

function buildShutdownPlan(store, mode) {
  const running = store.byState('running');
  const queued = store.byState('queued');
  const blocked = store.byState('blocked');
  if (mode === 'force')
    return { mode, action: 'force', runningIds: running.map(t => t.id), queuedIds: queued.map(t => t.id),
      pids: running.map(t => t.pid).filter(Boolean), cancelIds: [...running, ...queued, ...blocked].map(t => t.id) };
  return { mode, action: 'drain', runningIds: running.map(t => t.id), queuedIds: [...queued, ...blocked].map(t => t.id), pids: [], cancelIds: [] };
}

class ShutdownCtl {
  constructor({ graceSec = 60, pollMs = 2000, execImpl = null, closeWindows = null }) {
    this.graceSec = graceSec; this.pollMs = pollMs; this.closeWindows = closeWindows;
    this.execImpl = execImpl ?? ((cmd, args) => new Promise(res =>
      require('node:child_process').execFile(cmd, args, () => res())));
  }
  async requestDrain(store) {
    while (store.byState('running').length > 0) await new Promise(r => setTimeout(r, this.pollMs));
  }
  async forceShutdown() {
    try { await this.execImpl('shutdown', ['/a']); } catch { /* none scheduled */ }
    if (this.closeWindows) await this.closeWindows();
    await this.execImpl('shutdown', ['/s', '/t', String(this.graceSec)]);
  }
  async abort() { try { await this.execImpl('shutdown', ['/a']); } catch { /* none pending */ } }
}

module.exports = { buildShutdownPlan, ShutdownCtl };
