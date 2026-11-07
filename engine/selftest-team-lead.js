#!/usr/bin/env node
// Self-test for resolveTeamLead() — agent selection from design.md "Team:" line.
// Run: node tools/engine/selftest-team-lead.js

const fs = require('fs');
const path = require('path');
const os = require('os');
const { resolveTeamLead } = require('./engine');

const TEST_DIR = path.join(os.tmpdir(), 'studio-selftest-team-lead');

const tests = [
  // --- Priority and presence tests ---
  {
    name: 'frontend-dev listed first',
    content: '# Design\nTeam: frontend-dev, qa-engineer\n## Milestone 1\nstuff',
    expect: 'frontend-dev',
  },
  {
    name: 'mobile-dev only',
    content: '# Design\nTeam: mobile-dev, qa-engineer\n## Milestone 1\nstuff',
    expect: 'mobile-dev',
  },
  {
    name: 'backend-dev and mobile-dev present: priority picks mobile-dev',
    content: '# Design\nTeam: backend-dev, mobile-dev, qa\n## Milestone 1\nstuff',
    expect: 'mobile-dev',
  },
  {
    name: 'mobile-dev listed first but frontend-dev present: priority picks frontend-dev',
    content: '# Design\nTeam: mobile-dev, frontend-dev, qa\n## Milestone 1\nstuff',
    expect: 'frontend-dev',
  },
  {
    name: 'all three: picks frontend-dev (first in candidate order)',
    content: '# Design\nTeam: frontend-dev, mobile-dev, backend-dev, qa\n## Milestone 1\nstuff',
    expect: 'frontend-dev',
  },
  {
    name: 'Team line with other roles only (no build role) → default',
    content: '# Design\nTeam: qa-engineer, code-reviewer\n## Milestone 1\nstuff',
    expect: 'mobile-dev',
  },
  {
    name: 'no Team line at all → default',
    content: '# Design\nJust some text without a team line.\n## Milestone 1\nstuff',
    expect: 'mobile-dev',
  },
  {
    name: 'empty file → default',
    content: '',
    expect: 'mobile-dev',
  },
  {
    name: 'missing file → default',
    missing: true,
    expect: 'mobile-dev',
  },
  // --- Regex: case-insensitive ---
  {
    name: 'team: lowercase spelling',
    content: '# Design\nteam: mobile-dev, qa\n## Milestone 1\nstuff',
    expect: 'mobile-dev',
  },
  {
    name: 'TEAM: uppercase spelling',
    content: '# Design\nTEAM: frontend-dev, qa\n## Milestone 1\nstuff',
    expect: 'frontend-dev',
  },
  // --- Regex: bold markdown ---
  {
    name: '**Team:** bold markdown',
    content: '# Design\n**Team:** frontend-dev, qa-engineer\n## Milestone 1\nstuff',
    expect: 'frontend-dev',
  },
  {
    name: '*Team:* single-asterisk bold',
    content: '# Design\n*Team:* mobile-dev, qa-engineer\n## Milestone 1\nstuff',
    expect: 'mobile-dev',
  },
  // --- Regex: list bullets ---
  {
    name: '- Team: dash bullet',
    content: '# Design\n- Team: frontend-dev, qa-engineer\n## Milestone 1\nstuff',
    expect: 'frontend-dev',
  },
  {
    name: '* Team: asterisk bullet',
    content: '# Design\n* Team: mobile-dev, qa-engineer\n## Milestone 1\nstuff',
    expect: 'mobile-dev',
  },
  {
    name: '  - Team: indented dash bullet',
    content: '# Design\n  - Team: backend-dev, qa-engineer\n## Milestone 1\nstuff',
    expect: 'backend-dev',
  },
  // --- Path: absolute ---
  {
    name: 'absolute path is accepted',
    content: '# Design\nTeam: backend-dev, qa\n## Milestone 1\nstuff',
    expect: 'backend-dev',
  },
  // --- Path: docs/specs/<slug>.design.md structure ---
  {
    name: 'docs/specs/<slug>.design.md sub-path accepted',
    content: '# Design\n**Team:** backend-dev, qa-engineer\n## Milestone 1\nstuff',
    subDir: 'docs/specs',
    fileName: 'test-slug.design.md',
    expect: 'backend-dev',
  },
];

// Setup
fs.mkdirSync(TEST_DIR, { recursive: true });
let passed = 0, failed = 0;

for (const t of tests) {
  let fp;
  if (t.missing) {
    fp = path.join(TEST_DIR, 'design.md');
    try { fs.unlinkSync(fp); } catch {}
  } else if (t.subDir) {
    const dir = path.join(TEST_DIR, t.subDir);
    fs.mkdirSync(dir, { recursive: true });
    fp = path.join(dir, t.fileName);
    fs.writeFileSync(fp, t.content);
  } else {
    fp = path.join(TEST_DIR, 'design.md');
    fs.writeFileSync(fp, t.content);
  }

  const got = resolveTeamLead(fp);
  const ok = got === t.expect;
  if (ok) { passed++; console.log(`  ✓ ${t.name}`); }
  else { failed++; console.log(`  ✗ ${t.name}: expected "${t.expect}", got "${got}"`); }
}

// Cleanup
try { fs.rmSync(TEST_DIR, { recursive: true }); } catch {}

console.log(`\n${passed}/${tests.length} passed${failed ? ` (${failed} failed)` : ''}`);
process.exit(failed > 0 ? 1 : 0);
