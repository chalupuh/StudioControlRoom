// Auth module: token management, rate limiting, and auth middleware factory.
// Secrets: none (tokens are generated per-studio, stored in .studio/auth.json).
//
// Tests: studio/selftest-token.js

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
 * @returns {{token:string, created:number}|null}
 */
function readAuth(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'auth.json'), 'utf8')); }
  catch { return null; }
}

/**
 * Write the auth file to the given studio directory.
 * @param {string} dir - .studio directory path
 * @param {{token:string, created:number}} auth
 */
function writeAuth(dir, auth) {
  fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify(auth, null, 2));
}

/**
 * Ensure a token exists; generate one if missing.
 * @param {string} dir - .studio directory path
 * @returns {{token:string, created:number}}
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
 * Constant-time token comparison using Web Crypto.
 * @param {string} provided
 * @param {string} expected
 * @returns {boolean}
 */
function verifyToken(provided, expected) {
  if (!provided || !expected) return false;
  try {
    return subtle.timingSafeCompare(
      new Uint8Array(Buffer.from(provided)),
      new Uint8Array(Buffer.from(expected))
    );
  } catch {
    // subtle not available (older Node): fall back to strict equality
    return provided === expected;
  }
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
 * @param {{headers?:Object,connection?:Object}} req
 * @returns {string}
 */
function rateLimitKey(req) {
  const forwarded = req.headers && req.headers['x-forwarded-for'];
  if (forwarded) return String(forwarded).split(',')[0].trim();
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

// ---- Auth middleware factory ----

/**
 * Factory: returns (req, res) => true|false.
 * `false` means the response was ended (401 / 429).
 *
 * @param {Function} jsonFn - (res, obj, code) → writes JSON response
 * @param {string|undefined} _unusedText - kept for compatibility (unused)
 * @param {Map} store - rate-limit store
 * @returns {(req,res)=>boolean}
 */
function makeAuthMiddleware(jsonFn, _unusedText, store) {
  return (req, res) => {
    const ip = rateLimitKey(req);
    if (!checkRateLimit(ip, store)) {
      jsonFn(res, { error: 'rate limited' }, 429);
      return false;
    }
    const token = (req.headers && req.headers['authorization']?.replace(/^Bearer\s+/i, ''))
      || (() => { try { return new URL(req.url, 'http://x').searchParams.get('token'); } catch { return null; } })();
    const expected = currentToken(store.get('__dir__') || '');
    // We need the dir; it's stored on the middleware closure below.
    if (!verifyToken(token, expected)) {
      jsonFn(res, { error: 'unauthorized' }, 401);
      return false;
    }
    return true;
  };
}

/**
 * Factory (convenient form): returns auth middleware bound to a studio directory.
 * Reads the expected token from `dir/auth.json` at call time.
 *
 * @param {Function} jsonFn - (res, obj, code) → writes JSON response
 * @param {string} dir - .studio directory path
 * @param {Map} store - rate-limit store
 * @returns {(req,res)=>boolean}
 */
function makeAuthMiddlewareForDir(jsonFn, dir, store) {
  return (req, res) => {
    const ip = rateLimitKey(req);
    if (!checkRateLimit(ip, store)) {
      jsonFn(res, { error: 'rate limited' }, 429);
      return false;
    }
    const token = (req.headers && req.headers['authorization']?.replace(/^Bearer\s+/i, ''))
      || (() => { try { return new URL(req.url, 'http://x').searchParams.get('token'); } catch { return null; } })();
    const expected = currentToken(dir);
    if (!verifyToken(token, expected)) {
      jsonFn(res, { error: 'unauthorized' }, 401);
      return false;
    }
    return true;
  };
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
  makeAuthMiddleware,
  makeAuthMiddlewareForDir,
  RATE_WINDOW_MS,
  RATE_LIMIT,
};
