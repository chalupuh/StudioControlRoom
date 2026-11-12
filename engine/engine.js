#!/usr/bin/env node
// Studio Workflow Engine ("Kaito"): runs pipelines as a state machine so the expensive
// Claude session doesn't have to. Local models do the work; Claude only at gates/escalation.
//
//   node tools/engine/engine.js start <pipeline> [--var key=value ...]   create + run until a gate/stop
//   node tools/engine/engine.js resume <runId>                            continue (after approve / un-pause)
//   node tools/engine/engine.js approve <runId> [approve|reject] ["note"] answer the owner gate
//   node tools/engine/engine.js status [runId]                            list runs / show one
//   node tools/engine/engine.js pipelines                                  list pipelines
//
// Pipeline stage types (tools/engine/pipelines/*.json):
//   agent   { id, agent, tier: local|local-fast|sonnet|opus, task, expect:[paths], check:"cmd", maxTurns }
//   gate    { id, title, show:[paths] }            stops until the owner approves
//   script  { id, run:"cmd" }                       deterministic step, no model
//   foreach { id, items:{ file, regex }, stages:[...] }  repeats sub-stages per match ({{item}})
//   agent stages may add  rework:{ to:"build", verdict:"<report path template>", max:3, failRegex?:"..." }
//   so an honest 'VERDICT: FAIL' loops back to the build stage (same foreach item) instead of climbing tiers.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync, execFileSync } = require('child_process');
const codexPath = require('./codex-path.js');

// REPO = the org workspace (STUDIO_HOME): agents, docs, pipelines, runtime data. The engine itself may live
// elsewhere (StudioControlRoom). Resolution: STUDIO_HOME env → studio.home.json at the software root → legacy.
const machineLib = require('../studio/machine');
const REPO = machineLib.studioHome(path.resolve(__dirname, '..', '..')); // legacy fallback: engine inside HOME/tools/engine
const MACHINE = machineLib.load(REPO); // per-machine profile (REPO/.studio/machine.json)
const PIPES = path.join(REPO, 'tools', 'engine', 'pipelines');
const RUNS = path.join(REPO, '.studio', 'runs');
const STUDIO = [path.join(__dirname, '..', 'studio', 'studio.js'), path.join(REPO, '.studio', 'studio.js')].find((p) => fs.existsSync(p));

// ---- model tiers (ADR 0001) ----
const TIERS = {
  local:        { model: 'qwen3.6:27b',     local: true },
  'local-fast': { model: 'qwen3-coder:30b', local: true },
  codex:        { model: 'codex',           local: false },
  sonnet:       { model: 'sonnet',          local: false },
  opus:         { model: 'opus',            local: false },
};
// Which provider serves a tier (usage events carry this).
const providerOf = (tier) => (tier === 'codex' ? 'openai' : TIERS[tier] && TIERS[tier].local ? 'ollama' : 'anthropic');
// Escalation ladder when a stage fails its checks: retry once, then move up.
// Codex sits between local retry and Sonnet (ADR 0004).
const LADDER = {
  'local-fast': ['local-fast', 'local', 'codex', 'sonnet'],
  local:        ['local', 'local', 'codex', 'sonnet'],
  codex:        ['codex', 'sonnet'],
  sonnet:       ['sonnet', 'opus'],
  opus:         ['opus'],
};

const now = () => new Date().toISOString();
const ev = (obj) => { try { fs.appendFileSync(path.join(REPO, '.studio', 'events.jsonl'), JSON.stringify({ ts: Date.now(), ...obj }) + '\n'); } catch {} };
const { teamOf } = require('../studio/teams');
// Paused if the global switch is paused, or (when agentId is given) that agent's team is paused.
const paused = (agentId) => { try {
  const c = JSON.parse(fs.readFileSync(path.join(REPO, '.studio', 'control.json'), 'utf8'));
  if (c.state === 'paused') return true;
  if (!agentId || !c.teams) return false;
  let roster = null;
  try { roster = JSON.parse(fs.readFileSync(path.join(REPO, '.studio', 'roster.json'), 'utf8')); } catch {}
  return c.teams[teamOf(agentId, roster)] === 'paused';
} catch { return false; } };

function claudeExe() {
  if (process.env.CLAUDE_EXE) return process.env.CLAUDE_EXE;
  const base = path.join(process.env.LOCALAPPDATA || '', 'Claude-Data');
  const found = [];
  const walk = (d, depth) => { if (depth > 5) return; let es = []; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p, depth + 1); else if (e.name === 'claude.exe') found.push(p); } };
  walk(base, 0);
  found.sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs);
  if (!found.length) throw new Error('claude.exe not found; set CLAUDE_EXE');
  return found.pop();
}

function fill(tpl, vars, depth = 0) {
  return String(tpl || '')
    .replace(/\{\{file:([^}]+)\}\}/g, (_, f) => { const p = path.resolve(REPO, fill(f, vars)); return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : `(missing: ${f})`; })
    .replace(/\{\{(\w+)\}\}/g, (_, k) => {
      const v = vars[k];
      if (v === undefined || v === null) return `{{${k}}}`;
      // a var whose value names other vars (title "feat: internal sprint {{sprint}}") is filled too, one level deep
      return depth < 1 && typeof v === 'string' && /\{\{\w+\}\}/.test(v) ? fill(v, vars, depth + 1) : v;
    });
}

// Forward slashes: these paths are substituted into JS/JSON/shell strings in pipeline commands, where
// Windows backslashes become escape sequences and break the path.
const toSlash = (p) => String(p).split(String.fromCharCode(92)).join('/');

// Read an HQ role file (.claude/agents/<name>.md) into Claude Code's --agents JSON shape.
function agentDefinition(name) {
  const f = path.join(REPO, '.claude', 'agents', name + '.md');
  if (!fs.existsSync(f)) return null;
  const txt = fs.readFileSync(f, 'utf8');
  const m = txt.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { description: name, prompt: txt };
  const fm = Object.fromEntries(m[1].split(/\r?\n/).map((l) => l.match(/^(\w+):\s*(.*)$/)).filter(Boolean).map((x) => [x[1], x[2].trim()]));
  const def = { description: fm.description || name, prompt: m[2].trim() };
  if (fm.tools) def.tools = fm.tools.split(',').map((t) => t.trim()).filter(Boolean);
  return def;
}

// The Studio rules line appended to every stage prompt that runs outside HQ (Claude and Codex alike).
function studioRules(stage, cwd) {
  const logCmd = cwd === REPO ? 'node .studio/studio.js' : `node "${STUDIO}"`;
  return `

Studio rules: work only inside this repository (${cwd}). Org docs, specs and backlogs live in ${REPO} (read-only unless the task says to write there). Report progress with \`${logCmd} log ${stage.agent} <pct> "<msg>"\`.`;
}

// ---- Codex runner (ADR 0004) ----

// Minimal TOML parser for .codex/agents/<name>.toml files.
// Only needs: key = "value", key = """multiline""", key = '''multiline''', key = ['array'].
function parseSimpleTOML(src) {
  const result = {};
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) { i++; continue; }
    // Triple-quoted basic string (""")
    const mDQ = line.match(/^(\w+)\s*=\s*"""([\s\S]*?)"""\s*$/);
    if (mDQ) { result[mDQ[1]] = mDQ[2]; i++; continue; }
    // Triple-quoted literal string (''')
    const mTSQ = line.match(/^(\w+)\s*=\s*'''([\s\S]*?)'''\s*$/);
    if (mTSQ) { result[mTSQ[1]] = mTSQ[2]; i++; continue; }
    // Triple-quoted string spanning several lines (the real .codex/agents format)
    const mML = line.match(/^(\w+)\s*=\s*"""(.*)$/);
    if (mML) {
      const parts = mML[2] ? [mML[2]] : [];
      i++;
      while (i < lines.length && !lines[i].includes('"""')) parts.push(lines[i++]);
      if (i < lines.length) { const tail = lines[i].slice(0, lines[i].indexOf('"""')); if (tail) parts.push(tail); }
      result[mML[1]] = parts.join('\n').trim();
      i++; continue;
    }
    // Triple-quoted literal string spanning several lines
    const mMLSQ = line.match(/^(\w+)\s*=\s*'''(.*)$/);
    if (mMLSQ) {
      const parts = mMLSQ[2] ? [mMLSQ[2]] : [];
      i++;
      while (i < lines.length && !lines[i].includes("'''")) parts.push(lines[i++]);
      if (i < lines.length) { const tail = lines[i].slice(0, lines[i].indexOf("'''")); if (tail) parts.push(tail); }
      result[mMLSQ[1]] = parts.join('\n').trim();
      i++; continue;
    }
    // Quoted string
    const mSQ = line.match(/^(\w+)\s*=\s*"(.*)"$/);
    if (mSQ) { result[mSQ[1]] = mSQ[2]; i++; continue; }
    // Boolean / number / array
    const mKV = line.match(/^(\w+)\s*=\s*(.+)$/);
    if (mKV) {
      let v = mKV[2].trim();
      if (v === 'true') v = true;
      else if (v === 'false') v = false;
      else if (/^\d+$/.test(v)) v = Number(v);
      result[mKV[1]] = v;
    }
    i++;
  }
  return result;
}

// Locate the Codex CLI binary (shared with the bench: engine/codex-path.js).
const findCodex = () => codexPath.findCodex(REPO);

// Load the developer_instructions from HQ .codex/agents/<name>.toml.
function loadCodexAgent(name) {
  const f = path.join(REPO, '.codex', 'agents', name + '.toml');
  if (!fs.existsSync(f)) return null;
  const data = parseSimpleTOML(fs.readFileSync(f, 'utf8'));
  return data.developer_instructions || null;
}

// Parse `codex exec --json` JSONL output (and the spawn result) into the same
// { result, error, usage, turns } shape parseRunOutput returns, plus `limited` and `missing`.
// Handles both event styles: item.completed/turn.completed/turn.failed and plain result/usage/error.
const CODEX_LIMIT_RE = /rate[\s_-]*limit|usage[\s_-]*limit|limit reached|quota|too many requests|\b429\b|billing|insufficient_quota/i;
function parseCodexOutput(r) {
  let result = '', error = null, turns = 0, limitedEvent = false;
  const usage = { in: 0, out: 0, cached: 0 }; let sawUsage = false;
  const addUsage = (u) => { if (!u) return; sawUsage = true; usage.in += u.input_tokens || 0; usage.out += u.output_tokens || 0; usage.cached += u.cached_input_tokens || u.cache_read_input_tokens || 0; };
  const errMsg = (e) => (typeof e === 'string' ? e : e && (e.message || JSON.stringify(e))) || 'codex error';
  for (const line of (r.stdout || '').split('\n')) {
    let o; try { o = JSON.parse(line.trim()); } catch { continue; }
    if (!o || typeof o !== 'object') continue;
    if (o.type === 'item.completed' && o.item && o.item.type === 'agent_message') result = String(o.item.text || '');
    else if (o.type === 'result') result = String(o.result || '');
    else if (o.type === 'turn.completed') { turns++; addUsage(o.usage); }
    else if (o.type === 'usage') addUsage(o.usage || o);
    else if (o.type === 'turn.failed' || o.type === 'error') {
      error = errMsg(o.error || o.message);
      if (o.rate_limit || o.code === 429 || CODEX_LIMIT_RE.test(error)) limitedEvent = true;
    }
  }
  const stderr = r.stderr || '';
  const missing = !!(r.error && r.error.code === 'ENOENT');
  const failed = r.status !== 0 || !!r.error || !!r.signal;
  if (!error && failed && !result) error = stderr.slice(-800) || String(r.error?.code || r.error || r.signal || 'exit ' + r.status);
  const limited = !missing && !result && (limitedEvent || (failed && CODEX_LIMIT_RE.test(stderr)));
  if (result && !failed) error = null; // a clean exit with an answer wins over a stray non-fatal error event
  return { turns, result: result.slice(0, 2000), error, usage: sawUsage ? usage : null, limited, missing };
}

