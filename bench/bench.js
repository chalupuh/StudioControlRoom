#!/usr/bin/env node
// Role benchmark: can a local model do this studio role well enough?
//   node bench/bench.js run [--models a,b] [--providers p1,p2] [--provider p] [--roles r1,r2]   -> runs evals, auto-checks, writes results
//   node bench/bench.js report <results-dir>                                   -> summary table (markdown)
// Evals live in bench/evals/<role>/<id>.json. No dependencies; talks to Ollama's native API.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const ROOT = __dirname;
const OLLAMA = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const DEFAULT_MODELS = ['qwen3-coder:30b', 'qwen3.6:27b', 'qwen3:4b'];

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };

// ---- provider abstractions ----
// Each provider has: displayName (label), model (identifier), and chatFn(model, messages, tools).
// Returns { msg, secs, tps, outTokens } or throws.

const OLLAMA_TIMEOUT = parseInt(process.env.OLLAMA_TIMEOUT_MS || '300000', 10);
const ANTHROPIC_TIMEOUT = parseInt(process.env.ANTHROPIC_TIMEOUT_MS || '120000', 10);

async function chatOllama(model, messages, tools) {
  const t0 = Date.now();
  const body = JSON.stringify({ model, messages, tools, stream: false, options: { temperature: 0.2, num_ctx: 16384 } });
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), OLLAMA_TIMEOUT);
      const r = await fetch(`${OLLAMA}/api/chat`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: ac.signal,
      });
      clearTimeout(timer);
      const j = await r.json();
      if (j.error) throw new Error('ollama: ' + j.error);
      const secs = (Date.now() - t0) / 1000;
      const tps = j.eval_count && j.eval_duration ? j.eval_count / (j.eval_duration / 1e9) : 0;
      return { msg: j.message, secs, tps, outTokens: j.eval_count || 0, inTokens: j.prompt_eval_count || 0 };
    } catch (e) {
      if (attempt < 2 && /fetch failed|ECONNREFUSED|reset|abort/i.test(String(e))) {
        await new Promise((r) => setTimeout(r, 3000)); // Ollama may be loading model
        continue;
      }
      throw e;
    }
  }
}

// Shared CLI helpers. Both CLI providers run in a throwaway temp dir so a model can never touch the repo.
const codexPath = require('../engine/codex-path.js'); // same resolution and spawning as the engine
const findCodex = () => codexPath.findCodex(process.env.STUDIO_HOME || null);

function findClaude() {
  if (process.env.CLAUDE_EXE) return process.env.CLAUDE_EXE;
  const wins = process.platform === 'win32';
  for (const dir of (process.env.PATH || process.env.Path || '').split(path.delimiter).filter(Boolean)) {
    for (const x of wins ? ['.exe', '.cmd'] : ['']) { const p = path.join(dir, 'claude' + x); if (fs.existsSync(p)) return p; }
  }
  const found = [];
  const walk = (d, depth) => { if (depth > 5) return; let es = []; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p, depth + 1); else if (e.name === 'claude.exe') found.push(p); } };
  walk(path.join(process.env.LOCALAPPDATA || '', 'Claude-Data'), 0);
  found.sort((x, y) => fs.statSync(x).mtimeMs - fs.statSync(y).mtimeMs);
  return found.pop() || null;
}

// One prompt for every provider: system message (if any) first, then the first user message.
const flatPrompt = (messages) => {
  const sys = (messages.find((m) => m.role === 'system') || {}).content;
  const usr = (messages.find((m) => m.role === 'user') || {}).content || '';
  return sys ? sys + '\n\n' + usr : usr;
};

