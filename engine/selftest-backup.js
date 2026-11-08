#!/usr/bin/env node
// Self-test for studio/backup.js — temp HOME with fake runs/checkpoints, verify zip + prune.
const fs = require('fs');
const os = require('os');
const path = require('path');

let fail = 0;
const check = (name, ok) => { if (ok) console.log(`  ok   ${name}`); else { fail++; console.error(`  FAIL ${name}`); } };

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-test-'));
const studio = path.join(HOME, '.studio');
fs.mkdirSync(path.join(studio, 'runs'), { recursive: true });
fs.mkdirSync(path.join(studio, 'checkpoints'), { recursive: true });
fs.writeFileSync(path.join(studio, 'runs', 'test-run.json'), JSON.stringify({ id: 'test-run', status: 'running' }));
fs.writeFileSync(path.join(studio, 'checkpoints', 'agent-cp.json'), JSON.stringify({ agent: 'test' }));
fs.writeFileSync(path.join(studio, 'roster.json'), JSON.stringify({ agents: [] }));
fs.writeFileSync(path.join(studio, 'events.jsonl'), 'test line\n');
const docsDir = path.join(HOME, 'docs', 'internal');
fs.mkdirSync(docsDir, { recursive: true });
fs.writeFileSync(path.join(docsDir, 'qa.md'), '# QA');

const backup = require('../studio/backup');

// --- Collect sources ---
const sources = backup.collectSources(HOME);
check('collectSources: found runs', sources.some((s) => s.includes('runs')));
check('collectSources: found checkpoints', sources.some((s) => s.includes('checkpoints')));
check('collectSources: found roster', sources.some((s) => s.includes('roster.json')));
check('collectSources: found events', sources.some((s) => s.includes('events.jsonl')));
check('collectSources: found docs', sources.some((s) => s.includes('docs')));

// --- Backup (skips zip on non-Windows for now; test the collect + prune logic) ---
// We test prune separately since Compress-Archive is Windows-only.

// --- Prune old backups ---
const backupDir = path.join(studio, 'backups');
fs.mkdirSync(backupDir, { recursive: true });
// Create 16 fake backups
for (let i = 0; i < 16; i++) {
  const d = `2026-01-${String(i + 1).padStart(2, '0')}`;
  fs.writeFileSync(path.join(backupDir, d + '.zip'), 'fake');
}
check('16 backups exist before prune', fs.readdirSync(backupDir).length === 16);

backup.pruneOld(backupDir, 14);
const after = fs.readdirSync(backupDir);
check('pruneOld: keeps 14', after.length === 14);
check('pruneOld: keeps newest', after.includes('2026-01-16.zip'));
check('pruneOld: drops oldest', !after.includes('2026-01-01.zip'));
check('pruneOld: drops 2nd oldest too', !after.includes('2026-01-02.zip')); // 01+02 dropped → 14 remain
check('pruneOld: keeps 2026-01-03', after.includes('2026-01-03.zip')); // 3..16 = 14

// --- Empty HOME: nothing to back up ---
const emptyHOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-empty-'));
const emptySrc = backup.collectSources(emptyHOME);
check('empty HOME: no sources', emptySrc.length === 0);

// Cleanup
fs.rmSync(HOME, { recursive: true, force: true });
fs.rmSync(emptyHOME, { recursive: true, force: true });

if (fail) { console.error(`${fail} failed`); process.exit(1); }
console.log('backup selftest passed');