// Limited cache: after a limit error, later stages skip Codex for an hour (the CLI gives no reliable reset time).
const CODEX_LIMIT_FILE = path.join(REPO, '.studio', 'codex-limited.json');
const CODEX_LIMIT_MS = 60 * 60 * 1000;
function codexLimitedUntil() {
  try { const u = Number(JSON.parse(fs.readFileSync(CODEX_LIMIT_FILE, 'utf8')).until); return u > Date.now() ? u : 0; } catch { return 0; }
}

// Run a stage via the Codex CLI (ADR 0004): `codex exec --json`, non-interactive, workspace-write sandbox,
// cwd = stage workdir, prompt = HQ .codex/agents/<role>.toml instructions + the stage task (via stdin).
// Returns { tier, model, secs, cloud, result, error, usage, turns, limited?, skipped? }.
// limited (rate/usage cap) and skipped (no codex binary) mean: skip the tier, not a failure.
function runCodex(stage, vars, feedback, reworkNote) {
  const instructions = loadCodexAgent(stage.agent);
  let prompt = (instructions ? instructions + '\n\n' : '') + fill(stage.task, vars);
  if (stage.expect?.length) prompt += '\n\nYou MUST create/update these files: ' + stage.expect.map((e) => fill(e, vars)).join(', ') + '.';
  if (reworkNote) prompt += '\n\n' + reworkNote;
  if (feedback) prompt += '\n\nPrevious attempt failed these checks; fix them:\n' + feedback;
  // While Codex is rate/usage limited, go straight to the next tier without spawning (ADR 0004).
  const lim = codexLimitedUntil();
  if (lim) return { tier: 'codex', model: 'codex', secs: 0, cloud: true, result: '', error: 'codex limited until ' + new Date(lim).toISOString(), usage: null, turns: 0, limited: true, cached: true };
  const cwd = workdir(vars);
  // Working outside HQ: HQ docs (QA reports, reviews, sprint log) must stay writable, and the model needs the studio rules.
  if (cwd !== REPO) prompt += studioRules(stage, cwd);
  const args = ['exec', '--json', '--sandbox', 'workspace-write', '--skip-git-repo-check'];
  if (cwd !== REPO) args.push('--add-dir', REPO);
  args.push('-');
  const t0 = Date.now();
  const exe = findCodex();
  const spec = exe ? codexPath.codexSpawnSpec(exe, args) : null;
  const r = spec
    ? spawnSync(spec.command, spec.args, { cwd, shell: spec.shell, input: prompt, encoding: 'utf8', timeout: (stage.timeoutMin || 30) * 60000, maxBuffer: 64 * 1024 * 1024 })
    : { status: null, error: Object.assign(new Error('codex not found'), { code: 'ENOENT' }), stdout: '', stderr: '' };
  const p = parseCodexOutput(r);
  const base = { tier: 'codex', model: 'codex', secs: Math.round((Date.now() - t0) / 1000), cloud: true };
  if (p.missing) {
    return { ...base, result: '', error: 'codex binary not found', usage: null, turns: 0, skipped: true };
  }
  if (p.limited) { try { fs.writeFileSync(CODEX_LIMIT_FILE, JSON.stringify({ until: Date.now() + CODEX_LIMIT_MS, at: now() })); } catch {} }
  return { ...base, result: p.result, error: p.error, usage: p.usage, turns: p.turns, ...(p.limited ? { limited: true } : {}) };
}

// Agents, checks and scripts run in vars.workdir (absolute, or relative to REPO) when set; else in REPO.
const workdir = (vars) => (vars && vars.workdir ? path.resolve(REPO, fill(vars.workdir, vars)) : REPO);
const runFile = (id) => path.join(RUNS, id + '.json');
const save = (run) => { run.updated = now(); fs.mkdirSync(RUNS, { recursive: true }); fs.writeFileSync(runFile(run.id), JSON.stringify(run, null, 2)); };
const load = (id) => JSON.parse(fs.readFileSync(runFile(id), 'utf8'));

// Parse Claude Code JSON output and determine error status.
// Failure is detected via: is_error flag, non-zero exit code, spawn error, or termination signal.
// An error is reported only when hasFailure is true AND no result was produced.
// A partial success (hasFailure but hasResult) does NOT report an error.
// The [claude-code:unrecognized_model] stderr warning is logged to ignoredWarning for
// observability but NEVER suppresses an error — real failures must still be reported.
// Known context-window / output-limit failures of Claude Code and Ollama. A rework that "succeeds" with one of
// these as its answer changed nothing (S4h history held ok:true for "exceeded the 32000 output token maximum"),
// so they are hard failures before any verification. Short, error-sized texts only.
const CONTEXT_LIMIT_RX = new RegExp([
  'exceeded the \\d+ output token maximum', 'output token (?:limit|maximum)', 'prompt is too long', 'prompt too long',
  'context (?:length|window|limit)[^.]{0,40}(?:exceed|reached|too (?:long|large))', '(?:exceed|exceeds|exceeded)[^.]{0,40}context (?:length|window|limit)',
  'maximum context length', 'input length and `?max_tokens`? exceed', 'request too large', 'request_too_large', 'context_length_exceeded',
  'conversation is too long', 'ran out of context',
].join('|'), 'i');
const OUTPUT_MAX_RX = /exceeded the \d+ output token maximum/i; // seen with ok:true in S4h history: unconditional
// `failed` = the run itself failed (is_error / non-zero exit); the broader phrases only count then, so an honest
// short summary that mentions "prompt too long" is not misread.
const isCliErrorResult = (result, failed = false) => {
  const t = String(result || '').trim();
  // The limit phrases only count in a short, error-sized result, so a long real report that merely
  // mentions one (e.g. a review of this very check) is not misread as a failure.
  return /^API Error:/i.test(t) || (t.length < 500 && (OUTPUT_MAX_RX.test(t) || (failed && CONTEXT_LIMIT_RX.test(t))));
};
// A plan usage/rate limit ("You've hit your 5-hour limit · resets 4am") is not a failure of the stage: the
// engine waits for the reset and retries the same tier (2026-11-09: every run blocked at ~2 AM on this).
// Only short, error-sized texts count, and parseRunOutput only asks when the run itself failed, so a finished
// report that mentions rate limiting ("added a 429 rate limit to /login") is never misread.
const USAGE_LIMIT_RX = /hit your .{0,30}limit|\b(5-hour|session|weekly|opus|sonnet|usage)\s+limit\s+(reached|exceeded)|limit reached.{0,10}resets|^API Error:.{0,80}\b(rate[_ ]limit|429)\b/i;
const isUsageLimit = (text) => {
  const t = String(text || '').trim();
  return t.length > 0 && t.length < 600 && USAGE_LIMIT_RX.test(t);
};
function parseRunOutput(r) {
  let out = {};
  try { out = JSON.parse((r.stdout || '').trim().split('\n').filter(Boolean).pop() || '{}'); } catch {}
  const rawStderr = (r.stderr || '');
  const modelWarning = rawStderr.includes('[claude-code:unrecognized_model]');
  // Known harmless warnings must not be reported as the failure reason (they hid the real cause overnight).
  const stderr = rawStderr.split(/\r?\n/).filter((l) => !/^\s*(?:⚠ claude\.ai connectors are disabled|.*\[claude-code:unrecognized_model\]|Ignoring \d+ permissions\.allow entries)/.test(l)).join('\n').trim();
  const hasFailure = out.is_error || r.status !== 0 || !!r.error || !!r.signal;
  const hasResult = !!out.result;
  const usageLimit = !!hasFailure && (isUsageLimit(out.result) || isUsageLimit(rawStderr.slice(-2000)));
  // A CLI/API error printed as the "result" (e.g. "API Error: ... exceeded the 32000 output token maximum")
  // is not an answer: report it as an error so the attempt fails and climbs the tier ladder.
  // (is_error with a real result stays a partial success by design; see selftest.js.)
  const cliError = isCliErrorResult(out.result, !!hasFailure);
  return {
    turns: out.num_turns,
    result: String(out.result || '').slice(0, 2000),
    error: cliError ? String(out.result).trim().slice(0, 800)
      : (hasFailure && !hasResult) ? stderr.slice(-800) || out.subtype || String(r.error?.code || r.error || r.signal || 'exit ' + r.status) : null,
    ignoredWarning: modelWarning ? rawStderr.slice(0, 300) : null,
    usageLimit,
    usage: out.usage ? { in: out.usage.input_tokens, out: out.usage.output_tokens, cached: out.usage.cache_read_input_tokens } : null,
    hitTurnCap: out.subtype === 'error_max_turns',
    sessionId: out.session_id || null,
  };
}

// Env for a local (Ollama) tier. Claude Code does not know the local model, so it assumes a 200k window
// and never compacts, while Ollama serves only `contextLength` tokens (32k default). Past that, Ollama
// truncates the prompt and stops after a few tokens with max_tokens, which Claude Code reports as
// "exceeded the 32000 output token maximum" — every long local stage failed this way on 2026-11-09.
// Telling Claude Code the real window makes it auto-compact in time; the output cap leaves room for the reply.
const LOCAL_CONTEXT_DEFAULT = 32768;
function localTierEnv(tier, machineCfg = {}) {
  const o = machineCfg.ollama || {};
  const ctx = Number(o.contextLength) || LOCAL_CONTEXT_DEFAULT;
  const maxOut = Number(o.maxOutputTokens) || Math.min(8192, Math.floor(ctx / 4));
  return {
    ANTHROPIC_BASE_URL: o.url || 'http://127.0.0.1:11434', ANTHROPIC_AUTH_TOKEN: 'ollama', ANTHROPIC_API_KEY: '',
    ANTHROPIC_MODEL: tier.model, ANTHROPIC_DEFAULT_OPUS_MODEL: tier.model, ANTHROPIC_DEFAULT_SONNET_MODEL: tier.model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'qwen3:4b', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(ctx), CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(maxOut),
  };
}

