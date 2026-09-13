'use strict';
const fs = require('node:fs');
const path = require('node:path');

// Skill files are plain markdown the owner curates for the agent. Names are
// strict (`^\w-+$`) because they become filenames and button payloads.
const SKILL_NAME_RE = /^[\w-]+$/;

// Cline skills (.md) carry YAML frontmatter: "---\nname: …\ndescription: …\n---".
function parseSkillMeta(content) {
  const text = String(content ?? '');
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { description: '' };
  const d = /^description:\s*(.+)$/m.exec(m[1]);
  const desc = d ? d[1].trim().replace(/^["']|["']$/g, '') : '';
  return { description: desc };
}

function firstLine(text) {
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const t = line.trim();
    if (t) return t.replace(/^#+\s*/, '').slice(0, 120);
  }
  return '';
}

function listSkills(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.md'))
    .map(f => {
      const p = path.join(dir, f);
      const content = fs.readFileSync(p, 'utf8');
      return { name: f.replace(/\.md$/i, ''), path: p, size: fs.statSync(p).size, description: parseSkillMeta(content).description || firstLine(content) };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function skillPath(dir, name) {
  if (!SKILL_NAME_RE.test(name)) throw new Error(`invalid skill name "${name}" — use letters, digits, - or _`);
  return path.join(dir, `${name}.md`);
}

function readSkill(dir, name) {
  const p = skillPath(dir, name);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, 'utf8');
}

function createSkill(dir, name, content) {
  const p = skillPath(dir, name); // validates the name first
  let body = String(content ?? '');
  if (!/^---\r?\n/.test(body.trimStart())) {
    body = `---\nname: ${name}\ndescription: ${firstLine(body)}\n---\n\n${body}`;
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(p, body, 'utf8');
  return p;
}

function deleteSkill(dir, name) {
  const p = skillPath(dir, name);
  if (!fs.existsSync(p)) return false;
  fs.unlinkSync(p);
  return true;
}

// ── Agent hook: one markdown file injected into EVERY task prompt ───────────
const HOOK_FILE = 'hook.md';

function hookPath(dir) { return path.join(dir, HOOK_FILE); }

function readHook(dir) {
  const p = hookPath(dir);
  if (!fs.existsSync(p)) return null;
  const text = fs.readFileSync(p, 'utf8');
  return text.trim() ? text : null;
}

function writeHook(dir, content) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(hookPath(dir), String(content ?? ''), 'utf8');
}

function clearHook(dir) {
  const p = hookPath(dir);
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

// "@name" or "@name.md" mentions of EXISTING skills (case-insensitive).
const SKILL_MENTION_RE = /@([A-Za-z0-9_-]+)(?:\.md)?/g;
function findSkillMentions(text, skillNames) {
  const lower = skillNames.map(n => n.toLowerCase());
  const found = new Set();
  for (const m of String(text ?? '').matchAll(SKILL_MENTION_RE)) {
    const n = m[1].toLowerCase();
    if (lower.includes(n)) found.add(n);
  }
  return [...found];
}

module.exports = { listSkills, readSkill, createSkill, deleteSkill, hookPath, readHook, writeHook, clearHook, findSkillMentions, SKILL_NAME_RE };