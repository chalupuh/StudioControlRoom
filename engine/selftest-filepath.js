#!/usr/bin/env node
// /api/file path resolution: gate links carry absolute {{home}} paths; they must open, while escapes stay forbidden.
const fs = require('fs'), os = require('os'), path = require('path');
const { resolveDocPath } = require('../studio/filepath.js');
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'filepath-'));
let fails = 0;
const check = (ok, name) => { console.log(`  ${ok ? '✓' : '✗'} ${name}`); if (!ok) fails++; };
const fwd = repo.replace(/\\/g, '/');
const want = path.resolve(repo, 'docs/internal/review-sprint2b.md');
check(resolveDocPath('docs/internal/review-sprint2b.md', repo) === want, 'relative docs path');
check(resolveDocPath(`${fwd}/docs/internal/review-sprint2b.md`, repo) === want, 'absolute forward-slash path inside repo');
check(resolveDocPath(path.join(repo, 'docs', 'internal', 'review-sprint2b.md'), repo) === want, 'absolute native path inside repo');
check(resolveDocPath('.studio/checkpoints/manager.md', repo) === path.resolve(repo, '.studio/checkpoints/manager.md'), 'checkpoint path');
check(resolveDocPath('docs/../package.json', repo) === null, 'dot-dot rejected');
check(resolveDocPath(`${fwd}/docs/../../secret.md`, repo) === null, 'absolute escape rejected');
check(resolveDocPath(`${fwd}-evil/docs/x.md`, repo) === null, 'sibling folder with same prefix rejected');
check(resolveDocPath(path.join(os.tmpdir(), 'docs', 'x.md'), repo) === null, 'absolute path outside repo rejected');
check(resolveDocPath('docs/x.js', repo) === null, 'non-markdown rejected');
check(resolveDocPath('README.md', repo) === null, 'markdown outside docs/ rejected');
check(resolveDocPath('docs/x.md\0', repo) === null, 'NUL rejected');
check(resolveDocPath('/etc/passwd.md', repo) === null, 'root path rejected');
fs.rmSync(repo, { recursive: true, force: true });
if (fails) { console.log(`\n${fails} failed`); process.exit(1); }
console.log('\nall passed');
