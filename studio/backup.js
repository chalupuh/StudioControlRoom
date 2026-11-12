#!/usr/bin/env node
// Studio backup: `node studio/studio.js backup`
// Zips HOME/.studio/runs, .studio/checkpoints, roster.json, events.jsonl
// and docs/internal into HOME/.studio/backups/<YYYY-MM-DD>.zip.
// Keeps at most 14 most recent backups.
//
// Invoked by the supervisor once a day at 03:00, or on-demand from CLI.
// Uses a stage-then-zip pattern: copy sources to a temp dir (fs.cpSync handles
// files held open for append), zip the staging dir, then remove it in finally.
//
// Archive layout preserves parent directories (.studio/ and docs/) so the zip
// can be restored with Expand-Archive <zip> -DestinationPath <HQ>.
//
// S6: Writes .partial first, renames on success, deletes .partial in finally.
// S7: async function with try/finally to avoid leaking staging on early throw.

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
 * On Unix: tar -C staging for correct archive layout.
 * Returns a Promise for async use by the supervisor.
 */
function zipFiles(srcFiles, destZip) {
  return new Promise((resolve, reject) => {
    const cb = (err) => { if (err) reject(err); else resolve(); };
    if (os.platform() === 'win32') {
      // srcFiles[0] is the staging dir; zip its CONTENTS (any extension works, unlike Compress-Archive,
      // which rejects '.partial'). Paths go through env vars; 'Stop' makes failures exit non-zero.
      const ps = "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; "
        + "if (Test-Path -LiteralPath $env:BK_DEST) { Remove-Item -LiteralPath $env:BK_DEST -Force }; "
        + "[System.IO.Compression.ZipFile]::CreateFromDirectory($env:BK_SRC, $env:BK_DEST, [System.IO.Compression.CompressionLevel]::Optimal, $false)";
      execFile('powershell.exe', ['-NoProfile', '-Command', ps], {
        env: { ...process.env, BK_SRC: srcFiles[0], BK_DEST: destZip },
        windowsHide: true,
        timeout: 600000, // docs/internal and runs/ grow large; 10 min should suffice.
      }, cb);
    } else {
      // Use -C staging so entries start with .studio/ and docs/ (not /tmp/studio-backup-...).
      const staging = srcFiles[0];
      execFile('tar', ['-C', staging, '-a', '-cf', destZip, '.studio', 'docs'], { timeout: 600000 }, cb);
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
 *
 * S6: Writes to .partial first, renames to final .zip on success.
 * S7: async with try/finally so staging is always cleaned up even on early throw.
 * S8: Stages under .studio/ and docs/ parents so the archive restores cleanly.
 */
async function backup(opts = {}) {
  const HOME = opts.HOME || studioHome();
  const now = opts.now || new Date();
  const log = opts.log || console.log;
  const cp = opts.cp || ((src, dst) => fs.cpSync(src, dst, { recursive: true })); // injectable for tests
  const zip = opts.zip || zipFiles;
  const srcFiles = collectSources(HOME);
  if (srcFiles.length === 0) {
    console.log('backup: nothing to back up (no runs/checkpoints/docs found).');
    return null;
  }

  const today = localDate(now);
  const backupDir = path.join(HOME, '.studio', 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const dest = path.join(backupDir, today + '.zip');
  // S6: write to .partial first, rename on success
  const partial = dest + '.partial';

  // S7: staging dir created inside the async function, cleaned up in finally
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-backup-'));
  try {
    // Stage each source under its HOME-relative path (.studio/..., docs/internal) so the zip restores in place.
    const missing = [];
    for (const src of srcFiles) {
      const rel = path.relative(HOME, src);
      const dst = path.join(staging, rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      missing.push(...copyItem(cp, src, dst, rel));
    }
    if (missing.length) {
      // Do not pretend the backup is complete: say what is missing, inside the archive and in the log.
      fs.writeFileSync(path.join(staging, 'MISSING.txt'), 'These items could not be copied (locked or unreadable):\n' + missing.join('\n') + '\n');
      log(`backup partial: ${missing.join(', ')}`);
    }

    console.log(`backup: creating ${dest}`);
    console.log(`backup: sources: ${srcFiles.join(', ')}`);

    await zip([staging], partial); // zips staging contents: entries start with .studio/ and docs/

    const sz = fs.statSync(partial).size;
    if (sz === 0) throw new Error('backup: created archive is empty');

    fs.renameSync(partial, dest);
    console.log(`backup: ${dest} (${sz.toLocaleString()} bytes)`);

    // Prune old backups (only count real .zip files, not .partial)
    const before = fs.readdirSync(backupDir).filter((f) => f.endsWith('.zip')).length;
    pruneOld(backupDir);
    const after = fs.readdirSync(backupDir).filter((f) => f.endsWith('.zip')).length;
    if (before > MAX_KEEP) console.log(`backup: pruned ${before - after} old backup(s), keeping ${MAX_KEEP}`);

    return dest;
  } catch (e) {
    try { fs.unlinkSync(partial); } catch {}
    throw e;
  } finally {
    try { fs.rmSync(staging, { recursive: true, force: true }); } catch {}
  }
}

/** Copy one source; retry once; for a directory that still fails, copy file by file and report only what failed.
 *  Returns the list of HOME-relative items that could not be copied (empty = complete). */
function copyItem(cp, src, dst, rel) {
  for (let i = 0; i < 2; i++) { try { cp(src, dst); return []; } catch {} }
  let isDir = false; try { isDir = fs.statSync(src).isDirectory(); } catch {}
  if (!isDir) return [rel];
  const failed = [];
  const walk = (s, d, r) => {
    let names; try { names = fs.readdirSync(s, { withFileTypes: true }); } catch { failed.push(r); return; }
    try { fs.mkdirSync(d, { recursive: true }); } catch {}
    for (const e of names) {
      const sp = path.join(s, e.name), dp = path.join(d, e.name), rp = r + '/' + e.name;
      if (e.isDirectory()) { walk(sp, dp, rp); continue; }
      let ok = false;
      for (let i = 0; i < 2 && !ok; i++) { try { cp(sp, dp); ok = true; } catch {} }
      if (!ok) failed.push(rp);
    }
  };
  walk(src, dst, rel.split(path.sep).join('/'));
  return failed;
}

module.exports = { backup, collectSources, pruneOld, localDate, MAX_KEEP, zipFiles };

// CLI entry
if (require.main === module) {
  backup().then((result) => { if (!result) process.exit(1); }).catch((e) => { console.error(e); process.exit(1); });
}
