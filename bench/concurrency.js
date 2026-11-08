#!/usr/bin/env node
// Concurrency benchmark: run coding evals at varying concurrency levels
//   node bench/concurrency.js run        -> full benchmark against Ollama
//   node bench/concurrency.js --dry-run -> validate setup only (no LLM calls)
//
// Runs 3 coding evals with 1, 2, 3, 4 simultaneous requests to qwen3.6:27b,
// reports per-request tok/s, aggregate tok/s, wall time and pass rate.
// Writes results to bench/results/concurrency-<date>.md.
// Prints recommended llmSlots (highest level where aggregate throughput
// still rises by >=20 % and pass rate does not drop).

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const ROOT = __dirname;
const OLLAMA = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const MODEL = process.env.BENCH_MODEL || 'qwen3.6:27b';
const CONCURRENCY_LEVELS = [1, 2, 3, 4];
const EVAL_COUNT = 3;

// ---------- pick 3 coding evals ----------
function loadEvals() {
  const evalDir = path.join(ROOT, 'evals', 'coding');
  const files = fs.readdirSync(evalDir).filter((f) => f.endsWith('.json'));
  // pick first 3 alphabetically
  return files.slice(0, EVAL_COUNT).map((f) => JSON.parse(fs.readFileSync(path.join(evalDir, f), 'utf8')));
}

// ---------- helpers (mirror bench.js) ----------
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };

