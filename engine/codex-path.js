// Locating and spawning the Codex CLI (ADR 0004), shared by the engine and the bench.
// Windows npm installs a `codex.cmd` shim next to node_modules/@openai/codex/bin/codex.js (in %APPDATA%/npm).
// Node refuses to spawn .cmd/.bat without a shell, but a shell leaves orphaned grandchildren when a timeout
// kills only cmd.exe. So we run the module with node directly when we can find it, and only fall back to a
// (quoted) shell command otherwise.
const fs = require('fs');
const path = require('path');

const isShim = (exe) => /\.(cmd|bat)$/i.test(exe || '');

// Resolution order: CODEX_EXE (or legacy CODX_EXE) -> <home>/.studio/machine.json codexExe -> install dir -> PATH.
function findCodex(home) {
  if (process.env.CODEX_EXE || process.env.CODX_EXE) return process.env.CODEX_EXE || process.env.CODX_EXE;
  if (home) { try { const c = JSON.parse(fs.readFileSync(path.join(home, '.studio', 'machine.json'), 'utf8')); if (c.codexExe) return c.codexExe; } catch {} }
  if (process.platform === 'win32') {
    const wins = [path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Codex', 'codex.cmd')];
    for (const p of wins) { if (fs.existsSync(p)) return p; }
  } else {
    const d = path.join(process.env.HOME || '', '.local', 'bin', 'codex');
    if (fs.existsSync(d)) return d;
  }
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat'] : [''];
  for (const dir of (process.env.PATH || process.env.Path || '').split(path.delimiter).filter(Boolean)) {
    for (const x of exts) { const p = path.join(dir, 'codex' + x); if (fs.existsSync(p)) return p; }
  }
  return null; // not installed: the codex tier is skipped
}

// The JS entry point the npm shim runs, found next to the shim itself.
function codexModule(exe) {
  if (!isShim(exe)) return null;
  const mod = path.join(path.dirname(exe), 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  return fs.existsSync(mod) ? mod : null;
}

const shellQuote = (s) => (/^[\w@%+=:,./\-]+$/.test(s) ? s : '"' + String(s).replace(/"/g, '""') + '"');

// Returns { command, args, shell } ready for spawnSync(command, args, { shell, ... }).
// opts.module=false skips the codex module lookup (for other CLIs, e.g. claude.cmd).
function codexSpawnSpec(exe, args, opts = {}) {
  const mod = opts.module === false ? null : codexModule(exe);
  if (mod) return { command: process.execPath, args: [mod, ...args], shell: false };
  if (isShim(exe)) return { command: [exe, ...args].map(shellQuote).join(' '), args: [], shell: true };
  return { command: exe, args, shell: false };
}

module.exports = { findCodex, codexModule, codexSpawnSpec, isShim };
