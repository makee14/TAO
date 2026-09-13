'use strict';
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { SECRET_FILE_GLOBS } = require('./secret-patterns');

const ROBOCOPY_EXCLUDE_DIRS = ['node_modules', '.git', 'data', '.cache', '.tao'];
const ROBOCOPY_EXCLUDE_FILES = SECRET_FILE_GLOBS;

// Build the full robocopy command line: /MIR the workspace into the mirror,
// skipping dependency/cache dirs and any secret-style file globs.
function robocopyArgs(workspace, mirror) {
  return [workspace, mirror, '/MIR', '/XD', ...ROBOCOPY_EXCLUDE_DIRS, '/XF', ...ROBOCOPY_EXCLUDE_FILES, '/NFL', '/NDL', '/NJH', '/NJS'];
}

// Never surface a credential in a log, an error, or the owner's Telegram card.
function redact(text, secret) {
  if (!secret || typeof text !== 'string') return text;
  return text.split(secret).join('***');
}

// Standard GitHub x-access-token auth header, base64-encoded so the raw PAT is
// never present verbatim in process listings, error output, or stored remotes.
function authHeader(pat) {
  const token = `x-access-token:${pat}`;
  return `Authorization: Basic ${Buffer.from(token).toString('base64')}`;
}

// Remote URL intentionally carries NO token — credentials are injected per
// invocation via git -c http.extraHeader, so nothing sensitive is persisted
// into .git/config or echoed back by git on failure.
function buildRemoteUrl(owner, repo) {
  return `https://github.com/${owner}/${repo}.git`;
}

const run = (cmd, args, opts = {}, secret = '') => new Promise((resolve, reject) => {
  execFile(cmd, args, { windowsHide: true, ...opts }, (err, stdout, stderr) => {
    if (err) {
      err.message = redact(err.message, secret);
      err.stdout = redact(stdout, secret);
      err.stderr = redact(stderr, secret);
      return reject(err);
    }
    resolve(String(stdout));
  });
});

// robocopy exit codes 0-7 are success
function robocopyOk(code) { return code >= 0 && code < 8; }

// Pre-push safety gate: the workspace is the source of truth for the agent's
// files, but a remote branch may hold commits this mirror never made (manual
// pushes, another machine). Pushing /MIR-mirrored content over those would
// silently destroy remote-only work — so by default we refuse and let the
// owner decide. `force` is an explicit owner choice to overwrite.
function publishGuard({ aheadCountByMirror, aheadCountByRemote }) {
  if (aheadCountByRemote > 0) return { refusedRemoteAhead: true, remoteAheadCount: aheadCountByRemote, mirrorAheadCount: aheadCountByMirror };
  return { refusedRemoteAhead: false, remoteAheadCount: 0, mirrorAheadCount: aheadCountByMirror };
}

class Publisher {
  constructor({ mirrorDir, pat, defaultBranch = 'main', commitAuthor = 'TAO Agent <tao@localhost>', apiFetch = fetch, remoteFor = null, allowCreate = true }) {
    Object.assign(this, { mirrorDir, pat, defaultBranch, commitAuthor, apiFetch, remoteFor, allowCreate });
  }

  mirrorFor(owner, repo) { return path.join(this.mirrorDir, `${owner}-${repo}`); }

