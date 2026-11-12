#!/usr/bin/env node
// Engine fixes 2026-11-08:
//   A. reworkTarget: an unsuffixed stage (sprint-wide "review") reworks the LAST build stage, not build#1.
//   B. A CLI error printed as the result ("API Error: ...", output-token limit) is a failed attempt that climbs tiers.
//   C. Verdict regexes tolerate markdown: **REQUEST CHANGES**, **APPROVE**, **VERDICT:** FAIL.
// Optional: ENGINE_PIPES=<dir with pipeline *.json> also runs every real pipeline's review/QA checks and
// failRegex against bold and plain sample reports (through the real shell, as the engine does).
const fs = require('fs'), os = require('os'), path = require('path');
const { spawnSync } = require('child_process');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-verdicts-'));
process.env.STUDIO_HOME = HOME;
const engine = require('./engine.js');
engine.hooks.localReady = () => true; // no real Ollama check in tests

let fails = 0;
const check = (ok, name) => { console.log(`  ${ok ? '✓' : '✗'} ${name}`); if (!ok) fails++; };
const sl = (p) => p.split(String.fromCharCode(92)).join('/');
const quiet = (fn) => { const l = console.log; console.log = () => {}; try { return fn(); } finally { console.log = l; } };
fs.mkdirSync(path.join(HOME, '.studio', 'runs'), { recursive: true });

// The canonical patterns the HQ pipelines use (keep in sync with tools/engine/pipelines/*.json).
const REVIEW_FAIL = 'REQUEST CHANGES[\\s*_`]*$';
const approveOk = (txt) => /\bAPPROVE$/.test(txt.trim().split('\n').pop().replace(/[\s*_\x60]+/g, ' ').trim());
const qaPass = (txt) => /VERDICT:[\s*_\x60]*PASS/.test(txt);

// ---- A. rework target ----
console.log('reworkTarget');
{
  const st = ['build#1', 'qa#1', 'build#2', 'qa#2', 'build#3', 'qa#3', 'review'].map((id) => ({ id }));
  check(engine.reworkTarget(st, 6, 'build', '') === 4, 'unsuffixed review → last build (build#3)');
  check(engine.reworkTarget(st, 3, 'build', '#2') === 2, 'qa#2 → build#2');
  check(engine.reworkTarget(st, 1, 'build', '#1') === 0, 'qa#1 → build#1');
  check(engine.reworkTarget([{ id: 'build' }, { id: 'review' }], 1, 'build', '') === 0, 'plain "build" matched');
  check(engine.reworkTarget([{ id: 'builder' }, { id: 'review' }], 1, 'build', '') === -1, '"builder" is not "build"');
  check(engine.reworkTarget(st, 0, 'build', '') === -1, 'nothing before the cursor → -1');
}
// end-to-end: foreach-style stages + a sprint-wide review that requests changes once
{
  const rpath = sl(path.join(HOME, 'review.md'));
  const stages = [
    { id: 'build#1', type: 'agent', agent: 'backend-dev', tier: 'local', task: 'b1' },
    { id: 'build#2', type: 'agent', agent: 'backend-dev', tier: 'local', task: 'b2' },
    { id: 'review', type: 'agent', agent: 'code-reviewer', tier: 'opus', task: 'r', expect: [rpath],
      rework: { to: 'build', verdict: rpath, failRegex: REVIEW_FAIL, max: 3 } },
  ];
  const verdicts = ['**REQUEST CHANGES**', '**APPROVE**'], log = [];
  engine.hooks.runAgent = (stage, tier) => {
    log.push(stage.id);
    if (stage.id === 'review') fs.writeFileSync(rpath, `findings\n\n${verdicts.shift()}\n`);
    return { tier, model: 'x', secs: 0, result: 'ok' };
  };
  const run = { id: 'v1', pipeline: 't', vars: { home: sl(HOME) }, stages, cursor: 0, gates: {}, history: [], status: 'running' };
  quiet(() => engine.advance(run));
  check(run.status === 'done', 'bold REQUEST CHANGES then bold APPROVE finishes');
  check(log.join(',') === 'build#1,build#2,review,build#2,review', `review rework re-ran build#2 only (got ${log.join(',')})`);
}

// ---- B. CLI errors as results ----
console.log('CLI error results');
{
  const j = (o) => JSON.stringify(o) + '\n';
  const msg = "API Error: Claude's response exceeded the 32000 output token maximum. To configure this behavior, set the CLAUDE_CODE_MAX_OUTPUT_TOKENS environment variable.";
  let r = engine.parseRunOutput({ status: 0, stdout: j({ result: msg, num_turns: 4, is_error: false }), stderr: '' });
  check(!!r.error && /API Error/.test(r.error), 'API Error result (is_error false, exit 0) → error');
  r = engine.parseRunOutput({ status: 1, stdout: j({ result: msg, num_turns: 4, is_error: true }), stderr: '' });
  check(!!r.error, 'API Error result with is_error → error');
  r = engine.parseRunOutput({ status: 0, stdout: j({ result: "Claude's response exceeded the 32000 output token maximum.", is_error: false }), stderr: '' });
  check(!!r.error, 'bare output-token-limit message → error');
  r = engine.parseRunOutput({ status: 0, stdout: j({ result: 'Done. Fixed the API Error: handling in parseRunOutput.' + ' x'.repeat(10), is_error: false }), stderr: '' });
  check(r.error === null, 'normal answer mentioning "API Error:" mid-text → no error');
  r = engine.parseRunOutput({ status: 0, stdout: j({ result: 'Report: ' + 'y'.repeat(600) + ' the 32000 output token maximum was exceeded the 32000 output token maximum', is_error: false }), stderr: '' });
  check(r.error === null, 'long report merely mentioning the token limit → no error');

  // end-to-end: the attempt fails and climbs local → local → codex → sonnet
  const out = sl(path.join(HOME, 'out.md'));
  const tiers = [];
  engine.hooks.runAgent = (stage, tier) => {
    tiers.push(tier);
    if (tier === 'sonnet') { fs.writeFileSync(out, 'ok'); return { tier, model: 'x', secs: 0, result: 'done', error: null }; }
    return { tier, model: 'x', secs: 0, ...engine.parseRunOutput({ status: 0, stdout: j({ result: msg, is_error: false }), stderr: '' }) };
  };
  const run = { id: 'v2', pipeline: 't', vars: { home: sl(HOME) }, stages: [{ id: 'write', type: 'agent', agent: 'product-manager', tier: 'local', task: 't', expect: [out] }], cursor: 0, gates: {}, history: [], status: 'running' };
  quiet(() => engine.advance(run));
  check(tiers.join(',') === 'local,local,codex,sonnet', `API Error climbs the ladder (got ${tiers.join(',')})`);
  check(run.history[0].ok === false && /run error: API Error/.test(run.history[0].problems[0] || ''), 'API Error attempt recorded ok:false with the error');
  check(run.status === 'done', 'run finishes once a tier succeeds');
}

