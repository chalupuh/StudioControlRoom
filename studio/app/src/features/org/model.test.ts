import { describe, it, expect } from 'vitest';
import {
  buildOrg,
  teamOf,
  prettyId,
  displayName,
  initials,
  relTime,
  fmtTokens,
  agentStats,
  recentEvents,
  trailEvents,
  describeEvent,
  packetFor,
  TEAM_ORDER,
  type Dept,
  type DeptTeam,
} from './model';
import type { StudioEvent, Roster, Character } from '../../api';

function makeEvent(type: StudioEvent['type'], overrides: Partial<StudioEvent> = {}): StudioEvent {
  return {
    ts: Date.now(),
    type,
    agent: 'test-agent',
    task: 'test-task',
    ...overrides,
  } as StudioEvent;
}

describe('TEAM_ORDER', () => {
  it('contains all three departments', () => {
    expect(TEAM_ORDER).toEqual(['eng', 'rd', 'creative']);
  });
});

describe('buildOrg', () => {
  it('returns three departments with default members when no roster', () => {
    const depts = buildOrg(undefined);
    expect(depts.length).toBe(3);
    const eng = depts.find((d) => d.team === 'eng');
    expect(eng).toBeDefined();
    expect(eng!.members).toContain('frontend-dev');
    expect(eng!.members).toContain('backend-dev');
    expect(eng!.members).toContain('qa-engineer');
  });

  it('excludes department heads from members list', () => {
    const depts = buildOrg(undefined);
    const eng = depts.find((d) => d.team === 'eng')!;
    expect(eng.members).not.toContain('manager');
    const rd = depts.find((d) => d.team === 'rd')!;
    expect(rd.members).not.toContain('rd-manager');
  });

  it('honours roster override that moves a member to another team', () => {
    const roster: Roster = {
      agents: {
        'frontend-dev': {
          name: 'Frontend',
          title: 'Dev',
          team: 'rd',
          color: '#000',
          bio: '',
        },
      },
    };
    const depts = buildOrg(roster);
    const eng = depts.find((d) => d.team === 'eng')!;
    expect(eng.members).not.toContain('frontend-dev');
  });

  it('adds roster-only agents to their team', () => {
    const roster: Roster = {
      agents: {
        'custom-agent': {
          name: 'Custom',
          title: 'Agent',
          team: 'eng',
          color: '#000',
          bio: '',
        },
      },
    };
    const depts = buildOrg(roster);
    const eng = depts.find((d) => d.team === 'eng')!;
    expect(eng.members).toContain('custom-agent');
  });

  it('adds agents whose parent matches a department head', () => {
    const roster: Roster = {
      agents: {
        'custom-agent': {
          name: 'Custom',
          title: 'Agent',
          team: 'owner',
          color: '#000',
          bio: '',
          parent: 'rd-manager',
        },
      },
    };
    const depts = buildOrg(roster);
    const rd = depts.find((d) => d.team === 'rd')!;
    expect(rd.members).toContain('custom-agent');
  });
});

describe('teamOf', () => {
  it('returns "owner" for the owner', () => {
    const depts = buildOrg(undefined);
    expect(teamOf('owner', depts)).toBe('owner');
  });

  it('returns the correct team for a member', () => {
    const depts = buildOrg(undefined);
    expect(teamOf('frontend-dev', depts)).toBe('eng');
    expect(teamOf('market-researcher', depts)).toBe('rd');
    expect(teamOf('image-artist', depts)).toBe('creative');
  });

  it('returns the team for a department head', () => {
    const depts = buildOrg(undefined);
    expect(teamOf('manager', depts)).toBe('eng');
    expect(teamOf('rd-manager', depts)).toBe('rd');
    expect(teamOf('creative-director', depts)).toBe('creative');
  });

  it('returns undefined for unknown agent', () => {
    const depts = buildOrg(undefined);
    expect(teamOf('unknown-agent', depts)).toBeUndefined();
  });
});

