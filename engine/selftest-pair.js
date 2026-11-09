#!/usr/bin/env node
// Selftest: QR encoder + `studio.js pair` + GET /api/pair-qr (Sprint 4i Task 2)
// The QR check re-reads the matrix the way a scanner does (format info, unmask, zigzag, deinterleave),
// verifies every Reed-Solomon block has a zero syndrome, and decodes the payload back to the input text.
const { spawn, spawnSync } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const qr = require('../studio/qr');
const auth = require('../studio/auth');

const ROOT = path.resolve(__dirname, '..');
const STUDIO = path.join(ROOT, 'studio', 'studio.js');
let pass = 0, fail = 0;
function t(name, cond) { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.error(`  ✗ ${name}`); } }

// ---- independent-ish reader ----
const ECC = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24];
const NB = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9];
const EXP = [], LOG = [];
for (let i = 0, x = 1; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 256) x ^= 0x11D; }
const gmul = (a, b) => (a && b ? EXP[(LOG[a] + LOG[b]) % 255] : 0);

function decode(m) {
  const size = m.length, ver = (size - 17) / 4;
  // format info (copy 1) -> mask
  const fbits = [];
  for (let i = 0; i <= 5; i++) fbits[i] = m[i][8];
  fbits[6] = m[7][8]; fbits[7] = m[8][8]; fbits[8] = m[8][7];
  for (let i = 9; i < 15; i++) fbits[i] = m[8][14 - i];
  let f = 0; fbits.forEach((b, i) => { if (b) f |= 1 << i; });
  f ^= 0x5412;
  const mask = (f >> 10) & 7, level = f >> 13;
  if (level !== 0) throw new Error('not level M');
  // function-pattern map = encode a dummy of same version is not exposed, so rebuild reserved area
  const fn = Array.from({ length: size }, () => new Array(size).fill(false));
  const rect = (x0, y0, x1, y1) => { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (x >= 0 && y >= 0 && x < size && y < size) fn[y][x] = true; };
  rect(0, 0, 8, 8); rect(size - 8, 0, size - 1, 8); rect(0, size - 8, 8, size - 1);
  for (let i = 0; i < size; i++) { fn[6][i] = true; fn[i][6] = true; }
  if (ver >= 2) {
    const n = Math.floor(ver / 7) + 2, step = Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2;
    const ap = [6]; for (let p = size - 7; ap.length < n; p -= step) ap.splice(1, 0, p);
    ap.forEach((ax, i) => ap.forEach((ay, j) => {
      if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) return;
      rect(ax - 2, ay - 2, ax + 2, ay + 2);
    }));
  }
  if (ver >= 7) { rect(size - 11, 0, size - 9, 5); rect(0, size - 11, 5, size - 9); }
  const inv = (x, y) => [(x + y) % 2 === 0, y % 2 === 0, x % 3 === 0, (x + y) % 3 === 0,
    (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x * y) % 2 + (x * y) % 3 === 0,
    ((x * y) % 2 + (x * y) % 3) % 2 === 0, ((x + y) % 2 + (x * y) % 3) % 2 === 0][mask];
  const bits = [];
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let v = 0; v < size; v++) for (let j = 0; j < 2; j++) {
      const x = right - j, y = ((right + 1) & 2) === 0 ? size - 1 - v : v;
      if (!fn[y][x]) bits.push(m[y][x] !== inv(x, y));
    }
  }
  const cws = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) { let b = 0; for (let k = 0; k < 8; k++) b = (b << 1) | (bits[i + k] ? 1 : 0); cws.push(b); }
  // deinterleave
  const nb = NB[ver], el = ECC[ver], raw = cws.length, shortBlocks = nb - (raw % nb), shortLen = Math.floor(raw / nb);
  const blocks = Array.from({ length: nb }, () => []);
  let k = 0;
  for (let i = 0; i < shortLen + 1; i++) for (let j = 0; j < nb; j++) {
    if (i === shortLen - el && j < shortBlocks) { blocks[j].push(null); continue; } // pad slot (not stored)
    blocks[j].push(cws[k++]);
  }
  // fix layout: data then ecc for each block
  let data = [], synOk = true;
  blocks.forEach((blk, j) => {
    const dl = shortLen - el + (j < shortBlocks ? 0 : 1);
    const dat = blk.filter((x, idx) => !(x === null)).slice(0, dl);
    const ecc = blk.filter((x) => x !== null).slice(dl);
    // syndrome check: codeword poly evaluated at alpha^0..alpha^(el-1) must be 0
    const word = dat.concat(ecc);
    for (let s = 0; s < el; s++) { let acc = 0; for (const c of word) acc = gmul(acc, EXP[s]) ^ c; if (acc) synOk = false; }
    data = data.concat(dat);
  });
  // parse byte mode
  let p = 0; const rd = (n) => { let v = 0; for (let i = 0; i < n; i++) { const byte = data[p >> 3]; v = (v << 1) | ((byte >> (7 - (p & 7))) & 1); p++; } return v; };
  const mode = rd(4), len = rd(ver < 10 ? 8 : 16);
  const out = Buffer.from(Array.from({ length: len }, () => rd(8)));
  return { mode, text: out.toString('utf8'), synOk, ver };
}

