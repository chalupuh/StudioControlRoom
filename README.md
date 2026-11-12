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

## Phone and LAN access
By default the server listens on loopback only. To use the Control Room from a phone on the same network:
1. Bind to the LAN: start with `STUDIO_BIND=0.0.0.0` (or set `controlRoom.bind` in `.studio/machine.json`). LAN mode requires the token; loopback never does.
2. Allow the port in Windows Firewall (elevated PowerShell): `powershell -ExecutionPolicy Bypass -File studio\firewall.ps1` (the default execution policy blocks unsigned scripts) adds the inbound rule "Studio Control Room (LAN)" for the port (default 4777, or `-Port N`), limited to `-RemoteAddress LocalSubnet` and the Private network profile. Preview with `-WhatIf`; delete it with `-Remove`.
3. Run `node studio/studio.js pair [port]`. It prints a pairing link for each private IPv4 address of this host (`http://<ip>:<port>/pair?t=<token>`) and draws a QR code of the first one. Scan it, or open a link on the phone: the token is exchanged for an HttpOnly cookie and you land on the Control Room. **Open by IP address, not hostname** — DNS-rebinding defence rejects hostnames like `*.local` or `goldg-5090`.
4. From an already-authorised browser (e.g. the desktop page), `GET /api/pair-qr` returns the same QR as an SVG, for a "Pair phone" button.

The rule only applies on the **Private** network profile, so set your home network to Private. The first time the server listens on `0.0.0.0`, Windows shows an "allow node.exe" prompt: decline it (or allow Private only), because that rule is not limited to LocalSubnet.

The pairing cookie lasts one year. In LAN mode every route except `/pair` and the static app shell requires the token. The pairing link contains the token, so treat the QR like a password. `node studio/studio.js token rotate` invalidates old links and cookies; already-open `/api/stream` connections stay authorised until they reconnect. 192.168.x addresses are listed first; virtual adapters (WSL, Hyper-V, Docker, VPN) are included but sorted last — a Hyper-V External switch may hold the host's real LAN address. The terminal QR is drawn for dark terminals; on a light terminal use a link or invert colours. The QR encoder is vendored in `studio/qr.js` (MIT, no npm dependency).

## Engine
```
node engine/engine.js pipelines
node engine/engine.js start <pipeline> [--var key=value] [--var workdir=<checkout>]
node engine/engine.js status | approve <run> approve|reject "<note>" | resume <run>
```
Pipelines live in HQ (`tools/engine/pipelines/*.json`). `{{soft}}` in a pipeline expands to this repo's root.

## Development
Branch, open a PR, CI must pass, then squash merge (see HQ ADR 0002). Tests: `npm --prefix studio/app test` and `node engine/test.js`.
