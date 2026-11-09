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
  const run = { pipeline: 'p', stages: [
    { id: 'build#1' }, { id: 'qa#1', check: 'qa-check 1', rework: { to: 'build', verdict: 'qa-1.md', failRegex: 'VERDICT: FAIL', max: 3 } },
    { id: 'review', check: 'OLD-CHECK', rework: { to: 'build', verdict: 'r.md', failRegex: 'REQUEST CHANGES\\s*$', max: 3 } } ] };
  const n = engine.refreshStages(run);
  check(run.stages[2].rework.failRegex === 'REQUEST CHANGES[\\s*_`]*$', 'review failRegex refreshed');
  check(run.stages[2].check === 'NEW-CHECK', 'unsuffixed review check refreshed');
  check(run.stages[1].rework.failRegex === 'VERDICT:[\\s*_`]*FAIL', 'expanded qa#1 failRegex refreshed');
  check(run.stages[1].check === 'qa-check 1' && run.stages[1].rework.verdict === 'qa-1.md', 'expanded qa#1 keeps its per-item check and report path');
  check(n === 3, 'reports the number of rules changed');
  check(engine.refreshStages({ pipeline: 'missing', stages: [] }) === 0, 'missing pipeline file is a no-op');
}

console.log('D. headless permissions and rules');
{
  const t = engine.allowedToolsFor({ allowedTools: ['Bash(cargo:*)'] });
  for (const need of ['Bash(git commit:*)', 'Bash(git add:*)', 'Bash(npm:*)', 'Bash(node:*)', 'Bash(powershell:*)', 'Bash(cargo:*)']) check(t.includes(need), `allowed: ${need}`);
  for (const no of ['Bash(git push:*)', 'Bash(gh:*)', 'Bash(git reset --hard:*)']) check(engine.DISALLOWED_TOOLS.includes(no) && !t.includes(no), `denied: ${no}`);
  check(/never ask/i.test(engine.UNATTENDED_RULES) && /never push/i.test(engine.UNATTENDED_RULES), 'prompt tells agents they run unattended and must not push');
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