// Every stage runs headless: nobody can answer a question or approve a prompt (2026-11-09: local runs asked
// "what would you like me to work on?", builders stopped to ask "want me to commit?").
// Only build stages working in their own checkout (a lane worktree or app repo) commit. Stages that run in the
// HQ checkout (R&D, research) or that only check work (QA, review) never commit: HQ sits on main with unrelated
// runtime files, and git there goes through branch → PR → squash merge (ADR 0002).
// Never on main/master either: internal pipelines use workdir={{soft}}, which is the main checkout if the
// engine is ever run without a lane worktree.
const currentBranch = (cwd) => { try { return spawnSync('git', ['branch', '--show-current'], { cwd, encoding: 'utf8' }).stdout.trim(); } catch { return ''; } };
const commitsWork = (stage, cwd) => mustChange(stage) && !!cwd && cwd !== REPO && !['main', 'master'].includes(currentBranch(cwd));
function unattendedRules(stage, cwd) {
  const git = commitsWork(stage, cwd)
    ? 'commit your changes to the current branch (git add <files> + git commit; never push, never switch branches)'
    : 'do NOT commit or change git state; the engine and the owner handle git for this stage';
  return 'You are running unattended in a pipeline: nobody will read questions or approve prompts until you finish. ' +
    `Never ask what to do, never ask for confirmation and never wait for approval. Do the task now, ${git}, write every required file, ` +
    'then end with a short report. If a command is refused, keep going with what you can do and say in the report exactly which command could not run.';
}
// Auto-approved for headless stages. Note: DISALLOWED_TOOLS only guards direct invocations; anything that can run
// arbitrary code (node -e, npm scripts) could still reach git. That is accepted for node/npm, which every build
// and QA stage needs; shells that take inline commands (powershell -c, pwsh, npx <any package>, find -exec) are
// not granted: PowerShell is limited to running script files, npx to the project's own dev tools.
const BASE_ALLOWED_TOOLS = ['Read', 'Write', 'Edit', 'Glob', 'Grep',
  'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)', 'Bash(git rev-parse:*)', 'Bash(git ls-files:*)',
  'Bash(git branch --show-current:*)',
  'Bash(npm test:*)', 'Bash(npm run:*)', 'Bash(npm install:*)', 'Bash(npm ci:*)', 'Bash(npm ls:*)', 'Bash(node:*)',
  'Bash(npx tsc:*)', 'Bash(npx jest:*)', 'Bash(npx vitest:*)', 'Bash(npx eslint:*)', 'Bash(npx prettier:*)', 'Bash(npx expo:*)',
  'Bash(powershell -NoProfile -ExecutionPolicy Bypass -File:*)', 'Bash(powershell -ExecutionPolicy Bypass -File:*)', 'Bash(powershell -File:*)',
  'Bash(ls:*)', 'Bash(cat:*)', 'Bash(head:*)', 'Bash(tail:*)', 'Bash(wc:*)', 'Bash(grep:*)', 'Bash(rg:*)', 'Bash(mkdir:*)', 'Bash(touch:*)',
  'Bash(cp:*)', 'Bash(mv:*)', 'Bash(cd:*)', 'Bash(pwd:*)', 'Bash(echo:*)', 'Bash(diff:*)', 'Bash(sort:*)'];
const COMMIT_TOOLS = ['Bash(git add:*)', 'Bash(git commit:*)', 'Bash(git mv:*)', 'Bash(git rm:*)', 'Bash(git restore:*)', 'Bash(git stash:*)'];
const DISALLOWED_TOOLS = ['Bash(git push:*)', 'Bash(git reset --hard:*)', 'Bash(git clean:*)', 'Bash(git checkout:*)',
  'Bash(git switch:*)', 'Bash(git rebase:*)', 'Bash(git -C:*)', 'Bash(gh:*)', 'Bash(npm publish:*)', 'Bash(rm -rf:*)', 'Bash(rm -fr:*)'];
const allowedToolsFor = (stage, cwd) => [...new Set([...BASE_ALLOWED_TOOLS, ...(commitsWork(stage, cwd) ? COMMIT_TOOLS : []), ...(stage.allowedTools || [])])];

// ---- run one agent stage on a given tier ----
// opts.resume continues an earlier session (the finalize turn) with opts.prompt and opts.maxTurns.
const LOCAL_TIMEOUT_MIN = Number(process.env.STUDIO_LOCAL_TIMEOUT_MIN) || 10;

function runAgent(stage, tierName, vars, feedback, reworkNote, opts = {}) {
  const tier = TIERS[tierName];
  // ADR 0004: codex tier uses the Codex CLI, not Claude Code
  if (tierName === 'codex') {
    return runCodex(stage, vars, feedback, reworkNote);
  }
  const env = { ...process.env };
  const machineCfg = MACHINE; // merged per-machine profile (machine.json over defaults)
  // Headless Claude Code on Windows needs Git Bash for its Bash tool; without this, agents have
  // no shell (can't run builds/tests) — found 2026-11-07 when QA couldn't run `npm run build`.
  // Resolution order: env STUDIO_GIT_BASH → .studio/machine.json gitBash → system default.
  if (process.platform === 'win32' && !env.CLAUDE_CODE_GIT_BASH_PATH) {
    const candidates = [process.env.STUDIO_GIT_BASH, machineCfg.gitBash, 'C:\\Program Files\\Git\\bin\\bash.exe'];
    const found = candidates.find((p) => p && fs.existsSync(p));
    if (found) env.CLAUDE_CODE_GIT_BASH_PATH = found;
  }
  if (tier.local) Object.assign(env, localTierEnv(tier, machineCfg));
  const cwd = workdir(vars);
  // Rework builders get a short, dedicated prompt (checklist first; the original task only as brief context).
  let prompt = opts.rework && reworkNote ? `${reworkNote}\n\nOriginal task, for context only (do NOT redo it):\n${fill(stage.task, vars).slice(0, 700)}` : fill(stage.task, vars);
  prompt += studioRules(stage, cwd);
  prompt += `
${unattendedRules(stage, cwd)}`;
  if (stage.expect?.length) prompt += `\nYou MUST create/update these files at exactly these absolute paths (not inside ${cwd} unless the path says so): ${stage.expect.map((e) => toSlash(path.resolve(REPO, fill(e, vars)))).join(', ')}.`;
  if (reworkNote && !opts.rework) prompt += `\n\n${reworkNote}`;
  if (feedback) prompt += `\n\nA previous attempt failed these checks; fix them:\n${feedback}`;
  if (opts.resume) prompt = opts.prompt;
  const args = ['-p', '--agent', stage.agent, '--model', tier.model, '--permission-mode', 'acceptEdits', '--output-format', 'json', '--max-turns', String(opts.maxTurns || stage.maxTurns || 25)];
  if (opts.resume) args.push('--resume', opts.resume);
  // Working outside HQ (e.g. a StudioControlRoom worktree): that checkout has no .claude/agents or
  // hooks, so pass the role definition and HQ's settings (pause hook, event logging) explicitly.
  if (cwd !== REPO) {
    const def = agentDefinition(stage.agent);
    if (def) args.push('--agents', JSON.stringify({ [stage.agent]: def }));
    const hqSettings = path.join(REPO, '.claude', 'settings.json');
    if (fs.existsSync(hqSettings)) args.push('--settings', hqSettings);
    args.push('--add-dir', REPO); // HQ docs (backlogs, sprint log, QA, reviews) must stay writable
  }
  // Headless runs can't answer permission prompts, and lane worktrees are "untrusted" folders whose project
  // settings Claude Code ignores, so the tools a stage needs (tests, builds, local commits) are granted on the
  // command line. Pushing, merging and destructive git stay with the ship script and the owner.
  args.push('--allowedTools', ...allowedToolsFor(stage, cwd), '--disallowedTools', ...DISALLOWED_TOOLS);
  const t0 = Date.now();
  // Local models can stall for the whole stage budget; cap them so the ladder falls through to Codex quickly.
  const limitMin = tier.local ? Math.min(stage.timeoutMin || 30, stage.localTimeoutMin || LOCAL_TIMEOUT_MIN) : (stage.timeoutMin || 30);
  const r = spawnSync(claudeExe(), args, { cwd: workdir(vars), env, input: prompt, encoding: 'utf8', timeout: limitMin * 60000, maxBuffer: 64 * 1024 * 1024 });
  const parsed = parseRunOutput(r);
  return {
    tier: tierName, model: tier.model, secs: Math.round((Date.now() - t0) / 1000),
    cloud: !tier.local,
    ...parsed,
  };
}

// Checks decide success, never the model's own claim (ADR 0001 rule 5).
// Fingerprint of the working tree (HEAD + uncommitted changes); null when the dir is not a git checkout.
function treeSnapshot(dir) {
  try {
    const git = (a) => require('child_process').execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return git(['rev-parse', 'HEAD']) + git(['status', '--porcelain', '-uall']) + git(['diff']);
  } catch { return null; }
}
// Stages that must produce changes: explicit "mustChange": true, or any stage whose id starts with "build".
const mustChange = (stage) => stage.mustChange ?? /^build/.test(stage.id || '');

// ---- rework baseline (rework-loop diagnosis causes 1-2) ----
// On a QA/review rejection the engine records what the tree looked like (HEAD, porcelain status, diff hash, and a
// content hash of every dirty/untracked file). A rework builder only succeeds if the tree differs from THAT
// baseline, not merely from its own start, and QA/review after the rework is only run on a non-empty manifest of
// the paths that changed since the baseline.
const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
function gitOut(dir, args) {
  try { return execFileSync('git', ['-c', 'core.quotepath=off', ...args], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024 }); } catch { return null; }
}
const lines = (s) => String(s || '').split(/\r?\n/).filter(Boolean);
const fileHash = (dir, rel) => { try { return sha256(fs.readFileSync(path.join(dir, rel))); } catch { return 'deleted'; } };
const IGNORED_PATH = /^(?:\.studio|node_modules|\.git)\//;
// Paths that differ from `rev`: tracked changes (committed since or uncommitted) plus untracked files.
function dirtyPaths(dir, rev) {
  const tracked = gitOut(dir, ['diff', '--name-only', '--relative', rev]);
  const untracked = gitOut(dir, ['ls-files', '--others', '--exclude-standard']);
  return [...new Set([...lines(tracked), ...lines(untracked)])].filter((p) => !IGNORED_PATH.test(p));
}
// null when `dir` is not a git checkout (or has no commit): the rework checks are then skipped, as treeSnapshot's are.
function gitState(dir) {
  const head = gitOut(dir, ['rev-parse', 'HEAD']);
  if (head === null) return null;
  const sha = head.trim();
  const diff = gitOut(dir, ['diff', 'HEAD']) || '';
  const files = Object.fromEntries(dirtyPaths(dir, sha).map((p) => [p, fileHash(dir, p)]));
  return { head: sha, porcelain: gitOut(dir, ['status', '--porcelain', '-uall']) || '', diffHash: sha256(diff), files };
}
// Paths whose content differs from the baseline, committed or not. `exclude` = absolute paths (reports) to ignore.
function changedSince(baseline, dir, exclude = [], only = null) {
  if (!baseline) return null;
  const pre = (only || []).map((x) => toSlash(x).replace(/\/?$/, '/'));
  const ex = new Set(exclude.map((e) => toSlash(path.relative(dir, e))));
  const cand = new Set([...dirtyPaths(dir, baseline.head), ...Object.keys(baseline.files || {})]);
  return [...cand].filter((p) => !ex.has(p) && !IGNORED_PATH.test(p) && (!pre.length || pre.some((x) => p.startsWith(x))) && (baseline.files && p in baseline.files ? baseline.files[p] !== fileHash(dir, p) : true)).sort();
}
// Paths that are the stage's own output, not a fix: its expect files and the shared sprint log (and the rejected
// report). Without this, writing the sprint log (or another lane's report in HQ) would count as "changed".
const reworkExcludes = (rec, target, vars) => [rec.report, rec.verdictReport, path.join(REPO, 'docs', 'internal', 'sprint-log.md'),
  ...((target && target.expect) || []).map((e) => path.resolve(REPO, fill(e, vars)))].map((p) => path.resolve(p));
