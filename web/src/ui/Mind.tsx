import { useEffect, useRef } from 'preact/hooks';
import type { MatchVM, MindEntry } from '../game/match';
import { ROLE_CLASS, pct } from '../game/labels';
import { Icon } from './Icon';
import { BeliefPanel } from './Belief';

const SERIES = ['var(--accent)', 'var(--blue)'];

export function Sparkline({
  values,
  seats,
  cursor,
  height = 56,
  label,
}: {
  values: { seat: number; v: number; n: number }[];
  seats: number[];
  cursor?: number | null;
  height?: number;
  label: string;
}) {
  const W = 300;
  const H = height;
  const pad = 4;
  const n = Math.max(values.length - 1, 1);
  const x = (k: number) => pad + (k / n) * (W - 2 * pad);
  const y = (v: number) => pad + (1 - (v + 1) / 2) * (H - 2 * pad);
  return (
    <svg class="spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={label}>
      <line class="spark-mid" x1={0} x2={W} y1={y(0)} y2={y(0)} />
      {seats.map((s, si) => {
        const pts = values.map((p, k) => ({ k, p })).filter((q) => q.p.seat === s);
        if (pts.length === 0) return null;
        const d = pts.map((q, j) => `${j ? 'L' : 'M'}${x(q.k).toFixed(1)},${y(q.p.v).toFixed(1)}`).join(' ');
        const area = `${d} L${x(pts.at(-1)!.k).toFixed(1)},${H} L${x(pts[0].k).toFixed(1)},${H} Z`;
        const last = pts.at(-1)!;
        return (
          <g key={s} style={{ '--c': SERIES[si % 2] } as any}>
            {seats.length === 1 && <path class="spark-area" d={area} />}
            <path class="spark-line" d={d} vector-effect="non-scaling-stroke" />
            <circle class="spark-dot" cx={x(last.k)} cy={y(last.p.v)} r={2.6} />
          </g>
        );
      })}
      {cursor != null && values.length > 0 && (
        <line class="spark-cursor" x1={x(cursor)} x2={x(cursor)} y1={0} y2={H} vector-effect="non-scaling-stroke" />
      )}
    </svg>
  );
}

