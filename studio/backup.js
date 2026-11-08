#!/usr/bin/env node
// Studio backup: `node studio/studio.js backup`
// Zips HOME/.studio/runs, .studio/checkpoints, roster.json, events.jsonl
// and docs/internal into HOME/.studio/backups/<YYYY-MM-DD>.zip.
// Keeps at most 14 most recent backups.
//
// Invoked by the supervisor once a day at 03:00, or on-demand from CLI.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const os = require('os');

const MAX_KEEP = 14;

function studioHome() {
  if (process.env.STUDIO_HOME) return path.resolve(process.env.STUDIO_HOME);
  try { const c = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'studio.home.json'), 'utf8')); if (c.home) return path.resolve(c.home); } catch {}
  return path.resolve(__dirname, '..');
}

function zipFiles(srcFiles, destZip) {
  // Use PowerShell to create a zip on Windows (built-in Compress-Archive).
  // On other platforms, fallback to a simple tar if available, else node.zip.
  if (os.platform() === 'win32') {
    const args = srcFiles.map((f) => "'" + f.replace("'", "''") + "'").join(', ');
    execSync(
      `Compress-Archive -Path ${args} -DestinationPath '${destZip.replace("'", "''")}' -Force`,
      { encoding: 'utf8', windowsHide: true, timeout: 120000 }
    );
  } else {
    // Best-effort tar on unix
    const tmpTar = destZip + '.tar';
    execSync(`tar cf "${tmpTar}" ${srcFiles.join(' ')}`, { timeout: 120000 });
    try { execSync(`rm "${destZip}"`, { encoding: 'utf8' }); } catch {}
    execSync(`mv "${tmpTar}" "${destZip}"`, { encoding: 'utf8' });
  }
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

/**
 * @param {{ HOME?: string }} opts
 * Returns the path to the created zip, or null if nothing to back up.
 */
function backup(opts = {}) {
  const HOME = opts.HOME || studioHome();
  const srcFiles = collectSources(HOME);
  if (srcFiles.length === 0) {
    console.log('backup: nothing to back up (no runs/checkpoints/docs found).');
    return null;
  }

  const today = new Date().toISOString().slice(0, 10);
  const backupDir = path.join(HOME, '.studio', 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const dest = path.join(backupDir, today + '.zip');

  console.log(`backup: creating ${dest}`);
  console.log(`backup: sources: ${srcFiles.join(', ')}`);
  zipFiles(srcFiles, dest);

  // Verify
  const sz = fs.statSync(dest).size;
  console.log(`backup: ${dest} (${sz.toLocaleString()} bytes)`);

  // Prune old backups
  const before = fs.existsSync(backupDir) ? fs.readdirSync(backupDir).filter((f) => f.endsWith('.zip')).length : 0;
  pruneOld(backupDir);
  const after = fs.readdirSync(backupDir).filter((f) => f.endsWith('.zip')).length;
  if (before > MAX_KEEP) console.log(`backup: pruned ${before - after} old backup(s), keeping ${MAX_KEEP}`);

  return dest;
}

module.exports = { backup, collectSources, pruneOld, MAX_KEEP };

// CLI entry
if (require.main === module) {
  const result = backup();
  if (!result) process.exit(1);
}
