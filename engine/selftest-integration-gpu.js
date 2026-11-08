#!/usr/bin/env node
// Integration test: engine.js advance() <-> gpu.js (real slot files, stubbed runAgent).
// Run: node engine/selftest-integration-gpu.js

const fs = require('fs');
const path = require('path');
const os = require('os');

const TEST_HOME = path.join(os.tmpdir(), 'studio-gpu-int-test-' + process.pid);
fs.mkdirSync(path.join(TEST_HOME, '.studio'), { recursive: true });
process.env.STUDIO_HOME = TEST_HOME;
process.env.STUDIO_GPU_RETRY_MS = '50';
process.env.STUDIO_GPU_POLL_MS = '50';
process.env.STUDIO_OLLAMA_PORT = '1'; // unload is best-effort; nothing listens

const gpu = require('./gpu');
const engine = require('./engine');

let passed = 0, failed = 0;
const ok = (label, cond) => { if (cond) { passed++; console.log(`  ✓ ${label}`); } else { failed++; console.log(`  ✗ ${label}`); } };
process.on('exit', () => { try { fs.rmSync(TEST_HOME, { recursive: true, force: true }); } catch {} });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const events = () => { try { return fs.readFileSync(path.join(TEST_HOME, '.studio', 'events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const mkRun = (id, stages) => ({ id, pipeline: 't', vars: {}, stages, cursor: 0, gates: {}, history: [], status: 'running' });
const okRes = (tier) => ({ tier, model: tier, secs: 0, cloud: tier === 'sonnet' || tier === 'opus', result: 'done', error: null, usage: null });

(async () => {
  // 1. local attempt: llm slot held during runAgent, released after
  let seen = null;
  engine.impl.runAgent = (stage, tier) => { seen = gpu.status().llm.used; return okRes(tier); };
  let run = mkRun('r1', [{ id: 's1', agent: 'a', tier: 'local', task: 'x' }]);
  await engine.advance(run);
  ok('local: llm slot held during attempt', seen === 1);
  ok('local: slot released after', gpu.status().llm.used === 0);
  ok('local: run done', run.status === 'done');

  // 2. cloud tier: no slot, never waits (even with creative running)
  const c = await gpu.acquire('creative', {});
  seen = null;
  engine.impl.runAgent = (stage, tier) => { seen = gpu.status().llm.used; return okRes(tier); };
  run = mkRun('r2', [{ id: 's2', agent: 'a', tier: 'sonnet', task: 'x' }]);
  const t0 = Date.now();
  await engine.advance(run);
  ok('cloud: no slot taken', seen === 0);
  ok('cloud: did not wait', Date.now() - t0 < 1000 && run.status === 'done');
  gpu.release(c);

  // 3. failed local attempts release per attempt; escalation to cloud holds no slot
  const used = [];
  engine.impl.runAgent = (stage, tier) => { used.push([tier, gpu.status().llm.used]); return tier === 'sonnet' ? okRes(tier) : { ...okRes(tier), result: '' }; };
  run = mkRun('r3', [{ id: 's3', agent: 'a', tier: 'local', task: 'x' }]);
  await engine.advance(run);
  ok('ladder: local attempts hold 1, cloud holds 0', JSON.stringify(used) === JSON.stringify([['local', 1], ['local', 1], ['sonnet', 0]]));
  ok('ladder: nothing leaked', gpu.status().llm.used === 0);

  // 4. runAgent throwing still releases
  engine.impl.runAgent = () => { throw new Error('boom'); };
  run = mkRun('r4', [{ id: 's4', agent: 'a', tier: 'local', task: 'x' }]);
  let threw = false;
  try { await engine.advance(run); } catch { threw = true; }
  ok('throw: propagates and slot released', threw && gpu.status().llm.used === 0);

  // 5. creative stage: exclusive slot held during run; llm waits with a progress event
  let creativeSeen = null;
  engine.impl.runAgent = (stage, tier) => { const s = gpu.status(); creativeSeen = s.creative.running; return okRes(tier); };
  run = mkRun('r5', [{ id: 'cre', agent: 'image-artist', tier: 'local', gpu: 'creative', task: 'x' }]);
  await engine.advance(run);
  ok('creative: exclusive slot held during attempt', creativeSeen === true);
  ok('creative: released after', !gpu.status().creative.running && run.status === 'done');

  // 6. llm waits while creative runs, emits progress, proceeds after release
  const cr = await gpu.acquire('creative', {});
  engine.impl.runAgent = (stage, tier) => okRes(tier);
  run = mkRun('r6', [{ id: 'w1', agent: 'a', tier: 'local', task: 'x' }]);
  const p = engine.advance(run);
  await sleep(300);
  ok('wait: still pending while creative runs', run.status === 'running' && run.cursor === 0);
  ok('wait: "waiting for GPU" progress emitted once', events().filter((e) => e.type === 'progress' && /waiting for GPU/.test(e.message)).length === 1);
  gpu.release(cr);
  await p;
  ok('wait: proceeds after release', run.status === 'done' && gpu.status().llm.used === 0);

  // 7. creative waits for running llm slots, then runs
  const l = await gpu.acquire('llm', {});
  let cStarted = false;
  engine.impl.runAgent = (stage, tier) => { cStarted = true; return okRes(tier); };
  run = mkRun('r7', [{ id: 'cw', agent: 'image-artist', tier: 'local', gpu: 'creative', task: 'x' }]);
  const p7 = engine.advance(run);
  await sleep(300);
  ok('creative waits while llm slot held', !cStarted);
  gpu.release(l);
  await p7;
  ok('creative runs after llm released', cStarted && run.status === 'done');

  // 8. script stage marked creative takes the exclusive slot; plain script takes none
  const cmd = `node -e "process.exit(0)"`;
  run = mkRun('r8', [{ id: 'sc', type: 'script', run: cmd, gpu: 'creative' }, { id: 'sp', type: 'script', run: cmd }]);
  await engine.advance(run);
  ok('script: runs and releases', run.status === 'done' && !gpu.status().creative.running);
  ok('gpuKind: plain script none, local llm, cloud none', engine.gpuKind({}) === null && engine.gpuKind({}, 'local-fast') === 'llm' && engine.gpuKind({}, 'opus') === null);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
