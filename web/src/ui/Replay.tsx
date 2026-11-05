import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Frame, MatchVM } from '../game/match';
import { ROLE_CLASS, pct } from '../game/labels';
import { CardView } from './CardView';
import { Icon } from './Icon';
import { PolicyBars, Sparkline } from './Mind';
import { summaryLines } from './GameOver';
import { Bear, type BearMood } from './Bear';
import { BeliefBars, BeliefStrip } from './Belief';

/** The bot narrates its own decisions in the post-mortem. */
function narrate(f: Frame, vm: MatchVM): { line: string; mood: BearMood } {
  const botSeat = vm.seats[f.seat].kind === 'bot';
  const you = vm.viewer !== null;
  const me = f.seats[f.seat];
  const hand = me.cards.join(' + ') || 'nothing';
  if (!botSeat) {
    if (f.challenge) return f.challenge.won ? { line: 'You called my bluff there. Fair.', mood: 'fail' } : { line: 'You challenged — but I had it.', mood: 'jump' };
    if (f.claim && !f.claim.held) return { line: `You claimed ${f.claim.card} without it.${f.caught ? ' I caught that one.' : ' I let it go.'}`, mood: f.caught ? 'jump' : 'review' };
    return { line: you ? 'Your move. I was watching.' : `${me.name} to decide.`, mood: 'review' };
  }
  if (f.claim && !f.claim.held)
    return f.caught
      ? { line: `I claimed ${f.claim.card} holding ${hand}. Caught.`, mood: 'fail' }
      : { line: `I claimed ${f.claim.card} holding ${hand}. Nobody checked.`, mood: 'wait' };
  if (f.claim) return { line: `${f.claim.card}? I really had it.`, mood: 'idle' };
  if (f.challenge) return f.challenge.won ? { line: 'I smelled a bluff — and was right.', mood: 'jump' } : { line: 'I challenged, and was wrong.', mood: 'fail' };
  if (f.kind === 'exch') return { line: 'Exchange: I keep my best roles by rule.', mood: 'think' };
  if (f.kind === 'lose') return { line: 'Which one to give up…', mood: 'fail' };
  return { line: `Holding ${hand}. ${f.mind && f.mind.value !== null ? `I gave myself ${pct((f.mind.value + 1) / 2)}.` : ''}`, mood: 'think' };
}

function flagOf(f: Frame): { cls: string; label: string } | null {
  if (f.claim && !f.claim.held) return { cls: f.caught ? 'flag-caught' : 'flag-bluff', label: f.caught ? 'bluff caught' : 'bluff' };
  if (f.challenge) return { cls: 'flag-challenge', label: f.challenge.won ? 'challenge won' : 'challenge lost' };
  if (f.kind === 'blk' && f.claim) return { cls: 'flag-block', label: 'block' };
  return null;
}

