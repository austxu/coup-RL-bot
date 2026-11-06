import type { Belief, MatchVM } from '../game/match';
import { CARDS, type Card } from '../engine/types';
import { ROLE_CLASS, pct } from '../game/labels';

/** Per-role "P(holds at least one)" bars, with the change since the previous belief and the truth (when shown). */
export function BeliefBars({
  b,
  prev,
  showTruth,
  truthLabel,
}: {
  b: Belief;
  prev?: Belief | null;
  showTruth: boolean;
  truthLabel: string;
}) {
  const held = (c: Card) => b.truth.filter((x) => x === c).length;
  return (
    <>
      <ul class="brows" aria-label="Probability the opponent holds each role">
        {CARDS.map((c, r) => {
          const p = b.roles[r];
          const d = prev ? p - prev.roles[r] : 0;
          const h = showTruth ? held(c) : 0;
          return (
            <li
              class={`brow ${ROLE_CLASS[c]} ${h ? 'is-held' : ''}`}
              key={c}
              aria-label={`${c}: ${pct(p)}${Math.abs(d) >= 0.05 ? `, ${d > 0 ? 'up' : 'down'} ${Math.round(Math.abs(d) * 100)} points` : ''}${h ? `, ${truthLabel}` : ''}`}
            >
              <span class="brow-name">
                <span class="role-dot" aria-hidden="true" />
                {c}
              </span>
              <span class="brow-track" aria-hidden="true">
                <span class="brow-fill" style={{ width: `${Math.max(p * 100, 0.8)}%` }} />
                {prev && <span class="brow-prev" style={{ left: `${prev.roles[r] * 100}%` }} />}
              </span>
              <span class="brow-pct" aria-hidden="true">
                {p < 0.005 ? '<1%' : pct(p)}
              </span>
              <span class={`brow-delta ${d > 0 ? 'up' : 'down'}`} aria-hidden="true">
                {Math.abs(d) >= 0.05 ? `${d > 0 ? '+' : '−'}${Math.round(Math.abs(d) * 100)}` : ''}
              </span>
              <span class="brow-truth" aria-hidden="true" title={h ? truthLabel : undefined}>
                {h ? (h > 1 ? '●●' : '●') : ''}
              </span>
            </li>
          );
        })}
      </ul>
      {b.top.length > 0 && (
        <p class="btop">
          <span class="eyebrow">most likely</span>
          {b.top.slice(0, 2).map((t, k) => (
            <span class="btop-hand" key={k}>
              {t.cards.map((c, j) => (
                <span class={`btop-card ${ROLE_CLASS[c]}`} key={j}>
                  {c}
                </span>
              ))}
              <span class="btop-p">{pct(t.p)}</span>
            </span>
          ))}
        </p>
      )}
    </>
  );
}

/** "Reading your hand": the latest belief of the (first) Gen7 seat about its opponent. */
export function BeliefPanel({ vm }: { vm: MatchVM }) {
  const reader = vm.seats.find((s) => s.kind === 'bot' && s.model === 'gen7');
  if (!reader) {
    const bot = vm.seats.find((s) => s.kind === 'bot');
    if (!bot) return null;
    return (
      <div class="belief belief-off">
        <span class="eyebrow">reading your hand</span>
        <p class="mind-note">Gen 5 has no belief head. Pick Gen 7 in the lobby to see what the bot thinks you hold.</p>
      </div>
    );
  }
  const series = vm.beliefs.filter((x) => x.seat === reader.idx);
  const cur = series.at(-1);
  const prev = series.at(-2);
  const target = 1 - reader.idx;
  const you = vm.viewer === target;
  const whose = you ? 'your' : `${vm.seats[target].name}'s`;
  const showTruth = you || vm.xray || vm.phase === 'over';
  return (
    <div class="belief" aria-live="off">
      <div class="belief-head">
        <span class="eyebrow">
          {vm.seats.filter((s) => s.kind === 'bot').length > 1 ? `${reader.name} reads ${whose} hand` : `reading ${whose} hand`}
        </span>
        <span class="panel-meta">belief head</span>
      </div>
      {cur ? (
        <>
          <BeliefBars b={cur.b} prev={prev?.b} showTruth={showTruth} truthLabel={you ? 'you hold it' : 'actually held'} />
          <p class="belief-cap">
            P({you ? 'you hold' : 'holds'} ≥1) after each of {reader.name === 'PPO-AI' ? 'its' : `${reader.name}'s`} decisions
            {showTruth ? ` · ● ${you ? 'your cards' : 'true hand'}` : ''}
          </p>
        </>
      ) : (
        <p class="mind-note">
          After its first decision, the bot's guess at {whose} two hidden cards appears here — learned from claims, blocks
          and challenges, with impossible hands ruled out by card counting.
        </p>
      )}
    </div>
  );
}

/** Replay heatmap: one column per belief update, one row per role; dots mark the true hand at the time. */
export function BeliefStrip({ vm, cursorTurn, cursorN }: { vm: MatchVM; cursorTurn: number; cursorN: number | null }) {
  const reader = vm.seats.find((s) => s.kind === 'bot' && s.model === 'gen7');
  if (!reader) return null;
  const series = vm.beliefs.filter((x) => x.seat === reader.idx);
  if (series.length < 2) return null;
  const W = series.length;
  return (
    <div class="bstrip" role="img" aria-label={`Belief over ${W} decisions about the opponent's roles`}>
      <span class="eyebrow bstrip-h">
        {reader.name}'s belief about {vm.viewer === 1 - reader.idx ? 'your' : `${vm.seats[1 - reader.idx].name}'s`} hand, decision by decision
      </span>
      <div class="bstrip-grid" style={{ '--cols': W } as any}>
        {CARDS.map((c, r) => (
          <div class={`bstrip-row ${ROLE_CLASS[c]}`} key={c}>
            <span class="bstrip-label">{c}</span>
            <span class="bstrip-cells">
              {series.map((x, k) => (
                <span
                  key={k}
                  class={`bstrip-cell ${x.b.truth.includes(c) ? 'is-held' : ''} ${cursorN === x.n ? 'is-cur' : ''}`}
                  style={{ '--p': x.b.roles[r] } as any}
                  title={`turn ${x.turn}: ${pct(x.b.roles[r])}`}
                />
              ))}
            </span>
          </div>
        ))}
      </div>
      <span class="bstrip-cap">
        brighter = more confident · ● = actually held then · turn {cursorTurn}
      </span>
    </div>
  );
}
