#!/usr/bin/env node
// Self-test for gpu.js — GPU slot scheduler (includes real cross-process tests)
// Run: node engine/selftest-gpu.js
//
// The same file doubles as the child-process worker:
//   node selftest-gpu.js --child <hold-llm|hold-creative|stress> [...]

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { spawn, spawnSync } = require('child_process');

process.env.STUDIO_GPU_POLL_MS = process.env.STUDIO_GPU_POLL_MS || '50';

// ---------------- child worker ----------------
if (process.argv[2] === '--child') {
  const gpu = require('./gpu');
  const mode = process.argv[3];
  const out = (s) => process.stdout.write(s + '\n');
  const holdUntilStdinEnds = (t) => {
    process.stdin.resume();
    process.stdin.on('end', () => { try { gpu.release(t); } catch {} process.exit(0); });
  };
  (async () => {
    if (mode === 'hold-llm') {
      try { const t = await gpu.acquire('llm'); out('OK ' + t); holdUntilStdinEnds(t); }
      catch (e) { out('ERR ' + e.message); process.exit(0); }
    } else if (mode === 'hold-creative') {
      out('WAITING');
      try { const t = await gpu.acquire('creative'); out('ACQUIRED ' + t); holdUntilStdinEnds(t); }
      catch (e) { out('ERR ' + e.message); process.exit(0); }
    } else if (mode === 'stress') {
      let got = 0;
      for (let i = 0; i < 15; i++) {
        try {
          const t = await gpu.acquire('llm'); got++;
          await new Promise((r) => setTimeout(r, 15));
          gpu.release(t);
        } catch { await new Promise((r) => setTimeout(r, 5)); }
      }
      out('DONE ' + got);
    }
  })();
  return;
}

// ---------------- parent ----------------
const TEST_HOME = path.join(os.tmpdir(), 'studio-gpu-test-' + process.pid);
const GPU_DIR = path.join(TEST_HOME, '.studio', 'gpu');
fs.mkdirSync(GPU_DIR, { recursive: true });
process.env.STUDIO_HOME = TEST_HOME;
const gpu = require('./gpu');

let passed = 0, failed = 0;
function ok(label, cond) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rejects = (p) => p.then(() => null, (e) => e.message);
function wipe() {
  try { fs.rmSync(GPU_DIR, { recursive: true, force: true }); } catch {}
  fs.mkdirSync(GPU_DIR, { recursive: true });
}
function setCfg(c) { fs.writeFileSync(path.join(TEST_HOME, '.studio', 'gpu.json'), JSON.stringify(c)); }
function deadPid() {
  const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']);
  return Number(r.stdout.toString());
}

// Spawn a child worker; collect its stdout lines.
const children = [];
function child(mode) {
  const p = spawn(process.execPath, [__filename, '--child', mode], {
    env: { ...process.env, STUDIO_HOME: TEST_HOME }, stdio: ['pipe', 'pipe', 'inherit'],
  });
  const c = { p, lines: [], exited: false };
  let buf = '';
  p.stdout.on('data', (d) => {
    buf += d; let i;
    while ((i = buf.indexOf('\n')) >= 0) { c.lines.push(buf.slice(0, i)); buf = buf.slice(i + 1); }
  });
  c.exit = new Promise((r) => p.on('exit', () => { c.exited = true; r(); }));
  c.waitLine = async (prefix, ms = 8000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const l = c.lines.find((x) => x.startsWith(prefix));
      if (l) return l;
      await sleep(20);
    }
    return null;
  };
  c.stop = () => { try { p.stdin.end(); } catch {} return c.exit; };
  children.push(c);
  return c;
}

process.on('exit', () => {
  for (const c of children) { try { c.p.kill(); } catch {} }
  gpu.stopPoll();
  try { fs.rmSync(TEST_HOME, { recursive: true, force: true }); } catch {}
});

function mockOllama() {
  const calls = [];
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (d) => b += d);
    req.on('end', () => { calls.push({ url: req.url, method: req.method, body: JSON.parse(b || '{}') }); res.end('{}'); });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, calls, port: srv.address().port })));
}

