#!/usr/bin/env node
// ComfyUI helper (Node 24, no deps). See README.md.
const fs = require('fs'), path = require('path');
const BASE = process.env.COMFY_URL || require('../studio/machine').load().comfyUrl;
const [cmd, ...rest] = process.argv.slice(2);
const a = {};
for (let i = 0; i < rest.length; i++) if (rest[i].startsWith('--')) a[rest[i].slice(2)] = rest[i + 1]?.startsWith('--') || rest[i + 1] === undefined ? true : rest[++i];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const die = (m) => { console.error('comfy.js: ' + m); process.exit(1); };

async function up() { try { return (await fetch(BASE + '/system_stats')).ok; } catch { return false; } }

async function run(graph, outFile) {
  if (!(await up())) die('ComfyUI not reachable at ' + BASE + '. Run tools/creative/start-comfy.ps1');
  const r = await fetch(BASE + '/prompt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: graph }) });
  const j = await r.json();
  if (!r.ok) die('prompt rejected: ' + JSON.stringify(j.node_errors && Object.keys(j.node_errors).length ? j.node_errors : j.error || j));
  const id = j.prompt_id;
  for (;;) {
    await sleep(1500);
    const h = await (await fetch(BASE + '/history/' + id)).json();
    const e = h[id];
    if (!e) continue;
    if (e.status?.status_str === 'error') {
      const m = e.status.messages?.find((m) => m[0] === 'execution_error');
      throw new Error(m ? m[1].exception_message : 'execution error');
    }
    const img = Object.values(e.outputs || {}).flatMap((o) => o.images || [])[0];
    if (!img) { if (e.status?.completed) throw new Error('no image output'); continue; }
    const q = new URLSearchParams({ filename: img.filename, subfolder: img.subfolder || '', type: img.type || 'output' });
    const buf = Buffer.from(await (await fetch(BASE + '/view?' + q)).arrayBuffer());
    fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
    fs.writeFileSync(outFile, buf);
    return;
  }
}

async function image() {
  if (!a.prompt || !a.out) die('usage: image --prompt "<p>" --w <px> --h <px> --out <file> [--seed N]');
  const g = JSON.parse(fs.readFileSync(path.join(__dirname, 'workflows', 'z_image_turbo.json'), 'utf8'));
  const seed = a.seed !== undefined ? Number(a.seed) : Math.floor(Math.random() * 2 ** 32);
  g['27'].inputs.text = a.prompt;
  g['13'].inputs.width = Number(a.w || 1024);
  g['13'].inputs.height = Number(a.h || 1024);
  g['3'].inputs.seed = seed;
  if (a.steps) g['3'].inputs.steps = Number(a.steps);
  for (let t = 1; ; t++) {
    try { await run(g, a.out); break; }
    catch (e) {
      if (/out of memory|OOM/i.test(e.message) && t < 4) { console.error('OOM, waiting 30s then retry ' + t); await sleep(30000); continue; }
      die(e.message);
    }
  }
  console.log(`ok ${a.out} seed=${seed} ${g['13'].inputs.width}x${g['13'].inputs.height}`);
}

const nyi = (n) => die(`'${n}' is not implemented yet (see tools/creative/README.md)`);
({ image })[cmd] ? image().catch((e) => die(e.message)) : ['edit', 'upscale', 'rmbg', 'i2v', 't2v'].includes(cmd) ? nyi(cmd) : die('commands: image | edit | upscale | rmbg | i2v | t2v');
