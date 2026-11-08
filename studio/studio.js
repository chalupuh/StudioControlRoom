#!/usr/bin/env node
// Studio monitor: one script, three jobs.
//   node .studio/studio.js hook                 <- called by Claude Code hooks (reads JSON on stdin)
//   node .studio/studio.js log <agent> <pct> "<message>" [working|blocked|done]
//   node .studio/studio.js serve [port]         <- live dashboard at http://localhost:4777
//   node .studio/studio.js reset                <- clear the event log
//   node .studio/studio.js pause | resume | status        <- safe stop / start switch
//   node .studio/studio.js checkpoint <agent> "<where>" "<next>" ["<files>"]
//   node .studio/studio.js checkpoint-clear <agent>       <- archive after resuming
const fs = require('fs');
const path = require('path');
const http = require('http');

// SOFT = where this software lives (dashboard.html, app-dist). HOME = the org workspace (agents, docs,
// runtime data in HOME/.studio). They are the same folder today; after the StudioControlRoom split they differ.
// HOME: STUDIO_HOME env → studio.home.json next to the software → legacy (parent of this file's folder).
const SOFT = __dirname;
function studioHome() {
  if (process.env.STUDIO_HOME) return path.resolve(process.env.STUDIO_HOME);
  try { const c = JSON.parse(fs.readFileSync(path.join(SOFT, '..', 'studio.home.json'), 'utf8')); if (c.home) return path.resolve(c.home); } catch {}
  return path.resolve(SOFT, '..');
}
const HOME = studioHome();
const DIR = path.join(HOME, '.studio');
const LOG = path.join(DIR, 'events.jsonl');

function append(ev) {
  ev.ts = ev.ts || Date.now();
  fs.appendFileSync(LOG, JSON.stringify(ev) + '\n');
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
    setTimeout(() => resolve(data), 2000); // never hang a hook
  });
}

const short = (s, n = 140) => {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
};

