#!/usr/bin/env node
// Runs all engine self-tests. NPM-free: just `node tools/engine/test.js`.
// Exits non-zero if any test file fails.

const { spawnSync } = require('child_process');
const path = require('path');

const DIR = __dirname;
const SUITES = [
  { file: 'selftest.js',              label: 'parseRunOutput / verify / postmortem' },
  { file: 'selftest-team-lead.js',    label: 'resolveTeamLead' },
  { file: 'selftest-foreach.js',      label: 'foreach expansion (Windows paths)' },
  { file: 'selftest-mustchange.js',   label: 'build stages must change files' },
  { file: 'selftest-rework.js',       label: 'QA/review rework loop' },
  { file: 'selftest-stage-contracts.js',   label: 'requires / dod stage contracts' },
];

let anyFailed = false;

for (const suite of SUITES) {
  const fp = path.join(DIR, suite.file);
  console.log(`\n--- ${suite.label} (${suite.file}) ---`);
  const r = spawnSync('node', [fp], { stdio: 'inherit', timeout: 120000 });
  if (r.status !== 0) {
    anyFailed = true;
    console.error(`  FAIL: ${suite.file} exited ${r.status}${r.signal ? ` / ${r.signal}` : ''}`);
  } else {
    console.log(`  OK`);
  }
}

console.log();
if (anyFailed) {
  console.error('Some self-tests failed.');
  process.exit(1);
} else {
  console.log('All self-tests passed.');
  process.exit(0);
}
