import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { StudioState } from '../../api';
import type { AgentLive } from '../../store';
import { AgentCard } from './AgentCard';
import { TEAM_VAR, type Dept, type Packet } from './model';

export const CARD_W = 196;
export const GAP = 14;
const CONN_H = 36;

/* ---- Zoom / pan helpers ---- */
const ZOOM_MIN = 0.4;
const ZOOM_MAX = 2;
const ZOOM_STEP = 0.12;
const WHEEL_FACTOR = 0.0015;
const DRAG_THRESHOLD = 4; /* px moved before a drag cancels the next click */

function clamp(val: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, val)); }

function useZoomPan(containerRef: React.RefObject<HTMLDivElement | null>) {
  const [scale, setScale] = useState(1);
  const [tx, setTx] = useState(0);
  const [ty, setTy] = useState(0);

  const applyDelta = useCallback((dx: number, dy: number) => {
    setTx((prev) => clamp(prev + dx, -1200, 1200));
    setTy((prev) => clamp(prev + dy, -600, 600));
  }, []);

  const zoom = useCallback((factor: number) => {
    setScale((prev) => clamp(prev + factor, ZOOM_MIN, ZOOM_MAX));
  }, []);

  const reset = useCallback(() => { setScale(1); setTx(0); setTy(0); }, []);

  /* ctrl/cmd + wheel → zoom */
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const factor = -e.deltaY * WHEEL_FACTOR;
      setScale((prev) => clamp(prev + factor, ZOOM_MIN, ZOOM_MAX));
    };
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
  }, [containerRef]);

  const isDragging = useRef(false);
  const last = useRef({ x: 0, y: 0 });

  /* Shared pan logic: mouse + touch */
  const handleStart = useCallback((x: number, y: number) => {
    isDragging.current = true;
    last.current = { x, y };
  }, []);
  const handleMove = useCallback((x: number, y: number) => {
    if (!isDragging.current) return;
    applyDelta(x - last.current.x, y - last.current.y);
    last.current = { x, y };
  }, [applyDelta]);
  const handleEnd = useCallback(() => { isDragging.current = false; }, []);

  /* mouse drag → pan; ignore clicks on buttons / links / cards */
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const origin = { x: 0, y: 0 };
    let moved = false;
    let panning = false;

    const onDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      if ((e.target as HTMLElement).closest('button, a, .o-card, .o-toggle')) return;
      e.preventDefault(); /* no text selection / native drag while panning */
      origin.x = e.clientX; origin.y = e.clientY;
      moved = false;
      panning = true;
      handleStart(e.clientX, e.clientY);
      el.classList.add('dragging');
    };
    const onMove = (e: MouseEvent) => {
      if (!panning) return;
      if (Math.hypot(e.clientX - origin.x, e.clientY - origin.y) > DRAG_THRESHOLD) moved = true;
      handleMove(e.clientX, e.clientY);
    };
    const onUp = () => {
      if (!panning) return;
      panning = false;
      handleEnd();
      el.classList.remove('dragging');
      /* a drag must not open a card: swallow the click that follows it */
      if (moved) {
        const swallow = (ev: MouseEvent) => { ev.stopPropagation(); ev.preventDefault(); };
        window.addEventListener('click', swallow, { capture: true, once: true });
        setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0);
      }
    };
    el.addEventListener('mousedown', onDown);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      el.removeEventListener('mousedown', onDown);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [containerRef, handleStart, handleMove, handleEnd]);

  /* touch drag → pan; prevent native scroll while panning */
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const onStart = (e: TouchEvent) => {
      const t = e.touches[0];
      handleStart(t.clientX, t.clientY);
    };
    const onMove = (e: TouchEvent) => {
      if (!isDragging.current) return;
      e.preventDefault();
      const t = e.touches[0];
      handleMove(t.clientX, t.clientY);
    };
    const onEnd = () => { handleEnd(); };
    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchmove', onMove, { passive: false });
    el.addEventListener('touchend', onEnd);
    el.addEventListener('touchcancel', onEnd);
    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', onEnd);
      el.removeEventListener('touchcancel', onEnd);
    };
  }, [containerRef, handleStart, handleMove, handleEnd]);

  return { scale, tx, ty, zoom, reset };
}

interface Common {
  state: StudioState; live: Record<string, AgentLive>; onOpen: (id: string) => void;
}

