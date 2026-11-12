#!/usr/bin/env node
// usageFromEvents: provider split, Codex excluded from the Claude budget, limited events are attempts not calls.
const { usageFromEvents } = require('./usage');
let fails = 0;
const check = (ok, name) => { console.log(`  ${ok ? '✓' : '✗'} ${name}`); if (!ok) fails++; };
const now = new Date(2026, 10, 11, 12, 0, 0).getTime();
const ev = (o) => ({ type: 'usage', ts: now - 1000, tokensIn: 0, tokensOut: 0, secs: 1, ...o });
const u = usageFromEvents([
  ev({ agent: 'a', provider: 'ollama', cloud: false, tokensIn: 100, tokensOut: 50 }),
  ev({ agent: 'a', provider: 'anthropic', cloud: true, tokensIn: 1000, tokensOut: 500 }),
  ev({ agent: 'a', provider: 'openai', tier: 'codex', cloud: true, tokensIn: 7000, tokensOut: 3000 }),
  ev({ agent: 'a', provider: 'openai', tier: 'codex', cloud: true, limited: true }),
  ev({ agent: 'b', tier: 'codex', cloud: true, tokensIn: 10, tokensOut: 10 }), // legacy event without provider
  { type: 'progress', ts: now },
], now);
const today = u.byDay[u.byDay.length - 1];
check(u.today.cloudTokens === 1500 && u.today.cloudCalls === 1, 'today cloud = Anthropic only (Codex excluded)');
check(u.today.localTokens === 150 && u.today.localCalls === 1, 'today local counted');
check(today.cloudTokens === 1500 && today.localTokens === 150, 'byDay cloudTokens excludes Codex');
check(u.byProvider.openai.tokens === 10020 && u.byProvider.openai.attempts === 3 && u.byProvider.openai.runs === 2 && u.byProvider.openai.limited === 1, 'openai: tokens, attempts, runs, limited');
check(u.byProvider.anthropic.runs === 1 && u.byProvider.ollama.runs === 1, 'anthropic and ollama counted');
check(u.byAgent.a.calls === 3, 'limited event is an attempt, not a call');
check(u.byDay.length === 14, '14 days returned');
console.log(fails ? `\n${fails} FAILED` : '\nall usage tests passed');
process.exit(fails ? 1 : 0);
