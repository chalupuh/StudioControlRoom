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
const { spawnSync } = require('child_process');

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

function fill(tpl, vars) {
  return String(tpl || '')
    .replace(/\{\{file:([^}]+)\}\}/g, (_, f) => { const p = path.resolve(REPO, fill(f, vars)); return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : `(missing: ${f})`; })
    .replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] ?? `{{${k}}}`));
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
function parseRunOutput(r) {
  let out = {};
  try { out = JSON.parse((r.stdout || '').trim().split('\n').filter(Boolean).pop() || '{}'); } catch {}
  const stderr = (r.stderr || '');
  const modelWarning = stderr.includes('[claude-code:unrecognized_model]');
  const hasFailure = out.is_error || r.status !== 0 || !!r.error || !!r.signal;
  const hasResult = !!out.result;
  return {
    turns: out.num_turns,
    result: String(out.result || '').slice(0, 2000),
    error: (hasFailure && !hasResult) ? stderr.slice(-800) || out.subtype || String(r.error?.code || r.error || r.signal || 'exit ' + r.status) : null,
    ignoredWarning: modelWarning ? stderr.slice(0, 300) : null,
    usage: out.usage ? { in: out.usage.input_tokens, out: out.usage.output_tokens, cached: out.usage.cache_read_input_tokens } : null,
    hitTurnCap: out.subtype === 'error_max_turns',
  };
}