describe('prettyId', () => {
  it('converts kebab-case to Title Case', () => {
    expect(prettyId('frontend-dev')).toBe('Frontend Dev');
    expect(prettyId('market-researcher')).toBe('Market Researcher');
  });

  it('handles single word', () => {
    expect(prettyId('manager')).toBe('Manager');
  });
});

describe('displayName', () => {
  it('uses character name when provided', () => {
    const char: Character = { name: 'Kaito', title: 'Dev', team: 'eng', color: '#000', bio: '' };
    expect(displayName('frontend-dev', char)).toBe('Kaito');
  });

  it('falls back to prettyId when no character', () => {
    expect(displayName('frontend-dev', undefined)).toBe('Frontend Dev');
  });

  it('falls back to prettyId when character has no name', () => {
    const char: Character = { name: '', title: '', team: 'eng', color: '#000', bio: '' };
    expect(displayName('frontend-dev', char)).toBe('Frontend Dev');
  });
});

describe('initials', () => {
  it('returns first two chars for single word', () => {
    expect(initials('Kaito')).toBe('KA');
  });

  it('returns first and last initial for multi-word', () => {
    expect(initials('Frontend Dev')).toBe('FD');
    expect(initials('Engineering Manager')).toBe('EM');
  });

  it('handles hyphenated names', () => {
    expect(initials('Frontend-Dev')).toBe('FD');
  });

  it('returns "?" for empty string', () => {
    expect(initials('')).toBe('?');
  });

  it('returns "?" for whitespace only', () => {
    expect(initials('   ')).toBe('?');
  });
});

describe('relTime', () => {
  const now = 1000000;

  it('returns "just now" for very recent', () => {
    expect(relTime(now - 1000, now)).toBe('just now');
    expect(relTime(now - 4000, now)).toBe('just now');
  });

  it('returns seconds for under a minute', () => {
    expect(relTime(now - 10000, now)).toBe('10s ago');
    expect(relTime(now - 59000, now)).toBe('59s ago');
  });

  it('returns minutes for under an hour', () => {
    expect(relTime(now - 60000, now)).toBe('1m ago');
    expect(relTime(now - 3500000, now)).toBe('58m ago');
  });

  it('returns hours for under a day', () => {
    expect(relTime(now - 3600000, now)).toBe('1h ago');
    expect(relTime(now - 86000000, now)).toBe('1d ago');
  });

  it('returns days for longer durations', () => {
    expect(relTime(now - 86400000, now)).toBe('1d ago');
    expect(relTime(now - 864000000, now)).toBe('10d ago');
  });

  it('handles future timestamps (clamps to "just now")', () => {
    expect(relTime(now + 1000, now)).toBe('just now');
  });
});

describe('fmtTokens', () => {
  it('formats small numbers as integers', () => {
    expect(fmtTokens(0)).toBe('0');
    expect(fmtTokens(42)).toBe('42');
    expect(fmtTokens(999)).toBe('999');
  });

  it('formats thousands with "k" suffix', () => {
    expect(fmtTokens(1000)).toBe('1.0k');
    expect(fmtTokens(15000)).toBe('15k'); // >= 10_000 rounds to integer
  });

  it('formats millions with "M" suffix', () => {
    expect(fmtTokens(1000000)).toBe('1.0M');
    expect(fmtTokens(2500000)).toBe('2.5M');
  });
});

