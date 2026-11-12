#!/usr/bin/env node
// Self-test for studio/backup.js — temp HOME with fake runs/checkpoints, verify zip + prune.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

let fail = 0;
const check = (name, ok) => { if (ok) console.log(`  ok   ${name}`); else { fail++; console.error(`  FAIL ${name}`); } };

async function run() {
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

  // --- Backup: actually create the zip ---
  const mockNow = new Date(2026, 6, 15, 10, 0); // 2026-07-15 10:00
  const dest = await backup.backup({ HOME, now: mockNow });
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
      const norm = files.map((f) => f.split(path.sep).join('/'));
      check('backup zip has exact entry .studio/runs/test-run.json', norm.includes('.studio/runs/test-run.json'));
      check('backup zip has exact entry docs/internal/qa.md', norm.includes('docs/internal/qa.md'));
    } catch (e) {
      check('backup zip expansion (skipped: ' + e.message + ')', false);
    } finally {
      fs.rmSync(tmpExtract, { recursive: true, force: true });
    }
  } else {
    check('backup on non-Windows: skipped (no Compress-Archive on this platform)', true);
  }

  // --- B2: backup succeeds when a run log is held open for append ---
  if (os.platform() === 'win32') {
    const logFile = path.join(studio, 'runs', 'live-run.log');
    fs.writeFileSync(logFile, 'initial log line\n');
    const fd = fs.openSync(logFile, 'a'); // hold open for append
    const b2Now = new Date(2026, 8, 1, 3, 0); // 2026-09-01
    try {
      const dest2 = await backup.backup({ HOME, now: b2Now });
      check('B2: backup with open file created zip', dest2 && fs.existsSync(dest2));
      check('B2: backup zip > 0 bytes', dest2 && fs.statSync(dest2).size > 0);
      // Verify the live log made it into the zip
      const tmpExtract2 = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-b2-'));
      try {
        execFileSync('powershell.exe', [
          '-NoProfile', '-NonInteractive', '-Command',
          'Expand-Archive -LiteralPath $env:ZIP -DestinationPath $env:DST -Force',
        ], { env: { ...process.env, ZIP: dest2, DST: tmpExtract2 }, windowsHide: true, timeout: 30000 });
        const files2 = [];
        function walk2(dir) {
          for (const e of fs.readdirSync(dir)) {
            const fp = path.join(dir, e);
            if (fs.statSync(fp).isDirectory()) walk2(fp);
            else files2.push(fp.replace(tmpExtract2 + path.sep, ''));
          }
        }
        walk2(tmpExtract2);
        check('B2: zip contains .studio/runs/live-run.log', files2.map((f) => f.split(path.sep).join('/')).includes('.studio/runs/live-run.log'));
      } finally {
        fs.rmSync(tmpExtract2, { recursive: true, force: true });
      }
    } finally {
      fs.closeSync(fd);
    }
  }

  // --- Prune old backups ---
  const backupDir = path.join(studio, 'backups');
  // 14 fake backups (leaving room for the real ones)
  for (let i = 0; i < 14; i++) {
    const d = `2026-01-${String(i + 1).padStart(2, '0')}`;
    fs.writeFileSync(path.join(backupDir, d + '.zip'), 'fake');
  }
  // Plus the 2 real zips from above = 16 total
  const beforeCount = fs.readdirSync(backupDir).length;
  check('backups exist before prune', beforeCount === 16);

  backup.pruneOld(backupDir, 14);
  const after = fs.readdirSync(backupDir);
  check('pruneOld: keeps 14', after.length === 14);
  check('pruneOld: keeps newest fake', after.includes('2026-01-14.zip'));
  check('pruneOld: drops oldest', !after.includes('2026-01-01.zip'));

  // --- Injected zipper / copier (OS independent) ---
  const stagingLeft = () => fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('studio-backup-')).sort().join();
  const listFiles = (dir, base = dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? listFiles(path.join(dir, e.name), base) : [path.relative(base, path.join(dir, e.name)).split(path.sep).join('/')]);
  {
    const h2 = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-inj-'));
    fs.cpSync(HOME, h2, { recursive: true });
    fs.rmSync(path.join(h2, '.studio', 'backups'), { recursive: true, force: true });
    const before = stagingLeft();

    // exact staged layout
    let entries = [];
    const okZip = async (src, destZip) => { entries = listFiles(src[0]); fs.writeFileSync(destZip, 'zipbytes'); };
    const d1 = await backup.backup({ HOME: h2, now: new Date(2026, 4, 1, 3, 0), zip: okZip });
    check('staged layout has .studio/runs/test-run.json and docs/internal/qa.md', entries.includes('.studio/runs/test-run.json') && entries.includes('docs/internal/qa.md') && entries.includes('.studio/roster.json'));
    check('complete backup has no MISSING.txt', !entries.includes('MISSING.txt') && d1 && fs.existsSync(d1));
    check('no .partial left after success', !fs.readdirSync(path.join(h2, '.studio', 'backups')).some((f) => f.endsWith('.partial')));

    // zip fails after writing bytes: no .partial, no <date>.zip, no staging dir left
    const badZip = async (src, destZip) => { fs.writeFileSync(destZip, 'half'); throw new Error('zip exploded'); };
    let threw = false;
    try { await backup.backup({ HOME: h2, now: new Date(2026, 4, 2, 3, 0), zip: badZip }); } catch { threw = true; }
    const bdir = path.join(h2, '.studio', 'backups');
    check('failed zip rejects', threw);
    check('failed zip leaves no .partial and no <date>.zip', !fs.existsSync(path.join(bdir, '2026-05-02.zip.partial')) && !fs.existsSync(path.join(bdir, '2026-05-02.zip')));
    check('failed zip leaves no studio-backup-* staging dir', stagingLeft() === before);

    // copy failure: runs/ cannot be copied -> retried, reported in MISSING.txt and the log, backup still produced
    const logs = [];
    let attempts = 0;
    const flakyCp = (src, dst) => { if (/runs/.test(src)) { attempts++; throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); } fs.cpSync(src, dst, { recursive: true }); };
    let miss = '';
    const capZip = async (src, destZip) => { entries = listFiles(src[0]); try { miss = fs.readFileSync(path.join(src[0], 'MISSING.txt'), 'utf8'); } catch {} fs.writeFileSync(destZip, 'zipbytes'); };
    const d3 = await backup.backup({ HOME: h2, now: new Date(2026, 4, 3, 3, 0), zip: capZip, cp: flakyCp, log: (m) => logs.push(m) });
    check('copy failure: item retried before giving up', attempts >= 2);
    check('copy failure: MISSING.txt in the archive names the failed file', entries.includes('MISSING.txt') && /\.studio\/runs\/test-run\.json/.test(miss));
    check('copy failure: logged as backup partial', logs.some((m) => /^backup partial: .*runs/.test(m)));
    check('copy failure: other sources still backed up', entries.includes('docs/internal/qa.md') && d3 && fs.existsSync(d3));
    check('copy failure: no staging dir left', stagingLeft() === before);
    fs.rmSync(h2, { recursive: true, force: true });
  }

  // --- Empty HOME: nothing to back up ---
  const emptyHOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-empty-'));
  const emptySrc = backup.collectSources(emptyHOME);
  check('empty HOME: no sources', emptySrc.length === 0);
  const emptyResult = await backup.backup({ HOME: emptyHOME });
  check('empty HOME: returns null', emptyResult === null);

  // Cleanup
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.rmSync(emptyHOME, { recursive: true, force: true });
}

run().then(() => {
  if (fail) { console.error(`${fail} failed`); process.exit(1); }
  console.log('backup selftest passed');
}).catch((e) => {
  console.error('backup selftest error:', e);
  process.exit(1);
});
