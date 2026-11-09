# StudioControlRoom

The software that runs the **AI Development Company** studio: an org of AI agents (R&D, Engineering, Creative) that build apps through fixed pipelines, using local models first and Claude for review at the gates.

The org itself (agents, docs, pipeline definitions, runtime data) lives in a separate workspace repo, **AIDevCompanyHQ**. This repo is the code that drives it.

| Folder | What |
|---|---|
| `studio/studio.js` | Control Room server (API + SSE on :4777), Claude Code hook handler, CLI (log, pause/resume, checkpoints) |
| `studio/app/` | Control Room UI: Vite + React + TS (Team, Village, Operations tabs) |
| `studio/dashboard.html` | Legacy v1 dashboard (served at `/v1`) |
| `engine/` | Workflow engine: runs pipelines as a state machine (local → Sonnet → Opus ladder, owner gates, GPU-aware) |
| `bench/` | Role benchmark for local models (auto-checked evals) |
| `creative/` | ComfyUI helper (`comfy.js`), portrait batch tool, installer |

## Setup
1. Clone **AIDevCompanyHQ** and this repo side by side.
2. `cp studio.home.example.json studio.home.json` and set `home` to your HQ checkout (or set the `STUDIO_HOME` env var).
3. `cd studio/app && npm ci && npm run build`
4. `node studio/studio.js serve`, then open http://localhost:4777
5. In HQ's `.claude/settings.json`, point the hooks at `node "<this repo>/studio/studio.js" hook`.

## Engine
```
node engine/engine.js pipelines
node engine/engine.js start <pipeline> [--var key=value] [--var workdir=<checkout>]
node engine/engine.js status | approve <run> approve|reject "<note>" | resume <run>
```
Pipelines live in HQ (`tools/engine/pipelines/*.json`). `{{soft}}` in a pipeline expands to this repo's root.

## Always-on host

### Per-machine profile
Copy one profile object from `studio/machine.example.json` to `.studio/machine.json` and tune values for your hardware (Ollama settings, GPU slots, Control Room port).
The profile is merged over sensible defaults.

### Supervisor
```
node studio/studio.js supervise          # long-running: keep services up, resume runs, daily backup at 03:00
```
Log: `.studio/logs/supervisor.log` (rotated at 5 MB, 5 files kept).

### Boot install (Windows)
Registers a Scheduled Task **StudioSupervisor** (at startup, runs whether user is logged on or not, restarts on failure every 1 min up to 999 times).
The task runs under your own account (S4U, no password stored) and sets `STUDIO_HOME` to your HQ checkout.

```powershell
powershell -ExecutionPolicy Bypass -File studio\install-service.ps1       # install
powershell -ExecutionPolicy Bypass -File studio\install-service.ps1 -Uninstall  # remove
powershell -ExecutionPolicy Bypass -File studio\install-service.ps1 -WhatIf     # dry-run
```
To check the task is healthy:
```powershell
Get-ScheduledTask StudioSupervisor | Get-ScheduledTaskInfo
```

### Backup
```
node studio/studio.js backup             # on-demand backup now
```
The supervisor also runs a backup once per day at 03:00 local time.
Backups zip `.studio/runs/`, `.studio/checkpoints/`, `roster.json`, `events.jsonl`, and `docs/internal/`
into `.studio/backups/<YYYY-MM-DD>.zip`, keeping the 14 most recent.

## Development
Branch, open a PR, CI must pass, then squash merge (see HQ ADR 0002). Tests: `npm --prefix studio/app test` and `node engine/test.js`.