// ---------- Start / safe-stop control ----------
const CONTROL = path.join(DIR, 'control.json');
const CKPT = path.join(DIR, 'checkpoints');
function getControl() {
  try { return JSON.parse(fs.readFileSync(CONTROL, 'utf8')); } catch { return { state: 'running', since: Date.now() }; }
}
const TEAMS = ['eng', 'rd', 'creative'];
const TEAM_FALLBACK = { 'rd-manager': 'rd', 'market-researcher': 'rd', 'opportunity-analyst': 'rd', 'creative-director': 'creative', 'image-artist': 'creative', 'video-producer': 'creative', 'copy-voice': 'creative', 'ui-ux-designer': 'creative' };
const ROSTER = path.join(DIR, 'roster.json');
function readRoster() { try { const r = JSON.parse(fs.readFileSync(ROSTER, 'utf8')); return r && r.agents ? r : { agents: {} }; } catch { return { agents: {} }; } }
function teamOf(agent) {
  const t = (readRoster().agents[agent] || {}).team;
  return TEAMS.includes(t) ? t : (TEAM_FALLBACK[agent] || 'eng');
}
function setControl(state, by = 'cli', team) {
  const prev = getControl();
  const c = { ...prev, since: Date.now(), by };
  if (team) c.teams = { ...(prev.teams || {}), [team]: state };
  else c.state = state;
  fs.writeFileSync(CONTROL, JSON.stringify(c, null, 2));
  append({ type: state === 'paused' ? 'paused' : 'resumed', agent: 'manager', message: `${team ? 'Team ' + team : 'Studio'} ${state} (${by})` });
  return c;
}
function listCheckpoints() {
  if (!fs.existsSync(CKPT)) return [];
  return fs.readdirSync(CKPT).filter((f) => f.endsWith('.md')).map((f) => {
    const p = path.join(CKPT, f);
    return { agent: f.replace(/\.md$/, ''), ts: fs.statSync(p).mtimeMs, text: fs.readFileSync(p, 'utf8') };
  });
}
function checkpoint([agent, where, next, files]) {
  if (!agent || !where) { console.error('usage: checkpoint <agent> "<where I stopped>" "<next step>" ["<files touched>"]'); process.exit(1); }
  fs.mkdirSync(CKPT, { recursive: true });
  const md = `# Checkpoint: ${agent}\n\n- **Saved:** ${new Date().toISOString()}\n- **Where I stopped:** ${where}\n- **Next step:** ${next || '(not given)'}\n- **Files touched:** ${files || '(not given)'}\n`;
  fs.writeFileSync(path.join(CKPT, agent + '.md'), md);
  append({ type: 'checkpoint', agent, message: short(where, 200), next: short(next, 200) });
  console.log(`Checkpoint saved for ${agent}.`);
}
function clearCheckpoint([agent]) {
  const p = path.join(CKPT, agent + '.md');
  if (!fs.existsSync(p)) return console.log('No checkpoint for ' + agent);
  const done = path.join(CKPT, 'done'); fs.mkdirSync(done, { recursive: true });
  fs.renameSync(p, path.join(done, `${agent}-${Date.now()}.md`));
  append({ type: 'resumed-agent', agent, message: 'Picked up from checkpoint' });
  console.log('Checkpoint archived for ' + agent);
}
// Which model each worker uses: the "brain" comes from the agent file's `model:` line,
// and the local tool models come from .studio/models.json (edit that file when models change).
const AGENTS_DIR = path.join(DIR, '..', '.claude', 'agents');
const BRAIN = { opus: 'Claude Opus', sonnet: 'Claude Sonnet', haiku: 'Claude Haiku', fable: 'Claude Fable', inherit: 'Session model' };
function modelMap() {
  let reg = {};
  try { reg = JSON.parse(fs.readFileSync(path.join(DIR, 'models.json'), 'utf8')); } catch {}
  const out = {};
  if (fs.existsSync(AGENTS_DIR)) for (const f of fs.readdirSync(AGENTS_DIR).filter((f) => f.endsWith('.md'))) {
    const m = (fs.readFileSync(path.join(AGENTS_DIR, f), 'utf8').match(/^model:\s*(\S+)/m) || [])[1] || 'inherit';
    out[f.replace(/\.md$/, '')] = { brain: BRAIN[m] || m };
  }
  for (const [id, v] of Object.entries(reg.agents || {})) {
    const local = (v.local || []).map((l) => ({ ...l, installed: isInstalled(l, reg) }));
    out[id] = { ...(out[id] || {}), ...v, local };
  }
  return out;
}
// Local models are checked on disk each time, so the dashboard shows what's really installed.
function isInstalled(l, reg) {
  try {
    if (l.kind === 'ollama') {
      const [name, tag = 'latest'] = l.ref.split(':');
      const base = process.env.OLLAMA_MODELS || path.join(require('os').homedir(), '.ollama', 'models');
      return fs.existsSync(path.join(base, 'manifests', 'registry.ollama.ai', 'library', name, tag));
    }
    if (l.kind === 'file') return fs.existsSync(path.isAbsolute(l.ref) ? l.ref : path.join(reg.comfyRoot || '', l.ref));
    if (l.kind === 'python') return fs.existsSync(path.join(DIR, '..', l.ref));
  } catch {}
  return false;
}

// While paused, only allow what an agent needs to save its place.
function pausedGate(tool, ti) {
  if (['Read', 'Glob', 'Grep'].includes(tool)) return true;
  // Looking is fine while paused (dashboard screenshots, page reads); acting is not.
  if (/^mcp__Claude_Browser__(read_page|get_page_text|find|tabs_context|read_console_messages|preview_list|preview_logs)$/.test(tool)) return true;
  if (tool === 'mcp__Claude_Browser__computer' && ['screenshot', 'zoom'].includes(ti.action)) return true;
  if (tool === 'Bash' || tool === 'PowerShell') return /studio\.js/.test(ti.command || '');
  return false;
}
const PAUSE_MSG = (who) =>
  `STUDIO PAUSED by the owner (safe stop). Do not continue your task. Save your place now by running:\n` +
  `node .studio/studio.js checkpoint ${who || '<your-agent-name>'} "<exactly where you stopped>" "<the very next step>" "<files you changed>"\n` +
  `Then end your turn with a one-line summary. Work resumes when the owner flips the switch back to Running.`;