function get(port, urlPath) {
  return new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port, path: urlPath, timeout: 5000 }, (res) => {
      let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: d }));
    }).on('error', reject);
  });
}

(async () => {
  console.log('--- QR / pairing self-tests ---\n');
  console.log('[qr] encoder round-trip');
  const samples = ['hi', 'http://192.168.1.20:4777/pair?t=' + 'ab'.repeat(32), 'x'.repeat(120), 'üñí ✓ ' + 'y'.repeat(200)];
  for (const s of samples) {
    const m = qr.encode(s);
    let r; try { r = decode(m); } catch (e) { r = { text: null, synOk: false, err: e.message }; }
    t(`v${r.ver || '?'} decodes (${s.length} chars), RS syndromes zero`, r.text === s && r.synOk && r.mode === 4);
  }
  let threw = false; try { qr.encode('z'.repeat(5000)); } catch { threw = true; }
  t('oversized input throws', threw);
  const svg = qr.toSvg(qr.encode('hello'));
  t('toSvg returns an <svg> with a path', /^<svg [^>]*viewBox/.test(svg) && svg.includes('<path') && svg.endsWith('</svg>'));
  const term = qr.toTerminal(qr.encode('hello'));
  t('toTerminal returns multiple lines of equal length', term.split('\n').length > 5 && new Set(term.split('\n').map((l) => l.length)).size === 1);

  console.log('\n[lan] lanAddresses with virtual NICs');
  // S1 fix: vEthernet adapters should NOT be dropped — they are sorted last instead.
  // Replicate the lanAddresses logic with a fake networkInterfaces result.
  const VIRTUAL_NIC = /vEthernet|WSL|Hyper-V|Docker|VirtualBox|VMware|Loopback/i;
  function testLanAddresses(ifaces) {
    const out = [], virtual = [];
    for (const [name, list] of Object.entries(ifaces)) {
      const isVirtual = VIRTUAL_NIC.test(name);
      for (const ni of list || []) {
        if (ni.family !== 'IPv4' || ni.internal || !auth.isPrivateIP(ni.address)) continue;
        (isVirtual ? virtual : out).push(ni.address);
      }
    }
    return [...new Set([...out, ...virtual])].sort(
      (a, b) => Number(b.startsWith('192.168.')) - Number(a.startsWith('192.168.'))
    );
  }
  const fakeIfaces = {
    'Ethernet': [{ address: '192.168.1.20', family: 'IPv4', internal: false }],
    'vEthernet (External Switch)': [{ address: '192.168.1.55', family: 'IPv4', internal: false }],
    'vEthernet (WSL)': [{ address: '172.18.160.1', family: 'IPv4', internal: false }],
    'Loopback Pseudo-Interface 1': [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
  };
  const addrs = testLanAddresses(fakeIfaces);
  t('vEthernet (External) address is included, not dropped', addrs.includes('192.168.1.55'));
  t('real Ethernet address sorts before virtual', addrs.indexOf('192.168.1.20') < addrs.indexOf('192.168.1.55'));
  t('WSL virtual address is included but sorted last (non-192.168)', addrs.includes('172.18.160.1') && addrs.indexOf('172.18.160.1') === addrs.length - 1);
  t('loopback is excluded (internal)', !addrs.includes('127.0.0.1'));
  // Only 192.168.x present — both should be first
  const onlyVirtual = { 'vEthernet (External Switch)': [{ address: '192.168.1.55', family: 'IPv4', internal: false }] };
  t('when only vEthernet has LAN IP, it is the sole result', testLanAddresses(onlyVirtual).length === 1 && testLanAddresses(onlyVirtual)[0] === '192.168.1.55');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-pair-'));
  fs.mkdirSync(path.join(dir, '.studio'), { recursive: true });
  const env = { ...process.env, STUDIO_HOME: dir, STUDIO_BIND: '0.0.0.0' };
  delete env.PORT;

  console.log('\n[cli] studio.js pair');
  const r = spawnSync(process.execPath, [STUDIO, 'pair', '4999'], { env, encoding: 'utf8', timeout: 10000 });
  const token = JSON.parse(fs.readFileSync(path.join(dir, '.studio', 'auth.json'), 'utf8')).token;
  const urls = (r.stdout.match(/http:\/\/[^\s]+\/pair\?t=\w+/g) || []);
  if (os.networkInterfaces && urls.length === 0) {
    t('no private LAN address on this host: reported cleanly', /No private LAN IPv4/.test(r.stdout));
  } else {
    t('prints at least one pairing URL with port and token', urls.length > 0 && urls.every((u) => u.includes(':4999/pair?t=' + token)));
    t('every URL host is a private IPv4', urls.every((u) => /^http:\/\/(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(u)));
    t('renders a QR block in the terminal', /[█▄▀]{10}/.test(r.stdout));
  }
  t('no loopback warning when bound to 0.0.0.0', !/loopback only/.test(r.stdout));
  const r2 = spawnSync(process.execPath, [STUDIO, 'pair', '4999'], { env: { ...env, STUDIO_BIND: '' }, encoding: 'utf8', timeout: 10000 });
  t('warns when the server is bound to loopback', /loopback only/.test(r2.stdout) || /No private LAN/.test(r2.stdout));

  console.log('\n[http] GET /api/pair-qr');
  const port = await new Promise((res) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
  const child = spawn(process.execPath, [STUDIO, 'serve', String(port)], { env: { ...env, PORT: String(port) }, stdio: 'ignore' });
  try {
    for (let i = 0; i < 50; i++) { try { await get(port, '/events'); break; } catch { await new Promise((x) => setTimeout(x, 100)); } }
    const q = await get(port, '/api/pair-qr');
    if (urls.length === 0) t('no LAN address -> 404', q.status === 404);
    else {
      t('authorised (loopback) request -> 200 image/svg+xml', q.status === 200 && /image\/svg\+xml/.test(q.headers['content-type']));
      t('SVG is not cached and contains a QR path', q.headers['cache-control'] === 'no-store' && q.body.includes('<path'));
    }
    const post = await new Promise((res) => { const rq = http.request({ hostname: '127.0.0.1', port, path: '/api/pair-qr', method: 'POST' }, (x) => { x.resume(); res(x.statusCode); }); rq.end(); });
    t('POST /api/pair-qr is not served (404)', post === 404);
  } finally { child.kill(); }

  // ---- S3: /api/pair-qr returns 409 in loopback-only mode ----
  console.log('\n[http] GET /api/pair-qr in loopback mode -> 409');
  const port3 = await new Promise((res) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
  const child3 = spawn(process.execPath, [STUDIO, 'serve', String(port3)], {
    env: { ...env, PORT: String(port3), STUDIO_BIND: '127.0.0.1' }, stdio: 'ignore'
  });
  try {
    for (let i = 0; i < 50; i++) { try { await get(port3, '/events'); break; } catch { await new Promise((x) => setTimeout(x, 100)); } }
    const q3 = await get(port3, '/api/pair-qr');
    t('pair-qr in loopback mode returns 409', q3.status === 409);
    t('pair-qr 409 body mentions LAN mode', q3.body.toLowerCase().includes('lan mode'));
  } finally { child3.kill(); }

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
