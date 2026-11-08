#!/usr/bin/env node
// Studio supervisor: `node studio/studio.js supervise` (long-running, one pass every 60 s).
//  - Keeps Ollama and the Control Room server alive (power.startup starts whichever is down).
//  - Switch Running: resumes engine runs with status 'paused' or 'running' that have no live engine process.
//    One engine process per run: lock HOME/.studio/locks/<runId>.lock holds the pid; stale if the pid is dead.
//    Never resumes 'blocked', 'waiting-gate', 'parked' (or any other status).
//  - Switch Paused: only keeps the services up.
//  - Daily backup at 03:00 local time (zip of runs, checkpoints, roster, events, docs/internal).
// Log: HOME/.studio/logs/supervisor.log (rotated at 5 MB, 5 files kept).
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const INTERVAL_MS = 60000;
const MAX_LOG = 5 * 1024 * 1024;
const KEEP = 5;
const RESUMABLE = new Set(['paused', 'running']);

const alive = (pid) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

// Track whether we backed up today so we don't repeat within the same process lifetime.
let lastBackupDate = '';

function makeLogger(DIR, maxBytes = MAX_LOG, keep = KEEP) {
  const dir = path.join(DIR, 'logs'), file = path.join(dir, 'supervisor.log');
  return (msg) => {
    try {
      fs.mkdirSync(dir, { recursive: true });
      if (fs.existsSync(file) && fs.statSync(file).size >= maxBytes) {
        try { fs.unlinkSync(`${file}.${keep}`); } catch {}
        for (let i = keep - 1; i >= 1; i--) { try { fs.renameSync(`${file}.${i}`, `${file}.${i + 1}`); } catch {} }
        fs.renameSync(file, `${file}.1`);
      }
      fs.appendFileSync(file, `${new Date().toISOString()} ${msg}\n`);
    } catch {}
  };
}

/** Take the per-run lock. Returns true if we now own it, false if a live process already holds it. */
function takeLock(lockFile, deps) {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try { fs.writeFileSync(lockFile, String(process.pid), { flag: 'wx' }); return true; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let pid = 0; try { pid = Number(fs.readFileSync(lockFile, 'utf8')); } catch {}
      if (deps.isAlive(pid)) return false;
      try { fs.unlinkSync(lockFile); } catch {}
    }
  }
  return false;
}

function defaultSpawnEngine(HOME, runId) {
  const engine = path.join(__dirname, '..', 'engine', 'engine.js');
  const child = spawn(process.execPath, [engine, 'resume', runId], { detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, STUDIO_HOME: HOME } });
  child.unref();
  return child.pid;
}

/**
 * One pass. ctx: { HOME, DIR, getControl, append, log }
 * deps (injectable for tests): startup, spawnEngine(HOME, runId) -> pid, isAlive(pid), engineAlive(runId) -> bool
 */
function tick(ctx, deps = {}) {
  const { HOME, DIR } = ctx;
  const log = ctx.log || (() => {});
  deps = {
    startup: (c) => require('./power').startup(c),
    spawnEngine: defaultSpawnEngine,
    isAlive: alive,
    engineAlive: (runId) => require('./power').studioProcesses().some((p) => /engine[\\/]engine\.js/.test(p.cmd) && p.cmd.includes(runId)),
    ...deps,
  };
  const result = { resumed: [], skipped: [] };

  try { deps.startup({ HOME, DIR, log: (s) => { if (!/still PAUSED/.test(s)) log(s); } }); } catch (e) { log('service check failed: ' + e.message); }

  if (ctx.getControl().state !== 'running') { log('switch is Paused: services only'); return result; }

  const runsDir = path.join(DIR, 'runs');
  const files = fs.existsSync(runsDir) ? fs.readdirSync(runsDir).filter((f) => f.endsWith('.json')) : [];
  for (const f of files) {
    let run; try { run = JSON.parse(fs.readFileSync(path.join(runsDir, f), 'utf8')); } catch { continue; }
    const id = run.id || f.replace(/\.json$/, '');
    if (!/^[\w.-]+$/.test(id)) continue;
    if (!RESUMABLE.has(run.status)) { result.skipped.push(id); continue; }
    if (deps.engineAlive(id)) { log(`run ${id}: engine already live, skipping`); result.skipped.push(id); continue; }
    const lock = path.join(DIR, 'locks', id + '.lock');
    if (!takeLock(lock, deps)) { log(`run ${id}: locked by a live process, skipping`); result.skipped.push(id); continue; }
    try {
      const pid = deps.spawnEngine(HOME, id);
      fs.writeFileSync(lock, String(pid));
      log(`run ${id}: resumed (was ${run.status}) pid ${pid}`);
      ctx.append({ type: 'progress', agent: 'manager', pct: 0, message: `Supervisor resumed run ${id} (was ${run.status})`, status: 'working' });
      result.resumed.push(id);
    } catch (e) {
      try { fs.unlinkSync(lock); } catch {}
      log(`run ${id}: resume failed: ${e.message}`);
    }
  }
  return result;
}

/** Long-running loop. */
function supervise(ctx) {
  const log = makeLogger(ctx.DIR);
  const c = { ...ctx, log };
  log(`supervisor started (pid ${process.pid}, every ${INTERVAL_MS / 1000} s)`);
  const pass = () => {
    try { tick(c); } catch (e) { log('tick error: ' + (e.stack || e.message)); }
    try { dailyBackup(c, log); } catch (e) { log('backup error: ' + (e.stack || e.message)); }
  };
  pass();
  return setInterval(pass, INTERVAL_MS);
}

/** Run daily backup at 03:00 local time if none was done yet today. */
function dailyBackup(ctx, log) {
  const today = new Date().toISOString().slice(0, 10);
  if (lastBackupDate === today) return; // already backed up today this process lifetime
  const now = new Date();
  const hour = now.getHours();
  if (hour !== 3) return; // only at 03:00
  log('daily backup at 03:00');
  try {
    const { backup } = require('./backup');
    const dest = backup({ HOME: ctx.HOME });
    if (dest) log(`backup done: ${dest}`);
    lastBackupDate = today;
  } catch (e) {
    log('backup failed: ' + (e.message || e));
  }
}

module.exports = { tick, supervise, makeLogger, takeLock, INTERVAL_MS, dailyBackup };
