#!/usr/bin/env node
// Finalize turn on a QA turn cap, and the local-server check (a down Ollama is skipped, not a failed attempt).
const fs = require('fs'), os = require('os'), path = require('path');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-finalize-'));
process.env.STUDIO_HOME = HOME;
const engine = require('./engine.js');
// QA stages skip the codex tier on win32 (codex sandbox spawn EPERM).
const WIN = process.platform === 'win32';

let fails = 0;
const check = (ok, name) => { console.log(`  ${ok ? '✓' : '✗'} ${name}`); if (!ok) fails++; };
const sl = (p) => p.split(String.fromCharCode(92)).join('/');
fs.mkdirSync(path.join(HOME, '.studio', 'runs'), { recursive: true });
const rp = path.join(HOME, 'qa-1.md');
const chk = path.join(HOME, 'chk.js');
fs.writeFileSync(chk, "process.exit(/VERDICT: PASS/.test(require('fs').readFileSync(process.argv[2],'utf8'))?0:1)");
const qaStage = (extra = {}) => ({ id: 'qa#1', type: 'agent', agent: 'qa-engineer', tier: 'local', task: 'qa', maxTurns: 40,
  expect: [sl(rp)], check: `node "${sl(chk)}" "${sl(rp)}"`, ...extra });
const mkRun = (id, stage) => ({ id, pipeline: 't', vars: { home: sl(HOME), workdir: sl(HOME) }, stages: [stage], cursor: 0, gates: {}, history: [], status: 'running' });
const quiet = (fn) => { const l = console.log; console.log = () => {}; try { return fn(); } finally { console.log = l; } };
const reset = () => { try { fs.unlinkSync(rp); } catch {} };

// 1. turn cap → finalize resumes the same session on the same tier and the stage passes
{
  reset(); const calls = [];
  engine.hooks.localReady = () => true;
  engine.hooks.runAgent = (stage, tier, vars, fb, note, opts = {}) => {
    calls.push({ tier, opts });
    if (!opts.resume) return { tier, model: 'x', secs: 10, turns: 41, result: '', error: 'error_max_turns', hitTurnCap: true, sessionId: 'sess-1' };
    fs.writeFileSync(rp, 'report\nVERDICT: PASS\n');
    return { tier, model: 'x', secs: 2, turns: 3, result: 'written' };
  };
  const run = mkRun('f1', qaStage()); quiet(() => engine.advance(run));
  check(run.status === 'done', 'stage passes after the finalize turn');
  check(calls.length === 2 && calls[1].opts.resume === 'sess-1' && calls[1].tier === 'local', 'finalize resumes the same session on the local tier');
  check(calls[1].opts.maxTurns <= 10 && /turn budget is used up/i.test(calls[1].opts.prompt) && calls[1].opts.prompt.includes(sl(rp)), 'finalize prompt is short and names the report path');
  check(run.history.some((h) => h.type === 'finalize'), 'finalize recorded in history');
  const ok = run.history.find((h) => h.ok === true && h.stage === 'qa#1' && h.attempt);
  check(ok && ok.turns === 44 && ok.secs === 12 && ok.finalized, 'turns and seconds are summed');
}

// 2. no session id (timeout) → no finalize, normal ladder
{
  reset(); const calls = [];
  engine.hooks.runAgent = (stage, tier, vars, fb, note, opts = {}) => {
    calls.push({ tier, opts });
    if (tier === 'sonnet') { fs.writeFileSync(rp, 'VERDICT: PASS\n'); return { tier, model: 's', secs: 1, turns: 5, result: 'ok' }; }
    return { tier, model: 'x', secs: 1, result: '', error: 'ETIMEDOUT', hitTurnCap: false, sessionId: null };
  };
  const run = mkRun('f2', qaStage()); quiet(() => engine.advance(run));
  check(run.status === 'done' && calls.every((c) => !c.opts.resume), 'no finalize without a session');
  check(calls.map((c) => c.tier).join() === (WIN ? 'local,local,sonnet' : 'local,local,codex,sonnet'), 'ladder unchanged');
}

// 3. build stages never finalize (they must change code, not write a report)
{
  const calls = [];
  engine.hooks.runAgent = (stage, tier, vars, fb, note, opts = {}) => { calls.push(opts); return { tier, model: 'x', secs: 1, result: '', error: 'error_max_turns', hitTurnCap: true, sessionId: 's' }; };
  const run = mkRun('f3', { id: 'build#1', type: 'agent', agent: 'mobile-dev', tier: 'local', task: 'b', expect: [sl(rp)] });
  quiet(() => engine.advance(run));
  check(calls.every((o) => !o.resume), 'build stage is not finalized');
}

// 4. local server down → local tiers skipped without counting an attempt, server checked once
{
  reset(); const calls = []; let checks = 0;
  engine.hooks.localReady = () => { checks++; return false; };
  engine.hooks.runAgent = (stage, tier) => { calls.push(tier); fs.writeFileSync(rp, 'VERDICT: PASS\n'); return { tier, model: 's', secs: 1, turns: 5, result: 'ok' }; };
  const run = mkRun('f4', qaStage()); quiet(() => engine.advance(run));
  check(calls.join() === (WIN ? 'sonnet' : 'codex') && run.status === 'done', 'only the cloud tier ran (first cloud tier)');
  check(checks === 1, 'server checked once per stage');
  check(run.history.filter((h) => h.type === 'local-down').length === 1 && !run.history.some((h) => h.ok === false), 'one local-down note, no failed attempt recorded');
}

// 5. parseRunOutput carries the session id
{
  const p = engine.parseRunOutput({ stdout: JSON.stringify({ subtype: 'error_max_turns', session_id: 'abc', num_turns: 41 }), stderr: '', status: 1 });
  check(p.sessionId === 'abc' && p.hitTurnCap, 'session id parsed from CLI output');
}

fs.rmSync(HOME, { recursive: true, force: true });
if (fails) { console.error(`${fails} finalize test(s) failed`); process.exit(1); }
console.log('finalize tests passed');
