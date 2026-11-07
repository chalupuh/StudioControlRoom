#!/usr/bin/env node
// Role benchmark: can a local model do this studio role well enough?
//   node tools/bench/bench.js run [--models a,b] [--roles r1,r2]   -> runs evals, auto-checks, writes results
//   node tools/bench/bench.js report <results-dir>                 -> summary table (markdown)
// Evals live in tools/bench/evals/<role>/<id>.json. No dependencies; talks to Ollama's native API.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const ROOT = __dirname;
const OLLAMA = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const DEFAULT_MODELS = ['qwen3-coder:30b', 'qwen3.6:27b', 'qwen3:4b'];

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };

async function chat(model, messages, tools) {
  const t0 = Date.now();
  const r = await fetch(`${OLLAMA}/api/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, tools, stream: false, options: { temperature: 0.2, num_ctx: 16384 } }),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  const secs = (Date.now() - t0) / 1000;
  const tps = j.eval_count && j.eval_duration ? j.eval_count / (j.eval_duration / 1e9) : 0;
  return { msg: j.message, secs, tps, outTokens: j.eval_count || 0 };
}

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
    // The model writes tests; they must FAIL on the buggy version and PASS on the fixed one.
    const tests = codeBlock(output).replace(/from\s+['"](?!node:)[^'"]+['"]/g, "from './solution.mjs'"); // keep node: imports
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
async function runTask(model, task) {
  const messages = [];
  if (task.system) messages.push({ role: 'system', content: task.system });
  messages.push({ role: 'user', content: task.prompt });
  let total = { secs: 0, outTokens: 0, tps: [] }, out = '', calls = [];
  for (let step = 0; step < (task.tools ? 6 : 1); step++) {
    const r = await chat(model, messages, task.tools);
    total.secs += r.secs; total.outTokens += r.outTokens; if (r.tps) total.tps.push(r.tps);
    messages.push(r.msg);
    out = r.msg.content || out;
    const tc = r.msg.tool_calls || [];
    if (!tc.length) break;
    calls.push(...tc);
    for (const t of tc) {
      // toolResults[name] is either a string, or an object keyed by the path/command argument (with "*" as fallback)
      let r = (task.toolResults || {})[t.function?.name] ?? 'ok';
      if (r && typeof r === 'object') { const a = t.function?.arguments || {}; const key = a.path || a.command || ''; r = r[key] ?? Object.entries(r).find(([k]) => k !== '*' && key.includes(k))?.[1] ?? r['*'] ?? 'ok'; }
      messages.push({ role: 'tool', content: r });
    }
  }
  return { out, calls, secs: total.secs, outTokens: total.outTokens, tps: total.tps.length ? total.tps.reduce((a, b) => a + b) / total.tps.length : 0 };
}

async function run() {
  const models = (arg('models') || DEFAULT_MODELS.join(',')).split(',');
  const roleFilter = arg('roles') ? arg('roles').split(',') : null;
  const evalDir = path.join(ROOT, 'evals');
  const roles = fs.readdirSync(evalDir).filter((r) => !roleFilter || roleFilter.includes(r));
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const outDir = path.join(ROOT, 'results', stamp);
  fs.mkdirSync(outDir, { recursive: true });
  const rows = [];
  for (const model of models) {
    for (const role of roles) {
      for (const f of fs.readdirSync(path.join(evalDir, role)).filter((f) => f.endsWith('.json'))) {
        const task = JSON.parse(fs.readFileSync(path.join(evalDir, role, f), 'utf8'));
        process.stdout.write(`${model} · ${role}/${task.id} … `);
        let res, chk;
        try { res = await runTask(model, task); chk = check(task, res.out, res.calls); }
        catch (e) { res = { out: 'ERROR: ' + e.message, calls: [], secs: 0, tps: 0, outTokens: 0 }; chk = { auto: 0, notes: e.message }; }
        console.log(`${chk.auto === null ? 'judge' : chk.auto ? 'PASS' : 'FAIL'} (${res.secs.toFixed(1)}s, ${res.tps.toFixed(0)} tok/s)`);
        const row = { model, role, id: task.id, auto: chk.auto, secs: +res.secs.toFixed(1), tps: +res.tps.toFixed(0), outTokens: res.outTokens, rubric: task.rubric || null };
        rows.push(row);
        const md = `# ${role}/${task.id} · ${model}\n\n**Auto check:** ${chk.auto === null ? 'n/a' : chk.auto ? 'PASS' : 'FAIL'}  \n**Time:** ${row.secs}s · ${row.tps} tok/s · ${row.outTokens} tokens\n\n## Check notes\n\`\`\`\n${chk.notes}\n\`\`\`\n\n## Rubric (for judge)\n${(task.rubric || []).map((r) => '- ' + r).join('\n') || '(none)'}\n\n## Prompt\n${task.prompt}\n\n## Tool calls\n${res.calls.map((c) => '- ' + c.function?.name + ' ' + JSON.stringify(c.function?.arguments)).join('\n') || '(none)'}\n\n## Output\n${res.out}\n`;
        fs.writeFileSync(path.join(outDir, `${model.replace(/[:/]/g, '_')}__${role}__${task.id}.md`), md);
      }
    }
  }
  fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(rows, null, 2));
  console.log('\n' + report(rows) + `\nResults: ${outDir}`);
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

const cmd = process.argv[2];
if (cmd === 'run') run().catch((e) => { console.error(e); process.exit(1); });
else if (cmd === 'report') console.log(report(JSON.parse(fs.readFileSync(path.join(process.argv[3], 'results.json'), 'utf8'))));
else console.log('usage: bench.js run [--models a,b] [--roles r1,r2] | report <dir>');