(async () => {
  console.log('  === status defaults ===');
  wipe();
  const s0 = gpu.status();
  ok('llm.used = 0', s0.llm.used === 0);
  ok('llm.max = 3', s0.llm.max === 3);
  ok('llm.model default', s0.llm.model === 'qwen3.6:27b');
  ok('creative idle', s0.creative.running === false && !s0.creative.queued);

  console.log('  === llm acquire / release (in-process) ===');
  const t1 = await gpu.acquire('llm', { task: 'x' });
  const slot = JSON.parse(fs.readFileSync(path.join(GPU_DIR, t1 + '.json'), 'utf8'));
  ok('token returned + slot file', typeof t1 === 'string' && slot.token === t1);
  ok('model recorded on slot', slot.model === 'qwen3.6:27b');
  ok('meta stored', slot.meta.task === 'x');
  gpu.release(t1);
  ok('released', gpu.status().llm.used === 0);
  const ts = [await gpu.acquire('llm'), await gpu.acquire('llm'), await gpu.acquire('llm')];
  ok('3 slots used', gpu.status().llm.used === 3);
  ok('4th refused', /no llm slots/.test(await rejects(gpu.acquire('llm'))));
  ts.forEach((t) => gpu.release(t));
  ok('invalid kind rejected', /invalid kind/.test(await rejects(gpu.acquire('nope'))));
  let m = null; try { gpu.release('nonexistent-token'); } catch (e) { m = e.message; }
  ok('bad token throws', m === 'no such token');
  m = null; try { gpu.release('../evil'); } catch (e) { m = e.message; }
  ok('path-like token rejected', m === 'no such token');

  console.log('  === config override ===');
  wipe(); setCfg({ llmModel: 'llama3:8b', llmSlots: 1 });
  const c1 = await gpu.acquire('llm');
  ok('override model recorded', JSON.parse(fs.readFileSync(path.join(GPU_DIR, c1 + '.json'), 'utf8')).model === 'llama3:8b');
  ok('limit 1 enforced', /no llm slots/.test(await rejects(gpu.acquire('llm'))));
  gpu.release(c1);
  fs.unlinkSync(path.join(TEST_HOME, '.studio', 'gpu.json'));

  console.log('  === creative in-process: immediate, exclusive, Ollama unload ===');
  wipe();
  const mock = await mockOllama();
  process.env.STUDIO_OLLAMA_PORT = String(mock.port);
  // gpu.js read the port at load; verify via a child-free path below using a fresh module
  delete require.cache[require.resolve('./gpu')];
  const gpu2 = require('./gpu');
  const cr = await gpu2.acquire('creative');
  ok('creative acquired when idle', gpu2.status().creative.running === true);
  ok('ollama unload POSTed', mock.calls.length === 1 && mock.calls[0].method === 'POST' &&
     mock.calls[0].url === '/api/generate' && mock.calls[0].body.keep_alive === 0 &&
     mock.calls[0].body.model === 'qwen3.6:27b');
  ok('llm refused while creative running', /creative running/.test(await rejects(gpu2.acquire('llm'))));
  gpu2.release(cr);
  ok('llm allowed after creative release', (gpu2.release(await gpu2.acquire('llm')), true));
  mock.srv.close();
  delete process.env.STUDIO_OLLAMA_PORT;

  console.log('  === stale reclaim (dead pid) ===');
  wipe();
  const dead = deadPid();
  fs.writeFileSync(path.join(GPU_DIR, 'dead-llm.json'),
    JSON.stringify({ kind: 'llm', pid: dead, token: 'dead-llm', since: 1, meta: {} }));
  ok('dead llm slot not counted', gpu.status().llm.used === 0);
  ok('dead llm slot file removed', !fs.existsSync(path.join(GPU_DIR, 'dead-llm.json')));
  fs.writeFileSync(path.join(GPU_DIR, 'pending-dead-cr.json'),
    JSON.stringify({ kind: 'creative', pid: dead, token: 'dead-cr', since: 1, meta: {} }));
  const tl = await gpu.acquire('llm');
  ok('dead-pid pending reclaimed: llm acquire not blocked', typeof tl === 'string');
  ok('dead pending file removed', !fs.existsSync(path.join(GPU_DIR, 'pending-dead-cr.json')));
  gpu.release(tl);
  fs.writeFileSync(path.join(GPU_DIR, 'dead-cr-run.json'),
    JSON.stringify({ kind: 'creative', pid: dead, token: 'dead-cr-run', since: 1, meta: {} }));
  gpu.tick();
  ok('tick() reclaims dead running creative', !fs.existsSync(path.join(GPU_DIR, 'dead-cr-run.json')));
  // stale lock dir left by a crashed process
  fs.mkdirSync(path.join(GPU_DIR, '.lock'));
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(path.join(GPU_DIR, '.lock'), old, old);
  ok('stale lock broken', gpu.status().llm.used === 0);

  console.log('  === cross-process: llm blocked while creative running ===');
  wipe();
  const cc = child('hold-creative');
  ok('child creative acquired', !!(await cc.waitLine('ACQUIRED')));
  ok('parent sees creative running', gpu.status().creative.running === true);
  ok('llm refused (other process holds creative)', /creative running/.test(await rejects(gpu.acquire('llm'))));
  const lc = child('hold-llm');
  ok('llm in other process refused', !!(await lc.waitLine('ERR blocked: creative running')));
  await cc.stop();
  ok('creative gone after child exit', gpu.status().creative.running === false);
  const tx = await gpu.acquire('llm'); gpu.release(tx);
  ok('llm allowed again', true);

  console.log('  === cross-process: creative waits for llm drain; pending blocks llm ===');
  wipe();
  const h1 = child('hold-llm'), h2 = child('hold-llm');
  ok('2 llm holders in children', !!(await h1.waitLine('OK')) && !!(await h2.waitLine('OK')));
  const waiter = child('hold-creative');
  await waiter.waitLine('WAITING');
  await sleep(300);
  ok('creative queued, not acquired', gpu.status().creative.queued === 1 && !waiter.lines.some((l) => l.startsWith('ACQUIRED')));
  ok('llm refused while creative pending', /creative queued/.test(await rejects(gpu.acquire('llm'))));
  await h1.stop();
  await sleep(300);
  ok('still waiting with 1 llm left', !waiter.lines.some((l) => l.startsWith('ACQUIRED')));
  await h2.stop();
  ok('creative acquired after drain', !!(await waiter.waitLine('ACQUIRED')));
  ok('queue empty, creative running', gpu.status().creative.queued === 0 && gpu.status().creative.running === true);
  await waiter.stop();

  console.log('  === cross-process: FIFO creative queue ===');
  wipe();
  const hold = child('hold-llm'); await hold.waitLine('OK');
  const k1 = child('hold-creative'); await k1.waitLine('WAITING'); await sleep(100);
  const k2 = child('hold-creative'); await k2.waitLine('WAITING'); await sleep(200);
  ok('two creatives queued', gpu.status().creative.queued === 2);
  await hold.stop();
  ok('first queued gets GPU', !!(await k1.waitLine('ACQUIRED')));
  await sleep(300);
  ok('second still waiting (exclusive)', !k2.lines.some((l) => l.startsWith('ACQUIRED')));
  await k1.stop();
  ok('second acquires after first releases', !!(await k2.waitLine('ACQUIRED')));
  await k2.stop();

  console.log('  === cross-process: queued creative that dies is reclaimed ===');
  wipe();
  const h3 = child('hold-llm'); await h3.waitLine('OK');
  const dw = child('hold-creative'); await dw.waitLine('WAITING'); await sleep(200);
  ok('pending present', gpu.status().creative.queued === 1);
  dw.p.kill('SIGKILL'); await dw.exit;
  ok('pending file of dead waiter reclaimed', gpu.status().creative.queued === 0);
  const h4 = child('hold-llm');
  ok('llm acquire works after waiter died', !!(await h4.waitLine('OK')));
  await h3.stop(); await h4.stop();

  console.log('  === cross-process: slot limit under 6 concurrent acquirers ===');
  wipe();
  const hs = Array.from({ length: 6 }, () => child('hold-llm'));
  await Promise.all(hs.map((h) => h.waitLine('OK', 3000).then((l) => l || h.waitLine('ERR', 3000))));
  const okN = hs.filter((h) => h.lines.some((l) => l.startsWith('OK'))).length;
  ok('exactly 3 of 6 got slots', okN === 3 && gpu.status().llm.used === 3);
  await Promise.all(hs.map((h) => h.stop()));

  wipe();
  let maxSeen = 0, sampling = true;
  const sampler = (async () => {
    while (sampling) {
      const n = fs.readdirSync(GPU_DIR).filter((f) => f.endsWith('.json') && !f.startsWith('pending-')).length;
      if (n > maxSeen) maxSeen = n;
      await sleep(2);
    }
  })();
  const st = Array.from({ length: 6 }, () => child('stress'));
  await Promise.all(st.map((c) => c.exit));
  sampling = false; await sampler;
  const total = st.reduce((a, c) => a + Number((c.lines.find((l) => l.startsWith('DONE')) || 'DONE 0').split(' ')[1]), 0);
  ok(`stress: max concurrent slot files ${maxSeen} <= 3`, maxSeen <= 3);
  ok(`stress: slots were actually granted (${total})`, total > 0 && maxSeen >= 1);
  ok('stress: all released', gpu.status().llm.used === 0);

  console.log(`\n${passed}/${passed + failed} passed${failed ? ` (${failed} failed)` : ''}`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
