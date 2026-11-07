// Village view: top-down SVG map with buildings, paths, and animated character tokens.
// Characters idle near their building, walk along the drawn paths to HQ on 'done', and back on 'start'.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Character } from '../../api';
import type { useStudio } from '../../store';
import {
  VW, VH, ALL_BLDGS, PATHS, type Building, type AgentPos, type Pt,
  homePos, hqSlot, truncate, walkDir, eventKey, routeFor, startWalk, isWalking, posAt, allAgentIds, charOf,
} from './model';
import { buildOrg, TEAM_VAR, TEAM_LABEL, displayName, initials, type Dept } from '../org/model';
import { Drawer } from '../org/Drawer';
import './village.css';

// ---- Optional art from .studio/village/ (served at /village/). Missing files fall back to flat placeholders. ----
function useAsset(url: string): boolean {
  const [ok, setOk] = useState(false);
  useEffect(() => {
    let live = true;
    const img = new Image();
    img.onload = () => { if (live) setOk(true); };
    img.onerror = () => { if (live) setOk(false); };
    img.src = url;
    return () => { live = false; };
  }, [url]);
  return ok;
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const on = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return reduced;
}

function BuildingArt({ b, accent }: { b: Building; accent: string }) {
  const hasArt = useAsset(`/village/buildings/${b.id}.png`);
  const x = b.x - b.w / 2, y = b.y - b.h / 2;
  if (hasArt) {
    return (
      <g>
        <image href={`/village/buildings/${b.id}.png`} x={x} y={y} width={b.w} height={b.h} preserveAspectRatio="xMidYMid meet" />
        <text x={b.x} y={y + b.h + 12} textAnchor="middle" fontSize="11" fontWeight="600" fill="var(--text)" fontFamily="var(--font)">{b.label}</text>
      </g>
    );
  }
  return (
    <g>
      <rect x={x + 3} y={y + 3} width={b.w} height={b.h} rx={6} fill="rgba(0,0,0,.25)" />
      <rect x={x} y={y} width={b.w} height={b.h} rx={6} fill="var(--panel)" stroke={accent} strokeWidth={2} />
      <rect x={b.x - 8} y={y + b.h - 18} width={16} height={18} rx={3} fill="color-mix(in srgb, var(--bg) 60%, var(--panel))" />
      <rect x={x + 8} y={y + 8} width={12} height={12} rx={2} fill="color-mix(in srgb, var(--line) 40%, #fff)" opacity=".5" />
      <rect x={x + b.w - 20} y={y + 8} width={12} height={12} rx={2} fill="color-mix(in srgb, var(--line) 40%, #fff)" opacity=".5" />
      <text x={b.x} y={b.y + 5} textAnchor="middle" fontSize="11" fontWeight="600" fill="var(--text)" fontFamily="var(--font)">{b.label}</text>
    </g>
  );
}

function CharacterToken({ id, c, x, y, status, task, accent, size, onClick }: {
  id: string; c?: Character; x: number; y: number;
  status: string; task?: string; accent: string; size: number; onClick: () => void;
}) {
  const name = displayName(id, c);
  const isWorking = status === 'working';
  return (
    <g className="v-char" role="button" tabIndex={0} aria-label={`${name} – ${status}`} onClick={onClick}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } }}>
      {isWorking && <circle cx={x} cy={y} r={size / 2 + 4} fill="none" stroke="var(--working)" strokeWidth={2} opacity=".5" />}
      <circle cx={x} cy={y} r={size / 2} fill="var(--panel)" stroke={accent} strokeWidth={2} />
      {c?.portrait ? (
        <>
          <clipPath id={`v-clip-${id}`}><circle cx={x} cy={y} r={size / 2 - 2} /></clipPath>
          <image href={c.portrait} x={x - size / 2 + 2} y={y - size / 2 + 2} width={size - 4} height={size - 4}
            preserveAspectRatio="xMidYMid slice" clipPath={`url(#v-clip-${id})`}>
            <title>{name}</title>
          </image>
        </>
      ) : (
        <>
          <circle cx={x} cy={y} r={size / 2 - 2} fill={c?.color || 'var(--faint)'} opacity=".6" />
          <text x={x} y={y + 4} textAnchor="middle" fontSize="10" fontWeight="700" fill="#fff" fontFamily="var(--font)">{initials(name)}</text>
        </>
      )}
      {isWorking && task && (
        <g className="v-bubble">
          <rect x={x - 44} y={y - size / 2 - 22} width={88} height={16} rx={4} fill="var(--panel2)" stroke="var(--line)" strokeWidth={1} />
          <text x={x} y={y - size / 2 - 11} textAnchor="middle" fontSize="9" fill="var(--muted)" fontFamily="var(--font)">{truncate(task, 20)}</text>
        </g>
      )}
      <text x={x} y={y + size / 2 + 12} textAnchor="middle" fontSize="9" fill="var(--faint)" fontFamily="var(--font)">{name.length > 14 ? truncate(name, 12) : name}</text>
    </g>
  );
}

