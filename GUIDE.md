# TAO — Telegram Agent Orchestrator

This is the complete beginner guide for TAO. Follow it top to bottom and you will have a working bot in about 10 minutes.

TAO is a Windows program that lets you control AI coding agents from your phone through Telegram. You send a prompt from anywhere, watch live progress in the chat, and the results are automatically published to a GitHub repository. When everything is done you can even shut your PC down safely from the same chat.

Here is the big picture:

```
You (phone)  ──Telegram──►  TAO (your Windows PC)  ──spawns──►  Cline CLI agents
                                 │                                    │
                                 ▼                                    ▼
                            live progress ◄────NDJSON events────  your project folder
                                 │
                                 ▼
                          GitHub repo (auto-committed & pushed)
```

One machine owns the bot. Every message is checked against your Telegram user ID, so nobody else can use your bot even if they find it. Setup asks you to message the bot once so it can capture your ID automatically.

## Behavior snapshot

- New tasks: `/newtask` is a guided flow that asks plan/act mode, workspace, GitHub publish (create/choose/skip), name, auto-approve, and prompt — with template suggestions you can paste into your draft.
- When a remote is found you get a one-tap confirm; when none is found you still get the publish question (you can create or type a repo since you have a PAT).
- Settings hub: `/settings` groups agent mode, auto-approve, two-phase thinking, provider, model, Gemini keys, skills, and hook — all navigable from one card.
- Skills and hook: `/skill` manages `.md` skill files on the machine; `/hook` reads/edits a standing-rules hook prepended to every task prompt.
- Cards: menu/status cards are edited in place; task cards re-surface as the latest message when they change phase — the finished outcome is always the newest thing in the chat.
- Every card has a Menu or Back button — nothing is a dead end.
- One slash command per line — every command reference appears on its own line.

## How the chat works

TAO uses a single-card chat model. Instead of sending a new message for every interaction, TAO keeps one interactive card per chat and edits it in place. This means:

- When you tap `/status` twice, the second tap updates the first card — you never see duplicates.
- When a task finishes, the old "Started" card is cleared and a fresh "Done" (or "Failed") card appears as the newest message — nothing overshadows the result.
- Every card has a navigation button — `🏠 Menu`, `⬅️ Back`, or `🚫 Cancel` — so you're never stuck.
- Tapping a button on a card edits that card's content and keyboard, replacing whatever was there before.

This keeps your chat clean and predictable. No scrolling through dozens of bot messages, no duplicate buttons, no dead ends.

## 1. What you need before starting

TAO needs three tools on your PC. Check what you already have first, then install whatever is missing.

Open PowerShell (press the Windows key, type powershell, press Enter) and run:

```powershell
node --version    # Node.js — runs TAO itself
git --version     # Git — clones TAO and publishes results to GitHub
cline --version   # Cline CLI — the AI agent that does the work
```

If a command prints a version number, that tool is already installed — skip it. If PowerShell says it is not recognized, install it with one command in 1a to 1c below.

You will also need two tokens. The next section shows how to create them:

- A Telegram bot token
- A GitHub Personal Access Token (PAT)

### 1a. Install Node.js

If `node --version` is not recognized, install it with this command:

```powershell
winget install OpenJS.NodeJS.LTS
```

winget is the official Windows package manager, built into Windows 10 and 11, so this downloads and installs everything for you. Prefer clicking? Download the LTS installer from https://nodejs.org instead and click Next through it — both do the same thing.

When it finishes, close PowerShell and open it again. This matters: PowerShell only sees new programs after a restart. Then check again:

```powershell
node --version
```

You should see something like `v22.14.0`. The first number must be 20 or higher.

### 1b. Install Git

If `git --version` is not recognized:

```powershell
winget install Git.Git
```

Or download the installer from https://git-scm.com/download/win and click Next through it. Then close and reopen PowerShell and check again:

```powershell
git --version
```

### 1c. Install the Cline CLI

Needs Node.js from 1a first. Then run:

```powershell
npm i -g cline
```

Check it:

```powershell
cline --version
```

You should see a version number like `3.0.60`.

If any check still fails after reopening PowerShell, restart the PC once — on rare occasions Windows finishes applying PATH changes only after a full reboot.

## 2. Get your accounts ready

### 2a. Create your Telegram bot (2 minutes)

1. Open Telegram and search for @BotFather (the verified one with a blue check).
2. Send `/newbot` and follow the prompts. Pick any name and username you like.
3. BotFather replies with a token that looks like `123456789:AAE...abc`. Copy it and keep it private.

