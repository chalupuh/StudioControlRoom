// Operations view: owner inbox, run board, team switches, Claude budget, GPU & models.
import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { useStudio } from '../../store';
import { api, type Gpu, type RunSummary, type Usage } from '../../api';
import { renderMarkdown } from './markdown';
import { budgetLevel, fmtDuration, fmtTokens, isCloudTier, isEscalation, needsOwner } from './format';
import './ops.css';

type Studio = ReturnType<typeof useStudio>;
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

function useNow(ms = 5000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(t); }, [ms]);
  return now;
}

/** Polls `fn` every `ms`; if `visibleOnly`, pauses while the tab is hidden. */
function usePoll<T>(fn: () => Promise<T>, ms: number, visibleOnly = false) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      if (visibleOnly && document.hidden) return;
      try { const d = await fn(); if (!stop) { setData(d); setError(null); } }
      catch (e) { if (!stop) setError(errMsg(e)); }
      finally { if (!stop) setLoading(false); }
    };
    tick();
    const t = setInterval(tick, ms);
    const vis = () => { if (!document.hidden) tick(); };
    if (visibleOnly) document.addEventListener('visibilitychange', vis);
    return () => { stop = true; clearInterval(t); document.removeEventListener('visibilitychange', vis); };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- fn is a stable api call
  }, [ms, visibleOnly]);
  return { data, error, loading };
}

function Card({ title, id, children, className = '', aside }: { title: string; id: string; children: ReactNode; className?: string; aside?: ReactNode }) {
  return (
    <section className={'ops-card ' + className} aria-labelledby={id}>
      <header className="ops-card-h"><h2 id={id}>{title}</h2>{aside}</header>
      {children}
    </section>
  );
}
const ErrorLine = ({ msg }: { msg: string }) => <p className="ops-error" role="alert">Could not load: {msg}</p>;

function TierBadge({ tier }: { tier?: string }) {
  if (!tier) return null;
  return <span className={'tier ' + (isCloudTier(tier) ? 'cloud' : 'local')}>{tier}</span>;
}

// ---------------------------------------------------------------- Owner inbox
function FileViewer({ path }: { path: string }) {
  const [text, setText] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let stop = false;
    api.file(path).then((t) => { if (!stop) setText(t); }).catch((e) => { if (!stop) setErr(errMsg(e)); });
    return () => { stop = true; };
  }, [path]);
  return (
    <div className="md" tabIndex={0} aria-label={'Contents of ' + path}>
      {err ? <ErrorLine msg={err} /> : text === null ? <p className="ops-muted">Loading {path}…</p>
        : text.trim() ? renderMarkdown(text) : <p className="ops-muted">File is empty.</p>}
    </div>
  );
}

function GateItem({ run, now, onDone }: { run: RunSummary; now: number; onDone: () => void }) {
  const gate = run.gate!;
  const [open, setOpen] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const noteId = 'note-' + run.id;

  const decide = async (d: 'approve' | 'reject') => {
    setBusy(true); setErr(null);
    try { await api.gate(run.id, d, note.trim()); setSent(d === 'approve' ? 'Approved' : 'Rejected'); setConfirming(false); onDone(); }
    catch (e) { setErr(errMsg(e)); }
    finally { setBusy(false); }
  };

  return (
    <li className="inbox-item gate">
      <div className="inbox-h">
        <span className="chip gate">Gate</span>
        <h3>{gate.title}</h3>
        <span className="ops-muted">{run.pipeline} · waiting {fmtDuration(now - Date.parse(gate.since))}</span>
      </div>
      {gate.show.length > 0 && (
        <ul className="files" aria-label="Files to review">
          {gate.show.map((f) => (
            <li key={f}>
              <button type="button" className="link" aria-expanded={open === f} onClick={() => setOpen(open === f ? null : f)}>{f}</button>
            </li>
          ))}
        </ul>
      )}
      {open && <FileViewer path={open} />}
      {sent ? (
        <p className="ops-sent" role="status">Sent ({sent}) — engine continuing…</p>
      ) : (
        <>
          <label className="note" htmlFor={noteId}>Note (optional)
            <textarea id={noteId} rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Reason or instructions for the engine" />
          </label>
          <div className="actions">
            <button type="button" className="btn ok" disabled={busy} onClick={() => decide('approve')}>Approve</button>
            {!confirming
              ? <button type="button" className="btn danger" disabled={busy} onClick={() => setConfirming(true)}>Reject</button>
              : (
                <span className="confirm" role="group" aria-label="Confirm rejection">
                  <span>Reject this gate?</span>
                  <button type="button" className="btn danger" disabled={busy} onClick={() => decide('reject')}>Yes, reject</button>
                  <button type="button" className="btn" disabled={busy} onClick={() => setConfirming(false)}>Cancel</button>
                </span>
              )}
          </div>
        </>
      )}
      {err && <p className="ops-error" role="alert">Failed: {err}</p>}
    </li>
  );
}

