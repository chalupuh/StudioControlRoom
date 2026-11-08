#!/usr/bin/env node
// GPU slot scheduler — cross-process coordination via files only.
//
//   acquire(kind, meta)       → Promise<token>
//   release(token)            → void   |  throw
//   status()                  → { llm:{used, max, model}, creative:{running, queued} }
//   startPoll() / stopPoll()  → optional background stale-slot reclaim (5 s)
//
// Kind 'llm': up to cfg.llmSlots holders concurrently, all on cfg.llmModel.
//   Refused (throws) while any creative slot is running OR pending, or when full.
// Kind 'creative': exclusive. Writes a pending file (pid + since), waits FIFO
//   until it is head of the queue, no creative runs and llm count is 0, then
//   converts pending → running and unloads Ollama models via
//   POST http://127.0.0.1:11434/api/generate {model, keep_alive:0}.
//
// State (all in HOME/.studio/gpu/):
//   <token>.json          running slot  {kind, pid, token, model?, since, meta}
//   pending-<token>.json  queued creative {kind, pid, token, since, meta}
//   .lock/                directory lock (mkdir is atomic) around every
//                         read-modify-write of the state above.
// Stale entries (dead pid) are reclaimed under the lock.

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

// ---- HOME (same resolution as engine.js) ----
function studioHome() {
  if (process.env.STUDIO_HOME) return path.resolve(process.env.STUDIO_HOME);
  try {
    const c = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'studio.home.json'), 'utf8'));
    if (c.home) return path.resolve(c.home);
  } catch { /* noop */ }
  return path.resolve(__dirname, '..', '..');
}
const HOME = studioHome();

// ---- config ----
const GPU_CFG = path.join(HOME, '.studio', 'gpu.json');
const DEFAULT_CFG = { llmModel: 'qwen3.6:27b', llmSlots: 3 };

function loadCfg() {
  try { return { ...DEFAULT_CFG, ...JSON.parse(fs.readFileSync(GPU_CFG, 'utf8')) }; }
  catch { return { ...DEFAULT_CFG }; }
}

const SLOTS_DIR = path.join(HOME, '.studio', 'gpu');
const LOCK_DIR = path.join(SLOTS_DIR, '.lock');
const POLL_MS = Number(process.env.STUDIO_GPU_POLL_MS) || 5000;
const CREATIVE_TIMEOUT_MS = Number(process.env.STUDIO_GPU_CREATIVE_TIMEOUT_MS) || 120000;
const OLLAMA_PORT = Number(process.env.STUDIO_OLLAMA_PORT) || 11434;
const LOCK_STALE_MS = 10000;
const PENDING_PREFIX = 'pending-';