### 2b. Create a GitHub token (3 minutes)

1. On GitHub, click your avatar, then Settings, then Developer settings at the bottom of the left menu.
2. Go to Personal access tokens, then Fine-grained tokens, then Generate new token.
3. Give it access to All repositories so TAO can create new ones, with these permissions:
   - Contents: Read and write
   - Administration: Read and write (needed to create repos on demand)
4. Generate and copy the token. It starts with `github_pat_`.

### 2c. Sign Cline in (once, on the PC)

Run this in PowerShell and follow the prompts to connect your AI provider:

```powershell
cline auth
```

TAO uses whatever you configure here by default. You can switch provider or model later from Telegram with:
- `/model`
- `/provider`

## 3. Install and run the setup wizard

Open PowerShell on the PC and run:

```powershell
git clone https://github.com/makee14/makeedev-TAO.git
cd makeedev-TAO
npm install
npm run setup
```

The wizard asks a few questions and validates each one live, so nothing is accepted until it actually works:

- Telegram bot token — checked against Telegram's API on the spot. A typo is rejected immediately with a friendly message, and it confirms "connected as @yourbot".
- Your identity — it says "Now send ANY message to your bot in Telegram". Open Telegram, tap your bot, send "hi". TAO captures your numeric user ID automatically. You never type your ID.
- GitHub token — validated against the GitHub API. It confirms "authenticated as yourname".
- Workspace folders — type the full path of each project folder you want agents to work in, for example `C:\Projects\myapp`. Press Enter after each one, then press Enter on an empty line to finish. Paths are verified to exist.
- Default provider and model — optional. Just press Enter twice to use your `cline auth` defaults.

The wizard also auto-detects the `cline` CLI and tells you if it is missing.

Finally it validates the whole configuration and writes `config.json`. That file is gitignored, so your secrets never leave the PC. Now start the bot:

```powershell
npm start
```

You should see "TAO online" appear in your Telegram chat.

Re-running `npm run setup` later is safe, because it becomes an editor. It detects your existing config and enters edit mode: press Enter to keep each current value, or type a new one to replace it. Your workspaces and secrets are preserved.

## 4. Make it survive reboots (recommended)

Register TAO as a Windows scheduled task so it starts at logon, with a watchdog that restarts it if the process ever dies:

```powershell
powershell -ExecutionPolicy Bypass -File .\install-task.ps1
```

Test that it works:

```powershell
schtasks /Run /TN "TAO-Orchestrator"
```

"TAO online" should arrive in Telegram within about 60 seconds. After that, rebooting the PC needs no manual steps.

Recovery is automatic. After a reboot TAO sends a boot card, marks any tasks that were mid-run as interrupted (retry them with `/retry`), and resumes whatever was still queued.

## 5. Daily use

Send `/start` for a quick welcome, or tap Menu for the full command list inside Telegram:
- `/help`

### The commands

- `/newtask` — guided composer (recommended). Walks you through workspace and prompt with tap buttons. When your workspace has a GitHub remote you get a one-tap confirm to publish there; when none is detected the flow skips straight to task naming.
- `/do <prompt>` — quick task with all defaults.
- `/workspace` — view and switch the active workspace used by quick tasks
- `/status` — live snapshot of running tasks and the queue, plus the last lines of each agent's output
- `/list` — all tasks and their states
- `/cancel <id>` — kill a running task or drop a queued one
- `/retry <id>` — re-queue a failed task
- `/pause` — freeze the task queue
- `/resume` — unfreeze the task queue
- `/model` — switch the AI model. Takes effect on the next task you start.
- `/provider` — switch the AI provider. Takes effect on the next task you start.
- `/startOmniroute` — start the OmniRoute AI proxy and use it as the provider (`/openOmniroute` still works).
- `/settings` — all agent settings in one grouped panel: mode, auto-approve, thinking, provider, model, Gemini keys, skills, hook
- `/thinkingMode` — set plan vs act thinking effort
- `/agent` — agent mode/auto-approve/thinking quick panel
- `/skill` — manage the markdown skill files the agent can read
- `/hook` — read or edit the standing-rules hook prepended to every task prompt
- `/suggest` — insert suggestion templates into the composer draft
- `/file` — interactive card-based file browser; tap any file button to download directly to your phone
- `/files <id>` — inspect changed files for a task
- `/getfile <id> <path>` — download a workspace file directly to Telegram
- `/diff <id>` — see what a task changed
- `/publish <id>` — confirm git publish to GitHub for a finished task
- `/heartbeat` — live ping and health check: confirms TAO is running, PC uptime, queue state, and memory
- `/health` — PC health report: CPU, RAM, disk
- `/purge` — purge old run logs
- `/shutdown` — safe shutdown. Closes your open windows first, shows running tasks and asks you to confirm, drains them, then powers off in 60 seconds.
- `/shutdown now` — shut down immediately
- `/abortshutdown` — change your mind within the 60-second window
- `/panic` — emergency stop. Kills all running agents and pauses the queue.

