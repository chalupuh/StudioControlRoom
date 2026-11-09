#!/usr/bin/env node
// Selftest: LAN bind + token auth (Sprint 4i Task 1)
// Spawns the studio server on a random port with STUDIO_BIND=0.0.0.0 (LAN mode).
// Exercises each criterion from the spec, then kills the server.
// Run: node engine/selftest-auth.js
//
// Coverage:
//   - Loopback (127.0.0.1) requests skip auth -> 200
//   - LAN-bound server requires token on /api/* -> 401 without, 200 with
//   - Wrong token -> 401; 5 failures -> 429 (middleware mock tests)
//   - Bearer header and HttpOnly cookie auth
//   - GET /pair?t=<token> sets cookie, redirects to /
//   - Non-private source IPs -> 403 (middleware mock test)
//   - Token stored in .studio/auth.json as 32 random bytes
//   - `studio.js token rotate` works

const { spawn, spawnSync } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');

// ---- helpers ----
const HOME = path.resolve(__dirname, '..');
const DIR = path.join(HOME, '.studio');
const tests = { pass: 0, fail: 0, errors: [] };

function t(name, cond) {
  if (cond) { tests.pass++; console.log(`  ✓ ${name}`); }
  else { tests.fail++; console.error(`  ✗ ${name}`); tests.errors.push(name); }
}

// Port chosen dynamically (set before server starts)
let PORT = 0;

