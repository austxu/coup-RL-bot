import type { Match, MatchVM, SeatVM, Callout } from '../game/match';
import { ART, ROLE_CLASS, pad2, pct } from '../game/labels';
import { CardView } from './CardView';
import { Icon } from './Icon';
import { Dock } from './Dock';
import { GameOver } from './GameOver';
import { Bear, type BearMood } from './Bear';
import type { LookTarget } from '../game/match';

// head pose per look target: 0 = up, clockwise as seen by the viewer
const LOOK: Record<'top' | 'bottom', Record<LookTarget, number>> = {
  top: { opponent: 8, center: 8, deck: 10, treasury: 6 },
  bottom: { opponent: 0, center: 0, deck: 14, treasury: 2 },
};

interface TableProps {
  match: Match;
  vm: MatchVM;
  embed: boolean;
  onZoom: (card: import('../engine/types').Card) => void;
  onAgain: () => void;
  onReplay: () => void;
  onLobby: () => void;
}

export function Table({ match, vm, embed, onZoom, onAgain, onReplay, onLobby }: TableProps) {
  const bottom = vm.viewer ?? 1;
  const top = 1 - bottom;
  const cur = vm.current;
  const whose =
    cur === null
      ? vm.phase === 'dealing'
        ? 'dealing'
        : vm.phase === 'over'
          ? 'game over'
          : ''
      : cur === vm.viewer
        ? 'your move'
        : `${vm.seats[cur].name.toLowerCase()}'s move`;

  return (
    <div class={`table phase-${vm.phase} ${vm.xray ? 'is-xray' : ''}`} aria-label="Coup table">
      <div class="table-bar">
        <span class="eyebrow">
          {vm.turn > 0 ? `turn ${pad2(vm.turn)}` : 'turn 00'} / {whose || '—'}
        </span>
        {vm.recap ? (
          <span class={`recap ${vm.recap.role ? ROLE_CLASS[vm.recap.role] : ''}`} title="Last action">
            <Icon name={vm.recap.icon} size={14} />
            <span class="recap-text">{vm.recap.text}</span>
          </span>
        ) : (
          <span class="recap recap-empty">
            {vm.mode === 'attract'
              ? 'Gen5 vs Gen5 · both hands shown'
              : vm.current !== null
                ? `New game · ${vm.current === vm.viewer ? 'you move' : `${vm.seats[vm.current].name} moves`} first`
                : 'Dealing a fresh hand'}
          </span>
        )}
      </div>

      <Seat match={match} vm={vm} seat={vm.seats[top]} pos="top" onZoom={onZoom} />

      <div class="table-center">
        <div class="pile deck" data-anchor="deck" aria-label={`Court deck, ${vm.deck} cards`}>
          <div class="deck-stack" aria-hidden="true">
            {[0, 1, 2].map((i) => (
              <span class="deck-card" style={{ '--i': i } as any} key={i} />
            ))}
          </div>
          <span class="pile-label">
            <span class="eyebrow">deck</span>
            <span class="pile-count">{vm.deck}</span>
          </span>
        </div>

        <Stage vm={vm} />

        <div class="pile treasury" data-anchor="treasury" aria-label="Treasury">
          <div class="coin-heap" aria-hidden="true">
            {[0, 1, 2, 3, 4].map((i) => (
              <span class="coin" style={{ '--i': i } as any} key={i} />
            ))}
          </div>
          <span class="pile-label">
            <span class="eyebrow">treasury</span>
          </span>
        </div>
      </div>

      <Seat match={match} vm={vm} seat={vm.seats[bottom]} pos="bottom" onZoom={onZoom} />

      <Dock match={match} vm={vm} embed={embed} />

      {vm.outcome && (
        <GameOver vm={vm} onAgain={onAgain} onReplay={onReplay} onLobby={onLobby} embed={embed} />
      )}
      {vm.error && (
        <div class="table-error" role="alert">
          Something went wrong: {vm.error}
          <button class="btn btn-sm" type="button" onClick={onAgain}>
            Start over
          </button>
        </div>
      )}
    </div>
  );
}

