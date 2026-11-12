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

// REPO = the org workspace (STUDIO_HOME): agents, docs, pipelines, runtime data. The engine itself may live
// elsewhere (StudioControlRoom). Resolution: STUDIO_HOME env → studio.home.json at the software root → legacy.
function studioHome() {
  if (process.env.STUDIO_HOME) return path.resolve(process.env.STUDIO_HOME);
  try { const c = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'studio.home.json'), 'utf8')); if (c.home) return path.resolve(c.home); } catch {}
  return path.resolve(__dirname, '..', '..');
}
const REPO = studioHome();
const PIPES = path.join(REPO, 'tools', 'engine', 'pipelines');
const RUNS = path.join(REPO, '.studio', 'runs');
const STUDIO = [path.join(__dirname, '..', 'studio', 'studio.js'), path.join(REPO, '.studio', 'studio.js')].find((p) => fs.existsSync(p));

// ---- model tiers (ADR 0001) ----
const TIERS = {
  local:        { model: 'qwen3.6:27b',     local: true },
  'local-fast': { model: 'qwen3-coder:30b', local: true },
  sonnet:       { model: 'sonnet',          local: false },
  opus:         { model: 'opus',            local: false },
};
// Escalation ladder when a stage fails its checks: retry once, then move up.
const LADDER = { 'local-fast': ['local-fast', 'local', 'sonnet'], local: ['local', 'local', 'sonnet'], sonnet: ['sonnet', 'opus'], opus: ['opus'] };