export function PolicyBars({ entry, compact = false }: { entry: MindEntry; compact?: boolean }) {
  if (entry.req === 'EXCH') {
    return (
      <p class="mind-note">
        Exchanges use a fixed rule (keep the highest-value roles: Duke &gt; Assassin &gt; Captain &gt; Ambassador &gt;
        Contessa), so there is no policy to show.
      </p>
    );
  }
  const opts = [...entry.options].sort((a, b) => b.prob - a.prob);
  return (
    <ul class={`bars ${compact ? 'bars-compact' : ''}`} aria-label={`Policy for: ${entry.title}`}>
      {opts.map((o) => (
        <li
          key={o.idx}
          class={`bar ${o.chosen ? 'is-chosen' : ''} ${o.role ? ROLE_CLASS[o.role] : ''}`}
          aria-label={`${o.label}: ${pct(o.prob)}${o.chosen ? ', chosen' : ''}`}
        >
          <span class="bar-label">
            {o.role && <span class="role-dot" aria-hidden="true" />}
            {o.label}
            {o.chosen && (
              <span class="bar-chosen" aria-hidden="true">
                <Icon name="check" size={12} />
              </span>
            )}
          </span>
          <span class="bar-track" aria-hidden="true">
            <span class="bar-fill" style={{ width: `${Math.max(o.prob * 100, 0.6)}%` }} />
          </span>
          <span class="bar-pct" aria-hidden="true">
            {o.prob < 0.005 ? '<1%' : pct(o.prob)}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function MindPanel({ vm }: { vm: MatchVM }) {
  const bots = vm.seats.filter((s) => s.kind === 'bot').map((s) => s.idx);
  const last = vm.mind.at(-1);
  const latestFor = (s: number) => [...vm.values].reverse().find((v) => v.seat === s);
  const primary = bots[0];
  const lv = primary !== undefined ? latestFor(primary) : undefined;
  const first = vm.values.find((v) => v.seat === primary);
  const delta = lv && first ? (lv.v - first.v) / 2 : 0;

  return (
    <section class="panel mind" aria-labelledby="mind-h">
      <header class="panel-head">
        <span class="eyebrow" id="mind-h">
          02 / bot's mind
        </span>
        <span class="panel-meta">
          {[...new Set(bots.map((b) => vm.seats[b].model))].join(' vs ')} · lstm 256
        </span>
      </header>

      <div class="winest">
        {bots.length === 1 ? (
          <>
            <div class="winest-top">
              <span class="winest-num" aria-live="off">
                {lv ? pct((lv.v + 1) / 2) : '—'}
              </span>
              <span class="winest-label">
                {vm.seats[primary].name}'s own win estimate
                {lv && vm.values.filter((v) => v.seat === primary).length > 1 && (
                  <span class={`delta ${delta >= 0 ? 'up' : 'down'}`}>
                    {delta >= 0 ? '+' : '−'}
                    {Math.abs(Math.round(delta * 100))} pts
                  </span>
                )}
              </span>
            </div>
            <div class="meter" aria-hidden="true">
              <span class="meter-fill" style={{ width: lv ? `${((lv.v + 1) / 2) * 100}%` : '50%' }} />
              <span class="meter-mid" />
            </div>
          </>
        ) : (
          <div class="winest-duo">
            {bots.map((s, si) => {
              const v = latestFor(s);
              return (
                <div class="duo" key={s} style={{ '--c': SERIES[si] } as any}>
                  <span class="duo-name">
                    <span class="swatch" /> {vm.seats[s].name}
                  </span>
                  <span class="winest-num sm">{v ? pct((v.v + 1) / 2) : '—'}</span>
                </div>
              );
            })}
          </div>
        )}
        <Sparkline
          values={vm.values}
          seats={bots}
          label={
            lv
              ? `Win estimate over ${vm.values.length} decisions, now ${pct((lv.v + 1) / 2)}`
              : 'No decisions yet'
          }
        />
        <span class="spark-caption">
          critic value (v+1)/2 after each decision · dashed line = 50%
        </span>
      </div>

      <BeliefPanel vm={vm} />

      <div class="decision" aria-live="polite">
        {last ? (
          <>
            <div class="decision-head">
              <span class="eyebrow">
                last decision{bots.length > 1 ? ` · ${vm.seats[last.seat].name}` : ''}
              </span>
              <strong class="decision-title">{last.title}</strong>
            </div>
            <PolicyBars entry={last} />
            {last.sampledBelowTop && (
              <p class="mind-note">
                <Icon name="spark" size={12} /> Sampled a less likely option — the bot plays a mixed strategy, not argmax.
              </p>
            )}
          </>
        ) : (
          <p class="empty">
            After every bot decision, its probability over the legal options appears here. Hidden cards never do.
          </p>
        )}
      </div>
    </section>
  );
}

export function Timeline({ vm }: { vm: MatchVM }) {
  const ref = useRef<HTMLOListElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [vm.log.length]);
  let lastTurn = -1;
  return (
    <section class="panel timeline" aria-labelledby="tl-h">
      <header class="panel-head">
        <span class="eyebrow" id="tl-h">
          03 / timeline
        </span>
        <span class="panel-meta">{vm.turn ? `${vm.turn} turns` : ''}</span>
      </header>
      <ol
        class="log"
        ref={ref}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
        tabIndex={0}
        aria-label="Game log"
      >
        {vm.log.length === 0 && <li class="empty">Moves will appear here.</li>}
        {vm.log.map((e) => {
          const head = e.turn !== lastTurn && e.turn > 0;
          lastTurn = e.turn;
          return (
            <li key={e.id} class={`log-item tone-${e.tone} ${e.role ? ROLE_CLASS[e.role] : ''} ${head ? 'has-head' : ''}`}>
              {head && <span class="log-turn">t{String(e.turn).padStart(2, '0')}</span>}
              <span class="log-icon">
                <Icon name={e.icon} size={14} />
              </span>
              <span class="log-text">{e.text}</span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
