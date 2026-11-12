#!/usr/bin/env node
// Tests for bench.js provider routing: --providers flag, provider registry, chatFn abstractions.
// Does NOT actually call external APIs — uses mocks and the test harness.
const assert = require('assert').strict;
const fs = require('fs');
const path = require('path');
const os = require('os');

// Load bench module (does NOT run CLI because process.argv[2] !== 'run')
const bench = require('./bench.js');

let fails = 0;
const check = (ok, name) => { console.log(`  ${ok ? '✓' : '✗'} ${name}`); if (!ok) fails++; };

async function main() {
  // 1. Provider registry shape
  check(bench.PROVIDERS.codex && bench.PROVIDERS.codex.chatFn === bench.chatCodex, 'codex provider uses chatCodex');
  check(bench.PROVIDERS.sonnet && bench.PROVIDERS.sonnet.chatFn === bench.chatClaude, 'sonnet provider uses chatClaude (claude -p, no API key)');
  check(bench.PROVIDERS['sonnet-api'].chatFn === bench.chatAnthropic, 'sonnet-api provider uses chatAnthropic');
  check(bench.PROVIDERS['qwen3.6:27b'] && bench.PROVIDERS['qwen3.6:27b'].chatFn === bench.chatOllama, 'qwen3.6:27b uses chatOllama');
  check(typeof bench.PROVIDERS.codex.displayName === 'string', 'codex has displayName');
  check(typeof bench.PROVIDERS.sonnet.model === 'string', 'sonnet has model identifier');

  // 2. findCodex — when no codex on PATH
  {
    const orig = process.env.CODX_EXE;
    delete process.env.CODX_EXE;
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-test-'));
    const origPath = process.env.PATH || process.env.Path;
    process.env.PATH = empty; process.env.Path = empty;
    const r = bench.findCodex();
    check(r === null, 'findCodex returns null when not on PATH');
    process.env.PATH = origPath; process.env.Path = origPath;
    if (orig) process.env.CODX_EXE = orig;
  }

  // 3. findCodex — respects CODX_EXE env var
  {
    process.env.CODEX_EXE = '/tmp/fake-codex';
    const r = bench.findCodex();
    check(r === '/tmp/fake-codex', 'findCodex returns CODEX_EXE value');
    delete process.env.CODEX_EXE;
    process.env.CODX_EXE = '/tmp/legacy-codex';
    check(bench.findCodex() === '/tmp/legacy-codex', 'findCodex still accepts legacy CODX_EXE');
    delete process.env.CODX_EXE;
  }

  // 4. chatAnthropic throws when ANTHROPIC_API_KEY not set
  {
    const orig = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      await bench.chatAnthropic('claude-sonnet-4-20250514', [{ role: 'user', content: 'hi' }], []);
      check(false, 'chatAnthropic throws without key');
    } catch (e) {
      check(/ANTHROPIC_API_KEY/.test(e.message), 'chatAnthropic error mentions missing key');
    }
    if (orig) process.env.ANTHROPIC_API_KEY = orig;
  }

  // 5. chatCodex throws when binary not found
  {
    const orig = process.env.CODX_EXE;
    delete process.env.CODX_EXE;
    const origPath = process.env.PATH || process.env.Path;
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-test-'));
    process.env.PATH = empty; process.env.Path = empty;
    try {
      await bench.chatCodex('codex', [{ role: 'user', content: 'hi' }], []);
      check(false, 'chatCodex throws when binary missing');
    } catch (e) {
      check(/not found/.test(e.message), 'chatCodex error mentions missing binary');
    }
    process.env.PATH = origPath; process.env.Path = origPath;
    if (orig) process.env.CODX_EXE = orig;
  }

  // 6. check() with test-based validation (happy path)
  {
    const goodTask = {
      check: { type: 'tests', tests: `import { test } from 'node:test'; import assert from 'node:assert/strict';\nimport { f } from './solution.mjs';\ntest('add', () => assert.equal(f(2, 3), 5));` },
    };
    const goodCode = 'export function f(a, b) { return a + b; }';
    const r = bench.check(goodTask, '```js\n' + goodCode + '\n```', []);
    check(r.auto === 1, 'check tests: known-good code passes');

    const badCode = 'export function f(a, b) { return a; }';
    const r2 = bench.check(goodTask, '```js\n' + badCode + '\n```', []);
    check(r2.auto === 0, 'check tests: wrong code fails');
    check(typeof r2.notes === 'string' && r2.notes.length > 0, 'check tests: failure includes notes');
  }

  // 7. check() with contains type
  {
    const containsTask = { check: { type: 'contains', all: ['module', 'export'] } };
    check(bench.check(containsTask, 'This is a module that exports something', []).auto === 1, 'check contains: all keywords found');
    check(bench.check(containsTask, 'nope', []).auto === 0, 'check contains: missing keywords');
  }

  // 8. check() with number type
  {
    const numTask = { check: { type: 'number', value: 42, tolerance: 1 } };
    check(bench.check(numTask, 'the answer is 42', []).auto === 1, 'check number: value found');
    check(bench.check(numTask, 'the answer is 10', []).auto === 0, 'check number: value not found');
  }

  // 9. check() with no check type → needs judge
  {
    check(bench.check({}, 'anything', []).auto === null, 'check without type → null (needs judge)');
  }

  // 10. runTask with a mock provider (no external API calls)
  {
    const mockProvider = {
      model: 'mock',
      chatFn: async (_m, msgs, _tools) => {
        check(msgs.some((x) => x.role === 'user'), 'runTask passes user messages to chatFn');
        return { msg: { content: 'mocked response' }, secs: 0.1, tps: 10, outTokens: 5 };
      },
    };
    const res = await bench.runTask(mockProvider, { system: 'be nice', prompt: 'hello' });
    check(res.out === 'mocked response', 'runTask returns mocked output');
    check(res.secs === 0.1, 'runTask returns timing');
    check(res.outTokens === 5, 'runTask returns token count');
    check(res.tps === 10, 'runTask returns tokens/sec');
  }

  // 11. runTask with tool-use provider (mocked)
  {
    const toolResults = { readFile: { '/x.txt': 'content' } };
    let callCount = 0;
    const toolProvider = {
      model: 'mock-tools',
      chatFn: async (_m, msgs, _tools) => {
        callCount++;
        if (callCount === 1) {
          return {
            msg: {
              content: 'reading file',
              tool_calls: [{ function: { name: 'readFile', arguments: { path: '/x.txt' } } }],
            },
            secs: 0.05, tps: 8, outTokens: 3,
          };
        }
        // second call: final answer, no tools
        return { msg: { content: 'file content is: content' }, secs: 0.05, tps: 12, outTokens: 4 };
      },
    };
    const res = await bench.runTask(toolProvider, { prompt: 'read /x.txt', toolResults, tools: [{ name: 'readFile' }] });
    check(callCount === 2, 'tool-use: two calls (tool then answer)');
    check(res.out === 'file content is: content', 'tool-use: final output from second call');
    check(res.calls.length === 1, 'tool-use: one tool call recorded');
    check(res.calls[0].function.name === 'readFile', 'tool-use: tool name correct');
  }

  // 11b. chatClaude throws when binary missing
  {
    const orig = process.env.CLAUDE_EXE, origPath = process.env.PATH || process.env.Path, origLocal = process.env.LOCALAPPDATA;
    delete process.env.CLAUDE_EXE;
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-test-'));
    process.env.PATH = empty; process.env.Path = empty; process.env.LOCALAPPDATA = empty;
    try {
      await bench.chatClaude('sonnet', [{ role: 'user', content: 'hi' }], []);
      check(false, 'chatClaude throws when binary missing');
    } catch (e) {
      check(/not found/.test(e.message), 'chatClaude error mentions missing binary');
    }
    process.env.PATH = origPath; process.env.Path = origPath;
    if (origLocal === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = origLocal;
    if (orig) process.env.CLAUDE_EXE = orig;
    fs.rmSync(empty, { recursive: true, force: true });
  }

  // 12. chatOllama basic shape (skip if Ollama busy — evals test this for real)
  // Omitted: real Ollama calls are flaky in CI and tested by the actual eval runs.
}

main().then(() => {
  console.log(fails ? `\n${fails} FAILED` : '\nall provider tests passed');
  process.exit(fails ? 1 : 0);
}).catch((e) => {
  console.error('test harness error:', e);
  process.exit(1);
});