function Stage({ vm }: { vm: MatchVM }) {
  const sd = vm.showdown;
  if (sd) {
    const claimer = sd.claimer === vm.viewer ? 'You' : vm.seats[sd.claimer].name;
    return (
      <div class={`stage showdown sd-${sd.result} ${ROLE_CLASS[sd.card]}`} key={sd.id} aria-hidden="true">
        <div class="sd-card">
          <span class="sd-card-inner">
            <span class="sd-face sd-face-back" />
            <span class="sd-face sd-face-front">
              <img src={ART[sd.card].sm} alt="" />
            </span>
          </span>
          {sd.result === 'bluff' && <span class="sd-stamp">bluff</span>}
          {sd.result === 'proven' && (
            <span class="sd-check">
              <Icon name="check" size={18} />
            </span>
          )}
        </div>
        <div class="sd-copy">
          <span class="eyebrow">{sd.isBlock ? 'block challenged' : 'challenge'}</span>
          <strong>
            {sd.result === 'pending'
              ? `Does ${claimer === 'You' ? 'you' : claimer} hold ${sd.card}?`.replace('Does you', 'Do you')
              : sd.result === 'proven'
                ? `${claimer} had the ${sd.card}`
                : `${claimer} had no ${sd.card}`}
          </strong>
          <span class="sd-sub">
            {sd.result === 'pending'
              ? 'Reveal or lose an influence.'
              : sd.result === 'proven'
                ? 'Challenger loses an influence.'
                : 'Bluffer loses an influence.'}
          </span>
        </div>
      </div>
    );
  }
  if (vm.toast) {
    return (
      <div class={`stage toast tone-${vm.toast.tone}`} key={vm.toast.id} role="status">
        {vm.toast.text}
      </div>
    );
  }
  return <div class="stage stage-idle" aria-hidden="true" />;
}

