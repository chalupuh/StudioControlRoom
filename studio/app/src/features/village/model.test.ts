import { describe, it, expect } from 'vitest';
import {
  HQ,
  ENG_BLDG,
  RD_BLDG,
  CRE_BLDG,
  ALL_BLDGS,
  PATHS,
  buildingForTeam,
  hqDoor,
  pathPoints,
  homePos,
  hqSlot,
  truncate,
  walkDir,
  eventKey,
  routeFor,
  polyLength,
  pointOnPolyline,
  startWalk,
  isWalking,
  posAt,
  allAgentIds,
  charOf,
  VW,
  VH,
  MIN_WALK_MS,
  type Pt,
} from './model';
import type { StudioEvent, Roster } from '../../api';
import type { Dept } from '../org/model';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MOCK_ROSTER: Roster = {
  agents: {
    owner: { name: 'Owner', title: 'CEO', team: 'owner', color: '#f00', bio: '' },
    manager: { name: 'Eng Manager', title: 'EM', team: 'eng', color: '#0f0', bio: '' },
    'frontend-dev': { name: 'Frontend', title: 'Dev', team: 'eng', color: '#0f0', bio: '' },
    'qa-engineer': { name: 'QA', title: 'QA', team: 'eng', color: '#0f0', bio: '' },
    'rd-manager': { name: 'R&D Mgr', title: 'R&D', team: 'rd', color: '#00f', bio: '' },
    'creative-director': { name: 'Creative', title: 'CD', team: 'creative', color: '#f0f', bio: '' },
  },
};

const DEPTS: Dept[] = [
  { team: 'eng', headId: 'manager', label: 'Engineering', members: ['frontend-dev', 'qa-engineer'] },
  { team: 'rd', headId: 'rd-manager', label: 'R&D', members: [] },
  { team: 'creative', headId: 'creative-director', label: 'Creative', members: [] },
];

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

describe('viewport dimensions', () => {
  it('has expected viewport size', () => {
    expect(VW).toBe(800);
    expect(VH).toBe(600);
  });
});

