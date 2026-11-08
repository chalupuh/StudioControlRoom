import { describe, it, expect } from 'vitest';
import { fmtRate, fallbackRows, fmtDuration, fmtTokens, isCloudTier, budgetLevel, isEscalation, needsOwner, deriveGateOutcome, decisionCounts, decisionSummary, decisionLabel } from './format';
import type { GateItem, RunSummary } from '../../api';

describe('fmtDuration', () => {
  it('returns dash for negative or non-finite values', () => {
    expect(fmtDuration(-1)).toBe('–');
    expect(fmtDuration(Infinity)).toBe('–');
    expect(fmtDuration(NaN)).toBe('–');
  });

  it('returns seconds for under 60 seconds', () => {
    expect(fmtDuration(0)).toBe('0s');
    expect(fmtDuration(5000)).toBe('5s');
    expect(fmtDuration(59999)).toBe('59s');
  });

  it('returns minutes and seconds for under an hour', () => {
    expect(fmtDuration(60000)).toBe('1m 0s');
    expect(fmtDuration(125000)).toBe('2m 5s');
    expect(fmtDuration(3599999)).toBe('59m 59s');
  });

  it('returns hours and minutes for under 48 hours', () => {
    expect(fmtDuration(3600000)).toBe('1h 0m');
    expect(fmtDuration(7260000)).toBe('2h 1m');
    expect(fmtDuration(172799999)).toBe('47h 59m');
  });

  it('returns days and hours for 48+ hours', () => {
    expect(fmtDuration(172800000)).toBe('2d 0h');
    expect(fmtDuration(262800000)).toBe('3d 1h');
  });
});

describe('fmtTokens', () => {
  it('returns rounded number for small values', () => {
    expect(fmtTokens(0)).toBe('0');
    expect(fmtTokens(42)).toBe('42');
    expect(fmtTokens(999)).toBe('999');
  });

  it('returns k suffix for thousands', () => {
    expect(fmtTokens(1000)).toBe('1.0k');
    expect(fmtTokens(1500)).toBe('1.5k');
    expect(fmtTokens(10000)).toBe('10k'); // >= 1e4 rounds
    expect(fmtTokens(99999)).toBe('100k');
  });

  it('returns M suffix for millions', () => {
    expect(fmtTokens(1000000)).toBe('1.0M');
    expect(fmtTokens(5000000)).toBe('5.0M');
    expect(fmtTokens(10000000)).toBe('10M'); // >= 1e7 rounds
  });
});

describe('isCloudTier', () => {
  it('returns true for opus and sonnet', () => {
    expect(isCloudTier('opus')).toBe(true);
    expect(isCloudTier('sonnet')).toBe(true);
  });

  it('returns false for local tiers', () => {
    expect(isCloudTier('local')).toBe(false);
    expect(isCloudTier('local-fast')).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isCloudTier(undefined)).toBe(false);
  });
});

describe('budgetLevel', () => {
  it('returns ok when budget is zero or negative', () => {
    expect(budgetLevel(100, 0)).toBe('ok');
    expect(budgetLevel(100, -1)).toBe('ok');
  });

  it('returns ok when usage is under 80%', () => {
    expect(budgetLevel(79, 100)).toBe('ok');
    expect(budgetLevel(0, 100)).toBe('ok');
    expect(budgetLevel(50, 100)).toBe('ok');
  });

  it('returns warn when usage is between 80% and 99%', () => {
    expect(budgetLevel(80, 100)).toBe('warn');
    expect(budgetLevel(90, 100)).toBe('warn');
    expect(budgetLevel(99, 100)).toBe('warn');
  });

  it('returns over when usage is 100% or more', () => {
    expect(budgetLevel(100, 100)).toBe('over');
    expect(budgetLevel(150, 100)).toBe('over');
  });
});

describe('isEscalation', () => {
  const makeRun = (stageTier?: string): RunSummary => ({
    id: 'run-1',
    pipeline: 'test',
    status: 'running',
    vars: {},
    created: '2024-01-01',
    updated: '2024-01-01',
    stages: [
      { id: 'stage-1', type: 'build', tier: stageTier, state: 'current' },
    ],
    attempts: [],
  });

  it('returns true when attempt tier differs from stage tier', () => {
    const run = makeRun('local');
    const escalation = isEscalation(run, { stage: 'stage-1', tier: 'sonnet', ok: true, at: '' });
    expect(escalation).toBe(true);
  });

  it('returns false when attempt tier matches stage tier', () => {
    const run = makeRun('local');
    const ok = isEscalation(run, { stage: 'stage-1', tier: 'local', ok: true, at: '' });
    expect(ok).toBe(false);
  });

  it('returns false when stage has no tier', () => {
    const run = makeRun(undefined);
    const ok = isEscalation(run, { stage: 'stage-1', tier: 'sonnet', ok: true, at: '' });
    expect(ok).toBe(false);
  });

  it('returns false when attempt has no tier', () => {
    const run = makeRun('sonnet');
    const ok = isEscalation(run, { stage: 'stage-1', ok: true, at: '' });
    expect(ok).toBe(false);
  });

  it('returns false when stage is not found in run', () => {
    const run = makeRun('local');
    const ok = isEscalation(run, { stage: 'nonexistent', tier: 'sonnet', ok: true, at: '' });
    expect(ok).toBe(false);
  });
});

