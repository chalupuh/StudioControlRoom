#!/usr/bin/env node
// Self-test for studio/backup.js — temp HOME with fake runs/checkpoints, verify zip + prune.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

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

// --- Backup: actually create the zip on Windows, skip on non-Windows ---
const mockNow = new Date(2026, 6, 15, 10, 0); // 2026-07-15 10:00
const dest = backup.backup({ HOME, now: mockNow });
if (os.platform() === 'win32') {
  check('backup created zip', dest && fs.existsSync(dest));
  check('backup zip > 0 bytes', dest && fs.statSync(dest).size > 0);
  check('backup zip name matches date', dest && dest.includes('2026-07-15'));
  // Verify the zip actually contains the test run file by expanding it.
  const tmpExtract = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-expand-'));
  try {
    execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      'Expand-Archive -LiteralPath $env:ZIP -DestinationPath $env:DST -Force',
    ], { env: { ...process.env, ZIP: dest, DST: tmpExtract }, windowsHide: true, timeout: 30000 });
    const files = [];
    function walk(dir) {
      for (const e of fs.readdirSync(dir)) {
        const fp = path.join(dir, e);
        if (fs.statSync(fp).isDirectory()) walk(fp);
        else files.push(fp.replace(tmpExtract + path.sep, ''));
      }
    }
    walk(tmpExtract);
    check('backup zip contains runs/test-run.json', files.some((f) => /runs[/\\]test-run\.json$/.test(f)));
  } catch (e) {
    check('backup zip expansion (skipped: ' + e.message + ')', false);
  } finally {
    fs.rmSync(tmpExtract, { recursive: true, force: true });
  }
} else {
  check('backup on non-Windows: skipped (no Compress-Archive on this platform)', true);
}

// --- Prune old backups ---
const backupDir = path.join(studio, 'backups');
fs.mkdirSync(backupDir, { recursive: true });
// 15 fake backups + 1 real zip from backup() above = 16 total
for (let i = 0; i < 15; i++) {
  const d = `2026-01-${String(i + 1).padStart(2, '0')}`;
  fs.writeFileSync(path.join(backupDir, d + '.zip'), 'fake');
}
check('16 backups exist before prune', fs.readdirSync(backupDir).length === 16);

backup.pruneOld(backupDir, 14);
const after = fs.readdirSync(backupDir);
check('pruneOld: keeps 14', after.length === 14);
check('pruneOld: keeps newest fake', after.includes('2026-01-15.zip'));
check('pruneOld: drops oldest', !after.includes('2026-01-01.zip'));
check('pruneOld: drops 2nd oldest too', !after.includes('2026-01-02.zip')); // 01+02 dropped → 14 remain
check('pruneOld: keeps 2026-01-03', after.includes('2026-01-03.zip')); // 03..15 + real = 14

// --- Empty HOME: nothing to back up ---
const emptyHOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-empty-'));
const emptySrc = backup.collectSources(emptyHOME);
check('empty HOME: no sources', emptySrc.length === 0);

// Cleanup
fs.rmSync(HOME, { recursive: true, force: true });
fs.rmSync(emptyHOME, { recursive: true, force: true });

if (fail) { console.error(`${fail} failed`); process.exit(1); }
console.log('backup selftest passed');
