#!/usr/bin/env node
// Studio supervisor: `node studio/studio.js supervise` (long-running, one pass every 60 s).
//  - Keeps Ollama and the Control Room server alive (power.startup starts whichever is down).
//  - Switch Running: resumes engine runs with status 'paused' or 'running' that have no live engine process.
//    One engine process per run: lock HOME/.studio/locks/<runId>.lock holds the pid; stale if the pid is dead.
//    Never resumes 'blocked', 'waiting-gate', 'parked' (or any other status).
//  - Switch Paused: only keeps the services up.
//  - Daily backup at 03:00 local time (zip of runs, checkpoints, roster, events, docs/internal).
// Log: HOME/.studio/logs/supervisor.log (rotated at 5 MB, 5 files kept).
//
// Liveness of a lock holder is decided by process command line (engine.js), never by a bare PID, because
// Windows recycles PIDs: a dead engine's PID reused by any other process must not block a run forever.
// Locks are also removed when the engine we spawned exits.
// Crash loop: a resume counts as a crash only if that engine lived < CRASH_MS; the history is cleared whenever
// the switch is Paused, so pause/resume cycles, Game mode and reboots never block a healthy run.
// Resumed engines log to runs/<id>.log through an inherited file descriptor, so they survive a supervisor restart.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { teamOf, teamPaused } = require('./teams');

const INTERVAL_MS = 60000;
const MAX_LOG = 5 * 1024 * 1024;
const KEEP = 5;
const CRASH_MS = 5 * 60 * 1000;
const RESUMABLE = new Set(['paused', 'running']);
const ENGINE_RE = /engine[\\/]engine\.js/;

/** Bare liveness (signal 0). Only a building block: use enginePid() for engine locks. */
const alive = (pid) => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};

/** True when pid is alive AND is an engine.js process (per the process scan). procs === null: scan unavailable. */
function enginePid(pid, procs, aliveFn = alive) {
  if (!aliveFn(pid)) return false;
  if (!procs) return true;
  return procs.some((p) => p.pid === pid && ENGINE_RE.test(p.cmd));
}

/** Is any engine.js process running this run id (whole-token match, not substring)? */
function engineAlive(runId, procs) {
  if (!procs) return false;
  const re = new RegExp('(?<![\\w.-])' + runId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\w.-])');
  return procs.some((p) => ENGINE_RE.test(p.cmd) && re.test(p.cmd));
}

/** Process scan, or null when unavailable (non-Windows): callers then fall back to bare PID checks. */
function loadProcs(deps = {}) {
  try {
    if (deps.studioProcesses) return deps.studioProcesses();
    if (process.platform !== 'win32') return null;
    return require('./power').studioProcesses();
  } catch { return null; }
}

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

/**
 * Take a lock file (atomic create). Returns true if we now own it, false if a live holder has it.
 * deps.isAlive(pid) decides liveness; deps.staleMs (optional) also treats a lock not touched for that long as stale.
 */
function takeLock(lockFile, deps) {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try { fs.writeFileSync(lockFile, String(process.pid), { flag: 'wx' }); return true; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let pid = 0; try { pid = Number(fs.readFileSync(lockFile, 'utf8')); } catch {}
      let stale = false;
      if (deps.staleMs) { try { stale = Date.now() - fs.statSync(lockFile).mtimeMs > deps.staleMs; } catch {} }
      if (!stale && deps.isAlive(pid)) return false;
      try { fs.unlinkSync(lockFile); } catch {}
    }
  }
  return false;
}

/** Delete a lock only if it still names `pid` (the engine that just exited). */
function releaseLock(lockFile, pid) {
  try { if (Number(fs.readFileSync(lockFile, 'utf8')) === pid) fs.unlinkSync(lockFile); } catch {}
}

/** Crash-loop history lives next to the lock (locks/<id>.resumes.json) so replacing a stale lock keeps it. */
function resumesFile(lockFile) { return lockFile.replace(/\.lock$/, '.resumes.json'); }

function readResumes(lockFile) {
  try { const a = JSON.parse(fs.readFileSync(resumesFile(lockFile), 'utf8')); return Array.isArray(a) ? a : []; } catch { return []; }
}
function writeResumes(lockFile, list) {
  try { fs.writeFileSync(resumesFile(lockFile), JSON.stringify(list.slice(-10))); } catch {}
}

