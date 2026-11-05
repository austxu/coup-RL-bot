import type { Card } from '../engine/types';
import { ART, BEAR, ROLE_CLASS } from '../game/labels';

export interface CardViewProps {
  /** The face to show, or null when the viewer may not see it (never rendered). */
  card: Card | null;
  dead?: boolean;
  undealt?: boolean;
  flash?: string;
  flashKey?: number;
  size?: 'xs' | 'sm' | 'md' | 'lg';
  anchor?: string;
  label?: string;
  onClick?: () => void;
  selected?: boolean;
  selectable?: boolean;
  hint?: string;
  xray?: boolean;
}

export function CardView(p: CardViewProps) {
  const up = p.card !== null;
  const cls = [
    'card',
    `card-${p.size ?? 'md'}`,
    up ? 'is-up' : 'is-down',
    p.dead ? 'is-dead' : '',
    p.undealt ? 'is-undealt' : '',
    p.card ? ROLE_CLASS[p.card] : '',
    p.selected ? 'is-selected' : '',
    p.selectable ? 'is-selectable' : '',
    p.xray ? 'is-xray' : '',
  ]
    .filter(Boolean)
    .join(' ');
  const label = p.label ?? (p.card ? `${p.card}${p.dead ? ', lost' : ''}` : 'Hidden card');
  const body = (
    <>
      <span class="card-inner">
        <span class="card-face card-back" aria-hidden="true">
          <img src={BEAR.sm} alt="" draggable={false} />
        </span>
        <span class="card-face card-front" aria-hidden="true">
          {p.card && (
            <img
              src={ART[p.card].sm}
              srcset={`${ART[p.card].sm} 320w, ${ART[p.card].lg} 720w`}
              sizes={p.size === 'lg' ? '(max-width: 640px) 60vw, 300px' : '160px'}
              alt=""
              draggable={false}
              decoding="async"
            />
          )}
        </span>
      </span>
      {p.dead && <span class="card-dead" aria-hidden="true" />}
      {p.flash && <span key={p.flashKey} class={`card-flash flash-${p.flash}`} aria-hidden="true" />}
      {p.hint && <span class="card-hint">{p.hint}</span>}
    </>
  );
  if (p.onClick) {
    return (
      <button
        type="button"
        class={cls}
        data-anchor={p.anchor}
        onClick={p.onClick}
        aria-label={label}
        aria-pressed={p.selectable ? !!p.selected : undefined}
      >
        {body}
      </button>
    );
  }
  return (
    <span class={cls} data-anchor={p.anchor} role="img" aria-label={label}>
      {body}
    </span>
  );
}
