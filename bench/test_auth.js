const http = require('http');
const path = require('path');
const fs = require('fs');

const HOME = process.cwd();
const DIR = path.join(HOME, '.studio');

// helpers
function post(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const opts = { hostname: parsed.hostname, port: parsed.port, path: parsed.pathname, method: 'POST', headers: { 'Content-Type': 'application/json', ...headers } };
    const req = http.request(opts, (res) => {
      let d = ''; res.on('data', (c) => d += c); res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
        catch { resolve({ status: res.statusCode, body: d }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}
function get(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const opts = { hostname: parsed.hostname, port: parsed.port, path: parsed.pathname, method: 'GET', headers };
    http.get(opts, (res) => {
      let d = ''; res.on('data', (c) => d += c); res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
        catch { resolve({ status: res.statusCode, body: d }); }
      });
    }).on('error', reject);
  });
}

async function run(port) {
  let passed = 0, failed = 0;
  function ok(name, cond) { if (cond) { passed++; console.log(`  ✅ ${name}`); } else { failed++; console.error(`  ❌ ${name}`); } }

  try {
    // 1) POST /api/pair without token -> 200 with token
    const pair = await post(`http://localhost:${port}/api/pair`, {});
    ok('/api/pair returns 200', pair.status === 200);
    ok('/api/pair has token field', typeof pair.body.token === 'string' && pair.body.token.length > 0);
    ok('/api/pair has method=bearer', pair.body.method === 'bearer');
    const token = pair.body.token;

    // 2) GET /api/state without token -> 401
    const unauth = await get(`http://localhost:${port}/api/state`);
    ok('/api/state without token -> 401', unauth.status === 401);

    // 3) GET /api/state WITH token -> 200
    const state = await get(`http://localhost:${port}/api/state`, { Authorization: `Bearer ${token}` });
    ok('/api/state with token -> 200', state.status === 200);
    ok('/api/state has events', Array.isArray(state.body.events));
    ok('/api/state has runs', Array.isArray(state.body.runs));

    // 4) POST /api/control without token -> 401
    const ctrlBad = await post(`http://localhost:${port}/api/control`, { action: 'pause' });
    ok('/api/control without token -> 401', ctrlBad.status === 401);

    // 5) POST /api/control WITH token -> 200
    const ctrlOk = await post(`http://localhost:${port}/api/control`, { action: 'pause' }, { Authorization: `Bearer ${token}` });
    ok('/api/control with token -> 200', ctrlOk.status === 200);
    // resume so we don't leave paused
    await post(`http://localhost:${port}/api/control`, { action: 'resume' }, { Authorization: `Bearer ${token}` });

    // 6) /api/gpu with token
    const gpu = await get(`http://localhost:${port}/api/gpu`, { Authorization: `Bearer ${token}` });
    ok('/api/gpu with token -> 200', gpu.status === 200);

    // 7) /api/usage with token
    const usage = await get(`http://localhost:${port}/api/usage`, { Authorization: `Bearer ${token}` });
    ok('/api/usage with token -> 200', usage.status === 200);

    // 8) stale token fails
    await post(`http://localhost:${port}/api/pair`, {}); // issue new token
    const stale = await get(`http://localhost:${port}/api/state`, { Authorization: `Bearer ${token}` });
    ok('stale token rejected -> 401', stale.status === 401);

    // 9) token in query param works
    const freshPair = await post(`http://localhost:${port}/api/pair`, {});
    const qToken = freshPair.body.token;
    const qp = await get(`http://localhost:${port}/api/state?token=${encodeURIComponent(qToken)}`);
    ok('token via query param -> 200', qp.status === 200);

    // 10) malformed body on /api/control -> 400
    const badBody = await post(`http://localhost:${port}/api/control`, { action: 'noop' }, { Authorization: `Bearer ${qToken}` });
    ok('bad action on /api/control -> 400', badBody.status === 400);

    // 11) non-existent endpoint -> 404
    const noexist = await get(`http://localhost:${port}/api/noexist`, { Authorization: `Bearer ${qToken}` });
    ok('non-existent /api/* -> 404', noexist.status === 404);

  } catch (e) {
    console.error('Test error:', e.message);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  return failed === 0;
}

// start server, run tests, then kill
(async () => {
  const PORT = process.env.TEST_PORT || 4778;
  const child = require('child_process').spawn(process.execPath, [path.join(__dirname, '..', 'studio', 'studio.js'), 'serve', String(PORT)], {
    cwd: HOME, detached: false, stdio: ['ignore', 'pipe', 'pipe']
  });
  let buf = '';
  child.stdout.on('data', (c) => { buf += c; });
  child.stderr.on('data', (c) => { buf += c; });

  // wait for server ready
  await new Promise((r) => setTimeout(r, 1500));
  const ok = await run(PORT);
  child.kill();
  process.exit(ok ? 0 : 1);
})();
