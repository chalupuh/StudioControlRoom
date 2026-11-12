#!/usr/bin/env node
// Rework-loop regression tests (docs/internal/rework-diagnosis-codex.md, causes 1-5), against a REAL temporary git
// repo: a rework must change the code vs the rejection baseline, QA runs only on a non-empty manifest,
// sprint-wide findings reach one sprint-rework stage, the feedback is structured and kept, and limit errors fail.
const fs = require('fs'), os = require('os'), path = require('path'), { execFileSync } = require('child_process');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-rwbase-home-'));
process.env.STUDIO_HOME = HOME;
const engine = require('./engine.js');
engine.hooks.localReady = () => true;

let fails = 0;
const check = (ok, name) => { console.log(`  ${ok ? '✓' : '✗'} ${name}`); if (!ok) fails++; };
const sl = (p) => p.split(String.fromCharCode(92)).join('/');
const quiet = (fn) => { const l = console.log; console.log = () => {}; try { return fn(); } finally { console.log = l; } };
fs.mkdirSync(path.join(HOME, '.studio', 'runs'), { recursive: true });

function mkRepo(branch) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-rwbase-repo-'));
  const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  git('init', '-q', '-b', branch); git('config', 'user.email', 't@example.com'); git('config', 'user.name', 't');
  fs.writeFileSync(path.join(dir, 'a.js'), 'one\n'); fs.writeFileSync(path.join(dir, 'b.js'), 'one\n');
  git('add', '-A'); git('commit', '-qm', 'init');
  return { dir: sl(dir), git, head: () => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim() };
}
const REPORT = (verdict) => `# QA\n## Blocker\n- a.js:10 input is not validated (task 1)\n## Should fix\n- b.js:5 wrong status code (task 2)\n- B7 extra case in b.js:9 is untested\nVERDICT: ${verdict}\n`;
const rpath = sl(path.join(HOME, 'qa-1.md'));
const stagesOf = () => [
  { id: 'build#1', type: 'agent', agent: 'backend-dev', tier: 'local', task: 'build the thing', maxTurns: 60 },
  { id: 'qa#1', type: 'agent', agent: 'qa-engineer', tier: 'local', task: 'qa', expect: [rpath], rework: { to: 'build', verdict: rpath, max: 3 } },
];
const mkRun = (id, repo, stages = stagesOf()) => ({ id, pipeline: 't', vars: { home: sl(HOME), workdir: repo.dir }, stages, cursor: 0, gates: {}, history: [], status: 'running' });

// scripted agents: qaVerdicts consumed per QA call; onBuild(call#, repo, tier) performs the builder's work
function fake(repo, qaVerdicts, onBuild, log) {
  engine.hooks.runAgent = (stage, tier, vars, feedback, note, opts) => {
    log.push({ id: stage.id, tier, note, opts });
    if (stage.id.startsWith('build')) {
      const n = log.filter((l) => l.id === stage.id).length;
      const extra = onBuild(n, repo, tier, stage) || {};
      return { tier, model: 'x', secs: 0, result: 'built', ...extra };
    }
    fs.writeFileSync(rpath, REPORT(qaVerdicts.shift()));
    return { tier, model: 'x', secs: 0, result: 'qa done' };
  };
}
const edit = (repo, file = 'a.js') => fs.appendFileSync(path.join(repo.dir, file), 'fix ' + Math.random() + '\n');
const commitAll = (repo, msg = 'fix') => { repo.git('add', '-A'); repo.git('commit', '-qm', msg); };
const cleanReport = () => { for (const f of fs.readdirSync(HOME)) if (/^qa-/.test(f)) fs.rmSync(path.join(HOME, f)); };