async function hook() {
  let input = {};
  try { input = JSON.parse(await readStdin() || '{}'); } catch { return; }
  const evName = input.hook_event_name;
  const tool = input.tool_name;
  const ti = input.tool_input || {};
  const isDelegation = tool === 'Task' || tool === 'Agent';

  const ctl = evName === 'PreToolUse' ? getControl() : null;
  const callerTeam = input.agent_type ? teamOf(input.agent_type) : null;
  const isPaused = ctl && (ctl.state === 'paused' || (callerTeam && ctl.teams && ctl.teams[callerTeam] === 'paused'));
  if (evName === 'PreToolUse' && isPaused && !pausedGate(tool, ti)) {
    const who = input.agent_type || (isDelegation ? 'manager' : 'manager');
    process.stderr.write(PAUSE_MSG(who));
    process.exit(2); // exit 2 = block this tool call and show the message to Claude
  }

  if (isDelegation && ti.subagent_type) {
    if (evName === 'PreToolUse') {
      append({ type: 'start', agent: ti.subagent_type, from: 'manager', task: short(ti.description || ti.prompt) });
    } else if (evName === 'PostToolUse') {
      append({ type: 'done', agent: ti.subagent_type, to: 'manager', task: short(ti.description) });
    }
    return;
  }
  // Tool calls made *inside* a subagent (newer Claude Code versions include agent_type).
  const who = input.agent_type || input.subagent_type;
  if (evName === 'PreToolUse' && who && tool) {
    const detail = ti.file_path || ti.command || ti.pattern || ti.url || '';
    append({ type: 'tool', agent: who, tool, detail: short(detail, 90) });
  }
  if (evName === 'SubagentStop' && who) {
    append({ type: 'done', agent: who, to: 'manager' });
  }
}

function log(args) {
  const [agent, pct, message, status] = args;
  if (!agent) { console.error('usage: log <agent> <pct> "<message>" [working|blocked|done]'); process.exit(1); }
  append({ type: 'progress', agent, pct: Math.max(0, Math.min(100, Number(pct) || 0)), message: short(message, 200), status: status || 'working' });
}

// ---------- Control Room v2 API ----------
// Engine: STUDIO_ENGINE env → split layout (<software>/engine/engine.js) → legacy (HOME/tools/engine/engine.js)
const ENGINE = process.env.STUDIO_ENGINE || [path.join(SOFT, '..', 'engine', 'engine.js'), path.join(HOME, 'tools', 'engine', 'engine.js')].find((p) => fs.existsSync(p));
const REPO = HOME;
const RUNS = path.join(DIR, 'runs');
const DIST = path.join(SOFT, 'app-dist');
const PORTRAITS = path.join(DIR, 'portraits');
const readJson = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };

