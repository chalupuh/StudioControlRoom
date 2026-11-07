#!/usr/bin/env node
// Self-test for stage contracts: requires (pre-check) and dod (post-check headings).
// Run: node tools/engine/selftest-stage-contracts.js

const fs = require('fs');
const path = require('path');
const os = require('os');
const { checkRequires, verify, fill, REPO } = require('./engine');

const TEST_DIR = path.join(os.tmpdir(), `studio-selftest-stage-contracts-${process.pid}-${Date.now()}`);
fs.mkdirSync(TEST_DIR, { recursive: true });

let pass = 0, fail = 0;
function assert(name, cond) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`); }
}

// ---- Test block 1: checkRequires — happy path (all paths present) ----
{
  const reqFile = path.join(TEST_DIR, 'requires-ok', 'input.txt');
  fs.mkdirSync(path.dirname(reqFile), { recursive: true });
  fs.writeFileSync(reqFile, 'hello');
  const stage = { requires: [path.relative(REPO, reqFile)] };
  const missing = checkRequires(stage, {});
  assert('checkRequires: all paths present → empty missing', missing.length === 0);
}

// ---- Test block 2: checkRequires — one missing path ----
{
  const present = path.join(TEST_DIR, 'requires-one-missing', 'a.txt');
  fs.mkdirSync(path.dirname(present), { recursive: true });
  fs.writeFileSync(present, 'exists');
  const stage = {
    requires: [
      path.relative(REPO, present),
      path.join(TEST_DIR, 'requires-one-missing', 'b.txt'), // does not exist
    ],
  };
  const missing = checkRequires(stage, {});
  assert('checkRequires: one missing → one entry in missing', missing.length === 1);
  assert('checkRequires: missing entry names the file', missing[0].includes('b.txt'));
}

// ---- Test block 3: checkRequires — all paths missing ----
{
  const stage = {
    requires: [
      path.join(TEST_DIR, 'requires-all-missing', 'x.txt'),
      path.join(TEST_DIR, 'requires-all-missing', 'y.txt'),
    ],
  };
  const missing = checkRequires(stage, {});
  assert('checkRequires: all missing → two entries', missing.length === 2);
}

// ---- Test block 4: checkRequires — empty requires array ----
{
  const missing = checkRequires({ requires: [] }, {});
  assert('checkRequires: empty requires → empty missing', missing.length === 0);
}

// ---- Test block 5: checkRequires — no requires field at all ----
{
  const missing = checkRequires({ type: 'agent', id: 'test' }, {});
  assert('checkRequires: no requires field → empty missing', missing.length === 0);
}

// ---- Test block 6: checkRequires — path with template variable ----
{
  const varsFile = path.join(TEST_DIR, 'requires-vars', 'data.json');
  fs.mkdirSync(path.dirname(varsFile), { recursive: true });
  fs.writeFileSync(varsFile, '{}');
  const vars = { workDir: path.join(TEST_DIR, 'requires-vars') };
  const stage = { requires: ['{{workDir}}/data.json'] };
  const missing = checkRequires(stage, vars);
  assert('checkRequires: template var resolved → no missing', missing.length === 0);
}

// ---- Test block 7: verify with dod — all headings present ----
{
  const dodFile = path.join(TEST_DIR, 'dod-ok', 'README.md');
  fs.mkdirSync(path.dirname(dodFile), { recursive: true });
  fs.writeFileSync(dodFile, '# Title\n\n## Introduction\n\nSome text.\n\n## API Design\n\nMore text.\n');
  const stage = {
    dod: [{ file: path.relative(REPO, dodFile), headings: ['Introduction', 'API Design'] }],
  };
  const res = { error: null, hitTurnCap: false, result: 'done' };
  const problems = verify(stage, {}, res);
  assert('verify dod: all headings present → no problems', problems.length === 0);
}

// ---- Test block 8: verify with dod — one heading missing ----
{
  const dodFile = path.join(TEST_DIR, 'dod-one-missing', 'README.md');
  fs.mkdirSync(path.dirname(dodFile), { recursive: true });
  fs.writeFileSync(dodFile, '# Title\n\n## Introduction\n\nSome text.\n');
  const stage = {
    dod: [{ file: path.relative(REPO, dodFile), headings: ['Introduction', 'Testing'] }],
  };
  const res = { error: null, hitTurnCap: false, result: 'done' };
  const problems = verify(stage, {}, res);
  assert('verify dod: one heading missing → has dod problem', problems.some((p) => p.includes('dod')));
  assert('verify dod: problem names the missing heading', problems.some((p) => p.includes('Testing')));
  assert('verify dod: no false positives for present heading', !problems.some((p) => p.includes('Introduction')));
}

// ---- Test block 9: verify with dod — file does not exist ----
{
  const stage = {
    dod: [{ file: path.join(TEST_DIR, 'dod-no-file', 'missing.md'), headings: ['Intro', 'Setup'] }],
  };
  const res = { error: null, hitTurnCap: false, result: 'done' };
  const problems = verify(stage, {}, res);
  assert('verify dod: file missing → both headings reported', problems.filter((p) => p.includes('dod')).length === 2);
  assert('verify dod: problem mentions file does not exist', problems.some((p) => p.includes('does not exist')));
}

// ---- Test block 10: verify with dod — multiple files, mixed results ----
{
  const fileA = path.join(TEST_DIR, 'dod-multi', 'a.md');
  const fileBDir = path.join(TEST_DIR, 'dod-multi');
  fs.mkdirSync(fileBDir, { recursive: true });
  fs.writeFileSync(fileA, '## Alpha\n## Beta\n');
  const stage = {
    dod: [
      { file: path.relative(REPO, fileA), headings: ['Alpha', 'Beta'] },          // both present
      { file: path.join(TEST_DIR, 'dod-multi', 'nonexistent.md'), headings: ['Gamma'] }, // file missing
    ],
  };
  const res = { error: null, hitTurnCap: false, result: 'done' };
  const problems = verify(stage, {}, res);
  const dodProblems = problems.filter((p) => p.includes('dod'));
  assert('verify dod multi: only the missing-file heading is flagged', dodProblems.length === 1);
  assert('verify dod multi: flagged heading names Gamma', dodProblems[0].includes('Gamma'));
}

// ---- Test block 11: verify with dod — h3 sub-headings detected ----
{
  const dodFile = path.join(TEST_DIR, 'dod-h3', 'spec.md');
  fs.mkdirSync(path.dirname(dodFile), { recursive: true });
  fs.writeFileSync(dodFile, '## Section\n\n### Sub-heading\n\nContent.\n\n### Another\n');
  const stage = {
    dod: [{ file: path.relative(REPO, dodFile), headings: ['Sub-heading', 'Another'] }],
  };
  const res = { error: null, hitTurnCap: false, result: 'done' };
  const problems = verify(stage, {}, res);
  assert('verify dod: h3 headings detected → no problems', problems.length === 0);
}

// ---- Test block 12: verify with dod — heading with special regex chars ----
{
  const dodFile = path.join(TEST_DIR, 'dod-special', 'readme.md');
  fs.mkdirSync(path.dirname(dodFile), { recursive: true });
  fs.writeFileSync(dodFile, '## Setup (v2.0)\n\nContent.\n');
  const stage = {
    dod: [{ file: path.relative(REPO, dodFile), headings: ['Setup (v2.0)'] }],
  };
  const res = { error: null, hitTurnCap: false, result: 'done' };
  const problems = verify(stage, {}, res);
  assert('verify dod: special chars in heading (parentheses) → no problems', problems.length === 0);
}

// ---- Test block 13: verify with dod + other checks — dod problems stack with existing problems ----
{
  const dodFile = path.join(TEST_DIR, 'dod-stack', 'readme.md');
  fs.mkdirSync(path.dirname(dodFile), { recursive: true });
  fs.writeFileSync(dodFile, '## OnlyThis\n');
  const stage = {
    dod: [{ file: path.relative(REPO, dodFile), headings: ['OnlyThis', 'MissingHeading'] }],
  };
  const res = { error: 'simulated', hitTurnCap: false, result: '' };
  const problems = verify(stage, {}, res);
  assert('verify dod stacking: has run error problem', problems.some((p) => p.startsWith('run error:')));
  assert('verify dod stacking: has empty final answer', problems.some((p) => p === 'empty final answer'));
  assert('verify dod stacking: has dod problem for MissingHeading', problems.some((p) => p.includes('MissingHeading')));
  assert('verify dod stacking: no dod problem for present heading', !problems.some((p) => p.includes('OnlyThis')));
}

// ---- Test block 14: verify with dod — empty headings array is a no-op ----
{
  const stage = { dod: [{ file: 'some/file.md', headings: [] }] };
  const res = { error: null, hitTurnCap: false, result: 'done' };
  const problems = verify(stage, {}, res);
  assert('verify dod: empty headings array → no problems', problems.length === 0);
}

// ---- Test block 15: verify with dod — template variable in file path ----
{
  const dodFile = path.join(TEST_DIR, 'dod-var', 'out.md');
  fs.mkdirSync(path.dirname(dodFile), { recursive: true });
  fs.writeFileSync(dodFile, '## Results\n');
  const vars = { outputDir: path.join(TEST_DIR, 'dod-var') };
  const stage = {
    dod: [{ file: '{{outputDir}}/out.md', headings: ['Results'] }],
  };
  const res = { error: null, hitTurnCap: false, result: 'done' };
  const problems = verify(stage, vars, res);
  assert('verify dod: template var in file path → heading found', problems.length === 0);
}

// Cleanup
try { fs.rmSync(TEST_DIR, { recursive: true }); } catch {}

// ---- Summary ----
console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail > 0 ? 1 : 0);
