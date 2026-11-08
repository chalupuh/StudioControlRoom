#!/usr/bin/env node
// Studio Workflow Engine ("Kaito"): runs pipelines as a state machine so the expensive
// Claude session doesn't have to. Local models do the work; Claude only at gates/escalation.
//
//   node tools/engine/engine.js start <pipeline> [--var key=value ...]   create + run until a gate/stop
//   node tools/engine/engine.js resume <runId>                            continue (after approve / un-pause)
//   node tools/engine/engine.js approve <runId> [approve|park|reject] ["note"] answer the owner gate (park = decide later; resume re-opens it)
//   node tools/engine/engine.js approve <runId> items '<json {item: approve|park|reject}>' ["note"]   per-item decisions, written back into the gate's file
//   node tools/engine/engine.js status [runId]                            list runs / show one
//   node tools/engine/engine.js pipelines                                  list pipelines
//
// Pipeline stage types (tools/engine/pipelines/*.json):
//   agent   { id, agent, tier: local|local-fast|sonnet|opus, task, expect:[paths], check:"cmd", maxTurns }
//   gate    { id, title, show:[paths], items?:{ file, regex } }  stops until the owner decides; items = per-item decisions
//   script  { id, run:"cmd" }                       deterministic step, no model
//   foreach { id, items:{ file, regex }, stages:[...] }  repeats sub-stages per match ({{item}})
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
    error: (hasFailure && !hasResult) ? stderr.slice(-800) || out.subtype : null,
    ignoredWarning: modelWarning ? stderr.slice(0, 300) : null,
    usage: out.usage ? { in: out.usage.input_tokens, out: out.usage.output_tokens, cached: out.usage.cache_read_input_tokens } : null,
    hitTurnCap: out.subtype === 'error_max_turns',
  };
}

// ---- run one agent stage on a given tier ----
function runAgent(stage, tierName, vars, feedback) {
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
  if (feedback) prompt += `\n\nA previous attempt failed these checks; fix them:\n${feedback}`;
  const args = ['-p', '--agent', stage.agent, '--model', tier.model, '--permission-mode', 'acceptEdits', '--output-format', 'json', '--max-turns', String(stage.maxTurns || 25)];
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
  return problems;
}

// Resolve the build agent from the design.md "Team:" line.
// Picks the first of frontend-dev, mobile-dev, backend-dev named in that line.
// Returns "mobile-dev" if the file is missing or no role is found.
// Accepts absolute paths or repo-relative paths (joined with REPO).
function resolveTeamLead(designPath) {
	const f = path.isAbsolute(designPath) ? designPath : path.join(REPO, designPath);
	let txt = '';
	try { txt = fs.readFileSync(f, 'utf8'); } catch {}
	// Match "Team:" with optional leading list bullets, optional bold markdown, any case.
	const teamRegex = /^[ \t]*[*\->]?\s*\*?Team\*?:/im;
	const line = txt.split('\n').find((l) => teamRegex.test(l));
	if (!line) return 'mobile-dev';
	const candidates = ['frontend-dev', 'mobile-dev', 'backend-dev'];
	for (const c of candidates) { if (line.includes(c)) return c; }
	return 'mobile-dev';
}

// ---- gate items (Owner Inbox) ----
const ITEM_DECISIONS = ['approve', 'park', 'reject'];
const cap = (w) => w[0].toUpperCase() + w.slice(1);
const CHOICE = /approve\s*\/\s*park\s*\/\s*reject/i;
// Items a gate asks the owner to decide: every regex match in the file (group 1 or whole match, trimmed).
function parseItems(spec, vars) {
  if (!spec || !spec.file || !spec.regex) return [];
  let src = ''; try { src = fs.readFileSync(path.resolve(REPO, fill(spec.file, vars || {})), 'utf8'); } catch { return []; }
  const seen = new Set(), out = [];
  for (const m of src.matchAll(new RegExp(spec.regex, 'gm'))) {
    const id = (m[1] || m[0]).trim();
    if (id && !seen.has(id)) { seen.add(id); out.push({ id, text: m[0].trim() }); }
  }
  return out;
}
// Write decisions into the file's Owner decision lines: tick the box, replace "Approve / Park / Reject" with the chosen word.
function writeItemDecisions(spec, vars, map) {
  const f = path.resolve(REPO, fill(spec.file, vars || {}));
  const re = new RegExp(spec.regex, 'm');
  const out = fs.readFileSync(f, 'utf8').split('\n').map((line) => {
    const m = line.match(re); const id = m && (m[1] || m[0]).trim();
    if (!id || !Object.prototype.hasOwnProperty.call(map, id)) return line;
    const l = line.replace(/\[[ xX]?\]/, '[x]');
    return CHOICE.test(l) ? l.replace(CHOICE, cap(map[id])) : l.replace(/\s*$/, '') + ' \u2192 ' + cap(map[id]);
  });
  fs.writeFileSync(f, out.join('\n'));
}
// Record a decision on a waiting gate: approve|park|reject, or a map of per-item decisions (outcome derived:
// any approve -> approved, else any park -> parked, else rejected). Throws on bad input. Returns the gate status.
function decideGate(run, gid, decision, note, map) {
  const g = run.gates[gid];
  if (map) {
    const known = new Set((g.itemList || []).map((i) => i.id));
    if (!g.items || !known.size) throw new Error('gate has no items');
    const entries = Object.entries(map);
    if (!entries.length) throw new Error('items map is empty');
    for (const [k, v] of entries) {
      if (!known.has(k)) throw new Error('unknown item: ' + k);
      if (!ITEM_DECISIONS.includes(v)) throw new Error('bad decision for ' + k + ': ' + v);
    }
    writeItemDecisions(g.items, run.vars, map);
    g.itemDecisions = { ...(g.itemDecisions || {}), ...map };
    const all = Object.values(g.itemDecisions);
    decision = all.includes('approve') ? 'approve' : all.includes('park') ? 'park' : 'reject';
  } else if (!ITEM_DECISIONS.includes(decision)) throw new Error('decision must be approve, park or reject');
  g.status = { approve: 'approved', park: 'parked', reject: 'rejected' }[decision];
  Object.assign(g, { note: note || '', decided: now() });
  if (decision === 'park') run.status = 'parked'; else if (decision === 'reject') run.status = 'stopped';
  return g.status;
}

