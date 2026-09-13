'use strict';
const { spawn, execFile } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');
const fs = require('node:fs');
const path = require('node:path');
const { parseLine } = require('./ndjson-parser');

// A clineBin may be a bare command name (resolved via PATH by the shell, e.g.
// the npm shim "cline.cmd") or an explicit path to a binary. We must NOT
// path.resolve() a bare name: path.resolve('cline') joins process.cwd() and
// yields "<orchestrator>\cline" — a file that doesn't exist — which Windows
// reports as "'...\\cline' is not recognized as an internal or external command".
// Only absolutize values that are already path-like (contain a separator or a
// drive letter); keep bare names bare so spawn({ shell: true }) finds them.
function resolveBin(bin) {
  if (!bin || !String(bin).trim()) return 'cline';
  const b = String(bin).trim();
  const isPath = b.includes('/') || b.includes('\\') || /^[A-Za-z]:/.test(b);
  return isPath ? path.resolve(b) : b;
}

// cmd.exe (/c) re-tokenizes the joined command line. Node only quote-wraps
// args that contain whitespace/quotes, so a no-space arg like `pwn&dir` reaches
// cmd unquoted and `&`/`|`/`<>` execute as shell syntax; `%VAR%` also expands
// even inside quotes. Escape every user-influenceable arg before it ever lands
// in a cmd-based spawn.
function cmdEscapeArg(arg) {
  const s = String(arg ?? '');
  if (s === '') return s;
  const scrubbed = s.replace(/"/g, "'");               // never let " break quote balancing
  if (!/[%&|<>^()]/.test(scrubbed)) return scrubbed;   // fast path: no metachars
  // Node quotes args that contain whitespace, which makes & | < > ( ) literal
  // there — the ONLY live vector is %VAR% expansion, and cmd /c expands it even
  // inside quotes with no usable escape. ponytail: a space-arg containing "%"
  // keeps env-substitution (owner-controlled input, local disclosure only).
  if (/\s/.test(scrubbed)) return scrubbed;
  // No whitespace => Node leaves the arg UNQUOTED => cmd treats & | < > ^ ( ) as
  // syntax and expands %VAR%. Caret-escape the syntax chars, and escape "%" as
  // "^%" (the only literal-% encoding that survives a /c expansion pass).
  return scrubbed
    .replace(/([&|<>^()])/g, '^$1')
    .replace(/%/g, '^%');
}

function resolveSpawn(bin, args = []) {
  const resolved = resolveBin(bin);
  if (process.platform !== 'win32') {
    return { command: resolved, spawnArgs: args };
  }

  // Windows platform handling:
  // 1. Bare command names (e.g. "cline" or empty):
  if (!resolved.includes('/') && !resolved.includes('\\') && !/^[A-Za-z]:/.test(resolved)) {
    if (resolved.toLowerCase() === 'cline') {
      const appData = process.env.APPDATA || '';
      if (appData) {
        const exeCandidate = path.join(appData, 'npm', 'node_modules', 'cline', 'node_modules', '@cline', 'cli-windows-x64', 'bin', 'cline.exe');
        if (fs.existsSync(exeCandidate)) {
          return { command: exeCandidate, spawnArgs: args };
        }
        const jsCandidate = path.join(appData, 'npm', 'node_modules', 'cline', 'bin', 'cline');
        if (fs.existsSync(jsCandidate)) {
          return { command: process.execPath, spawnArgs: [jsCandidate, ...args] };
        }
      }
    }
    const comspec = process.env.COMSPEC || 'cmd.exe';
    return { command: comspec, spawnArgs: ['/c', resolved, ...args.map(cmdEscapeArg)] };
  }

  // 2. Explicit path-like values:
  const ext = path.extname(resolved).toLowerCase();
  if (ext === '.cmd' || ext === '.bat') {
    const comspec = process.env.COMSPEC || 'cmd.exe';
    return { command: comspec, spawnArgs: ['/c', resolved, ...args.map(cmdEscapeArg)] };
  }
  if (ext === '.js') {
    return { command: process.execPath, spawnArgs: [resolved, ...args] };
  }
  return { command: resolved, spawnArgs: args };
}

// Two-phase thinking levels Cline accepts; anything else degrades to medium
// instead of breaking the run with an invalid --thinking value.
const THINKING_LEVELS = new Set(['none', 'low', 'medium', 'high', 'xhigh']);
const THINKING_FALLBACK = 'medium';

function buildArgs(task, { provider, model, visionProvider, visionModel, retries, thinking, planThinking, actThinking, hook }, promptFile) {
  const photoPaths = (Array.isArray(task.photos) && task.photos.length > 0)
    ? task.photos
    : (task.imagePath ? [task.imagePath] : []);
  const hasPhotos = photoPaths.length > 0;

  const effectiveProvider = (hasPhotos && visionProvider) ? visionProvider : provider;
  const effectiveModel = (hasPhotos && visionModel) ? visionModel : model;

  // Mode: plan mode must use Cline's real -p switch (never --yolo).
  const isPlanMode = task.mode === 'plan' || task.isPlan === true;

  // Tasks always run hands-free: the approval requirement was removed, so we
  // never turn auto-approve off (Cline defaults it ON; plan mode still gets -p).
  // Two-phase thinking: high for making a plan, lower for implementing.
  const effectiveThinking = isPlanMode
    ? (planThinking || 'high')
    : (actThinking || thinking || 'medium');
  const thinkingLevel = THINKING_LEVELS.has(effectiveThinking) ? effectiveThinking : THINKING_FALLBACK;

  const args = ['--json', '--retries', String(retries), '-c', task.workspace];
  if (isPlanMode) args.unshift('-p');
  args.push('--auto-approve', 'true');
  if (effectiveProvider) args.push('-P', effectiveProvider);
  if (effectiveModel) args.push('-m', effectiveModel);
  args.push('--thinking', thinkingLevel);

  const lines = [`You are working on task ${task.id} ("${task.name}") in workspace ${task.workspace}.`, '', task.prompt];
  // The owner's hook (managed via /hook) is injected at the very top of every
  // prompt so standing rules bind before the task instructions.
  if (hook && String(hook).trim()) {
    lines.splice(1, 0, '', '=== AGENT HOOK (TAO) ===', String(hook).trim(), '');
  }
  if (isPlanMode) {
    lines.push('', '=== MODE: PLAN ===', 'Focus exclusively on analyzing requirements and producing an implementation plan. Do NOT make source code changes or run state-modifying actions without user review.');
  }
  if (hasPhotos) {
    if (task.visualAnalysis && task.visualAnalysis.trim()) {
      lines.push('', '=== VISUAL REFERENCE DESIGN SPECIFICATION ===', task.visualAnalysis.trim(), '=============================================');
    }
    const label = photoPaths.length > 1 ? 'Reference image files' : 'Reference image file';
    lines.push('', `${label} (stored outside workspace in central attachments):`);
    for (const p of photoPaths) {
      lines.push(`- ${p}`);
    }
    lines.push('Note: The workspace must contain ONLY files generated for the task. Do NOT copy reference photos into the workspace.');
    lines.push('If your model supports image input, you may inspect the reference image directly with the read_files tool using the path above.');
  }
  if (task.followUpOf) lines.push('', `This is a follow-up to task ${task.followUpOf}; the previous run finished with summary: ${task.prevSummary ?? '(unavailable)'}`);
  lines.push('', 'When finished, reply with a short summary of what you did. Do NOT call any helper script or write sentinel files - the orchestrator detects completion from process exit.');
  let prompt = lines.join('\n');
  // Windows CreateProcess command line is capped (~8k chars). For long prompts,
  // write the prompt to a file and tell the agent to read it first.
  if (prompt.length > 7000 && promptFile) {
    fs.writeFileSync(promptFile, prompt, 'utf8');
    prompt = `Your full task instructions are in the file ${promptFile}. Read that file first, then execute the task inside it.`;
  }
  args.push(prompt);
  return { args, prompt };
}

class CliRunner {
  constructor({ clineBin, provider = '', model = '', visionProvider = '', visionModel = '', retries = 3, timeoutSec = 1800, thinking, planThinking, actThinking, runsDir, hook = '' }) {
    Object.assign(this, { clineBin, provider, model, visionProvider, visionModel, retries, timeoutSec, thinking, planThinking, actThinking, runsDir, hook });
    this.lastPid = null;
  }
  abort(pid) {
    return new Promise(resolve => execFile('taskkill', ['/PID', String(pid), '/T', '/F'], () => resolve()));
  }
  run(task, { onEvent = () => {}, promptFile } = {}) {
    fs.mkdirSync(this.runsDir, { recursive: true }); // must exist before buildArgs may spill a long prompt to it
    const { args, prompt } = buildArgs(task, this, promptFile);
    const { command, spawnArgs } = resolveSpawn(this.clineBin, args);
    const runLogPath = path.join(this.runsDir, `task-${task.id}.ndjson`);
    const log = fs.createWriteStream(runLogPath);
    const started = Date.now();
    return new Promise(resolve => {
      const child = spawn(command, spawnArgs, { cwd: task.workspace, stdio: ['ignore', 'pipe', 'pipe'], shell: false, windowsHide: true });
      this.lastPid = child.pid;
      task.pid = child.pid;
      let lastText = '', timedOut = false, done = false;
      const timer = setTimeout(() => { timedOut = true; this.abort(child.pid); }, this.timeoutSec * 1000);
      // Line-buffer the child's output: network chunks split NDJSON lines and
      // multi-byte UTF-8 chars mid-sequence, which corrupted lines and emitted
      // phantom "unknown" events (losing real ones at the seam). StringDecoder
      // holds the partial line + partial char until the sequence completes;
      // the final partial is flushed on close so a trailing line without \n
      // still parses.
      const decoder = new StringDecoder('utf8');
      let lineBuf = '';
      const feed = buf => {
        lineBuf += decoder.write(buf);
        let idx;
        while ((idx = lineBuf.indexOf('\n')) >= 0) {
          const line = lineBuf.slice(0, idx).replace(/\r$/, '');
          lineBuf = lineBuf.slice(idx + 1);
          emitLine(line);
        }
      };
      const emitLine = line => {
        log.write(line + '\n');
        const evt = parseLine(line);
        if (!evt) return;
        if (evt.kind === 'text' && evt.text) lastText = evt.text;
        onEvent(evt);
      };
      const finishLineBuf = () => {
        const tail = (lineBuf + decoder.end()).replace(/\r$/, '');
        lineBuf = '';
        if (tail) emitLine(tail);
      };
      child.stdout.on('data', feed);
      child.stderr.on('data', feed); // diagnostics also flow through the parser
      child.on('error', err => {
        if (done) return;
        done = true;
        clearTimeout(timer); finishLineBuf(); log.end();
        resolve({ exitCode: 1, durationSec: (Date.now() - started) / 1000, lastText, runLogPath, pid: child.pid, error: `spawn error: ${err.message}` });
      });
      child.on('close', code => {
        if (done) return;
        done = true;
        clearTimeout(timer); finishLineBuf(); log.end();
        if (timedOut) return resolve({ exitCode: null, durationSec: (Date.now() - started) / 1000, lastText, runLogPath, pid: child.pid, error: `timed out after ${this.timeoutSec}s` });
        resolve({ exitCode: code, durationSec: (Date.now() - started) / 1000, lastText, runLogPath, pid: child.pid, error: null });
      });
    });
  }
}

module.exports = { CliRunner, buildArgs, resolveBin, resolveSpawn, cmdEscapeArg };
