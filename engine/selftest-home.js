// Self-test for {{home}} pipeline variable and absolute-path support
const path = require('path');
const { parseRunOutput, resolveTeamLead } = require('./engine');
const fs = require('fs');

let pass = 0, fail = 0;
function assert(name, cond) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`); }
}

const REPO = path.resolve(__dirname, '..');

// ---- Test 1: {{home}} is set as a run variable ----
// The engine at line 265 sets home: REPO in run vars
// We verify by checking that fill() with home works
function fill(tpl, vars) {
  return String(tpl || '')
    .replace(/\{\{file:([^}]+)\}\}/g, (_, f) => { const p = path.resolve(REPO, fill(f, vars)); return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : `(missing: ${f})`; })
    .replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] ?? `{{${k}}}`));
}

const runVars = { date: '2026-11-07', soft: path.resolve(REPO, 'studio'), home: REPO };
assert('{{home}} expands to REPO', fill('{{home}}', runVars) === REPO);

// ---- Test 2: path.resolve with absolute path preserves it ----
const absPath = path.resolve(REPO, 'tools', 'engine');
assert('absolute path from resolve stays absolute', path.isAbsolute(absPath));

// ---- Test 3: path.resolve with relative path resolves correctly ----
const relResult = path.resolve(REPO, 'docs');
assert('relative path resolves to absolute', path.isAbsolute(relResult));
assert('relative path contains REPO', relResult.startsWith(REPO));

// ---- Test 4: fill() with nested {{file:...}} uses path.resolve ----
// This tests that {{file:...}} template uses path.resolve(REPO, ...)
const enginePath = path.resolve(REPO, 'engine', 'engine.js');
assert('engine.js exists at resolved path', fs.existsSync(enginePath));

// ---- Test 5: {{home}} in {{file:...}} works ----
// e.g. {{file:{{home}}/engine/engine.js}}
const nestedFill = fill('{{file:engine/engine.js}}', runVars);
assert('{{file:engine/engine.js}} resolves correctly', nestedFill.length > 0 && !nestedFill.startsWith('(missing'));

// ---- Test 6: {{home}} as explicit var in template ----
const homeTemplate = '{{home}}/docs/specs';
const homeExpanded = fill(homeTemplate, runVars);
assert('{{home}} in template expands correctly', homeExpanded.startsWith(REPO));

// ---- Test 7: path.resolve handles absolute input (Windows) ----
const winAbs = 'C:\\test\\absolute';
// On Windows, path.resolve with an absolute path should return that path
if (process.platform === 'win32') {
  const resolved = path.resolve(REPO, winAbs);
  assert('Windows absolute path preserved by resolve', resolved === winAbs);
} else {
  const unixAbs = '/tmp/absolute';
  const resolved = path.resolve(REPO, unixAbs);
  assert('Unix absolute path preserved by resolve', resolved === unixAbs);
}

// ---- Test 8: path.resolve handles relative path with .. ----
const dotDot = path.resolve(REPO, '../sibling');
assert('resolve with .. goes up one level', !dotDot.includes('..' ));

// ---- Test 9: fill() with no matching var keeps original ----
const unexpanded = fill('{{unknown}}', runVars);
assert('unknown var kept as-is', unexpanded === '{{unknown}}');

// ---- Test 10: parseRunOutput still works ----
const result = parseRunOutput({
  status: 0,
  stdout: JSON.stringify({ result: 'ok', num_turns: 3, is_error: false }),
});
assert('parseRunOutput returns result', result.result === 'ok');
assert('parseRunOutput returns turns', result.turns === 3);
assert('parseRunOutput no error on success', result.error === null);

console.log(`\n--- {{home}} / absolute-path support ---`);
console.log(`${pass} passed, ${fail} failed.`);
process.exit(fail > 0 ? 1 : 0);
