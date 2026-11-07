// Team view: org chart (desktop) / grouped card list (mobile), work trail rail, profile drawer.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { useStudio } from '../../store';
import { Chart, MobileList } from './Chart';
import { Drawer } from './Drawer';
import { Trail } from './Trail';
import { buildOrg, packetFor, type Packet } from './model';
import './org.css';

function useNarrow(): boolean {
  const q = '(max-width: 719px)';
  const [narrow, setNarrow] = useState(() => window.matchMedia(q).matches);
  useEffect(() => {
    const m = window.matchMedia(q);
    const h = () => setNarrow(m.matches);
    m.addEventListener('change', h);
    return () => m.removeEventListener('change', h);
  }, []);
  return narrow;
}

export function OrgView({ studio }: { studio: ReturnType<typeof useStudio> }) {
  const { state, live } = studio;
  const narrow = useNarrow();
  const [openId, setOpenId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [packets, setPackets] = useState<Packet[]>([]);
  const loadedAt = useRef(Date.now());
  const seen = useRef<Set<string>>(new Set());

  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 15000); return () => clearInterval(t); }, []);

  const events = state?.events;
  useEffect(() => {
    if (!events) return;
    const fresh: Packet[] = [];
    for (let i = events.length - 1; i >= 0 && i >= events.length - 20; i--) {
      const p = packetFor(events[i], loadedAt.current);
      if (p && !seen.current.has(p.id)) { seen.current.add(p.id); fresh.push(p); }
    }
    if (!fresh.length) return;
    setPackets((cur) => [...cur, ...fresh]);
    const ids = new Set(fresh.map((p) => p.id));
    // Not cleared on re-run on purpose: every packet must expire even if new events arrive.
    setTimeout(() => setPackets((cur) => cur.filter((p) => !ids.has(p.id))), 1500);
  }, [events]);

  const depts = useMemo(() => buildOrg(state?.roster), [state?.roster]);
  if (!state) return <div className="loading">Loading team…</div>;

  const common = { state, live, onOpen: (id: string) => { setNow(Date.now()); setOpenId(id); } };
  return (
    <div className="o-root">
      <div className="o-main">
        {narrow ? <MobileList depts={depts} {...common} /> : <Chart depts={depts} packets={packets} {...common} />}
      </div>
      <Trail events={state.events} roster={state.roster} now={now} onOpen={common.onOpen} />
      {openId && <Drawer id={openId} state={state} live={live} depts={depts} now={now} onClose={() => setOpenId(null)} />}
    </div>
  );
}
