'use strict';

function dedupeFiles(list) {
  const byPath = new Map();
  for (const f of list) byPath.set(f.path, f.op); // one entry per path — the latest op wins
  return [...byPath].map(([path, op]) => ({ path, op }));
}

class EventRouter {
  constructor({ debounceMs = 30000, onMilestone }) {
    this.debounceMs = debounceMs; this.onMilestone = onMilestone;
    this.pending = []; this.timer = null; this.lastText = '';
    this.lastThinking = '';
    this.files = [];
    this.emittedPaths = new Set();
  }
  #emitFiles() {
    const unique = dedupeFiles(this.pending.filter(f => !this.emittedPaths.has(f.path)));
    this.pending = [];
    if (!unique.length) return;
    for (const f of unique) { this.emittedPaths.add(f.path); this.files.push(f); }
    this.onMilestone({ type: 'files', files: unique });
  }
  handle(evt) {
    if (evt.kind === 'file') {
      this.pending.push({ path: evt.file, op: evt.op });
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.#emitFiles(), this.debounceMs);
    } else if (evt.kind === 'error') {
      this.onMilestone({ type: 'error', text: evt.text });
    } else if (evt.kind === 'thinking' && evt.text) {
      // reasoning/thinking surfaced immediately (compact) so the live card can
      // show the agent's plan as it forms
      this.lastThinking = evt.text;
      this.onMilestone({ type: 'thinking', text: evt.text });
    } else if (evt.kind === 'text' && evt.text) {
      this.lastText = evt.text; // stored for /status, not pushed (anti-spam)
    }
  }
  flush() { clearTimeout(this.timer); this.#emitFiles(); }
}

module.exports = { EventRouter };