function parseEvents(text) {
  return text.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
function readEvents() { return fs.existsSync(LOG) ? parseEvents(fs.readFileSync(LOG, 'utf8')) : []; }

function runSummary(run) {
  const cur = run.cursor || 0;
  const stages = (run.stages || []).map((s, i) => ({
    id: s.id, type: s.type, agent: s.agent, tier: s.tier,
    state: run.status === 'done' || i < cur ? 'done' : i === cur ? 'current' : 'pending',
  }));
  let gate;
  for (const [id, g] of Object.entries(run.gates || {})) {
    if (g && g.status === 'waiting') {
      gate = { id, title: g.title || id, show: g.show || [], since: g.since };
      if (Array.isArray(g.itemList) && g.itemList.length) gate.items = g.itemList.map((i) => ({ id: i.id, text: i.text, ...(g.itemDecisions && g.itemDecisions[i.id] ? { decision: g.itemDecisions[i.id] } : {}) }));
    }
  }
  const out = {
    id: run.id, pipeline: run.pipeline, status: run.status, vars: run.vars || {},
    created: run.created || run.updated, updated: run.updated, stages,
    attempts: (run.history || []).filter((h) => h.type !== 'script').map((h) => ({
      stage: h.stage, agent: h.agent, tier: h.tier, ok: !!h.ok, secs: h.secs, problems: h.problems, at: h.at,
    })),
  };
  if (gate && run.status === 'waiting-gate') out.gate = gate;
  if (run.blockedReason) out.blockedReason = run.blockedReason;
  return out;
}
function listRuns() {
  if (!fs.existsSync(RUNS)) return [];
  const out = [];
  for (const f of fs.readdirSync(RUNS).filter((f) => f.endsWith('.json'))) {
    const r = readJson(path.join(RUNS, f), null);
    if (r && r.id) out.push(runSummary(r));
  }
  return out.sort((a, b) => String(b.created).localeCompare(String(a.created)) || String(b.updated).localeCompare(String(a.updated)));
}
function getState() {
  return { events: readEvents().slice(-500), control: getControl(), checkpoints: listCheckpoints(), models: modelMap(), roster: readRoster(), runs: listRuns() };
}

const dayKey = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
function getUsage() {
  const budget = { dailyCloudTokens: 200000, ...readJson(path.join(DIR, 'budget.json'), {}) };
  const today = { cloudTokens: 0, localTokens: 0, cloudCalls: 0, localCalls: 0 };
  const byAgent = {}, byProject = {}, fb = {};
  const days = {};
  const todayKey = dayKey(Date.now());
  for (let i = 13; i >= 0; i--) { const k = dayKey(Date.now() - i * 86400000); days[k] = { day: k, cloudTokens: 0, localTokens: 0 }; }
  for (const e of readEvents()) {
    if (e.type !== 'usage') continue;
    const tok = (Number(e.tokensIn) || 0) + (Number(e.tokensOut) || 0);
    const k = dayKey(e.ts), cloud = !!e.cloud;
    const a = (byAgent[e.agent] = byAgent[e.agent] || { cloudTokens: 0, localTokens: 0, calls: 0, secs: 0 });
    a[cloud ? 'cloudTokens' : 'localTokens'] += tok; a.calls++; a.secs += Number(e.secs) || 0;
    const pk = e.project || e.pipeline || 'unknown';
    const pr = (byProject[pk] = byProject[pk] || { cloudTokens: 0, localTokens: 0, calls: 0, secs: 0 });
    pr[cloud ? 'cloudTokens' : 'localTokens'] += tok; pr.calls++; pr.secs += Number(e.secs) || 0;
    // fallback: successful attempt of a local-tier stage that ran on a cloud tier (30 days, one per run+stage)
    if (e.ok === true && /^local/.test(e.stageTier || '') && Date.now() - e.ts <= 30 * 86400000) fb[`${e.runId}|${e.stage}|${e.agent}`] = { agent: e.agent, cloud };
    if (days[k]) days[k][cloud ? 'cloudTokens' : 'localTokens'] += tok;
    if (k === todayKey) { today[cloud ? 'cloudTokens' : 'localTokens'] += tok; today[cloud ? 'cloudCalls' : 'localCalls']++; }
  }
  for (const a of Object.values(byAgent)) Object.assign(a, { localStages: 0, fallbackStages: 0, fallbackRate: 0, fallbackAlert: false });
  for (const f of Object.values(fb)) { const a = byAgent[f.agent]; if (!a) continue; a.localStages++; if (f.cloud) a.fallbackStages++; }
  for (const a of Object.values(byAgent)) { a.fallbackRate = a.localStages ? a.fallbackStages / a.localStages : 0; a.fallbackAlert = a.fallbackRate > 0.25; } // ADR 0001
  return { budget, today, byAgent, byProject, byDay: Object.values(days) };
}

// ---- GPU / Ollama / ComfyUI (cached 2 s, never throws) ----
let gpuCache = { at: 0, val: null, pending: null };
const fetchJson = async (url) => { const r = await fetch(url, { signal: AbortSignal.timeout(1500) }); if (!r.ok) throw new Error(String(r.status)); return r.json(); };
function nvidia() {
  return new Promise((resolve) => {
    require('child_process').execFile('nvidia-smi', ['--query-gpu=name,memory.used,memory.total,utilization.gpu,temperature.gpu', '--format=csv,noheader,nounits'],
      { timeout: 3000, windowsHide: true }, (err, stdout) => {
        if (err) return resolve([]);
        resolve(String(stdout).split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
          const p = l.split(',').map((x) => x.trim());
          return { name: p[0], memUsedMB: Number(p[1]) || 0, memTotalMB: Number(p[2]) || 0, utilPct: Number(p[3]) || 0, tempC: Number(p[4]) || 0 };
        }));
      });
  });
}
async function computeGpu() {
  const [gpus, ollama, comfy] = await Promise.all([
    nvidia().catch(() => []),
    fetchJson('http://127.0.0.1:11434/api/ps').then((j) => (j.models || []).map((m) => ({ name: m.name || m.model, vramMB: Math.round((m.size_vram || 0) / 1048576), until: m.expires_at }))).catch(() => []),
    fetchJson('http://127.0.0.1:8188/queue').then((j) => ({ up: true, queueRunning: (j.queue_running || []).length, queuePending: (j.queue_pending || []).length })).catch(() => ({ up: false, queueRunning: 0, queuePending: 0 })),
  ]);
  return { gpus, ollama, comfy };
}
async function getGpu() {
  if (gpuCache.val && Date.now() - gpuCache.at < 2000) return gpuCache.val;
  if (!gpuCache.pending) gpuCache.pending = computeGpu().catch(() => ({ gpus: [], ollama: [], comfy: { up: false, queueRunning: 0, queuePending: 0 } }))
    .then((v) => { gpuCache = { at: Date.now(), val: v, pending: null }; return v; });
  return gpuCache.pending;
}

