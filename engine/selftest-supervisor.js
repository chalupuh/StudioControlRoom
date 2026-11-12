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

(async () => {
const tickMs = () => new Promise((r) => setImmediate(r));

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
  await tickMs();

  // 03:01 → within 60 min of last attempt → skipped (hourly retry guard)
  sup.dailyBackup(mockCtx, (m) => logs.push(m), { now: new Date(2026, 0, 1, 3, 1), backup: mockBackup, localDate: mockLocalDate });
  check('dailyBackup: 03:01 skipped (within 1 h)', !logs.some((m) => /daily backup/.test(m)) && backupCallCount === 1);
  await tickMs();

  // 04:01 → more than 60 min → retry
  sup.dailyBackup(mockCtx, (m) => logs.push(m), { now: new Date(2026, 0, 1, 4, 1), backup: mockBackup, localDate: mockLocalDate });
  check('dailyBackup: 04:01 retried (past 1 h)', logs.some((m) => /daily backup/.test(m)) && backupCallCount === 2);
  logs.length = 0;
  await tickMs();

  // Unconditional same-day dedup: once zip exists, no further attempts that day.
  // Simulate successful backup by creating the zip.
  const todayZip = path.join(bkDir, '2026-01-01.zip');
  fs.writeFileSync(todayZip, 'fake');
  sup.dailyBackup(mockCtx, (m) => logs.push(m), { now: new Date(2026, 0, 1, 10, 0), backup: mockBackup, localDate: mockLocalDate });
  check('dailyBackup: same-day zip exists → dedup unconditionally', !logs.some((m) => /daily backup/.test(m)) && backupCallCount === 2);
  fs.unlinkSync(todayZip);
  await tickMs();

  // N5: a backup still in flight is not started a second time (even past the hourly retry)
  {
    let calls = 0, release;
    const slow = () => { calls++; return new Promise((r) => { release = r; }); };
    const d1 = new Date(2026, 0, 2, 3, 0), d2 = new Date(2026, 0, 2, 5, 0);
    sup.dailyBackup(mockCtx, () => {}, { now: d1, backup: slow, localDate: mockLocalDate });
    sup.dailyBackup(mockCtx, () => {}, { now: d2, backup: slow, localDate: mockLocalDate });
    check('N5: overlapping backup is not started', calls === 1);
    release(null); await tickMs();
  }
}

// ---- extra scenarios, each with its own temp HOME ----
const mk = (runs) => {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'sup-x-'));
  fs.mkdirSync(path.join(h, '.studio', 'runs'), { recursive: true });
  for (const [id, status, agent] of runs) fs.writeFileSync(path.join(h, '.studio', 'runs', id + '.json'), JSON.stringify({ id, status, cursor: 0, stages: [{ agent: agent || 'builder' }] }));
  return { h, d: path.join(h, '.studio'), cx: { HOME: h, DIR: path.join(h, '.studio'), getControl: () => ({ state: 'running' }), append: () => {}, log: () => {} } };
};
const sp = [];
const fakeSpawn = (h, id) => { sp.push(id); return 910000 + sp.length; };
const base = { startup: () => {}, engineAlive: () => false, liveCount: 0, spawnEngine: fakeSpawn };

// S1: the cap is read from the real machine.json (no deps.MACHINE injected)
{
  const t = mk([['a', 'paused'], ['b', 'paused']]);
  fs.writeFileSync(path.join(t.d, 'machine.json'), JSON.stringify({ gpu: { llmSlots: 1 } }));
  sp.length = 0;
  const r = sup.tick(t.cx, { ...base, isAlive: () => false });
  check('S1: llmSlots from machine.json caps resumes (1 of 2)', r.resumed.length === 1 && sp.length === 1);
  fs.rmSync(t.h, { recursive: true, force: true });
}

// S2: pause/resume cycles are not crashes
{
  const t = mk([['p1', 'paused']]);
  let st = 'running';
  const cx = { ...t.cx, getControl: () => ({ state: st }) };
  const d = { ...base, isAlive: () => false };
  for (let i = 0; i < 5; i++) { st = 'running'; sup.tick(cx, d); st = 'paused'; sup.tick(cx, d); }
  const run = JSON.parse(fs.readFileSync(path.join(t.d, 'runs', 'p1.json'), 'utf8'));
  check('S2: 5 resume/Paused cycles do not block the run', run.status === 'paused');
  // an engine that lived > 5 min and then died is not a crash either
  st = 'running';
  for (let i = 0; i < 5; i++) {
    sup.tick(cx, d);
    const f = path.join(t.d, 'locks', 'p1.resumes.json');
    const list = JSON.parse(fs.readFileSync(f, 'utf8')); list[list.length - 1].time -= 10 * 60 * 1000; fs.writeFileSync(f, JSON.stringify(list));
  }
  check('S2: long-lived engines that exit are not counted as crashes', JSON.parse(fs.readFileSync(path.join(t.d, 'runs', 'p1.json'), 'utf8')).status === 'paused');
  fs.rmSync(t.h, { recursive: true, force: true });
}