// ---- C. bold-tolerant verdict regexes ----
console.log('verdict regexes');
{
  const fail = (t) => new RegExp(REVIEW_FAIL).test(t);
  for (const v of ['REQUEST CHANGES', '**REQUEST CHANGES**', '__REQUEST CHANGES__', '`REQUEST CHANGES`', '**REQUEST CHANGES** \n\n', 'Verdict: *REQUEST CHANGES*\r\n'])
    check(fail(`# Review\nstuff\n${v}`), `failRegex matches ${JSON.stringify(v)}`);
  check(!fail('# Review\nREQUEST CHANGES was considered\n\n**APPROVE**'), 'failRegex ignores REQUEST CHANGES before the final line');
  for (const v of ['APPROVE', '**APPROVE**', '__APPROVE__', '`APPROVE`', 'Verdict: **APPROVE**', '**Verdict: APPROVE**  \r\n\n'])
    check(approveOk(`# Review\nstuff\n${v}`), `APPROVE check accepts ${JSON.stringify(v)}`);
  for (const v of ['**REQUEST CHANGES**', 'APPROVES', 'APPROVE\nbut one more thing', 'NOAPPROVE'])
    check(!approveOk(`# Review\n${v}`), `APPROVE check rejects ${JSON.stringify(v)}`);
  const qaFail = (t) => new RegExp(engine.DEFAULT_FAIL_REGEX).test(t);
  for (const v of ['VERDICT: FAIL', '**VERDICT:** FAIL', 'VERDICT: **FAIL**', '`VERDICT: FAIL`'])
    check(qaFail(v) && !qaPass(v), `QA FAIL detected in ${JSON.stringify(v)}`);
  for (const v of ['VERDICT: PASS', '**VERDICT:** PASS', 'VERDICT: **PASS**'])
    check(qaPass(v) && !qaFail(v), `QA PASS detected in ${JSON.stringify(v)}`);
}

// ---- optional: real pipelines, real shell ----
if (process.env.ENGINE_PIPES) {
  console.log(`pipelines in ${process.env.ENGINE_PIPES}`);
  const report = sl(path.join(HOME, 'report.md'));
  const walk = (stages, f) => { for (const s of stages || []) { if (s.stages) walk(s.stages, f); else f(s); } };
  const runCheck = (cmd, body) => { fs.writeFileSync(report, body); return spawnSync(cmd, { shell: true, cwd: HOME, encoding: 'utf8' }).status === 0; };
  for (const f of fs.readdirSync(process.env.ENGINE_PIPES).filter((f) => f.endsWith('.json'))) {
    const pipe = JSON.parse(fs.readFileSync(path.join(process.env.ENGINE_PIPES, f), 'utf8'));
    walk(pipe.stages, (s) => {
      const cmd = (s.check || '').replace(/\{\{home\}\}\/[^']+\.md/g, report);
      const isReview = /APPROVE/.test(s.check || ''), isQa = /VERDICT/.test(s.check || '');
      const name = `${f}:${s.id}`;
      if (isReview) {
        check(runCheck(cmd, 'x\n**APPROVE**\n') && runCheck(cmd, 'x\nAPPROVE') && runCheck(cmd, 'x\n__APPROVE__\n') && !runCheck(cmd, 'x\n**REQUEST CHANGES**\n'), `${name} check: bold/plain APPROVE pass, REQUEST CHANGES fails`);
      } else if (isQa) {
        check(runCheck(cmd, 'x\n**VERDICT:** PASS\n') && runCheck(cmd, 'VERDICT: PASS') && !runCheck(cmd, '**VERDICT: FAIL**'), `${name} check: bold/plain PASS pass, FAIL fails`);
      }
      if (s.rework) {
        const re = new RegExp(s.rework.failRegex || engine.DEFAULT_FAIL_REGEX);
        const bad = isReview ? 'x\n**REQUEST CHANGES**\n' : 'x\n**VERDICT:** FAIL\n';
        const good = isReview ? 'x\n**APPROVE**\n' : 'x\n**VERDICT:** PASS\n';
        check(re.test(bad) && !re.test(good), `${name} failRegex: bold FAIL verdict matched, PASS not`);
      }
    });
  }
}

fs.rmSync(HOME, { recursive: true, force: true });
console.log(fails ? `\n${fails} failed` : '\nverdicts selftest passed');
process.exit(fails ? 1 : 0);
