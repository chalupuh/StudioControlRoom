// Auth module: token management, rate limiting, and auth middleware factory.
// Secrets: none (tokens are generated per-studio, stored in .studio/auth.json).
//
// Tests: engine/selftest-auth.js

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 5; // spec: 5 failed attempts per IP per minute -> 429

// ---- Token management ----

/** Generate a cryptographically random hex token (64 chars = 32 bytes). */
function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Read the auth file from the given studio directory.
 * @param {string} dir - .studio directory path
 * @returns {{token:string,created:number}|null}
 */
function readAuth(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'auth.json'), 'utf8')); }
  catch { return null; }
}

/**
 * Write the auth file to the given studio directory.
 * @param {string} dir - .studio directory path
 * @param {{token:string,created:number}} auth
 */
function writeAuth(dir, auth) {
  fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify(auth, null, 2));
}

/**
 * Ensure a token exists; generate one if missing.
 * @param {string} dir - .studio directory path
 * @returns {{token:string,created:number}}
 */
function ensureToken(dir) {
  let a = readAuth(dir);
  if (!a || !a.token) {
    a = { token: generateToken(), created: Date.now() };
    writeAuth(dir, a);
  }
  return a;
}

/**
 * Return the current token or null.
 * @param {string} dir - .studio directory path
 * @returns {string|null}
 */
function currentToken(dir) {
  return readAuth(dir)?.token || null;
}

/**
 * Constant-time token comparison using crypto.timingSafeEqual.
 * @param {string} provided - token from the request
 * @param {string} expected - token from auth.json
 * @returns {boolean}
 */
function verifyToken(provided, expected) {
  if (!provided || !expected) return false;
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ---- Rate limiter (per-IP, in-memory) ----

/**
 * Create a fresh rate-limit bucket store.
 * Each studio instance should get its own store to avoid cross-test contamination.
 * @returns {Map<string,{start:number,count:number}>}
 */
function createRateStore() {
  return new Map();
}

/**
 * Extract the client IP from an HTTP request (or object with headers/connection).
 * Uses the real socket address, NOT X-Forwarded-For (spoofable).
 * @param {{headers?:Object,connection?:Object}} req
 * @returns {string}
 */
function rateLimitKey(req) {
  const socket = req.connection && req.connection.remoteAddress;
  return socket ? socket.replace(/^::ffff:/, '') : 'unknown';
}

/**
 * Check whether the given IP has exceeded its rate limit.
 * @param {string} ip
 * @param {Map} store - rate-limit store (from createRateStore())
 * @param {number} [windowMs] - window size in ms (default RATE_WINDOW_MS)
 * @param {number} [limit] - max requests per window (default RATE_LIMIT)
 * @param {number} [nowMs] - override Date.now() for testing
 * @returns {boolean} true = allowed, false = rate-limited
 */
function checkRateLimit(ip, store, windowMs, limit, nowMs) {
  const now = nowMs != null ? nowMs : Date.now();
  const w = windowMs ?? RATE_WINDOW_MS;
  const l = limit ?? RATE_LIMIT;
  let bucket = store.get(ip);
  if (!bucket || now - bucket.start > w) {
    bucket = { start: now, count: 0 };
    store.set(ip, bucket);
  }
  bucket.count++;
  // prune old buckets when store is large
  if (store.size > 500) {
    for (const [k, v] of store) { if (now - v.start > w) store.delete(k); }
  }
  return bucket.count <= l;
}

/**
 * Record a successful auth, resetting the failure counter for this IP.
 * @param {string} ip
 * @param {Map} store
 */
function resetRateLimit(ip, store) {
  store.delete(ip);
}

// ---- Auth middleware factory ----

/**
 * Factory: returns (req, res) => true|false.
 * `false` means the response was ended (401 / 429).
 *
 * Reads the expected token from `dir/auth.json` at call time.
 * Loops back (127.0.0.1 / ::1) skip auth entirely.
 * Non-private source IPs are rejected with 403.
 *
 * @param {Function} jsonFn - (res, obj, code) -> writes JSON response
 * @param {string} dir - .studio directory path
 * @param {Map} store - rate-limit store (from createRateStore())
 * @returns {(req,res)=>boolean}
 */
function makeAuthMiddleware(jsonFn, dir, store) {
  return (req, res) => {
    const ip = rateLimitKey(req);

    // loopback always skips auth
    if (ip === '127.0.0.1' || ip === '::1') return true;

    // reject non-private source IPs
    if (!isPrivateIP(ip)) {
      jsonFn(res, { error: 'forbidden' }, 403);
      return false;
    }

    // check rate limit (only failed attempts count, but we check before token)
    if (!checkRateLimit(ip, store)) {
      jsonFn(res, { error: 'rate limited' }, 429);
      return false;
    }

    // extract token from Bearer header or cookie
    let token = req.headers['authorization']?.replace(/^Bearer\s+/i, '');
    if (!token) {
      // try cookie
      const cookies = parseCookies(req.headers['cookie'] || '');
      token = cookies.studio_token || null;
    }

    const expected = currentToken(dir);
    if (!verifyToken(token, expected)) {
      jsonFn(res, { error: 'unauthorized' }, 401);
      return false;
    }

    // success: reset failure counter
    resetRateLimit(ip, store);
    return true;
  };
}

// ---- Private IP helpers ----

/** Check if an IPv4 address is in a private range. */
function isPrivateIP(ip) {
  // loopback
  if (ip === '127.0.0.1' || ip === '::1') return true;
  // link-local
  if (ip === '169.254.0.0' || ip.startsWith('169.254.')) return true;

  // parse IPv4
  const parts = ip.split('.');
  if (parts.length === 4) {
    const [a, b] = [parseInt(parts[0], 10), parseInt(parts[1], 10)];
    // 10.0.0.0/8
    if (a === 10) return true;
    // 172.16.0.0/12
    if (a === 172 && b >= 16 && b <= 31) return true;
    // 192.168.0.0/16
    if (a === 192 && b === 168) return true;
  }

  // IPv6 loopback / local
  if (ip === '::1' || ip === '::' || ip.startsWith('fd') || ip.startsWith('fe80')) return true;

  return false;
}

/** Simple cookie parser: "k=v; k2=v2" -> {k: v, k2: v2}. */
function parseCookies(header) {
  const out = {};
  for (const pair of header.split(';')) {
    const idx = pair.indexOf('=');
    if (idx < 0) continue;
    const key = pair.slice(0, idx).trim();
    const val = pair.slice(idx + 1).trim();
    if (key) out[key] = val;
  }
  return out;
}

module.exports = {
  generateToken,
  readAuth,
  writeAuth,
  ensureToken,
  currentToken,
  verifyToken,
  createRateStore,
  rateLimitKey,
  checkRateLimit,
  resetRateLimit,
  makeAuthMiddleware,
  isPrivateIP,
  parseCookies,
  RATE_WINDOW_MS,
  RATE_LIMIT,
};
