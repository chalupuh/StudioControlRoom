#!/usr/bin/env node
// check-config: CI gate — fail when generated .toml / AGENTS.md drift from source .md / CLAUDE.md
//
// Usage:
//   node tools/ci/check-config.js           auto-detect HQ root
//   node tools/ci/check-config.js --home X  override HQ root
//
// Exit 0  all generated files are up to date
// Exit 1  drift detected (generated files would differ)
// Exit 2  tooling error (missing script, missing source dir, etc.)

const { spawnSync } = require('child_process');
const path = require('path');

const syncScript = path.join(__dirname, '..', 'sync-codex-agents.js');

// Build args: always --check; optionally --home from caller
const args = ['--check'];
const home = process.argv.find((a, i) => i > 0 && a === '--home');
if (home) {
  args.push('--home', process.argv[process.argv.indexOf('--home') + 1]);
}

const r = spawnSync(process.execPath, [syncScript, ...args], { stdio: 'inherit' });
process.exit(r.status ?? 2);
