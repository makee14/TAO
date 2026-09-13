'use strict';

// Matchers per docs/ndjson-samples.md (Phase 0). Adjust here when the CLI schema drifts.
const TEXT_TYPES = new Set(['assistant', 'text', 'say', 'message']);
const ERROR_TYPES = new Set(['error', 'tool_error']);
const USAGE_TYPES = new Set(['usage', 'run_stats', 'completion']);
const THINKING_TYPES = new Set(['thinking', 'reasoning', 'plan']);

function classifyEvent(evt) {
  if (!evt || typeof evt !== 'object') return { kind: 'unknown', raw: evt };
  if (TEXT_TYPES.has(evt.type)) return { kind: 'text', text: evt.message ?? evt.text ?? '' };
  if (ERROR_TYPES.has(evt.type)) return { kind: 'error', text: evt.message ?? 'unknown error' };
  if (USAGE_TYPES.has(evt.type)) return { kind: 'usage', text: evt.message ?? '' };
  if (evt.contentType === 'reasoning') return { kind: 'thinking', text: evt.reasoning ?? evt.text ?? '' };
  if (evt.type === 'tool_use' || evt.type === 'tool_call') {
    const file = evt.path ?? evt.file_path ?? evt.args?.path ?? null;
    if (file) {
      const op = /write|create|new/i.test(evt.name ?? '') ? 'write' : /edit|replace|search/i.test(evt.name ?? '') ? 'edit' : 'tool';
      return { kind: 'file', file, op };
    }
    return { kind: 'file', file: evt.name ?? 'tool', op: 'tool' };
  }
  // real cline --json envelope: {"ts","type":"agent_event","event":{...}} (docs/ndjson-samples.md)
  if (evt.type === 'agent_event' && evt.event && typeof evt.event === 'object') return classifyEvent(evt.event);
  if (THINKING_TYPES.has(evt.type) && (evt.text || evt.reasoning)) return { kind: 'thinking', text: evt.text ?? evt.reasoning };
  if (evt.type === 'done' || evt.type === 'run_result') return { kind: 'text', text: evt.text ?? '' };
  if (evt.type === 'content_start' || evt.type === 'content_end') {
    if (evt.contentType === 'tool' && evt.toolName === 'editor') {
      const file = evt.input?.path ?? null;
      if (file) {
        const op = evt.input?.old_text ? 'edit' : 'write';
        return { kind: 'file', file, op };
      }
    }
    if (evt.contentType === 'reasoning') return { kind: 'thinking', text: evt.reasoning ?? '' };
    return { kind: 'unknown', raw: evt };
  }
  return { kind: 'unknown', raw: evt };
}

function parseLine(line) {
  if (!line || !line.trim()) return null;
  let evt;
  try { evt = JSON.parse(line); } catch { return { kind: 'unknown', raw: line.trim() }; }
  return classifyEvent(evt);
}

module.exports = { parseLine, classifyEvent };
