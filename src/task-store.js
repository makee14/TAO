'use strict';
const fs = require('node:fs');
const path = require('node:path');

// Sequential, human-friendly task ids: T-00001, T-00002, … Continue the numeration
// from the highest existing /^T-(\d+)$/ id so legacy base36 ids (T-k3j2x9) keep
// their own ids and are simply ignored for numbering.
function nextTaskId(tasks) {
  let max = 0;
  for (const t of tasks) {
    const m = /^T-(\d+)$/.exec(t.id);
    if (m && Number(m[1]) > max) max = Number(m[1]);
  }
  return `T-${String(max + 1).padStart(5, '0')}`;
}

class TaskStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.tasks = new Map();
    if (fs.existsSync(filePath)) {
      try { for (const t of JSON.parse(fs.readFileSync(filePath, 'utf8'))) this.tasks.set(t.id, t); }
      catch { /* corrupt file: start empty, keep the bad file as .bak */ fs.copyFileSync(filePath, filePath + '.bak'); }
    }
  }
  #persist() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify([...this.tasks.values()], null, 2));
  }
  create(fields) {
    const rawPhotos = Array.isArray(fields.photos)
      ? fields.photos
      : (fields.imagePath ? [fields.imagePath] : []);
    const photos = rawPhotos.filter(Boolean);
    const imagePath = fields.imagePath || (photos[0] ?? null);
    const visualAnalysis = fields.visualAnalysis ?? null;
    const t = { id: nextTaskId(this.all()), state: 'queued', attempts: 0, pid: null,
      exitCode: null, error: null, summary: '', fileChanges: [], runLogPath: null, commitUrl: null,
      followUpOf: null, tgMessageId: null, imagePath, photos, visualAnalysis, after: null, repo: null, publishState: null,
      createdAt: new Date().toISOString(), startedAt: null, finishedAt: null, ...fields, imagePath, photos, visualAnalysis };
    this.tasks.set(t.id, t); this.#persist(); return t;
  }
  get(id) { return this.tasks.get(id) ?? null; }
  all() { return [...this.tasks.values()]; }
  byState(state) { return this.all().filter(t => t.state === state); }
  update(id, patch) {
    const t = this.tasks.get(id);
    if (!t) throw new Error(`unknown task ${id}`);
    Object.assign(t, patch); this.#persist(); return t;
  }
  purge(olderThanDate) {
    const terminal = new Set(['done', 'failed', 'cancelled']);
    const olderThan = olderThanDate instanceof Date ? olderThanDate : new Date(olderThanDate);
    let removed = 0;
    for (const t of this.all()) {
      if (t.publishState === 'pending') continue;            // an owed push is never silently dropped
      if (!t.finishedAt || !terminal.has(t.state)) continue; // keep in-flight and always-visible state
      if (new Date(t.finishedAt) < olderThan) { this.tasks.delete(t.id); removed++; }
    }
    if (removed) this.#persist();
    return { removed };
  }
}

module.exports = { TaskStore };
