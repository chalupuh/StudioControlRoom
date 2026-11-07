import { useEffect, useRef } from 'react';
import type { StudioState } from '../../api';
import type { AgentLive } from '../../store';
import { ModelChips, Portrait, Ring, StatusPill } from './AgentCard';
import { TEAM_LABEL, TEAM_VAR, agentStats, describeEvent, displayName, fmtTokens, recentEvents, relTime, type Dept, teamOf } from './model';

const FOCUSABLE = 'a[href],button:not([disabled]),input,select,textarea,[tabindex]:not([tabindex="-1"])';

export function Drawer({ id, state, live, depts, now, onClose }: {
  id: string; state: StudioState; live: Record<string, AgentLive>; depts: Dept[]; now: number; onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const c = state.roster?.agents?.[id];
  const team = c?.team ?? teamOf(id, depts) ?? 'eng';
  const l = live[id];
  const status = l?.status ?? 'idle';
  const name = displayName(id, c);
  const cp = state.checkpoints?.find((k) => k.agent === id);
  const evs = recentEvents(state.events, id, 20);
  const st = agentStats(state.events, id);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const root = ref.current;
    root?.querySelector<HTMLElement>('.o-close')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); return; }
      if (e.key !== 'Tab' || !root) return;
      const items = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (!items.length) return;
      const first = items[0], last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      else if (!root.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); opener?.focus?.(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only (re)bind when the opened agent changes
  }, [id]);

  return (
    <div className="o-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="o-drawer" ref={ref} role="dialog" aria-modal="true" aria-labelledby="o-dr-name" style={{ ['--accent' as string]: TEAM_VAR[team] }}>
        <button type="button" className="o-close" onClick={onClose} aria-label="Close profile">×</button>
        <div className="o-dr-hero">
          <Ring pct={l?.pct ?? 0} status={status} size={112}><Portrait id={id} c={c} size={96} /></Ring>
          <div>
            <h2 id="o-dr-name">{name}</h2>
            <p className="o-dr-title">{c?.title || id}</p>
            <div className="o-dr-badges"><span className="o-team-tag">{TEAM_LABEL[team]}</span><StatusPill status={status} /></div>
          </div>
        </div>

        {c?.quote && <blockquote className="o-quote">“{c.quote}”</blockquote>}
        {c?.bio && <p className="o-bio">{c.bio}</p>}
        <ModelChips info={state.models?.[id]} />

        <h3>Live</h3>
        <dl className="o-kv">
          <dt>Task</dt><dd>{l?.task || <em>No active task</em>}</dd>
          <dt>Progress</dt><dd>{Math.round(l?.pct ?? 0)}%</dd>
          <dt>Last tool</dt><dd className="mono">{l?.lastTool || '–'}</dd>
        </dl>

        {cp && (
          <>
            <h3>Checkpoint <small>{relTime(cp.ts, now)}</small></h3>
            <pre className="o-cp">{cp.text}</pre>
          </>
        )}

        <h3>Stats</h3>
        <div className="o-stats">
          <div><b>{st.started}</b><span>started</span></div>
          <div><b>{st.done}</b><span>done</span></div>
          <div><b>{st.blocked}</b><span>blocked</span></div>
          <div><b>{fmtTokens(st.cloudTokens)}</b><span>cloud tokens</span></div>
          <div><b>{fmtTokens(st.localTokens)}</b><span>local tokens</span></div>
        </div>

        <h3>Recent activity</h3>
        {evs.length === 0 ? <p className="o-empty">No recorded events for this agent.</p> : (
          <ol className="o-tl">
            {evs.map((e, i) => (
              <li key={e.ts + e.type + i} className={e.type === 'gate' ? 'gate' : ''}>
                <span className="o-tl-type">{e.type}</span>
                <span className="o-tl-text">{describeEvent(e)}</span>
                <time dateTime={new Date(e.ts).toISOString()}>{relTime(e.ts, now)}</time>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