// ---- run one agent stage on a given tier ----
function runAgent(stage, tierName, vars, feedback, reworkNote) {
  const tier = TIERS[tierName];
  const env = { ...process.env };
  // Headless Claude Code on Windows needs Git Bash for its Bash tool; without this, agents have
  // no shell (can't run builds/tests) — found 2026-11-07 when QA couldn't run `npm run build`.
  // Resolution order: env STUDIO_GIT_BASH → .studio/machine.json gitBash → system default.
  if (process.platform === 'win32' && !env.CLAUDE_CODE_GIT_BASH_PATH) {
    const machineCfg = (() => { try { return JSON.parse(fs.readFileSync(path.join(REPO, '.studio', 'machine.json'), 'utf8')); } catch { return {}; } })();
    const candidates = [process.env.STUDIO_GIT_BASH, machineCfg.gitBash, 'C:\\Program Files\\Git\\bin\\bash.exe'];
    const found = candidates.find((p) => p && fs.existsSync(p));
    if (found) env.CLAUDE_CODE_GIT_BASH_PATH = found;
  }
  if (tier.local) Object.assign(env, {
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:11434', ANTHROPIC_AUTH_TOKEN: 'ollama', ANTHROPIC_API_KEY: '',
    ANTHROPIC_MODEL: tier.model, ANTHROPIC_DEFAULT_OPUS_MODEL: tier.model, ANTHROPIC_DEFAULT_SONNET_MODEL: tier.model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'qwen3:4b', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  });
  let prompt = fill(stage.task, vars);
  const cwd = workdir(vars);
  const logCmd = cwd === REPO ? 'node .studio/studio.js' : `node "${STUDIO}"`;
  prompt += `\n\nStudio rules: work only inside this repository (${cwd}). Org docs, specs and backlogs live in ${REPO} (read-only unless the task says to write there). Report progress with \`${logCmd} log ${stage.agent} <pct> "<msg>"\`.`;
  if (stage.expect?.length) prompt += `\nYou MUST create/update these files: ${stage.expect.map((e) => fill(e, vars)).join(', ')}.`;
  if (reworkNote) prompt += `\n\n${reworkNote}`;
  if (feedback) prompt += `\n\nA previous attempt failed these checks; fix them:\n${feedback}`;
  const args = ['-p', '--agent', stage.agent, '--model', tier.model, '--permission-mode', 'acceptEdits', '--output-format', 'json', '--max-turns', String(stage.maxTurns || 25)];
  // Working outside HQ (e.g. a StudioControlRoom worktree): that checkout has no .claude/agents or
  // hooks, so pass the role definition and HQ's settings (pause hook, event logging) explicitly.
  if (cwd !== REPO) {
    const def = agentDefinition(stage.agent);
    if (def) args.push('--agents', JSON.stringify({ [stage.agent]: def }));
    const hqSettings = path.join(REPO, '.claude', 'settings.json');
    if (fs.existsSync(hqSettings)) args.push('--settings', hqSettings);
    args.push('--add-dir', REPO); // HQ docs (backlogs, sprint log, QA, reviews) must stay writable
  }
  if (stage.allowedTools) args.push('--allowedTools', ...stage.allowedTools);
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
function handleRework(run, stage, vars, res, t0) {
  const rw = stage.rework;
  if (!rw || res.error || res.hitTurnCap || !String(res.result || '').trim()) return 'none';
  const rp = path.resolve(REPO, fill(rw.verdict, vars));
  let txt; try { if (fs.statSync(rp).mtimeMs < t0 - 2000) return 'none'; txt = fs.readFileSync(rp, 'utf8'); } catch { return 'none'; }
  if (!new RegExp(rw.failRegex || 'VERDICT:\\s*FAIL').test(txt)) return 'none';
  const max = rw.max || 3;
  run.reworks = run.reworks || {};
  const n = run.reworks[stage.id] = (run.reworks[stage.id] || 0) + 1;
  const suffix = (stage.id.match(/#\d+$/) || [''])[0];
  const cur = run.cursor;
  const target = run.stages.findIndex((s, i) => i < cur && (suffix ? s.id === rw.to + suffix : (s.id === rw.to || s.id.startsWith(rw.to + '#'))));
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
  run.reworkNotes = run.reworkNotes || {};
  run.reworkNotes[back.id] = `Rework round ${n}: QA/review FAILED. Fix every finding in ${toSlash(kept)}, then update the sprint log.`;
  run.history.push({ stage: stage.id, type: 'rework', round: n, max, back: back.id, report: toSlash(kept), at: now() });
  ev({ type: 'progress', agent: stage.agent, pct: 0, status: 'working', message: `rework ${n}/${max}: ${stage.id} FAIL → back to ${back.id}` });
  console.log(`  ↩ rework ${n}/${max}: ${stage.id} FAIL → back to ${back.id}`);
  run.cursor = target; save(run);
  return 'back';
}
const hooks = { runAgent: (...a) => runAgent(...a) }; // test seam: selftests swap in a fake agent

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
  const stageHistory = (run.history || []).filter((h) => h.stage === stage.id);
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
    const reworkNote = run.reworkNotes && run.reworkNotes[stage.id];
    for (let attempt = 0; attempt < ladder.length && !done; attempt++) {
      const tierName = ladder[attempt];
      if (paused(stage.agent)) break;
      if (['sonnet', 'opus'].includes(tierName)) writePostmortem(run, stage);
      ev({ type: 'start', agent: stage.agent, from: 'manager', task: `${stage.id} [${tierName}${attempt ? ', retry ' + attempt : ''}]` });
      console.log(`▶ ${stage.id} → ${stage.agent} on ${tierName} (${TIERS[tierName].model})${attempt ? ' [attempt ' + (attempt + 1) + ']' : ''}`);
      const before = treeSnapshot(workdir(vars));
      const t0 = Date.now();
      const res = hooks.runAgent(stage, tierName, vars, feedback, reworkNote);
      const rwState = handleRework(run, stage, vars, res, t0);
      if (rwState === 'blocked') return;
      if (rwState === 'back') { reworked = true; break; }
      const problems = verify(stage, vars, res);
      // Guard (2026-11-07): a build stage that changed nothing has not done its task, even if checks pass.
      if (mustChange(stage) && before !== null && treeSnapshot(workdir(vars)) === before) problems.push('no files changed in ' + workdir(vars) + ' (the task was not implemented)');
      run.history.push({ stage: stage.id, agent: stage.agent, attempt: attempt + 1, ...res, ok: !problems.length, problems, at: now() });
      ev({ type: 'usage', agent: stage.agent, tier: tierName, model: res.model, cloud: res.cloud, tokensIn: res.usage?.in || 0, tokensOut: res.usage?.out || 0, secs: res.secs });
      if (!problems.length) {
        done = true;
        ev({ type: 'done', agent: stage.agent, to: 'manager', task: `${stage.id} ✓ (${tierName}, ${res.secs}s)` });
        console.log(`  ✓ ${res.secs}s, ${res.turns ?? '?'} turns`);
      } else {
        feedback = problems.join('\n');
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
    if (run.reworkNotes) delete run.reworkNotes[stage.id]; // note consumed by a successful build
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
		const run = load(rest[0]); run.status = 'running'; save(run); advance(run);
	} else if (cmd === 'approve') {
		const run = load(rest[0]); const decision = rest[1] || 'approve';
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

module.exports = { advance, hooks, parseRunOutput, verify, resolveTeamLead, agentDefinition, treeSnapshot, mustChange, writePostmortem, checkRequires, fill, REPO };
