import { describe, it, expect } from 'vitest';
import { deriveLive, type AgentLive } from './store';
import type { StudioEvent } from './api';

function makeEvent(type: StudioEvent['type'], overrides: Partial<StudioEvent> = {}): StudioEvent {
  return {
    ts: Date.now(),
    type,
    agent: 'test-agent',
    task: 'test-task',
    ...overrides,
  } as StudioEvent;
}

describe('deriveLive', () => {
  it('returns empty object for no events', () => {
    const result = deriveLive([]);
    expect(result).toEqual({});
  });

  it('skips events without an agent', () => {
    const events: StudioEvent[] = [{ ts: 1, type: 'start', agent: '' }];
    const result = deriveLive(events);
    expect(result).toEqual({});
  });

  it('creates agent entry on "start" event', () => {
    const events: StudioEvent[] = [makeEvent('start', { agent: 'frontend-dev', task: 'build UI', ts: 100 })];
    const result = deriveLive(events);
    expect(result['frontend-dev']).toEqual({
      status: 'working',
      pct: 5,
      task: 'build UI',
      since: 100,
      lastTool: undefined,
    });
  });

  it('increments pct on "tool" events, capped at 90', () => {
    const events: StudioEvent[] = [
      makeEvent('start', { agent: 'a', ts: 1 }),
      makeEvent('tool', { agent: 'a', tool: 'Read', detail: 'file.ts', ts: 2 }),
      makeEvent('tool', { agent: 'a', tool: 'Grep', detail: 'pattern', ts: 3 }),
    ];
    const result = deriveLive(events);
    expect(result['a'].pct).toBe(11); // 5 + 3 + 3

    // cap at 90: push many tool events
    const manyTools = [...events];
    for (let i = 0; i < 30; i++) {
      manyTools.push(makeEvent('tool', { agent: 'a', tool: 'X', ts: 100 + i }));
    }
    const capped = deriveLive(manyTools);
    expect(capped['a'].pct).toBe(90);
  });

  it('sets lastTool on "tool" events', () => {
    const events: StudioEvent[] = [
      makeEvent('start', { agent: 'a', ts: 1 }),
      makeEvent('tool', { agent: 'a', tool: 'Read', detail: 'foo.ts', ts: 2 }),
    ];
    const result = deriveLive(events);
    expect(result['a'].lastTool).toBe('Read foo.ts');
  });

  it('handles "tool" with only tool name (no detail)', () => {
    const events: StudioEvent[] = [
      makeEvent('start', { agent: 'a', ts: 1 }),
      makeEvent('tool', { agent: 'a', tool: 'Read', detail: '', ts: 2 }),
    ];
    const result = deriveLive(events);
    expect(result['a'].lastTool).toBe('Read');
  });

  it('updates pct and status on "progress" event', () => {
    const events: StudioEvent[] = [
      makeEvent('start', { agent: 'a', ts: 1 }),
      makeEvent('progress', { agent: 'a', pct: 50, status: 'working', message: 'half done', ts: 2 }),
    ];
    const result = deriveLive(events);
    expect(result['a'].pct).toBe(50);
    expect(result['a'].status).toBe('working');
    expect(result['a'].task).toBe('half done');
  });

  it('keeps existing pct when progress event omits pct', () => {
    const events: StudioEvent[] = [
      makeEvent('start', { agent: 'a', ts: 1 }),
      makeEvent('progress', { agent: 'a', message: 'still going', ts: 2 }),
    ];
    const result = deriveLive(events);
    expect(result['a'].pct).toBe(5); // unchanged from start
  });

  it('sets status to "done" and pct 100 on "done" event', () => {
    const events: StudioEvent[] = [
      makeEvent('start', { agent: 'a', ts: 1 }),
      makeEvent('done', { agent: 'a', ts: 2 }),
    ];
    const result = deriveLive(events);
    expect(result['a'].status).toBe('done');
    expect(result['a'].pct).toBe(100);
  });

  it('does not overwrite "blocked" status with "done"', () => {
    const events: StudioEvent[] = [
      makeEvent('start', { agent: 'a', ts: 1 }),
      makeEvent('progress', { agent: 'a', status: 'blocked', ts: 2 }),
      makeEvent('done', { agent: 'a', ts: 3 }),
    ];
    const result = deriveLive(events);
    expect(result['a'].status).toBe('blocked');
    expect(result['a'].pct).not.toBe(100);
  });

  it('does not overwrite "paused" status with "done"', () => {
    const events: StudioEvent[] = [
      makeEvent('start', { agent: 'a', ts: 1 }),
      makeEvent('checkpoint', { agent: 'a', message: 'saving', ts: 2 }),
      makeEvent('done', { agent: 'a', ts: 3 }),
    ];
    const result = deriveLive(events);
    expect(result['a'].status).toBe('paused');
  });

  it('sets status to "paused" on "checkpoint" event', () => {
    const events: StudioEvent[] = [
      makeEvent('start', { agent: 'a', ts: 1 }),
      makeEvent('checkpoint', { agent: 'a', message: 'saving state', ts: 2 }),
    ];
    const result = deriveLive(events);
    expect(result['a'].status).toBe('paused');
    expect(result['a'].task).toBe('Stopped: saving state');
  });

  it('handles checkpoint with no message', () => {
    const events: StudioEvent[] = [
      makeEvent('start', { agent: 'a', ts: 1 }),
      makeEvent('checkpoint', { agent: 'a', ts: 2 }),
    ];
    const result = deriveLive(events);
    expect(result['a'].task).toBe('Stopped: ');
  });

  it('sets status to "working" on "resumed-agent" event', () => {
    const events: StudioEvent[] = [
      makeEvent('start', { agent: 'a', ts: 1 }),
      makeEvent('checkpoint', { agent: 'a', ts: 2 }),
      makeEvent('resumed-agent', { agent: 'a', ts: 3 }),
    ];
    const result = deriveLive(events);
    expect(result['a'].status).toBe('working');
    expect(result['a'].task).toBe('Resuming from checkpoint');
  });

  it('tracks multiple agents independently', () => {
    const events: StudioEvent[] = [
      makeEvent('start', { agent: 'a', task: 'task-a', ts: 1 }),
      makeEvent('start', { agent: 'b', task: 'task-b', ts: 2 }),
      makeEvent('done', { agent: 'a', ts: 3 }),
    ];
    const result = deriveLive(events);
    expect(result['a'].status).toBe('done');
    expect(result['b'].status).toBe('working');
    expect(result['b'].task).toBe('task-b');
  });

  it('uses empty string as default task when start event has no task', () => {
    const events: StudioEvent[] = [
      makeEvent('start', { agent: 'a', task: undefined, ts: 1 }),
    ];
    const result = deriveLive(events);
    expect(result['a'].task).toBe('');
  });
});
