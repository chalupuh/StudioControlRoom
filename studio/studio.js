#!/usr/bin/env node
// Studio monitor: one script, three jobs.
//   node .studio/studio.js hook                 <- called by Claude Code hooks (reads JSON on stdin)
//   node .studio/studio.js log <agent> <pct> "<message>" [working|blocked|done]
//   node .studio/studio.js serve [port]         <- live dashboard at http://localhost:4777
//   node .studio/studio.js reset                <- clear the event log
//   node .studio/studio.js pause | resume | status        <- safe stop / start switch
//   node .studio/studio.js checkpoint <agent> "<where>" "<next>" ["<files>"]
//   node .studio/studio.js checkpoint-clear <agent>       <- archive after resuming
//   node studio/studio.js supervise                       <- long-running: keep services up, resume paused/running runs (60 s)
//   node studio/studio.js backup                          <- one daily backup now
//   node studio/studio.js token [rotate]                  <- show current token / rotate it
//   node studio/studio.js pair [port]                     <- LAN pairing URL(s) + QR code for a phone
//   node studio/studio.js shutdown | startup              <- Game mode: one-shot total shutdown / bring back
const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');

// Auth: extracted to testable module; studio-local functions delegate to it.
const auth = require('./auth');

// SOFT = where this software lives (dashboard.html, app-dist). HOME = the org workspace (agents, docs,
// runtime data in HOME/.studio). They are the same folder today; after the StudioControlRoom split they differ.
// HOME: --home CLI arg → STUDIO_HOME env → studio.home.json next to the software → error (no repo-root fallback).
const SOFT = __dirname;

/* Parse --home <path> from argv and set STUDIO_HOME so children inherit it.
   This lets the boot task register node directly with `-Argument '… --home "C:\HQ"'`
   instead of relying on per-action environment variables (which Task Scheduler does not support). */
(function parseHomeArg() {
  const idx = process.argv.indexOf('--home');
  if (idx !== -1 && process.argv[idx + 1]) {
    process.env.STUDIO_HOME = process.argv[idx + 1];
    process.argv.splice(idx, 2); // N11: keep positional args (e.g. `serve --home X 4800`) intact
  }
})();

/** Resolve HOME. If strict is true (for supervise/backup), exit 1 if HOME cannot be resolved. */
function studioHome(strict) {
  const h = require('./machine').studioHome(null); // shared rule: STUDIO_HOME (from --home) -> studio.home.json
  if (h) return h;
  if (strict) { console.error('Cannot resolve STUDIO_HOME. Pass --home <path>, set STUDIO_HOME, or create studio.home.json.'); process.exit(1); }
  // Non-strict fallback (for serve, hook, etc. — safe for dashboard).
  return path.resolve(SOFT, '..');
}
const HOME = studioHome();
const DIR = path.join(HOME, '.studio');
const machineLib = require('./machine');
const MACHINE = machineLib.load(HOME); // per-machine profile (HOME/.studio/machine.json)
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

// ---- Auth token ----
function generateToken() { return auth.generateToken(); }
function readAuth() { return auth.readAuth(DIR); }
function writeAuth(a) { auth.writeAuth(DIR, a); }
function ensureToken() { return auth.ensureToken(DIR); }
function currentToken() { return auth.currentToken(DIR); }
function verifyToken(provided) {
  const expected = currentToken();
  if (!expected) return false;
  return auth.verifyToken(provided, expected);
}

// ---- LAN bind address ----
function getLanBind() {
  // 1. STUDIO_BIND env var, 2. machine.json controlRoom.bind (via machine.js defaults), 3. loopback only
  return process.env.STUDIO_BIND || MACHINE.controlRoom.bind || '127.0.0.1';
}

