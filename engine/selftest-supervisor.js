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
  liveCount: 0, // ignore real engines on the dev machine
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

// S1: team-paused run is not resumed
{
  const before = spawned.length;
  fs.rmSync(path.join(DIR, 'locks'), { recursive: true, force: true });
  fs.writeFileSync(path.join(DIR, 'roster.json'), JSON.stringify({ agents: { 'image-artist': { team: 'creative' } } }));
  for (const f of fs.readdirSync(path.join(DIR, 'runs'))) fs.unlinkSync(path.join(DIR, 'runs', f));
  fs.writeFileSync(path.join(DIR, 'runs', 'r-team.json'), JSON.stringify({ id: 'r-team', status: 'paused', cursor: 0, stages: [{ agent: 'image-artist' }] }));
  sup.tick({ ...ctx, getControl: () => ({ state: 'running', teams: { creative: 'paused' } }) }, deps);
  check('S1: team-paused run is not resumed', spawned.length === before);
  sup.tick(ctx, deps);
  check('S1: resumed once the team is running', spawned.length === before + 1);
}

// S2: concurrency cap and crash-loop guard
{
  const before = spawned.length;
  fs.rmSync(path.join(DIR, 'locks'), { recursive: true, force: true });
  sup.tick(ctx, { ...deps, liveCount: 2 });
  check('S2: concurrency cap (2 live engines) blocks new resumes', spawned.length === before);
  for (let i = 0; i < 4; i++) { livePids.clear(); sup.tick(ctx, deps); }
  const run = JSON.parse(fs.readFileSync(path.join(DIR, 'runs', 'r-team.json'), 'utf8'));
  check('S2: crash loop (3 resumes, same cursor) blocks the run', run.status === 'blocked' && /resume loop/.test(run.blockedReason));
}

// Log rotation
const log = sup.makeLogger(DIR, 200, 2);
for (let i = 0; i < 40; i++) log('line ' + i + ' ' + 'x'.repeat(30));
const lf = fs.readdirSync(path.join(DIR, 'logs')).sort();
check('log rotates and keeps at most 2 old files', lf.join() === 'supervisor.log,supervisor.log.1,supervisor.log.2');

// dailyBackup: injected now, backup fn, hourly retry guard
{
  const bkDir = path.join(DIR, 'backups');
  fs.mkdirSync(bkDir, { recursive: true });
  const logs = [];
  const mockCtx = { HOME: HOME, DIR: DIR };

  let backupCallCount = 0;
  const mockBackup = () => { backupCallCount++; return Promise.resolve(null); };
  const mockLocalDate = require('../studio/backup').localDate;

  // before 03:00 → no backup
  const before03 = new Date(2026, 0, 1, 2, 59);
  sup.dailyBackup(mockCtx, (m) => logs.push(m), { now: before03, backup: mockBackup, localDate: mockLocalDate });
  check('dailyBackup: 02:59 does not run', logs.length === 0 && backupCallCount === 0);

  // 03:00 → backup triggered
  const at03 = new Date(2026, 0, 1, 3, 0);
  sup.dailyBackup(mockCtx, (m) => logs.push(m), { now: at03, backup: mockBackup, localDate: mockLocalDate });
  check('dailyBackup: 03:00 triggers backup', logs.some((m) => /daily backup/.test(m)) && backupCallCount === 1);
  logs.length = 0;

  // 03:01 → within 60 min of last attempt → skipped (hourly retry guard)
  sup.dailyBackup(mockCtx, (m) => logs.push(m), { now: new Date(2026, 0, 1, 3, 1), backup: mockBackup, localDate: mockLocalDate });
  check('dailyBackup: 03:01 skipped (within 1 h)', !logs.some((m) => /daily backup/.test(m)) && backupCallCount === 1);

  // 04:01 → more than 60 min → retry
  sup.dailyBackup(mockCtx, (m) => logs.push(m), { now: new Date(2026, 0, 1, 4, 1), backup: mockBackup, localDate: mockLocalDate });
  check('dailyBackup: 04:01 retried (past 1 h)', logs.some((m) => /daily backup/.test(m)) && backupCallCount === 2);
  logs.length = 0;

  // Unconditional same-day dedup: once zip exists, no further attempts that day.
  // Simulate successful backup by creating the zip.
  const todayZip = path.join(bkDir, '2026-01-01.zip');
  fs.writeFileSync(todayZip, 'fake');
  sup.dailyBackup(mockCtx, (m) => logs.push(m), { now: new Date(2026, 0, 1, 10, 0), backup: mockBackup, localDate: mockLocalDate });
  check('dailyBackup: same-day zip exists → dedup unconditionally', !logs.some((m) => /daily backup/.test(m)) && backupCallCount === 2);
  fs.unlinkSync(todayZip);
}

fs.rmSync(HOME, { recursive: true, force: true });
if (fail) { console.error(`${fail} failed`); process.exit(1); }
console.log('supervisor selftest passed');
