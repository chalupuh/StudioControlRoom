// Pure logic for the Team view: org layout, stats, formatting. No React here.
import type { Character, Roster, StudioEvent, Team } from '../../api';

export type DeptTeam = Exclude<Team, 'owner'>;
export interface Dept { team: DeptTeam; headId: string; label: string; members: string[]; }

const DEFAULT_HEADS: Record<DeptTeam, { id: string; label: string }> = {
  eng: { id: 'manager', label: 'Engineering' },
  rd: { id: 'rd-manager', label: 'R&D' },
  creative: { id: 'creative-director', label: 'Creative' },
};
const DEFAULT_MEMBERS: Record<DeptTeam, string[]> = {
  eng: ['product-manager', 'architect', 'ui-ux-designer', 'frontend-dev', 'backend-dev', 'mobile-dev', 'devops-engineer', 'qa-engineer', 'code-reviewer'],
  rd: ['market-researcher', 'opportunity-analyst'],
  creative: ['image-artist', 'video-producer', 'copy-voice'],
};
export const TEAM_ORDER: DeptTeam[] = ['eng', 'rd', 'creative'];

/** Build departments. Roster team/parent win over the default; roster-only agents join their team. */
export function buildOrg(roster: Roster | undefined): Dept[] {
  const agents = roster?.agents ?? {};
  return TEAM_ORDER.map((team) => {
    const headId = DEFAULT_HEADS[team].id;
    const members: string[] = [];
    const add = (id: string) => { if (id !== headId && !members.includes(id)) members.push(id); };
    for (const id of DEFAULT_MEMBERS[team]) {
      const c = agents[id];
      // honour a roster override that moves a default member elsewhere
      if (c && c.team !== team && c.team !== 'owner') continue;
      add(id);
    }
    for (const [id, c] of Object.entries(agents)) {
      if (id === 'owner' || id === headId || DEFAULT_HEADS.eng.id === id || DEFAULT_HEADS.rd.id === id || DEFAULT_HEADS.creative.id === id) continue;
      if (c.team === team || c.parent === headId) add(id);
    }
    return { team, headId, label: DEFAULT_HEADS[team].label, members };
  });
}

export function teamOf(id: string, depts: Dept[]): DeptTeam | 'owner' | undefined {
  if (id === 'owner') return 'owner';
  return depts.find((d) => d.headId === id || d.members.includes(id))?.team;
}

export const TEAM_VAR: Record<Team, string> = { eng: 'var(--eng)', rd: 'var(--rd)', creative: 'var(--creative)', owner: 'var(--owner)' };
export const TEAM_LABEL: Record<Team, string> = { eng: 'Engineering', rd: 'R&D', creative: 'Creative', owner: 'Owner' };

export function prettyId(id: string): string {
  return id.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}
export function displayName(id: string, c?: Character): string { return c?.name || prettyId(id); }
export function initials(name: string): string {
  const parts = name.trim().split(/[\s-]+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts.length === 1 ? parts[0].slice(0, 2) : parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function relTime(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return s + 's ago';
  const m = Math.round(s / 60);
  if (m < 60) return m + 'm ago';
  const h = Math.round(m / 60);
  if (h < 24) return h + 'h ago';
  return Math.round(h / 24) + 'd ago';
}

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(n >= 10_000 ? 0 : 1) + 'k';
  return String(n);
}

export interface AgentStats { started: number; done: number; blocked: number; cloudTokens: number; localTokens: number; }
export function agentStats(events: StudioEvent[], agent: string): AgentStats {
  const s: AgentStats = { started: 0, done: 0, blocked: 0, cloudTokens: 0, localTokens: 0 };
  for (const e of events) {
    if (e.agent !== agent) continue;
    if (e.type === 'start') s.started++;
    else if (e.type === 'done') s.done++;
    else if (e.type === 'progress' && e.status === 'blocked') s.blocked++;
    else if (e.type === 'usage') {
      const t = (e.tokensIn ?? 0) + (e.tokensOut ?? 0);
      if (e.cloud) s.cloudTokens += t; else s.localTokens += t;
    }
  }
  return s;
}

/** Last `n` events of an agent, newest first. */
export function recentEvents(events: StudioEvent[], agent: string, n = 20): StudioEvent[] {
  const out: StudioEvent[] = [];
  for (let i = events.length - 1; i >= 0 && out.length < n; i--) if (events[i].agent === agent) out.push(events[i]);
  return out;
}

/** Meaningful events for the work trail (no 'tool'/'usage'), newest first. */
export function trailEvents(events: StudioEvent[], n = 60): StudioEvent[] {
  const out: StudioEvent[] = [];
  for (let i = events.length - 1; i >= 0 && out.length < n; i--) {
    const t = events[i].type;
    if (t !== 'tool' && t !== 'usage') out.push(events[i]);
  }
  return out;
}

export function describeEvent(e: StudioEvent): string {
  switch (e.type) {
    case 'start': return 'Started: ' + (e.task || 'a task');
    case 'done': return 'Finished' + (e.message || e.task ? ': ' + (e.message || e.task) : '');
    case 'progress': return (e.status === 'blocked' ? 'Blocked: ' : '') + (e.message || (e.pct != null ? e.pct + '%' : 'progress'));
    case 'checkpoint': return 'Checkpoint: ' + (e.message || 'saved');
    case 'paused': return 'Paused';
    case 'resumed': return 'Resumed';
    case 'resumed-agent': return 'Resumed from checkpoint';
    case 'gate': return 'Gate: ' + (e.message || e.task || 'needs owner review');
    case 'tool': return (e.tool || 'tool') + (e.detail ? ' ' + e.detail : '');
    case 'usage': return `Usage ${e.model || e.tier || ''}`.trim();
  }
}

export const STATUS_VAR: Record<string, string> = {
  idle: 'var(--idle)', working: 'var(--working)', done: 'var(--done)', blocked: 'var(--blocked)', paused: 'var(--paused)',
};

export interface Packet { id: string; agent: string; dir: 'down' | 'up'; }
/** Packets for events newer than `since` (page load): start = head->member, done = member->head. */
export function packetFor(e: StudioEvent, since: number): Packet | null {
  if (e.ts <= since) return null;
  if (e.type === 'start') return { id: `${e.ts}-${e.agent}-s`, agent: e.agent, dir: 'down' };
  if (e.type === 'done') return { id: `${e.ts}-${e.agent}-d`, agent: e.agent, dir: 'up' };
  return null;
}
