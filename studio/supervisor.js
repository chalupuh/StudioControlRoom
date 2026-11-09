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
    // dailyBackup is async (S1) — it logs its own success/failure inside dailyBackup().
    try { dailyBackup(c, log); } catch (e) { log('backup scheduling error: ' + (e.stack || e.message)); }
  };
  pass();
  return setInterval(pass, INTERVAL_MS);
}

/** Run daily backup at 03:00 local time if none was done yet today.
 *  Retry guard: `.studio/backups/.last-attempt` stores an ISO timestamp.
 *  A failed attempt is not retried until 60 minutes have passed, so the 03:00
 *  backup on a busy host can succeed at 04:00 or later without blocking the
 *  entire day.
 *  The backup runs asynchronously (S1) so tick() keeps its 60 s cadence. */
function dailyBackup(ctx, log, opts = {}) {
  const now = opts.now || new Date();
  const { localDate: localDateFn, backup: backupFn } = opts;
  const localDate = localDateFn || require('./backup').localDate;
  const today = localDate(now);
  const backupDir = path.join(ctx.HOME, '.studio', 'backups');
  const expectedZip = path.join(backupDir, today + '.zip');
  if (fs.existsSync(expectedZip)) return; // already backed up today

  const hour = now.getHours();
  if (hour < 3) return; // first run happens before 03:00 → wait; allows catch-up after downtime

  // Hourly retry guard: store ISO timestamp, skip if less than 60 minutes old.
  const attemptFile = path.join(backupDir, '.last-attempt');
  try { fs.mkdirSync(backupDir, { recursive: true }); } catch {}
  try {
    const lastISO = fs.readFileSync(attemptFile, 'utf8').trim();
    const lastTime = new Date(lastISO).getTime();
    if (!Number.isNaN(lastTime) && (now.getTime() - lastTime) < 60 * 60 * 1000) {
      return; // attempted within the last hour
    }
  } catch {}

  log('daily backup at ' + String(hour).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0') + ' (local date ' + today + ')');

  // Write attempt timestamp before starting so next tick skips
  try { fs.writeFileSync(attemptFile, now.toISOString()); } catch {}

  // S1: run backup asynchronously so tick() keeps its cadence.
  const doBackup = backupFn || require('./backup').backup;
  doBackup({ HOME: ctx.HOME, now })
    .then((dest) => {
      if (dest) log('backup done: ' + dest);
      else log('backup: nothing to back up');
    })
    .catch((e) => { log('backup failed: ' + (e.message || e)); });
}

module.exports = { tick, supervise, makeLogger, takeLock, INTERVAL_MS, dailyBackup };
