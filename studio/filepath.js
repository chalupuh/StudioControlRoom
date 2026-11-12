// Resolve a ?path= value from /api/file to a readable file inside the HQ repo, or null (forbidden).
// Accepts repo-relative paths ("docs/x.md") and absolute paths that point inside the repo
// ("C:/Users/.../AI Development Company/docs/x.md"), which is what gate links carry ({{home}}/docs/...).
// Only .md files under docs/ or .studio/checkpoints/ are allowed.
const path = require('path');

function resolveDocPath(raw, repo) {
  if (typeof raw !== 'string' || !raw || raw.includes('\0')) return null;
  let rel = raw.replace(/\\/g, '/');
  if (path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) {
    const root = path.resolve(repo).replace(/\\/g, '/').replace(/\/+$/, '') + '/';
    const abs = path.resolve(rel).replace(/\\/g, '/');
    const caseless = process.platform === 'win32';
    const inside = caseless ? abs.toLowerCase().startsWith(root.toLowerCase()) : abs.startsWith(root);
    if (!inside) return null;
    rel = abs.slice(root.length);
  }
  if (rel.split('/').includes('..')) return null;
  const norm = path.posix.normalize(rel);
  if (norm.startsWith('/') || norm.startsWith('..')) return null;
  if (!/\.md$/i.test(norm) || !(norm.startsWith('docs/') || norm.startsWith('.studio/checkpoints/'))) return null;
  const full = path.resolve(repo, norm);
  if (!full.startsWith(path.resolve(repo) + path.sep)) return null;
  return full;
}

module.exports = { resolveDocPath };
