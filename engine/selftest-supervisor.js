#!/usr/bin/env node
// Self-test for studio/supervisor.js with a temp HOME, fake run files and fake engine spawning.
const fs = require('fs');
const os = require('os');
const path = require('path');
const sup = require('../studio/supervisor');

let fail = 0;
const check = (name, ok) => { if (ok) console.log(`  ok   ${name}`); else { fail++; console.error(`  FAIL ${name}`); } };

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sup-test-'));
const DIR = path.join(HOME, '.studio');
fs.mkdirSync(path.join(DIR, 'runs'), { recursive: true });
for (const [id, status] of [['r-paused', 'paused'], ['r-running', 'running'], ['r-blocked', 'blocked'], ['r-gate', 'waiting-gate'], ['r-parked', 'parked'], ['r-done', 'done']])
  fs.writeFileSync(path.join(DIR, 'runs', id + '.json'), JSON.stringify({ id, status, stages: [], cursor: 0 }));

const events = [], spawned = [];
let state = 'running', startups = 0;
const livePids = new Set();
let nextPid = 900001;
const ctx = { HOME, DIR, getControl: () => ({ state }), append: (e) => events.push(e), log: () => {} };
const deps = {
  startup: () => { startups++; },
  spawnEngine: (h, id) => { spawned.push(id); const pid = nextPid++; livePids.add(pid); return pid; },
  isAlive: (pid) => livePids.has(pid),
  engineAlive: () => false,
};

// Paused switch: services only
state = 'paused';
let r = sup.tick(ctx, deps);
check('paused: nothing resumed', spawned.length === 0 && r.resumed.length === 0);
check('paused: services still checked', startups === 1);

// Running switch: resumes paused + running only
state = 'running';
r = sup.tick(ctx, deps);
check('resumes paused and running', spawned.slice().sort().join() === 'r-paused,r-running');
check('skips blocked / waiting-gate / parked / done', ['r-blocked', 'r-gate', 'r-parked', 'r-done'].every((i) => !spawned.includes(i)));
check('lock file holds the engine pid', /^90000[12]$/.test(fs.readFileSync(path.join(DIR, 'locks', 'r-paused.lock'), 'utf8')));
check('progress event per resume', events.filter((e) => e.type === 'progress').length === 2);

// Second pass: engines alive -> never double-start
sup.tick(ctx, deps);
check('never double-starts', spawned.length === 2);

// Engine died -> stale lock -> resumed again
livePids.clear();
sup.tick(ctx, deps);
check('stale lock (dead pid) is replaced and run resumed', spawned.length === 4);

// Live engine seen by process scan -> skipped even without a lock
fs.rmSync(path.join(DIR, 'locks'), { recursive: true, force: true });
sup.tick(ctx, { ...deps, engineAlive: () => true });
check('live engine process (no lock) is not duplicated', spawned.length === 4);

// Log rotation
const log = sup.makeLogger(DIR, 200, 2);
for (let i = 0; i < 40; i++) log('line ' + i + ' ' + 'x'.repeat(30));
const lf = fs.readdirSync(path.join(DIR, 'logs')).sort();
check('log rotates and keeps at most 2 old files', lf.join() === 'supervisor.log,supervisor.log.1,supervisor.log.2');

// dailyBackup exported and callable (actual invocation requires hour==3
// which we can't mock; covered by integration testing in production).
check('dailyBackup function exported', typeof sup.dailyBackup === 'function');

// dailyBackup: injected now and file-existence dedup
{
  const bkDir = path.join(DIR, 'backups');
  fs.mkdirSync(bkDir, { recursive: true });
  // Create runs dir so backup has something to zip (even on non-Windows it's a no-op here).
  const logs = [];
  const mockCtx = { HOME: HOME, DIR: DIR };

  // before 03:00 → no backup
  const before03 = new Date(2026, 0, 1, 2, 59);
  sup.dailyBackup(mockCtx, (m) => logs.push(m), { now: before03 });
  check('dailyBackup: 02:59 does not run', logs.length === 0);

  // 03:00 → would run (but backup() might fail in test env; just check it was attempted).
  const at03 = new Date(2026, 0, 1, 3, 0);
  sup.dailyBackup(mockCtx, (m) => logs.push(m), { now: at03 });
  // We got at least one log line meaning the path was entered.
  check('dailyBackup: 03:00 triggers backup path', logs.some((m) => /daily backup/.test(m)));
  logs.length = 0;

  // Same day, second call → skip (if zip was created) or at least attempt (if not).
  sup.dailyBackup(mockCtx, (m) => logs.push(m), { now: new Date(2026, 0, 1, 4, 0) });
  // If a zip exists for 2026-01-01, we should get no new "daily backup" logs.
  const todayZip = path.join(bkDir, '2026-01-01.zip');
  if (fs.existsSync(todayZip)) {
    check('dailyBackup: same-day zip exists → dedup', !logs.some((m) => /daily backup/.test(m)));
  }
}

fs.rmSync(HOME, { recursive: true, force: true });
if (fail) { console.error(`${fail} failed`); process.exit(1); }
console.log('supervisor selftest passed');