export function Replay({ vm, onClose, onAgain }: { vm: MatchVM; onClose: () => void; onAgain: () => void }) {
  const frames = vm.frames;
  const [i, setI] = useState(() => Math.max(0, frames.findIndex((f) => f.claim && !f.claim.held && vm.seats[f.seat].kind === 'bot')));
  const [botOnly, setBotOnly] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const f = frames[i];
  const bot = vm.seats.findIndex((s) => s.kind === 'bot');

  const visible = useMemo(
    () => frames.map((fr, k) => ({ fr, k })).filter(({ fr }) => !botOnly || vm.seats[fr.seat].kind === 'bot'),
    [botOnly, frames],
  );
  const step = (d: number) => {
    const pos = visible.findIndex((v) => v.k === i);
    const next = visible[Math.max(0, Math.min(visible.length - 1, (pos < 0 ? 0 : pos) + d))];
    if (next) setI(next.k);
  };

  useEffect(() => {
    rootRef.current?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (document.querySelector('dialog[open]')) return;
      if (e.key === 'ArrowRight' || e.key === 'j') step(1);
      else if (e.key === 'ArrowLeft' || e.key === 'k') step(-1);
      else if (e.key === 'Home') setI(visible[0]?.k ?? 0);
      else if (e.key === 'End') setI(visible.at(-1)?.k ?? 0);
      else if (e.key === 'Escape') onClose();
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [i, visible]);

  if (!f) {
    return (
      <div class="replay">
        <p class="empty">No decisions were recorded.</p>
        <button class="btn" type="button" onClick={onClose}>
          Back
        </button>
      </div>
    );
  }

  // value index for the sparkline cursor: last bot value at or before this frame
  const valueIdx = (() => {
    let n: number | null = null;
    for (let k = 0; k <= i; k++) {
      const m = frames[k].mind;
      if (m && m.value !== null) n = vm.values.findIndex((v) => v.seat === m.seat && v.turn === m.turn && v.v === m.value);
    }
    return n;
  })();
  const beliefIdx = (() => {
    let n: number | null = null;
    for (let k = 0; k <= i; k++) {
      const b = frames[k].mind?.belief;
      if (b) n = vm.beliefs.find((x) => x.b === b)?.n ?? n;
    }
    return n;
  })();
  const flag = flagOf(f);
  const o = vm.outcome;
  const bluffList = frames.filter((fr) => fr.claim && !fr.claim.held);

  return (
    <div class="replay" ref={rootRef} tabIndex={-1} aria-labelledby="rp-h">
      <header class="replay-head">
        <div>
          <span class="eyebrow">post-mortem / {frames.length} decisions / {o?.turns ?? 0} turns</span>
          <h1 id="rp-h" class="replay-h">
            {o?.winner == null ? 'Draw' : o.winner === vm.viewer ? 'You won' : `${vm.seats[o.winner].name} won`} — every
            card, every bluff
          </h1>
        </div>
        <div class="replay-actions">
          <button type="button" class="btn btn-primary" onClick={onAgain}>
            <Icon name="play" /> Play again
          </button>
          <button type="button" class="btn" onClick={onClose}>
            <Icon name="x" /> Close
          </button>
        </div>
      </header>

      <ul class="replay-summary">
        {summaryLines(vm).map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>

      <div class="replay-grid">
        <section class="panel rp-board" aria-label="Board at this decision">
          <header class="panel-head">
            <span class="eyebrow">board · turn {String(f.turn).padStart(2, '0')}</span>
            <span class="panel-meta">deck {f.deck}</span>
          </header>
          {f.seats.map((s, si) => (
            <div class={`rp-seat ${si === f.seat ? 'is-deciding' : ''}`} key={si}>
              <div class="rp-seat-head">
                <strong>{si === vm.viewer ? 'You' : s.name}</strong>
                <span class="chip chip-coins">
                  <span class="coin coin-sm" aria-hidden="true" /> {s.coins}
                </span>
                {s.kind === 'bot' && vm.viewer !== null && (
                  <span class="tag tag-xray">
                    <Icon name="eye" size={12} /> hidden during play
                  </span>
                )}
              </div>
              <div class="mini-hand">
                {s.cards.map((c, k) => (
                  <CardView key={`a${k}`} card={c} size="sm" xray={s.kind === 'bot' && vm.viewer !== null} />
                ))}
                {s.revealed.map((c, k) => (
                  <CardView key={`d${k}`} card={c} size="sm" dead />
                ))}
              </div>
            </div>
          ))}
        </section>

        <section class="panel rp-decision" aria-live="polite">
          <header class="panel-head">
            <span class="eyebrow">
              decision {i + 1} / {frames.length}
            </span>
            {flag && <span class={`flag ${flag.cls}`}>{flag.label}</span>}
          </header>
          <h2 class="rp-q">{f.question}</h2>
          {bot >= 0 && (() => {
            const nr = narrate(f, vm);
            return (
              <div class="narrator">
                <Bear base={nr.mood === 'jump' || nr.mood === 'fail' ? 'idle' : nr.mood} react={nr.mood === 'jump' || nr.mood === 'fail' ? nr.mood : null} reactKey={i} size={72} hold={nr.mood === 'fail'} />
                <p class="narrator-line">{nr.line}</p>
              </div>
            );
          })()}
          <p class="rp-choice">
            <Icon name="arrowRight" size={14} /> {vm.seats[f.seat].kind === 'human' && f.seat === vm.viewer ? 'You chose' : 'Chose'}{' '}
            <strong>{f.choice}</strong>
            {f.claim && (
              <span class={`claim ${f.claim.held ? '' : 'claim-bluff'} ${ROLE_CLASS[f.claim.card]}`}>
                {f.claim.held ? `held ${f.claim.card}` : `no ${f.claim.card} in hand`}
              </span>
            )}
          </p>
          {f.mind ? (
            <>
              {f.mind.value !== null && (
                <p class="rp-value">
                  win estimate after this decision: <strong>{pct((f.mind.value + 1) / 2)}</strong>
                </p>
              )}
              <PolicyBars entry={f.mind} />
              {f.mind.belief && (
                <div class="belief rp-belief">
                  <span class="eyebrow">
                    what it thought {1 - f.seat === vm.viewer ? 'you' : vm.seats[1 - f.seat].name} held
                  </span>
                  <BeliefBars
                    b={f.mind.belief}
                    showTruth
                    truthLabel={1 - f.seat === vm.viewer ? 'you held it' : 'actually held'}
                  />
                </div>
              )}
            </>
          ) : vm.seats[f.seat].kind === 'human' ? (
            <p class="mind-note">Your decision — no policy to show.</p>
          ) : null}
          {f.after.length > 0 && (
            <div class="rp-after">
              <span class="eyebrow">then</span>
              <ul>
                {f.after.map((t, k) => (
                  <li key={k}>{t}</li>
                ))}
              </ul>
            </div>
          )}
        </section>
      </div>

      <section class="panel rp-scrub" aria-label="Timeline scrubber">
        <div class="rp-scrub-top">
          <button type="button" class="btn btn-sm" onClick={() => step(-1)} aria-label="Previous decision">
            <Icon name="arrowLeft" />
          </button>
          <div class="rp-track">
          <input
            type="range"
            min={0}
            max={frames.length - 1}
            value={i}
            onInput={(e) => setI(Number((e.target as HTMLInputElement).value))}
            aria-label="Decision"
            aria-valuetext={`Decision ${i + 1}: ${f.question}`}
          />
        <div class="rp-marks" aria-hidden="true">
          {frames.map((fr, k) => {
            const fl = flagOf(fr);
            return (
              <button
                type="button"
                tabIndex={-1}
                key={k}
                class={`mark ${fl?.cls ?? ''} ${k === i ? 'is-current' : ''} ${vm.seats[fr.seat].kind === 'bot' ? 'is-bot' : ''}`}
                style={{ left: `${frames.length > 1 ? (k / (frames.length - 1)) * 100 : 50}%` }}
                onClick={() => setI(k)}
                title={`${fr.question} → ${fr.choice}`}
              />
            );
          })}
        </div>
        {bot >= 0 && (
          <Sparkline
            values={vm.values}
            seats={vm.seats.filter((s) => s.kind === 'bot').map((s) => s.idx)}
            cursor={valueIdx}
            height={44}
            label="Bot win estimate across the game"
          />
        )}
        <BeliefStrip vm={vm} cursorTurn={f.turn} cursorN={beliefIdx} />
          </div>
          <button type="button" class="btn btn-sm" onClick={() => step(1)} aria-label="Next decision">
            <Icon name="arrowRight" />
          </button>
          <label class="toggle">
            <input type="checkbox" checked={botOnly} onChange={(e) => setBotOnly((e.target as HTMLInputElement).checked)} />
            bot decisions only
          </label>
        </div>
        <div class="rp-legend">
          <span><i class="mark flag-bluff" /> bluff</span>
          <span><i class="mark flag-caught" /> bluff caught</span>
          <span><i class="mark flag-challenge" /> challenge</span>
          <span><i class="mark flag-block" /> honest block</span>
          <span class="rp-keys">← → to step · Home/End · Esc closes</span>
        </div>
        {bluffList.length > 0 && (
          <div class="rp-jump">
            <span class="eyebrow">jump to a bluff</span>
            {bluffList.map((fr) => (
              <button type="button" class={`chip chip-btn ${ROLE_CLASS[fr.claim!.card]}`} key={fr.n} onClick={() => setI(fr.n)}>
                t{String(fr.turn).padStart(2, '0')} · {fr.seat === vm.viewer ? 'you' : vm.seats[fr.seat].name} · {fr.claim!.card}
                {fr.caught ? ' · caught' : ''}
              </button>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
