// Village layout and walking model. No React.
import type { StudioEvent, Roster, Character } from '../../api';
import type { DeptTeam, Dept } from '../org/model';
import { buildOrg, TEAM_VAR } from '../org/model';

export const VW = 800;
export const VH = 600;

export interface Pt { x: number; y: number; }
export interface Building { id: string; x: number; y: number; w: number; h: number; label: string; team?: DeptTeam; }

export const HQ: Building = { id: 'hq', x: 400, y: 100, w: 120, h: 80, label: 'HQ' };
export const ENG_BLDG: Building = { id: 'eng', x: 180, y: 420, w: 110, h: 75, label: 'Engineering', team: 'eng' };
export const RD_BLDG: Building = { id: 'rd', x: 400, y: 450, w: 110, h: 75, label: 'R&D', team: 'rd' };
export const CRE_BLDG: Building = { id: 'creative', x: 620, y: 420, w: 110, h: 75, label: 'Creative', team: 'creative' };
export const ALL_BLDGS: Building[] = [HQ, ENG_BLDG, RD_BLDG, CRE_BLDG];

const IDLE_SPREAD = 28;

export function buildingForTeam(team: DeptTeam): Building {
  switch (team) {
    case 'eng': return ENG_BLDG;
    case 'rd': return RD_BLDG;
    case 'creative': return CRE_BLDG;
  }
}

/** HQ door: where every path starts. */
export function hqDoor(): Pt { return { x: HQ.x, y: HQ.y + HQ.h / 2 }; }

/** Drawn path (polyline) from the HQ door to a department building's front. */
export function pathPoints(b: Building): Pt[] {
  const door = hqDoor();
  const top = b.y - b.h / 2;
  const midY = door.y + (top - door.y) / 2;
  return [door, { x: door.x, y: midY }, { x: b.x, y: midY }, { x: b.x, y: top }];
}

export interface VillagePath { id: string; building: Building; points: Pt[]; color: string; }
export const PATHS: VillagePath[] = [ENG_BLDG, RD_BLDG, CRE_BLDG].map((b) => ({
  id: `p-${b.id}`, building: b, points: pathPoints(b), color: TEAM_VAR[b.team as DeptTeam],
}));

function deptOf(id: string, depts: Dept[]): Dept | undefined {
  return depts.find((d) => d.headId === id || d.members.includes(id));
}

/** Idle (home) position. Owner and manager sit at HQ. */
export function homePos(id: string, depts: Dept[]): Pt {
  const door = hqDoor();
  if (id === 'owner') return { x: door.x - 20, y: door.y };
  if (id === 'manager') return { x: door.x + 20, y: door.y };
  const dept = deptOf(id, depts);
  if (!dept) return { x: 400, y: 300 };
  const bldg = buildingForTeam(dept.team);
  const y = bldg.y - bldg.h / 2 - 16;
  if (dept.headId === id) return { x: bldg.x, y };
  const idx = dept.members.indexOf(id);
  const offset = (idx - (dept.members.length - 1) / 2) * IDLE_SPREAD;
  return { x: bldg.x + offset, y };
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

/** Spot at the HQ where an agent waits after a 'done' walk (spread so tokens do not stack). */
export function hqSlot(id: string): Pt {
  const h = hash(id);
  const door = hqDoor();
  return { x: door.x + ((h % 9) - 4) * 14, y: door.y + 22 + (Math.floor(h / 9) % 2) * 20 };
}

export function truncate(s: string, max: number): string {
  if (!s) return '';
  return s.length > max ? s.slice(0, max) + '…' : s;
}

// ---- Events → walks ----
export type WalkDir = 'to-hq' | 'to-home';

/** Stable identity of an event; each is processed exactly once. */
export function eventKey(e: StudioEvent): string { return `${e.ts}|${e.agent}|${e.type}`; }

/** 'done' walks to HQ, 'start' walks back home. Others (and the owner) do not walk. */
export function walkDir(e: StudioEvent): WalkDir | null {
  if (e.agent === 'owner') return null;
  if (e.type === 'done') return 'to-hq';
  if (e.type === 'start') return 'to-home';
  return null;
}

/** Route (polyline) for a walk, starting at the agent's current position and following the drawn paths. */
export function routeFor(id: string, dir: WalkDir, cur: Pt, depts: Dept[]): Pt[] {
  const dept = deptOf(id, depts);
  const path = dept && id !== 'manager' ? pathPoints(buildingForTeam(dept.team)) : [];
  if (dir === 'to-hq') return [cur, ...[...path].reverse(), hqSlot(id)];
  return [cur, hqDoor(), ...path, homePos(id, depts)];
}

/** Per-agent position state. `route` is the polyline from `from` to `to`. */
export interface AgentPos { from: Pt; to: Pt; route: Pt[]; startedAt: number; duration: number; }

const SPEED = 0.16; // px per ms
export const MIN_WALK_MS = 500;

export function polyLength(pts: Pt[]): number {
  let n = 0;
  for (let i = 1; i < pts.length; i++) n += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  return n;
}

/** Point at fraction f (0..1) of the polyline's total length. */
export function pointOnPolyline(pts: Pt[], f: number): Pt {
  if (pts.length === 0) return { x: 0, y: 0 };
  if (f <= 0 || pts.length === 1) return pts[0];
  if (f >= 1) return pts[pts.length - 1];
  let target = polyLength(pts) * f;
  for (let i = 1; i < pts.length; i++) {
    const seg = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    if (target <= seg && seg > 0) {
      const k = target / seg;
      return { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * k, y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * k };
    }
    target -= seg;
  }
  return pts[pts.length - 1];
}

export function startWalk(route: Pt[], now: number, reduced: boolean): AgentPos {
  const duration = reduced ? 0 : Math.max(MIN_WALK_MS, polyLength(route) / SPEED);
  return { from: route[0], to: route[route.length - 1], route, startedAt: now, duration };
}

export function isWalking(p: AgentPos, now: number): boolean { return now - p.startedAt < p.duration; }

/** Where the agent is at `now`: along the route while walking, otherwise parked at the destination. */
export function posAt(p: AgentPos, now: number): Pt {
  if (!isWalking(p, now)) return p.to;
  return pointOnPolyline(p.route, (now - p.startedAt) / p.duration);
}

export function allAgentIds(roster?: Roster): string[] {
  const depts = buildOrg(roster);
  const ids = new Set<string>(['owner', 'manager']);
  for (const d of depts) { ids.add(d.headId); for (const m of d.members) ids.add(m); }
  return [...ids];
}

export function charOf(roster: Roster | undefined, id: string): Character | undefined {
  return roster?.agents?.[id];
}