export function VillageView({ studio }: { studio: ReturnType<typeof useStudio> }) {
  const { state, live } = studio;
  const [drawerId, setDrawerId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [, setFrame] = useState(0);       // bumped every animation frame while a walk is active
  const [kick, setKick] = useState(0);    // bumped when a new walk starts → (re)starts the rAF loop
  const reduced = useReducedMotion();
  const reducedRef = useRef(reduced);
  reducedRef.current = reduced;

  const positions = useRef(new Map<string, AgentPos>());  // persists: agents stay at their destination
  const seen = useRef(new Set<string>());                 // event keys already processed
  const initialised = useRef(false);

  const hasGrass = useAsset('/village/tiles/grass.png');
  const depts = useMemo<Dept[]>(() => buildOrg(state?.roster), [state?.roster]);
  const allIds = useMemo(() => allAgentIds(state?.roster), [state?.roster]);
  const events = state?.events;

  // Process each event exactly once.
  useEffect(() => {
    if (!events) return;
    const pos = positions.current, done = seen.current;
    const t = Date.now();
    let started = false;
    if (!initialised.current) {
      // History: park agents where their latest event left them, no animation.
      for (const e of events) {
        done.add(eventKey(e));
        const dir = walkDir(e);
        if (dir === 'to-hq') { const s = hqSlot(e.agent); pos.set(e.agent, { from: s, to: s, route: [s], startedAt: 0, duration: 0 }); }
        else if (dir === 'to-home') pos.delete(e.agent);
      }
      initialised.current = true;
      setKick((k) => k + 1);
      return;
    }
    for (const e of events) {
      const key = eventKey(e);
      if (done.has(key)) continue;
      done.add(key);
      const dir = walkDir(e);
      if (!dir) continue;
      const prev = pos.get(e.agent);
      const cur: Pt = prev ? posAt(prev, t) : homePos(e.agent, depts);
      const route = routeFor(e.agent, dir, cur, depts);
      pos.set(e.agent, startWalk(route, t, reducedRef.current));
      started = true;
    }
    // Forget keys that left the server's rolling window so the set stays bounded.
    if (done.size > events.length * 2 + 50) {
      const current = new Set(events.map(eventKey));
      for (const k of done) if (!current.has(k)) done.delete(k);
    }
    if (started) setKick((k) => k + 1);
  }, [events, depts]);

  // ONE rAF loop: re-render every frame while any walk is active; stops when all walks end.
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const t = Date.now();
      setFrame((f) => f + 1);
      let active = false;
      for (const p of positions.current.values()) if (isWalking(p, t)) { active = true; break; }
      raf = active ? requestAnimationFrame(tick) : 0;
    };
    raf = requestAnimationFrame(tick);
    return () => { if (raf) cancelAnimationFrame(raf); };
  }, [kick]);

  const openDrawer = useCallback((id: string) => { setNow(Date.now()); setDrawerId(id); }, []);

  if (!state) return <div className="v-loading">Loading village…</div>;

  const t = Date.now();
  const chars = allIds.map((id) => {
    const l = live[id];
    const dept = depts.find((d) => d.headId === id || d.members.includes(id));
    const team = id === 'owner' ? 'owner' : dept?.team ?? 'eng';
    const p = positions.current.get(id);
    const at = p ? posAt(p, t) : homePos(id, depts);
    return { id, c: charOf(state.roster, id), at, status: l?.status ?? 'idle', task: l?.task, accent: TEAM_VAR[team] || 'var(--idle)' };
  });

  return (
    <div className="v-root">
      <svg className="v-map" viewBox={`0 0 ${VW} ${VH}`} role="img" aria-label="Studio Village Map">
        <defs>
          <radialGradient id="v-grass" cx="50%" cy="40%" r="60%">
            <stop offset="0%" stopColor="color-mix(in srgb, var(--panel) 80%, #1a3a2a)" />
            <stop offset="100%" stopColor="var(--bg)" />
          </radialGradient>
          <pattern id="v-grass-tile" width="64" height="64" patternUnits="userSpaceOnUse">
            <image href="/village/tiles/grass.png" width="64" height="64" />
          </pattern>
        </defs>
        <rect x={0} y={0} width={VW} height={VH} fill={hasGrass ? 'url(#v-grass-tile)' : 'url(#v-grass)'} />
        {!hasGrass && Array.from({ length: 40 }).map((_, i) => (
          <circle key={`grass-${i}`} cx={(i * 137 + 50) % VW} cy={(i * 89 + 100) % VH} r={2 + (i % 3)} fill="var(--line)" opacity=".12" />
        ))}

        {PATHS.map((p) => (
          <polyline key={p.id} points={p.points.map((q) => `${q.x},${q.y}`).join(' ')} fill="none"
            stroke={p.color} strokeWidth={3} strokeDasharray="8 6" strokeLinejoin="round" opacity=".35" />
        ))}

        {ALL_BLDGS.map((b) => <BuildingArt key={b.id} b={b} accent={b.team ? TEAM_VAR[b.team] : 'var(--owner)'} />)}

        {chars.map((ch) => (
          <CharacterToken key={ch.id} id={ch.id} c={ch.c} x={ch.at.x} y={ch.at.y} status={ch.status} task={ch.task}
            accent={ch.accent} size={ch.id === 'owner' ? 32 : 28} onClick={() => openDrawer(ch.id)} />
        ))}
      </svg>

      <div className="v-legend" aria-label="Village legend">
        {depts.map((d) => (
          <span key={d.team} className="v-legend-item" style={{ ['--accent' as string]: TEAM_VAR[d.team] }}><i />{TEAM_LABEL[d.team]}</span>
        ))}
        <span className="v-legend-item" style={{ ['--accent' as string]: TEAM_VAR.owner }}><i />Owner</span>
      </div>

      {drawerId && <Drawer id={drawerId} state={state} live={live} depts={depts} now={now} onClose={() => setDrawerId(null)} />}
    </div>
  );
}
