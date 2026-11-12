// "Models in use now": every working employee grouped by the model their current stage runs on.
import type { Roster } from '../../api';
import type { AgentLive } from '../../store';
import { displayName } from './model';

export interface ModelGroup { model: string; cloud: boolean; agents: string[]; }

export function groupByModel(live: Record<string, AgentLive>): ModelGroup[] {
  const g = new Map<string, ModelGroup>();
  for (const [id, a] of Object.entries(live)) {
    if (a.status !== 'working' || !a.model) continue;
    if (!g.has(a.model)) g.set(a.model, { model: a.model, cloud: !!a.cloud, agents: [] });
    g.get(a.model)!.agents.push(id);
  }
  // local first (that's where the work should be), then by head count
  return [...g.values()].sort((x, y) => Number(x.cloud) - Number(y.cloud) || y.agents.length - x.agents.length);
}

export function ModelsNow({ live, roster, onOpen }: { live: Record<string, AgentLive>; roster?: Roster; onOpen: (id: string) => void }) {
  const groups = groupByModel(live);
  return (
    <section className="o-models" aria-label="Models in use now">
      <h2>Models in use now</h2>
      {!groups.length && <p className="o-models-none">Nobody is running a model right now.</p>}
      <div className="o-models-row">
        {groups.map((g) => (
          <div key={g.model} className={'o-model-card ' + (g.cloud ? 'cloud' : 'local')}>
            <div className="o-model-head"><i /><strong>{g.model}</strong><em>{g.cloud ? 'cloud' : 'local GPU'}</em></div>
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
