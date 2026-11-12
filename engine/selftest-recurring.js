#!/usr/bin/env node
// Recurring run failures found 2026-11-09 (overnight on the 5090 PC):
//   A. a cloud usage limit ("You've hit your 5-hour limit") blocked every run instead of waiting for the reset
//   B. reports written inside the lane worktree instead of HQ looked "missing"
//   C. runs kept stale verdict rules from the pipeline they started with
//   D. headless agents had no permission for git commit / npm / powershell
//   E. harmless CLI warnings were reported as the failure reason
const fs = require('fs'), os = require('os'), path = require('path');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-recurring-'));
process.env.STUDIO_HOME = HOME;
process.env.STUDIO_LIMIT_MAX_WAITS = '3';
const engine = require('./engine.js');
engine.hooks.localReady = () => true; // no real Ollama check in tests

let fails = 0;
const check = (ok, name) => { console.log(`  ${ok ? '✓' : '✗'} ${name}`); if (!ok) fails++; };
const sl = (p) => p.split(String.fromCharCode(92)).join('/');
const quiet = (fn) => { const l = console.log; console.log = () => {}; try { return fn(); } finally { console.log = l; } };
fs.mkdirSync(path.join(HOME, '.studio', 'runs'), { recursive: true });

console.log('A. usage limits');
{
  check(engine.isUsageLimit("You've hit your 5-hour limit · resets 4am (America/New_York)"), '5-hour limit message detected');
  check(engine.isUsageLimit('Claude AI usage limit reached|1794214800'), '"usage limit reached" detected');
  check(!engine.isUsageLimit('VERDICT: PASS. The rate limiter in studio.js handles 429 correctly.\n' + 'x'.repeat(700)), 'a long report about rate limits is not a limit');
  check(!engine.isUsageLimit(''), 'empty text is not a limit');
  for (const t of ['5-hour limit reached ∙ resets 3pm', 'Session limit reached ∙ resets 4am', 'Opus weekly limit reached ∙ resets Oct 9, 10am', 'API Error: 429 rate_limit_error'])
    check(engine.isUsageLimit(t), 'detected: ' + t);
  const fp = 'Done. Added a rate limit to POST /login; returns 429 Too Many Requests when exceeded. Tests pass, committed.';
  check(!engine.isUsageLimit(fp), 'a short build report about adding a 429 rate limit is not a usage limit');
  check(engine.parseRunOutput({ stdout: JSON.stringify({ result: "You've hit your 5-hour limit" }), stderr: '', status: 0 }).usageLimit === false, 'a successful run is never flagged as a usage limit');

  const sleeps = []; engine.hooks.sleep = (ms) => sleeps.push(ms);
  let calls = 0;
  engine.hooks.runAgent = (stage, tier) => (++calls <= 2 ? { tier, model: 'x', secs: 0, result: "You've hit your 5-hour limit · resets 4am", usageLimit: true } : { tier, model: 'x', secs: 0, result: 'done' });
  const run = { id: 'lim1', pipeline: 't', vars: { home: sl(HOME), workdir: sl(HOME) }, stages: [{ id: 'review', type: 'agent', agent: 'code-reviewer', tier: 'sonnet', task: 'x', mustChange: false }], cursor: 0, gates: {}, history: [], status: 'running' };
  quiet(() => engine.advance(run));
  check(run.status === 'done', 'run finishes after the limit resets');
  check(sleeps.length === 2, 'waited once per limit hit');
  check(run.history.filter((h) => h.type === 'usage-limit').length === 2, 'limit waits recorded in history');
  check(run.history.filter((h) => h.ok === false).length === 0, 'limit hits are not counted as failed attempts');
  check(run.history.filter((h) => h.ok === true).every((h) => h.tier === 'sonnet'), 'retried on the same tier (did not climb to opus)');

  engine.hooks.runAgent = (stage, tier) => ({ tier, model: 'x', secs: 0, result: "You've hit your 5-hour limit", usageLimit: true });
  const run2 = { ...run, id: 'lim2', history: [], cursor: 0, status: 'running', limitWaits: 0 };
  quiet(() => engine.advance(run2));
  check(run2.status === 'blocked' && /usage limit did not reset after 3 waits/.test(run2.blockedReason), 'blocks for the owner after the max number of waits');
}