// S3: a lock held by a live PID that is not an engine (recycled PID) is replaced
{
  const t = mk([['pid1', 'running']]);
  fs.mkdirSync(path.join(t.d, 'locks'), { recursive: true });
  fs.writeFileSync(path.join(t.d, 'locks', 'pid1.lock'), String(process.pid)); // alive, but not an engine
  sp.length = 0;
  const notEngine = [{ pid: process.pid, cmd: 'node some-other-script.js' }];
  const r = sup.tick(t.cx, { startup: () => {}, liveCount: 0, spawnEngine: fakeSpawn, studioProcesses: () => notEngine });
  check('S3: lock whose live PID is not an engine is replaced', r.resumed.join() === 'pid1');
  // ...but a lock held by a real engine process is respected
  fs.writeFileSync(path.join(t.d, 'locks', 'pid1.lock'), String(process.pid));
  sp.length = 0;
  const isEngine = [{ pid: process.pid, cmd: 'node C:\\x\\engine\\engine.js resume other-run' }];
  const r2 = sup.tick(t.cx, { startup: () => {}, liveCount: 0, spawnEngine: fakeSpawn, studioProcesses: () => isEngine });
  check('S3: lock held by a real engine process is kept', r2.resumed.length === 0 && sp.length === 0);
  fs.rmSync(t.h, { recursive: true, force: true });
}

// S3: lock is released when the spawned engine exits
{
  const t = mk([['ex1', 'running']]);
  const EE = require('events');
  const child = Object.assign(new EE(), { pid: 920001 });
  sup.tick(t.cx, { ...base, isAlive: () => false, spawnEngine: () => child });
  const lock = path.join(t.d, 'locks', 'ex1.lock');
  check('S3: lock written with child pid', fs.readFileSync(lock, 'utf8') === '920001');
  child.emit('exit', 0);
  check('S3: lock removed on engine exit', !fs.existsSync(lock));
  fs.rmSync(t.h, { recursive: true, force: true });
}

// S4: dashboard resume: first call spawns, second gets 409
{
  const t = mk([['dash', 'paused']]);
  let n = 0;
  const live = new Set();
  const d = { spawnEngine: () => { n++; live.add(930000 + n); return 930000 + n; }, isAlive: (pid) => live.has(pid), studioProcesses: () => [] };
  const r1 = sup.resumeRun(t.cx, 'dash', d);
  const r2 = sup.resumeRun(t.cx, 'dash', d);
  check('S4: first dashboard resume spawns (200)', r1.code === 200 && n === 1);
  check('S4: second dashboard resume is 409, no second engine', r2.code === 409 && n === 1);
  check('S4: unknown run is 404 and bad id is 400', sup.resumeRun(t.cx, 'nope', d).code === 404 && sup.resumeRun(t.cx, '../x', d).code === 400);
  fs.rmSync(path.join(t.d, 'locks'), { recursive: true, force: true });
  const r3 = sup.resumeRun(t.cx, 'dash', { ...d, studioProcesses: () => [{ pid: 1, cmd: 'node x/engine/engine.js resume dash' }] });
  check('S4: a live engine process for the run (no lock) is 409', r3.code === 409);
  fs.rmSync(t.h, { recursive: true, force: true });
}

// S10: the real spawn path logs through a file descriptor (no supervisor-owned pipe)
await (async () => {
  const t = mk([]);
  const stub = path.join(t.h, 'stub-engine.js');
  fs.writeFileSync(stub, "console.log('stub-out ' + process.argv.slice(2).join(' ')); console.error('stub-err');");
  const child = sup.spawnEngine(t.h, 'logrun', { engine: stub });
  check('S10: stdout/stderr/stdin are not pipes owned by the supervisor', child.stdout === null && child.stderr === null && child.stdin === null);
  const keep = setInterval(() => {}, 1000); // the child is unref'd; keep the loop alive until it exits
  await new Promise((res) => child.on('exit', res)); clearInterval(keep);
  const logTxt = fs.readFileSync(path.join(t.d, 'runs', 'logrun.log'), 'utf8');
  check('S10: engine output reached runs/<id>.log', /stub-out resume logrun/.test(logTxt) && /stub-err/.test(logTxt));
  fs.rmSync(t.h, { recursive: true, force: true });
})();

// N3: supervisor lock: stale-by-heartbeat lock is taken over; a live fresh one is not
{
  const t = mk([]);
  const lf = path.join(t.d, 'locks', 'supervisor.lock');
  check('N3: free lock taken', sup.takeLock(lf, { isAlive: () => true }));
  check('N3: live fresh lock refused', !sup.takeLock(lf, { isAlive: () => true, staleMs: 180000 }));
  const old = new Date(Date.now() - 10 * 60 * 1000); fs.utimesSync(lf, old, old);
  check('N3: lock not touched for 10 min is stale even if PID is alive', sup.takeLock(lf, { isAlive: () => true, staleMs: 180000 }));
  fs.rmSync(t.h, { recursive: true, force: true });
}

// N2: shared team mapping
{
  const teams = require('../studio/teams');
  check('N2: roster team wins (custom team ok), fallback, default', teams.teamOf('x', { agents: { x: { team: 'ops' } } }) === 'ops' && teams.teamOf('image-artist', null) === 'creative' && teams.teamOf('zzz', null) === 'eng');
}

// Server probe (replaces the bare server.pid check): any HTTP answer is "up"
await (async () => {
  const power = require('../studio/power');
  const srv = require('http').createServer((q, r) => { r.statusCode = 401; r.end('no'); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  check('server probe: HTTP 401 counts as up', (await power.probeServer('127.0.0.1', port)) === true);
  await new Promise((r) => srv.close(r));
  check('server probe: nothing listening is down', (await power.probeServer('127.0.0.1', port, 500)) === false);
})();

fs.rmSync(HOME, { recursive: true, force: true });
if (fail) { console.error(`${fail} failed`); process.exit(1); }
console.log('supervisor selftest passed');
})().catch((e) => { console.error(e); process.exit(1); });