async function chat(model, messages) {
  const t0 = Date.now();
  const r = await fetch(`${OLLAMA}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, stream: false, options: { temperature: 0.2, num_ctx: 16384 } }),
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conc-'));
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
  const r = spawnSync(process.execPath, ['--test', ...Object.keys(files).filter((f) => f.endsWith('.test.mjs'))], {
    cwd: dir, encoding: 'utf8', timeout: 60000,
  });
  return { pass: r.status === 0, out: (r.stdout + r.stderr).slice(-1000) };
}

function checkEval(task, output) {
  const c = task.check || {};
  if (c.type !== 'tests') return { pass: null };
  const r = runNodeTests({ 'solution.mjs': codeBlock(output), 'solution.test.mjs': c.tests });
  return { pass: r.pass ? 1 : 0 };
}

// run one eval end-to-end (no tool-use loop needed for coding evals)
async function runEval(model, task) {
  const messages = [];
  if (task.system) messages.push({ role: 'system', content: task.system });
  messages.push({ role: 'user', content: task.prompt });
  const r = await chat(model, messages);
  const chk = checkEval(task, r.msg.content || '');
  return { pass: chk.pass, secs: r.secs, tps: r.tps, outTokens: r.outTokens };
}

// run `n` evals concurrently (bounded by concurrency level)
async function runBatch(concurrency, evals) {
  const results = [];
  const queue = [...evals];
  const active = [];

  while (queue.length > 0 || active.length > 0) {
    while (active.length < concurrency && queue.length > 0) {
      const task = queue.shift();
      const slot = runEval(MODEL, task).then((res) => {
        active.splice(active.indexOf(slot), 1);
        results.push(res);
        return res;
      });
      active.push(slot);
    }
    if (active.length > 0) {
      // wait for any one to finish, then loop again
      await Promise.race(active);
    }
  }
  return results;
}

// ---------- dry-run: validate setup ----------
async function dryRun() {
  console.log('--- concurrency dry-run ---');
  let ok = true;

  // 1. evals exist and parse
  try {
    const evals = loadEvals();
    console.log(`  evals: ${evals.length} coding evals loaded (${evals.map((e) => e.id).join(', ')})`);
  } catch (e) {
    console.error(`  evals: FAILED — ${e.message}`);
    ok = false;
  }

  // 2. Ollama reachable
  try {
    const r = await fetch(`${OLLAMA}/api/tags`);
    const j = await r.json();
    const modelOk = j.models && j.models.some((m) => m.name.includes(MODEL.split(':')[0]));
    console.log(`  ollama: reachable (${OLLAMA})`);
    console.log(`  model ${MODEL}: ${modelOk ? 'available' : 'NOT FOUND in model list — will fail at request time'}`);
    if (!modelOk) ok = false;
  } catch (e) {
    console.error(`  ollama: UNREACHABLE — ${e.message}`);
    ok = false;
  }

  // 3. results directory writable
  try {
    fs.mkdirSync(path.join(ROOT, 'results'), { recursive: true });
    console.log(`  results dir: writable (${path.join(ROOT, 'results')})`);
  } catch (e) {
    console.error(`  results dir: FAILED — ${e.message}`);
    ok = false;
  }

  // 4. Node test runner available
  try {
    spawnSync(process.execPath, ['-v']);
    console.log(`  node: ${process.version}`);
  } catch (e) {
    console.error(`  node: FAILED — ${e.message}`);
    ok = false;
  }

  console.log(`\n  dry-run: ${ok ? 'PASS — setup OK' : 'FAIL — fix issues before running'}`);
  if (!ok) process.exit(1);
}

// ---------- full run ----------
async function run() {
  const evals = loadEvals();
  const allResults = {}; // concurrencyLevel -> { tasks[], wallSecs, aggregateTokens }

  for (const concurrency of CONCURRENCY_LEVELS) {
    console.log(`\n── concurrency ${concurrency} ──`);
    const t0 = Date.now();
    const tasks = await runBatch(concurrency, evals);
    const wallSecs = (Date.now() - t0) / 1000;
    const aggregateTokens = tasks.reduce((s, t) => s + t.outTokens, 0);
    const aggregateTok = aggregateTokens / wallSecs;
    const passCount = tasks.filter((t) => t.pass === 1).length;
    const passRate = passCount / tasks.length;

    // per-request average tok/s
    const avgTok = tasks.reduce((s, t) => s + t.tps, 0) / tasks.length;

    allResults[concurrency] = { tasks, wallSecs, aggregateTokens, aggregateTok, avgTok, passCount, passRate };

    console.log(`  wall: ${wallSecs.toFixed(1)}s  tokens: ${aggregateTokens}  agg tok/s: ${aggregateTok.toFixed(0)}  avg tok/s: ${avgTok.toFixed(0)}  pass: ${passCount}/${tasks.length} (${(passRate * 100).toFixed(0)}%)`);
  }

  // recommended llmSlots: highest concurrency where aggregate throughput
  // is >=20% above level 1 and pass rate >= level-1 pass rate
  const baseTok = allResults[1].aggregateTok;
  const basePass = allResults[1].passRate;
  let recommended = 1;
  for (const c of CONCURRENCY_LEVELS) {
    const tok = allResults[c].aggregateTok;
    const pass = allResults[c].passRate;
    if (tok >= baseTok * 1.2 && pass >= basePass) {
      recommended = c;
    }
  }

  // ---------- write results ----------
  const dateStr = new Date().toISOString().slice(0, 10);
  const outPath = path.join(ROOT, 'results', `concurrency-${dateStr}.md`);
  fs.mkdirSync(path.join(ROOT, 'results'), { recursive: true });

  let md = `# Concurrency Benchmark — ${dateStr}\n\n`;
  md += `**Model:** ${MODEL}  \n`;
  md += `**Ollama:** ${OLLAMA}  \n`;
  md += `**Evals:** ${evals.map((e) => e.id).join(', ')}  \n\n`;

  md += '| Concurrency | Wall (s) | Tokens | Agg tok/s | Avg tok/s | Pass | Pass % |\n';
  md += '|---|---|---|---|---|---|---|\n';
  for (const c of CONCURRENCY_LEVELS) {
    const r = allResults[c];
    md += `| ${c} | ${r.wallSecs.toFixed(1)} | ${r.aggregateTokens} | ${r.aggregateTok.toFixed(0)} | ${r.avgTok.toFixed(0)} | ${r.passCount}/${r.tasks.length} | ${(r.passRate * 100).toFixed(0)}% |\n`;
  }

  md += `\n## Recommendation\n\n`;
  md += `**Recommended \`llmSlots\`: ${recommended}**\n\n`;
  md += `Highest concurrency where aggregate throughput rises >=20% vs single-slot\n`;
  md += `and pass rate does not drop below the single-slot baseline.\n\n`;
  md += `| Level | Agg tok/s | vs-1x | Pass % | Eligible |\n`;
  md += '|---|---|---|---|---|\n';
  for (const c of CONCURRENCY_LEVELS) {
    const r = allResults[c];
    const gain = ((r.aggregateTok - baseTok) / baseTok * 100).toFixed(0);
    const eligible = r.aggregateTok >= baseTok * 1.2 && r.passRate >= basePass;
    md += `| ${c} | ${r.aggregateTok.toFixed(0)} | +${gain}% | ${(r.passRate * 100).toFixed(0)}% | ${eligible ? 'yes' : 'no'} |\n`;
  }

  fs.writeFileSync(outPath, md);
  console.log(`\nResults written to ${outPath}`);
  console.log(`\nRecommended llmSlots: ${recommended}`);
}

// ---------- main ----------
const dryRunFlag = process.argv.includes('--dry-run');
if (dryRunFlag) {
  dryRun().catch((e) => { console.error(e); process.exit(1); });
} else {
  const cmd = process.argv[2];
  if (cmd === 'run') run().catch((e) => { console.error(e); process.exit(1); });
  else if (process.argv.length < 3) {
    console.log('usage: node bench/concurrency.js [--dry-run | run]');
    console.log('  --dry-run  validate setup without contacting the model');
    console.log('  run        run the full concurrency benchmark');
  } else {
    console.log('usage: node bench/concurrency.js [--dry-run | run]');
  }
}
