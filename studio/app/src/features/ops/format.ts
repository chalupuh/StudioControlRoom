// Pure helpers for the ops view.
import type { GateDecision, GateItem, RunSummary } from '../../api';

export function fmtDuration(ms: number): string {
  if (!isFinite(ms) || ms < 0) return '–';
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ' + (s % 60) + 's';
  const h = Math.floor(m / 60);
  if (h < 48) return h + 'h ' + (m % 60) + 'm';
  return Math.floor(h / 24) + 'd ' + (h % 24) + 'h';
}

export function fmtTokens(n: number): string {
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'k';
  return String(Math.round(n));
}

export const isCloudTier = (t?: string) => t === 'opus' || t === 'sonnet';

/** Budget gauge level: ok < 80%, warn >= 80%, over >= 100%. */
export function budgetLevel(used: number, budget: number): 'ok' | 'warn' | 'over' {
  if (!budget || budget <= 0) return 'ok';
  const r = used / budget;
  return r >= 1 ? 'over' : r >= 0.8 ? 'warn' : 'ok';
}

/** ADR 0001: agents whose Local to Claude fallback rate is above this move to Claude. */
export const FALLBACK_ALERT_RATE = 0.25;

/** Format a 0..1 rate as a whole percent ("25%"); invalid input gives a dash. */
export function fmtRate(r: number): string {
  if (!isFinite(r) || r < 0) return '–';
  return Math.round(r * 100) + '%';
}

/** Agents that ran local stages, highest fallback rate first; `alert` is true when the rate is above 25%. */
export function fallbackRows(byAgent: Record<string, { localStages: number; fallbackStages: number; fallbackRate: number }>) {
  return Object.entries(byAgent || {})
    .filter(([, v]) => v.localStages > 0)
    .map(([id, v]) => ({ id, localStages: v.localStages, fallbackStages: v.fallbackStages, rate: v.fallbackRate, alert: v.fallbackRate > FALLBACK_ALERT_RATE }))
    .sort((a, b) => b.rate - a.rate || a.id.localeCompare(b.id));
}

/** An attempt is an escalation when its tier differs from the stage's planned tier. */
export function isEscalation(run: RunSummary, a: RunSummary['attempts'][number]): boolean {
  const st = run.stages.find((s) => s.id === a.stage);
  return !!(st && st.tier && a.tier && st.tier !== a.tier);
}

export const needsOwner = (r: RunSummary) => r.status === 'waiting-gate' || r.status === 'blocked';

// ---------------------------------------------------------------- Item-decision helpers
/**
 * Derive the gate-level outcome from per-item decisions.
 * Rule (per API contract): any approve → approve, else any park → park, else reject.
 * Returns `undefined` when no items have a decision yet.
 */
export function deriveGateOutcome(items: GateItem[]): GateDecision | undefined {
  const decisions = items.map((it) => it.decision).filter(Boolean) as GateDecision[];
  if (decisions.length === 0) return undefined;
  if (decisions.some((d) => d === 'approve')) return 'approve';
  if (decisions.some((d) => d === 'park')) return 'park';
  return 'reject';
}

/** Build a label string from a GateDecision for display / summary purposes. */
export function decisionLabel(d: GateDecision): string {
  return { approve: 'Approved', park: 'Parked', reject: 'Rejected' }[d];
}

/** Count how many items are in each decision bucket. */
export function decisionCounts(items: GateItem[]) {
  const c = { approve: 0, park: 0, reject: 0, undecided: 0 };
  for (const it of items) {
    if (it.decision === 'approve') c.approve++;
    else if (it.decision === 'park') c.park++;
    else if (it.decision === 'reject') c.reject++;
    else c.undecided++;
  }
  return c;
}

/** Return a one-line summary string for the decision screen after submission. */
export function decisionSummary(items: GateItem[]): string {
  const c = decisionCounts(items);
  const parts: string[] = [];
  if (c.approve) parts.push(`${c.approve} approved`);
  if (c.park) parts.push(`${c.park} parked`);
  if (c.reject) parts.push(`${c.reject} rejected`);
  if (c.undecided) parts.push(`${c.undecided} undecided`);
  return parts.join(' · ');
}
