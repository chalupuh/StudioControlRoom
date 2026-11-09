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

const { execSync } = require('child_process');
const path = require('path');

const syncScript = path.join(__dirname, '..', 'sync-codex-agents.js');

// Build args: always --check; optionally --home from caller
const args = ['--check'];
const home = process.argv.find((a, i) => i > 0 && a === '--home');
if (home) {
  args.push('--home', process.argv[process.argv.indexOf('--home') + 1]);
}

try {
  // Quote each arg to handle paths with spaces
  const quoted = args.map((a) => `"${a}"`);
  execSync(`node "${syncScript}" ${quoted.join(' ')}`, {
    stdio: 'inherit',
  });
  process.exit(0);
} catch (err) {
  if (err.status === 1) {
    // --check found drift
    process.exit(1);
  }
  // Unexpected error (script missing, source dir missing, etc.)
  process.exit(2);
}