function BlockedItem({ run, now, onDone }: { run: RunSummary; now: number; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const failed = run.attempts.filter((a) => !a.ok && a.problems?.length);
  const resume = async () => {
    setBusy(true); setErr(null);
    try { await api.resume(run.id); setSent(true); onDone(); } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };
  return (
    <li className="inbox-item blocked">
      <div className="inbox-h">
        <span className="chip blocked">Blocked</span>
        <h3>{run.pipeline}</h3>
        <span className="ops-muted">{run.id} · since {fmtDuration(now - Date.parse(run.updated))}</span>
      </div>
      <p className="reason">{run.blockedReason || 'No reason recorded.'}</p>
      {failed.length > 0 && (
        <ul className="problems" aria-label="Failed attempts">
          {failed.map((a, i) => (
            <li key={i}>
              <strong>{a.stage}</strong> {a.agent && <span className="ops-muted">{a.agent}</span>} <TierBadge tier={a.tier} />
              <ul>{a.problems!.map((p, j) => <li key={j}>{p}</li>)}</ul>
            </li>
          ))}
        </ul>
      )}
      {sent ? <p className="ops-sent" role="status">Sent — engine continuing…</p>
        : <div className="actions"><button type="button" className="btn ok" disabled={busy} onClick={resume}>Resume</button></div>}
      {err && <p className="ops-error" role="alert">Failed: {err}</p>}
    </li>
  );
}

function Inbox({ runs, now, refetch }: { runs: RunSummary[]; now: number; refetch: () => void }) {
  const items = runs.filter(needsOwner);
  return (
    <Card title="Owner Inbox" id="ops-inbox" className="inbox" aside={items.length > 0 ? <b className="badge">{items.length}</b> : null}>
      {items.length === 0 ? <p className="ops-empty">Nothing needs you right now.</p> : (
        <ul className="inbox-list">
          {items.map((r) => r.status === 'waiting-gate' && r.gate
            ? <GateItem key={r.id} run={r} now={now} onDone={refetch} />
            : <BlockedItem key={r.id} run={r} now={now} onDone={refetch} />)}
        </ul>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- Runs board
const pill = (s: RunSummary['status']) => <span className={'pill ' + s}>{s}</span>;

function RunRow({ run, now }: { run: RunSummary; now: number }) {
  const [open, setOpen] = useState(false);
  const live = run.status === 'running' || run.status === 'waiting-gate' || run.status === 'blocked' || run.status === 'paused';
  const elapsed = (live ? now : Date.parse(run.updated)) - Date.parse(run.created);
  const escalations = run.attempts.filter((a) => isEscalation(run, a)).length;
  const hid = 'hist-' + run.id;
  return (
    <li className="run">
      <div className="run-h">
        <strong>{run.pipeline}</strong> {pill(run.status)}
        <span className="ops-muted">{run.id}</span>
        <span className="run-meta">
          <span title="Elapsed">⏱ {fmtDuration(elapsed)}</span>
          <span>{run.attempts.length} attempt{run.attempts.length === 1 ? '' : 's'}</span>
          {escalations > 0 && <span className="esc">{escalations} escalation{escalations === 1 ? '' : 's'}</span>}
        </span>
      </div>
      <ol className="stepper" aria-label="Stages">
        {run.stages.map((s) => (
          <li key={s.id} className={'step ' + s.state} aria-current={s.state === 'current' ? 'step' : undefined}>
            <span className="dot" aria-hidden="true">{s.state === 'done' ? '✓' : ''}</span>
            <span className="step-name">{s.id}</span>
            <span className="step-sub">{s.agent && <span>{s.agent}</span>}<TierBadge tier={s.tier} /></span>
            <span className="sr-only">{s.state}</span>
          </li>
        ))}
      </ol>
      {run.attempts.length > 0 && (
        <>
          <button type="button" className="link" aria-expanded={open} aria-controls={hid} onClick={() => setOpen(!open)}>
            {open ? 'Hide' : 'Show'} attempt history
          </button>
          {open && (
            <ul className="history" id={hid}>
              {run.attempts.map((a, i) => (
                <li key={i} className={a.ok ? 'ok' : 'fail'}>
                  <span>{a.ok ? '✓' : '✗'}<span className="sr-only">{a.ok ? ' ok' : ' failed'}</span></span>
                  <strong>{a.stage}</strong>
                  {a.agent && <span className="ops-muted">{a.agent}</span>}
                  <TierBadge tier={a.tier} />
                  {isEscalation(run, a) && <span className="esc">escalated</span>}
                  {a.secs != null && <span className="ops-muted">{a.secs}s</span>}
                  <time className="ops-muted" dateTime={a.at}>{new Date(a.at).toLocaleTimeString()}</time>
                  {a.problems && a.problems.length > 0 && <ul>{a.problems.map((p, j) => <li key={j}>{p}</li>)}</ul>}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </li>
  );
}

function RunsBoard({ runs, now }: { runs: RunSummary[]; now: number }) {
  const sorted = [...runs].sort((a, b) => Date.parse(b.created) - Date.parse(a.created));
  return (
    <Card title="Pipeline Runs" id="ops-runs" className="runs">
      {sorted.length === 0 ? <p className="ops-empty">No pipeline runs yet.</p>
        : <ul className="run-list">{sorted.map((r) => <RunRow key={r.id} run={r} now={now} />)}</ul>}
    </Card>
  );
}

// ---------------------------------------------------------------- Team switches
const TEAMS: { id: 'eng' | 'rd' | 'creative'; label: string }[] = [
  { id: 'eng', label: 'Engineering' }, { id: 'rd', label: 'R&D' }, { id: 'creative', label: 'Creative' },
];

function TeamSwitches({ studio }: { studio: Studio }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const control = studio.state?.control;
  const globalPaused = control?.state === 'paused';
  const toggle = async (team: string, paused: boolean) => {
    if (!paused && !confirm(`Pause the ${team} team? Its agents will safe-stop at their next step.`)) return;
    setBusy(team); setErr(null);
    try { await api.control(paused ? 'resume' : 'pause', team); await studio.refetch(); }
    catch (e) { setErr(errMsg(e)); } finally { setBusy(null); }
  };
  return (
    <Card title="Team Switches" id="ops-teams" className="teams">
      {globalPaused && <p className="ops-muted">The whole studio is paused; team switches apply once it resumes.</p>}
      <ul className="team-list">
        {TEAMS.map((t) => {
          const paused = control?.teams?.[t.id] === 'paused';
          return (
            <li key={t.id}>
              <span className={'team-name ' + t.id}>{t.label}</span>
              <button type="button" role="switch" aria-checked={!paused} aria-label={`${t.label} team running`}
                className={'toggle ' + (paused ? 'off' : 'on')} disabled={busy === t.id || !control}
                onClick={() => toggle(t.label, paused)}>
                <span className="track"><span className="knob" /></span>{paused ? 'Paused' : 'Running'}
              </button>
            </li>
          );
        })}
      </ul>
      {err && <p className="ops-error" role="alert">Failed: {err}</p>}
    </Card>
  );
}

// ---------------------------------------------------------------- Budget
function Sparkline({ days }: { days: Usage['byDay'] }) {
  const W = 280, H = 70, gap = 3;
  const max = Math.max(1, ...days.map((d) => d.cloudTokens + d.localTokens));
  const bw = (W - gap * (days.length - 1)) / Math.max(1, days.length);
  const summary = days.map((d) => `${d.day}: cloud ${fmtTokens(d.cloudTokens)}, local ${fmtTokens(d.localTokens)}`).join('; ');
  return (
    <svg className="spark" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={'Daily tokens, last ' + days.length + ' days. ' + summary} preserveAspectRatio="none">
      {days.map((d, i) => {
        const hc = (d.cloudTokens / max) * (H - 2), hl = (d.localTokens / max) * (H - 2);
        const x = i * (bw + gap);
        return (
          <g key={d.day}>
            <title>{`${d.day}: cloud ${fmtTokens(d.cloudTokens)}, local ${fmtTokens(d.localTokens)}`}</title>
            <rect x={x} y={H - hl} width={bw} height={hl} className="b-local" />
            <rect x={x} y={H - hl - hc} width={bw} height={hc} className="b-cloud" />
          </g>
        );
      })}
    </svg>
  );
}

function Budget() {
  const { data, error, loading } = usePoll(api.usage, 10_000);
  let body: ReactNode;
  if (!data) body = error ? <ErrorLine msg={error} /> : loading ? <p className="ops-muted">Loading usage…</p> : null;
  else {
    const { budget, today, byAgent, byDay } = data;
    const used = today.cloudTokens, cap = budget?.dailyCloudTokens || 0;
    const pct = cap > 0 ? Math.round((used / cap) * 100) : 0;
    const level = budgetLevel(used, cap);
    const total = today.cloudTokens + today.localTokens;
    const cloudShare = total > 0 ? (today.cloudTokens / total) * 100 : 0;
    const agents = Object.entries(byAgent || {}).map(([id, v]) => ({ id, ...v, total: v.cloudTokens + v.localTokens }))
      .sort((a, b) => b.total - a.total).slice(0, 6);
    body = (
      <>
        {error && <ErrorLine msg={error} />}
        <div className="gauge-wrap">
          <div className="gauge-label"><span>Cloud (Claude) today</span><strong className={'lvl ' + level}>{fmtTokens(used)} / {cap ? fmtTokens(cap) : 'no budget'}{cap ? ` (${pct}%)` : ''}</strong></div>
          <div className={'bar gauge ' + level} role="meter" aria-label="Cloud tokens used today" aria-valuemin={0} aria-valuemax={cap || 1} aria-valuenow={Math.min(used, cap || 1)} aria-valuetext={`${pct}% of daily cloud budget`}>
            <i style={{ width: Math.min(100, pct) + '%' }} />
          </div>
          {level !== 'ok' && <p className={'lvl ' + level} role="status">{level === 'over' ? 'Daily cloud budget exceeded.' : 'Approaching the daily cloud budget.'}</p>}
        </div>
        <div className="gauge-wrap">
          <div className="gauge-label"><span>Share of tokens today</span><span className="ops-muted">{fmtTokens(total)} total</span></div>
          <div className="bar split" role="img" aria-label={`Cloud (Claude) ${cloudShare.toFixed(0)}%, Local (this PC) ${(total ? 100 - cloudShare : 0).toFixed(0)}%`}>
            <i className="b-cloud" style={{ width: cloudShare + '%' }} /><i className="b-local" style={{ width: (total ? 100 - cloudShare : 0) + '%' }} />
          </div>
          <ul className="legend">
            <li><span className="sw b-cloud" />Cloud (Claude): {fmtTokens(today.cloudTokens)} · {today.cloudCalls} calls</li>
            <li><span className="sw b-local" />Local (this PC): {fmtTokens(today.localTokens)} · {today.localCalls} calls</li>
          </ul>
          <p className="ops-muted">Calls today: <strong>{today.cloudCalls + today.localCalls}</strong></p>
        </div>
        <h3 className="sub">Last {byDay?.length || 0} days</h3>
        {byDay && byDay.length > 0 ? <Sparkline days={byDay} /> : <p className="ops-muted">No history yet.</p>}
        <h3 className="sub">Top agents by tokens</h3>
        {agents.length === 0 ? <p className="ops-muted">No agent usage recorded.</p> : (
          <div className="tbl"><table>
            <thead><tr><th scope="col">Agent</th><th scope="col" className="num">Cloud (Claude)</th><th scope="col" className="num">Local (this PC)</th><th scope="col" className="num">Calls</th></tr></thead>
            <tbody>{agents.map((a) => (
              <tr key={a.id}><th scope="row">{a.id}</th><td className="num">{fmtTokens(a.cloudTokens)}</td><td className="num">{fmtTokens(a.localTokens)}</td><td className="num">{a.calls}</td></tr>
            ))}</tbody>
          </table></div>
        )}
      </>
    );
  }
  return <Card title="Claude Budget" id="ops-budget" className="budget">{body}</Card>;
}

// ---------------------------------------------------------------- GPU
function GpuPanel() {
  const { data, error, loading } = usePoll<Gpu>(api.gpu, 3000, true);
  let body: ReactNode;
  if (!data) body = error ? <ErrorLine msg={error} /> : loading ? <p className="ops-muted">Reading GPU…</p> : null;
  else {
    const gpus = data.gpus || [], models = data.ollama || [], comfy = data.comfy;
    body = (
      <>
        {error && <ErrorLine msg={error} />}
        {gpus.length === 0 ? <p className="ops-muted">No GPU data available.</p> : gpus.map((g, i) => {
          const p = g.memTotalMB > 0 ? Math.round((g.memUsedMB / g.memTotalMB) * 100) : 0;
          return (
            <div className="gpu" key={i}>
              <div className="gauge-label"><strong>{g.name}</strong><span className="ops-muted">{g.utilPct}% util · {g.tempC}°C</span></div>
              <div className={'bar gauge ' + (p >= 100 ? 'over' : p >= 80 ? 'warn' : 'ok')} role="meter" aria-label={`${g.name} VRAM`} aria-valuemin={0} aria-valuemax={g.memTotalMB} aria-valuenow={g.memUsedMB} aria-valuetext={`${(g.memUsedMB / 1024).toFixed(1)} of ${(g.memTotalMB / 1024).toFixed(1)} GB`}>
                <i style={{ width: Math.min(100, p) + '%' }} />
              </div>
              <div className="ops-muted">VRAM {(g.memUsedMB / 1024).toFixed(1)} / {(g.memTotalMB / 1024).toFixed(1)} GB ({p}%)</div>
              <div className="bar util" role="meter" aria-label={`${g.name} utilisation`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={g.utilPct}><i style={{ width: Math.min(100, g.utilPct) + '%' }} /></div>
            </div>
          );
        })}
        <h3 className="sub">Ollama models loaded</h3>
        {models.length === 0 ? <p className="ops-muted">No models loaded right now.</p> : (
          <div className="tbl"><table>
            <thead><tr><th scope="col">Model</th><th scope="col" className="num">VRAM</th><th scope="col">Unloads at</th></tr></thead>
            <tbody>{models.map((m) => (
              <tr key={m.name}><th scope="row">{m.name}</th><td className="num">{(m.vramMB / 1024).toFixed(1)} GB</td><td>{m.until ? new Date(m.until).toLocaleTimeString() : '–'}</td></tr>
            ))}</tbody>
          </table></div>
        )}
        <h3 className="sub">ComfyUI</h3>
        {comfy ? (
          <p><span className={'pill ' + (comfy.up ? 'done' : 'blocked')}>{comfy.up ? 'up' : 'down'}</span>{' '}
            <span className="ops-muted">{comfy.up ? `${comfy.queueRunning} running · ${comfy.queuePending} pending` : 'not reachable'}</span></p>
        ) : <p className="ops-muted">No ComfyUI data.</p>}
      </>
    );
  }
  return <Card title="GPU & Models" id="ops-gpu" className="gpu-card">{body}</Card>;
}

// ---------------------------------------------------------------- Entry
export function OpsPanel({ studio }: { studio: Studio }) {
  const now = useNow();
  const runs = studio.state?.runs ?? [];
  const refetch = useCallback(() => { studio.refetch().catch(() => undefined); }, [studio]);
  return (
    <div className="ops">
      <Inbox runs={runs} now={now} refetch={refetch} />
      <RunsBoard runs={runs} now={now} />
      <TeamSwitches studio={studio} />
      <Budget />
      <GpuPanel />
    </div>
  );
}