console.log('B. misplaced reports');
{
  const wt = path.join(HOME, 'lane'); fs.mkdirSync(wt, { recursive: true });
  const rel = 'docs/internal/review-sprintX.md';
  engine.hooks.runAgent = (stage, tier) => {
    fs.mkdirSync(path.join(wt, 'docs', 'internal'), { recursive: true });
    fs.writeFileSync(path.join(wt, rel), 'review\n\n**APPROVE**\n');
    return { tier, model: 'x', secs: 0, result: 'wrote the review in this worktree' };
  };
  const run = { id: 'mis1', pipeline: 't', vars: { home: sl(HOME), workdir: sl(wt) }, stages: [{ id: 'review', type: 'agent', agent: 'code-reviewer', tier: 'opus', task: 'x', expect: [rel], mustChange: false }], cursor: 0, gates: {}, history: [], status: 'running' };
  quiet(() => engine.advance(run));
  check(run.status === 'done', 'stage passes when the report was written in the worktree');
  check(fs.existsSync(path.join(HOME, rel)) && !fs.existsSync(path.join(wt, rel)), 'report moved to the HQ path');
  check(run.history.some((h) => h.type === 'adopted-report' && h.files.includes(rel)), 'move recorded in history');

  // a stale worktree copy (older than the attempt) is not adopted
  fs.unlinkSync(path.join(HOME, rel));
  fs.writeFileSync(path.join(wt, rel), 'old');
  const old = new Date(Date.now() - 3600e3); fs.utimesSync(path.join(wt, rel), old, old);
  const moved = engine.adoptMisplacedReports({ history: [] }, { id: 'review', expect: [rel] }, { workdir: sl(wt) }, Date.now());
  check(moved.length === 0 && !fs.existsSync(path.join(HOME, rel)), 'stale worktree copy is left alone');
  // a stale HQ copy from an earlier round is moved aside and the fresh worktree report wins
  fs.writeFileSync(path.join(HOME, rel), 'old HQ copy'); fs.utimesSync(path.join(HOME, rel), old, old);
  fs.writeFileSync(path.join(wt, rel), 'fresh\nREQUEST CHANGES\n');
  const m2 = engine.adoptMisplacedReports({ history: [] }, { id: 'review', expect: [rel], rework: { verdict: rel } }, { workdir: sl(wt) }, Date.now() - 1000);
  check(m2.length === 1 && /fresh/.test(fs.readFileSync(path.join(HOME, rel), 'utf8')), 'fresh verdict report replaces a stale HQ copy');
  check(fs.readdirSync(path.join(HOME, 'docs', 'internal')).some((f) => /^review-sprintX-stale-\d{8}T\d{6}\.md$/.test(f)), 'stale HQ copy kept as -stale-<time>.md');
  // shared, append-only HQ docs in `expect` (the sprint log) are never replaced by a worktree copy
  const log = 'docs/internal/sprint-log.md';
  fs.writeFileSync(path.join(HOME, log), 'entry 1\nentry 2\nentry 3\n'); fs.utimesSync(path.join(HOME, log), old, old);
  fs.writeFileSync(path.join(wt, 'docs', 'internal', 'sprint-log.md'), 'entry 4 only\n');
  const m3 = engine.adoptMisplacedReports({ history: [] }, { id: 'build#1', expect: [log], rework: { verdict: 'docs/internal/qa/x.md' } }, { workdir: sl(wt) }, Date.now() - 1000);
  check(m3.length === 0 && fs.readFileSync(path.join(HOME, log), 'utf8') === 'entry 1\nentry 2\nentry 3\n', 'HQ sprint log left unchanged by a worktree copy');
  check(!fs.readdirSync(path.join(HOME, 'docs', 'internal')).some((f) => /sprint-log-stale/.test(f)), 'sprint log never moved aside');
  // a second stale copy of a verdict report does not overwrite the first
  fs.writeFileSync(path.join(HOME, rel), 'round A'); fs.utimesSync(path.join(HOME, rel), old, old);
  fs.writeFileSync(path.join(wt, rel), 'round B');
  engine.adoptMisplacedReports({ history: [] }, { id: 'review', expect: [rel], rework: { verdict: rel } }, { workdir: sl(wt) }, Date.now() - 1000);
  const stales = fs.readdirSync(path.join(HOME, 'docs', 'internal')).filter((f) => /review-sprintX-stale/.test(f));
  check(stales.length >= 2, 'each stale copy gets its own name (none overwritten)');
  // never escapes HQ
  const esc = engine.adoptMisplacedReports({ history: [] }, { id: 'review', expect: ['../outside.md'] }, { workdir: sl(wt) }, 0);
  check(esc.length === 0, 'paths outside HQ are ignored');
}

