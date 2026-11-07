import type { StudioEvent } from '../../api';
import type { Roster } from '../../api';
import { describeEvent, displayName, relTime, trailEvents } from './model';

export function Trail({ events, roster, now, onOpen }: { events: StudioEvent[]; roster: Roster | undefined; now: number; onOpen: (id: string) => void }) {
  const items = trailEvents(events);
  return (
    <aside className="o-trail" aria-label="Work trail">
      <h2>Work Trail</h2>
      {items.length === 0 ? (
        <p className="o-empty">No activity yet. Events appear here as the team works.</p>
      ) : (
        <ol>
          {items.map((e, i) => {
            const c = roster?.agents?.[e.agent];
            return (
              <li key={e.ts + e.agent + e.type + i} className={e.type === 'gate' ? 'gate' : ''}>
                <i className="o-dot" style={{ background: c?.color || 'var(--faint)' }} aria-hidden="true" />
                <div>
                  <button type="button" className="o-link" onClick={() => onOpen(e.agent)}>{displayName(e.agent, c)}</button>
                  {e.type === 'gate' && <span className="o-gate-tag">needs you</span>}
                  <p>{describeEvent(e)}</p>
                  <time dateTime={new Date(e.ts).toISOString()}>{relTime(e.ts, now)}</time>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </aside>
  );
}