// ---- SSE: tail events.jsonl, watch state files ----
const clients = new Set();
const broadcast = (obj) => { const d = `data: ${JSON.stringify(obj)}\n\n`; for (const c of clients) { try { c.write(d); } catch {} } };
function startWatchers() {
  let offset = fs.existsSync(LOG) ? fs.statSync(LOG).size : 0, buf = '', busy = false;
  const pump = () => {
    if (busy) return; busy = true;
    try {
      const size = fs.existsSync(LOG) ? fs.statSync(LOG).size : 0;
      if (size < offset) { offset = size; buf = ''; }          // truncated (reset)
      if (size > offset) {
        const fd = fs.openSync(LOG, 'r'); const b = Buffer.alloc(size - offset);
        fs.readSync(fd, b, 0, b.length, offset); fs.closeSync(fd); offset = size;
        buf += b.toString('utf8');
        const lines = buf.split('\n'); buf = lines.pop();
        for (const e of parseEvents(lines.join('\n'))) broadcast({ kind: 'event', event: e });
      }
    } catch {} finally { busy = false; }
  };
  try { fs.watch(LOG, pump); } catch {}
  setInterval(pump, 1000).unref?.();                              // fallback + Windows double-fire safe (offset-based)
  let t = null;
  const refresh = () => { clearTimeout(t); t = setTimeout(() => broadcast({ kind: 'refresh' }), 300); };
  fs.mkdirSync(CKPT, { recursive: true }); fs.mkdirSync(RUNS, { recursive: true });
  try { fs.watch(DIR, (_, f) => { if (f === 'control.json' || f === 'roster.json') refresh(); }); } catch {}
  for (const d of [CKPT, RUNS]) { try { fs.watch(d, { recursive: true }, (_, f) => { if (!/\.log$/.test(String(f || ''))) refresh(); }); } catch {} }
  setInterval(() => { for (const c of clients) { try { c.write(': hb\n\n'); } catch {} } }, 15000).unref?.();
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.json': 'application/json', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.map': 'application/json' };
function sendFile(res, file, extraHeaders = {}) {
  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', ...extraHeaders });
  fs.createReadStream(file).on('error', () => res.end()).pipe(res);
}
// Resolve a URL path inside a root; null if it escapes the root.
function safeJoin(root, rel) {
  let dec; try { dec = decodeURIComponent(rel); } catch { return null; }
  if (dec.includes('\0')) return null;
  const full = path.resolve(root, '.' + path.sep + dec.replace(/^[\\/]+/, ''));
  if (full !== root && !full.startsWith(root + path.sep)) return null;
  return full;
}
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve) => {
    let body = '', over = false;
    req.on('data', (c) => { body += c; if (body.length > limit) { over = true; req.destroy(); } });
    req.on('end', () => { if (over) return resolve({}); try { resolve(JSON.parse(body || '{}') || {}); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

function spawnEngine(args, runId) {
  fs.mkdirSync(RUNS, { recursive: true });
  const out = fs.openSync(path.join(RUNS, runId + '.log'), 'a');
  const child = require('child_process').spawn(process.execPath, [ENGINE, ...args],
    { cwd: REPO, detached: true, windowsHide: true, stdio: ['ignore', out, out] });
  child.on('error', () => {});
  child.unref();
  fs.closeSync(out);
}

function serve(port = 4777) {
  const html = path.join(SOFT, 'dashboard.html');
  const json = (res, obj, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
  const text = (res, s, code = 200) => { res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(s); };
  startWatchers();

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname, m = req.method;

    // ---- legacy endpoints (used by dashboard.html) ----
    if (p === '/control') {
      if (m === 'POST') {
        const b = await readBody(req);
        if (b.action === 'pause') return json(res, setControl('paused', 'dashboard'));
        if (b.action === 'resume') return json(res, setControl('running', 'dashboard'));
        return json(res, { error: 'action must be pause or resume' }, 400);
      }
      return json(res, getControl());
    }
    if (p === '/checkpoints') return json(res, listCheckpoints());
    if (p === '/models') return json(res, modelMap());
    if (p === '/events') return json(res, readEvents());
    if (p === '/v1') return sendFile(res, html, { 'Cache-Control': 'no-store' });

    // ---- v2 API ----
    if (p === '/api/state' && m === 'GET') return json(res, getState());
    if (p === '/api/usage' && m === 'GET') return json(res, getUsage());
    if (p === '/api/gpu' && m === 'GET') return json(res, await getGpu());
    if (p === '/api/stream' && m === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write(': connected\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (p === '/api/control' && m === 'POST') {
      const b = await readBody(req);
      if (b.action !== 'pause' && b.action !== 'resume') return json(res, { error: 'action must be pause or resume' }, 400);
      if (b.team != null && !TEAMS.includes(b.team)) return json(res, { error: 'team must be eng, rd or creative' }, 400);
      return json(res, setControl(b.action === 'pause' ? 'paused' : 'running', 'dashboard', b.team || undefined));
    }
    let mt;
    if (m === 'POST' && (mt = p.match(/^\/api\/gates\/([^/]+)$/))) {
      const runId = decodeURIComponent(mt[1]);
      if (!/^[\w-]+$/.test(runId)) return json(res, { error: 'invalid run id' }, 400);
      const b = await readBody(req);
      const hasItems = b.items !== undefined && b.items !== null;
      // With items, the gate outcome is derived from them (any approve -> approve, else any park -> park, else reject), so decision is optional.
      if (!hasItems && !['approve', 'park', 'reject'].includes(b.decision)) return json(res, { error: 'decision must be approve, park or reject' }, 400);
      if (b.decision !== undefined && !['approve', 'park', 'reject'].includes(b.decision)) return json(res, { error: 'decision must be approve, park or reject' }, 400);
      const note = typeof b.note === 'string' ? b.note.slice(0, 2000) : '';
      const run = readJson(path.join(RUNS, runId + '.json'), null);
      if (!run) return json(res, { error: 'run not found' }, 404);
      if (run.status !== 'waiting-gate') return json(res, { error: 'run is not waiting at a gate' }, 409);
      if (hasItems) {
        if (typeof b.items !== 'object' || Array.isArray(b.items) || !Object.keys(b.items).length) return json(res, { error: 'items must be a non-empty object of item -> approve|park|reject' }, 400);
        const g = Object.values(run.gates || {}).find((x) => x && x.status === 'waiting');
        const known = new Set(((g && g.itemList) || []).map((i) => i.id));
        for (const [k, v] of Object.entries(b.items)) {
          if (!known.has(k)) return json(res, { error: 'unknown item: ' + k.slice(0, 80) }, 400);
          if (!['approve', 'park', 'reject'].includes(v)) return json(res, { error: 'item decisions must be approve, park or reject' }, 400);
        }
        spawnEngine(['approve', runId, 'items', JSON.stringify(b.items), note], runId);
        return json(res, { ok: true });
      }
      spawnEngine(['approve', runId, b.decision, note], runId);
      return json(res, { ok: true });
    }
    if (m === 'POST' && (mt = p.match(/^\/api\/runs\/([^/]+)\/resume$/))) {
      const runId = decodeURIComponent(mt[1]);
      if (!/^[\w-]+$/.test(runId)) return json(res, { error: 'invalid run id' }, 400);
      if (!fs.existsSync(path.join(RUNS, runId + '.json'))) return json(res, { error: 'run not found' }, 404);
      spawnEngine(['resume', runId], runId);
      return json(res, { ok: true });
    }
    if (p === '/api/file' && m === 'GET') {
      const raw = url.searchParams.get('path') || '';
      if (raw.includes('\0') || raw.includes('..') || raw.includes('\\') || path.isAbsolute(raw) || /^[a-zA-Z]:/.test(raw)) return text(res, 'forbidden', 403);
      const norm = path.posix.normalize(raw);
      if (!/\.md$/i.test(norm) || !(norm.startsWith('docs/') || norm.startsWith('.studio/checkpoints/'))) return text(res, 'forbidden', 403);
      const full = path.resolve(REPO, norm);
      if (!full.startsWith(REPO + path.sep)) return text(res, 'forbidden', 403);
      if (!isFile(full)) return text(res, 'not found', 404);
      return text(res, fs.readFileSync(full, 'utf8'));
    }
    if (p.startsWith('/api/')) return json(res, { error: 'not found' }, 404);

    if (p.startsWith('/portraits/') && m === 'GET') {
      const full = safeJoin(PORTRAITS, p.slice('/portraits/'.length));
      if (!full || !/\.(png|jpe?g|webp|svg)$/i.test(full) || !isFile(full)) return text(res, 'not found', 404);
      return sendFile(res, full, { 'Cache-Control': 'public, max-age=300' });
    }

    if (p.startsWith('/village/') && m === 'GET') {
      const full = safeJoin(path.join(DIR, 'village'), p.slice('/village/'.length));
      if (!full || !/\.(png|jpe?g|webp|svg)$/i.test(full) || !isFile(full)) return text(res, 'not found', 404);
      return sendFile(res, full, { 'Cache-Control': 'public, max-age=300' });
    }

    // ---- SPA ----
    const index = path.join(DIST, 'index.html');
    if (!isFile(index)) return p === '/' ? sendFile(res, html, { 'Cache-Control': 'no-store' }) : text(res, 'not found', 404);
    const full = p === '/' ? null : safeJoin(DIST, p);
    if (full && isFile(full)) return sendFile(res, full, { 'Cache-Control': /\/assets\//.test(p) ? 'public, max-age=31536000, immutable' : 'no-cache' });
    if (path.extname(p)) return text(res, 'not found', 404);
    return sendFile(res, index, { 'Cache-Control': 'no-cache' });
  }

  http.createServer((req, res) => {
    handle(req, res).catch(() => { try { if (!res.headersSent) json(res, { error: 'server error' }, 500); else res.end(); } catch {} });
  }).listen(port, '127.0.0.1', () => console.log(`Studio dashboard: http://localhost:${port}`));
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'hook') hook().catch(() => {});
else if (cmd === 'log') log(rest);
else if (cmd === 'pause') console.log(setControl('paused'));
else if (cmd === 'resume') console.log(setControl('running'));
else if (cmd === 'status') { console.log(getControl()); for (const c of listCheckpoints()) console.log('\n' + c.text); }
else if (cmd === 'checkpoint') checkpoint(rest);
else if (cmd === 'checkpoint-clear') clearCheckpoint(rest);
else if (cmd === 'serve') serve(Number(process.env.PORT) || Number(rest[0]) || 4777);
else if (cmd === 'reset') { fs.writeFileSync(LOG, ''); console.log('Event log cleared.'); }
else console.log('commands: hook | log | serve | reset | pause | resume | status | checkpoint | checkpoint-clear');