console.log('C. refresh stale stage rules on resume');
{
  const pipes = path.join(HOME, 'tools', 'engine', 'pipelines'); fs.mkdirSync(pipes, { recursive: true });
  fs.writeFileSync(path.join(pipes, 'p.json'), JSON.stringify({ stages: [
    { type: 'foreach', id: 'items', stages: [
      { id: 'build', type: 'agent' },
      { id: 'qa', type: 'agent', check: 'qa-check {{n}}', rework: { to: 'build', verdict: 'qa-{{n}}.md', failRegex: 'VERDICT:[\\s*_`]*FAIL', max: 3 } } ] },
    { id: 'review', type: 'agent', check: 'NEW-CHECK', rework: { to: 'build', verdict: 'r.md', failRegex: 'REQUEST CHANGES[\\s*_`]*$', max: 3 } },
  ] }));
  const run = { pipeline: 'p', stages: [ { id: 'items', type: 'foreach', stages: [{ id: 'build', type: 'agent' }] },
    { id: 'build#1' }, { id: 'qa#1', check: 'qa-check 1', rework: { to: 'build', verdict: 'qa-1.md', failRegex: 'VERDICT: FAIL', max: 3 } },
    { id: 'review', check: 'OLD-CHECK', rework: { to: 'build', verdict: 'r.md', failRegex: 'REQUEST CHANGES\\s*$', max: 3 } } ] };
  const n = engine.refreshStages(run);
  check(run.stages[0].stages.length === 2 && run.stages[0].stages[1].rework.failRegex === 'VERDICT:[\\s*_`]*FAIL', 'unexpanded foreach takes the template inner stages');
  run.stages.shift();
  check(run.stages[2].rework.failRegex === 'REQUEST CHANGES[\\s*_`]*$', 'review failRegex refreshed');
  check(run.stages[2].check === 'NEW-CHECK', 'unsuffixed review check refreshed');
  check(run.stages[1].rework.failRegex === 'VERDICT:[\\s*_`]*FAIL', 'expanded qa#1 failRegex refreshed');
  check(run.stages[1].check === 'qa-check 1' && run.stages[1].rework.verdict === 'qa-1.md', 'expanded qa#1 keeps its per-item check and report path');
  check(n === 4, 'reports the number of rules changed');
  check(engine.refreshStages({ pipeline: 'missing', stages: [] }) === 0, 'missing pipeline file is a no-op');

  // 2026-11-09 afternoon: Opus reviews hit an old 30-turn cap, a docs review had no rework loop, and an old
  // lite-build run kept a backslash home path that broke its qa#1 check (ENOENT).
  fs.writeFileSync(path.join(pipes, 'q.json'), JSON.stringify({ stages: [
    { type: 'foreach', id: 'items', stages: [
      { id: 'qa', type: 'agent', maxTurns: 40, check: "read('{{home}}/qa-m{{n}}.md')" },
      { id: 'other', type: 'agent', check: 'x {{g2}}' } ] },
    { id: 'review', type: 'agent', maxTurns: 60, timeoutMin: 45, rework: { to: 'build', verdict: 'rv-{{sprint}}.md', failRegex: 'REQUEST CHANGES', max: 3 } },
  ] }));
  const bs = String.fromCharCode(92);
  const r2 = { pipeline: 'q', vars: { home: 'C:' + bs + 'HQ' + bs + 'x', sprint: '4j' }, stages: [
    { id: 'qa#2', maxTurns: 25, check: "read('C:" + bs + 'HQ' + bs + "x/qa-m2.md')" },
    { id: 'other#2', check: 'x item-two' },
    { id: 'review', maxTurns: 30 } ] };
  engine.refreshStages(r2);
  check(r2.vars.home === 'C:/HQ/x', 'backslash home var normalised to forward slashes');
  check(r2.stages[0].check === "read('C:/HQ/x/qa-m2.md')", 'expanded check re-filled with the run vars and item number');
  check(r2.stages[1].check === 'x item-two', 'expanded check needing per-item values is left alone');
  check(r2.stages[0].maxTurns === 40 && r2.stages[2].maxTurns === 60 && r2.stages[2].timeoutMin === 45, 'turn and time limits refreshed');
  check(r2.stages[2].rework && r2.stages[2].rework.failRegex === 'REQUEST CHANGES', 'a newly added rework loop reaches the run');
  if (engine.fill) check(engine.fill('{{title}}', { title: 'feat: sprint {{sprint}}', sprint: '4i' }) === 'feat: sprint 4i', 'a var naming another var is filled');
}