// ---- Pairing (phone on the LAN) ----
// One entry per private IPv4 address of this host; each is a ready-to-open pairing link.
// Virtual adapters (WSL, Hyper-V, Docker, VPN...) are sorted last instead of dropped —
// a Hyper-V External switch can hold the host's real LAN address.
// Home /24 (192.168.x) addresses sort first. Result is cached for 30 s.
const VIRTUAL_NIC = /vEthernet|WSL|Hyper-V|Docker|VirtualBox|VMware|Loopback/i;
let _lanCache = { at: 0, val: null };
const LAN_CACHE_TTL = 30000;
function lanAddresses(ifaces) {
  const live = ifaces === undefined;
  if (live) {
    if (Date.now() - _lanCache.at < LAN_CACHE_TTL && _lanCache.val !== null) return _lanCache.val;
    ifaces = os.networkInterfaces();
  }
  const out = [];
  const virtual = [];
  for (const [name, list] of Object.entries(ifaces)) {
    const isVirtual = VIRTUAL_NIC.test(name);
    for (const ni of list || []) {
      if (ni.family !== 'IPv4' || ni.internal || !auth.isPrivateIP(ni.address)) continue;
      (isVirtual ? virtual : out).push(ni.address);
    }
  }
  const result = [...new Set([...out, ...virtual])].sort(
    (a, b) => Number(b.startsWith('192.168.')) - Number(a.startsWith('192.168.'))
  );
  if (live) {
    _lanCache = { at: Date.now(), val: result };
  }
  return result;
}
// preferHost: the Host header the browser used; if it is one of our LAN addresses it goes first.
function lanPairUrls(port, token, preferHost) {
  const addrs = lanAddresses();
  const h = String(preferHost || '').replace(/:\d+$/, '');
  const i = addrs.indexOf(h);
  if (i > 0) addrs.unshift(addrs.splice(i, 1)[0]);
  return addrs.map((a) => `http://${a}:${port}/pair?t=${token}`);
}

const isLoopbackBind = (b) => /^(127(\.\d{1,3}){3}|::1|localhost)$/i.test(String(b || '').trim());

function pairCommand(rest) {
  const qr = require('./qr');
  const port = Number(rest[0]) || Number(process.env.PORT) || 4777;
  const urls = lanPairUrls(port, ensureToken().token);
  if (!urls.length) { console.log('No private LAN IPv4 address found on this host.'); process.exitCode = 1; return; }
  const bind = getLanBind();
  if (isLoopbackBind(bind)) {
    console.log(`Note: the server is bound to ${bind} (loopback only). Set STUDIO_BIND=0.0.0.0 (or controlRoom.bind in machine.json) and restart, or a phone cannot connect.\n`);
  }
  console.log('Open one of these on your phone (same Wi-Fi/LAN):');
  for (const u of urls) console.log('  ' + u);
  console.log('\n' + qr.toTerminal(qr.encode(urls[0])) + '\n');
  console.log('(QR is for the first link. It is drawn for dark terminals; on a light terminal, invert colours or use a link.)');
  console.log('If the phone cannot connect, allow the port: powershell -File studio\\firewall.ps1 -Port ' + port);
}

// ---- Auth state ----
const rateStore = auth.createRateStore();
let _isLanMode = false;