function spawnCli(exe, args, input) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-cli-'));
  const t0 = Date.now();
  try {
    // codex npm shims run via node directly; other .cmd shims (claude.cmd) go through a quoted shell command.
    const spec = codexPath.codexSpawnSpec(exe, args);
    const r = spawnSync(spec.command, spec.args, { shell: spec.shell, input, cwd: dir, encoding: 'utf8', timeout: 300000, maxBuffer: 64 * 1024 * 1024 });
    return { r, secs: (Date.now() - t0) / 1000 };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// codex CLI provider (ADR 0004, ChatGPT sign-in, no API key): `codex exec --json --sandbox read-only -`
async function chatCodex(_model, messages, _tools) {
  const exe = findCodex();
  if (!exe) throw new Error('codex binary not found on PATH');
  const { r, secs } = spawnCli(exe, ['exec', '--json', '--sandbox', 'read-only', '--skip-git-repo-check', '-'], flatPrompt(messages));
  let result = '', outTokens = 0, inTokens = 0, error = null;
  for (const line of (r.stdout || '').split('\n')) {
    let o; try { o = JSON.parse(line.trim()); } catch { continue; }
    if (!o || typeof o !== 'object') continue;
    if (o.type === 'item.completed' && o.item && o.item.type === 'agent_message') result = String(o.item.text || '');
    else if (o.type === 'result') result = String(o.result || '');
    else if (o.type === 'turn.completed' && o.usage) { outTokens += (o.usage.output_tokens || 0); inTokens += (o.usage.input_tokens || 0); }
    else if (o.type === 'turn.failed' || o.type === 'error') error = o.error?.message || o.message;
  }
  if (!result && r.status !== 0) throw new Error('codex: ' + (error || r.stderr?.slice(-800) || 'exited with code ' + r.status));
  return { msg: { content: result }, secs, tps: secs > 0 ? outTokens / secs : 0, outTokens, inTokens };
}

// Sonnet via Claude Code (`claude -p --model sonnet --output-format json`): the studio has no API key.
async function chatClaude(model, messages, _tools) {
  const exe = findClaude();
  if (!exe) throw new Error('claude binary not found (set CLAUDE_EXE)');
  const { r, secs } = spawnCli(exe, ['-p', '--model', model, '--output-format', 'json'], flatPrompt(messages));
  let j = null; try { j = JSON.parse((r.stdout || '').trim()); } catch {}
  if (!j || j.is_error || r.status !== 0) throw new Error('claude: ' + ((j && j.result) || r.stderr?.slice(-800) || 'exited with code ' + r.status));
  const u = j.usage || {};
  const outTokens = u.output_tokens || 0;
  const inTokens = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
  return { msg: { content: String(j.result || '') }, secs, tps: secs > 0 ? outTokens / secs : 0, outTokens, inTokens };
}

// Anthropic Messages API provider
async function chatAnthropic(model, messages, _tools) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
  const baseUrl = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
  const sysMsg = messages.find((m) => m.role === 'system');
  const nonSys = messages.filter((m) => m.role !== 'system');
  const t0 = Date.now();
  const req = JSON.stringify({
    model, max_tokens: 8192, temperature: 0.2,
    system: sysMsg ? sysMsg.content : undefined,
    messages: nonSys,
  });
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), ANTHROPIC_TIMEOUT);
      const r = await fetch(`${baseUrl}/v1/messages`, {
        method: 'POST', headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: req, signal: ac.signal,
      });
      clearTimeout(timer);
      const j = await r.json();
      if (j.error) {
        if (j.error.type === 'api_error' && attempt < 2) { await new Promise((r) => setTimeout(r, 5000)); continue; }
        throw new Error('anthropic: ' + j.error.message);
      }
      const secs = (Date.now() - t0) / 1000;
      const outTokens = j.usage?.output_tokens || 0;
      const tps = secs > 0 ? outTokens / secs : 0;
      return { msg: { content: j.content?.[0]?.text || '' }, secs, tps, outTokens, inTokens: j.usage?.input_tokens || 0 };
    } catch (e) {
      if (attempt < 2 && /fetch failed|ECONNREFUSED|reset|abort/i.test(String(e))) {
        await new Promise((r) => setTimeout(r, 3000)); continue;
      }
      throw e;
    }
  }
}

// Provider registry: maps provider name → { displayName, model, chatFn }
const PROVIDERS = {
  codex:       { displayName: 'Codex',       model: 'codex',              chatFn: chatCodex },
  sonnet:      { displayName: 'Sonnet',      model: process.env.BENCH_SONNET_MODEL || 'sonnet', chatFn: chatClaude },
  'sonnet-api': { displayName: 'Sonnet (API)', model: process.env.BENCH_SONNET_MODEL || 'claude-sonnet-4-20250514', chatFn: chatAnthropic },
  'qwen3.6:27b': { displayName: 'Qwen3.6 27B', model: 'qwen3.6:27b',       chatFn: chatOllama },
  'qwen3-coder:30b': { displayName: 'Qwen3-Coder 30B', model: 'qwen3-coder:30b', chatFn: chatOllama },
  'qwen3:4b':  { displayName: 'Qwen3 4B',    model: 'qwen3:4b',           chatFn: chatOllama },
};

// Backwards-compatible: if --models is given, resolve to providers (defaults to ollama chatFn)
function resolveModels(modelsStr) {
  return modelsStr.split(',').map((m) => {
    const key = m.trim();
    if (PROVIDERS[key]) return PROVIDERS[key];
    // treat as bare Ollama model name
    return { displayName: key, model: key, chatFn: chatOllama };
  });
}

// ---------- helpers ----------
const codeBlock = (text) => {
  const m = [...String(text).matchAll(/```(?:js|javascript|ts|mjs)?\s*\n([\s\S]*?)```/g)];
  return m.length ? m.map((x) => x[1]).join('\n') : String(text);
};

