#!/usr/bin/env node
// Guard: a build stage that leaves the working tree unchanged must fail (found 2026-11-07, when a local
// builder changed nothing and the build check still passed).
const fs = require('fs'), os = require('os'), path = require('path'), { execFileSync } = require('child_process');
const { treeSnapshot, mustChange } = require('./engine.js');

let fails = 0;
const check = (ok, name) => { console.log(`  ${ok ? '✓' : '✗'} ${name}`); if (!ok) fails++; };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-mustchange-'));
const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
git('init', '-q'); git('config', 'user.email', 't@example.com'); git('config', 'user.name', 't');
fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n'); git('add', '-A'); git('commit', '-qm', 'init');

const s0 = treeSnapshot(dir);
check(s0 !== null, 'snapshot works in a git checkout');
check(treeSnapshot(dir) === s0, 'unchanged tree gives the same snapshot');
fs.writeFileSync(path.join(dir, 'a.txt'), 'two\n');
check(treeSnapshot(dir) !== s0, 'edited file changes the snapshot');
const s1 = treeSnapshot(dir);
fs.writeFileSync(path.join(dir, 'b.txt'), 'new\n');
check(treeSnapshot(dir) !== s1, 'new untracked file changes the snapshot');
check(treeSnapshot(os.tmpdir() + path.sep + 'definitely-not-a-repo-' + Date.now()) === null, 'non-git dir gives null (guard skipped)');

check(mustChange({ id: 'build#3' }) === true, 'build stages must change files');
check(mustChange({ id: 'qa#3' }) === false, 'qa stages need not change code');
check(mustChange({ id: 'qa#3', mustChange: true }) === true, 'explicit mustChange wins');
check(mustChange({ id: 'build#1', mustChange: false }) === false, 'explicit opt-out wins');

fs.rmSync(dir, { recursive: true, force: true });
console.log(fails ? `\n${fails} failed` : '\nmust-change selftest passed');
process.exit(fails ? 1 : 0);
