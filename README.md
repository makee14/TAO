<h1 align="center">🧠 TAO — Telegram Agent Orchestrator</h1>

<p align="center">
  <img src="https://img.shields.io/badge/status-BETA-red?style=for-the-badge" alt="Beta" />
  <img src="https://img.shields.io/badge/version-0.1.0-blue?style=for-the-badge" alt="Version" />
  <img src="https://img.shields.io/badge/platform-Windows_10%2F11-0078d4?style=for-the-badge&logo=windows" alt="Windows" />
  <img src="https://img.shields.io/badge/license-MIT-green?style=for-the-badge" alt="MIT License" />
</p>

<p align="center">
  <b>Control AI coding agents from Telegram.</b><br/>
  Queue tasks, track progress, publish to GitHub — all from your phone.<br/>
  Runs Cline CLI agents on your local Windows machine.
</p>

---

> ### ⚠️ BETA
>
> **This is a pre-release test build** distributed for evaluation and feedback only.
> It is **not** the final product. Features may be incomplete, unstable, or subject
> to breaking changes. There is no warranty, no SLA, and no guarantee of support.
>
> **Do not use this in production or on critical machines.**
> Use a dedicated test environment or a throwaway workspace.
>
> If you find bugs or have feedback, please open an issue on this repository.

---

## What is TAO?