describe('agentStats', () => {
  it('returns zeroed stats for no events', () => {
    const stats = agentStats([], 'a');
    expect(stats).toEqual({ started: 0, done: 0, blocked: 0, cloudTokens: 0, localTokens: 0 });
  });

  it('counts start and done events', () => {
    const events: StudioEvent[] = [
      makeEvent('start', { agent: 'a', ts: 1 }),
      makeEvent('start', { agent: 'a', ts: 2 }),
      makeEvent('done', { agent: 'a', ts: 3 }),
    ];
    const stats = agentStats(events, 'a');
    expect(stats.started).toBe(2);
    expect(stats.done).toBe(1);
  });

  it('ignores events for other agents', () => {
    const events: StudioEvent[] = [
      makeEvent('start', { agent: 'a', ts: 1 }),
      makeEvent('start', { agent: 'b', ts: 2 }),
    ];
    expect(agentStats(events, 'a').started).toBe(1);
    expect(agentStats(events, 'b').started).toBe(1);
  });

  it('counts blocked progress events', () => {
    const events: StudioEvent[] = [
      makeEvent('progress', { agent: 'a', status: 'blocked', ts: 1 }),
      makeEvent('progress', { agent: 'a', status: 'working', ts: 2 }),
    ];
    const stats = agentStats(events, 'a');
    expect(stats.blocked).toBe(1);
  });

  it('sums cloud and local tokens from usage events', () => {
    const events: StudioEvent[] = [
      makeEvent('usage', { agent: 'a', cloud: true, tokensIn: 100, tokensOut: 200, ts: 1 }),
      makeEvent('usage', { agent: 'a', cloud: false, tokensIn: 50, tokensOut: 50, ts: 2 }),
    ];
    const stats = agentStats(events, 'a');
    expect(stats.cloudTokens).toBe(300);
    expect(stats.localTokens).toBe(100);
  });

  it('handles usage events with missing token fields', () => {
    const events: StudioEvent[] = [
      makeEvent('usage', { agent: 'a', cloud: true, ts: 1 }),
    ];
    const stats = agentStats(events, 'a');
    expect(stats.cloudTokens).toBe(0);
  });
});

describe('recentEvents', () => {
  it('returns events for the agent in reverse chronological order', () => {
    const events: StudioEvent[] = [
      makeEvent('start', { agent: 'a', ts: 1 }),
      makeEvent('tool', { agent: 'a', ts: 2 }),
      makeEvent('done', { agent: 'a', ts: 3 }),
    ];
    const result = recentEvents(events, 'a');
    expect(result.map((e) => e.type)).toEqual(['done', 'tool', 'start']);
  });

  it('ignores events for other agents', () => {
    const events: StudioEvent[] = [
      makeEvent('start', { agent: 'a', ts: 1 }),
      makeEvent('start', { agent: 'b', ts: 2 }),
    ];
    expect(recentEvents(events, 'a').length).toBe(1);
  });

  it('limits to n events', () => {
    const events: StudioEvent[] = [];
    for (let i = 0; i < 30; i++) {
      events.push(makeEvent('start', { agent: 'a', ts: i }));
    }
    expect(recentEvents(events, 'a', 5).length).toBe(5);
  });
});

describe('trailEvents', () => {
  it('excludes "tool" and "usage" events', () => {
    const events: StudioEvent[] = [
      makeEvent('start', { ts: 1 }),
      makeEvent('tool', { ts: 2 }),
      makeEvent('usage', { ts: 3 }),
      makeEvent('done', { ts: 4 }),
    ];
    const result = trailEvents(events);
    expect(result.map((e) => e.type)).toEqual(['done', 'start']);
  });

  it('returns events in reverse chronological order', () => {
    const events: StudioEvent[] = [
      makeEvent('start', { ts: 1 }),
      makeEvent('done', { ts: 2 }),
    ];
    expect(trailEvents(events).map((e) => e.type)).toEqual(['done', 'start']);
  });

  it('limits to n events', () => {
    const events: StudioEvent[] = [];
    for (let i = 0; i < 100; i++) {
      events.push(makeEvent('start', { ts: i }));
    }
    expect(trailEvents(events, 10).length).toBe(10);
  });
});

