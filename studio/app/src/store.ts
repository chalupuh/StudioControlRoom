// Live studio state: fetches /api/state, then applies SSE pushes. Derives per-agent status.
import { useEffect, useMemo, useState } from 'react';
import { api, type StudioEvent, type StudioState, type Status } from './api';

export interface AgentLive { status: Status; pct: number; task: string; lastTool?: string; since?: number; }

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
      case 'start': Object.assign(a, { status: 'working', pct: 5, task: e.task || '', since: e.ts, lastTool: undefined }); break;
      case 'tool': a.status = 'working'; a.lastTool = `${e.tool} ${e.detail || ''}`.trim(); a.pct = Math.min(90, a.pct + 3); break;
      case 'progress': a.pct = e.pct ?? a.pct; a.status = e.status || 'working'; if (e.message) a.task = e.message; break;
      case 'done': if (a.status !== 'blocked' && a.status !== 'paused') { a.status = 'done'; a.pct = 100; } break;
      case 'checkpoint': a.status = 'paused'; a.task = 'Stopped: ' + (e.message || ''); break;
      case 'resumed-agent': a.status = 'working'; a.task = 'Resuming from checkpoint'; break;
    }
  }
  return s;
}