### What a task looks like from your phone

1. You compose it and immediately get a Queued card, even if the workspace is busy.
2. When it starts you get a Running card, then periodic progress with tidy folder-grouped file-change milestones.
3. When it finishes you get a Done card with a summary, elapsed time, changed files, and a link to the GitHub commit. Failures get a Failed card with the reason.

If TAO itself hits an unexpected error, you get an error card in the same chat. You will never be left wondering why the bot went quiet.

### Useful things to know

- Every card has a `🏠 Menu` or `⬅️ Back` button — you're never stuck on a dead-end screen.
- Menu and status cards are edited in place: tapping `/status` twice updates the first card instead of sending a duplicate. Task cards delete + re-send when they finish so the result is the newest message.
- Files a task changed are shown grouped by folder, and are delivered on demand via the `📦 Send files` button on the Done card (no automatic file copies in the chat).
- Task ids count up automatically: `T-00001`, `T-00002`, …
- Reply to a done message with a follow-up instruction. It starts a new task in the same workspace with the context carried over, for example "tweak the button color you just added".
- When composing with `/newtask` you can set an after dependency. Task B will not start until task A is done.
- Up to 3 tasks run in parallel, but never two in the same workspace, so agents never fight over files.
- If several tasks fail in a row (for example the API is down), TAO auto-pauses the queue instead of burning attempts. Check `/health` first, then resume the queue when ready:
  - `/resume`

## 6. What happens when a task finishes

1. TAO mirrors the workspace, commits everything as `task-<id>: <name>`, and pushes it to the GitHub repo you picked in `/newtask`. If that repo does not exist yet, TAO creates it on demand.
2. One GitHub repo per workspace. Bind each repo to its workspace with `"ws": "<workspace-name>"` in `config.json`. TAO then only offers that repo for that workspace.
3. You get a done report with a summary, elapsed time, changed files, and a link to the commit on GitHub.
4. Check results on your phone with the file inspection commands:
   - `/files <id>`
   - `/diff <id>`
   - `/getfile <id> <path>`
   - Or browse the repo directly on github.com.

## 7. Troubleshooting

- Wizard says token rejected — re-copy the token from @BotFather, open /mybots, pick your bot, then API Token. If it was revoked, generate a new one.
- "User ID captured" never appears — make sure you sent a message directly to your bot in a private chat (not a group), then wait a few seconds.
- Bot silent after reboot — re-run `install-task.ps1`. Check Task Scheduler for the TAO-Orchestrator task, then try `schtasks /Run /TN "TAO-Orchestrator"`.
- GitHub push fails with 403 — your token is missing Contents: Read and write (or Administration for repo creation). Create a new token and run `npm run setup` to update it.
- Two workspaces publishing to the same repo — do not do this. The publish mirror is per-repo, so a second workspace would overwrite the first. Bind each repo to one workspace with `"ws"` in `config.json`. TAO filters the repo list per workspace automatically.
- Tasks fail instantly, circuit breaker opens — run `cline auth` on the PC, because the provider sign-in probably expired. Check that `cline --version` matches the pinned version in `config.json`.
- Windows Firewall popup on first start — allow Node.js on private networks. It is the Telegram bot polling.
- PC shut down mid-task — on next boot TAO auto-starts and the task shows as interrupted. Use `/retry <id>`.

## 8. Security notes

- Your bot token and GitHub token live only in `config.json` on the PC. That file is gitignored and never logged.
- Only your Telegram account can command the bot. Messages from anyone else are silently ignored.
- Agents run only in the workspace folders you allowlisted during setup.
- `/shutdown` only works if `safety.allowShutdownPc` is `true` in `config.json`. Set it with the setup wizard's edit mode or a text editor.

---

For how TAO works under the hood, see README.md. Windows-only by design; setup takes about 10 minutes once the prerequisites are installed.