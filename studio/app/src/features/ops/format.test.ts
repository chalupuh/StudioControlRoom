import { describe, it, expect } from 'vitest';
import { fmtDuration, fmtTokens, isCloudTier, budgetLevel, isEscalation, needsOwner, providerRows } from './format';
import type { RunSummary } from '../../api';

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

describe('providerRows', () => {
  it('returns no rows for missing or empty data', () => {
    expect(providerRows(undefined)).toEqual([]);
    expect(providerRows({})).toEqual([]);
  });

  it('orders providers ollama, anthropic, openai and adds labels', () => {
    const u = { runs: 1, tokens: 10, attempts: 2, limited: 1 };
    const rows = providerRows({ openai: u, ollama: u });
    expect(rows.map((r) => r.id)).toEqual(['ollama', 'openai']);
    expect(rows[1]).toEqual({ id: 'openai', label: 'OpenAI (Codex)', ...u });
  });
});

describe('isCloudTier', () => {
  it('returns true for opus, sonnet, and codex', () => {
    expect(isCloudTier('opus')).toBe(true);
    expect(isCloudTier('sonnet')).toBe(true);
    expect(isCloudTier('codex')).toBe(true);
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
