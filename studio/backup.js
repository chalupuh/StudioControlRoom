#!/usr/bin/env node
// Studio backup: `node studio/studio.js backup`
// Zips HOME/.studio/runs, .studio/checkpoints, roster.json, events.jsonl
// and docs/internal into HOME/.studio/backups/<YYYY-MM-DD>.zip.
// Keeps at most 14 most recent backups.
//
// Invoked by the supervisor once a day at 03:00, or on-demand from CLI.
// Uses a stage-then-zip pattern: copy sources to a temp dir (fs.cpSync handles
// files held open for append), zip the staging dir, then remove it in finally.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const os = require('os');
const machineLib = require('./machine');

const MAX_KEEP = 14;

// Reuse the shared studioHome resolver.
const studioHome = machineLib.studioHome;

/**
 * Zip source paths into a destination zip.
 * On Windows: powershell.exe Compress-Archive with $ErrorActionPreference='Stop'.
 * On Unix: bsdtar picks zip from .zip extension.
 * Returns a Promise for async use by the supervisor.
 */
function zipFiles(srcFiles, destZip) {
  return new Promise((resolve, reject) => {
    const cb = (err) => { if (err) reject(err); else resolve(); };
    if (os.platform() === 'win32') {
      // Pass paths through an env var so PowerShell never sees raw paths on the command line.
      // Prefix with 'Stop' so a partial archive produces a non-zero exit.
      execFile('powershell.exe', [
        '$ErrorActionPreference=\'Stop\'; Compress-Archive -LiteralPath $env:BK_SRC.Split(\'|\') -DestinationPath $env:BK_DEST -Force',
      ], {
        env: { ...process.env, BK_SRC: srcFiles.join('|'), BK_DEST: destZip },
        windowsHide: true,
        timeout: 600000, // docs/internal and runs/ grow large; 10 min should suffice.
      }, cb);
    } else {
      // bsdtar (or equivalent) picks zip from the .zip extension.
      execFile('tar', ['-a', '-cf', destZip, ...srcFiles], { timeout: 600000 }, cb);
    }
  });
}

function collectSources(HOME) {
  const src = [];
  const studio = path.join(HOME, '.studio');

  const items = [
    path.join(studio, 'runs'),
    path.join(studio, 'checkpoints'),
    path.join(studio, 'roster.json'),
    path.join(studio, 'events.jsonl'),
    path.join(HOME, 'docs', 'internal'),
  ];
  for (const p of items) {
    try {
      const st = fs.statSync(p);
      if (st.isDirectory() || st.isFile()) src.push(p);
    } catch {}
  }
  return src;
}

function pruneOld(backupDir, keep = MAX_KEEP) {
  if (!fs.existsSync(backupDir)) return;
  const entries = fs.readdirSync(backupDir)
    .filter((f) => f.endsWith('.zip'))
    .sort() // oldest first (YYYY-MM-DD sort)
    .reverse(); // newest first
  while (entries.length > keep) {
    const old = entries.pop();
    try { fs.unlinkSync(path.join(backupDir, old)); } catch {}
  }
}

/** Local-date helper (YYYY-MM-DD in local timezone). Used by backup name and supervisor dedup. */
function localDate(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

/**
 * @param {{ HOME?: string, now?: Date }} opts
 * Returns a Promise resolving to the path of the created zip, or null if nothing to back up.
 *
 * Stage-then-zip: copies sources to a temp dir so files held open for append
 * (e.g., runs/<id>.log while an engine is running) can be copied successfully.
 */
function backup(opts = {}) {
  const HOME = opts.HOME || studioHome();
  const now = opts.now || new Date();
  const srcFiles = collectSources(HOME);
  if (srcFiles.length === 0) {
    console.log('backup: nothing to back up (no runs/checkpoints/docs found).');
    return Promise.resolve(null);
  }

  const today = localDate(now);
  const backupDir = path.join(HOME, '.studio', 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const dest = path.join(backupDir, today + '.zip');

  // Stage sources to a temp directory — fs.cpSync handles files held open for append.
  const staging = path.join(os.tmpdir(), `studio-backup-${Date.now()}`);
  fs.mkdirSync(staging, { recursive: true });
  for (const src of srcFiles) {
    const name = path.basename(src);
    fs.cpSync(src, path.join(staging, name), { recursive: true });
  }

  console.log(`backup: creating ${dest}`);
  console.log(`backup: sources: ${srcFiles.join(', ')}`);

  return zipFiles([staging], dest).then(() => {
    // Verify
    const sz = fs.statSync(dest).size;
    console.log(`backup: ${dest} (${sz.toLocaleString()} bytes)`);

    // Prune old backups
    const before = fs.readdirSync(backupDir).filter((f) => f.endsWith('.zip')).length;
    pruneOld(backupDir);
    const after = fs.readdirSync(backupDir).filter((f) => f.endsWith('.zip')).length;
    if (before > MAX_KEEP) console.log(`backup: pruned ${before - after} old backup(s), keeping ${MAX_KEEP}`);

    return dest;
  }).finally(() => {
    // Always clean up staging directory after zip completes
    try { fs.rmSync(staging, { recursive: true, force: true }); } catch {}
  });
}

module.exports = { backup, collectSources, pruneOld, localDate, MAX_KEEP };

// CLI entry
if (require.main === module) {
  backup().then((result) => { if (!result) process.exit(1); }).catch((e) => { console.error(e); process.exit(1); });
}