describe('describeEvent', () => {
  it('describes start events', () => {
    expect(describeEvent({ ts: 0, type: 'start', agent: 'a', task: 'my task' })).toBe('Started: my task');
    expect(describeEvent({ ts: 0, type: 'start', agent: 'a' })).toBe('Started: a task');
  });

  it('describes done events with message or task', () => {
    expect(describeEvent({ ts: 0, type: 'done', agent: 'a', message: 'complete' })).toBe('Finished: complete');
    expect(describeEvent({ ts: 0, type: 'done', agent: 'a', task: 'my task' })).toBe('Finished: my task');
    expect(describeEvent({ ts: 0, type: 'done', agent: 'a' })).toBe('Finished');
  });

  it('describes progress events', () => {
    expect(describeEvent({ ts: 0, type: 'progress', agent: 'a', status: 'blocked', message: 'stuck' })).toBe('Blocked: stuck');
    expect(describeEvent({ ts: 0, type: 'progress', agent: 'a', pct: 50 })).toBe('50%');
    expect(describeEvent({ ts: 0, type: 'progress', agent: 'a', message: 'going' })).toBe('going');
  });

  it('describes checkpoint events', () => {
    expect(describeEvent({ ts: 0, type: 'checkpoint', agent: 'a', message: 'saving' })).toBe('Checkpoint: saving');
    expect(describeEvent({ ts: 0, type: 'checkpoint', agent: 'a' })).toBe('Checkpoint: saved');
  });

  it('describes paused/resumed events', () => {
    expect(describeEvent({ ts: 0, type: 'paused', agent: 'a' })).toBe('Paused');
    expect(describeEvent({ ts: 0, type: 'resumed', agent: 'a' })).toBe('Resumed');
    expect(describeEvent({ ts: 0, type: 'resumed-agent', agent: 'a' })).toBe('Resumed from checkpoint');
  });

  it('describes gate events', () => {
    expect(describeEvent({ ts: 0, type: 'gate', agent: 'a', message: 'review needed' })).toBe('Gate: review needed');
    expect(describeEvent({ ts: 0, type: 'gate', agent: 'a' })).toBe('Gate: needs owner review');
  });

  it('describes tool events', () => {
    expect(describeEvent({ ts: 0, type: 'tool', agent: 'a', tool: 'Read', detail: 'file.ts' })).toBe('Read file.ts');
    expect(describeEvent({ ts: 0, type: 'tool', agent: 'a', tool: 'Read' })).toBe('Read');
  });

  it('describes usage events', () => {
    expect(describeEvent({ ts: 0, type: 'usage', agent: 'a', model: 'opus', tier: 'opus' })).toBe('Usage opus');
    expect(describeEvent({ ts: 0, type: 'usage', agent: 'a' })).toBe('Usage');
  });
});

describe('packetFor', () => {
  it('returns null for events older than since', () => {
    const evt = { ts: 100, type: 'start' as const, agent: 'a' };
    expect(packetFor(evt as StudioEvent, 200)).toBeNull();
  });

  it('returns "down" packet for start events', () => {
    const evt: StudioEvent = { ts: 200, type: 'start', agent: 'a', task: 't' };
    const pkt = packetFor(evt, 100);
    expect(pkt).not.toBeNull();
    expect(pkt!.dir).toBe('down');
    expect(pkt!.agent).toBe('a');
    expect(pkt!.id).toContain('-s');
  });

  it('returns "up" packet for done events', () => {
    const evt: StudioEvent = { ts: 200, type: 'done', agent: 'a' };
    const pkt = packetFor(evt, 100);
    expect(pkt).not.toBeNull();
    expect(pkt!.dir).toBe('up');
    expect(pkt!.id).toContain('-d');
  });

  it('returns null for non-start/done event types', () => {
    expect(packetFor({ ts: 200, type: 'progress', agent: 'a' } as StudioEvent, 100)).toBeNull();
    expect(packetFor({ ts: 200, type: 'tool', agent: 'a' } as StudioEvent, 100)).toBeNull();
  });
});
