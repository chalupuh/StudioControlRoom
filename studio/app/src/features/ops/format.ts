// Pure helpers for the ops view.
import type { RunSummary, Provider, ProviderUsage } from '../../api';

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

export const PROVIDER_LABEL: Record<string, string> = { ollama: 'Ollama (local)', anthropic: 'Anthropic (Claude)', openai: 'OpenAI (Codex)' };

/** Rows for the provider table: known providers first in fixed order, empty ones dropped. */
export function providerRows(by: Partial<Record<Provider, ProviderUsage>> | undefined) {
  const order: Provider[] = ['ollama', 'anthropic', 'openai'];
  return order.filter((p) => by && by[p]).map((p) => ({ id: p, label: PROVIDER_LABEL[p], ...by![p]! }));
}

export const isCloudTier = (t?: string) => t === 'opus' || t === 'sonnet' || t === 'codex';

/** Budget gauge level: ok < 80%, warn >= 80%, over >= 100%. */
export function budgetLevel(used: number, budget: number): 'ok' | 'warn' | 'over' {
  if (!budget || budget <= 0) return 'ok';
  const r = used / budget;
  return r >= 1 ? 'over' : r >= 0.8 ? 'warn' : 'ok';
}

/** An attempt is an escalation when its tier differs from the stage's planned tier. */
export function isEscalation(run: RunSummary, a: RunSummary['attempts'][number]): boolean {
  const st = run.stages.find((s) => s.id === a.stage);
  return !!(st && st.tier && a.tier && st.tier !== a.tier);
}

export const needsOwner = (r: RunSummary) => r.status === 'waiting-gate' || r.status === 'blocked';