// ---- cause 1: a no-op "successful" rework builder is rejected, QA does not run ----
{
  cleanReport(); const repo = mkRepo('lane'); const log = [];
  // first build commits (initial work); every rework build claims ok without touching the repo
  fake(repo, ['FAIL', 'PASS'], (n, r) => { if (n === 1) { edit(r); commitAll(r); } }, log);
  const run = mkRun('b1', repo); quiet(() => engine.advance(run));
  const builds = log.filter((l) => l.id === 'build#1'), qas = log.filter((l) => l.id === 'qa#1');
  check(run.status === 'blocked' && /build#1 failed on every tier/.test(run.blockedReason), 'no-op rework builder fails on every tier (blocked)');
  check(builds.length === 4 && qas.length === 1, 'QA does not run again after a no-op rework');
  const h = run.history.filter((x) => x.stage === 'build#1' && x.attempt);
  check(/made no change since the rejection baseline/.test(h[h.length - 1].problems.join()), 'problem names the baseline');
  check(run.reworkRecords[0].status === 'pending', 'record stays pending');
}
// ---- cause 1: uncommitted edit in a lane worktree is not enough (HEAD must advance) ----
{
  cleanReport(); const repo = mkRepo('lane'); const log = [];
  fake(repo, ['FAIL', 'PASS'], (n, r) => { if (n === 1) { edit(r); commitAll(r); } else edit(r); }, log);
  const run = mkRun('b2', repo); quiet(() => engine.advance(run));
  check(run.status === 'blocked' && log.filter((l) => l.id === 'qa#1').length === 1, 'uncommitted rework in a lane worktree is rejected');
  const h = run.history.filter((x) => x.stage === 'build#1' && x.rework);
  check(h.length > 0 && /did not commit/.test(h[0].problems.join()), 'problem says it must commit');
}
// ---- cause 1+2+4: committed rework passes; history, manifest, prompt, record ----
{
  cleanReport(); const repo = mkRepo('lane'); const log = [];
  let head0;
  fake(repo, ['FAIL', 'PASS'], (n, r) => { if (n === 1) { edit(r); commitAll(r); head0 = r.head(); } else { edit(r, 'b.js'); commitAll(r); } }, log);
  const run = mkRun('b3', repo); quiet(() => engine.advance(run));
  check(run.status === 'done', 'committed rework then QA PASS finishes the run');
  const rw = run.history.find((x) => x.stage === 'build#1' && x.rework && x.ok);
  check(rw && rw.rework.beforeHead === head0 && rw.rework.afterHead === repo.head() && rw.rework.afterHead !== head0, 'history records beforeHead/afterHead');
  check(rw && rw.rework.changedPaths.join() === 'b.js', 'history records changed paths');
  const note = log.filter((l) => l.id === 'build#1')[1].note;
  check(/qa-1-round1\.md/.test(note) && /sha256 [0-9a-f]{9}/.test(note) && note.includes(head0.slice(0, 9)), 'builder prompt has round path, sha and baseline');
  check(['F1', 'F2', 'B7'].every((id) => note.includes(id)) && /a\.js:10/.test(note) && /edits for the checklist FIRST/.test(note), 'builder prompt has every finding ID and the edits-first rule');
  check(log.filter((l) => l.id === 'build#1')[1].opts.rework === true && log.filter((l) => l.id === 'build#1')[1].opts.maxTurns === 30, 'rework uses the tighter turn cap');
  const qaNote = log.filter((l) => l.id === 'qa#1')[1].note;
  check(qaNote && /b\.js/.test(qaNote) && !/a\.js\n/.test(qaNote) && ['F1', 'F2', 'B7'].every((id) => qaNote.includes(id)), 'QA prompt carries the manifest and finding IDs');
  check(log.filter((l) => l.id === 'qa#1')[0].note === undefined, 'first QA has no rework note');
  const rec = run.reworkRecords[0];
  check(rec.status === 'consumed' && rec.findings.length === 3 && /^[0-9a-f]{64}$/.test(rec.reportSha256) && rec.baseline.head === head0 && rec.changedPaths.join() === 'b.js', 'record kept (consumed) with sha256, baseline, findings, changed paths');
  check(rec.findings.map((f) => f.id).join() === 'F1,F2,B7', 'finding IDs extracted (explicit ones kept)');
}
// ---- cause 1: on main the engine does not require a commit; a working-tree edit counts ----
{
  cleanReport(); const repo = mkRepo('main'); const log = [];
  fake(repo, ['FAIL', 'PASS'], (n, r) => edit(r), log);
  const run = mkRun('b4', repo); quiet(() => engine.advance(run));
  check(run.status === 'done', 'on main an uncommitted edit satisfies the baseline check');
}
// ---- cause 2: QA is blocked when nothing changed since the baseline ----
{
  cleanReport(); const repo = mkRepo('lane'); const log = [];
  fake(repo, ['PASS'], () => {}, log);
  const run = mkRun('b5', repo);
  const baseline = engine.gitState(repo.dir);
  run.cursor = 1;
  run.reworkRecords = [{ id: 'qa#1:1', round: 1, max: 3, rejectedBy: 'qa#1', target: 'build#1', status: 'built', report: rpath, verdictReport: rpath, reportSha256: 'x', findings: [], baseline }];
  quiet(() => engine.advance(run));
  check(run.status === 'blocked' && /no rework diff to verify/.test(run.blockedReason) && log.length === 0 && run.history.some((h) => h.type === 'rework-empty-manifest'), 'empty manifest blocks QA before any model call');
  check(run.reworkRecords[0].status === 'pending' && run.cursor === 0, 'S4: block marks the record pending and moves the cursor back to the rework builder');
  // resume: the rework builder re-runs (and edits), then QA runs with the manifest
  run.status = 'running'; delete run.blockedReason; cleanReport();
  fake(repo, ['PASS'], (n, r) => { edit(r, 'a.js'); commitAll(r); }, log);
  quiet(() => engine.advance(run));
  check(run.status === 'done' && log[0].id === 'build#1' && /a\.js/.test(log[1].note), 'S4: resume re-runs the builder, then QA is told the manifest');
}
// ---- cause 3: sprint-wide review reaches ONE sprint-rework stage that owns every task's findings ----
{
  cleanReport(); const repo = mkRepo('lane'); const log = [];
  const vr = sl(path.join(HOME, 'review.md'));
  const stages = [
    { id: 'build#1', type: 'agent', agent: 'backend-dev', tier: 'local', task: 't1' }, { id: 'build#2', type: 'agent', agent: 'backend-dev', tier: 'local', task: 't2' },
    { id: 'sprint-rework', type: 'agent', agent: 'backend-dev', tier: 'local', task: 'own all findings', mustChange: true, onlyOnRework: true },
    { id: 'review', type: 'agent', agent: 'code-reviewer', tier: 'opus', task: 'review', expect: [vr], rework: { to: 'sprint-rework', verdict: vr, max: 3, failRegex: 'REQUEST CHANGES' } },
  ];
  const verdicts = ['REQUEST CHANGES', 'APPROVE'];
  engine.hooks.runAgent = (stage, tier, vars, fb, note, opts) => {
    log.push({ id: stage.id, note });
    if (stage.id === 'review') { fs.writeFileSync(vr, `## Blocker\n- a.js:3 task 1 forgot validation\n- b.js:8 task 2 leaks the token\n${verdicts.shift()}\n`); return { tier, model: 'x', secs: 0, result: 'r' }; }
    edit(repo, stage.id === 'build#2' ? 'b.js' : 'a.js'); commitAll(repo);
    return { tier, model: 'x', secs: 0, result: 'ok' };
  };
  const run = mkRun('b6', repo, stages); quiet(() => engine.advance(run));
  const ids = log.map((l) => l.id);
  check(run.status === 'done', 'sprint with a rejected review completes after the sprint-rework');
  check(ids.join() === 'build#1,build#2,review,sprint-rework,review', 'sprint-rework is skipped on the first pass and runs once after the rejection');
  const note = log.find((l) => l.id === 'sprint-rework').note;
  check(/a\.js:3/.test(note) && /b\.js:8/.test(note), 'sprint-rework gets the findings of both tasks');
  check(!log.filter((l) => l.id.startsWith('build')).some((l) => l.note), 'task builders are not handed the sprint findings');
  check(run.history.some((h) => h.stage === 'sprint-rework' && h.type === 'skipped'), 'skip recorded in history');
}
// ---- cause 5: a capped rework escalates (skips the second local try) and never reaches QA ----
{
  cleanReport(); const repo = mkRepo('lane'); const log = [];
  fake(repo, ['FAIL', 'PASS'], (n, r, tier) => {
    if (n === 1) { edit(r); commitAll(r); return {}; }
    edit(r, 'b.js'); commitAll(r); // even with a real commit, a capped run is not accepted
    return tier === 'local' ? { hitTurnCap: true, result: 'partial prose' } : {};
  }, log);
  const run = mkRun('b7', repo); quiet(() => engine.advance(run));
  const tiers = log.filter((l) => l.id === 'build#1').map((l) => l.tier);
  check(tiers.join() === 'local,local,sonnet', 'initial build, one capped local rework, then straight to sonnet (no second local try): ' + tiers.join());
  const bl = log.filter((l) => l.id === 'build#1');
  check(bl[1].opts.maxTurns === 30 && bl[2].tier === 'sonnet' && bl[2].opts.rework === true && bl[2].opts.maxTurns === undefined, 'N1: 30-turn rework cap on local only, cloud tier uses the stage maxTurns');
  const q = log.filter((l) => l.id === 'qa#1');
  check(q.length === 2 && run.status === 'done', 'QA only runs after the escalated rework produced an accepted result');
}
// ---- cause 5: context/output-limit results are hard failures, never ok ----
{
  const j = (o) => JSON.stringify(o);
  const strings = [
    "API Error: Claude's response exceeded the 32000 output token maximum. Set CLAUDE_CODE_MAX_OUTPUT_TOKENS.",
    "Claude's response exceeded the 32000 output token maximum.",
    'Prompt is too long',
    'Error: maximum context length is 32768 tokens, however you requested 40000 tokens',
    'input length and `max_tokens` exceed context limit: 31000 + 8192 > 32768',
    'The context window was exceeded; request too large',
    'context_length_exceeded',
    'Conversation is too long to continue',
  ];
  for (const s of strings) {
    const r = engine.parseRunOutput({ status: 1, stdout: j({ result: s, is_error: true }), stderr: '' });
    check(!!r.error && !r.hitTurnCap, `limit text on a failed run is an error: ${s.slice(0, 45)}`);
  }
  // S1: the old unconditional phrase still errors on a "successful" run; broader phrases need a failed run
  check(!!engine.parseRunOutput({ status: 0, stdout: j({ result: "Claude's response exceeded the 32000 output token maximum.", is_error: false }), stderr: '' }).error, 'exceeded-N-output-token-maximum is an error even with ok:true');
  for (const ok of ["Added 'prompt too long' handling to the limit regex.", 'Fixed the request too large path; context window exceeded case now retried.', 'Raised the output token limit docs.']) {
    check(!engine.parseRunOutput({ status: 0, stdout: j({ result: ok, is_error: false }), stderr: '' }).error, 'short success mentioning a limit phrase is NOT an error: ' + ok.slice(0, 40));
  }
  const long = engine.parseRunOutput({ status: 0, stdout: j({ result: 'Report: ' + 'x'.repeat(700) + ' prompt is too long', is_error: false }), stderr: '' });
  check(!long.error, 'a long real report that mentions a limit is not an error');
  const cap = engine.parseRunOutput({ status: 1, stdout: j({ subtype: 'error_max_turns', is_error: true }), stderr: '' });
  check(cap.hitTurnCap === true, 'turn cap still flagged');
  // an errored rework attempt can never be accepted or lead to QA
  const repo = mkRepo('lane'); const log = [];
  fake(repo, ['FAIL', 'PASS'], (n, r) => { edit(r, n === 1 ? 'a.js' : 'b.js'); commitAll(r); return n === 1 ? {} : { error: 'prompt is too long', result: '' }; }, log);
  cleanReport(); const run = mkRun('b8', repo); quiet(() => engine.advance(run));
  check(run.status === 'blocked' && log.filter((l) => l.id === 'qa#1').length === 1, 'errored rework builds are never accepted and QA does not run');
}

// ---- N6: an old-style run (reworkNotes, no reworkRecords) resumes under the new engine ----
{
  cleanReport(); const repo = mkRepo('lane'); const log = [];
  fake(repo, ['PASS'], (n, r) => { edit(r); commitAll(r); }, log);
  const run = mkRun('b9', repo); run.reworkNotes = { 'build#1': 'Rework round 1: QA/review FAILED. Fix every finding in x-round1.md, then update the sprint log.' };
  quiet(() => engine.advance(run));
  const b = log.find((l) => l.id === 'build#1');
  check(b.note.startsWith('Rework round 1') && !b.opts.rework, 'N6: legacy note is passed to the builder as before (no baseline needed)');
  check(run.status === 'done' && !run.reworkNotes['build#1'] && !(run.reworkRecords || []).length, 'N6: legacy note consumed, run completes');
}
// ---- S2: in HQ (cwd === REPO) the sprint log and out-of-scope files do not count as a rework change ----
{
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: HOME }); execFileSync('git', ['config', 'user.email', 't@e.com'], { cwd: HOME }); execFileSync('git', ['config', 'user.name', 't'], { cwd: HOME });
  fs.writeFileSync(path.join(HOME, 'README.md'), 'hq\n'); execFileSync('git', ['add', 'README.md'], { cwd: HOME }); execFileSync('git', ['commit', '-qm', 'init'], { cwd: HOME, stdio: 'ignore' });
  const logPath = path.join(HOME, 'docs', 'internal', 'sprint-log.md');
  const hqStages = (extra) => [
    { id: 'build#1', type: 'agent', agent: 'backend-dev', tier: 'local', task: 'b', expect: ['docs/internal/sprint-log.md'], ...extra },
    { id: 'qa#1', type: 'agent', agent: 'qa-engineer', tier: 'local', task: 'qa', expect: [rpath], rework: { to: 'build', verdict: rpath, max: 3 } },
  ];
  const hqRun = (id, mode, extra) => {
    cleanReport(); const log = []; const verdicts = ['FAIL', 'PASS'];
    engine.hooks.runAgent = (stage, tier, vars, fb, note) => {
      log.push({ id: stage.id, note });
      if (stage.id === 'build#1') {
        fs.mkdirSync(path.dirname(logPath), { recursive: true }); fs.appendFileSync(logPath, 'entry ' + Math.random() + '\n');
        const n = log.filter((l) => l.id === 'build#1').length;
        if (n === 1) { fs.mkdirSync(path.join(HOME, 'apps'), { recursive: true }); fs.writeFileSync(path.join(HOME, 'apps', 'first-' + id + '.js'), '1'); }
        else if (mode === 'other') fs.writeFileSync(path.join(HOME, 'docs', 'other-lane-' + id + '.md'), 'x');
        else if (mode === 'apps') fs.writeFileSync(path.join(HOME, 'apps', 'fix-' + id + '.js'), '2');
        return { tier, model: 'x', secs: 0, result: 'built' };
      }
      fs.writeFileSync(rpath, REPORT(verdicts.shift())); return { tier, model: 'x', secs: 0, result: 'qa' };
    };
    const run = { id, pipeline: 't', vars: { home: sl(HOME), workdir: sl(HOME) }, stages: hqStages(extra), cursor: 0, gates: {}, history: [], status: 'running' };
    quiet(() => engine.advance(run)); return { run, log };
  };
  let r = hqRun('h1', 'logonly', {});
  check(r.run.status === 'blocked' && r.log.filter((l) => l.id === 'qa#1').length === 1, 'S2: writing only the sprint log is not a rework change in HQ');
  r = hqRun('h2', 'other', { reworkPaths: ['apps/'] });
  check(r.run.status === 'blocked', 'S2: a file outside the stage reworkPaths allowlist does not count');
  r = hqRun('h3', 'apps', { reworkPaths: ['apps/'] });
  check(r.run.status === 'done' && r.run.reworkRecords[0].changedPaths.join() === 'apps/fix-h3.js', 'S2: a change inside reworkPaths passes, manifest excludes the sprint log');
}

fs.rmSync(HOME, { recursive: true, force: true });
console.log(fails ? `\n${fails} failed` : '\nrework baseline selftest passed');
process.exit(fails ? 1 : 0);
