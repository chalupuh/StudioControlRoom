// Usage reducer for /api/usage: events in, per-provider / per-agent / per-day totals out. Pure, so it is unit-tested.
// Codex (openai) tokens never count toward the Claude daily budget (today.* and byDay[].cloudTokens);
// limited events count as attempts, not calls.
const dayKey = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
function usageFromEvents(events, now) {
  const today = { cloudTokens: 0, localTokens: 0, cloudCalls: 0, localCalls: 0 };
  const byAgent = {};
  const byProvider = {};
  const days = {};
  const todayKey = dayKey(now);
  for (let i = 13; i >= 0; i--) { const k = dayKey(now - i * 86400000); days[k] = { day: k, cloudTokens: 0, localTokens: 0 }; }
  for (const e of events) {
    if (e.type !== 'usage') continue;
    const tok = (Number(e.tokensIn) || 0) + (Number(e.tokensOut) || 0);
    const k = dayKey(e.ts), cloud = !!e.cloud;
    // Events from before the provider field: infer from tier/cloud.
    const prov = ['ollama', 'anthropic', 'openai'].includes(e.provider) ? e.provider : e.tier === 'codex' ? 'openai' : cloud ? 'anthropic' : 'ollama';
    const p = (byProvider[prov] = byProvider[prov] || { runs: 0, tokens: 0, attempts: 0, limited: 0 });
    p.attempts++; p.tokens += tok;
    if (e.limited) p.limited++; else p.runs++;
    const a = (byAgent[e.agent] = byAgent[e.agent] || { cloudTokens: 0, localTokens: 0, calls: 0, secs: 0 });
    a[cloud ? 'cloudTokens' : 'localTokens'] += tok; a.secs += Number(e.secs) || 0;
    // S5: limited events don't count as calls (they are skipped, not executed)
    if (!e.limited) a.calls++;
    // byDay cloud tokens only count Anthropic (the daily budget is for Claude API)
    if (days[k]) {
      if (prov === 'anthropic') { days[k].cloudTokens += tok; }
      else if (!cloud) { days[k].localTokens += tok; }
      // codex (openai) tokens are tracked in byProvider but not in byDay cloud budget
    }
    // today cloud budget and cloud calls only count Anthropic
    if (k === todayKey) {
      if (prov === 'anthropic' && !e.limited) { today.cloudTokens += tok; today.cloudCalls++; }
      else if (!cloud && !e.limited) { today.localTokens += tok; today.localCalls++; }
    }
  }
  return { today, byAgent, byProvider, byDay: Object.values(days) };
}


module.exports = { usageFromEvents, dayKey };