describe('building constants', () => {
  it('HQ has correct id and position', () => {
    expect(HQ.id).toBe('hq');
    expect(HQ.x).toBe(400);
    expect(HQ.y).toBe(100);
  });

  it('department buildings have correct ids and teams', () => {
    expect(ENG_BLDG.id).toBe('eng');
    expect(ENG_BLDG.team).toBe('eng');
    expect(RD_BLDG.id).toBe('rd');
    expect(RD_BLDG.team).toBe('rd');
    expect(CRE_BLDG.id).toBe('creative');
    expect(CRE_BLDG.team).toBe('creative');
  });

  it('ALL_BLDGS contains four buildings', () => {
    expect(ALL_BLDGS).toHaveLength(4);
  });

  it('PATHS has three entries (no path for HQ)', () => {
    expect(PATHS).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// buildingForTeam
// ---------------------------------------------------------------------------

describe('buildingForTeam', () => {
  it('returns ENG_BLDG for eng', () => {
    expect(buildingForTeam('eng').id).toBe('eng');
  });

  it('returns RD_BLDG for rd', () => {
    expect(buildingForTeam('rd').id).toBe('rd');
  });

  it('returns CRE_BLDG for creative', () => {
    expect(buildingForTeam('creative').id).toBe('creative');
  });
});

// ---------------------------------------------------------------------------
// hqDoor
// ---------------------------------------------------------------------------

describe('hqDoor', () => {
  it('returns the bottom-center of HQ', () => {
    const door = hqDoor();
    expect(door.x).toBe(HQ.x);
    expect(door.y).toBe(HQ.y + HQ.h / 2);
  });
});

// ---------------------------------------------------------------------------
// pathPoints
// ---------------------------------------------------------------------------

describe('pathPoints', () => {
  it('returns a polyline with four points', () => {
    const pts = pathPoints(ENG_BLDG);
    expect(pts).toHaveLength(4);
  });

  it('starts at the HQ door', () => {
    const door = hqDoor();
    const pts = pathPoints(ENG_BLDG);
    expect(pts[0]).toEqual(door);
  });

  it('ends at the building front (above centre)', () => {
    const pts = pathPoints(ENG_BLDG);
    const last = pts[pts.length - 1];
    expect(last.x).toBe(ENG_BLDG.x);
    expect(last.y).toBeLessThan(ENG_BLDG.y);
  });
});

// ---------------------------------------------------------------------------
// homePos
// ---------------------------------------------------------------------------

describe('homePos', () => {
  it('places owner left of HQ door', () => {
    const door = hqDoor();
    expect(homePos('owner', DEPTS).x).toBeLessThan(door.x);
  });

  it('places manager right of HQ door', () => {
    const door = hqDoor();
    expect(homePos('manager', DEPTS).x).toBeGreaterThan(door.x);
  });

  it('places eng members above eng building', () => {
    expect(homePos('qa-engineer', DEPTS).y).toBeLessThan(ENG_BLDG.y);
  });

  it('places unknown agents at fallback centre', () => {
    const pos = homePos('unknown-agent', DEPTS);
    expect(pos).toEqual({ x: 400, y: 300 });
  });
});

// ---------------------------------------------------------------------------
// hqSlot
// ---------------------------------------------------------------------------

describe('hqSlot', () => {
  it('gives different slots to different agents', () => {
    const slot1 = hqSlot('frontend-dev');
    const slot2 = hqSlot('qa-engineer');
    expect(slot1.x !== slot2.x || slot1.y !== slot2.y).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// truncate
// ---------------------------------------------------------------------------

describe('truncate', () => {
  it('returns the string unchanged when under the limit', () => {
    expect(truncate('hello', 10)).toBe('hello');
  });

  it('truncates with ellipsis when over the limit', () => {
    expect(truncate('a very long task name here', 10)).toBe('a very lon…');
  });

  it('returns empty string for empty input', () => {
    expect(truncate('', 5)).toBe('');
  });

  it('returns empty string for nullish input', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(truncate(undefined as any, 5)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// walkDir
// ---------------------------------------------------------------------------

describe('walkDir', () => {
  it('returns "to-hq" for done events', () => {
    expect(
      walkDir({ ts: 1, type: 'done', agent: 'qa-engineer' } as StudioEvent),
    ).toBe('to-hq');
  });

  it('returns "to-home" for start events', () => {
    expect(
      walkDir({ ts: 1, type: 'start', agent: 'qa-engineer' } as StudioEvent),
    ).toBe('to-home');
  });

  it('returns null for progress events', () => {
    expect(
      walkDir({ ts: 1, type: 'progress', agent: 'qa-engineer' } as StudioEvent),
    ).toBeNull();
  });

  it('returns null for the owner regardless of event type', () => {
    expect(
      walkDir({ ts: 1, type: 'done', agent: 'owner' } as StudioEvent),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// eventKey (event dedupe)
// ---------------------------------------------------------------------------

describe('eventKey', () => {
  it('produces different keys for different timestamps', () => {
    const e1: StudioEvent = { ts: 100, type: 'done', agent: 'qa' };
    const e2: StudioEvent = { ts: 200, type: 'done', agent: 'qa' };
    expect(eventKey(e1)).not.toBe(eventKey(e2));
  });

  it('produces different keys for different event types', () => {
    const e1: StudioEvent = { ts: 100, type: 'done', agent: 'qa' };
    const e3: StudioEvent = { ts: 100, type: 'start', agent: 'qa' };
    expect(eventKey(e1)).not.toBe(eventKey(e3));
  });

  it('produces different keys for different agents', () => {
    const e1: StudioEvent = { ts: 100, type: 'done', agent: 'qa' };
    const e4: StudioEvent = { ts: 100, type: 'done', agent: 'frontend' };
    expect(eventKey(e1)).not.toBe(eventKey(e4));
  });

  it('produces identical keys for identical events (dedupe guarantee)', () => {
    const e1: StudioEvent = { ts: 100, type: 'done', agent: 'qa' };
    const e2: StudioEvent = { ts: 100, type: 'done', agent: 'qa' };
    expect(eventKey(e1)).toBe(eventKey(e2));
  });
});

// ---------------------------------------------------------------------------
// routeFor
// ---------------------------------------------------------------------------

describe('routeFor', () => {
  it('has multiple points for a to-hq route', () => {
    const cur = homePos('qa-engineer', DEPTS);
    const route = routeFor('qa-engineer', 'to-hq', cur, DEPTS);
    expect(route.length).toBeGreaterThan(2);
  });

  it('starts at the agent current position', () => {
    const cur = homePos('qa-engineer', DEPTS);
    const route = routeFor('qa-engineer', 'to-hq', cur, DEPTS);
    expect(route[0].x).toBe(cur.x);
    expect(route[0].y).toBe(cur.y);
  });

  it('has multiple points for a to-home route', () => {
    const door = hqDoor();
    const route = routeFor('qa-engineer', 'to-home', door, DEPTS);
    expect(route.length).toBeGreaterThan(2);
  });
});

// ---------------------------------------------------------------------------
// polyLength
// ---------------------------------------------------------------------------

describe('polyLength', () => {
  it('returns 0 for a single point', () => {
    expect(polyLength([{ x: 0, y: 0 }])).toBe(0);
  });

  it('computes Euclidean length for a two-point segment', () => {
    const len = polyLength([{ x: 0, y: 0 }, { x: 3, y: 4 }]);
    expect(len).toBeCloseTo(5, 4);
  });

  it('sums segment lengths for a multi-point polyline', () => {
    const pts: Pt[] = [
      { x: 0, y: 0 },
      { x: 3, y: 4 },
      { x: 8, y: 4 },
    ];
    const len = polyLength(pts);
    expect(len).toBeCloseTo(10, 4); // 5 + 5
  });
});

// ---------------------------------------------------------------------------
// pointOnPolyline (route / path interpolation)
// ---------------------------------------------------------------------------

describe('pointOnPolyline', () => {
  it('returns the midpoint at fraction 0.5', () => {
    const pts: Pt[] = [{ x: 0, y: 0 }, { x: 10, y: 0 }];
    const mid = pointOnPolyline(pts, 0.5);
    expect(mid.x).toBeCloseTo(5, 2);
    expect(mid.y).toBeCloseTo(0, 2);
  });

  it('returns the first point at f = 0', () => {
    const pts: Pt[] = [{ x: 0, y: 0 }, { x: 10, y: 0 }];
    expect(pointOnPolyline(pts, 0)).toEqual(pts[0]);
  });

  it('returns the last point at f = 1', () => {
    const pts: Pt[] = [{ x: 0, y: 0 }, { x: 10, y: 0 }];
    expect(pointOnPolyline(pts, 1)).toEqual(pts[pts.length - 1]);
  });

  it('returns origin for an empty polyline', () => {
    expect(pointOnPolyline([], 0.5)).toEqual({ x: 0, y: 0 });
  });

  it('interpolates along a bent path correctly', () => {
    const pts: Pt[] = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ];
    // Total length = 20, so f=0.25 lands at 5 along first segment
    const pt = pointOnPolyline(pts, 0.25);
    expect(pt.x).toBeCloseTo(5, 2);
    expect(pt.y).toBeCloseTo(0, 2);

    // f=0.75 is 15 along total → 5 past the corner → second segment midpoint
    const pt2 = pointOnPolyline(pts, 0.75);
    expect(pt2.x).toBeCloseTo(10, 2);
    expect(pt2.y).toBeCloseTo(5, 2);
  });

  it('handles a single-point polyline at any fraction', () => {
    const single = [{ x: 42, y: 99 }];
    expect(pointOnPolyline(single, 0.5)).toEqual(single[0]);
  });
});

// ---------------------------------------------------------------------------
// startWalk
// ---------------------------------------------------------------------------

describe('startWalk', () => {
  const route: Pt[] = [{ x: 0, y: 0 }, { x: 100, y: 100 }];
  const now = Date.now();

  it('returns an AgentPos with correct from/to', () => {
    const walk = startWalk(route, now, false);
    expect(walk.from).toEqual(route[0]);
    expect(walk.to).toEqual(route[route.length - 1]);
  });

  it('respects minimum walk duration', () => {
    const walk = startWalk(route, now, false);
    expect(walk.duration).toBeGreaterThanOrEqual(MIN_WALK_MS);
  });

  it('sets duration to 0 under reduced motion', () => {
    const walk = startWalk(route, now, true);
    expect(walk.duration).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// isWalking
// ---------------------------------------------------------------------------

describe('isWalking', () => {
  const route: Pt[] = [{ x: 0, y: 0 }, { x: 100, y: 100 }];
  const now = Date.now();

  it('returns true shortly after start', () => {
    const walk = startWalk(route, now, false);
    expect(isWalking(walk, now + 100)).toBe(true);
  });

  it('returns false after the walk duration has elapsed', () => {
    const walk = startWalk(route, now, false);
    expect(isWalking(walk, now + walk.duration + 1)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// posAt
// ---------------------------------------------------------------------------

describe('posAt', () => {
  const route: Pt[] = [{ x: 0, y: 0 }, { x: 100, y: 100 }];
  const now = Date.now();

  it('parks at the destination after the walk finishes', () => {
    const walk = startWalk(route, now, false);
    const pos = posAt(walk, now + walk.duration + 1);
    expect(pos.x).toBeCloseTo(walk.to.x, 1);
    expect(pos.y).toBeCloseTo(walk.to.y, 1);
  });

  it('returns the start point at the beginning of the walk', () => {
    const walk = startWalk(route, now, false);
    const pos = posAt(walk, now);
    expect(pos.x).toBeCloseTo(walk.from.x, 1);
    expect(pos.y).toBeCloseTo(walk.from.y, 1);
  });

  it('under reduced motion, parks at the destination immediately', () => {
    const walk = startWalk(route, now, true);
    const pos = posAt(walk, now);
    expect(pos).toEqual(walk.to);
  });
});

// ---------------------------------------------------------------------------
// Reduced motion: full lifecycle
// ---------------------------------------------------------------------------

describe('reduced motion walking', () => {
  const route: Pt[] = [{ x: 0, y: 0 }, { x: 100, y: 100 }];
  const now = Date.now();

  it('walk is instant (duration 0, not in-progress)', () => {
    const walk = startWalk(route, now, true);
    expect(walk.duration).toBe(0);
    expect(isWalking(walk, now)).toBe(false);
  });

  it('posAt returns the destination for a reduced-motion walk', () => {
    const walk = startWalk(route, now, true);
    const pos = posAt(walk, now);
    expect(pos.x).toBeCloseTo(route[route.length - 1].x, 1);
    expect(pos.y).toBeCloseTo(route[route.length - 1].y, 1);
  });
});

// ---------------------------------------------------------------------------
// allAgentIds
// ---------------------------------------------------------------------------

describe('allAgentIds', () => {
  it('includes owner and manager', () => {
    const ids = allAgentIds(MOCK_ROSTER);
    expect(ids).toContain('owner');
    expect(ids).toContain('manager');
  });

  it('includes agents from each department', () => {
    const ids = allAgentIds(MOCK_ROSTER);
    expect(ids).toContain('frontend-dev');
    expect(ids).toContain('qa-engineer');
    expect(ids).toContain('rd-manager');
    expect(ids).toContain('creative-director');
  });

  it('has no duplicate ids', () => {
    const ids = allAgentIds(MOCK_ROSTER);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// ---------------------------------------------------------------------------
// charOf
// ---------------------------------------------------------------------------

describe('charOf', () => {
  it('returns the character for a known agent', () => {
    expect(charOf(MOCK_ROSTER, 'owner')?.name).toBe('Owner');
  });

  it('returns undefined for a missing agent', () => {
    expect(charOf(MOCK_ROSTER, 'nonexistent')).toBeUndefined();
  });

  it('returns undefined when roster is undefined', () => {
    expect(charOf(undefined, 'owner')).toBeUndefined();
  });
});
