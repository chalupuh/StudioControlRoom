import { useState } from 'react';
import type { Character, ModelInfo, Team } from '../../api';
import type { AgentLive } from '../../store';
import { STATUS_VAR, TEAM_VAR, displayName, initials } from './model';

/** Portrait image with a generated SVG avatar fallback (initials on the character colour). */
export function Portrait({ id, c, size }: { id: string; c?: Character; size: number }) {
  const [failed, setFailed] = useState(false);
  const name = displayName(id, c);
  if (c?.portrait && !failed) {
    return <img className="o-portrait" src={c.portrait} alt="" width={size} height={size} loading="lazy" onError={() => setFailed(true)} />;
  }
  const fill = c?.color || 'var(--faint)';
  return (
    <svg className="o-portrait o-avatar-fallback" width={size} height={size} viewBox="0 0 100 100" aria-hidden="true">
      <rect width="100" height="100" fill={fill} />
      <circle cx="50" cy="38" r="18" fill="#fff" opacity=".22" />
      <path d="M14 100c0-22 16-36 36-36s36 14 36 36z" fill="#fff" opacity=".22" />
      <text x="50" y="62" textAnchor="middle" fontSize="34" fontWeight="700" fill="#fff" fontFamily="var(--font)">{initials(name)}</text>
    </svg>
  );
}

/** Circular progress ring around a portrait. */
export function Ring({ pct, status, size, children }: { pct: number; status: string; size: number; children: React.ReactNode }) {
  const stroke = Math.max(3, Math.round(size / 16));
  const r = (size - stroke) / 2, circ = 2 * Math.PI * r;
  const clamped = Math.max(0, Math.min(100, pct));
  const inner = size - stroke * 2 - 4;
  return (
    <div className="o-ring" style={{ width: size, height: size }}>
      <svg width={size} height={size} aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--line)" strokeWidth={stroke} />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={STATUS_VAR[status] || 'var(--idle)'} strokeWidth={stroke} strokeLinecap="round"
          strokeDasharray={circ} strokeDashoffset={circ * (1 - clamped / 100)} transform={`rotate(-90 ${size / 2} ${size / 2})`} />
      </svg>
      <div className="o-ring-in" style={{ width: inner, height: inner }}>{children}</div>
    </div>
  );
}

export function StatusPill({ status }: { status: string }) {
  return <span className="o-pill" style={{ ['--st' as string]: STATUS_VAR[status] || 'var(--idle)' }}><i />{status}</span>;
}

/** The model this employee is using right now (bright, pulsing while working; dim "last" when idle). */
export function LiveModel({ live }: { live?: AgentLive }) {
  if (!live?.model) return null;
  const on = live.status === 'working';
  const kind = live.cloud ? 'cloud' : 'local';
  return (
    <span className={'o-live ' + kind + (on ? ' on' : '')} title={(on ? 'Using now: ' : 'Last used: ') + live.model + (live.cloud ? ' (cloud)' : ' (local GPU)')}>
      <i />{on ? '' : 'last: '}{live.model}<em>{live.cloud ? 'cloud' : 'local'}</em>
    </span>
  );
}

export function ModelChips({ info }: { info?: ModelInfo }) {
  if (!info || (!info.brain && !info.local?.length)) return null;
  return (
    <div className="o-chips">
      {info.brain && <span className="o-chip brain" title="Brain model">{info.brain}</span>}
      {info.local?.map((m) => (
        <span key={m.ref + m.name} className={'o-chip ' + (m.installed ? 'local' : 'missing')} title={m.installed ? 'Local model' : 'Local model not installed'}>
          {m.name}{m.installed ? '' : ' (not installed)'}
        </span>
      ))}
    </div>
  );
}

interface CardProps {
  id: string; c?: Character; team: Team; live?: AgentLive; models?: ModelInfo;
  head?: boolean; onOpen: (id: string) => void; flash?: boolean;
}

export function AgentCard({ id, c, team, live, models, head, onOpen }: CardProps) {
  const status = live?.status ?? 'idle';
  const name = displayName(id, c);
  const title = c?.title || (head ? 'Team lead' : 'Agent');
  return (
    <button
      type="button"
      className={'o-card' + (head ? ' head' : '') + (status === 'working' ? ' working' : '')}
      style={{ ['--accent' as string]: TEAM_VAR[team], ['--st' as string]: STATUS_VAR[status] }}
      onClick={() => onOpen(id)}
      aria-label={`${name}, ${title}, ${status}. Open profile`}
      data-agent={id}
    >
      <div className="o-card-top">
        <Ring pct={live?.pct ?? 0} status={status} size={head ? 72 : 60}>
          <Portrait id={id} c={c} size={head ? 60 : 48} />
        </Ring>
        <div className="o-card-id">
          <strong className="o-name">{name}</strong>
          <span className="o-title">{title}</span>
          <StatusPill status={status} />
          <LiveModel live={live} />
        </div>
      </div>
      <p className="o-task">{live?.task || <em>No active task</em>}</p>
      <ModelChips info={models} />
    </button>
  );
}