// Commit policy: a rework in a lane worktree (not HQ, not main/master) must commit, so HEAD has to advance.
// On main or in HQ the engine/owner own git, so any scoped change vs the baseline is enough.
const requiresCommit = (dir) => !!dir && dir !== REPO && !['main', 'master'].includes(currentBranch(dir));

// Findings checklist extracted from a rejected report. Recognised, in this order of trust:
//  1. finding IDs (B-1, S2, N-9, F36, R3, optional letter suffix) as a heading, a bold lead-in or a bullet lead-in,
//     whether or not the line carries a severity word or a file:line;
//  2. status-table rows ("| B-1 | **STILL FAILING** | ..."): STILL FAILING / FAIL / OPEN / UNVERIFIED are kept,
//     FIXED ones are dropped (also from the list when a prose mention of the same ID exists);
//  3. legacy: bullets/headings that carry a severity word, a file:line, or sit under a severity heading.
// The result is ordered Blockers, then Should-fix, then the rest (stable).
const SEVERITY_RX = /\b(blockers?|should[- ]fix|nits?|critical|major|minor|high|medium|low)\b/i;
const FILEREF_RX = /[\w./\\[\]-]+\.\w{1,6}:\d+/;
const ID_RX = /^([BSNFR]-?\d{1,3}[a-z]?)(?![\w/=-])/;
// Lead-in FIXED must be upper-case and stand alone (so "Fixed-size buffer ..." is a title, not a status). Table status cells are looser.
const FIXED_STATUS_RX = /^FIXED(?![\w-])(?:\s*$|\s*[.:(\u2014\u2013,;])/;
const isFixedCell = (c) => /^fixed(?![\w-])/i.test(c);
const isOpenCell = (c) => /^(?:not fixed|still failing|still open|failing|failed|fail|unverified)(?![\w-])/i.test(c) || /^OPEN(?![\w-])/.test(c);
const MD_LEAD = /^(?:\*\*|__|`)+/;
const normSev = (s) => { const t = String(s || '').toLowerCase().replace(/[-\s]+/g, ' ').trim(); if (/^blocker/.test(t)) return 'blocker'; if (/^nit/.test(t)) return 'nit'; return t || null; };
const idSeverity = (id) => ({ B: 'blocker', S: 'should fix', N: 'nit' })[id[0]] || null;
const sevRank = (s) => (s === 'blocker' || s === 'critical' ? 0 : s === 'should fix' || s === 'major' || s === 'high' ? 1 : 2);
const stripMd = (s) => String(s || '').replace(/[*`_]/g, '').replace(/\s+/g, ' ').trim();
const idKey = (id) => id.replace(/^([A-Z])-?(\d)/, '$1-$2').toLowerCase();
const clean = (s) => String(s || '').replace(/\*\*|__/g, '').replace(/\s+/g, ' ').trim().slice(0, 300);
// Lead-in ID of a heading / bold / bullet line: { id, rest } or null. Plain (unbolded) bullets need a real separator,
// so prose like "- B-1 is still the main issue" is not a new finding; "F1-F18", "S-1..S-7" and "F19 = AC-72" never match.
function leadId(line) {
  let s = line; let heading = false;
  const h = /^#{1,6}\s+(.*)$/.exec(s); if (h) { s = h[1]; heading = true; }
  else { const b = /^(?:[-*+]|\d+[.)])\s+(.*)$/.exec(s); if (b) s = b[1]; }
  const bold = MD_LEAD.test(s);
  s = s.replace(MD_LEAD, '');
  const m = ID_RX.exec(s); if (!m) return null;
  let rest = s.slice(m[0].length).replace(/^\s*\([^)]*\)/, '');
  if (/^\s*=/.test(rest) || /^\s*\.\./.test(rest)) return null;
  const sep = /^((?:\*\*|__|`)*)(\s*[.:—–]\s*|\s+-\s+|\s+|$)/.exec(rest);
  if (!sep) return null;
  if (!heading && !bold && !sep[1] && !/[.:—–-]/.test(sep[2])) return null;
  rest = rest.slice(sep[0].length).replace(/(?:\*\*|__)\s*$/, '').trim();
  const id = m[1];
  if (FIXED_STATUS_RX.test(rest)) return { id, fixed: true, rest };
  if (rest.length < 6) return null;
  return { id, rest };
}
const tableCells = (line) => line.replace(/^\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
// Header row naming a Status column -> its index (else -1).
const statusHeader = (line) => tableCells(line).findIndex((c) => /^status$/i.test(stripMd(c)));
// ID'd table row -> { id, fixed, status, rest, ref } or null. A row with no recognisable status cell is an OPEN finding.
function tableFinding(line, statusCol = -1) {
  const cells = tableCells(line);
  const idm = ID_RX.exec(stripMd(cells[0]));
  if (!idm || cells.length < 2) return null;
  let si = statusCol > 0 && statusCol < cells.length ? statusCol : -1;
  if (si < 0) si = cells.findIndex((c, i) => i > 0 && (isOpenCell(stripMd(c)) || isFixedCell(stripMd(c))));
  const st = si >= 0 ? stripMd(cells[si]) : '';
  const rest = cells.filter((c, i) => i > 0 && i !== si).map(stripMd).filter(Boolean).join(' - ');
  const fixed = !!st && isFixedCell(st) && !isOpenCell(st);
  return { id: idm[1], fixed, status: st ? st.split(/[;(:,]/)[0].trim().toUpperCase() : 'OPEN', rest, ref: (FILEREF_RX.exec(cells.join(' ')) || [])[0] || null };
}
function extractFindings(txt) {
  const items = []; const fixed = new Set(); const openTable = new Set(); let section = null, cur = null, statusCol = -1;
  const add = (f) => { const o = items.find((x) => x.id && idKey(x.id) === idKey(f.id)); if (!o) items.push(f); else if (!o.explicit) { items[items.indexOf(o)] = f; if (!f.ref) f.ref = o.ref; return f; } else if (!o.ref && f.ref) o.ref = f.ref; return o || f; };
  for (const raw of String(txt || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || (/VERDICT|REQUEST CHANGES|^APPROVE/i.test(line) && line.length < 60)) continue;
    if (line[0] === '|') {
      cur = null;
      const hc = statusHeader(line); if (hc >= 0) { statusCol = hc; continue; }
      const t = tableFinding(line, statusCol); if (!t) continue;
      if (t.fixed) { fixed.add(idKey(t.id)); continue; }
      openTable.add(idKey(t.id));
      add({ id: t.id, severity: idSeverity(t.id) || section, ref: t.ref, text: `[${t.status}] ${t.rest}`.slice(0, 300), explicit: true });
      continue;
    }
    statusCol = -1;
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    const lead = leadId(line);
    if (lead) {
      cur = null;
      if (lead.fixed) { fixed.add(idKey(lead.id)); continue; }
      const sm = SEVERITY_RX.exec(lead.rest);
      cur = add({ id: lead.id, severity: idSeverity(lead.id) || (sm ? normSev(sm[1]) : section), ref: (FILEREF_RX.exec(lead.rest) || [])[0] || null, text: clean(lead.rest), explicit: true });
      continue;
    }
    if (heading) cur = null;
    if (cur) { if (!cur.ref) { const r = FILEREF_RX.exec(line); if (r) cur.ref = r[0]; } continue; } // body of an ID'd finding
    const bullet = /^(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (heading && SEVERITY_RX.test(heading[1]) && heading[1].length < 50 && !FILEREF_RX.test(heading[1])) { section = normSev((SEVERITY_RX.exec(heading[1]) || [])[1]); continue; }
    if (heading) { if (!SEVERITY_RX.test(heading[1])) section = null; if (!FILEREF_RX.test(heading[1])) continue; }
    const body = (heading || bullet || [])[1];
    if (!body || body.length < 12) continue;
    const ref = (FILEREF_RX.exec(body) || [])[0] || null;
    const sev = normSev((SEVERITY_RX.exec(body) || [])[1]) || section;
    if (!ref && !sev) continue;
    const idm = /^\W{0,2}((?:[A-Z]{1,3}[-.]?\d{1,3})|#\d{1,3})\b/.exec(body);
    items.push({ id: idm ? idm[1].replace(/^#/, 'F') : null, severity: sev, ref, text: clean(body) });
    if (items.length >= 200) break;
  }
  // drop repeats of an ID, and anything marked FIXED (unless a status table also lists it as still open)
  const seen = new Set(); const kept = [];
  const explicitKeys = new Set(items.filter((f) => f.explicit).map((f) => idKey(f.id)));
  for (const f of items) {
    if (!f.explicit && f.id && explicitKeys.has(idKey(f.id))) continue;
    if (f.id) { const k = idKey(f.id); if (seen.has(k)) continue; seen.add(k); if (fixed.has(k) && !openTable.has(k)) continue; }
    kept.push(f);
  }
  // findings without an explicit ID get the next free F<n>
  let n = 0; const used = new Set([...kept.map((f) => f.id).filter(Boolean), ...[...fixed, ...seen].map((k) => k.replace('-', '').toUpperCase())]);
  for (const f of kept) if (!f.id) { do n++; while (used.has(`F${n}`)); f.id = `F${n}`; used.add(f.id); }
  kept.forEach((f, i) => { f.i = i; });
  kept.sort((a, b) => sevRank(a.severity) - sevRank(b.severity) || a.i - b.i);
  return kept.slice(0, 40).map(({ id, severity, ref, text }) => ({ id, severity: severity || null, ref, text }));
}
// Blockers (and Should-fix) sections verbatim: used when the report has a non-empty Blockers section but no blocker
// reached the checklist, so blockers can never silently drop. Returns '' when no fallback is needed.
function findingsFallback(txt, findings) {
  const secs = { blocker: [], should: [] }; let cur = null, curLevel = 0, statusCol = -1;
  const mentioned = new Set(); const fixedIds = new Set();
  for (const raw of String(txt || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (line[0] === '|') {
      const hc = statusHeader(line); if (hc >= 0) { statusCol = hc; continue; }
      const t = tableFinding(line, statusCol);
      if (t && /^B/.test(t.id)) (t.fixed ? fixedIds : mentioned).add(idKey(t.id));
    } else statusCol = -1;
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h && !(cur && h[1].length > curLevel)) { // a deeper heading (### B-1.) stays inside the current section
      const t = stripMd(h[2]); curLevel = h[1].length;
      cur = /^blockers?\b/i.test(t) && t.length < 50 ? 'blocker' : /^should[- ]fix\b/i.test(t) && t.length < 50 ? 'should' : null;
      if (cur) secs[cur].push(raw);
      continue;
    }
    if (cur) secs[cur].push(raw);
    if (cur === 'blocker' && line[0] !== '|') for (const m of line.matchAll(/(?<![\w-])B-?\d{1,3}[a-z]?(?![\w-])/g)) mentioned.add(idKey(m[0]));
  }
  const content = secs.blocker.slice(1).map((l) => l.trim()).filter((l) => l && l !== '---');
  if (!content.length || content.every((l) => /^(?:[-*]\s*)?(?:\*\*)?(?:none|n\/a|no blockers?)\b/i.test(l))) return '';
  const have = new Set((findings || []).map((f) => idKey(f.id)));
  const missing = [...mentioned].filter((k) => !fixedIds.has(k) && !have.has(k));
  if ((findings || []).some((f) => f.severity === 'blocker') && !missing.length) return '';
  const body = [...secs.blocker, ...secs.should].join('\n').trim();
  return body.length > 6000 ? body.slice(0, 6000) + '\n[... truncated; read the full report]' : body;
}
const reworkRecords = (run) => (run.reworkRecords = run.reworkRecords || []);
const activeRecord = (run, target, status) => [...reworkRecords(run)].reverse().find((r) => r.target === target && r.status === status) || null;
const short = (sha) => String(sha || '').slice(0, 9);
// The dedicated, short rework prompt (cause 5): checklist first, edits before tests, report per finding ID.
function reworkPrompt(rec, dir) {
  const commit = rec.baseline && requiresCommit(dir);
  const list = rec.findings.length
    ? rec.findings.map((f) => `  ${f.id}${f.severity ? ` [${f.severity}]` : ''}${f.ref ? ` ${f.ref}` : ''}: ${f.text}`).join('\n')
    : '  (no individual findings could be extracted; read the report and fix every finding in it)';
  return `REWORK round ${rec.round}/${rec.max}. ${rec.rejectedBy} rejected the work. Full report (read it): ${rec.report} (sha256 ${short(rec.reportSha256)}).\n` +
    `Findings checklist (blockers first):\n${list}\n` +
    (rec.findingsFallback ? `The report has a Blockers section but no blocker could be extracted into the checklist. These sections are copied verbatim; every item in them is mandatory:\n${rec.findingsFallback}\n` : '') +
    'Fix blockers first; fix nits only after all blockers and should-fix items are done.\n' +
    (rec.baseline ? `Baseline at rejection: HEAD ${short(rec.baseline.head)}. The engine rejects this rework unless the tree differs from that baseline${commit ? ' AND you commit (HEAD must advance)' : ''}.\n` : '') +
    'Order of work: 1) make the edits for the checklist FIRST (no broad exploration); 2) ' + (commit ? 'commit; 3) ' : '') +
    'only then run the tests. Do not re-implement the original task or touch unrelated code. ' +
    'End with one line per finding ID: "<ID> FIXED <file>" or "<ID> NOT FIXED <why>".';
}
function reworkVerifyNote(rec, manifest) {
  const ids = rec.findings.map((f) => f.id);
  return `This is a re-check after rework round ${rec.round}: ${rec.rejectedBy} previously rejected the work (report ${rec.report}). ` +
    `Changed files since the rejection baseline (HEAD ${short(rec.baseline && rec.baseline.head)}):\n${manifest.map((p) => '  ' + p).join('\n') || '  (not available)'}\n` +
    (ids.length ? `Original finding IDs: ${ids.join(', ')}. In your report mark EACH ID as FIXED, STILL FAILING or UNVERIFIED, with evidence from the changed files; any STILL FAILING means VERDICT: FAIL.` : 'Verify that every original finding is fixed in the changed files; any still failing means VERDICT: FAIL.');
}

function verify(stage, vars, res) {
  const problems = [];
  if (res.error) problems.push('run error: ' + res.error);
  if (res.hitTurnCap) problems.push(`hit the ${stage.maxTurns || 25}-turn cap (likely stuck)`);
  if (!res.result.trim()) problems.push('empty final answer');
  for (const e of stage.expect || []) {
    const p = path.resolve(REPO, fill(e, vars));
    if (!fs.existsSync(p) || !fs.statSync(p).size) problems.push(`missing or empty: ${fill(e, vars)}`);
  }
  if (stage.check) {
    const c = spawnSync(fill(stage.check, vars), { cwd: workdir(vars), shell: true, encoding: 'utf8', timeout: 600000 });
    if (c.status !== 0) problems.push(`check failed: ${fill(stage.check, vars)}\n${(c.stdout + c.stderr).slice(-1200)}`);
  }
  // DoD: each heading must exist as a markdown heading (## ...) in the specified file.
  for (const entry of stage.dod || []) {
    const fpath = path.resolve(REPO, fill(entry.file, vars));
    const content = fs.existsSync(fpath) ? fs.readFileSync(fpath, 'utf8') : null;
    if (content === null) {
      for (const h of entry.headings || []) problems.push(`dod missing heading "${h}" — file ${fill(entry.file, vars)} does not exist`);
    } else {
      for (const h of entry.headings || []) {
        if (!new RegExp('^\\s*#{1,6}\\s+' + h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*$', 'mi').test(content)) {
          problems.push(`dod missing heading "${h}" in ${fill(entry.file, vars)}`);
        }
      }
    }
  }
  return problems;
}

// Pre-check: verify all required input paths exist before a stage runs.
// Returns an array of missing-path descriptions; empty array means all good.
function checkRequires(stage, vars) {
  const missing = [];
  for (const r of stage.requires || []) {
    const rp = fill(r, vars);
    const p = path.resolve(REPO, rp);
    if (!fs.existsSync(p)) missing.push(rp);
  }
  return missing;
}

// Resolve the build agent from the design.md "Team:" line.
// Picks the first of frontend-dev, mobile-dev, backend-dev named in that line.
// Falls back to "mobile-dev" if the file is missing, has no Team line, or
// the Team line contains no build role — and emits a progress warning in those cases.
// Accepts absolute paths or repo-relative paths (joined with REPO).
function resolveTeamLead(designPath) {
	const f = path.isAbsolute(designPath) ? designPath : path.join(REPO, designPath);
	let txt = '';
	try { txt = fs.readFileSync(f, 'utf8'); } catch {}
	// Match "Team:" with optional leading list bullets, optional bold markdown (* or **), any case.
	const teamRegex = /^\s*(?:[-*>]\s*)?(?:\*{1,2})?team(?:\*{1,2})?\s*:/i;
	const line = txt.split('\n').find((l) => teamRegex.test(l));
	if (!line) {
		console.warn('resolveTeamLead: no "Team:" line in', designPath, '— defaulting to mobile-dev');
		ev({ type: 'progress', agent: 'engine', pct: 0, status: 'warning', message: `no Team: line in ${designPath}; defaulting to mobile-dev` });
		return 'mobile-dev';
	}
	const candidates = ['frontend-dev', 'mobile-dev', 'backend-dev'];
	for (const c of candidates) { if (line.includes(c)) return c; }
	console.warn('resolveTeamLead: no build role on Team line in', designPath, '— defaulting to mobile-dev');
	ev({ type: 'progress', agent: 'engine', pct: 0, status: 'warning', message: `no build role on Team line in ${designPath}; defaulting to mobile-dev` });
	return 'mobile-dev';
}

// ---- QA/review rework loop (CLAUDE.md: failed QA/review goes back to the same engineer, 3 loops, then owner) ----
// Returns 'none' (no valid FAIL verdict: normal verify/tier logic applies), 'back' (cursor moved to the build
// stage) or 'blocked'. Only a stage that ran cleanly and wrote a fresh report containing a FAIL verdict counts;
// missing report, run error, turn cap or empty answer stay genuine failures that climb the tier ladder.
// Default QA verdict: tolerant of markdown around the verdict ("**VERDICT:** FAIL", "VERDICT: `FAIL`").
const DEFAULT_FAIL_REGEX = 'VERDICT:[\\s*_`]*FAIL';
// Rework target: the LAST stage before the cursor named `to` (or `to#N`). A suffixed stage (qa#2) goes to its
// own item (build#2). An unsuffixed stage (a sprint-wide review after a foreach) goes to the most recent build,
// not build#1. Returns -1 when there is none.
function reworkTarget(stages, cur, to, suffix) {
  for (let i = Math.min(cur, stages.length) - 1; i >= 0; i--) {
    const id = stages[i].id || '';
    if (suffix ? id === to + suffix : (id === to || id.startsWith(to + '#'))) return i;
  }
  return -1;
}
function handleRework(run, stage, vars, res, t0) {
  const rw = stage.rework;
  if (!rw || res.error || res.hitTurnCap || !String(res.result || '').trim()) return 'none';
  const rp = path.resolve(REPO, fill(rw.verdict, vars));
  let txt; try { if (fs.statSync(rp).mtimeMs < t0 - 2000) return 'none'; txt = fs.readFileSync(rp, 'utf8'); } catch { return 'none'; }
  if (!new RegExp(rw.failRegex || DEFAULT_FAIL_REGEX).test(txt)) return 'none';
  const max = rw.max || 3;
  run.reworks = run.reworks || {};
  const n = run.reworks[stage.id] = (run.reworks[stage.id] || 0) + 1;
  const suffix = (stage.id.match(/#\d+$/) || [''])[0];
  const cur = run.cursor;
  const target = reworkTarget(run.stages, cur, rw.to, suffix);
  // keep history: <name>.md -> <name>-round<N>.md (also forces the next QA/review to write a fresh report)
  const kept = rp.replace(/(\.[^./\\]+)?$/, (e) => `-round${n}${e || ''}`);
  try { fs.renameSync(rp, kept); } catch {}
  if (n >= max || target < 0) {
    run.status = 'blocked';
    run.blockedReason = target < 0 ? `${stage.id} FAIL but no '${rw.to}' stage to rework` : `QA/review failed ${max} rework rounds`;
    save(run);
    ev({ type: 'gate', agent: 'owner', run: run.id, message: `Blocked: ${stage.id}. ${run.blockedReason}.` });
    console.log(`\n⛔ BLOCKED at ${stage.id}: ${run.blockedReason}. Last report: ${kept}`);
    return 'blocked';
  }
  const back = run.stages[target];
  // Persistent, auditable record (cause 4): report path + sha256, baseline, extracted findings. It is marked
  // consumed when the rejecting stage finally passes, never deleted.
  for (const old of reworkRecords(run)) if (old.target === back.id && ['pending', 'built'].includes(old.status)) old.status = 'superseded';
  const foundFindings = extractFindings(txt);
  const rec = {
    id: `${stage.id}:${n}`, round: n, max, rejectedBy: stage.id, target: back.id, status: 'pending', at: now(),
    report: toSlash(kept), reportSha256: sha256(txt), findings: foundFindings, findingsFallback: findingsFallback(txt, foundFindings),
    baseline: gitState(workdir(vars)), verdictReport: toSlash(rp),
  };
  reworkRecords(run).push(rec);
  run.history.push({ stage: stage.id, type: 'rework', round: n, max, back: back.id, report: toSlash(kept), reportSha256: rec.reportSha256, findings: rec.findings.map((x) => x.id), baselineHead: rec.baseline && rec.baseline.head, at: now() });
  ev({ type: 'progress', agent: stage.agent, pct: 0, status: 'working', message: `rework ${n}/${max}: ${stage.id} FAIL → back to ${back.id}` });
  console.log(`  ↩ rework ${n}/${max}: ${stage.id} FAIL → back to ${back.id}`);
  run.cursor = target; save(run);
  return 'back';
}
// ---- usage-limit waits ----
const LIMIT_WAIT_MS = Number(process.env.STUDIO_LIMIT_WAIT_MS) || 15 * 60000;
const LIMIT_MAX_WAITS = Number(process.env.STUDIO_LIMIT_MAX_WAITS) || 48; // 12 h, then the owner decides
function sleepMs(ms, agentId) { // synchronous like the rest of the engine; wakes early if the studio or the agent's team pauses
  const cell = new Int32Array(new SharedArrayBuffer(4));
  for (let left = ms; left > 0 && !paused(agentId); left -= 60000) Atomics.wait(cell, 0, 0, Math.min(60000, left));
}

// ---- local model server check ----
// 2026-11-11: Ollama was not running after a restart, so both local build attempts failed in seconds with
// ECONNREFUSED and the stage fell through to Sonnet. A down server is not a failed attempt: check it first,
// try to start it, wait for it, and only then give up on the local tier for this stage.
const OLLAMA_WAIT_MS = Number(process.env.STUDIO_OLLAMA_WAIT_MS) || 5 * 60000;
function ollamaUp(url) {
  const r = spawnSync(process.execPath, ['-e', `fetch(${JSON.stringify(url + '/api/version')}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))`], { timeout: 10000 });
  return r.status === 0;
}
function ensureLocalServer(agentId) {
  const url = machineLib.ollamaUrl(MACHINE);
  if (ollamaUp(url)) return true;
  console.log(`  ⚠ local model server ${url} is not answering; starting it and waiting up to ${Math.round(OLLAMA_WAIT_MS / 60000)} min`);
  ev({ type: 'progress', agent: agentId, pct: 0, status: 'waiting', message: `local model server down; starting Ollama` });
  try { require('child_process').spawn(MACHINE.ollama.exe || 'ollama', ['serve'], { detached: true, stdio: 'ignore', windowsHide: true }).on('error', () => {}).unref(); } catch {}
  const cell = new Int32Array(new SharedArrayBuffer(4));
  for (let left = OLLAMA_WAIT_MS; left > 0 && !paused(agentId); left -= 5000) {
    Atomics.wait(cell, 0, 0, 5000);
    if (ollamaUp(url)) { console.log('  ✓ local model server is up'); return true; }
  }
  return false;
}

// ---- finalize turn ----
// Local QA/review runs often spend every turn exploring and hit the turn cap before writing the report
// (2026-11-07..11: no local HiveBoard QA attempt ever wrote one). Instead of discarding that work, resume the
// same session for a few turns whose only job is to write the report from what it already found.
const FINALIZE_TURNS = 8;
const finalizePrompt = (stage, vars) => 'Your turn budget is used up. Do not explore or run anything else. ' +
  `Using only what you have already found, write the required report now to: ${(stage.expect || []).map((e) => toSlash(path.resolve(REPO, fill(e, vars)))).join(', ')}. ` +
  'Mark anything you did not get to as UNVERIFIED. End the file with the required verdict line, then reply with a two-line summary.';
const canFinalize = (stage, res) => !!(res.hitTurnCap && res.sessionId && stage.expect?.length && !mustChange(stage) && stage.finalizeOnCap !== false);

// ---- reports written in the wrong place ----
// Agents working in a lane worktree sometimes write an HQ report (docs/internal/review-*.md, QA reports) at
// the same relative path inside the worktree. The check then sees it as missing and the stage climbs or blocks
// (2026-11-08/09: lane D and J reviews). Bring a fresh misplaced copy to the HQ path the stage expects.
// A stale HQ file from an earlier round is moved aside (-stale.md) so it can't pass the check in place of the
// fresh report. A file the lane has committed is copied, not moved, so the lane tree is left clean.
const isTracked = (dir, rel) => spawnSync('git', ['ls-files', '--error-unmatch', '--', rel], { cwd: dir, stdio: 'ignore' }).status === 0;
function adoptMisplacedReports(run, stage, vars, t0) {
  const wd = workdir(vars);
  if (wd === REPO) return [];
  // Only the per-round verdict report may replace an existing HQ file. Plain `expect` files can be shared,
  // append-only HQ docs (docs/internal/sprint-log.md): those are only adopted when HQ has no copy at all.
  const verdict = stage.rework && stage.rework.verdict ? fill(stage.rework.verdict, vars) : null;
  const targets = [...(stage.expect || []).map((x) => fill(x, vars)), ...(verdict ? [verdict] : [])];
  const fresh = (p) => { try { return fs.statSync(p).mtimeMs >= t0 - 2000; } catch { return false; } };
  const moved = [];
  for (const e of new Set(targets)) {
    const dest = path.resolve(REPO, e);
    const rel = path.relative(REPO, dest);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;
    const src = path.join(wd, rel);
    try {
      if (!fs.existsSync(src) || fs.lstatSync(src).isSymbolicLink() || !fresh(src)) continue;
      if (fs.existsSync(dest)) {
        if (e !== verdict || fresh(dest)) continue; // shared HQ doc, or the agent wrote the HQ copy too: leave it
        const stamp = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15);
        let aside, i = 0; // never overwrite an older stale copy
        do aside = dest.replace(/(\.[^./\\]+)?$/, (x) => `-stale-${stamp}${i ? '-' + i : ''}${x || ''}`), i++; while (fs.existsSync(aside));
        fs.renameSync(dest, aside);
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      if (isTracked(wd, rel)) fs.copyFileSync(src, dest);
      else { try { fs.renameSync(src, dest); } catch { fs.copyFileSync(src, dest); try { fs.unlinkSync(src); } catch {} } }
      moved.push(toSlash(rel));
    } catch (err) { console.log(`  ! could not adopt ${toSlash(rel)}: ${err.message}`); } // e.g. a locked file on Windows
  }
  if (moved.length) {
    run.history.push({ stage: stage.id, type: 'adopted-report', files: moved, at: now() });
    console.log(`  ↪ moved report(s) written inside the worktree to HQ: ${moved.join(', ')}`);
  }
  return moved;
}

// ---- refresh rules on resume ----
// A run keeps the stage list it started with, so pipeline fixes (e.g. the bold-tolerant verdict regexes, #15)
// never reached runs already in flight. On resume, copy the current pipeline's verdict rules onto matching
// stages, plus turn/time limits and newly added rework loops. Expanded foreach stages (id#N) get their check
// re-filled with the run vars and their item number; a check that needs other per-item values is left alone.
function refreshStages(run) {
  let pipe; try { pipe = JSON.parse(fs.readFileSync(path.join(PIPES, run.pipeline + '.json'), 'utf8')); } catch { return 0; }
  const tpl = {};
  const walk = (stages) => { for (const s of stages || []) { if (s.id && !(s.id in tpl)) tpl[s.id] = s; if (s.type === 'foreach') walk(s.stages); } };
  walk(pipe.stages);
  let changed = 0;
  // Runs started before vars were normalised hold Windows paths; backslashes break the JS checks they fill.
  for (const k of ['home', 'soft', 'workdir']) if (typeof run.vars?.[k] === 'string' && run.vars[k].includes('\\')) { run.vars[k] = toSlash(run.vars[k]); changed++; }
  const esc = (o) => Object.fromEntries(Object.entries(o || {}).map(([k, v]) => [k, JSON.stringify(String(v ?? '')).slice(1, -1)]));
  for (const s of run.stages || []) {
    const m = /#(\d+)$/.exec(String(s.id || ''));
    const t = tpl[String(s.id || '').replace(/#\d+$/, '')];
    if (!t) continue;
    // a foreach not expanded yet has no per-item values: take its inner stages from the template wholesale
    if (s.type === 'foreach' && t.type === 'foreach') { if (JSON.stringify(s.stages) !== JSON.stringify(t.stages)) { s.stages = JSON.parse(JSON.stringify(t.stages)); changed++; } continue; }
    // turn and time limits carry no per-item values
    for (const k of ['maxTurns', 'timeoutMin', 'localTimeoutMin']) if (t[k] !== undefined && s[k] !== t[k]) { s[k] = t[k]; changed++; }
    if (t.rework && !s.rework) { // a stage that gained a rework loop since the run started
      s.rework = JSON.parse(JSON.stringify(t.rework));
      if (m) s.rework.verdict = fill(s.rework.verdict, { ...run.vars, n: Number(m[1]) });
      changed++;
    } else if (s.rework && t.rework) for (const k of ['failRegex', 'max']) if (t.rework[k] !== undefined && s.rework[k] !== t.rework[k]) { s.rework[k] = t.rework[k]; changed++; }
    if (t.check) {
      // an expanded stage's check embeds its item number: re-fill the template, and use it only if nothing is left unfilled
      const want = m ? fill(t.check, { ...esc(run.vars), n: Number(m[1]) }) : t.check;
      if (!(m && /\{\{\w+\}\}/.test(want)) && s.check !== want) { s.check = want; changed++; }
    }
  }
  return changed;
}

const hooks = { runAgent: (...a) => runAgent(...a), sleep: (ms, agentId) => sleepMs(ms, agentId), localReady: (agentId) => ensureLocalServer(agentId) }; // test seams: selftests swap in fakes

// ---- the state machine ----
// ---- postmortem stubs (S2) ----
// When a run becomes blocked or an attempt escalates to sonnet/opus,
// write docs/postmortems/<run-id>-<stage>.md with run history, tiers tried,
// problems verbatim, time and token usage, plus empty Root cause / Fix / Prevent.
function writePostmortem(run, stage) {
  const dir = path.join(REPO, 'docs', 'postmortems');
  const fname = `${run.id}-${stage.id}.md`;
  const filePath = path.resolve(REPO, 'docs', 'postmortems', fname);
  fs.mkdirSync(dir, { recursive: true });
  const stageHistory = (run.history || []).filter((h) => h.stage === stage.id && !['usage-limit', 'adopted-report', 'manager-reset'].includes(h.type));
  const tiersTried = [...new Set(stageHistory.map((h) => h.tier).filter(Boolean))];
  let lines = [
    `# Postmortem: ${run.id} → ${stage.id}`,
    '',
    `## What happened`,
  ];
  for (const h of stageHistory) {
    lines.push(`- Attempt ${h.attempt} on ${h.tier} (${h.model}): ${h.ok ? 'ok' : 'failed'} in ${h.secs}s`);
    if (h.turns != null) lines.push(`  turns: ${h.turns}`);
    if (h.error) lines.push(`  error: ${h.error}`);
  }
  if (!stageHistory.length) lines.push('(no history yet)');
  lines.push('');
  lines.push(`## Tiers tried`);
  lines.push(tiersTried.join(', ') || '(none)');
  lines.push('');
  lines.push(`## Problems`);
  const problems = stageHistory.filter((h) => h.problems && h.problems.length).flatMap((h) => h.problems);
  for (const p of problems) lines.push(`- ${p}`);
  if (!problems.length) lines.push('(none)');
  lines.push('');
  lines.push(`## Time and Token Usage`);
  const totalSecs = stageHistory.reduce((s, h) => s + (h.secs || 0), 0);
  const totalIn = stageHistory.reduce((s, h) => s + (h.usage?.in || 0), 0);
  const totalOut = stageHistory.reduce((s, h) => s + (h.usage?.out || 0), 0);
  const totalCached = stageHistory.reduce((s, h) => s + (h.usage?.cached || 0), 0);
  lines.push(`- Total time: ${totalSecs}s`);
  lines.push(`- Tokens in: ${totalIn}, out: ${totalOut}, cached: ${totalCached}`);
  lines.push('');
  lines.push(`## Root cause`);
  lines.push('');
  lines.push(`## Fix`);
  lines.push('');
  lines.push(`## Prevent`);
  lines.push('');
  fs.writeFileSync(filePath, lines.join('\n'));
  ev({ type: 'progress', agent: 'engine', pct: 0, status: 'postmortem', message: `Postmortem stub: ${filePath}` });
  return filePath;
}
const rwInfoLast = (run, stageId) => { for (let i = run.history.length - 1; i >= 0; i--) { const h = run.history[i]; if (h.stage === stageId && h.rework && h.ok) return h.rework; } return null; };
function advance(run) {
  while (run.cursor < run.stages.length) {
    if (paused(run.stages[run.cursor] && run.stages[run.cursor].agent)) { run.status = 'paused'; save(run); console.log('Studio is paused (safe stop). Resume with the switch, then: engine.js resume ' + run.id); return; }
    const stage = run.stages[run.cursor];
    const vars = run.vars;

    // requires: pre-check paths BEFORE any stage runs; missing → blocked, no model call.
    if (stage.type !== 'gate') {
      const missingReqs = checkRequires(stage, vars);
      if (missingReqs.length) {
        run.status = 'blocked';
        run.blockedReason = `stage ${stage.id}: requires missing — ${missingReqs.join(', ')}`;
        writePostmortem(run, stage);
        save(run);
        console.log(`\n⛔ BLOCKED at ${stage.id}: required path(s) missing: ${missingReqs.join(', ')}`);
        return;
      }
    }

    if (stage.type === 'gate') {
      const g = run.gates[stage.id];
      if (!g) {
        run.gates[stage.id] = { status: 'waiting', title: fill(stage.title, vars), show: (stage.show || []).map((s) => fill(s, vars)), since: now() };
        run.status = 'waiting-gate'; save(run);
        ev({ type: 'gate', agent: 'owner', run: run.id, message: `Needs your decision: ${fill(stage.title, vars)}` });
        console.log(`\n⏸ OWNER GATE "${stage.id}": ${fill(stage.title, vars)}\n   Review: ${(stage.show || []).map((s) => fill(s, vars)).join(', ')}\n   Then: node tools/engine/engine.js approve ${run.id} approve|reject "<note>"`);
        return;
      }
      if (g.status === 'waiting') { run.status = 'waiting-gate'; save(run); console.log('Still waiting on gate ' + stage.id); return; }
      if (g.status === 'rejected') { run.status = 'stopped'; save(run); console.log('Owner rejected at ' + stage.id + '. Run stopped.'); return; }
      run.cursor++; continue;
    }

    if (stage.type === 'script') {
      const c = spawnSync(fill(stage.run, vars), { cwd: workdir(vars), shell: true, encoding: 'utf8' });
      run.history.push({ stage: stage.id, type: 'script', ok: c.status === 0, at: now(), out: (c.stdout + c.stderr).slice(-500) });
      if (c.status !== 0) { run.status = 'blocked'; run.blockedReason = `script ${stage.id} failed`; writePostmortem(run, stage); save(run); return; }
      run.cursor++; save(run); continue;
    }

    if (stage.type === 'foreach') {
      const src = fs.existsSync(path.resolve(REPO, fill(stage.items.file, vars))) ? fs.readFileSync(path.resolve(REPO, fill(stage.items.file, vars)), 'utf8') : '';
      // Each match gives {{item}} (group 1 or whole match) plus {{g1}}, {{g2}}… for every capture group.
      const items = [...src.matchAll(new RegExp(stage.items.regex, 'gm'))].map((m) => ({ item: (m[1] || m[0]).trim(), ...Object.fromEntries(m.slice(1).map((g, j) => [`g${j + 1}`, (g || '').trim()])) }));
      if (!items.length) { run.status = 'blocked'; run.blockedReason = `foreach ${stage.id}: no items found in ${stage.items.file}`; writePostmortem(run, stage); save(run); return; }
      const esc = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, JSON.stringify(String(v ?? '')).slice(1, -1)])); // safe inside JSON strings
      const expanded = items.flatMap((it, i) => stage.stages.map((s) => JSON.parse(fill(JSON.stringify({ ...s, id: `${s.id}#${i + 1}` }), { ...esc(vars), ...esc(it), n: i + 1 }))));
      run.stages.splice(run.cursor, 1, ...expanded); save(run); continue;
    }

    // agent stage with escalation ladder
    // Resolve __team_lead__ sentinel: pick build agent from design.md "Team:" line.
    // Uses stage.designDoc if provided (pipeline-level override), otherwise falls back
    // to the conventional docs/specs/{{slug}}.design.md path.
    if (stage.agent === '__team_lead__') {
      const designPath = fill(stage.designDoc || 'docs/specs/{{slug}}.design.md', vars);
      stage.agent = resolveTeamLead(designPath);
    }
    // Ladder attempts are counted per advance() call: `resume` starts the ladder afresh (a human decided to retry),
    // so a stage blocked on every tier gets at most one full ladder per resume, never more within a single call.
    const ladder = LADDER[stage.tier || 'local'];
    let feedback = null, done = false, reworked = false;
    const cwd = workdir(vars);
    // A rework record is addressed to this stage when it is the rework target (builder side).
    const rwRec = activeRecord(run, stage.id, 'pending');
    // onlyOnRework (e.g. the sprint-rework stage): runs only when a review rejection was routed to it.
    if (stage.onlyOnRework && !rwRec) { run.history.push({ stage: stage.id, type: 'skipped', note: 'no pending rework', at: now() }); run.cursor++; save(run); continue; }
    let reworkNote = rwRec ? reworkPrompt(rwRec, cwd) : (run.reworkNotes && run.reworkNotes[stage.id]); // legacy in-flight notes still honoured
    // Verifier side (cause 2): a QA/review stage that follows a rework runs only on a non-empty manifest of changes
    // since the rejection baseline, and is told that manifest and the finding IDs.
    if (stage.rework && !rwRec) {
      const tgt = reworkTarget(run.stages, run.cursor, stage.rework.to, (stage.id.match(/#\d+$/) || [''])[0]);
      const vrec = tgt >= 0 ? activeRecord(run, run.stages[tgt].id, 'built') : null;
      const manifest = vrec ? changedSince(vrec.baseline, cwd, reworkExcludes(vrec, run.stages[tgt], vars), run.stages[tgt].reworkPaths) : null;
      if (vrec && manifest) {
        if (!manifest.length) {
          run.status = 'blocked'; run.blockedReason = `${stage.id}: no rework diff to verify (nothing changed since the ${vrec.rejectedBy} rejection baseline ${short(vrec.baseline.head)})`;
          writePostmortem(run, stage);
          // so `resume` re-runs the rework builder instead of re-evaluating the same empty manifest
          run.history.push({ stage: stage.id, type: 'rework-empty-manifest', round: vrec.round, back: run.stages[tgt].id, at: now() });
          vrec.status = 'pending'; run.cursor = tgt; save(run);
          ev({ type: 'gate', agent: 'owner', run: run.id, message: `Blocked: ${stage.id}. ${run.blockedReason}.` });
          console.log(`\n⛔ BLOCKED at ${stage.id}: ${run.blockedReason}`);
          return;
        }
        reworkNote = reworkVerifyNote(vrec, manifest);
        run.history.push({ stage: stage.id, type: 'rework-manifest', round: vrec.round, changedPaths: manifest, at: now() });
      }
    }
    const rwTurns = stage.reworkMaxTurns || Math.min(stage.maxTurns || 25, 30);
    let localDown = false;
    for (let attempt = 0; attempt < ladder.length && !done; attempt++) {
      const tierName = ladder[attempt];
      if (paused(stage.agent)) break;
      if (TIERS[tierName].local && (localDown || !hooks.localReady(stage.agent))) {
        if (paused(stage.agent)) break;
        if (!localDown) {
          localDown = true;
          run.history.push({ stage: stage.id, type: 'local-down', tier: tierName, at: now(), note: 'local model server unreachable; skipped without counting an attempt' });
          console.log(`  ⚠ local model server unreachable; skipping the local tier for ${stage.id}`);
          save(run);
        }
        continue;
      }
      if (['sonnet', 'opus'].includes(tierName)) writePostmortem(run, stage);
      ev({ type: 'start', agent: stage.agent, from: 'manager', task: `${stage.id} [${tierName}${attempt ? ', retry ' + attempt : ''}]`, tier: tierName, model: TIERS[tierName].model, cloud: !TIERS[tierName].local });
      console.log(`▶ ${stage.id} → ${stage.agent} on ${tierName} (${TIERS[tierName].model})${attempt ? ' [attempt ' + (attempt + 1) + ']' : ''}`);
      const before = treeSnapshot(workdir(vars));
      const t0 = Date.now();
      let res = hooks.runAgent(stage, tierName, vars, feedback, reworkNote, rwRec ? { rework: true, ...(TIERS[tierName].local ? { maxTurns: rwTurns } : {}) } : {});
      // Codex rate/usage limit or missing binary: skip the tier (not a failure) and fall through (ADR 0004).
      if (res.limited || res.skipped) {
        const why = res.skipped ? 'unavailable' : 'limited';
        if (res.limited && !res.cached) ev({ type: 'usage', agent: stage.agent, tier: tierName, provider: providerOf(tierName), model: res.model, cloud: res.cloud, tokensIn: 0, tokensOut: 0, secs: res.secs, limited: true });
        ev({ type: 'progress', agent: stage.agent, pct: 0, status: 'warning', message: `${stage.id}: ${tierName} ${why}, skipping tier` });
        console.log(`  skip: ${tierName} ${why}`);
        continue;
      }
      if (!rwRec && canFinalize(stage, res) && !paused(stage.agent)) {
        console.log(`  ↻ hit the turn cap after ${res.turns ?? '?'} turns; finalize turn to write the report`);
        const fin = hooks.runAgent(stage, tierName, vars, null, null, { resume: res.sessionId, prompt: finalizePrompt(stage, vars), maxTurns: FINALIZE_TURNS });
        run.history.push({ stage: stage.id, type: 'finalize', tier: tierName, secs: fin.secs, turns: fin.turns, ok: !fin.error && !fin.hitTurnCap, at: now() });
        res = { ...fin, secs: (res.secs || 0) + (fin.secs || 0), turns: (res.turns || 0) + (fin.turns || 0), finalized: true };
      }
      if (res.usageLimit && !TIERS[tierName].local) {
        run.limitWaits = (run.limitWaits || 0) + 1;
        run.history.push({ stage: stage.id, type: 'usage-limit', tier: tierName, wait: run.limitWaits, at: now(), note: String(res.result || res.error || '').slice(0, 200) });
        if (run.limitWaits > LIMIT_MAX_WAITS) {
          run.status = 'blocked'; run.blockedReason = `${tierName} usage limit did not reset after ${LIMIT_MAX_WAITS} waits`;
          run.limitWaits = 0; delete run.limitUntil; save(run); // a later resume gets a full set of waits again
          ev({ type: 'gate', agent: 'owner', run: run.id, message: `Blocked: ${stage.id}. ${run.blockedReason}.` });
          console.log(`\n⛔ BLOCKED at ${stage.id}: ${run.blockedReason}`);
          return;
        }
        // Status stays 'running' (every Control Room view already knows it); limitUntil says why it is idle.
        // If the engine dies mid-wait, `resume` picks the run up like any other interrupted run.
        run.limitUntil = new Date(Date.now() + LIMIT_WAIT_MS).toISOString(); save(run);
        ev({ type: 'progress', agent: stage.agent, pct: 0, status: 'waiting', message: `${stage.id}: ${tierName} usage limit hit; waiting ${Math.round(LIMIT_WAIT_MS / 60000)} min, then retrying` });
        console.log(`  ⏸ ${tierName} usage limit hit; waiting ${Math.round(LIMIT_WAIT_MS / 60000)} min (wait ${run.limitWaits}/${LIMIT_MAX_WAITS})`);
        hooks.sleep(LIMIT_WAIT_MS, stage.agent);
        delete run.limitUntil; save(run);
        if (paused(stage.agent)) break; // the owner paused during the wait: the normal paused path below saves the run
        attempt--; continue; // same tier again; a usage limit is not a failed attempt
      }
      run.limitWaits = 0;
      adoptMisplacedReports(run, stage, vars, t0);
      const rwState = handleRework(run, stage, vars, res, t0);
      if (rwState === 'blocked') return;
      if (rwState === 'back') { reworked = true; break; }
      const problems = verify(stage, vars, res);
      // Guard (2026-11-07): a build stage that changed nothing has not done its task, even if checks pass.
      if (mustChange(stage) && before !== null && treeSnapshot(workdir(vars)) === before) problems.push('no files changed in ' + workdir(vars) + ' (the task was not implemented)');
      // Rework builder (cause 1): success needs a scoped change vs the REJECTION baseline; in a lane worktree HEAD must advance too.
      let rwInfo = null;
      if (rwRec && rwRec.baseline && !res.error && !res.hitTurnCap) {
        const changedPaths = changedSince(rwRec.baseline, cwd, reworkExcludes(rwRec, stage, vars), stage.reworkPaths) || [];
        const afterHead = (gitState(cwd) || {}).head || null;
        rwInfo = { round: rwRec.round, beforeHead: rwRec.baseline.head, afterHead, changedPaths };
        if (!changedPaths.length) problems.push(`rework made no change since the rejection baseline (HEAD ${short(rwRec.baseline.head)}); fix the findings in the report, do not just re-run checks`);
        else if (requiresCommit(cwd) && afterHead === rwRec.baseline.head) problems.push(`rework edited files but did not commit: HEAD is still ${short(rwRec.baseline.head)}; git add + git commit the fixes`);
      }
      run.history.push({ stage: stage.id, agent: stage.agent, attempt: attempt + 1, ...res, ...(rwInfo ? { rework: rwInfo } : {}), ok: !problems.length, problems, at: now() });
      ev({ type: 'usage', agent: stage.agent, tier: tierName, provider: providerOf(tierName), model: res.model, cloud: res.cloud, tokensIn: res.usage?.in || 0, tokensOut: res.usage?.out || 0, secs: res.secs });
      if (!problems.length) {
        done = true;
        ev({ type: 'done', agent: stage.agent, to: 'manager', task: `${stage.id} ✓ (${tierName}, ${res.secs}s)` });
        console.log(`  ✓ ${res.secs}s, ${res.turns ?? '?'} turns`);
      } else {
        feedback = problems.join('\n');
        // A capped or errored rework builder does not get a second local try: straight to the first cloud tier (cause 5).
        if (rwRec && (res.hitTurnCap || res.error)) { const nxt = ladder.findIndex((t, i) => i > attempt && !TIERS[t].local); if (nxt > attempt + 1) attempt = nxt - 1; }
        ev({ type: 'progress', agent: stage.agent, pct: 0, status: 'blocked', message: `${stage.id} failed on ${tierName}: ${problems[0].slice(0, 120)}` });
        console.log(`  ✗ ${problems.join(' | ').slice(0, 300)}`);
      }
      save(run);
    }
    if (reworked) continue; // cursor already moved back to the build stage
    if (!done) {
      const isP = paused(stage.agent);
      run.status = isP ? 'paused' : 'blocked';
      run.blockedReason = isP ? 'paused' : `${stage.id} failed on every tier: ${feedback}`;
      if (!isP) writePostmortem(run, stage);
      save(run);
      if (!isP) ev({ type: 'gate', agent: 'owner', run: run.id, message: `Blocked: ${stage.id}. Needs owner or Claude help.` });
      console.log(run.status === 'blocked' ? `\n⛔ BLOCKED at ${stage.id}. See .studio/runs/${run.id}.json` : '\nPaused.');
      return;
    }
    if (rwRec) { // built: stays on record until the rejecting stage passes
      const cur = rwInfoLast(run, stage.id);
      Object.assign(rwRec, { status: 'built', builtAt: now(), ...(cur ? { beforeHead: cur.beforeHead, afterHead: cur.afterHead, changedPaths: cur.changedPaths } : {}) });
    }
    for (const r of reworkRecords(run)) if (r.rejectedBy === stage.id && r.status === 'built') { r.status = 'consumed'; r.consumedAt = now(); } // audit trail kept, not deleted
    if (run.reworkNotes) delete run.reworkNotes[stage.id]; // legacy note
    run.cursor++; save(run);
  }
  run.status = 'done'; save(run);
  ev({ type: 'progress', agent: 'manager', pct: 100, status: 'done', message: `Pipeline ${run.pipeline} finished (${run.id})` });
  console.log(`\n✅ Pipeline ${run.pipeline} complete (${run.id})`);
}

// ---- CLI ----
if (require.main === module) {
	const [cmd, ...rest] = process.argv.slice(2);
	const vars = {}; for (let i = 0; i < rest.length; i++) if (rest[i] === '--var') { const [k, ...v] = rest[++i].split('='); vars[k] = v.join('='); }

	if (cmd === 'start') {
		const name = rest[0];
		const pipe = JSON.parse(fs.readFileSync(path.join(PIPES, name + '.json'), 'utf8'));
		const id = `${name}-${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '')}-${Math.random().toString(36).slice(2, 5)}`;
		const run = { id, pipeline: name, vars: { date: new Date().toISOString().slice(0, 10), soft: toSlash(path.resolve(__dirname, '..')), home: toSlash(REPO), ...pipe.defaults, ...vars }, stages: pipe.stages, cursor: 0, gates: {}, history: [], status: 'running', created: now() };
		for (const k of pipe.required || []) if (!run.vars[k]) { console.error(`missing --var ${k}=...`); process.exit(1); }
		save(run); console.log(`Run ${id} started: ${pipe.description || ''}`); advance(run);
	} else if (cmd === 'resume') {
		const run = load(rest[0]); run.status = 'running'; run.limitWaits = 0; delete run.limitUntil;
		const n = refreshStages(run); if (n) console.log(`Refreshed ${n} stage rule(s) from the current ${run.pipeline} pipeline.`);
		save(run); advance(run);
	} else if (cmd === 'approve') {
		const run = load(rest[0]); const decision = rest[1] || 'approve'; refreshStages(run);
		const gid = Object.keys(run.gates).find((k) => run.gates[k].status === 'waiting');
		if (!gid) { console.log('No gate is waiting.'); process.exit(0); }
		Object.assign(run.gates[gid], { status: decision === 'reject' ? 'rejected' : 'approved', note: rest[2] || '', decided: now() });
		ev({ type: 'progress', agent: 'owner', pct: 100, status: 'done', message: `Gate ${gid}: ${run.gates[gid].status}${rest[2] ? ' (' + rest[2] + ')' : ''}` });
		save(run); console.log(`Gate ${gid} ${run.gates[gid].status}.`); if (decision !== 'reject') advance(run); else { run.status = 'stopped'; save(run); }
	} else if (cmd === 'status') {
		if (rest[0]) { const r = load(rest[0]); console.log(JSON.stringify({ ...r, stages: r.stages.map((s, i) => `${i === r.cursor ? '→ ' : '  '}${s.id}`) }, null, 2)); }
		else if (fs.existsSync(RUNS)) for (const f of fs.readdirSync(RUNS).filter((f) => f.endsWith('.json'))) { const r = load(f.replace('.json', '')); console.log(`${r.id.padEnd(40)} ${r.status.padEnd(13)} at ${r.stages[r.cursor]?.id || '(end)'}`); }
	} else if (cmd === 'pipelines') {
		for (const f of fs.readdirSync(PIPES)) { const p = JSON.parse(fs.readFileSync(path.join(PIPES, f), 'utf8')); console.log(`${f.replace('.json', '').padEnd(14)} ${p.description}  [vars: ${(p.required || []).join(', ')}]`); }
	} else console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 16).join('\n'));
}

module.exports = { gitState, changedSince, extractFindings, findingsFallback, reworkPrompt, CONTEXT_LIMIT_RX, advance, hooks, localTierEnv, isUsageLimit, adoptMisplacedReports, refreshStages, allowedToolsFor, DISALLOWED_TOOLS, unattendedRules, parseRunOutput, parseCodexOutput, runCodex, findCodex, isCliErrorResult, reworkTarget, DEFAULT_FAIL_REGEX, verify, resolveTeamLead, agentDefinition, treeSnapshot, mustChange, writePostmortem, checkRequires, fill, REPO };
