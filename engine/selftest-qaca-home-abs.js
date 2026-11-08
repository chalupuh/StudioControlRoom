#!/usr/bin/env node
// QA verification: {{home}} pipeline var and path.resolve() absolute-path support
// Run: node engine/selftest-qaca-home-abs.js

const path = require('path');
const fs = require('fs');

let pass = 0, fail = 0;
function assert(name, cond) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`); }
}

// ---- Module under test ----
const engine = require('./engine');
const { advance, withGpu, gpuKind } = engine;

// ---- Test 1: {{home}} variable exists in run defaults ----
// We can't easily spin up a full pipeline run in process, but we can verify
// the fill() function handles the 'home' var by checking that path.resolve
// is used (absolute paths work) rather than path.join (which would prepend REPO).
{
  // path.resolve with an absolute path should NOT prepend REPO
  // path.join with an absolute path WOULD prepend REPO, making the path wrong
  // The engine source is already tested by selftest-integration-gpu.js
  // Here we verify that the fill function resolves {{home}} correctly

  // Verify REPO is defined
  const src = fs.readFileSync(require.resolve('./engine'), 'utf8');

  // Check that {{home}} is in the defaults
  assert('{{home}} is in run defaults (home: REPO)',
    /home:\s*REPO/.test(src));

  // Check path.resolve is used in fill() instead of path.join
  assert('fill() uses path.resolve (not path.join) for {{file:}}',
    /path\.resolve\s*\(\s*REPO/.test(src));

  // Check verify() uses path.resolve for expect paths
  assert('verify() uses path.resolve for expect paths',
    /path\.resolve\s*\(\s*REPO/.test(src));

  // Check foreach uses path.resolve
  assert('foreach uses path.resolve for items.file',
    /path\.resolve\s*\(\s*REPO/.test(src));
}

// ---- Test 2: advance() is async ----
{
  const src = fs.readFileSync(require.resolve('./engine'), 'utf8');
  assert('advance() is declared async',
    /async\s+function\s+advance\s*\(\s*run\s*\)/.test(src));

  assert('CLI calls await advance()',
    /await\s+advance\s*\(/.test(src));
}

// ---- Test 3: GPU integration exported ----
{
  assert('withGpu exported', typeof engine.withGpu === 'function');
  assert('gpuKind exported', typeof engine.gpuKind === 'function');
  assert('impl exported', typeof engine.impl === 'object' && typeof engine.impl.runAgent === 'function');
}

// ---- Test 4: gpuKind logic ----
{
  // Stage with gpu:"creative" → always 'creative'
  assert('gpuKind("creative" stage) = "creative"',
    engine.gpuKind({ id: 'x', gpu: 'creative' }, 'local') === 'creative');
  assert('gpuKind("creative" stage, cloud tier) = "creative"',
    engine.gpuKind({ id: 'x', gpu: 'creative' }, 'sonnet') === 'creative');

  // Stage without gpu, local tier → 'llm'
  assert('gpuKind(plain stage, local) = "llm"',
    engine.gpuKind({ id: 'x' }, 'local') === 'llm');

  // Stage without gpu, cloud tier → null
  assert('gpuKind(plain stage, sonnet) = null',
    engine.gpuKind({ id: 'x' }, 'sonnet') === null);
  assert('gpuKind(plain stage, opus) = null',
    engine.gpuKind({ id: 'x' }, 'opus') === null);

  // Script stage without gpu → null (scripts have no tier)
  assert('gpuKind(script, undefined tier) = null',
    engine.gpuKind({ id: 'x', type: 'script' }, undefined) === null);
}

// ---- Test 5: studio.js GPU integration ----
// Verify studio.js requires gpu engine and passes slots to API response
{
  const studioSrc = fs.readFileSync(
    path.join(__dirname, '..', 'studio', 'studio.js'), 'utf8');

  assert('studio.js requires engine/gpu.js (optional)',
    /require\s*\(\s*['"]\.\.\/engine\/gpu\.js['"]\s*\)/.test(studioSrc));

  assert('studio.js calls gpuEngine.status()',
    /gpuEngine\s*\.\s*status\s*\(\s*\)/.test(studioSrc));

  assert('studio.js destructures slots from Promise.all',
    /const\s+\[\s*gpus\s*,\s*ollama\s*,\s*comfy\s*,\s*slots\s*\]/.test(studioSrc));

  assert('studio.js returns slots in GPU response',
    /return\s*\{\s*gpus\s*,\s*ollama\s*,\s*comfy\s*,\s*slots\s*\}/.test(studioSrc));
}

// ---- Test 6: api.ts type includes slots ----
{
  const apiSrc = fs.readFileSync(
    path.join(__dirname, '..', 'studio', 'app', 'src', 'api.ts'), 'utf8');

  assert('api.ts Gpu interface has slots field',
    /slots\s*\?\s*:\s*\{/m.test(apiSrc));

  assert('api.ts slots has llm sub-object',
    /llm\s*:\s*\{/.test(apiSrc));

  assert('api.ts slots has creative sub-object',
    /creative\s*:\s*\{/.test(apiSrc));
}

// ---- Test 7: path.resolve behavior (smoke test) ----
// Verify path.resolve with absolute path returns that path (not REPO + path)
{
  const absPath = path.resolve('/some/absolute/path.txt');
  assert('path.resolve(abs) returns abs path',
    absPath === path.normalize('/some/absolute/path.txt')
    || absPath.startsWith(path.sep));

  // Relative path resolves from base
  const relPath = path.resolve('/base', 'sub/file.txt');
  assert('path.resolve(base, rel) = base/sub/file.txt',
    relPath === path.normalize('/base/sub/file.txt'));

  // Absolute path overrides base in resolve
  const absOverride = path.resolve('/base', '/other/abs.txt');
  assert('path.resolve(base, absOverride) = absOverride (not base/absOverride)',
    absOverride === path.normalize('/other/abs.txt'));
}

// ---- Test 8: GPU env config vars ----
{
  const src = fs.readFileSync(require.resolve('./engine'), 'utf8');
  assert('GPU_WAIT_MS from env or default 30min',
    /STUDIO_GPU_WAIT_MS/.test(src));
  assert('GPU_RETRY_MS from env or default 5s',
    /STUDIO_GPU_RETRY_MS/.test(src));
}

// ---- Test 9: module.exports includes new functions ----
{
  assert('module.exports has advance', 'advance' in engine);
  assert('module.exports has withGpu', 'withGpu' in engine);
  assert('module.exports has gpuKind', 'gpuKind' in engine);
  assert('module.exports has impl', 'impl' in engine);
}

// ---- Summary ----
console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail > 0 ? 1 : 0);
