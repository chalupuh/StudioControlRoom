#!/usr/bin/env node
// Selftest: auth middleware, rate limiting, token management, IP restrictions
// Spawns the studio server on a random port, exercises each criterion, then kills it.
// Run: node engine/selftest-auth.js

const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const HOME = process.cwd();
const DIR = path.join(HOME, '.studio');
const tests = { pass: 0, fail: 0, errors: [] };

function t(name, cond) {
  if (cond) { tests.pass++; console.log(`  ✓ ${name}`); }
  else { tests.fail++; console.error(`  ✗ ${name}`); tests.errors.push(name); }
}

// --- helpers ---
function req({ url, method = 'GET', body = null, headers = {}, connection }) {
  return new Promise((resolve, reject) => {
    const opts = { hostname: '127.0.0.1', port: PORT, path: url, method, headers };
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

// --- boot server on random port ---
let PORT, child;

(async () => {
  // Pick a free port
  const srv = await new Promise(res => { const s = require('net').createServer(); s.listen(0, '127.0.0.1', () => { PORT = s.address().port; s.close(res); }); });

  // Ensure events.jsonl exists so server doesn't crash on startup
  if (!fs.existsSync(path.join(DIR, 'events.jsonl'))) {
    fs.writeFileSync(path.join(DIR, 'events.jsonl'), '');
  }

  child = spawn(process.execPath, [path.join(HOME, 'studio', 'studio.js'), 'serve', String(PORT)], {
    cwd: HOME, detached: false, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(PORT) }
  });

  let outBuf = '';
  child.stdout.on('data', c => outBuf += c);
  child.stderr.on('data', c => outBuf += c);

  // Wait for server ready
  await new Promise(r => setTimeout(r, 2000));

  // ======== TEST SUITE ========
  console.log('--- Auth self-tests ---\n');

  // 1) GET /api/state from loopback WITHOUT token should be 401
  //    Spec: "When bound to anything other than loopback, every /api/* request needs a token"
  //    But the server binds 0.0.0.0 — so all /api/* need auth. Loopback exemption must be coded.
  const noToken = await req({ url: '/api/state' });
  t('GET /api/state without token -> 401 (server bound 0.0.0.0)', noToken.status === 401);

  // 2) Get a token via POST /api/pair (unprotected)
  const pairResp = await req({ url: '/api/pair', method: 'POST', body: {} });
  t('POST /api/pair returns 200', pairResp.status === 200);
  t('/api/pair response has token field', typeof pairResp.body?.token === 'string' && pairResp.body.token.length > 0);
  t('/api/pair response has method=bearer', pairResp.body?.method === 'bearer');
  const token = pairResp.body.token;

  // 3) GET /api/state WITH token -> 200
  const stateOk = await req({ url: '/api/state', headers: { Authorization: `Bearer ${token}` } });
  t('GET /api/state with valid token -> 200', stateOk.status === 200);
  t('/api/state has events array', Array.isArray(stateOk.body?.events));
  t('/api/state has control object', typeof stateOk.body?.control === 'object');

  // 4) GET /api/state with WRONG token -> 401
  const wrongToken = await req({ url: '/api/state', headers: { Authorization: 'Bearer wrongtoken123' } });
  t('GET /api/state with wrong token -> 401', wrongToken.status === 401);

  // 5) Token via query param works
  const qpResp = await req({ url: `/api/state?token=${encodeURIComponent(token)}` });
  t('token via query string -> 200', qpResp.status === 200);

  // 6) POST /api/control without token -> 401
  const ctrlFail = await req({ url: '/api/control', method: 'POST', body: { action: 'pause' } });
  t('POST /api/control without token -> 401', ctrlFail.status === 401);

  // 7) POST /api/control WITH token -> 200
  const ctrlOk = await req({ url: '/api/control', method: 'POST', body: { action: 'resume' }, headers: { Authorization: `Bearer ${token}` } });
  t('POST /api/control with token -> 200', ctrlOk.status === 200);

  // 8) /api/gpu with token
  const gpu = await req({ url: '/api/gpu', headers: { Authorization: `Bearer ${token}` } });
  t('GET /api/gpu with token -> 200', gpu.status === 200);

  // 9) /api/usage with token
  const usage = await req({ url: '/api/usage', headers: { Authorization: `Bearer ${token}` } });
  t('GET /api/usage with token -> 200', usage.status === 200);

  // 10) Token rotate: POST /api/pair again → new token, old token should fail
  const pair2 = await req({ url: '/api/pair', method: 'POST', body: {} });
  t('second POST /api/pair gives new token', pair2.body.token !== token);
  const stale = await req({ url: '/api/state', headers: { Authorization: `Bearer ${token}` } });
  t('stale token rejected -> 401', stale.status === 401);
  const fresh = await req({ url: '/api/state', headers: { Authorization: `Bearer ${pair2.body.token}` } });
  t('new token accepted -> 200', fresh.status === 200);

  // 11) Rate limiting: rapid-fire failed auth from same IP
  // The rate limit is 120 per 60s. We need to exceed it without actually doing 120 requests.
  // Instead, test that the rate limiter structure is present (code review covers the constant).
  // We can't practically hit 120 requests in a selftest, so verify the 429 path is wired.
  // Actually we can lower the test: just verify that too-fast repeated calls DO return 429 eventually.
  // The spec says 5 failed attempts per IP per minute -> 429. Code uses RATE_LIMIT=120. MISMATCH.
  // This is a finding — we record it but note it.

  // 12) Non-existent /api/ endpoint with valid token -> 404
  const noexist = await req({ url: '/api/nope', headers: { Authorization: `Bearer ${pair2.body.token}` } });
  t('non-existent /api/* endpoint -> 404', noexist.status === 404);

  // 13) SSE /api/stream requires auth
  // We can't easily test SSE in a unit test, so just check that without token it returns 401
  const streamNoAuth = await req({ url: '/api/stream' });
  t('GET /api/stream without token -> 401', streamNoAuth.status === 401);

  // ======== FINDINGS (code review) ========
  console.log('\n--- Code review findings ---\n');

  // 14) Check: spec says "5 failed attempts per IP per minute -> 429" but code uses RATE_LIMIT=120
  const RATE_LIMIT_SPEC = 5; // spec says 5
  // We read the source
  const studioSrc = fs.readFileSync(path.join(HOME, 'studio', 'studio.js'), 'utf8');
  const rateMatch = studioSrc.match(/RATE_LIMIT\s*=\s*(\d+)/);
  const actualLimit = rateMatch ? parseInt(rateMatch[1]) : -1;
  t(`Rate limit matches spec: spec=5, code=${actualLimit}`, actualLimit === RATE_LIMIT_SPEC);

  // 15) Check: spec says "Requests from 127.0.0.1/::1 skip auth" — does code implement loopback exemption?
  const hasLoopbackExempt = studioSrc.includes('127.0.0.1') &&
    (studioSrc.includes('skip') || studioSrc.includes('loopback') || studioSrc.includes('remoteAddress') || studioSrc.includes('local'));
  // Actually look more carefully: the auth middleware should check source IP
  const hasLoopbackCheck = /\brateLimitKey\b/.test(studioSrc) &&
    (studioSrc.includes('127.0.0.1') || studioSrc.includes('::1')) &&
    /auth.*127|skip.*127|127.*auth|loopback.*auth/i.test(studioSrc);
  // The middleware in studio.js does NOT check if source is loopback before requiring auth.
  // ALL /api/* require auth, even from 127.0.0.1. This contradicts spec.
  // But our server binds to 0.0.0.0 (hardcoded). The spec says loopback should skip auth.
  // Finding: auth test above (#1) shows 127.0.0.1 gets 401 — meaning loopback does NOT skip auth.
  t('Loopback (127.0.0.1) requests skip auth (spec requirement)', false);
  console.log('  ^ FINDING: spec says loopback skips auth, but code requires auth for ALL /api/*');

  // 16) Check: spec says reject non-private source IPs with 403
  const hasIpRestriction = /10\.\d|172\.1[6-9]|172\.2\d|172\.3[01]|192\.168|private.*ip|non.*private|403.*ip|public.*403|restrict.*ip|block.*public|localSubnet/i.test(studioSrc);
  t('Non-private source IPs rejected with 403', hasIpRestriction);
  if (!hasIpRestriction) {
    console.log('  ^ FINDING: no code to reject non-private (public) source IPs with 403');
  }

  // 17) Check: constant-time token compare uses subtle.timingSafeCompare
  // subtle is NOT available in Node.js main context (it lives on crypto.subtle which requires --experimental-global-webcrypto or crypto.webcrypto)
  // This will throw at runtime
  t('Constant-time compare: uses crypto.subtle not bare "subtle" (Node.js compat)',
    !studioSrc.includes('subtle.timingSafeCompare') || studioSrc.includes('crypto.subtle') || studioSrc.includes('crypto.webcrypto'));
  if (studioSrc.includes('subtle.timingSafeCompare') && !studioSrc.includes('crypto.subtle')) {
    console.log('  ^ FINDING: bare "subtle" is undefined in Node.js — verifyToken will throw at runtime');
  }

  // 18) Check: spec says "machine.json controlRoom.bind" as fallback for bind address
  const hasMachineJson = studioSrc.includes('machine.json') || studioSrc.includes('controlRoom.bind');
  t('Falls back to machine.json controlRoom.bind for bind address', hasMachineJson);
  if (!hasMachineJson) {
    console.log('  ^ FINDING: spec mentions machine.json controlRoom.bind fallback; code does not reference it');
  }

  // 19) Check: "studio.js token rotate" — code has "token --regen" not "token rotate"
  // The CLI handler uses rest.includes('--regen') — spec says `studio.js token rotate`
  // The `token` command exists but uses --regen flag, not a `rotate` subcommand
  t('CLI has "token rotate" subcommand (spec)', studioSrc.includes('token.*rotate') || studioSrc.includes('"token"') && studioSrc.includes('rotate'));

  // 20) Check: spec says auth.json token is "random 32 bytes" — code uses 24 bytes
  const tokenBytes = studioSrc.match(/randomBytes\((\d+)\)/);
  const actualBytes = tokenBytes ? parseInt(tokenBytes[1]) : -1;
  t('Token is 32 bytes as spec requires (code uses ' + actualBytes + ' bytes)', actualBytes === 32);

  // Cleanup
  child.kill();
  await new Promise(r => setTimeout(r, 500));

  // ======== SUMMARY ========
  console.log(`\n--- Summary: ${tests.pass} passed, ${tests.fail} failed ---`);
  if (tests.fail > 0) {
    console.log('\nFailed checks:');
    for (const e of tests.errors) console.log(`  - ${e}`);
  }
  process.exit(tests.fail === 0 ? 0 : 1);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
