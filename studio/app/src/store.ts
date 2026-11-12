// Live studio state: fetches /api/state, then applies SSE pushes. Derives per-agent status.
import { useEffect, useMemo, useState } from 'react';
import { api, type StudioEvent, type StudioState, type Status } from './api';

export interface AgentLive { status: Status; pct: number; task: string; lastTool?: string; since?: number;
  /** Model the agent's current (or last) engine stage runs on, e.g. 'qwen3.6:27b'. */
  model?: string; tier?: string; cloud?: boolean;
  /** Who runs the model: the local GPU, Claude (Anthropic) or ChatGPT (OpenAI Codex). */
  provider?: Provider; }

export type Provider = 'local' | 'claude' | 'chatgpt';
export const PROVIDER_LABEL: Record<Provider, string> = { local: 'local GPU', claude: 'Claude', chatgpt: 'ChatGPT' };
/** Provider for a model/tier: Codex tier or gpt-* models are ChatGPT; other cloud models are Claude; the rest is local. */
export function providerOf(model?: string, tier?: string, cloud?: boolean): Provider {
  if (tier === 'codex' || /^(gpt|codex|o\d)/i.test(model || '')) return 'chatgpt';
  if (cloud || /^(opus|sonnet|haiku|claude)/i.test(model || '')) return 'claude';
  return 'local';
}

const TIER_MODEL: Record<string, string> = { local: 'qwen3.6:27b', 'local-fast': 'qwen3-coder:30b', sonnet: 'sonnet', opus: 'opus', codex: 'codex' };
/** Model for a start event: explicit fields (engine ≥ 2026-11-11), else the "[tier" tag in the task text. */
export function modelOf(e: StudioEvent): { model?: string; tier?: string; cloud?: boolean; provider?: Provider } {
  const tier = e.tier || (/\[(local-fast|local|sonnet|opus|codex)\b/.exec(e.task || '') || [])[1];
  const model = e.model || (tier ? TIER_MODEL[tier] : undefined);
  if (!model) return {};
  const cloud = e.cloud ?? !(tier === 'local' || tier === 'local-fast');
  return { model, tier, cloud, provider: providerOf(model, tier, cloud) };
}

export function useStudio() {
  const [state, setState] = useState<StudioState | null>(null);
  const [online, setOnline] = useState(false);

  useEffect(() => {
    let es: EventSource | null = null, stop = false;
    const refetch = () => api.state().then((s) => { if (!stop) { setState(s); setOnline(true); } }).catch(() => setOnline(false));
    refetch();
    const connect = () => {
      es = new EventSource('/api/stream');
      es.onopen = () => setOnline(true);
      es.onerror = () => { setOnline(false); es?.close(); if (!stop) setTimeout(() => { refetch(); connect(); }, 2000); };
      es.onmessage = (m) => {
        const msg = JSON.parse(m.data);
        if (msg.kind === 'refresh') refetch();
        if (msg.kind === 'event') setState((s) => (s ? { ...s, events: [...s.events.slice(-499), msg.event as StudioEvent] } : s));
      };
    };
    connect();
    return () => { stop = true; es?.close(); };
  }, []);

  const live = useMemo(() => deriveLive(state?.events || []), [state?.events]);
  return { state, online, live, refetch: () => api.state().then(setState) };
}

export function deriveLive(events: StudioEvent[]): Record<string, AgentLive> {
  const s: Record<string, AgentLive> = {};
  const get = (id: string) => (s[id] ||= { status: 'idle', pct: 0, task: '' });
  for (const e of events) {
    if (!e.agent) continue;
    const a = get(e.agent);
    switch (e.type) {
      case 'start': Object.assign(a, { status: 'working', pct: 5, task: e.task || '', since: e.ts, lastTool: undefined, model: undefined, tier: undefined, cloud: undefined, provider: undefined }, modelOf(e)); break;
      case 'tool': a.status = 'working'; a.lastTool = `${e.tool} ${e.detail || ''}`.trim(); a.pct = Math.min(90, a.pct + 3); break;
      case 'progress': a.pct = e.pct ?? a.pct; a.status = e.status || 'working'; if (e.message) a.task = e.message; break;
      case 'done': if (a.status !== 'blocked' && a.status !== 'paused') { a.status = 'done'; a.pct = 100; } break;
      case 'checkpoint': a.status = 'paused'; a.task = 'Stopped: ' + (e.message || ''); break;
      case 'resumed-agent': a.status = 'working'; a.task = 'Resuming from checkpoint'; break;
    }
  }
  return s;
}
