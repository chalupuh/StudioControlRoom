// "Models in use now": every working employee grouped by the model their current stage runs on.
import type { Roster } from '../../api';
import { PROVIDER_LABEL, providerOf, type AgentLive, type Provider } from '../../store';
import { displayName } from './model';

export interface ModelGroup { model: string; cloud: boolean; provider: Provider; agents: string[]; }

export function groupByModel(live: Record<string, AgentLive>): ModelGroup[] {
  const g = new Map<string, ModelGroup>();
  for (const [id, a] of Object.entries(live)) {
    if (a.status !== 'working' || !a.model) continue;
    if (!g.has(a.model)) g.set(a.model, { model: a.model, cloud: !!a.cloud, provider: a.provider || providerOf(a.model, a.tier, a.cloud), agents: [] });
    g.get(a.model)!.agents.push(id);
  }
  // local first (that's where the work should be), then Claude, then ChatGPT, then by head count
  const rank: Record<Provider, number> = { local: 0, claude: 1, chatgpt: 2 };
  return [...g.values()].sort((x, y) => rank[x.provider] - rank[y.provider] || y.agents.length - x.agents.length);
}

export function ModelsNow({ live, roster, onOpen }: { live: Record<string, AgentLive>; roster?: Roster; onOpen: (id: string) => void }) {
  const groups = groupByModel(live);
  return (
    <section className="o-models" aria-label="Models in use now">
      <div className="o-models-top">
        <h2>Models in use now</h2>
        <ul className="o-models-legend" aria-label="Providers">
          {(['local', 'claude', 'chatgpt'] as Provider[]).map((p) => (
            <li key={p} className={p}><i />{PROVIDER_LABEL[p]} <b>{groups.filter((x) => x.provider === p).reduce((n, x) => n + x.agents.length, 0)}</b></li>
          ))}
        </ul>
      </div>
      {!groups.length && <p className="o-models-none">Nobody is running a model right now.</p>}
      <div className="o-models-row">
        {groups.map((g) => (
          <div key={g.model} className={'o-model-card ' + g.provider}>
            <div className="o-model-head"><i /><strong>{g.model}</strong><em>{PROVIDER_LABEL[g.provider]}</em></div>
            <div className="o-model-who">
              {g.agents.map((id) => (
                <button key={id} type="button" onClick={() => onOpen(id)}>{displayName(id, roster?.agents?.[id])}</button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
