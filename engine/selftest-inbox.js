#!/usr/bin/env node
// Self-test for Owner Inbox: gate 'park' + per-item decisions (parseItems, decideGate, CLI approve/resume, runSummary shape).
// Run: node engine/selftest-inbox.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-selftest-inbox-'));
process.env.STUDIO_HOME = HOME; // engine resolves REPO at require time
const { parseItems, decideGate } = require('./engine');

let pass = 0, fail = 0;
const assert = (name, cond) => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.error(`  ✗ ${name}`); } };

const PROPOSAL = 'docs/proposal.md';
const REGEX = '^- \\[[ xX]\\] ([\\w-]+)';
const BODY = `# Proposal
## Owner decision
- [ ] alpha: Approve / Park / Reject   Notes: keep
- [ ] beta: Approve / Park / Reject   Notes:
- [ ] gamma: Approve / Park / Reject
- [ ] delta - no choice words
`;
const write = () => { fs.mkdirSync(path.join(HOME, 'docs'), { recursive: true }); fs.writeFileSync(path.join(HOME, PROPOSAL), BODY); };
const read = () => fs.readFileSync(path.join(HOME, PROPOSAL), 'utf8');
const mkRun = (id, withItems = true) => {
  const g = { status: 'waiting', title: 't', show: [], since: 'x' };
  if (withItems) { g.items = { file: PROPOSAL, regex: REGEX }; g.itemList = parseItems(g.items, {}); }
  return { id, pipeline: 'p', vars: {}, stages: [{ id: 'g', type: 'gate' }], cursor: 0, gates: { g }, history: [], status: 'waiting-gate', created: 'x' };
};
const cli = (...args) => spawnSync(process.execPath, [path.join(__dirname, 'engine.js'), ...args], { encoding: 'utf8', env: { ...process.env, STUDIO_HOME: HOME } });
const saveRun = (r) => { fs.mkdirSync(path.join(HOME, '.studio', 'runs'), { recursive: true }); fs.writeFileSync(path.join(HOME, '.studio', 'runs', r.id + '.json'), JSON.stringify(r)); };
const loadRun = (id) => JSON.parse(fs.readFileSync(path.join(HOME, '.studio', 'runs', id + '.json'), 'utf8'));

// ---- parseItems ----
write();
const items = parseItems({ file: PROPOSAL, regex: REGEX }, {});
assert('parseItems finds 4 checkbox items', items.length === 4 && items.map((i) => i.id).join() === 'alpha,beta,gamma,delta');
assert('parseItems: missing file gives []', parseItems({ file: 'nope.md', regex: REGEX }, {}).length === 0);
assert('parseItems: no spec gives []', parseItems(undefined, {}).length === 0);

// ---- decideGate: plain decisions ----
let r = mkRun('r1', false);
assert('park: gate parked, run parked', decideGate(r, 'g', 'park', 'later') === 'parked' && r.status === 'parked' && r.gates.g.note === 'later');
r = mkRun('r2', false);
assert('reject: run stopped', decideGate(r, 'g', 'reject', '') === 'rejected' && r.status === 'stopped');
r = mkRun('r3', false);
assert('approve: gate approved, run status unchanged', decideGate(r, 'g', 'approve', '') === 'approved' && r.status === 'waiting-gate');
let threw = false; try { decideGate(mkRun('r4', false), 'g', 'maybe', ''); } catch { threw = true; }
assert('invalid decision throws', threw);

// ---- decideGate: items ----
write(); r = mkRun('r5');
assert('mixed items: approved', decideGate(r, 'g', null, 'n', { alpha: 'approve', beta: 'park', gamma: 'reject' }) === 'approved');
const t = read();
assert('alpha ticked + word Approve, note kept', /- \[x\] alpha: Approve   Notes: keep/.test(t));
assert('beta ticked + word Park', /- \[x\] beta: Park/.test(t));
assert('gamma ticked + word Reject', /- \[x\] gamma: Reject/.test(t));
assert('untouched line unchanged', t.includes('- [ ] delta - no choice words'));
write(); r = mkRun('r6');
assert('park+reject only -> parked', decideGate(r, 'g', null, '', { alpha: 'park', beta: 'reject' }) === 'parked' && r.status === 'parked');
write(); r = mkRun('r7');
assert('all rejected -> rejected/stopped', decideGate(r, 'g', null, '', { alpha: 'reject' }) === 'rejected' && r.status === 'stopped');
for (const [label, map] of [['unknown item', { zzz: 'approve' }], ['bad value', { alpha: 'maybe' }], ['empty map', {}]]) {
  write(); threw = false; try { decideGate(mkRun('rx'), 'g', null, '', map); } catch { threw = true; }
  assert(`items: ${label} throws, file untouched`, threw && read() === BODY);
}
threw = false; try { decideGate(mkRun('ry', false), 'g', null, '', { alpha: 'approve' }); } catch { threw = true; }
assert('items on a gate without items throws', threw);

// ---- CLI: approve park / resume / items ----
write();
const pipeStages = [{ id: 'g', type: 'gate' }];
let run = mkRun('cli1'); run.stages = pipeStages; saveRun(run);
let o = cli('approve', 'cli1', 'park', 'not now');
run = loadRun('cli1');
assert('CLI park: run parked, gate parked', o.status === 0 && run.status === 'parked' && run.gates.g.status === 'parked');
o = cli('resume', 'cli1'); run = loadRun('cli1');
assert('CLI resume re-opens a parked gate (waiting-gate)', run.status === 'waiting-gate' && run.gates.g.status === 'waiting');
o = cli('approve', 'cli1', 'items', JSON.stringify({ alpha: 'approve', beta: 'park' }), 'ok'); run = loadRun('cli1');
assert('CLI items: run done after approve, itemDecisions stored', o.status === 0 && run.status === 'done' && run.gates.g.itemDecisions.beta === 'park');
assert('CLI items: file written back', /- \[x\] alpha: Approve/.test(read()) && /- \[x\] beta: Park/.test(read()));
run = mkRun('cli2'); saveRun(run);
o = cli('approve', 'cli2', 'items', 'not json');
assert('CLI items: bad JSON exits 1', o.status === 1);
o = cli('approve', 'cli2', 'items', JSON.stringify({ nope: 'approve' }));
assert('CLI items: unknown item exits 1, run still waiting', o.status === 1 && loadRun('cli2').status === 'waiting-gate');

// ---- engine creates the gate with parsed items ----
fs.mkdirSync(path.join(HOME, 'tools', 'engine', 'pipelines'), { recursive: true });
fs.writeFileSync(path.join(HOME, 'tools', 'engine', 'pipelines', 'inbox.json'), JSON.stringify({ description: 'x', stages: [{ id: 'g', type: 'gate', title: 'Decide', show: [PROPOSAL], items: { file: PROPOSAL, regex: REGEX } }] }));
write(); o = cli('start', 'inbox');
const id = fs.readdirSync(path.join(HOME, '.studio', 'runs')).find((f) => f.startsWith('inbox-')).replace('.json', '');
run = loadRun(id);
assert('start: gate waiting with parsed itemList', run.status === 'waiting-gate' && run.gates.g.itemList.length === 4 && run.gates.g.items.file === PROPOSAL);

fs.rmSync(HOME, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