console.log('D. headless permissions and rules');
{
  const lane = 'C:/lanes/x';
  const b = engine.allowedToolsFor({ id: 'build#1', allowedTools: ['Bash(cargo:*)'] }, lane);
  for (const need of ['Bash(git commit:*)', 'Bash(git add:*)', 'Bash(git restore:*)', 'Bash(npm test:*)', 'Bash(npm run:*)', 'Bash(npm install:*)', 'Bash(node:*)', 'Bash(npx tsc:*)', 'Bash(powershell -NoProfile -ExecutionPolicy Bypass -File:*)', 'Bash(cargo:*)']) check(b.includes(need), 'build in a lane may: ' + need);
  for (const no of ['Bash(powershell:*)', 'Bash(pwsh:*)', 'Bash(npx:*)', 'Bash(find:*)', 'Bash(npm:*)']) check(!b.includes(no), 'not granted (runs arbitrary inline code): ' + no);
  for (const no of ['Bash(git push:*)', 'Bash(gh:*)', 'Bash(git reset --hard:*)', 'Bash(git -C:*)']) check(engine.DISALLOWED_TOOLS.includes(no) && !b.includes(no), 'denied: ' + no);
  const qa = engine.allowedToolsFor({ id: 'qa#1' }, lane), hq = engine.allowedToolsFor({ id: 'build#1' }, engine.REPO);
  check(!qa.includes('Bash(git commit:*)') && !hq.includes('Bash(git commit:*)'), 'QA stages and stages in the HQ checkout get no commit tools');
  const rb = engine.unattendedRules({ id: 'build#1' }, lane), rq = engine.unattendedRules({ id: 'review' }, lane), rh = engine.unattendedRules({ id: 'build#1' }, engine.REPO);
  check(/never ask/i.test(rb) && /never push/i.test(rb) && /git commit/.test(rb), 'lane build: unattended, commit, never push');
  check(/do NOT commit/.test(rq) && /do NOT commit/.test(rh), 'review and HQ stages are told not to commit');
  // a build stage whose workdir is a checkout on main must not commit there
  const onMain = path.join(HOME, 'main-checkout'); fs.mkdirSync(onMain, { recursive: true });
  require('child_process').execSync('git init -q -b main', { cwd: onMain });
  check(!engine.allowedToolsFor({ id: 'build#1' }, onMain).includes('Bash(git commit:*)') && /do NOT commit/.test(engine.unattendedRules({ id: 'build#1' }, onMain)), 'build in a checkout on main gets no commit rules or tools');
}

console.log('E. failure reason text');
{
  const stderr = '⚠ claude.ai connectors are disabled because ANTHROPIC_API_KEY or another auth source is set\n[claude-code:unrecognized_model] {"model":"qwen3.6:27b"}\nError: ECONNREFUSED 127.0.0.1:11434\n';
  const r = engine.parseRunOutput({ stdout: '', stderr, status: 1 });
  check(/ECONNREFUSED/.test(r.error) && !/connectors are disabled|unrecognized_model/.test(r.error), 'real error kept, harmless warnings dropped');
  check(r.ignoredWarning && /unrecognized_model/.test(r.ignoredWarning), 'model warning still logged as ignoredWarning');
  const onlyWarn = engine.parseRunOutput({ stdout: '', stderr: '[claude-code:unrecognized_model] {}\n', status: 1 });
  check(onlyWarn.error === 'exit 1', 'warnings only → plain exit code, not the warning');
  const lim = engine.parseRunOutput({ stdout: JSON.stringify({ result: "You've hit your 5-hour limit · resets 4am", is_error: true }), stderr: '', status: 1 });
  check(lim.usageLimit === true, 'parseRunOutput flags the usage limit');
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
