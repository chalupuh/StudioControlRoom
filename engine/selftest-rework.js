#!/usr/bin/env node
// QA/review "rework" loop: an honest VERDICT: FAIL goes back to the build stage (not up the tier ladder);
// 3 FAILs block; a crashed QA (no report) still climbs tiers. Uses a fake agent via engine.hooks.
const fs = require('fs'), os = require('os'), path = require('path');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-rework-'));
process.env.STUDIO_HOME = HOME;
const engine = require('./engine.js');

let fails = 0;
const check = (ok, name) => { console.log(`  ${ok ? '✓' : '✗'} ${name}`); if (!ok) fails++; };
const sl = (p) => p.split(String.fromCharCode(92)).join('/');
fs.mkdirSync(path.join(HOME, '.studio', 'runs'), { recursive: true });
const chk = path.join(HOME, 'chk.js');
fs.writeFileSync(chk, "const f=process.argv[2];process.exit(/VERDICT: PASS/.test(require('fs').readFileSync(f,'utf8'))?0:1)");
const rpath = sl(path.join(HOME, 'qa-1.md'));
const stages = (maxQa) => [
  { id: 'build#1', type: 'agent', agent: 'backend-dev', tier: 'local', task: 'build' },
  { id: 'qa#1', type: 'agent', agent: 'qa-engineer', tier: 'local', task: 'qa', expect: [rpath],
    check: `node "${sl(chk)}" "${rpath}"`, rework: { to: 'build', verdict: rpath, max: maxQa } },
];
const mkRun = (id, maxQa) => ({ id, pipeline: 't', vars: { home: sl(HOME), workdir: sl(HOME) }, stages: stages(maxQa), cursor: 0, gates: {}, history: [], status: 'running' });
const rp = path.join(HOME, 'qa-1.md');

// scripted fake: verdicts[] is consumed by each qa call; 'crash' = no report + error
function fake(verdicts, log) {
  engine.hooks.runAgent = (stage, tier, vars, feedback, note) => {
    log.push({ id: stage.id, tier, note });
    if (stage.id.startsWith('build')) return { tier, model: 'x', secs: 0, result: 'built' };
    const v = verdicts.shift();
    if (v === 'crash') return { tier, model: 'x', secs: 0, result: '', error: 'boom' };
    fs.writeFileSync(rp, `report\nVERDICT: ${v}\n`);
    return { tier, model: 'x', secs: 0, result: 'done' };
  };
}
const quiet = (fn) => { const l = console.log; console.log = () => {}; try { return fn(); } finally { console.log = l; } };

// 1. FAIL then PASS
{
  const log = []; fake(['FAIL', 'PASS'], log);
  const run = mkRun('r1', 3); quiet(() => engine.advance(run));
  check(run.status === 'done', 'FAIL then PASS finishes the run');
  const builds = log.filter((l) => l.id === 'build#1');
  check(builds.length === 2, 'build ran again after the FAIL');
  check(builds[1].note && /Rework round 1: QA\/review FAILED\. Fix every finding in .*qa-1-round1\.md, then update the sprint log\./.test(builds[1].note), 'rework note injected into the build prompt');
  check(builds[0].note === undefined, 'first build has no note');
  check(log.filter((l) => l.id === 'qa#1').every((l) => l.tier === 'local'), 'QA never climbed tiers');
  check(fs.existsSync(path.join(HOME, 'qa-1-round1.md')), 'old report kept as -round1.md');
  const evs = fs.readFileSync(path.join(HOME, '.studio', 'events.jsonl'), 'utf8');
  check(/rework 1\/3: qa#1 FAIL → back to build#1/.test(evs), 'progress event emitted');
  check(run.reworks['qa#1'] === 1, 'rework counter recorded');
}
// 2. straight PASS
{
  const log = []; fake(['PASS'], log);
  const run = mkRun('r2', 3); quiet(() => engine.advance(run));
  check(run.status === 'done' && log.filter((l) => l.id === 'build#1').length === 1 && !run.reworks, 'PASS proceeds without rework');
}
// 3. three FAILs block
{
  const log = []; fake(['FAIL', 'FAIL', 'FAIL', 'PASS'], log);
  const run = mkRun('r3', 3); quiet(() => engine.advance(run));
  check(run.status === 'blocked' && run.blockedReason === 'QA/review failed 3 rework rounds', 'third FAIL blocks with the rework reason');
  check(log.filter((l) => l.id === 'build#1').length === 3, 'build ran 3 times (initial + 2 reworks)');
  check(log.filter((l) => l.id === 'qa#1').length === 3, 'QA not re-run on higher tiers');
}
// 4. crashed QA climbs the ladder
{
  const log = []; fake(['crash', 'crash', 'crash'], log);
  const run = mkRun('r4', 3); quiet(() => engine.advance(run));
  const tiers = log.filter((l) => l.id === 'qa#1').map((l) => l.tier);
  check(tiers.join(',') === 'local,local,codex,sonnet', 'crashed QA climbs local, local, codex, sonnet');
  check(run.status === 'blocked' && /failed on every tier/.test(run.blockedReason) && !run.reworks, 'blocked as a genuine failure, no rework');
}
// 5. no report, clean run -> genuine failure too
{
  engine.hooks.runAgent = (s, tier) => ({ tier, model: 'x', secs: 0, result: 'ok' });
  for (const f of fs.readdirSync(HOME)) if (/^qa-/.test(f)) fs.rmSync(path.join(HOME, f));
  const run = mkRun('r5', 3); quiet(() => engine.advance(run));
  check(run.status === 'blocked' && !run.reworks, 'missing report is not a rework');
}

fs.rmSync(HOME, { recursive: true, force: true });
console.log(fails ? `\n${fails} failed` : '\nrework selftest passed');
process.exit(fails ? 1 : 0);
