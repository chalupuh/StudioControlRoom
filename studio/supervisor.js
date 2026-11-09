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
// S1:  Team-paused runs are skipped (not resumed).
// S2:  Crash-loop guard blocks after 3 resumes/h with no cursor change; concurrency cap at MACHINE.gpu.llmSlots || 2.
// S4:  engineAlive matches runId as a whole token; alive verifies PID command line.
// S5:  spawnEngine uses cwd, appends output to run log, and has an error handler.
// N5:  Single-instance guard via locks/supervisor.lock.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const INTERVAL_MS = 60000;
const MAX_LOG = 5 * 1024 * 1024;
const KEEP = 5;
const RESUMABLE = new Set(['paused', 'running']);
const TEAMS = ['eng', 'rd', 'creative'];
const TEAM_FALLBACK = {
  'rd-manager': 'rd', 'market-researcher': 'rd', 'opportunity-analyst': 'rd',
  'creative-director': 'creative', 'image-artist': 'creative',
  'video-producer': 'creative', 'copy-voice': 'creative', 'ui-ux-designer': 'creative',
};

// S4: alive checks PID and verifies command line contains 'engine.js'
const alive = (pid) => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};

/** S4: verify PID belongs to an engine.js process (Windows CIM query). */
function enginePid(pid, studioProcs) {
  if (!alive(pid)) return false;
  if (!studioProcs) return true; // fallback when procs not available
  return studioProcs.some((p) => p.pid === pid && /engine[\\/]engine\.js/.test(p.cmd));
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

/** S1: Determine the team for an agent (used for team-pause check). */
function teamOf(agent, roster) {
  const t = (roster && roster.agents && roster.agents[agent] || {}).team;
  return TEAMS.includes(t) ? t : (TEAM_FALLBACK[agent] || 'eng');
}

/** S1: Check if a team is paused in the control state. */
function teamPaused(team, control) {
  return control && control.teams && control.teams[team] === 'paused';
}

/** S2: crash-loop history lives next to the lock (locks/<id>.resumes.json) so replacing a stale lock keeps it. */
function resumesFile(lockFile) { return lockFile.replace(/.lock$/, '.resumes.json'); }

function readResumes(lockFile) {
  try { const a = JSON.parse(fs.readFileSync(resumesFile(lockFile), 'utf8')); return Array.isArray(a) ? a : []; } catch { return []; }
}

/** S2: Blocks after 3 resumes within 1 hour with no cursor change. */
function crashLoopGuard(lockFile, runCursor, now = Date.now()) {
  const recent = readResumes(lockFile).filter((t) => t.time > now - 60 * 60 * 1000 && t.cursor === runCursor);
  if (recent.length < 3) return { blocked: false };
  return { blocked: true, reason: 'supervisor: resume loop (3 resumes/1h, no cursor change)' };
}

/** S2: Record a resume attempt (keeps the last 10). */
function recordResume(lockFile, cursor) {
  const list = readResumes(lockFile);
  list.push({ time: Date.now(), cursor });
  fs.writeFileSync(resumesFile(lockFile), JSON.stringify(list.slice(-10)));
}

/** S5: Spawn engine with cwd, log output, and error handler. */
function defaultSpawnEngine(HOME, runId, ctx) {
  const engine = path.join(__dirname, '..', 'engine', 'engine.js');
  const logFile = path.join(HOME, '.studio', 'runs', runId + '.log');
  const logStream = fs.createWriteStream(logFile, { flags: 'a' });
  const child = spawn(process.execPath, [engine, 'resume', runId], {
    cwd: HOME,
    detached: true,
    windowsHide: true,
    env: { ...process.env, STUDIO_HOME: HOME },
  });
  child.stdout.pipe(logStream);
  child.stderr.pipe(logStream);
  child.on('error', (err) => {
    const logger = ctx && ctx.log ? ctx.log : console.error;
    logger(`engine ${runId}: spawn error: ${err.message}`);
  });
  child.unref();
  return child.pid;
}

/**
 * One pass. ctx: { HOME, DIR, getControl, append, log }
 * deps (injectable for tests): startup, spawnEngine(HOME, runId, ctx) -> pid, isAlive(pid),
 *   engineAlive(runId) -> bool, studioProcesses() -> [{pid, cmd}]
 */
function tick(ctx, deps = {}) {
  const { HOME, DIR } = ctx;
  const log = ctx.log || (() => {});
  const control = ctx.getControl ? ctx.getControl() : { state: 'running' };

  // S3: call studioProcesses once per tick
  let studioProcs = null;
  try { studioProcs = require('./power').studioProcesses(); } catch {}

  deps = {
    startup: (c) => require('./power').startup(c),
    spawnEngine: defaultSpawnEngine,
    isAlive: alive,
    engineAlive: (runId) => {
      // S4: match runId as a whole argument token (not substring)
      return studioProcs && studioProcs.some((p) =>
        /engine[\\/]engine\.js/.test(p.cmd) && new RegExp('(?<![\\w.-])' + runId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\w.-])').test(p.cmd));
    },
    ...deps,
  };
  const result = { resumed: [], skipped: [] };

  try { deps.startup({ HOME, DIR, log: (s) => { if (!/still PAUSED/.test(s)) log(s); } }); } catch (e) { log('service check failed: ' + e.message); }

  if (control.state !== 'running') { log('switch is Paused: services only'); return result; }

  // S2: concurrency cap — count live engines
  const MACHINE = deps.MACHINE || (function () { try { return require('./machine').load({ HOME, DIR: path.join(HOME, '.studio') }); } catch { return {}; } })();
  const maxEngines = (MACHINE.gpu && MACHINE.gpu.llmSlots) || 2;
  const liveCount = deps.liveCount !== undefined ? deps.liveCount : studioProcs ? studioProcs.filter((p) => /engine[\\/]engine\.js/.test(p.cmd)).length : 0;

  // Read roster for team-pause checks
  let roster = null;
  try { roster = JSON.parse(fs.readFileSync(path.join(DIR, 'roster.json'), 'utf8')); } catch {}

  const runsDir = path.join(DIR, 'runs');
  const files = fs.existsSync(runsDir) ? fs.readdirSync(runsDir).filter((f) => f.endsWith('.json')) : [];
  for (const f of files) {
    // S2: concurrency cap — stop spawning if at limit
    if (liveCount + result.resumed.length >= maxEngines) {
      log(`concurrency cap reached (${maxEngines}), skipping remaining runs`);
      break;
    }

    let run; try { run = JSON.parse(fs.readFileSync(path.join(runsDir, f), 'utf8')); } catch { continue; }
    const id = run.id || f.replace(/\.json$/, '');
    if (!/^[\w.-]+$/.test(id)) continue;
    if (!RESUMABLE.has(run.status)) { result.skipped.push(id); continue; }

    // S1: team-pause guard — skip run if its current team is paused
    const currentStage = run.stages && run.stages[run.cursor];
    if (currentStage && currentStage.agent) {
      const team = teamOf(currentStage.agent, roster);
      if (teamPaused(team, control)) {
        log(`run ${id}: team '${team}' is paused, skipping`);
        result.skipped.push(id);
        continue;
      }
    }

    if (deps.engineAlive(id)) { log(`run ${id}: engine already live, skipping`); result.skipped.push(id); continue; }
    const lock = path.join(DIR, 'locks', id + '.lock');

    // S2: crash-loop guard
    const cursor = run.cursor || 0;
    const guard = crashLoopGuard(lock, cursor);
    if (guard.blocked) {
      log(`run ${id}: crash-loop blocked (${guard.reason})`);
      result.skipped.push(id);
      // Mark the run as blocked in its JSON
      try {
        run.status = 'blocked';
        run.blockedReason = guard.reason;
        fs.writeFileSync(path.join(runsDir, f), JSON.stringify(run, null, 2));
        ctx.append({ type: 'blocked', agent: 'manager', message: `Supervisor blocked run ${id}: ${guard.reason}`, status: 'blocked' });
      } catch {}
      continue;
    }

    if (!takeLock(lock, deps)) { log(`run ${id}: locked by a live process, skipping`); result.skipped.push(id); continue; }
    try {
      // S2: record this resume attempt for crash-loop tracking
      recordResume(lock, cursor);
      // S5: pass ctx to spawnEngine for logging
      const pid = deps.spawnEngine(HOME, id, ctx);
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

/** Long-running loop with single-instance guard (N5). */
function supervise(ctx) {
  // N5: single-instance guard via supervisor.lock
  const supervisorLock = path.join(ctx.DIR, 'locks', 'supervisor.lock');
  const dir = path.dirname(supervisorLock);
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.writeFileSync(supervisorLock, String(process.pid), { flag: 'wx' });
  } catch (e) {
    if (e.code === 'EEXIST') {
      const existingPid = Number(fs.readFileSync(supervisorLock, 'utf8'));
      if (alive(existingPid)) {
        console.error(`Supervisor already running (pid ${existingPid}). Exiting.`);
        process.exit(1);
      }
      // Stale lock — remove and continue
      try { fs.unlinkSync(supervisorLock); } catch {}
      fs.writeFileSync(supervisorLock, String(process.pid));
    } else {
      throw e;
    }
  }

  const log = makeLogger(ctx.DIR);
  const c = { ...ctx, log };
  log(`supervisor started (pid ${process.pid}, every ${INTERVAL_MS / 1000} s)`);
  const pass = () => {
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
function dailyBackup(ctx, log, opts = {}) {
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
  doBackup({ HOME: ctx.HOME, now })
    .then((dest) => {
      if (dest) log('backup done: ' + dest);
      else log('backup: nothing to back up');
    })
    .catch((e) => { log('backup failed: ' + (e.message || e)); });
}

module.exports = { tick, supervise, makeLogger, takeLock, INTERVAL_MS, dailyBackup, teamOf, teamPaused, crashLoopGuard, recordResume, TEAM_FALLBACK, TEAMS };
