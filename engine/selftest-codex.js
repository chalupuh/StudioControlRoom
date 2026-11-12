#!/usr/bin/env node
// Codex tier (ADR 0004): runCodex / parseCodexOutput against a fake `codex` script on PATH.
// Cases: success, failure, rate/usage limited, binary missing (tier skipped + progress warning), ladder skip.
const fs = require('fs'), os = require('os'), path = require('path');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-codex-'));
const BIN = path.join(HOME, 'bin');
const EMPTY = path.join(HOME, 'empty');
fs.mkdirSync(BIN, { recursive: true }); fs.mkdirSync(EMPTY);
fs.mkdirSync(path.join(HOME, '.studio', 'runs'), { recursive: true });
fs.mkdirSync(path.join(HOME, '.codex', 'agents'), { recursive: true });
const WINP = ['C:', 'Users', 'x'].join(String.fromCharCode(92));
fs.writeFileSync(path.join(HOME, '.codex', 'agents', 'backend-dev.toml'), ['name = "backend-dev"', "developer_instructions = '''", 'You are the ROLE-MARKER engineer.', 'Path ' + WINP + ' and """ quotes.', "'''", ''].join(String.fromCharCode(10)));
process.env.STUDIO_HOME = HOME;
// keep findCodex off any real install on this machine
process.env.LOCALAPPDATA = EMPTY; process.env.HOME = EMPTY; delete process.env.CODX_EXE; delete process.env.CODEX_EXE;
const engine = require('./engine.js');

let fails = 0;
const check = (ok, name) => { console.log(`  ${ok ? '✓' : '✗'} ${name}`); if (!ok) fails++; };

