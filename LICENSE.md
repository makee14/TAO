# MIT License — BETA

Copyright (c) 2026 makee14

> **⚠️ NOTICE: This is a BETA build of TAO (Telegram Agent Orchestrator).**
> It is a pre-release build distributed solely for evaluation and testing purposes.
> Additional terms in Section 4 below apply specifically to this beta distribution.

---

## 1. MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

---

## 2. Security is the user's responsibility

This project stores private secrets — Telegram bot tokens, GitHub Personal
Access Tokens (PATs) and workspace paths — in a `config.json` file on the
machine where it runs. You are solely responsible for:

- keeping `config.json` private and never committing it to any repository;
- protecting the machine, the tokens and any configured workspace from
  unauthorized access;
- reviewing the permissions granted to the bot and to the AI agents it
  spawns before granting them.

The software spawns local AI coding agents (e.g. Cline CLI) on **your own
PC**. Those agents can modify files, run commands, create repositories and,
if enabled, shut down the machine. You are fully responsible for the
workspaces you allowlist, the prompts you send, and every action those
agents perform.

---

## 3. No liability

The author(s) make no warranty — express or implied — and shall not be held
liable in contract, tort or otherwise for any damages or losses arising from
the use of the Software, including but not limited to:

- loss, corruption or leakage of data, code or workspace contents;
- unauthorized access to your machine, tokens or accounts;
- actions performed by AI agents or automated processes spawned by the
  Software;
- unexpected shutdowns, crashes or downtime;
- any direct, indirect, incidental, special, exemplary or consequential
  damages, even if advised of the possibility of such damages.

---

## 4. BETA — Additional Terms

The following terms apply **specifically** to this beta/tester distribution and
supersede any conflicting provisions in Sections 1–3 above.

### 4.1 Pre-release / evaluation only

This software is a **pre-release, non-production build**. It is distributed
solely for the purpose of evaluation, testing, and feedback. It is **not**
feature-complete and may contain bugs, security vulnerabilities, incomplete
functionality, and breaking changes between versions.

### 4.2 No warranty — beta quality

**THE SOFTWARE IS PROVIDED "AS IS" WITH ALL FAULTS.** The author(s) make no
warranty — express, implied, or statutory — regarding the software's quality,
reliability, performance, accuracy, or fitness for any particular purpose.
The beta build may crash, lose data, corrupt files, or behave unpredictably.

### 4.3 No support, no SLA

There is **no obligation** to provide support, updates, patches, documentation,
or maintenance for this beta distribution. There is **no service level agreement
(SLA)** of any kind. Response to issues or feedback is entirely at the
author's discretion.

### 4.4 Not for production use

This beta build **must not** be used in production environments, on critical
machines, or on any system where failure could cause harm, data loss, or
financial damage. It is intended only for isolated test environments and
throwaway workspaces.

### 4.5 Use at your own risk

You assume **full and sole responsibility** for evaluating this beta software,
backing up your data, and operating it in an environment you control. If you
do not accept these terms, do not use this software.

### 4.6 Distribution

This beta copy may be freely shared with other testers, provided the LICENSE.md
file is included and these beta-specific terms are preserved.