// check-intake: validation rules for Hana intake files.
const test = require('node:test');
const assert = require('node:assert');
const { checkIntake } = require('./check-intake.js');

function fixture({
  type = 'feature', route = 'lite', flags = '[]', team = 'Team: frontend-dev, qa-engineer',
  workOrder = '### Milestone 1: Build\n- task 1: frontend-dev',
  start = 'node tools/engine/engine.js start lite-build --var slug=x',
  ac = 'Given a user, When they tap, Then it works.', problem = 'Users cannot do X.',
  questions = 'None.', extra = '',
} = {}) {
  const parts = [
    '---', 'id: a-loreille-20261112-1', 'project: a-loreille', `type: ${type}`, 'priority: P2',
    `route: ${route}`, 'status: new', `flags: ${flags}`, 'duplicate-of: none', '---',
    '## Original request', 'Please add X. (feedback center, 2026-11-12, parent)', extra,
    '## Problem', problem,
    '## Acceptance criteria', ac,
  ];
  if (team !== null) parts.push('## Team', team);
  if (workOrder !== null) parts.push('## Work order', workOrder);
  parts.push('## Start command', start, '## Open questions for the owner', questions);
  return parts.join('\n') + '\n';
}

test('valid file passes', () => {
  const r = checkIntake(fixture());
  assert.deepStrictEqual(r.problems, []);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.meta.route, 'lite');
  assert.strictEqual(r.meta.project, 'a-loreille');
});

test('missing work order fails', () => {
  const r = checkIntake(fixture({ workOrder: null }));
  assert.strictEqual(r.ok, false);
  assert.ok(r.problems.includes('missing section: Work order'));
});

test('missing Team line fails', () => {
  const r = checkIntake(fixture({ team: 'frontend-dev, qa-engineer' }));
  assert.ok(r.problems.includes('Team: line required'));
});

test('bad enum fails', () => {
  const r = checkIntake(fixture({ route: 'medium' }));
  assert.ok(r.problems.includes('route must be one of quick-fix, lite, full, needs-owner'));
});

test('games-ip needs IP note', () => {
  const bad = checkIntake(fixture({ flags: '[games-ip]' }));
  assert.ok(bad.problems.includes('games-ip flag requires an IP: note'));
  const good = checkIntake(fixture({ flags: '[games-ip]', questions: 'IP: original characters only.' }));
  assert.ok(!good.problems.includes('games-ip flag requires an IP: note'));
});

test('bug needs repro', () => {
  const bad = checkIntake(fixture({ type: 'bug' }));
  assert.ok(bad.problems.includes('bug requires Repro/Expected/Actual'));
  const good = checkIntake(fixture({ type: 'bug', ac: 'Repro: open app\nExpected: ok\nActual: crash\nSeverity: high' }));
  assert.ok(!good.problems.includes('bug requires Repro/Expected/Actual'));
});

test('non-quick-fix needs start command', () => {
  assert.strictEqual(checkIntake(fixture({ route: 'lite', start: '' })).ok, false);
  assert.strictEqual(checkIntake(fixture({ route: 'quick-fix', start: '' })).ok, true);
});

test('email is rejected', () => {
  const r = checkIntake(fixture({ extra: 'From: someone@example.com' }));
  assert.ok(r.problems.includes('remove submitter email'));
});

test('missing front matter fails', () => {
  assert.strictEqual(checkIntake('## Problem\nx').ok, false);
});
