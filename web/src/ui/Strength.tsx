import { useEffect, useState } from 'preact/hooks';

interface Row {
  id: string;
  label: string;
  games: number;
  winRate: number;
  ci95: [number, number];
}
interface Evaluation {
  gamesPerOpponent: number;
  models?: { id: string; opponents: Row[] }[];
  opponents: Row[];
  belief?: { pooled: { top1: number; priorTop1: number; logLoss: number; priorLogLoss: number } };
}

// strongest opponents first; these are the rows worth showing
const ORDER = ['gen5', 'gen3', 'gen4', 'cfr', 'gen2', 'gen1', 'heuristic', 'zoo', 'random'];
const SHORT: Record<string, string> = {
  gen1: 'PPO Gen 1',
  gen2: 'PPO Gen 2',
  gen3: 'PPO Gen 3',
  gen4: 'PPO Gen 4',
  gen5: 'PPO Gen 5',
  cfr: 'CFR strategy',
  heuristic: 'Heuristic',
  zoo: 'Zoo profiles',
  random: 'Random',
};
const pct = (x: number) => `${Math.round(x * 1000) / 10}%`;

/** Lobby card: Gen 7's head-to-head win rates (95% CI) with Gen 5's for reference. */
export function StrengthCard() {
  const [data, setData] = useState<Evaluation | null>(null);
  useEffect(() => {
    let live = true;
    fetch('data/evaluation.json')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => live && setData(d))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  if (!data) return null;
  const g7 = data.models?.find((m) => m.id === 'gen7')?.opponents ?? data.opponents;
  const g5 = data.models?.find((m) => m.id === 'gen5')?.opponents ?? [];
  const rows = ORDER.map((id) => g7.find((r) => r.id === id)).filter((r): r is Row => !!r);
  const b = data.belief?.pooled;
  return (
    <section class="strength" aria-labelledby="str-h">
      <div class="roles-head">
        <span class="eyebrow" id="str-h">
          03 / how strong is it
        </span>
        <span class="panel-meta">{data.gamesPerOpponent.toLocaleString()} games each</span>
      </div>
      <div class="str-legend" aria-hidden="true">
        <span>
          <i class="str-key-dot" /> Gen 7 win rate, 95% CI
        </span>
        <span>
          <i class="str-key-tick" /> Gen 5 vs the same bot
        </span>
      </div>
      <table class="str-table">
        <caption class="sr-only">Gen 7 head-to-head win rate against each opponent, with Gen 5 for comparison</caption>
        <thead class="sr-only">
          <tr>
            <th scope="col">Opponent</th>
            <th scope="col">Gen 7 win rate (95% CI)</th>
            <th scope="col">Gen 5 win rate</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const old = g5.find((x) => x.id === r.id);
            const sig = r.ci95[0] > 0.5;
            return (
              <tr key={r.id} class={sig ? '' : 'is-even'}>
                <th scope="row" class="str-name">
                  {SHORT[r.id] ?? r.label}
                </th>
                <td class="str-plot" title={`Gen 7 ${pct(r.winRate)} (${pct(r.ci95[0])}–${pct(r.ci95[1])})${old ? ` · Gen 5 ${pct(old.winRate)}` : ''}`}>
                  <span class="str-track" aria-hidden="true">
                    <span class="str-mid" />
                    <span class="str-ci" style={{ left: `${r.ci95[0] * 100}%`, width: `${(r.ci95[1] - r.ci95[0]) * 100}%` }} />
                    {old && <span class="str-tick" style={{ left: `${old.winRate * 100}%` }} />}
                    <span class="str-dot" style={{ left: `${r.winRate * 100}%` }} />
                  </span>
                  <span class="sr-only">
                    {pct(r.winRate)}, 95% CI {pct(r.ci95[0])} to {pct(r.ci95[1])}
                  </span>
                </td>
                <td class="str-val">
                  {pct(r.winRate)}
                  {old && <span class="sr-only"> (Gen 5: {pct(old.winRate)})</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {b && (
        <p class="str-note">
          Belief head names your exact hand <strong>{pct(b.top1)}</strong> of the time (card counting alone:{' '}
          {pct(b.priorTop1)}). Bot-vs-bot games; humans play differently.
        </p>
      )}
    </section>
  );
}