function runSummary(run) {
  const cur = run.cursor || 0;
  const stages = (run.stages || []).map((s, i) => ({
    id: s.id, type: s.type, agent: s.agent, tier: s.tier,
    state: run.status === 'done' || i < cur ? 'done' : i === cur ? 'current' : 'pending',
  }));
  let gate;
  for (const [id, g] of Object.entries(run.gates || {})) {
    if (g && g.status === 'waiting') gate = { id, title: g.title || id, show: g.show || [], since: g.since };
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
  const byAgent = {};
  const days = {};
  const todayKey = dayKey(Date.now());
  for (let i = 13; i >= 0; i--) { const k = dayKey(Date.now() - i * 86400000); days[k] = { day: k, cloudTokens: 0, localTokens: 0 }; }
  for (const e of readEvents()) {
    if (e.type !== 'usage') continue;
    const tok = (Number(e.tokensIn) || 0) + (Number(e.tokensOut) || 0);
    const k = dayKey(e.ts), cloud = !!e.cloud;
    const a = (byAgent[e.agent] = byAgent[e.agent] || { cloudTokens: 0, localTokens: 0, calls: 0, secs: 0 });
    a[cloud ? 'cloudTokens' : 'localTokens'] += tok; a.calls++; a.secs += Number(e.secs) || 0;
    if (days[k]) days[k][cloud ? 'cloudTokens' : 'localTokens'] += tok;
    if (k === todayKey) { today[cloud ? 'cloudTokens' : 'localTokens'] += tok; today[cloud ? 'cloudCalls' : 'localCalls']++; }
  }
  return { budget, today, byAgent, byDay: Object.values(days) };
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
    fetchJson(machineLib.ollamaUrl(MACHINE) + '/api/ps').then((j) => (j.models || []).map((m) => ({ name: m.name || m.model, vramMB: Math.round((m.size_vram || 0) / 1048576), until: m.expires_at }))).catch(() => []),
    fetchJson(MACHINE.comfyUrl.replace(/\/+$/, '') + '/queue').then((j) => ({ up: true, queueRunning: (j.queue_running || []).length, queuePending: (j.queue_pending || []).length })).catch(() => ({ up: false, queueRunning: 0, queuePending: 0 })),
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
  // Shared with the supervisor: output goes to runs/<id>.log through an inherited fd.
  return require('./supervisor').spawnEngine(HOME, runId, { engine: ENGINE }, args);
}

function serve(port = MACHINE.controlRoom.port) {
  const html = path.join(SOFT, 'dashboard.html');
  const json = (res, obj, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
  const text = (res, s, code = 200) => { res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(s); };

  // Determine bind address and LAN mode
  const bindAddr = getLanBind();
  _isLanMode = !isLoopbackBind(bindAddr);

  // Ensure token exists when in LAN mode
  if (_isLanMode) ensureToken();

  const authMiddleware = auth.makeAuthMiddleware(json, DIR, rateStore);
  startWatchers();

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname, m = req.method;

    // ---- defence in depth: source IP, Host (DNS rebinding) and Origin (CSRF) ----
    if (_isLanMode && !auth.isPrivateIP(auth.rateLimitKey(req))) return json(res, { error: 'forbidden' }, 403);
    const hostName = String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '');
    if (!['localhost', '127.0.0.1', '[::1]', bindAddr.toLowerCase(), ...lanAddresses()].includes(hostName)) return json(res, { error: 'forbidden host' }, 403);
    if (m !== 'GET' && m !== 'HEAD' && req.headers.origin) {
      let oh = ''; try { oh = new URL(req.headers.origin).host.toLowerCase(); } catch {}
      if (oh !== String(req.headers.host || '').toLowerCase()) return json(res, { error: 'forbidden origin' }, 403);
    }

    // ---- /pair: validate token, set HttpOnly cookie, redirect to / ----
    if (p === '/pair' && m === 'GET') {
      const tParam = url.searchParams.get('t');
      // LAN: same IP check + failure rate limit as /api/* (no unlimited guessing here)
      if (_isLanMode && !tParam) return json(res, { error: 'unauthorized' }, 401);
      if (_isLanMode && !authMiddleware.check(req, res, tParam)) return;
      if (tParam && verifyToken(tParam)) {
        res.writeHead(302, {
          'Location': '/',
          'Set-Cookie': `studio_token=${tParam}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`,
          'Cache-Control': 'no-store',
          'Referrer-Policy': 'no-referrer',
        });
        res.end();
        return;
      }
      // If no token or invalid token: in LAN mode, 401; loopback, redirect anyway
      if (_isLanMode) return json(res, { error: 'unauthorized' }, 401);
      res.writeHead(302, { 'Location': '/' });
      res.end();
      return;
    }

    // ---- auth gate (LAN mode): everything except /pair and the static SPA shell ----
    if (_isLanMode && /^\/(api\/|control$|checkpoints$|models$|events$|v1$|portraits\/|village\/)/.test(p) && !authMiddleware(req, res)) return;

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

    // ---- v2 API (auth already enforced by the gate above in LAN mode) ----
    if (p.startsWith('/api/')) {
      if (p === '/api/state' && m === 'GET') return json(res, getState());
      if (p === '/api/pair-qr' && m === 'GET') {
        if (!_isLanMode) return json(res, { error: 'LAN mode is off: set STUDIO_BIND or controlRoom.bind' }, 409);
        const qr = require('./qr');
        const urls = lanPairUrls(port, ensureToken().token, req.headers.host);
        if (!urls.length) return json(res, { error: 'no LAN address' }, 404);
        res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
        return res.end(qr.toSvg(qr.encode(urls[0])));
      }
      if (p === '/api/usage' && m === 'GET') return json(res, getUsage());
      if (p === '/api/gpu' && m === 'GET') return json(res, await getGpu());
      if (p === '/api/stream' && m === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        res.write(': connected\n\n');
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }
      if (p === '/api/shutdown' && m === 'POST') {
        // One-shot Game mode: run in a detached process so it can also stop this server at the end.
        const out = fs.openSync(path.join(DIR, 'shutdown.log'), 'a');
        require('child_process').spawn(process.execPath, [path.join(SOFT, 'studio.js'), 'shutdown'], { detached: true, windowsHide: true, stdio: ['ignore', out, out] }).unref();
        return json(res, { ok: true, message: 'Shutting down: agents checkpoint, local models and ComfyUI stop, then this server stops.' });
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
        if (b.decision !== 'approve' && b.decision !== 'reject') return json(res, { error: 'decision must be approve or reject' }, 400);
        const note = typeof b.note === 'string' ? b.note.slice(0, 2000) : '';
        const run = readJson(path.join(RUNS, runId + '.json'), null);
        if (!run) return json(res, { error: 'run not found' }, 404);
        if (run.status !== 'waiting-gate') return json(res, { error: 'run is not waiting at a gate' }, 409);
        spawnEngine(['approve', runId, b.decision, note], runId);
        return json(res, { ok: true });
      }
      if (m === 'POST' && (mt = p.match(/^\/api\/runs\/([^/]+)\/resume$/))) {
        const runId = decodeURIComponent(mt[1]);
        if (!/^[\w-]+$/.test(runId)) return json(res, { error: 'invalid run id' }, 400);
        // Same lock + process-scan rules as the supervisor: a second click (or a run the supervisor already
        // resumed) gets 409 instead of a second engine.
        const r = require('./supervisor').resumeRun({ HOME, DIR, engine: ENGINE }, runId);
        return json(res, r.body, r.code);
      }
      if (p === '/api/file' && m === 'GET') {
        // gate links carry absolute {{home}} paths; resolveDocPath maps those inside HQ to docs/… and refuses the rest
        const full = require('./filepath.js').resolveDocPath(url.searchParams.get('path') || '', REPO);
        if (!full) return text(res, 'forbidden', 403);
        if (!isFile(full)) return text(res, 'not found', 404);
        return text(res, fs.readFileSync(full, 'utf8'));
      }
      return json(res, { error: 'not found' }, 404);
    }

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
  }).listen(port, bindAddr, () => {
    try { fs.writeFileSync(path.join(DIR, 'server.pid'), String(process.pid)); } catch {}
    console.log(`Studio dashboard: http://localhost:${port}`);
    if (_isLanMode) {
      console.log(`LAN mode: authentication required. Token in ${path.join(DIR, 'auth.json')}`);
    }
  });
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'hook') hook().catch(() => {});
else if (cmd === 'log') log(rest);
else if (cmd === 'pause') console.log(setControl('paused'));
else if (cmd === 'resume') console.log(setControl('running'));
else if (cmd === 'status') { console.log(getControl()); for (const c of listCheckpoints()) console.log('\n' + c.text); }
else if (cmd === 'checkpoint') checkpoint(rest);
else if (cmd === 'checkpoint-clear') clearCheckpoint(rest);
else if (cmd === 'serve') serve(Number(rest[0]) || Number(process.env.PORT) || MACHINE.controlRoom.port);
else if (cmd === 'token') {
  // token subcommands: show current token, or rotate (create/replace)
  const sub = rest[0];
  if (sub === 'rotate') {
    writeAuth({ token: generateToken(), created: Date.now() });
    console.log(`Token rotated. Re-pair devices with "studio.js pair"; existing cookies and links stop working.`);
  } else {
    // Show current token (create if missing)
    const a = ensureToken();
    console.log(`Token: ${a.token}`);
  }
}
else if (cmd === 'pair') pairCommand(rest);
else if (cmd === 'shutdown' || cmd === 'game-mode') require('./power').shutdown({ HOME, DIR, setControl, append, checkpoint, keepServer: rest.includes('--keep-server'), graceSec: Number((rest.find((a) => a.startsWith('--grace=')) || '').slice(8)) || 60 }).then(() => process.exit(0));
else if (cmd === 'startup') require('./power').startup({ HOME, DIR });
else if (cmd === 'supervise') { const h = studioHome(true); require('./supervisor').supervise({ HOME: h, DIR: path.join(h, '.studio'), getControl, append }); }
else if (cmd === 'backup') {
  const h = studioHome(true);
  const { backup } = require('./backup');
  backup({ HOME: h }).then((dest) => { if (!dest) { console.error('backup: nothing to back up'); process.exit(1); } console.log('backup written: ' + dest); }).catch((e) => { console.error(e); process.exit(1); });
}
else if (cmd === 'reset') { fs.writeFileSync(LOG, ''); console.log('Event log cleared.'); }
else console.log('commands: hook | log | serve | reset | pause | resume | status | checkpoint | checkpoint-clear | shutdown [--keep-server] [--grace=60] | startup | supervise | backup | token [rotate] | pair [port]');
