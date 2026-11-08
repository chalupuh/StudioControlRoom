// Per-machine profile: HOME/.studio/machine.json (gitignored) merged over defaults.
// Every host-specific value (Ollama/ComfyUI URLs, parallelism, GPU slots, Git Bash, Control Room port)
// is read from here so the same checkout runs on different PCs. See machine.example.json.
// HOME resolution matches studio.js / engine.js: STUDIO_HOME env → studio.home.json → parent of studio/.
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  name: '',
  gitBash: '',
  ollama: { url: 'http://127.0.0.1:11434', numParallel: 4, keepAlive: '5m', contextLength: null },
  comfyUrl: 'http://127.0.0.1:8188',
  gpu: { vramGB: null, llmModel: null, llmSlots: null },
  controlRoom: { port: 4777, bind: '127.0.0.1' },
};

function studioHome() {
  if (process.env.STUDIO_HOME) return path.resolve(process.env.STUDIO_HOME);
  try { const c = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'studio.home.json'), 'utf8')); if (c.home) return path.resolve(c.home); } catch {}
  return path.resolve(__dirname, '..');
}

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
function merge(base, over) {
  const out = { ...base };
  for (const k of Object.keys(over || {})) {
    if (isObj(base[k]) && isObj(over[k])) out[k] = merge(base[k], over[k]);
    else if (over[k] !== undefined && over[k] !== null) out[k] = over[k];
  }
  return out;
}

/** Load the profile. `home` defaults to the studio HOME. Missing file → defaults; bad JSON → defaults + warning. */
function load(home = studioHome()) {
  const file = path.join(home, '.studio', 'machine.json');
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return merge(DEFAULTS, {}); }
  try {
    const j = JSON.parse(raw);
    if (!isObj(j)) throw new Error('top level must be an object');
    return merge(DEFAULTS, j);
  } catch (e) {
    console.warn(`[machine] ignoring ${file}: ${e.message} — using defaults`);
    return merge(DEFAULTS, {});
  }
}

/** Ollama URL without trailing slash, and as host:port for OLLAMA_HOST. */
const ollamaUrl = (m) => String(m.ollama.url).replace(/\/+$/, '');
const ollamaHost = (m) => ollamaUrl(m).replace(/^https?:\/\//, '');

module.exports = { load, DEFAULTS, studioHome, ollamaUrl, ollamaHost };
