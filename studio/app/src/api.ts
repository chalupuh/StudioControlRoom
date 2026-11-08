// ============================================================================
// Control Room v2 · API CONTRACT (shared by server + UI). Change only by agreement.
// Server: .studio/studio.js (port 4777). UI: this Vite app, built to .studio/app-dist.
// ============================================================================

export type Status = 'idle' | 'working' | 'done' | 'blocked' | 'paused';
export type Team = 'owner' | 'eng' | 'rd' | 'creative';

/** One line of .studio/events.jsonl. `type` decides which other fields exist. */
export interface StudioEvent {
  ts: number;
  type: 'start' | 'done' | 'progress' | 'tool' | 'checkpoint' | 'paused' | 'resumed' | 'resumed-agent' | 'gate' | 'usage';
  agent: string;            // agent id, e.g. 'mobile-dev', 'manager', 'owner'
  task?: string; message?: string; next?: string;
  pct?: number; status?: Status;
  tool?: string; detail?: string;
  run?: string;             // engine run id (gate events)
  // usage events (engine): one per stage attempt
  tier?: 'local' | 'local-fast' | 'sonnet' | 'opus'; model?: string; cloud?: boolean;
  tokensIn?: number; tokensOut?: number; secs?: number;
  runId?: string; pipeline?: string; project?: string; stage?: string; stageTier?: string; ok?: boolean;
}

/** .studio/roster.json: the cast. Portrait paths are served from /portraits/<file>. */
export interface Character {
  name: string; title: string; team: Team; color: string;   // hex accent
  bio: string; quote?: string; portrait?: string;            // e.g. '/portraits/kaito.png'
  parent?: string;                                            // agent id of the manager it reports to
}
export interface Roster { agents: Record<string, Character>; }

export interface Control {
  state: 'running' | 'paused';                               // global switch
  teams?: Partial<Record<Exclude<Team, 'owner'>, 'running' | 'paused'>>; // per-team switches
  since: number; by?: string;
}
export interface Checkpoint { agent: string; ts: number; text: string; }
export interface ModelInfo { brain?: string; local?: { name: string; role?: string; kind: string; ref: string; installed: boolean }[]; }

export type GateDecision = 'approve' | 'park' | 'reject';
/** One decidable item of a gate (parsed from the gate's items.file by items.regex). */
export interface GateItem { id: string; text: string; decision?: GateDecision; }

/** Engine run (.studio/runs/<id>.json), trimmed for the UI. 'parked' = gate parked by the owner; resume re-opens it. */
export interface RunSummary {
  id: string; pipeline: string; status: 'running' | 'waiting-gate' | 'parked' | 'blocked' | 'paused' | 'done' | 'stopped';
  vars: Record<string, string>; created: string; updated: string;
  stages: { id: string; type: string; agent?: string; tier?: string; state: 'pending' | 'current' | 'done' }[];
  gate?: { id: string; title: string; show: string[]; since: string; items?: GateItem[] };   // present when waiting; items when the gate declares them
  blockedReason?: string;
  attempts: { stage: string; agent?: string; tier?: string; ok: boolean; secs?: number; problems?: string[]; at: string }[];
}

export interface Usage {
  budget: { dailyCloudTokens: number };                      // .studio/budget.json
  today: { cloudTokens: number; localTokens: number; cloudCalls: number; localCalls: number };
  byAgent: Record<string, { cloudTokens: number; localTokens: number; calls: number; secs: number;
    localStages: number; fallbackStages: number; fallbackRate: number; fallbackAlert: boolean }>;   // fallback over 30 days; alert > 25% (ADR 0001)
  byProject: Record<string, { cloudTokens: number; localTokens: number; calls: number; secs: number }>;
  byDay: { day: string; cloudTokens: number; localTokens: number }[];   // last 14 days
}

export interface Gpu {
  gpus: { name: string; memUsedMB: number; memTotalMB: number; utilPct: number; tempC: number }[];
  ollama: { name: string; vramMB: number; until?: string }[];  // models loaded right now
  comfy: { up: boolean; queueRunning: number; queuePending: number };
}

/** GET /api/state: one snapshot of everything. */
export interface StudioState {
  events: StudioEvent[];            // last 500
  control: Control;
  checkpoints: Checkpoint[];
  models: Record<string, ModelInfo>;
  roster: Roster;
  runs: RunSummary[];               // newest first
}

// ---- Endpoints ----
// GET  /api/state                 -> StudioState
// GET  /api/stream                (SSE) data: {"kind":"event","event":StudioEvent} | {"kind":"refresh"}
//                                 'refresh' = control/runs/checkpoints/roster changed -> refetch /api/state
// GET  /api/usage                 -> Usage
// GET  /api/gpu                   -> Gpu            (poll every 3 s while visible)
// POST /api/control               {action:'pause'|'resume', team?:'eng'|'rd'|'creative'} -> Control
// POST /api/gates/:runId          {decision:'approve'|'park'|'reject', items?:Record<itemId,GateDecision>, note?:string} -> {ok:true} (engine continues in background)
//                                 with items, decision is optional and the outcome is derived (any approve -> approve, else any park -> park, else reject)
// POST /api/runs/:runId/resume    -> {ok:true}
// GET  /api/file?path=<repo-relative .md>  -> text/plain (only docs/**, .studio/checkpoints/** ; for gate review)
// GET  /portraits/<file>          -> image
// GET  /v1                        -> legacy dashboard.html

export const api = {
  state: (): Promise<StudioState> => fetch('/api/state').then((r) => r.json()),
  usage: (): Promise<Usage> => fetch('/api/usage').then((r) => r.json()),
  gpu: (): Promise<Gpu> => fetch('/api/gpu').then((r) => r.json()),
  file: (p: string): Promise<string> => fetch('/api/file?path=' + encodeURIComponent(p)).then((r) => r.text()),
  control: (action: 'pause' | 'resume', team?: string): Promise<Control> =>
    fetch('/api/control', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, team }) }).then((r) => r.json()),
  gate: (runId: string, decision: GateDecision | undefined, note = '', items?: Record<string, GateDecision>) =>
    fetch('/api/gates/' + encodeURIComponent(runId), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision, note, items }) }).then((r) => r.json()),
  resume: (runId: string) => fetch('/api/runs/' + encodeURIComponent(runId) + '/resume', { method: 'POST' }).then((r) => r.json()),
};