// HTTP helper using raw socket so we can read Set-Cookie headers
function req({ url, method = 'GET', body = null, headers = {} }) {
  return new Promise((resolve, reject) => {
    const opts = { hostname: '127.0.0.1', port: PORT, path: url, method, headers, timeout: 5000 };
    const r = http.request(opts, (res) => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d), headers: res.headers }); }
        catch { resolve({ status: res.statusCode, body: d, headers: res.headers }); }
      });
    });
    r.on('error', reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

// ---- auth module unit tests (direct calls, no server needed) ----
const auth = require('../studio/auth');

// ---- main ----
(async () => {
  console.log('--- Auth self-tests ---\n');

  // ========== UNIT: auth.js module ==========
  console.log('[unit] auth module\n');

  // Token generation: 32 bytes = 64 hex chars
  const tok1 = auth.generateToken();
  t('generateToken() returns 64 hex chars (32 bytes)', /^([0-9a-f]{2}){32}$/.test(tok1));

  // Unique tokens
  const tok2 = auth.generateToken();
  t('two generateToken() calls produce different tokens', tok1 !== tok2);

  // Constant-time compare
  t('verifyToken: matching tokens -> true', auth.verifyToken(tok1, tok1));
  t('verifyToken: mismatching tokens -> false', !auth.verifyToken(tok1, tok2));
  t('verifyToken: null provided -> false', !auth.verifyToken(null, tok1));
  t('verifyToken: null expected -> false', !auth.verifyToken(tok1, null));

  // isPrivateIP
  t('isPrivateIP: 127.0.0.1 -> true', auth.isPrivateIP('127.0.0.1'));
  t('isPrivateIP: ::1 -> true', auth.isPrivateIP('::1'));
  t('isPrivateIP: 10.0.0.5 -> true', auth.isPrivateIP('10.0.0.5'));
  t('isPrivateIP: 172.16.0.1 -> true', auth.isPrivateIP('172.16.0.1'));
  t('isPrivateIP: 172.31.255.255 -> true', auth.isPrivateIP('172.31.255.255'));
  t('isPrivateIP: 192.168.1.1 -> true', auth.isPrivateIP('192.168.1.1'));
  t('isPrivateIP: 172.15.0.1 -> false (outside /12)', !auth.isPrivateIP('172.15.0.1'));
  t('isPrivateIP: 172.32.0.1 -> false (outside /12)', !auth.isPrivateIP('172.32.0.1'));
  t('isPrivateIP: 8.8.8.8 -> false (public)', !auth.isPrivateIP('8.8.8.8'));
  t('isPrivateIP: 203.0.113.5 -> false (public)', !auth.isPrivateIP('203.0.113.5'));
  t('isPrivateIP: fd00::1 -> false (not in spec)', !auth.isPrivateIP('fd00::1'));
  t('isPrivateIP: fe80::1 -> false (not in spec)', !auth.isPrivateIP('fe80::1'));
  t('isPrivateIP: 169.254.1.1 -> false (link-local not in spec)', !auth.isPrivateIP('169.254.1.1'));
  t('isPrivateIP: :: -> false', !auth.isPrivateIP('::'));

  // Rate limiter
  const store = auth.createRateStore();
  t('checkRateLimit: first call allowed', auth.checkRateLimit('1.2.3.4', store));
  // 4 more calls should be allowed (5 total), 6th should fail
  for (let i = 0; i < 4; i++) { auth.checkRateLimit('1.2.3.4', store); }
  t('checkRateLimit: 6th call blocked (429)', !auth.checkRateLimit('1.2.3.4', store));
  // Different IP should still be allowed
  t('checkRateLimit: different IP still allowed', auth.checkRateLimit('5.6.7.8', store));
  // After reset, IP should be allowed again
  auth.resetRateLimit('1.2.3.4', store);
  t('checkRateLimit: after reset, call allowed again', auth.checkRateLimit('1.2.3.4', store));

  // Cookie parsing
  const cookies = auth.parseCookies('studio_token=abc123; other=val');
  t('parseCookies extracts studio_token', cookies.studio_token === 'abc123');
  t('parseCookies extracts other cookies', cookies.other === 'val');

  // rateLimitKey uses connection.remoteAddress, not X-Forwarded-For
  const mockReq = { connection: { remoteAddress: '192.168.1.5' }, headers: { 'x-forwarded-for': '8.8.8.8' } };
  t('rateLimitKey uses socket address, not X-Forwarded-For', auth.rateLimitKey(mockReq) === '192.168.1.5');
  const mockV6 = { connection: { remoteAddress: '::ffff:10.0.0.1' }, headers: {} };
  t('rateLimitKey strips ::ffff: prefix', auth.rateLimitKey(mockV6) === '10.0.0.1');

  // ========== UNIT: middleware with mock requests ==========
  console.log('[unit] auth middleware (mock requests)\n');

  // Create a temp dir with a known token for middleware tests
  const MID_DIR = path.join(os.tmpdir(), 'studio-mid-' + crypto.randomBytes(4).toString('hex'));
  const MID_STUDIO = path.join(MID_DIR, '.studio');
  fs.mkdirSync(MID_STUDIO, { recursive: true });
  const midToken = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(path.join(MID_STUDIO, 'auth.json'), JSON.stringify({ token: midToken, created: Date.now() }, null, 2));

  const midStore = auth.createRateStore();
  let lastStatus = 0, lastBody = '', lastHeaders = {};
  function mockRes() { return { status: lastStatus, body: lastBody, headers: lastHeaders }; }
  function mockJsonFn(res, obj, code) {
    lastStatus = code; lastBody = JSON.stringify(obj); lastHeaders = {};
  }
  const midMiddleware = auth.makeAuthMiddleware(mockJsonFn, MID_STUDIO, midStore);

  // --- 1) Loopback (127.0.0.1) skips auth ---
  lastStatus = 999;
  const loopReq = { connection: { remoteAddress: '127.0.0.1' }, headers: {} };
  t('middleware: loopback 127.0.0.1 -> pass (status unchanged)', midMiddleware(loopReq, mockRes()) && lastStatus === 999);

  // --- 2) Loopback (::1) skips auth ---
  lastStatus = 999;
  const v6Req = { connection: { remoteAddress: '::1' }, headers: {} };
  t('middleware: loopback ::1 -> pass (status unchanged)', midMiddleware(v6Req, mockRes()) && lastStatus === 999);

  // --- 3) Public IP -> 403 ---
  lastStatus = 999;
  const pubReq = { connection: { remoteAddress: '8.8.8.8' }, headers: {} };
  const pubOk = midMiddleware(pubReq, mockRes());
  t('middleware: public IP 8.8.8.8 -> 403 blocked', !pubOk && lastStatus === 403);

  // --- 4) Private IP without token -> 401 ---
  lastStatus = 999;
  midStore.clear();
  const privReq = { connection: { remoteAddress: '192.168.1.10' }, headers: {} };
  const privOk = midMiddleware(privReq, mockRes());
  t('middleware: private IP no token -> 401', !privOk && lastStatus === 401);

  // --- 5) Private IP with valid Bearer token -> pass ---
  lastStatus = 999;
  midStore.clear();
  const goodReq = { connection: { remoteAddress: '192.168.1.10' }, headers: { authorization: `Bearer ${midToken}` } };
  const goodOk = midMiddleware(goodReq, mockRes());
  t('middleware: valid Bearer token -> pass', goodOk && lastStatus === 999);

  // --- 6) Private IP with wrong Bearer token -> 401 ---
  lastStatus = 999;
  midStore.clear();
  const badReq = { connection: { remoteAddress: '192.168.1.10' }, headers: { authorization: 'Bearer wrongtoken' } };
  const badOk = midMiddleware(badReq, mockRes());
  t('middleware: wrong Bearer token -> 401', !badOk && lastStatus === 401);

  // --- 7) Private IP with valid cookie -> pass ---
  lastStatus = 999;
  midStore.clear();
  const cookReq = { connection: { remoteAddress: '192.168.1.10' }, headers: { cookie: `studio_token=${midToken}` } };
  const cookOk = midMiddleware(cookReq, mockRes());
  t('middleware: valid cookie token -> pass', cookOk && lastStatus === 999);

  // --- 8) Private IP with wrong cookie -> 401 ---
  lastStatus = 999;
  midStore.clear();
  const badCook = { connection: { remoteAddress: '192.168.1.10' }, headers: { cookie: 'studio_token=bad' } };
  const badCookOk = midMiddleware(badCook, mockRes());
  t('middleware: wrong cookie token -> 401', !badCookOk && lastStatus === 401);

  // --- 9) Rate limit: 5 failed attempts -> 429 ---
  lastStatus = 999;
  const rlStore = auth.createRateStore();
  const rlMid = auth.makeAuthMiddleware(mockJsonFn, MID_STUDIO, rlStore);
  const rlIp = { connection: { remoteAddress: '10.0.0.50' }, headers: { authorization: 'Bearer bad' } };
  for (let i = 0; i < 5; i++) {
    lastStatus = 999;
    rlMid(rlIp, mockRes());
    t(`middleware: rate-limit attempt ${i + 1}/5 -> 401`, lastStatus === 401);
  }
  // 6th should be 429
  lastStatus = 999;
  rlMid(rlIp, mockRes());
  t('middleware: 6th attempt -> 429 rate limited', lastStatus === 429);

  // --- 10) Locked-out IP is refused even with a valid token ---
  lastStatus = 999;
  const rlOkReq = { connection: { remoteAddress: '10.0.0.50' }, headers: { authorization: `Bearer ${midToken}` } };
  rlMid(rlOkReq, mockRes());
  t('middleware: locked-out IP with valid token -> 429', lastStatus === 429);

  // --- 11) Success resets the failure counter; only failures count ---
  const rsStore = auth.createRateStore();
  const rsMid = auth.makeAuthMiddleware(mockJsonFn, MID_STUDIO, rsStore);
  const rsGood = { connection: { remoteAddress: '10.0.0.51' }, headers: { authorization: `Bearer ${midToken}` } };
  const rsBad = { connection: { remoteAddress: '10.0.0.51' }, headers: { authorization: 'Bearer bad' } };
  for (let i = 0; i < 4; i++) rsMid(rsBad, mockRes());
  for (let i = 0; i < 10; i++) { lastStatus = 999; rsMid(rsGood, mockRes()); }
  t('middleware: many valid requests never rate-limited', lastStatus === 999);
  lastStatus = 999;
  rsMid(rsBad, mockRes());
  t('middleware: after success reset, bad token -> 401 (not 429)', lastStatus === 401);

  // Cleanup middleware temp dir
  try { fs.rmSync(MID_DIR, { recursive: true, force: true }); } catch {}

  // ========== INTEGRATION: spawn server ==========
  console.log('\n[integration] spawned server\n');

  // Pick free ports
  const freePort = () => new Promise(resolve => {
    const s = require('net').createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
  const waitPort = async (port) => {
    for (let i = 0; i < 100; i++) {
      const ok = await new Promise((r) => { const c = require('net').connect(port, '127.0.0.1', () => { c.destroy(); r(true); }); c.on('error', () => r(false)); });
      if (ok) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  };
  PORT = await freePort();
  const PORT2 = await freePort();

  // Use a temporary HOME dir to avoid polluting real state.
  // The server sets DIR = path.join(HOME, '.studio'), so we put files under .studio/
  const TEST_DIR = path.join(os.tmpdir(), 'studio-selftest-' + crypto.randomBytes(4).toString('hex'));
  const TEST_STUDIO = path.join(TEST_DIR, '.studio');
  fs.mkdirSync(TEST_STUDIO, { recursive: true });
  fs.writeFileSync(path.join(TEST_STUDIO, 'events.jsonl'), '');

  // Pre-write a known token (32 bytes -> 64 hex chars)
  const testToken = crypto.randomBytes(32).toString('hex');
  const authFile = { token: testToken, created: Date.now() };
  fs.writeFileSync(path.join(TEST_STUDIO, 'auth.json'), JSON.stringify(authFile, null, 2));

  // Verify token file has 32 bytes (64 hex chars)
  const readAuth = JSON.parse(fs.readFileSync(path.join(TEST_STUDIO, 'auth.json'), 'utf8'));
  t('auth.json token is 64 hex chars (32 bytes)', readAuth.token.length === 64);

  // Spawn server in LAN mode (STUDIO_BIND=0.0.0.0) with our temp HOME
  const child = spawn(process.execPath, [path.join(HOME, 'studio', 'studio.js'), 'serve', String(PORT)], {
    cwd: HOME,
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(PORT), STUDIO_BIND: '0.0.0.0', STUDIO_HOME: TEST_DIR }
  });

  let outBuf = '';
  child.stdout.on('data', c => outBuf += c);
  child.stderr.on('data', c => outBuf += c);

  // Wait for server ready
  await waitPort(PORT);

  // Verify server is listening and LAN mode is enabled
  t('server started without crashing', child.exitCode === null);

  // ---- 1) Loopback request WITHOUT token -> 200 (loopback exemption) ----
  const loopback = await req({ url: '/api/state' });
  t('GET /api/state from loopback without token -> 200', loopback.status === 200);
  t('/api/state has events array', Array.isArray(loopback.body?.events));
  t('/api/state has control object', typeof loopback.body?.control === 'object');

  // ---- 2/3) Loopback ignores token headers (auth is only enforced for LAN sources; see 11b) ----
  const withToken = await req({ url: '/api/state', headers: { Authorization: `Bearer ${testToken}` } });
  t('loopback ignores Bearer header -> 200', withToken.status === 200);
  const cookieOk = await req({ url: '/api/state', headers: { Cookie: `studio_token=${testToken}` } });
  t('loopback ignores cookie header -> 200', cookieOk.status === 200);

  // ---- 3b) Host / Origin checks (DNS rebinding, CSRF) ----
  t('foreign Host header -> 403', (await req({ url: '/api/state', headers: { Host: 'evil.example.com' } })).status === 403);
  t('foreign Host header on /api/pair-qr -> 403', (await req({ url: '/api/pair-qr', headers: { Host: 'rebind.example:' + PORT } })).status === 403);
  t('POST with foreign Origin -> 403', (await req({ url: '/control', method: 'POST', body: { action: 'pause' }, headers: { Origin: 'http://evil.example.com' } })).status === 403);
  t('POST with matching Origin -> 200', (await req({ url: '/control', method: 'POST', body: { action: 'resume' }, headers: { Origin: `http://127.0.0.1:${PORT}`, Host: `127.0.0.1:${PORT}` } })).status === 200);

  // ---- 4) GET /pair?t=<valid-token> -> 302 with Set-Cookie ----
  const pairResp = await req({ url: `/pair?t=${testToken}` });
  t('GET /pair?t=<valid> -> 302 redirect', pairResp.status === 302);
  // Set-Cookie can be a string or array in Node.js http module
  const setCookieVal = pairResp.headers['set-cookie'];
  const setCookieStr = Array.isArray(setCookieVal) ? setCookieVal.join('; ') : (setCookieVal || '');
  t('/pair sets Set-Cookie header', typeof setCookieStr === 'string' && setCookieStr.includes('studio_token'));
  t('Set-Cookie is HttpOnly', typeof setCookieStr === 'string' && setCookieStr.includes('HttpOnly'));
  t('Set-Cookie is SameSite=Strict', typeof setCookieStr === 'string' && setCookieStr.includes('SameSite=Strict'));
  t('/pair redirects to /', pairResp.headers['location'] === '/');

  // ---- 5) GET /pair without valid token in LAN mode -> 401 ----
  const pairNoToken = await req({ url: '/pair' });
  t('GET /pair without token in LAN mode -> 401', pairNoToken.status === 401);

  // ---- 6) POST /api/control WITH token -> 200 ----
  const ctrlOk = await req({ url: '/api/control', method: 'POST', body: { action: 'pause' }, headers: { Authorization: `Bearer ${testToken}` } });
  t('POST /api/control with token -> 200', ctrlOk.status === 200);

  // ---- 7) /api/gpu with token ----
  const gpu = await req({ url: '/api/gpu', headers: { Authorization: `Bearer ${testToken}` } });
  t('GET /api/gpu with token -> 200', gpu.status === 200);

  // ---- 8) /api/usage with token ----
  const usage = await req({ url: '/api/usage', headers: { Authorization: `Bearer ${testToken}` } });
  t('GET /api/usage with token -> 200', usage.status === 200);

  // ---- 9) SSE /api/stream with token -> 200 ----
  // Use a short timeout and don't wait for full body (SSE is a long-running stream)
  const streamPromise = new Promise((resolve) => {
    const opts = { hostname: '127.0.0.1', port: PORT, path: '/api/stream', method: 'GET', headers: { Authorization: `Bearer ${testToken}` }, timeout: 3000 };
    const r = http.request(opts, (res) => {
      res.on('data', () => {}); // drain
      // Just check the status code, don't wait for body (it's a long-running stream)
      resolve({ status: res.statusCode, headers: res.headers });
    });
    r.on('error', () => resolve({ status: 0 }));
    r.end();
    // Destroy after a short delay since this is a long-running stream
    setTimeout(() => { try { r.abort(); } catch {} }, 1000);
  });
  const streamOk = await streamPromise;
  t('GET /api/stream with token -> 200', streamOk.status === 200);
  t('GET /api/stream returns event-stream content-type', streamOk.headers && streamOk.headers['content-type'] && streamOk.headers['content-type'].includes('event-stream'));

  // ---- 10) non-existent /api/* endpoint -> 404 ----
  const noexist = await req({ url: '/api/nope', headers: { Authorization: `Bearer ${testToken}` } });
  t('non-existent /api/* endpoint -> 404', noexist.status === 404);

  // ---- 11) POST /api/pair should NOT exist (no unauthenticated token minting) ----
  const pairPost = await req({ url: '/api/pair', method: 'POST', body: {} });
  t('POST /api/pair does NOT return token (no unauthenticated minting)', pairPost.status !== 200 || !pairPost.body?.token);

  // ---- 11b) LAN-source requests (source IP is a private non-loopback address of this host) ----
  // Connect to our own LAN IPv4 so the server sees a private, non-loopback peer and enforces auth.
  // Virtual NICs (WSL/Hyper-V/Docker...) are skipped here to avoid connecting to unexpected addresses
  // and triggering the Windows "allow node.exe" firewall prompt. The server includes them (sorted last),
  // but this test prefers physical NICs for the LAN-source checks.
  const lanIp = [].concat(...Object.entries(os.networkInterfaces()).filter(([n]) => !/vEthernet|WSL|Hyper-V|Docker|VirtualBox|VMware|Loopback/i.test(n)).map(([, l]) => l || []))
    .find((ni) => ni.family === 'IPv4' && !ni.internal && auth.isPrivateIP(ni.address))?.address;
  if (!lanIp) {
    console.log('  (skipped: host has no private IPv4 address; LAN-source checks not run)');
  } else {
    const lanReq = (url, headers = {}, method = 'GET') => new Promise((resolve) => {
      const r = http.request({ hostname: lanIp, port: PORT, path: url, method, headers, timeout: 5000 }, (res) => {
        let d = ''; res.on('data', (c) => d += c);
        res.on('end', () => resolve({ status: res.statusCode, body: d, headers: res.headers }));
      });
      r.on('error', () => resolve({ status: 0 })); r.end();
    });
    const bad = { Authorization: 'Bearer ' + 'f'.repeat(64) };
    t('LAN: /api/state without token -> 401', (await lanReq('/api/state')).status === 401);
    t('LAN: /api/state with Bearer -> 200', (await lanReq('/api/state', { Authorization: `Bearer ${testToken}` })).status === 200);
    t('LAN: /api/state with cookie -> 200', (await lanReq('/api/state', { Cookie: `studio_token=${testToken}` })).status === 200);
    t('LAN: /api/pair-qr with Bearer -> SVG', (await lanReq('/api/pair-qr', { Authorization: `Bearer ${testToken}` })).body.includes('<svg'));
    // Each unauthenticated request is a failure (5 -> lockout); a valid request resets the counter.
    const good = { Authorization: `Bearer ${testToken}` };
    let n = 0;
    const denied = async (name, p, method) => {
      if (n++ % 3 === 2) await lanReq('/api/state', good);
      t(`LAN: ${name} without token -> 401`, (await lanReq(p, {}, method)).status === 401);
    };
    for (const p of ['/control', '/checkpoints', '/models', '/events', '/v1', '/portraits/x.png', '/village/x.png', '/api/stream']) await denied(p, p);
    await denied('POST /control pause', '/control', 'POST');
    await denied('removed /api/test/reset-rate-limit', '/api/test/reset-rate-limit', 'POST');
    await lanReq('/api/state', good);
    const pairLan = await lanReq(`/pair?t=${testToken}`);
    t('LAN: /pair valid token -> 302 with persistent cookie', pairLan.status === 302 && /Max-Age=\d+/.test(String(pairLan.headers['set-cookie'])) && pairLan.headers['cache-control'] === 'no-store');
    t('LAN: wrong token -> 401', (await lanReq('/api/state', bad)).status === 401);
    let last = 0;
    for (let i = 0; i < 5; i++) last = (await lanReq('/api/state', bad)).status;
    t('LAN: repeated failures -> 429', last === 429);
    t('LAN: valid token refused while locked out -> 429', (await lanReq('/api/state', { Authorization: `Bearer ${testToken}` })).status === 429);
  }

  // ---- 12) `studio.js token rotate` CLI ----
  await new Promise(r => setTimeout(r, 500));
  const rotateResult = spawnSync(process.execPath, [path.join(HOME, 'studio', 'studio.js'), 'token', 'rotate'], {
    cwd: HOME, env: { ...process.env, STUDIO_HOME: TEST_DIR }, encoding: 'utf8', timeout: 10000
  });
  t('token rotate exits 0', rotateResult.status === 0);
  t('token rotate output includes re-pair hint', /re-pair|re.pair/i.test(rotateResult.stdout));
  const rotatedAuth = JSON.parse(fs.readFileSync(path.join(TEST_STUDIO, 'auth.json'), 'utf8'));
  t('token rotate produces new token', rotatedAuth.token !== testToken);
  t('token rotate new token is 64 hex chars', rotatedAuth.token.length === 64);

  // ---- 13) `studio.js token` (show) CLI ----
  const showResult = spawnSync(process.execPath, [path.join(HOME, 'studio', 'studio.js'), 'token'], {
    cwd: HOME, env: { ...process.env, STUDIO_HOME: TEST_DIR }, encoding: 'utf8', timeout: 10000
  });
  t('token show exits 0', showResult.status === 0);
  t('token show outputs the token', showResult.stdout.includes('Token:') && showResult.stdout.includes(rotatedAuth.token));

  // ---- 14) STUDIO_BIND env var is respected ----
  // The server was started with STUDIO_BIND=0.0.0.0 and it's running, so this is implicitly tested.
  // Check that getLanBind reads STUDIO_BIND by verifying the server output mentions LAN mode
  t('server stdout mentions LAN mode', outBuf.toLowerCase().includes('lan mode'));

  // ---- 15) machine.json fallback (unit-level: check getLanBind reads it) ----
  // Write a machine.json with controlRoom.bind and verify it's read
  // Spawn a second server with STUDIO_BIND unset and .studio/machine.json controlRoom.bind=0.0.0.0.
  fs.writeFileSync(path.join(TEST_STUDIO, 'machine.json'), JSON.stringify({ controlRoom: { bind: '0.0.0.0' } }));
  const env2 = { ...process.env, STUDIO_HOME: TEST_DIR, PORT: String(PORT2) };
  delete env2.STUDIO_BIND;
  const child2 = spawn(process.execPath, [path.join(HOME, 'studio', 'studio.js'), 'serve', String(PORT2)], { cwd: HOME, stdio: ['ignore', 'pipe', 'pipe'], env: env2 });
  let out2 = '';
  child2.stdout.on('data', (c) => out2 += c); child2.stderr.on('data', (c) => out2 += c);
  await waitPort(PORT2);
  t('machine.json controlRoom.bind fallback -> LAN mode banner', out2.toLowerCase().includes('lan mode'));
  child2.kill();

  // Cleanup server
  child.kill();
  await new Promise(r => setTimeout(r, 500));

  // Cleanup temp dir
  try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}

  // ======== SUMMARY ========
  console.log(`\n--- Summary: ${tests.pass} passed, ${tests.fail} failed ---`);
  if (tests.fail > 0) {
    console.log('\nFailed checks:');
    for (const e of tests.errors) console.log(`  - ${e}`);
  }
  process.exit(tests.fail === 0 ? 0 : 1);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