function runNodeTests(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-'));
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
  const r = spawnSync(process.execPath, ['--test', ...Object.keys(files).filter((f) => f.endsWith('.test.mjs'))], { cwd: dir, encoding: 'utf8', timeout: 60000 });
  return { pass: r.status === 0, out: (r.stdout + r.stderr).slice(-1500) };
}

// ---------- automatic checks ----------
function check(task, output, toolCalls) {
  const c = task.check || {};
  const notes = [];
  let auto = null; // 1 pass, 0 fail, null = needs judge only
  if (c.type === 'tests') {
    const r = runNodeTests({ 'solution.mjs': codeBlock(output), 'solution.test.mjs': c.tests });
    auto = r.pass ? 1 : 0; notes.push(r.pass ? 'tests passed' : 'tests FAILED:\n' + r.out);
  } else if (c.type === 'catches-bug') {
    const tests = codeBlock(output).replace(/from\s+['"](?!node:)[^'"]+['"]/g, "from './solution.mjs'");
    const bad = runNodeTests({ 'solution.mjs': c.buggy, 'solution.test.mjs': tests });
    const good = runNodeTests({ 'solution.mjs': c.fixed, 'solution.test.mjs': tests });
    auto = !bad.pass && good.pass ? 1 : 0;
    notes.push(`buggy version: ${bad.pass ? 'tests passed (bug NOT caught)' : 'tests failed (bug caught)'}; fixed version: ${good.pass ? 'pass' : 'FAIL:\n' + good.out}`);
  } else if (c.type === 'contains') {
    const miss = c.all.filter((s) => !new RegExp(s, 'i').test(output));
    auto = miss.length ? 0 : 1; notes.push(miss.length ? 'missing: ' + miss.join(', ') : 'all required parts present');
  } else if (c.type === 'number') {
    const nums = (String(output).match(/-?\d+(\.\d+)?/g) || []).map(Number);
    const hit = nums.some((n) => Math.abs(n - c.value) <= (c.tolerance ?? 0.5));
    auto = hit ? 1 : 0; notes.push(hit ? `found ${c.value}` : `expected ${c.value}, not found`);
  } else if (c.type === 'tool-calls') {
    const names = toolCalls.map((t) => t.function?.name);
    const forbidden = (c.forbid || []).filter(([name, key, re]) => toolCalls.some((t) => t.function?.name === name && new RegExp(re).test(String(t.function?.arguments?.[key] ?? ''))));
    if (forbidden.length) notes.push('FORBIDDEN call made: ' + forbidden.map((f) => f.join(' ')).join('; '));
    const ok = (c.sequence || []).every((n) => names.includes(n)) && !forbidden.length;
    const argsOk = (c.args || []).every(([name, key, re]) => toolCalls.some((t) => t.function?.name === name && new RegExp(re).test(String(t.function?.arguments?.[key] ?? ''))));
    auto = ok && argsOk ? 1 : 0; notes.push(`calls: [${names.join(', ')}] ${ok && argsOk ? 'OK' : 'expected ' + (c.sequence || []).join(' → ')}`);
  }
  return { auto, notes: notes.join('\n') };
}

// Simple agent loop for tool-use evals: fake tools answered from task.toolResults.
async function runTask(provider, task) {
  const messages = [];
  if (task.system) messages.push({ role: 'system', content: task.system });
  messages.push({ role: 'user', content: task.prompt });
  let total = { secs: 0, outTokens: 0, inTokens: 0, tps: [] }, out = '', calls = [];
  for (let step = 0; step < (task.tools ? 6 : 1); step++) {
    const r = await provider.chatFn(provider.model, messages, task.tools);
    total.secs += r.secs; total.outTokens += r.outTokens; total.inTokens += r.inTokens || 0; if (r.tps) total.tps.push(r.tps);
    messages.push(r.msg);
    out = r.msg.content || out;
    const tc = r.msg.tool_calls || [];
    if (!tc.length) break;
    calls.push(...tc);
    for (const t of tc) {
      let r2 = (task.toolResults || {})[t.function?.name] ?? 'ok';
      if (r2 && typeof r2 === 'object') { const a = t.function?.arguments || {}; const key = a.path || a.command || ''; r2 = r2[key] ?? Object.entries(r2).find(([k]) => k !== '*' && key.includes(k))?.[1] ?? r2['*'] ?? 'ok'; }
      messages.push({ role: 'tool', content: r2 });
    }
  }
  return { out, calls, secs: total.secs, outTokens: total.outTokens, inTokens: total.inTokens, tps: total.tps.length ? total.tps.reduce((a, b) => a + b) / total.tps.length : 0 };
}