describe('needsOwner', () => {
  it('returns true for waiting-gate status', () => {
    expect(needsOwner({ status: 'waiting-gate' } as RunSummary)).toBe(true);
  });

  it('returns true for blocked status', () => {
    expect(needsOwner({ status: 'blocked' } as RunSummary)).toBe(true);
  });

  it('returns false for other statuses', () => {
    expect(needsOwner({ status: 'running' } as RunSummary)).toBe(false);
    expect(needsOwner({ status: 'done' } as RunSummary)).toBe(false);
    expect(needsOwner({ status: 'paused' } as RunSummary)).toBe(false);
    expect(needsOwner({ status: 'stopped' } as RunSummary)).toBe(false);
  });
});

const it_ = (id: string, decision?: GateItem['decision']): GateItem => ({ id, text: id, decision });

describe('deriveGateOutcome', () => {
  it('is undefined when nothing is decided', () => {
    expect(deriveGateOutcome([])).toBeUndefined();
    expect(deriveGateOutcome([it_('a'), it_('b')])).toBeUndefined();
  });
  it('any approve wins', () => {
    expect(deriveGateOutcome([it_('a', 'reject'), it_('b', 'park'), it_('c', 'approve')])).toBe('approve');
  });
  it('park beats reject when nothing is approved', () => {
    expect(deriveGateOutcome([it_('a', 'reject'), it_('b', 'park'), it_('c')])).toBe('park');
  });
  it('rejects when all decided items are rejected', () => {
    expect(deriveGateOutcome([it_('a', 'reject'), it_('b')])).toBe('reject');
  });
});

describe('decisionCounts', () => {
  it('counts each bucket', () => {
    expect(decisionCounts([it_('a', 'approve'), it_('b', 'approve'), it_('c', 'park'), it_('d', 'reject'), it_('e')]))
      .toEqual({ approve: 2, park: 1, reject: 1, undecided: 1 });
  });
  it('handles empty', () => {
    expect(decisionCounts([])).toEqual({ approve: 0, park: 0, reject: 0, undecided: 0 });
  });
});

describe('decisionSummary / decisionLabel', () => {
  it('joins non-zero buckets', () => {
    expect(decisionSummary([it_('a', 'approve'), it_('b', 'park'), it_('c', 'reject'), it_('d')]))
      .toBe('1 approved · 1 parked · 1 rejected · 1 undecided');
  });
  it('omits empty buckets and is empty for no items', () => {
    expect(decisionSummary([it_('a', 'reject')])).toBe('1 rejected');
    expect(decisionSummary([])).toBe('');
  });
  it('labels decisions', () => {
    expect(decisionLabel('approve')).toBe('Approved');
    expect(decisionLabel('park')).toBe('Parked');
    expect(decisionLabel('reject')).toBe('Rejected');
  });
});

describe('fmtRate', () => {
  it('formats a 0..1 rate as a whole percent', () => {
    expect(fmtRate(0)).toBe('0%');
    expect(fmtRate(0.256)).toBe('26%');
    expect(fmtRate(1)).toBe('100%');
  });
  it('returns dash for invalid input', () => {
    expect(fmtRate(NaN)).toBe('–');
    expect(fmtRate(-0.1)).toBe('–');
  });
});

describe('fallbackRows', () => {
  const row = (localStages: number, fallbackStages: number, fallbackRate: number) => ({ localStages, fallbackStages, fallbackRate });
  it('sorts by rate, skips agents without local stages, flags only rates above 25%', () => {
    const rows = fallbackRows({ a: row(10, 2, 0.2), b: row(8, 4, 0.5), c: row(0, 0, 0), d: row(4, 1, 0.25) });
    expect(rows.map((r) => r.id)).toEqual(['b', 'd', 'a']);
    expect(rows.map((r) => r.alert)).toEqual([true, false, false]);
  });
  it('handles empty input', () => {
    expect(fallbackRows({})).toEqual([]);
  });
});
