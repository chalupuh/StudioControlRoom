// App shell. Feature areas are owned by separate builders:
//   features/org/*  → OrgView (org chart, character cards, profile drawer)  [org builder]
//   features/ops/*  → OpsPanel (owner inbox, run board, token meter, GPU)    [ops builder]
//   features/village/* → VillageView (top-down village map)                  [village builder]
// Shell owns: header, global switch, layout, tabs. Keep feature components self-contained.
import { useState } from 'react';
import { useStudio } from './store';
import { api } from './api';
import { OrgView } from './features/org/OrgView';
import { OpsPanel } from './features/ops/OpsPanel';
import { VillageView } from './features/village/VillageView';

export default function App() {
  const studio = useStudio();
  const { state, online } = studio;
  const [tab, setTab] = useState<'org' | 'village' | 'ops'>('org');
  const paused = state?.control.state === 'paused';
  const waiting = state?.runs.filter((r) => r.status === 'waiting-gate' || r.status === 'blocked').length || 0;

  const toggle = async () => {
    if (!paused && !confirm('Safe-stop the whole studio? Agents save a checkpoint at their next step.')) return;
    await api.control(paused ? 'resume' : 'pause');
    studio.refetch();
  };

  return (
    <div className="shell">
      <header className="top">
        <h1>Studio <span>Control Room</span></h1>
        <span className={'live ' + (online ? 'on' : 'off')}><i />{online ? 'live' : 'offline'}</span>
        <nav className="tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'org'} onClick={() => setTab('org')}>Team</button>
          <button role="tab" aria-selected={tab === 'village'} onClick={() => setTab('village')}>Village</button>
          <button role="tab" aria-selected={tab === 'ops'} onClick={() => setTab('ops')}>
            Operations {waiting > 0 && <b className="badge">{waiting}</b>}
          </button>
        </nav>
        <button className={'switch ' + (paused ? 'off' : 'on')} onClick={toggle} aria-pressed={!paused}>
          <span className="track"><span className="knob" /></span>{paused ? 'Paused' : 'Running'}
        </button>
      </header>
      {paused && <div className="banner">Studio paused. Agents are saving checkpoints. Flip the switch to resume.</div>}
      <main>
        {!state ? <div className="loading">Connecting to studio…</div>
          : tab === 'org' ? <OrgView studio={studio} />
            : tab === 'village' ? <VillageView studio={studio} />
            : <OpsPanel studio={studio} />}
      </main>
    </div>
  );
}
