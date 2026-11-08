#!/usr/bin/env node
// Self-test for studio/machine.js: defaults, override merge, bad JSON fallback (with a warning).
const fs = require('fs');
const os = require('os');
const path = require('path');
const machine = require('../studio/machine');

let pass = 0, fail = 0;
const check = (name, ok) => { if (ok) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.error(`  FAIL ${name}`); } };

function tempHome(content) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'machine-test-'));
  if (content !== undefined) {
    fs.mkdirSync(path.join(home, '.studio'));
    fs.writeFileSync(path.join(home, '.studio', 'machine.json'), content);
  }
  return home;
}

// 1. no file → defaults
let m = machine.load(tempHome());
check('defaults: ollama url', m.ollama.url === 'http://127.0.0.1:11434');
check('defaults: numParallel 4, keepAlive 5m', m.ollama.numParallel === 4 && m.ollama.keepAlive === '5m');
check('defaults: comfyUrl', m.comfyUrl === 'http://127.0.0.1:8188');
check('defaults: control room 4777 on 127.0.0.1', m.controlRoom.port === 4777 && m.controlRoom.bind === '127.0.0.1');
check('defaults: ollamaHost', machine.ollamaHost(m) === '127.0.0.1:11434');

// 2. override merge (partial nested override keeps sibling defaults)
m = machine.load(tempHome(JSON.stringify({ name: 'bld-3090', ollama: { numParallel: 2, contextLength: 32768 }, gpu: { vramGB: 24, llmSlots: 2 }, gitBash: 'D:\\git\\bash.exe' })));
check('merge: overridden values', m.name === 'bld-3090' && m.ollama.numParallel === 2 && m.ollama.contextLength === 32768 && m.gpu.llmSlots === 2 && m.gpu.vramGB === 24);
check('merge: sibling defaults kept', m.ollama.url === 'http://127.0.0.1:11434' && m.ollama.keepAlive === '5m' && m.controlRoom.port === 4777);
check('merge: gitBash', m.gitBash === 'D:\\git\\bash.exe');
check('merge: does not mutate DEFAULTS', machine.DEFAULTS.ollama.numParallel === 4 && machine.DEFAULTS.name === '');
check('ollamaUrl strips trailing slash', machine.ollamaUrl(machine.load(tempHome(JSON.stringify({ ollama: { url: 'http://10.0.0.5:11435/' } })))) === 'http://10.0.0.5:11435');

// 3. bad JSON → defaults + warning
const warns = [];
const origWarn = console.warn;
console.warn = (...a) => warns.push(a.join(' '));
m = machine.load(tempHome('{ not json'));
const m2 = machine.load(tempHome('[1,2]'));
console.warn = origWarn;
check('bad JSON: falls back to defaults', m.ollama.numParallel === 4 && m.comfyUrl === 'http://127.0.0.1:8188');
check('bad JSON: warns', warns.length === 2 && /\[machine\] ignoring/.test(warns[0]));
check('non-object JSON: falls back to defaults', m2.controlRoom.port === 4777);

// 4. shipped example parses and has both profiles
const ex = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'studio', 'machine.example.json'), 'utf8')).profiles;
check('example: goldg-5090', ex['goldg-5090'].gpu.vramGB === 32 && ex['goldg-5090'].ollama.numParallel === 4 && ex['goldg-5090'].gpu.llmSlots === 3);
check('example: bld-3090', ex['bld-3090'].gpu.vramGB === 24 && ex['bld-3090'].ollama.numParallel === 2 && ex['bld-3090'].gpu.llmSlots === 2 && ex['bld-3090'].ollama.contextLength === 32768);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