TAO (**T**elegram **A**gent **O**rchestrator) is a Windows-only Telegram bot that
spawns and manages [Cline CLI](https://github.com/cline/cline) AI coding agents
on your PC. Think of it as a **mission control dashboard in your pocket**:

- **Queue tasks** — send instructions from Telegram and TAO queues them and runs them
  in order (or in parallel up to your configured limit).
- **Real-time status** — interactive cards update in place as agents work.
- **GitHub integration** — completed tasks can be published (committed + pushed) to
  your repos with one tap.
- **Visual analysis** — send a screenshot or photo with a task and TAO will analyze
  it before passing it to the agent.
- **Safety controls** — circuit breaker, panic button, graceful shutdown, owner-only
  access.

---

## 🚀 Quick Start - Read GUIDE.md for more detailed instructions.

### 1. Clone & install

```powershell
git clone https://github.com/makee14/TAO.git
cd TAO
npm install
```

### 2. Run the setup wizard

```powershell
npm run setup
```

The wizard walks you through: Telegram token, user ID, Cline model, workspace
folder, and GitHub PAT. This creates `config.json` (git-ignored).

### 3. Start the bot

```powershell
npm start
```

Open Telegram and send **`/start`** to your bot.

---

## ⚡ Features

| Feature | Description |
|---|---|
| **Task Queue** | Parallel scheduler with configurable concurrency and workspace isolation |
| **Interactive Cards** | Telegram inline-keyboard cards for status, tasks, and controls |
| **Follow-ups** | Reply to a finished task to continue the conversation with context |
| **Quick Tasks** | `/do <prompt>` — skip the wizard, run immediately with defaults |
| **Task Wizard** | Guided compose flow: name → prompt → workspace → repo → confirm |
| **Photo / Screenshot** | Attach images to tasks; TAO saves them and generates visual analysis |
| **Publish to GitHub** | One-tap publish gate: commit + push + optional repo creation |
| **Model / Provider** | Switch AI model and provider on the fly (`/model`, `/provider`) |
| **Circuit Breaker** | Auto-pauses queue after N consecutive failures; self-heals after cooldown |
| **Panic Button** | `/panic` — kills all running agents and pauses the queue instantly |
| **Graceful Shutdown** | `/shutdown` drains running tasks before powering off the PC |
| **Heartbeat** | Optional periodic health + queue stats summary to Telegram |
| **Health Check** | `/health` — disk, uptime, queue stats at a glance |
| **Owner Lock** | Only your Telegram user ID can control the bot — everyone else is ignored |

---

## 📋 Requirements

| Requirement | Details |
|---|---|
| **OS** | Windows 10 or 11 (required — TAO uses Windows-specific APIs) |
| **Node.js** | v20.11.0 or newer |
| **Git** | For workspace versioning and GitHub publishing |
| **Cline CLI** | Install (`npm i -g cline`) |
| **Telegram Bot Token** | Create one via [@BotFather](https://t.me/BotFather) |
| **GitHub PAT** | A Personal Access Token with `repo` scope (for publishing) |
| **Telegram User ID** | Automatically determined by the wizard |

---

## 🤖 Bot Commands

### Core

| Command | Description |
|---|---|
| `/start` | Welcome card with main menu |
| `/help` | Full command reference |
| `/status` | Live queue overview with refresh, pause, resume buttons |
| `/do <prompt>` | Quick-task — runs immediately with workspace/repo defaults |
| `/newtask` | Guided task wizard (step-by-step compose flow) |

### Task Management

| Command | Description |
|---|---|
| `/list` | Show all tasks (any state) |
| `/cancel <id>` | Cancel a queued or running task |
| `/retry <id>` | Re-queue a failed task |
| `/pause` | Pause the queue (running tasks continue) |
| `/resume` | Resume a paused queue |

### Publishing

| Command | Description |
|---|---|
| `/publish <id>` | Publish a completed task's workspace to GitHub |
| `/skip <id>` | Skip publishing (keeps workspace local) |

### Engine & System

| Command | Description |
|---|---|
| `/model [name]` | View or change the AI model |
| `/provider [name]` | View or change the AI provider |
| `/workspace [name]` | Switch the active workspace |
| `/heartbeat` | View system health + queue stats |
| `/health` | Disk, uptime, queue status |
| `/panic` | Kill all running agents and pause the queue |
| `/shutdown` | Drain tasks then shut down the PC |
| `/abortshutdown` | Cancel a pending shutdown |

### Interacting with Tasks

- **Reply to a finished task** → Creates a follow-up with the same workspace and context.
- **Send a photo** → Attach it to a task or start the compose flow with a screenshot.
- **Inline buttons** — every card has contextual buttons (Status, Cancel, Retry, Publish).

---

## ⚙️ Configuration

TAO uses a single `config.json` (created by the setup wizard). Key sections:

```jsonc
{
  "telegram": { "botToken": "...", "userId": 123456789 },
  "cline":    { "bin": "cline", "provider": "gemini", "model": "gemini-3.5-flash" },
  "workspaces": [
    { "name": "myproject", "path": "C:\\Projects\\myproject", "default": true }
  ],
  "github":   { "pat": "github_pat_...", "allowCreate": true, "repos": [...] },
  "orchestration": { "maxParallel": 3, "circuitBreaker": { "enabled": true } },
  "safety":   { "allowShutdownPc": true, "shutdownGraceSec": 60 }
}
```

See [`config.example.json`](config.example.json) for the full reference.

> **Security:** `config.json` contains your bot token and GitHub PAT.
> It is git-ignored — **never commit it to a repository.**

---

## 🛡️ Safety & Security

TAO spawns **local AI agents that can modify files and run commands on your PC.**

- **Owner lock** — only your Telegram user ID can control the bot.
- **Workspace isolation** — two tasks never share the same workspace.
- **Circuit breaker** — auto-pauses after N consecutive failures.
- **Panic** — `/panic` kills all agents and pauses the queue instantly.
- **Graceful shutdown** — `/shutdown` waits for agents to finish before powering off.
- **Config secrets** — tokens stored locally in `config.json` (git-ignored).
- **Output redaction** — `secret-patterns.js` scrubs secrets from agent output.

> **You are responsible for:** the workspaces you allowlist, the prompts you send,
> and every action the AI agents perform. Review agent output regularly.

---

## 📄 License

MIT License — see [LICENSE.md](LICENSE.md).

**Additional terms apply to this BETA build** including no warranty,
no liability, and use-at-your-own-risk provisions.

---

## ⚠️ Disclaimer

This is a **BETA tester build**. It is provided **as-is** for evaluation purposes.
The author makes no guarantees regarding stability, security, or fitness for any
purpose. Use at your own risk, on a machine you control, with data you can afford
to lose.