// ---------- main runner ----------
async function run() {
  const roleFilter = arg('roles') ? arg('roles').split(',') : null;

  // Resolve providers: --providers > --provider (singular alias) > --models (backward compat).
  let providers;
  const providerStr = arg('providers') || arg('provider');
  if (providerStr) {
    providers = providerStr.split(',').map((p) => {
      const key = p.trim();
      if (!PROVIDERS[key]) throw new Error('unknown provider: ' + key + ' (available: ' + Object.keys(PROVIDERS).join(', ') + ')');
      return PROVIDERS[key];
    });
  } else {
    providers = resolveModels(arg('models') || DEFAULT_MODELS.join(','));
  }

  const evalDir = path.join(ROOT, 'evals');
  const roles = fs.readdirSync(evalDir).filter((r) => !roleFilter || roleFilter.includes(r));
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const outDir = path.join(ROOT, 'results', stamp);
  fs.mkdirSync(outDir, { recursive: true });
  const rows = [];
  for (const provider of providers) {
    const modelLabel = provider.displayName;
    for (const role of roles) {
      for (const f of fs.readdirSync(path.join(evalDir, role)).filter((f) => f.endsWith('.json'))) {
        const task = JSON.parse(fs.readFileSync(path.join(evalDir, role, f), 'utf8'));
        process.stdout.write(`${modelLabel} · ${role}/${task.id} … `);
        let res, chk;
        try {
          res = await runTask(provider, task);
          chk = check(task, res.out, res.calls);
        } catch (e) {
          res = { out: 'ERROR: ' + e.message, calls: [], secs: 0, tps: 0, outTokens: 0, inTokens: 0 };
          chk = { auto: 0, notes: e.message };
        }
        console.log(`${chk.auto === null ? 'judge' : chk.auto ? 'PASS' : 'FAIL'} (${res.secs.toFixed(1)}s, ${res.tps.toFixed(0)} tok/s)`);
        const row = { model: modelLabel, provider: provider.model, role, id: task.id, auto: chk.auto, secs: +res.secs.toFixed(1), tps: +res.tps.toFixed(0), outTokens: res.outTokens, inTokens: res.inTokens, rubric: task.rubric || null };
        rows.push(row);
        const safeModel = modelLabel.replace(/[:/\s]/g, '_');
        const md = `# ${role}/${task.id} · ${modelLabel}\n\n**Auto check:** ${chk.auto === null ? 'n/a' : chk.auto ? 'PASS' : 'FAIL'}  \n**Time:** ${row.secs}s · ${row.tps} tok/s · ${row.inTokens} in / ${row.outTokens} out tokens\n\n## Check notes\n\`\`\`\n${chk.notes}\n\`\`\`\n\n## Rubric (for judge)\n${(task.rubric || []).map((r) => '- ' + r).join('\n') || '(none)'}\n\n## Prompt\n${task.prompt}\n\n## Tool calls\n${res.calls.map((c) => '- ' + c.function?.name + ' ' + JSON.stringify(c.function?.arguments)).join('\n') || '(none)'}\n\n## Output\n${res.out}\n`;
        fs.writeFileSync(path.join(outDir, `${safeModel}__${role}__${task.id}.md`), md);
      }
    }
  }
  fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(rows, null, 2));
  console.log('\n' + report(rows) + `\nResults: ${outDir}`);
  return rows;
}

function report(rows) {
  const by = {};
  for (const r of rows) { const k = `${r.role}|${r.model}`; (by[k] ||= []).push(r); }
  let md = '| Role | Model | Auto pass | Avg time | Avg tok/s |\n|---|---|---|---|---|\n';
  for (const [k, rs] of Object.entries(by).sort()) {
    const [role, model] = k.split('|');
    const graded = rs.filter((r) => r.auto !== null);
    md += `| ${role} | ${model} | ${graded.length ? `${graded.filter((r) => r.auto).length}/${graded.length}` : 'judge'} | ${(rs.reduce((a, r) => a + r.secs, 0) / rs.length).toFixed(1)}s | ${(rs.reduce((a, r) => a + r.tps, 0) / rs.length).toFixed(0)} |\n`;
  }
  return md;
}

// Expose run for programmatic use (e.g. test runner)
const cmd = process.argv[2];
if (cmd === 'run') run().catch((e) => { console.error(e); process.exit(1); });
else if (cmd === 'report') console.log(report(JSON.parse(fs.readFileSync(path.join(process.argv[3], 'results.json'), 'utf8'))));
else console.log('usage: bench.js run [--models a,b] [--providers p1,p2] [--roles r1,r2] | report <dir>');

module.exports = { run, runTask, check, PROVIDERS, chatOllama, chatCodex, chatClaude, chatAnthropic, findCodex, findClaude };