/** Called when we know the previous engine for this run is gone: settle its lifetime (crash if < CRASH_MS). */
function settleResumes(lockFile, now = Date.now()) {
  const list = readResumes(lockFile);
  const last = list[list.length - 1];
  if (last && last.ended === undefined) {
    last.ended = now;
    last.crashed = now - last.time < CRASH_MS;
    writeResumes(lockFile, list);
  }
}

/** Blocks after 3 crashed resumes (engine lived < 5 min) within 1 hour at the same cursor. */
function crashLoopGuard(lockFile, runCursor, now = Date.now()) {
  const recent = readResumes(lockFile).filter((t) => t.crashed && t.time > now - 60 * 60 * 1000 && t.cursor === runCursor);
  if (recent.length < 3) return { blocked: false };
  return { blocked: true, reason: 'supervisor: resume loop (3 quick engine exits/1h, no cursor change)' };
}

/** Record a resume attempt (keeps the last 10). */
function recordResume(lockFile, cursor, pid) {
  const list = readResumes(lockFile);
  list.push({ time: Date.now(), cursor, pid });
  writeResumes(lockFile, list);
}

/** Forget all crash history (switch Paused: engines stopped on purpose, not crashed). */
function clearResumes(DIR) {
  const dir = path.join(DIR, 'locks');
  let names = []; try { names = fs.readdirSync(dir); } catch {}
  for (const n of names) if (n.endsWith('.resumes.json')) { try { fs.unlinkSync(path.join(dir, n)); } catch {} }
}

/**
 * Spawn `engine.js <args>` detached. Used by the supervisor AND the dashboard. stdout/stderr go straight to
 * runs/<id>.log through an inherited file descriptor (no pipe owned by this process), stdin is ignored, so the
 * engine keeps logging and cannot get EPIPE when this process exits. Returns the child (child.stdout === null).
 * ctx: { log?, engine? (override path) }
 */
function spawnEngine(HOME, runId, ctx = {}, args = ['resume', runId]) {
  const engine = ctx.engine || path.join(__dirname, '..', 'engine', 'engine.js');
  const runs = path.join(HOME, '.studio', 'runs');
  fs.mkdirSync(runs, { recursive: true });
  const out = fs.openSync(path.join(runs, runId + '.log'), 'a');
  let child;
  try {
    child = spawn(process.execPath, [engine, ...args], {
      cwd: HOME, detached: true, windowsHide: true, stdio: ['ignore', out, out],
      env: { ...process.env, STUDIO_HOME: HOME },
    });
  } finally { fs.closeSync(out); }
  child.on('error', (err) => { (ctx.log || console.error)(`engine ${runId}: spawn error: ${err.message}`); });
  child.unref();
  return child;
}

/** spawnEngine result -> pid (tests inject functions that return a bare pid). */
const pidOf = (r) => (r && typeof r === 'object' ? r.pid : r);
function watchExit(r, lock) {
  if (r && typeof r === 'object' && typeof r.on === 'function' && r.pid) r.on('exit', () => releaseLock(lock, r.pid));
}

/**
 * Dashboard "resume run": same lock + liveness rules as the supervisor, so two clicks (or a click on a run the
 * supervisor already resumed) can never start two engines. Returns { code, body }.
 * ctx: { HOME, DIR, log?, engine? }; deps (tests): spawnEngine, isAlive, studioProcesses
 */
function resumeRun(ctx, runId, deps = {}) {
  const { HOME, DIR } = ctx;
  if (!/^[\w.-]+$/.test(runId)) return { code: 400, body: { error: 'invalid run id' } };
  if (!fs.existsSync(path.join(DIR, 'runs', runId + '.json'))) return { code: 404, body: { error: 'run not found' } };
  const procs = loadProcs(deps);
  const lock = path.join(DIR, 'locks', runId + '.lock');
  const busy = { code: 409, body: { error: 'run already running', running: true } };
  if (engineAlive(runId, procs)) return busy;
  const isAlive = deps.isAlive || ((pid) => enginePid(pid, procs));
  if (!takeLock(lock, { isAlive })) return busy;
  try {
    const r = (deps.spawnEngine || spawnEngine)(HOME, runId, ctx);
    fs.writeFileSync(lock, String(pidOf(r)));
    watchExit(r, lock);
    return { code: 200, body: { ok: true } };
  } catch (e) {
    try { fs.unlinkSync(lock); } catch {}
    return { code: 500, body: { error: 'spawn failed' } };
  }
}