function Seat({
  match,
  vm,
  seat,
  pos,
  onZoom,
}: {
  match: Match;
  vm: MatchVM;
  seat: SeatVM;
  pos: 'top' | 'bottom';
  onZoom: (c: import('../engine/types').Card) => void;
}) {
  const i = seat.idx;
  const isViewer = vm.viewer === i;
  const canSee = isViewer || vm.xray || vm.phase === 'over';
  const active = vm.current === i;
  const alive = seat.slots.filter((s) => !s.dead).length;
  const losePrompt = vm.prompt && vm.prompt.k === 'lose' && vm.prompt.p === i ? vm.prompt : null;
  const callout = vm.callouts.find((c) => c.seat === i);
  const lastValue = [...vm.values].reverse().find((v) => v.seat === i);

  return (
    <section
      class={`seat seat-${pos} ${active ? 'is-active' : ''} ${seat.eliminated ? 'is-out' : ''} ${
        seat.thinking ? 'is-thinking' : ''
      } ${vm.outcome?.winner === i ? 'is-winner' : ''}`}
      aria-label={`${isViewer ? 'Your seat' : seat.name}: ${seat.coins} coins, ${alive} influence`}
    >
      <div class="seat-info">
        <div class="seat-name-row">
          {seat.kind === 'bot' ? (
            <Bear
              class="seat-bear"
              size={pos === 'top' ? 84 : 84}
              base={botBase(vm, seat)}
              react={seat.react}
              reactKey={seat.reactKey}
              look={LOOK[pos][seat.lookAt]}
              hold={vm.phase === 'over' && vm.outcome?.winner !== i}
            />
          ) : (
            <span class="avatar avatar-human" aria-hidden="true">
              {seat.name.slice(0, 1).toUpperCase()}
            </span>
          )}
          <span class="seat-name">
            {seat.name}
            {isViewer && <span class="you-tag">you</span>}
          </span>
          {active && !seat.eliminated && <span class="turn-pill">{isViewer ? 'your turn' : 'to act'}</span>}
        </div>
        <div class="seat-stats">
          <span class="chip chip-coins" data-anchor={`seat-${i}-coins`} title="Coins">
            <span class="coin coin-sm" aria-hidden="true" />
            <span key={seat.coinPulse} class="chip-num pulse">
              {seat.coins}
            </span>
            <span class="sr-only"> coins</span>
          </span>
          <span class="chip chip-influence" title="Influence">
            {seat.slots.map((s) => (
              <span key={s.id} class={`pip ${s.dead ? 'pip-dead' : ''}`} aria-hidden="true" />
            ))}
            <span class="sr-only">{alive} influence</span>
          </span>
          {seat.kind === 'bot' && lastValue && (
            <span class="chip chip-est" title="Its own win estimate (critic)">
              <span class="eyebrow">est</span> {pct((lastValue.v + 1) / 2)}
            </span>
          )}
          {seat.coins >= 10 && !seat.eliminated && <span class="chip chip-warn">must coup</span>}
        </div>
        {seat.thinking && (
          <span class="thinking" role="status">
            thinking<span class="dots" aria-hidden="true"><i /><i /><i /></span>
          </span>
        )}
      </div>

      <div class="hand" data-anchor={`seat-${i}-hand`}>
        {seat.slots.map((s) => {
          const visible = s.dead || (canSee && s.open);
          const selectable = !!losePrompt && !s.dead;
          return (
            <CardView
              key={s.id}
              card={visible ? s.card : null}
              dead={s.dead}
              undealt={!s.dealt}
              flash={s.flash}
              flashKey={s.flashKey}
              size="md"
              anchor={`seat-${i}-slot-${s.id}`}
              xray={vm.xray && !s.dead && vm.phase !== 'over'}
              selectable={selectable}
              hint={selectable ? `Reveal ${s.card}` : undefined}
              label={
                visible
                  ? `${isViewer ? 'Your' : `${seat.name}'s`} ${s.card}${s.dead ? ' (lost)' : ''}`
                  : `${seat.name}'s hidden card`
              }
              onClick={
                selectable
                  ? () => match.answer(match.vm.seats[i].order.indexOf(s.id))
                  : visible && s.dealt
                    ? () => onZoom(s.card)
                    : undefined
              }
            />
          );
        })}
        {Array.from({ length: isViewer && vm.prompt?.k === 'exch' ? 0 : seat.extra }, (_, k) => (
          <CardView key={`x${k}`} card={null} size="md" label="Drawn card" />
        ))}
      </div>

      <div class="seat-callout">{callout && <CalloutBubble c={callout} vm={vm} />}</div>
    </section>
  );
}

function botBase(vm: MatchVM, seat: SeatVM): BearMood {
  if (seat.thinking) return 'think';
  if (vm.phase === 'over') return 'idle';
  if (vm.prompt && vm.prompt.p !== seat.idx) return vm.prompt.k === 'act' ? 'review' : 'wait';
  return 'idle';
}

function CalloutBubble({ c, vm }: { c: Callout; vm: MatchVM }) {
  const mine = c.seat === vm.viewer;
  return (
    <div class={`callout callout-${c.kind} ${c.role ? ROLE_CLASS[c.role] : ''}`} key={c.id} aria-hidden="true">
      <span class="callout-who">{mine ? 'you' : vm.seats[c.seat].name}</span>
      <span class="callout-text">
        {c.kind === 'claim' && <span class="role-dot" />}
        {c.kind === 'block' && <Icon name="block" size={14} />}
        {c.kind === 'challenge' && <Icon name="challenge" size={14} />}
        {c.kind === 'coup' && <Icon name="coup" size={14} />}
        {c.text}
      </span>
      {c.bluff === true && <span class="tag tag-bluff">bluff</span>}
      {c.bluff === false && <span class="tag tag-honest">holds it</span>}
    </div>
  );
}