const now = () => new Date().toISOString();
const ev = (obj) => { try { fs.appendFileSync(path.join(REPO, '.studio', 'events.jsonl'), JSON.stringify({ ts: Date.now(), ...obj }) + '\n'); } catch {} };
const TEAM_FALLBACK = { 'rd-manager': 'rd', 'market-researcher': 'rd', 'opportunity-analyst': 'rd', 'creative-director': 'creative', 'image-artist': 'creative', 'video-producer': 'creative', 'copy-voice': 'creative', 'ui-ux-designer': 'creative' };
// Paused if the global switch is paused, or (when agentId is given) that agent's team is paused.
const paused = (agentId) => { try {
  const c = JSON.parse(fs.readFileSync(path.join(REPO, '.studio', 'control.json'), 'utf8'));
  if (c.state === 'paused') return true;
  if (!agentId || !c.teams) return false;
  let team = TEAM_FALLBACK[agentId] || 'eng';
  try { team = JSON.parse(fs.readFileSync(path.join(REPO, '.studio', 'roster.json'), 'utf8')).agents[agentId].team || team; } catch {}
  return c.teams[team] === 'paused';
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
const isCliErrorResult = (result) => {
  const t = String(result || '').trim();
  // The limit phrases only count in a short, error-sized result, so a long real report that merely
  // mentions one (e.g. a review of this very check) is not misread as a failure.
  return /^API Error:/i.test(t) || (t.length < 500 && CONTEXT_LIMIT_RX.test(t));
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
  const cliError = isCliErrorResult(out.result);
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
function runAgent(stage, tierName, vars, feedback, reworkNote, opts = {}) {
  const tier = TIERS[tierName];
  const env = { ...process.env };
  const machineCfg = (() => { try { return JSON.parse(fs.readFileSync(path.join(REPO, '.studio', 'machine.json'), 'utf8')); } catch { return {}; } })();
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
  const logCmd = cwd === REPO ? 'node .studio/studio.js' : `node "${STUDIO}"`;
  prompt += `\n\nStudio rules: work only inside this repository (${cwd}). Org docs, specs and backlogs live in ${REPO} (read-only unless the task says to write there). Report progress with \`${logCmd} log ${stage.agent} <pct> "<msg>"\`.`;
  prompt += `\n${unattendedRules(stage, cwd)}`;
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
  const r = spawnSync(claudeExe(), args, { cwd: workdir(vars), env, input: prompt, encoding: 'utf8', timeout: (stage.timeoutMin || 30) * 60000, maxBuffer: 64 * 1024 * 1024 });
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
    return git(['rev-parse', 'HEAD']) + git(['status', '--porcelain']) + git(['diff']);
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
  return { head: sha, porcelain: gitOut(dir, ['status', '--porcelain']) || '', diffHash: sha256(diff), files };
}
// Paths whose content differs from the baseline, committed or not. `exclude` = absolute paths (reports) to ignore.
function changedSince(baseline, dir, exclude = []) {
  if (!baseline) return null;
  const ex = new Set(exclude.map((e) => toSlash(path.relative(dir, e))));
  const cand = new Set([...dirtyPaths(dir, baseline.head), ...Object.keys(baseline.files || {})]);
  return [...cand].filter((p) => !ex.has(p) && !IGNORED_PATH.test(p) && (baseline.files && p in baseline.files ? baseline.files[p] !== fileHash(dir, p) : true)).sort();
}
// Commit policy: a rework in a lane worktree (not HQ, not main/master) must commit, so HEAD has to advance.
// On main or in HQ the engine/owner own git, so any scoped change vs the baseline is enough.
const requiresCommit = (dir) => !!dir && dir !== REPO && !['main', 'master'].includes(currentBranch(dir));

// Findings checklist extracted from a rejected report: bullets/headings that carry a severity word, a file:line
// reference, or sit under a severity heading. IDs are explicit ones in the report ("B1", "F-2", "#3") or F1, F2...
const SEVERITY_RX = /\b(blockers?|should[- ]fix|nits?|critical|major|minor|high|medium|low)\b/i;
const FILEREF_RX = /[\w./\\-]+\.\w{1,6}:\d+/;
function extractFindings(txt) {
  const out = []; let section = null;
  for (const raw of String(txt || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /VERDICT|REQUEST CHANGES|^APPROVE/i.test(line) && line.length < 60) continue;
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    const bullet = /^(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (heading && SEVERITY_RX.test(heading[1]) && heading[1].length < 50 && !FILEREF_RX.test(heading[1])) { section = (SEVERITY_RX.exec(heading[1]) || [])[1]; continue; }
    if (heading) { if (!SEVERITY_RX.test(heading[1])) section = null; if (!FILEREF_RX.test(heading[1])) continue; }
    const body = (heading || bullet || [])[1];
    if (!body || body.length < 12) continue;
    const ref = (FILEREF_RX.exec(body) || [])[0] || null;
    const sev = (SEVERITY_RX.exec(body) || [])[1] || section;
    if (!ref && !sev) continue;
    const idm = /^\W{0,2}((?:[A-Z]{1,3}[-.]?\d{1,3})|#\d{1,3})\b/.exec(body);
    out.push({ id: idm ? idm[1].replace(/^#/, 'F') : `F${out.length + 1}`, severity: sev ? sev.toLowerCase().replace(/[- ]/g, ' ') : null, ref, text: body.replace(/\s+/g, ' ').slice(0, 300) });
    if (out.length >= 40) break;
  }
  // explicit IDs must be unique; fall back to positional ones on a clash
  if (new Set(out.map((f) => f.id)).size !== out.length) out.forEach((f, i) => { f.id = `F${i + 1}`; });
  return out;
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
    `Findings checklist:\n${list}\n` +
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
  const rec = {
    id: `${stage.id}:${n}`, round: n, max, rejectedBy: stage.id, target: back.id, status: 'pending', at: now(),
    report: toSlash(kept), reportSha256: sha256(txt), findings: extractFindings(txt),
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
  let cfg = {}; try { cfg = JSON.parse(fs.readFileSync(path.join(REPO, '.studio', 'machine.json'), 'utf8')); } catch {}
  const url = (cfg.ollama && cfg.ollama.url) || 'http://127.0.0.1:11434';
  if (ollamaUp(url)) return true;
  console.log(`  ⚠ local model server ${url} is not answering; starting it and waiting up to ${Math.round(OLLAMA_WAIT_MS / 60000)} min`);
  ev({ type: 'progress', agent: agentId, pct: 0, status: 'waiting', message: `local model server down; starting Ollama` });
  try { require('child_process').spawn((cfg.ollama && cfg.ollama.exe) || 'ollama', ['serve'], { detached: true, stdio: 'ignore', windowsHide: true }).on('error', () => {}).unref(); } catch {}
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
    for (const k of ['maxTurns', 'timeoutMin']) if (t[k] !== undefined && s[k] !== t[k]) { s[k] = t[k]; changed++; }
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
      const manifest = vrec ? changedSince(vrec.baseline, cwd, [vrec.report, vrec.verdictReport].map((p) => path.resolve(p))) : null;
      if (vrec && manifest) {
        if (!manifest.length) {
          run.status = 'blocked'; run.blockedReason = `${stage.id}: no rework diff to verify (nothing changed since the ${vrec.rejectedBy} rejection baseline ${short(vrec.baseline.head)})`;
          writePostmortem(run, stage); save(run);
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
      let res = hooks.runAgent(stage, tierName, vars, feedback, reworkNote, rwRec ? { rework: true, maxTurns: rwTurns } : {});
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
        const exclude = [rwRec.report, rwRec.verdictReport].map((p) => path.resolve(p));
        const changedPaths = changedSince(rwRec.baseline, cwd, exclude) || [];
        const afterHead = (gitState(cwd) || {}).head || null;
        rwInfo = { round: rwRec.round, beforeHead: rwRec.baseline.head, afterHead, changedPaths };
        if (!changedPaths.length) problems.push(`rework made no change since the rejection baseline (HEAD ${short(rwRec.baseline.head)}); fix the findings in the report, do not just re-run checks`);
        else if (requiresCommit(cwd) && afterHead === rwRec.baseline.head) problems.push(`rework edited files but did not commit: HEAD is still ${short(rwRec.baseline.head)}; git add + git commit the fixes`);
      }
      run.history.push({ stage: stage.id, agent: stage.agent, attempt: attempt + 1, ...res, ...(rwInfo ? { rework: rwInfo } : {}), ok: !problems.length, problems, at: now() });
      ev({ type: 'usage', agent: stage.agent, tier: tierName, model: res.model, cloud: res.cloud, tokensIn: res.usage?.in || 0, tokensOut: res.usage?.out || 0, secs: res.secs });
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

module.exports = { gitState, changedSince, extractFindings, reworkPrompt, CONTEXT_LIMIT_RX, advance, hooks, localTierEnv, isUsageLimit, adoptMisplacedReports, refreshStages, allowedToolsFor, DISALLOWED_TOOLS, unattendedRules, parseRunOutput, isCliErrorResult, reworkTarget, DEFAULT_FAIL_REGEX, verify, resolveTeamLead, agentDefinition, treeSnapshot, mustChange, writePostmortem, checkRequires, fill, REPO };