// ---- the state machine ----
function advance(run) {
  while (run.cursor < run.stages.length) {
    if (paused(run.stages[run.cursor] && run.stages[run.cursor].agent)) { run.status = 'paused'; save(run); console.log('Studio is paused (safe stop). Resume with the switch, then: engine.js resume ' + run.id); return; }
    const stage = run.stages[run.cursor];
    const vars = run.vars;

    if (stage.type === 'gate') {
      const g = run.gates[stage.id];
      if (!g) {
        run.gates[stage.id] = { status: 'waiting', title: fill(stage.title, vars), show: (stage.show || []).map((s) => fill(s, vars)), since: now() };
        if (stage.items) { const g2 = run.gates[stage.id]; g2.items = { file: fill(stage.items.file, vars), regex: stage.items.regex }; g2.itemList = parseItems(g2.items, vars); }
        run.status = 'waiting-gate'; save(run);
        ev({ type: 'gate', agent: 'owner', run: run.id, message: `Needs your decision: ${fill(stage.title, vars)}` });
        console.log(`\n⏸ OWNER GATE "${stage.id}": ${fill(stage.title, vars)}\n   Review: ${(stage.show || []).map((s) => fill(s, vars)).join(', ')}\n   Then: node tools/engine/engine.js approve ${run.id} approve|reject "<note>"`);
        return;
      }
      if (g.status === 'waiting') { run.status = 'waiting-gate'; save(run); console.log('Still waiting on gate ' + stage.id); return; }
      if (g.status === 'parked') { run.status = 'parked'; save(run); console.log('Gate ' + stage.id + ' is parked. Re-open with: engine.js resume ' + run.id); return; }
      if (g.status === 'rejected') { run.status = 'stopped'; save(run); console.log('Owner rejected at ' + stage.id + '. Run stopped.'); return; }
      run.cursor++; continue;
    }

    if (stage.type === 'script') {
      const c = spawnSync(fill(stage.run, vars), { cwd: workdir(vars), shell: true, encoding: 'utf8' });
      run.history.push({ stage: stage.id, type: 'script', ok: c.status === 0, at: now(), out: (c.stdout + c.stderr).slice(-500) });
      if (c.status !== 0) { run.status = 'blocked'; run.blockedReason = `script ${stage.id} failed`; save(run); return; }
      run.cursor++; save(run); continue;
    }

    if (stage.type === 'foreach') {
      const src = fs.existsSync(path.resolve(REPO, fill(stage.items.file, vars))) ? fs.readFileSync(path.resolve(REPO, fill(stage.items.file, vars)), 'utf8') : '';
      // Each match gives {{item}} (group 1 or whole match) plus {{g1}}, {{g2}}… for every capture group.
      const items = [...src.matchAll(new RegExp(stage.items.regex, 'gm'))].map((m) => ({ item: (m[1] || m[0]).trim(), ...Object.fromEntries(m.slice(1).map((g, j) => [`g${j + 1}`, (g || '').trim()])) }));
      if (!items.length) { run.status = 'blocked'; run.blockedReason = `foreach ${stage.id}: no items found in ${stage.items.file}`; save(run); return; }
      const esc = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, JSON.stringify(v).slice(1, -1)])); // safe inside JSON strings
      const expanded = items.flatMap((it, i) => stage.stages.map((s) => JSON.parse(fill(JSON.stringify({ ...s, id: `${s.id}#${i + 1}` }), { ...vars, ...esc(it), n: i + 1 }))));
      run.stages.splice(run.cursor, 1, ...expanded); save(run); continue;
    }

    // agent stage with escalation ladder
    // Resolve __team_lead__ sentinel: pick build agent from design.md "Team:" line.
    // Uses stage.designDoc if provided (pipeline-level override), otherwise falls back
    // to the conventional docs/specs/{{slug}}.design.md path.
    if (stage.agent === '__team_lead__') {
      const designPath = fill(stage.designDoc || '{{slug}}.design.md', vars);
      stage.agent = resolveTeamLead(designPath);
    }
    const ladder = LADDER[stage.tier || 'local'];
    let feedback = null, done = false;
    for (let attempt = 0; attempt < ladder.length && !done; attempt++) {
      const tierName = ladder[attempt];
      if (paused(stage.agent)) break;
      ev({ type: 'start', agent: stage.agent, from: 'manager', task: `${stage.id} [${tierName}${attempt ? ', retry ' + attempt : ''}]` });
      console.log(`▶ ${stage.id} → ${stage.agent} on ${tierName} (${TIERS[tierName].model})${attempt ? ' [attempt ' + (attempt + 1) + ']' : ''}`);
      const res = runAgent(stage, tierName, vars, feedback);
      const problems = verify(stage, vars, res);
      run.history.push({ stage: stage.id, agent: stage.agent, attempt: attempt + 1, ...res, ok: !problems.length, problems, at: now() });
      ev({ type: 'usage', agent: stage.agent, runId: run.id, pipeline: run.pipeline, project: vars.slug || run.pipeline, stage: stage.id, stageTier: stage.tier || 'local', ok: !problems.length, tier: tierName, model: res.model, cloud: res.cloud, tokensIn: res.usage?.in || 0, tokensOut: res.usage?.out || 0, secs: res.secs });
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
    if (!done) {
      const isP = paused(stage.agent);
      run.status = isP ? 'paused' : 'blocked';
      run.blockedReason = isP ? 'paused' : `${stage.id} failed on every tier: ${feedback}`;
      save(run);
      if (!isP) ev({ type: 'gate', agent: 'owner', run: run.id, message: `Blocked: ${stage.id}. Needs owner or Claude help.` });
      console.log(run.status === 'blocked' ? `\n⛔ BLOCKED at ${stage.id}. See .studio/runs/${run.id}.json` : '\nPaused.');
      return;
    }
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
		const run = { id, pipeline: name, vars: { date: new Date().toISOString().slice(0, 10), soft: path.resolve(__dirname, '..'), home: REPO, ...pipe.defaults, ...vars }, stages: pipe.stages, cursor: 0, gates: {}, history: [], status: 'running', created: now() };
		for (const k of pipe.required || []) if (!run.vars[k]) { console.error(`missing --var ${k}=...`); process.exit(1); }
		save(run); console.log(`Run ${id} started: ${pipe.description || ''}`); advance(run);
	} else if (cmd === 'resume') {
		const run = load(rest[0]);
		for (const g of Object.values(run.gates)) if (g.status === 'parked') { g.status = 'waiting'; g.since = now(); delete g.decided; } // parked gates re-open for a decision
		run.status = 'running'; save(run); advance(run);
	} else if (cmd === 'approve') {
		const run = load(rest[0]); const isItems = rest[1] === 'items';
		const decision = isItems ? null : rest[1] || 'approve'; const note = (isItems ? rest[3] : rest[2]) || '';
		const gid = Object.keys(run.gates).find((k) => run.gates[k].status === 'waiting');
		if (!gid) { console.log('No gate is waiting.'); process.exit(0); }
		let map; if (isItems) { try { map = JSON.parse(rest[2]); if (!map || typeof map !== 'object' || Array.isArray(map)) throw 0; } catch { console.error('items needs a JSON object: {"item":"approve|park|reject"}'); process.exit(1); } }
		let status; try { status = decideGate(run, gid, decision, note, map); } catch (e) { console.error(e.message); process.exit(1); }
		ev({ type: 'progress', agent: 'owner', pct: 100, status: 'done', message: `Gate ${gid}: ${status}${note ? ' (' + note + ')' : ''}` });
		save(run); console.log(`Gate ${gid} ${status}.`); if (status === 'approved') advance(run);
	} else if (cmd === 'status') {
		if (rest[0]) { const r = load(rest[0]); console.log(JSON.stringify({ ...r, stages: r.stages.map((s, i) => `${i === r.cursor ? '→ ' : '  '}${s.id}`) }, null, 2)); }
		else if (fs.existsSync(RUNS)) for (const f of fs.readdirSync(RUNS).filter((f) => f.endsWith('.json'))) { const r = load(f.replace('.json', '')); console.log(`${r.id.padEnd(40)} ${r.status.padEnd(13)} at ${r.stages[r.cursor]?.id || '(end)'}`); }
	} else if (cmd === 'pipelines') {
		for (const f of fs.readdirSync(PIPES)) { const p = JSON.parse(fs.readFileSync(path.join(PIPES, f), 'utf8')); console.log(`${f.replace('.json', '').padEnd(14)} ${p.description}  [vars: ${(p.required || []).join(', ')}]`); }
	} else console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 16).join('\n'));
}

module.exports = { parseRunOutput, verify, resolveTeamLead, parseItems, decideGate };