/**
 * One pass. ctx: { HOME, DIR, getControl, append, log }
 * deps (injectable for tests): startup, spawnEngine(HOME, runId, ctx) -> child|pid, isAlive(pid),
 *   engineAlive(runId) -> bool, studioProcesses() -> [{pid, cmd}], MACHINE, liveCount
 */
function tick(ctx, deps = {}) {
  const { HOME, DIR } = ctx;
  const log = ctx.log || (() => {});
  const control = ctx.getControl ? ctx.getControl() : { state: 'running' };

  // One process scan per tick, shared with power.startup via ctx.
  const studioProcs = loadProcs(deps);

  deps = {
    startup: (c) => require('./power').startup(c),
    spawnEngine,
    isAlive: (pid) => enginePid(pid, studioProcs),
    engineAlive: (runId) => engineAlive(runId, studioProcs),
    ...deps,
  };
  const result = { resumed: [], skipped: [] };

  try {
    const p = deps.startup({ HOME, DIR, studioProcs, log: (s) => { if (!/still PAUSED/.test(s)) log(s); } });
    if (p && typeof p.catch === 'function') p.catch((e) => log('service check failed: ' + e.message));
  } catch (e) { log('service check failed: ' + e.message); }

  if (control.state !== 'running') {
    clearResumes(DIR); // engines stopped on purpose are not crashes
    log('switch is Paused: services only');
    return result;
  }

  // Concurrency cap from this machine's profile (gpu.llmSlots), default 2.
  const MACHINE = deps.MACHINE || require('./machine').load(HOME);
  const maxEngines = (MACHINE.gpu && MACHINE.gpu.llmSlots) || 2;
  const liveCount = deps.liveCount !== undefined ? deps.liveCount : studioProcs ? studioProcs.filter((p) => ENGINE_RE.test(p.cmd)).length : 0;

  // Read roster for team-pause checks
  let roster = null;
  try { roster = JSON.parse(fs.readFileSync(path.join(DIR, 'roster.json'), 'utf8')); } catch {}

  const runsDir = path.join(DIR, 'runs');
  const files = fs.existsSync(runsDir) ? fs.readdirSync(runsDir).filter((f) => f.endsWith('.json')) : [];
  for (const f of files) {
    if (liveCount + result.resumed.length >= maxEngines) {
      log(`concurrency cap reached (${maxEngines}), skipping remaining runs`);
      break;
    }

    let run; try { run = JSON.parse(fs.readFileSync(path.join(runsDir, f), 'utf8')); } catch { continue; }
    const id = run.id || f.replace(/\.json$/, '');
    if (!/^[\w.-]+$/.test(id)) continue;
    if (!RESUMABLE.has(run.status)) { result.skipped.push(id); continue; }
    const lock = path.join(DIR, 'locks', id + '.lock');

    // Team-pause guard: skip the run if its current team is paused (engine stops on purpose: not a crash)
    const currentStage = run.stages && run.stages[run.cursor];
    if (currentStage && currentStage.agent) {
      const team = teamOf(currentStage.agent, roster);
      if (teamPaused(team, control)) {
        try { fs.unlinkSync(resumesFile(lock)); } catch {}
        log(`run ${id}: team '${team}' is paused, skipping`);
        result.skipped.push(id);
        continue;
      }
    }

    if (deps.engineAlive(id)) { log(`run ${id}: engine already live, skipping`); result.skipped.push(id); continue; }

    // No engine process for this run: settle how long the last resumed engine lived, then apply the guard.
    const cursor = run.cursor || 0;
    // A failed process scan (null) cannot tell a live resumed engine from a dead one: settle only after takeLock succeeds.
    const scanOk = !!studioProcs;
    if (scanOk) settleResumes(lock);
    const guard = crashLoopGuard(lock, cursor);
    if (guard.blocked) {
      log(`run ${id}: crash-loop blocked (${guard.reason})`);
      result.skipped.push(id);
      try {
        run.status = 'blocked';
        run.blockedReason = guard.reason;
        fs.writeFileSync(path.join(runsDir, f), JSON.stringify(run, null, 2));
        ctx.append({ type: 'blocked', agent: 'manager', message: `Supervisor blocked run ${id}: ${guard.reason}`, status: 'blocked' });
      } catch {}
      continue;
    }

    if (!takeLock(lock, deps)) { log(`run ${id}: locked by a live process, skipping`); result.skipped.push(id); continue; }
    if (!scanOk) settleResumes(lock);
    try {
      const r = deps.spawnEngine(HOME, id, ctx);
      const pid = pidOf(r);
      recordResume(lock, cursor, pid);
      fs.writeFileSync(lock, String(pid));
      watchExit(r, lock);
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

/** Long-running loop with single-instance guard. */
function supervise(ctx) {
  // Single-instance guard: atomic lock, refreshed every tick (heartbeat). A lock not touched for 3 intervals is
  // stale even if its PID is alive (PID reuse), so a recycled PID can never keep the real supervisor out.
  const supervisorLock = path.join(ctx.DIR, 'locks', 'supervisor.lock');
  if (!takeLock(supervisorLock, { isAlive: alive, staleMs: 3 * INTERVAL_MS })) {
    // Exit 0: a duplicate start is not a failure, so Task Scheduler must not "restart on failure" it 999 times.
    console.error('Supervisor already running. Exiting.');
    process.exit(0);
  }

  const log = makeLogger(ctx.DIR);
  const c = { ...ctx, log };
  log(`supervisor started (pid ${process.pid}, every ${INTERVAL_MS / 1000} s)`);
  const pass = () => {
    try { fs.utimesSync(supervisorLock, new Date(), new Date()); } catch {}
    try { tick(c); } catch (e) { log('tick error: ' + (e.stack || e.message)); }
    // dailyBackup is async (S1) — it logs its own success/failure inside dailyBackup().
    try { dailyBackup(c, log); } catch (e) { log('backup scheduling error: ' + (e.stack || e.message)); }
  };
  pass();
  const interval = setInterval(pass, INTERVAL_MS);

  // Clean up supervisor lock on exit
  process.on('exit', () => { try { fs.unlinkSync(supervisorLock); } catch {} });
  process.on('SIGTERM', () => { try { fs.unlinkSync(supervisorLock); } catch {} clearInterval(interval); process.exit(0); });
  process.on('SIGINT', () => { try { fs.unlinkSync(supervisorLock); } catch {} clearInterval(interval); process.exit(0); });

  return interval;
}

/** Run daily backup at 03:00 local time if none was done yet today.
 *  Retry guard: `.studio/backups/.last-attempt` stores an ISO timestamp.
 *  A failed attempt is not retried until 60 minutes have passed, so the 03:00
 *  backup on a busy host can succeed at 04:00 or later without blocking the
 *  entire day.
 *  The backup runs asynchronously (S1) so tick() keeps its 60 s cadence. */
let backupRunning = false; // in-flight guard: a slow backup must not overlap the next hourly retry
function dailyBackup(ctx, log, opts = {}) {
  if (backupRunning) return;
  const now = opts.now || new Date();
  const { localDate: localDateFn, backup: backupFn } = opts;
  const localDate = localDateFn || require('./backup').localDate;
  const today = localDate(now);
  const backupDir = path.join(ctx.HOME, '.studio', 'backups');
  const expectedZip = path.join(backupDir, today + '.zip');
  // S6: only check for final .zip (not .partial), so retries work
  if (fs.existsSync(expectedZip)) return; // already backed up today

  const hour = now.getHours();
  if (hour < 3) return; // first run happens before 03:00 -> wait; allows catch-up after downtime

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
  backupRunning = true;
  let p;
  try { p = Promise.resolve(doBackup({ HOME: ctx.HOME, now, log })); } catch (e) { p = Promise.reject(e); }
  p.then((dest) => {
      if (dest) log('backup done: ' + dest);
      else log('backup: nothing to back up');
    })
    .catch((e) => { log('backup failed: ' + (e.message || e)); })
    .finally(() => { backupRunning = false; });
}

module.exports = {
  tick, supervise, makeLogger, takeLock, releaseLock, INTERVAL_MS, dailyBackup, crashLoopGuard,
  recordResume, settleResumes, spawnEngine, resumeRun, enginePid, engineAlive, alive,
};