function Lane({ dept, state, live, onOpen, packets }: Common & { dept: Dept; packets: Packet[] }) {
  const [open, setOpen] = useState(true);
  const panelId = useId();
  const roster = state.roster?.agents ?? {};
  const n = dept.members.length;
  const cw = Math.max(CARD_W, n * CARD_W + Math.max(0, n - 1) * GAP);
  // Centre the head over the VISIBLE part of the lane (not the full scroll width), so wide teams don't push it off-screen.
  const laneRef = useRef<HTMLDivElement>(null);
  const [laneW, setLaneW] = useState(0);
  useEffect(() => {
    const el = laneRef.current; if (!el) return;
    const ro = new ResizeObserver(() => setLaneW(el.clientWidth));
    ro.observe(el); setLaneW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  const hx = Math.max(CARD_W / 2, Math.min(cw, laneW || cw) / 2);
  const mx = (i: number) => i * (CARD_W + GAP) + CARD_W / 2;
  const working = [dept.headId, ...dept.members].filter((id) => live[id]?.status === 'working').length;

  return (
    <section className="o-dept" style={{ ['--accent' as string]: TEAM_VAR[dept.team] }} aria-label={dept.label + ' team'}>
      <header className="o-dept-h">
        <h2>{dept.label}</h2>
        <span className="o-count">{n + 1} members{working > 0 && <> · <b>{working} working</b></>}</span>
        <button type="button" className="o-toggle" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((v) => !v)}>
          {open ? 'Collapse' : 'Expand'}
        </button>
      </header>
      <div className="o-lane" ref={laneRef} tabIndex={0} role="group" aria-label={dept.label + ' lane, scrolls horizontally'}>
        <div className="o-lane-in" style={{ width: cw }}>
          <div className="o-head-row" style={{ width: CARD_W, marginLeft: hx - CARD_W / 2 }}>
            <AgentCard id={dept.headId} c={roster[dept.headId]} team={dept.team} live={live[dept.headId]} models={state.models?.[dept.headId]} head onOpen={onOpen} />
          </div>
          <div id={panelId} hidden={!open}>
            {n > 0 && (
              <svg className="o-conn" width={cw} height={CONN_H} viewBox={`0 0 ${cw} ${CONN_H}`} aria-hidden="true">
                {dept.members.map((id, i) => (
                  <path key={id} d={`M${hx} 0 V${CONN_H / 2} H${mx(i)} V${CONN_H}`} fill="none"
                    className={live[id]?.status === 'working' ? 'wire on' : 'wire'} />
                ))}
                {packets.map((p) => {
                  const i = dept.members.indexOf(p.agent);
                  if (i < 0) return null;
                  const d = p.dir === 'down' ? `M${hx} 0 V${CONN_H / 2} H${mx(i)} V${CONN_H}` : `M${mx(i)} ${CONN_H} V${CONN_H / 2} H${hx} V0`;
                  return (
                    <circle key={p.id} r="5" className="packet">
                      <animateMotion dur="1.1s" path={d} fill="freeze" />
                    </circle>
                  );
                })}
              </svg>
            )}
            <div className="o-members" style={{ gap: GAP }}>
              {dept.members.map((id) => (
                <div key={id} style={{ width: CARD_W, flex: 'none' }}>
                  <AgentCard id={id} c={roster[id]} team={dept.team} live={live[id]} models={state.models?.[id]} onOpen={onOpen} />
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

export function Chart({ depts, packets, ...common }: Common & { depts: Dept[]; packets: Packet[] }) {
  const owner = common.state.roster?.agents?.owner;
  const containerRef = useRef<HTMLDivElement>(null);
  const { scale, tx, ty, zoom, reset } = useZoomPan(containerRef);

  return (
    <div className="o-chart">
      <div className="o-zoom-bar" aria-label="Chart zoom controls">
        <button type="button" className="o-zoom-btn" title="Zoom out" aria-label="Zoom out" onClick={() => zoom(-ZOOM_STEP)}>-</button>
        <button type="button" className="o-zoom-btn" title="Reset zoom" aria-label="Reset zoom" onClick={reset}>⌂</button>
        <button type="button" className="o-zoom-btn" title="Zoom in" aria-label="Zoom in" onClick={() => zoom(ZOOM_STEP)}>+</button>
      </div>
      <div className="o-zoom-viewport" ref={containerRef}>
        <div
          className="o-zoom-canvas"
          style={{
            transform: `scale(${scale}) translate(${tx / scale}px, ${ty / scale}px)`,
            transformOrigin: 'top center',
          }}
        >
          <div className="o-owner" style={{ ['--accent' as string]: 'var(--owner)' }}>
            <AgentCard id="owner" c={owner ? { ...owner, title: owner.title || 'Owner' } : { name: 'Owner', title: 'Owner · you decide at the gates', team: 'owner', color: 'var(--owner)', bio: '' }}
              team="owner" live={common.live.owner} models={common.state.models?.owner} head onOpen={common.onOpen} />
          </div>
          <div className="o-spine" aria-hidden="true" />
          <div className="o-depts">
            {depts.map((d) => <Lane key={d.team} dept={d} {...common} packets={packets} />)}
          </div>
        </div>
      </div>
    </div>
  );
}

export function MobileList({ depts, ...common }: Common & { depts: Dept[] }) {
  const roster = common.state.roster?.agents ?? {};
  return (
    <div className="o-mobile">
      {depts.map((d) => (
        <section key={d.team} className="o-dept" style={{ ['--accent' as string]: TEAM_VAR[d.team] }} aria-label={d.label + ' team'}>
          <header className="o-dept-h"><h2>{d.label}</h2><span className="o-count">{d.members.length + 1} members</span></header>
          <div className="o-mlist">
            {[d.headId, ...d.members].map((id, i) => (
              <AgentCard key={id} id={id} c={roster[id]} team={d.team} live={common.live[id]} models={common.state.models?.[id]} head={i === 0} onOpen={common.onOpen} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