  #remote(owner, repo) {
    if (this.remoteFor) return this.remoteFor({ owner, repo });
    return buildRemoteUrl(owner, repo);
  }

  #auth() {
    return ['-c', `http.extraHeader=${authHeader(this.pat)}`];
  }

  async #ensureCloned(mirror, owner, repo) {
    if (fs.existsSync(path.join(mirror, '.git'))) return;
    fs.mkdirSync(mirror, { recursive: true });
    try {
      await run('git', [...this.#auth(), 'clone', '--no-checkout', this.#remote(owner, repo), '.'], { cwd: mirror }, this.pat);
    } catch (e) {
      // empty repo (auto_init should prevent this, but be safe): init + add remote
      await run('git', ['init', '-b', this.defaultBranch], { cwd: mirror });
      await run('git', ['remote', 'add', 'origin', this.#remote(owner, repo)], { cwd: mirror }, this.pat);
    }
    await run('git', ['config', 'user.name', this.commitAuthor.split(' <')[0]], { cwd: mirror });
    await run('git', ['config', 'user.email', this.commitAuthor.replace(/.*<|>/g, '')], { cwd: mirror });
  }

  async ensureRepo({ owner, repo, branch }) {
    const headers = { Authorization: `Bearer ${this.pat}`, 'X-GitHub-Api-Version': '2022-11-28' };
    const res = await this.apiFetch(`https://api.github.com/repos/${owner}/${repo}`, { headers });
    if (res.ok) return { created: false };
    if (res.status !== 404) throw new Error(`GitHub API status ${res.status} checking ${owner}/${repo}`);
    if (!this.allowCreate) throw new Error(`repo ${owner}/${repo} does not exist and creation is disabled (github.allowCreate=false)`);
    const create = await this.apiFetch('https://api.github.com/user/repos', {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: repo, private: true, auto_init: true }),
    });
    if (!create.ok) throw new Error(`repo creation failed (HTTP ${create.status}) — check PAT Administration permission`);
    return { created: true, url: (await create.json()).html_url };
  }

  async #remoteAheadCount(mirror, branch) {
    try {
      await run('git', [...this.#auth(), 'fetch', 'origin', '--quiet'], { cwd: mirror }, this.pat);
      const n = await run('git', ['rev-list', '--count', `HEAD..origin/${branch || this.defaultBranch}`], { cwd: mirror });
      return parseInt(String(n).trim(), 10) || 0;
    } catch {
      return 0; // no upstream branch yet (first publish) — nothing to protect
    }
  }

  async publish({ taskId, taskName, workspace, owner, repo, branch, force = false }) {
    const mirror = this.mirrorFor(owner, repo);
    await this.#ensureCloned(mirror, owner, repo);
    // Guard BEFORE touching anything: robocopy /MIR would already clobber the
    // mirror, so the remote-only-commit check must come first.
    const remoteAheadCount = await this.#remoteAheadCount(mirror, branch);
    const guard = publishGuard({ aheadCountByMirror: 0, aheadCountByRemote: remoteAheadCount });
    if (guard.refusedRemoteAhead && !force) {
      return { refusedRemoteAhead: true, remoteAheadCount, pushedFiles: 0, commitSha: null, commitUrl: null };
    }
    // robocopy returns its own code page: use cmd to capture exit code without throwing
    const rcCode = await new Promise(res => execFile('robocopy', robocopyArgs(workspace, mirror),
      { windowsHide: true }, e => res(e ? e.code ?? 16 : 0)));
    if (!robocopyOk(rcCode)) throw new Error(`robocopy failed with exit code ${rcCode}`);
    await run('git', ['add', '-A'], { cwd: mirror });
    const status = await run('git', ['status', '--porcelain'], { cwd: mirror });
    if (!status.trim()) return { commitSha: null, commitUrl: null, pushedFiles: 0, commitMessage: null };
    const commitMsg = taskName ? `task-${taskId}: ${taskName}` : `task-${taskId}: agent run`;
    await run('git', ['commit', '-m', commitMsg], { cwd: mirror });
    const pushArgs = [...this.#auth(), 'push', 'origin', `HEAD:${branch || this.defaultBranch}`];
    if (force) pushArgs.push('--force'); // explicit owner choice to overwrite remote-only work
    try {
      await run('git', pushArgs, { cwd: mirror }, this.pat);
    } catch (e) {
      const blob = `${e.message}\n${e.stderr ?? ''}`;
      if (/non-fast-forward|\[rejected\]/i.test(blob)) {
        // race: the remote moved ahead between the pre-check and the push
        const err = new Error('push rejected — the GitHub branch has commits this publish would overwrite. Retry to re-check, or choose Force publish to replace them.');
        err.code = 'PUSH_REJECTED';
        throw err;
      }
      throw e;
    }
    const sha = (await run('git', ['rev-parse', 'HEAD'], { cwd: mirror })).trim();
    return {
      commitSha: sha,
      commitUrl: `https://github.com/${owner}/${repo}/commit/${sha}`,
      pushedFiles: status.trim().split('\n').length,
      commitMessage: commitMsg,
    };
  }
}

module.exports = { Publisher, publishGuard, redact, authHeader, buildRemoteUrl, robocopyArgs, ROBOCOPY_EXCLUDE_DIRS, ROBOCOPY_EXCLUDE_FILES, SECRET_FILE_GLOBS };