// Fake codex: behaviour chosen by FAKE_CODEX_MODE; records argv, cwd and stdin prompt to FAKE_CODEX_OUT.
const impl = path.join(BIN, 'fake-codex.js');
fs.writeFileSync(impl, `
const fs = require('fs');
const stdin = fs.readFileSync(0, 'utf8');
fs.writeFileSync(process.env.FAKE_CODEX_OUT, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), stdin }));
const out = (o) => console.log(JSON.stringify(o));
const mode = process.env.FAKE_CODEX_MODE;
if (mode === 'success') {
  out({ type: 'thread.started', thread_id: 't' });
  out({ type: 'item.completed', item: { id: 'i0', type: 'reasoning', text: 'thinking' } });
  out({ type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: 'all done' } });
  out({ type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 7 } });
} else if (mode === 'failure') {
  out({ type: 'turn.failed', error: { message: 'model exploded' } });
  process.exit(1);
} else if (mode === 'limited') {
  out({ type: 'error', message: 'You have hit your usage limit. Try again later.' });
  out({ type: 'turn.failed', error: { message: 'You have hit your usage limit.' } });
  process.exit(1);
} else if (mode === 'limited-stderr') {
  console.error('Error: 429 Too Many Requests (rate limit)');
  process.exit(1);
}
`);
if (process.platform === 'win32') fs.writeFileSync(path.join(BIN, 'codex.cmd'), `@echo off\r\n"${process.execPath}" "${impl}" %*\r\n`);
else { fs.writeFileSync(path.join(BIN, 'codex'), `#!/bin/sh\nexec "${process.execPath}" "${impl}" "$@"\n`); fs.chmodSync(path.join(BIN, 'codex'), 0o755); }
const ORIG_PATH = process.env.PATH || process.env.Path;
const setPath = (p) => { process.env.PATH = p; if (process.platform === 'win32') process.env.Path = p; };
const withFake = () => setPath(BIN + path.delimiter + ORIG_PATH);
const OUT = path.join(HOME, 'call.json');
process.env.FAKE_CODEX_OUT = OUT;
const stage = { id: 'build#1', agent: 'backend-dev', task: 'do the {{thing}}', expect: ['out.txt'] };
const vars = { thing: 'work', workdir: HOME.split(String.fromCharCode(92)).join('/') };
const events = () => { try { return fs.readFileSync(path.join(HOME, '.studio', 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };

// 1. success
{
  withFake(); process.env.FAKE_CODEX_MODE = 'success';
  const r = engine.runCodex(stage, vars, null, null);
  const call = JSON.parse(fs.readFileSync(OUT, 'utf8'));
  check(r.tier === 'codex' && r.result === 'all done' && !r.error && !r.limited && !r.skipped, 'success: result parsed, no error');
  check(r.usage && r.usage.in === 100 && r.usage.out === 7 && r.usage.cached === 40, 'success: usage parsed');
  check(call.argv[0] === 'exec' && call.argv.includes('--json'), 'runs `codex exec --json`');
  check(call.argv.join(' ').includes('--sandbox workspace-write'), 'sandbox workspace-write');
  check(fs.realpathSync(call.cwd) === fs.realpathSync(HOME), 'cwd = stage workdir');
  check(call.stdin.includes('Path ' + WINP + ' and """ quotes.'), "''' fixture: backslash path and triple quotes reach the prompt verbatim");
  check(!call.argv.includes('--add-dir') && !call.stdin.includes('Studio rules'), 'workdir = HQ: no --add-dir, no studio rules line');
  check(call.stdin.includes('ROLE-MARKER engineer') && call.stdin.includes('do the work') && call.stdin.includes('out.txt'), 'prompt = role instructions + stage task + expected files');
  const r2 = engine.runCodex(stage, vars, 'bad thing', null);
  check(/bad thing/.test(JSON.parse(fs.readFileSync(OUT, 'utf8')).stdin), 'feedback appended to the prompt');
}
// 2. failure
{
  withFake(); process.env.FAKE_CODEX_MODE = 'failure';
  const r = engine.runCodex(stage, vars, null, null);
  check(/model exploded/.test(r.error) && !r.limited && !r.skipped && r.result === '', 'failure: error reported, not limited');
}
// 3. limited (JSONL event, and stderr-only)
{
  withFake(); process.env.FAKE_CODEX_MODE = 'limited';
  const r = engine.runCodex(stage, vars, null, null);
  check(r.limited === true && /usage limit/.test(r.error), 'limited: JSONL usage-limit error marked limited');
  try { fs.rmSync(path.join(HOME, '.studio', 'codex-limited.json')); } catch {}
  process.env.FAKE_CODEX_MODE = 'limited-stderr';
  const r2 = engine.runCodex(stage, vars, null, null);
  check(r2.limited === true, 'limited: stderr 429 rate limit marked limited');
  // limited cache: the next call returns limited without spawning codex
  fs.writeFileSync(OUT, 'untouched');
  const r3 = engine.runCodex(stage, vars, null, null);
  check(r3.limited === true && r3.cached === true && fs.readFileSync(OUT, 'utf8') === 'untouched', 'limited: cached, codex not spawned again');
  fs.writeFileSync(path.join(HOME, '.studio', 'codex-limited.json'), JSON.stringify({ until: Date.now() - 1000 }));
  process.env.FAKE_CODEX_MODE = 'success';
  const r4 = engine.runCodex(stage, vars, null, null);
  check(!r4.limited && r4.result === 'all done', 'limited: expired cache runs codex again');
}

// 3b. workdir outside HQ: HQ must be writable (--add-dir) and the Studio rules line is appended
{
  withFake(); process.env.FAKE_CODEX_MODE = 'success';
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-codex-wd-'));
  engine.runCodex(stage, { ...vars, workdir: other.split(String.fromCharCode(92)).join('/') }, null, null);
  const call = JSON.parse(fs.readFileSync(OUT, 'utf8'));
  const i = call.argv.indexOf('--add-dir');
  check(i > 0 && path.resolve(call.argv[i + 1]) === path.resolve(HOME), 'workdir outside HQ: --add-dir <HQ>');
  check(call.argv[call.argv.length - 1] === '-', 'prompt still read from stdin (-)');
  check(call.stdin.includes('Studio rules: work only inside this repository') && call.stdin.includes('Org docs, specs and backlogs live in'), 'workdir outside HQ: Studio rules line in the prompt');
  try { fs.rmSync(other, { recursive: true, force: true }); } catch {}
}
// 4. missing binary
{
  try { fs.rmSync(path.join(HOME, '.studio', 'codex-limited.json')); } catch {}
  setPath(EMPTY); process.env.FAKE_CODEX_MODE = 'success';
  const before = events().length;
  const r = engine.runCodex(stage, vars, null, null);
  const warn = events().slice(before).find((e) => e.type === 'progress' && e.status === 'warning');
  check(r.skipped === true && r.result === '' && !r.limited, 'missing: tier skipped');
  check(!warn, 'missing: runCodex itself emits no warning (advance emits the single one)');
}
// 5. parseCodexOutput shape / plain events
{
  const p = engine.parseCodexOutput({ status: 0, stdout: 'noise\n{"type":"result","result":"ok"}\n{"type":"usage","input_tokens":3,"output_tokens":4}\n' });
  check(p.result === 'ok' && p.error === null && p.usage.in === 3 && p.usage.out === 4, 'parse: plain result/usage events');
  const q = engine.parseCodexOutput({ status: 1, stdout: '', stderr: 'boom' });
  check(q.error === 'boom' && !q.limited && q.usage === null, 'parse: non-zero exit uses stderr');
}
// 6. ladder: codex tier stage uses codex-first ladder (S7: missing codex key was a crash)
{
  const mk = (id) => ({ id, pipeline: 't', vars: { home: vars.workdir, workdir: vars.workdir }, stages: [{ id: 'b#1', type: 'agent', agent: 'backend-dev', tier: 'codex', task: 'x' }], cursor: 0, gates: {}, history: [], status: 'running' });
  const tiers2 = [];
  engine.hooks.runAgent = (s, tier) => {
    tiers2.push(tier);
    if (tier === 'codex') return { tier, model: 'codex', secs: 0, result: 'ok' };
    return { tier, model: 'x', secs: 0, result: 'ok' };
  };
  const run = mk('l2');
  const l = console.log; console.log = () => {}; try { engine.advance(run); } finally { console.log = l; }
  check(tiers2[0] === 'codex' && run.status === 'done', 'codex tier: ladder resolves without crash');
}

// 7. ladder: limited / missing codex is skipped (not a failure), sonnet takes over
{
  const mk = (id) => ({ id, pipeline: 't', vars: { home: vars.workdir, workdir: vars.workdir }, stages: [{ id: 'b#1', type: 'agent', agent: 'backend-dev', tier: 'local', task: 'x' }], cursor: 0, gates: {}, history: [], status: 'running' });
  const tiers = [];
  engine.hooks.runAgent = (s, tier) => {
    tiers.push(tier);
    if (tier === 'codex') return { tier, model: 'codex', secs: 0, result: '', error: 'usage limit', limited: true };
    if (tier === 'sonnet') return { tier, model: 'sonnet', secs: 0, result: 'ok' };
    return { tier, model: 'x', secs: 0, result: '', error: 'boom' };
  };
  const run = mk('l1');
  const l = console.log; console.log = () => {}; try { engine.advance(run); } finally { console.log = l; }
  check(tiers.join(',') === 'local,local,codex,sonnet' && run.status === 'done', 'ladder: limited codex falls through to sonnet');
  check(!run.history.some((h) => h.tier === 'codex'), 'ladder: limited codex not recorded as a failed attempt');
  // Assert that a 'usage' event with limited=true was emitted (Task 3 contract)
  const usageEvents = events().filter((e) => e.type === 'usage' && e.limited === true);
  check(usageEvents.length > 0, 'ladder: limited usage event emitted');
}
// 8. ladder: skipped codex (binary missing) falls through to sonnet
{
  const mk = (id) => ({ id, pipeline: 't', vars: { home: vars.workdir, workdir: vars.workdir }, stages: [{ id: 'b#1', type: 'agent', agent: 'backend-dev', tier: 'local', task: 'x' }], cursor: 0, gates: {}, history: [], status: 'running' });
  const tiers = [];
  engine.hooks.runAgent = (s, tier) => {
    tiers.push(tier);
    if (tier === 'codex') return { tier, model: 'codex', secs: 0, result: '', error: 'codex binary not found', skipped: true };
    if (tier === 'sonnet') return { tier, model: 'sonnet', secs: 0, result: 'ok' };
    return { tier, model: 'x', secs: 0, result: '', error: 'boom' };
  };
  const run = mk('l3');
  const nWarn0 = events().filter((e) => e.type === 'progress' && e.status === 'warning' && /codex unavailable/.test(e.message)).length;
  const l = console.log; console.log = () => {}; try { engine.advance(run); } finally { console.log = l; }
  check(tiers.join(',') === 'local,local,codex,sonnet' && run.status === 'done', 'ladder: skipped codex falls through to sonnet');
  check(!run.history.some((h) => h.tier === 'codex'), 'ladder: skipped codex not recorded in history');
  check(events().filter((e) => e.type === 'progress' && e.status === 'warning' && /codex unavailable/.test(e.message)).length - nWarn0 === 1, 'ladder: exactly one unavailable warning per attempt');
}

// 9. codex-path: npm shim next to node_modules/@openai/codex/bin/codex.js runs through node, no shell; shell fallback quotes the exe
{
  const cpath = require('./codex-path.js');
  const npm = path.join(HOME, 'npm dir');
  fs.mkdirSync(path.join(npm, 'node_modules', '@openai', 'codex', 'bin'), { recursive: true });
  const shim = path.join(npm, 'codex.cmd');
  fs.writeFileSync(shim, ['@echo off', ''].join(String.fromCharCode(13, 10)));
  const spec0 = cpath.codexSpawnSpec(shim, ['exec', '-']);
  check(spec0.shell === true && spec0.command.startsWith('"' + shim + '"'), 'shim without module: shell fallback quotes an exe path with spaces');
  const mod = path.join(npm, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  fs.writeFileSync(mod, ["require('fs').writeFileSync(process.env.FAKE_CODEX_OUT, JSON.stringify({ argv: process.argv.slice(2) }));", "console.log(JSON.stringify({ type: 'result', result: 'via module' }));", ''].join(String.fromCharCode(10)));
  const spec1 = cpath.codexSpawnSpec(shim, ['exec', '-']);
  check(spec1.shell === false && spec1.command === process.execPath && spec1.args[0] === mod && spec1.args[1] === 'exec', 'shim with module: node spawns the module, no shell');
  process.env.CODEX_EXE = shim;
  const r = engine.runCodex(stage, vars, null, null);
  check(r.result === 'via module' && JSON.parse(fs.readFileSync(OUT, 'utf8')).argv[0] === 'exec', 'runCodex runs the module path end to end');
  delete process.env.CODEX_EXE;
  check(cpath.codexSpawnSpec('/usr/bin/codex', ['a']).shell === false, 'plain executable: no shell');
}

// N7: clean up temp directory
try { fs.rmSync(HOME, { recursive: true, force: true }); } catch {}

console.log(fails ? `\n${fails} FAILED` : '\nall codex tests passed');
process.exit(fails ? 1 : 0);
