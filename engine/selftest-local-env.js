#!/usr/bin/env node
// Local (Ollama) tier env, 2026-11-09: Claude Code must be told the model's real context window so it
// auto-compacts before Ollama truncates the prompt (which surfaced as "exceeded the 32000 output token maximum").
const fs = require('fs'), os = require('os'), path = require('path');
process.env.STUDIO_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-localenv-'));
const { localTierEnv } = require('./engine.js');

let fails = 0;
const check = (ok, name) => { console.log(`  ${ok ? '✓' : '✗'} ${name}`); if (!ok) fails++; };
const tier = { model: 'qwen3.6:27b', local: true };

console.log('localTierEnv');
{
  const e = localTierEnv(tier, {});
  check(e.CLAUDE_CODE_MAX_CONTEXT_TOKENS === '32768', 'no machine.json → 32768 window (Ollama default here)');
  check(e.CLAUDE_CODE_MAX_OUTPUT_TOKENS === '8192', 'output cap 8192 leaves room in a 32k window');
  check(e.ANTHROPIC_BASE_URL === 'http://127.0.0.1:11434', 'default Ollama URL');
  check(e.ANTHROPIC_MODEL === 'qwen3.6:27b' && e.ANTHROPIC_DEFAULT_SONNET_MODEL === 'qwen3.6:27b', 'model routed to the tier model');
  check(e.ANTHROPIC_API_KEY === '', 'no cloud API key leaks into local runs');
}
{
  const e = localTierEnv(tier, { ollama: { contextLength: 98304, url: 'http://192.168.1.117:11434' } });
  check(e.CLAUDE_CODE_MAX_CONTEXT_TOKENS === '98304', 'machine.json contextLength is used');
  check(e.CLAUDE_CODE_MAX_OUTPUT_TOKENS === '8192', 'output cap stays 8192 on a big window');
  check(e.ANTHROPIC_BASE_URL === 'http://192.168.1.117:11434', 'machine.json ollama.url is used');
}
{
  const e = localTierEnv(tier, { ollama: { contextLength: null } });
  check(e.CLAUDE_CODE_MAX_CONTEXT_TOKENS === '32768', 'contextLength null → default');
  const s = localTierEnv(tier, { ollama: { contextLength: 16384 } });
  check(s.CLAUDE_CODE_MAX_OUTPUT_TOKENS === '4096', 'small window → output cap is a quarter of it');
  const m = localTierEnv(tier, { ollama: { contextLength: 65536, maxOutputTokens: 12000 } });
  check(m.CLAUDE_CODE_MAX_OUTPUT_TOKENS === '12000', 'explicit maxOutputTokens wins');
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