// ---- helpers ----
function newToken() {
  return `${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
}
const TOKEN_RE = /^[A-Za-z0-9_-]+$/;

function slotFile(t) { return path.join(SLOTS_DIR, t + '.json'); }
function pendingFile(t) { return path.join(SLOTS_DIR, PENDING_PREFIX + t + '.json'); }

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// ---- atomic lock (mkdir) ----
function withLock(fn) {
  fs.mkdirSync(SLOTS_DIR, { recursive: true });
  const deadline = Date.now() + 10000;
  for (;;) {
    try { fs.mkdirSync(LOCK_DIR); break; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try { // break a lock left by a crashed process
        if (Date.now() - fs.statSync(LOCK_DIR).mtimeMs > LOCK_STALE_MS) { fs.rmdirSync(LOCK_DIR); continue; }
      } catch { /* released meanwhile */ }
      if (Date.now() > deadline) throw new Error('gpu lock timeout');
      sleepSync(5);
    }
  }
  try { return fn(); }
  finally { try { fs.rmdirSync(LOCK_DIR); } catch { /* noop */ } }
}

// ---- state (call only inside withLock, except status()) ----
function readEntries() {
  const slots = [], pending = [];
  let files = [];
  try { files = fs.readdirSync(SLOTS_DIR); } catch { /* dir gone */ }
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const p = path.join(SLOTS_DIR, f);
    let e;
    try { e = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { continue; }
    if (!e || typeof e !== 'object') continue;
    e._file = p;
    (f.startsWith(PENDING_PREFIX) ? pending : slots).push(e);
  }
  pending.sort((a, b) => (a.since - b.since) || String(a.token).localeCompare(String(b.token)));
  return { slots, pending };
}

// Remove entries whose pid is dead; return the live state.
function reclaim() {
  const st = readEntries();
  const live = { slots: [], pending: [] };
  for (const k of ['slots', 'pending']) {
    for (const e of st[k]) {
      if (isAlive(e.pid)) live[k].push(e);
      else { try { fs.unlinkSync(e._file); } catch { /* gone */ } }
    }
  }
  return live;
}

function writeJson(file, obj) {
  const tmp = file + '.tmp' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, file);
}

// ---- Ollama unload (best-effort) ----
function unloadOllama(model) {
  return new Promise((resolve) => {
    const payload = JSON.stringify({ model, keep_alive: 0 });
    const opts = {
      hostname: '127.0.0.1', port: OLLAMA_PORT, path: '/api/generate', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      timeout: 3000,
    };
    const req = http.request(opts, (res) => { res.resume(); res.on('end', resolve); res.on('error', resolve); });
    req.on('error', () => resolve());
    req.on('timeout', () => { req.destroy(); resolve(); });
    req.end(payload);
  });
}

// ---- poll (stale reclaim) ----
let _interval = null;

function tick() { withLock(reclaim); }

function startPoll() {
  if (_interval) return;
  _interval = setInterval(() => { try { tick(); } catch { /* retry next tick */ } }, POLL_MS);
  _interval.unref();
}
function stopPoll() {
  if (_interval) { clearInterval(_interval); _interval = null; }
}

// ---- public API ----
function tryAcquireLlm(meta) {
  return withLock(() => {
    const { slots, pending } = reclaim();
    if (slots.some((s) => s.kind === 'creative')) throw new Error('blocked: creative running');
    if (pending.length) throw new Error('blocked: creative queued');
    const cfg = loadCfg();
    if (slots.filter((s) => s.kind === 'llm').length >= cfg.llmSlots) throw new Error('no llm slots available');
    const t = newToken();
    writeJson(slotFile(t), { kind: 'llm', pid: process.pid, token: t, model: cfg.llmModel, since: Date.now(), meta: meta || {} });
    return t;
  });
}

// Try to promote our pending request to running. Returns true on success.
function tryPromote(t, meta) {
  return withLock(() => {
    const { slots, pending } = reclaim();
    if (!pending.length || pending[0].token !== t) return false; // not head of FIFO
    if (slots.length) return false;                              // llm or creative still running
    writeJson(slotFile(t), { kind: 'creative', pid: process.pid, token: t, since: Date.now(), meta: meta || {} });
    try { fs.unlinkSync(pendingFile(t)); } catch { /* noop */ }
    return true;
  });
}

/**
 * Acquire a GPU slot.
 * @param {'llm'|'creative'} kind
 * @param {object} [meta]  arbitrary context
 * @returns {Promise<string>} token
 */
async function acquire(kind, meta) {
  if (kind !== 'llm' && kind !== 'creative') throw new Error('invalid kind: ' + kind);
  if (kind === 'llm') return tryAcquireLlm(meta);

  const t = newToken();
  withLock(() => {
    writeJson(pendingFile(t), { kind: 'creative', pid: process.pid, token: t, since: Date.now(), meta: meta || {} });
  });
  const deadline = Date.now() + CREATIVE_TIMEOUT_MS;
  try {
    for (;;) {
      if (tryPromote(t, meta)) break;
      if (Date.now() >= deadline) throw new Error('creative acquire timed out');
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  } catch (e) {
    withLock(() => { try { fs.unlinkSync(pendingFile(t)); } catch { /* gone */ } });
    throw e;
  }
  await unloadOllama(loadCfg().llmModel);
  return t;
}

/**
 * Release a GPU slot.
 * @param {string} t  token
 */
function release(t) {
  if (typeof t !== 'string' || !TOKEN_RE.test(t)) throw new Error('no such token');
  withLock(() => {
    try { fs.unlinkSync(slotFile(t)); }
    catch (e) { if (e.code === 'ENOENT') throw new Error('no such token'); throw e; }
  });
}

/**
 * Current GPU status.
 */
function status() {
  const cfg = loadCfg();
  const { slots, pending } = withLock(reclaim);
  return {
    llm: { used: slots.filter((s) => s.kind === 'llm').length, max: cfg.llmSlots, model: cfg.llmModel },
    creative: { running: slots.some((s) => s.kind === 'creative'), queued: pending.length },
  };
}

// ---- CLI (standalone) ----
if (require.main === module) {
  console.log(JSON.stringify(status(), null, 2));
}

module.exports = { acquire, release, status, startPoll, stopPoll, tick, loadCfg, unloadOllama, SLOTS_DIR };
