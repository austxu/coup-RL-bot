import { useEffect, useRef, useState } from 'preact/hooks';
import type { Match, MatchVM } from '../game/match';
import type { ActionType, Card, Prompt } from '../engine/types';
import { ACTIONS, ROLE_CLASS } from '../game/labels';
import { CardView } from './CardView';
import { Icon } from './Icon';

export function Dock({ match, vm, embed }: { match: Match; vm: MatchVM; embed: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const prompt = vm.prompt;
  const promptKey = prompt ? `${vm.frames.length}` : '';

  // move focus into the dock whenever a new human decision opens
  useEffect(() => {
    if (!prompt || !ref.current) return;
    const btn = ref.current.querySelector<HTMLElement>('[data-primary]:not([disabled]), button:not([disabled])');
    btn?.focus({ preventScroll: true });
  }, [promptKey]);

  if (vm.phase === 'over') return <div class="dock dock-empty" />;

  if (!prompt) {
    const thinking = vm.seats.find((s) => s.thinking);
    return (
      <div class="dock dock-status" ref={ref}>
        <span class="eyebrow">{vm.mode === 'attract' ? 'live / self-play' : 'waiting'}</span>
        <p class="dock-line">
          {thinking ? (
            <>
              <strong>{thinking.name}</strong> is thinking
              <span class="dots" aria-hidden="true"><i /><i /><i /></span>
            </>
          ) : vm.phase === 'dealing' ? (
            'Shuffling the court deck and dealing two influence each…'
          ) : vm.mode === 'attract' ? (
            'Two copies of the Gen5 bot play each other. Bluffs are tagged as they happen.'
          ) : vm.showdown ? (
            'Resolving the challenge…'
          ) : (
            'Resolving…'
          )}
        </p>
      </div>
    );
  }

  return (
    <div class={`dock dock-prompt dock-${prompt.k}`} ref={ref} role="group" aria-labelledby="dock-q">
      <PromptBody key={promptKey} match={match} vm={vm} prompt={prompt} embed={embed} />
    </div>
  );
}

function useKeys(handler: (e: KeyboardEvent) => boolean | void, deps: unknown[]) {
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      if (document.querySelector('dialog[open]')) return;
      if (handler(e) === true) e.preventDefault();
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, deps);
}

function Kbd({ k }: { k: string }) {
  return (
    <kbd class="kbd" aria-hidden="true">
      {k}
    </kbd>
  );
}

function PromptBody({ match, vm, prompt }: { match: Match; vm: MatchVM; prompt: Prompt; embed: boolean }) {
  const me = vm.seats[prompt.p];
  const hand = me.slots.filter((s) => !s.dead).map((s) => s.card);
  const opp = vm.seats[1 - prompt.p];

  if (prompt.k === 'act') {
    const legal = new Map<ActionType, number>();
    prompt.legal.forEach((a, i) => legal.set(a.type, i));
    const forced = prompt.legal.every((a) => a.type === 'Coup');
    useKeys(
      (e) => {
        const a = ACTIONS.find((x) => x.key === e.key.toLowerCase());
        if (a && legal.has(a.type)) {
          match.answer(legal.get(a.type)!);
          return true;
        }
      },
      [prompt],
    );
    return (
      <>
        <div class="dock-head">
          <span class="eyebrow">01 / your move</span>
          <h2 id="dock-q" class="dock-q" tabIndex={-1}>
            {forced ? 'Ten coins: you must launch a Coup.' : 'Choose an action'}
          </h2>
          <span class="dock-sub">
            {forced
              ? 'At 10 or more coins, Coup is the only legal action.'
              : 'Character actions are claims — bluffing is allowed, and can be challenged.'}
          </span>
        </div>
        <div class="actions">
          {ACTIONS.map((a) => {
            const idx = legal.get(a.type);
            const ok = idx !== undefined;
            const bluff = a.role !== null && !hand.includes(a.role);
            const reason = !ok
              ? forced
                ? 'Must Coup'
                : a.cost > me.coins
                  ? `Needs ${a.cost} coins`
                  : 'Unavailable'
              : '';
            const effect =
              a.type === 'Steal' ? `take ${Math.min(2, opp.coins)} from ${opp.name}` : a.effect;
            return (
              <button
                type="button"
                key={a.type}
                class={`action ${a.role ? `${ROLE_CLASS[a.role]} has-role` : ''} ${a.type === 'Coup' && ok ? 'action-coup' : ''}`}
                disabled={!ok}
                data-primary={forced && ok ? '' : undefined}
                aria-keyshortcuts={a.key.toUpperCase()}
                title={reason || undefined}
                onClick={() => ok && match.answer(idx!)}
              >
                <span class="action-top">
                  <Icon name={a.icon} size={16} />
                  <span class="action-name">{a.short}</span>
                  <Kbd k={a.key.toUpperCase()} />
                </span>
                <span class="action-sub">
                  {reason || effect}
                  {ok && a.role && (
                    <span class={`claim ${bluff ? 'claim-bluff' : ''}`}>
                      {a.role}
                      {bluff ? ' · bluff' : ''}
                    </span>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      </>
    );
  }

  if (prompt.k === 'chl') {
    const claimer = vm.seats[prompt.claimer];
    const isBlock = vm.callouts.some((c) => c.seat === prompt.claimer && c.kind === 'block');
    useKeys(
      (e) => {
        const k = e.key.toLowerCase();
        if (k === 'c' || k === 'y') return match.answer(true), true;
        if (k === 'a' || k === 'n' || k === 'p') return match.answer(false), true;
      },
      [prompt],
    );
    return (
      <>
        <div class="dock-head">
          <span class="eyebrow">01 / your call</span>
          <h2 id="dock-q" class="dock-q">
            {claimer.name} claims <span class={`role-word ${ROLE_CLASS[prompt.card]}`}>{prompt.card}</span>
            {isBlock ? ' to block you' : ''}. Challenge?
          </h2>
          <span class="dock-sub">
            If they hold it, you lose an influence. If it's a bluff, they lose one
            {isBlock ? ' and your action goes through' : ' and the action fails'}.
          </span>
        </div>
        <div class="choices">
          <button type="button" class="btn btn-danger" data-primary onClick={() => match.answer(true)} aria-keyshortcuts="C">
            <Icon name="challenge" /> Challenge <Kbd k="C" />
          </button>
          <button type="button" class="btn" onClick={() => match.answer(false)} aria-keyshortcuts="A">
            Allow <Kbd k="A" />
          </button>
        </div>
      </>
    );
  }

  if (prompt.k === 'blk') {
    const actor = vm.seats[prompt.actor];
    useKeys(
      (e) => {
        const k = e.key.toLowerCase();
        const n = Number(k);
        if (n >= 1 && n <= prompt.cards.length) return match.answer(prompt.cards[n - 1]), true;
        if (k === 'b' && prompt.cards.length === 1) return match.answer(prompt.cards[0]), true;
        if (k === 'a' || k === 'n' || k === 'p') return match.answer(null), true;
      },
      [prompt],
    );
    const what =
      prompt.action === 'Foreign Aid'
        ? 'takes Foreign Aid'
        : prompt.action === 'Steal'
          ? `tries to steal ${Math.min(2, me.coins)} of your coins`
          : prompt.action === 'Assassinate'
            ? 'tries to assassinate you'
            : prompt.action;
    return (
      <>
        <div class="dock-head">
          <span class="eyebrow">01 / your call</span>
          <h2 id="dock-q" class="dock-q">
            {actor.name} {what}. Block?
          </h2>
          <span class="dock-sub">A block is a claim too — {actor.name} may challenge it.</span>
        </div>
        <div class="choices">
          {prompt.cards.map((c, n) => {
            const held = hand.includes(c);
            return (
              <button
                type="button"
                key={c}
                class={`btn btn-role ${ROLE_CLASS[c]}`}
                data-primary={n === 0 ? '' : undefined}
                onClick={() => match.answer(c)}
                aria-keyshortcuts={String(n + 1)}
              >
                <Icon name="block" /> Block with {c}
                <span class={`claim ${held ? '' : 'claim-bluff'}`}>{held ? 'you hold it' : 'bluff'}</span>
                <Kbd k={String(n + 1)} />
              </button>
            );
          })}
          <button type="button" class="btn" onClick={() => match.answer(null)} aria-keyshortcuts="A">
            Allow <Kbd k="A" />
          </button>
        </div>
      </>
    );
  }

  if (prompt.k === 'lose') {
    const alive = me.slots.filter((s) => !s.dead);
    useKeys(
      (e) => {
        const n = Number(e.key);
        if (n >= 1 && n <= alive.length) return match.answer(me.order.indexOf(alive[n - 1].id)), true;
      },
      [prompt],
    );
    return (
      <>
        <div class="dock-head">
          <span class="eyebrow">01 / lose an influence</span>
          <h2 id="dock-q" class="dock-q">Choose a card to reveal</h2>
          <span class="dock-sub">It stays face-up for the rest of the game. Keep the one you'll want to claim.</span>
        </div>
        <div class="choices">
          {alive.map((s, n) => (
            <button
              type="button"
              key={s.id}
              class={`btn btn-role ${ROLE_CLASS[s.card]}`}
              data-primary={n === 0 ? '' : undefined}
              onClick={() => match.answer(me.order.indexOf(s.id))}
              aria-keyshortcuts={String(n + 1)}
            >
              <span class="role-dot" /> Reveal {s.card} <Kbd k={String(n + 1)} />
            </button>
          ))}
        </div>
      </>
    );
  }

  return <ExchangePicker match={match} prompt={prompt} />;
}

function ExchangePicker({ match, prompt }: { match: Match; prompt: Extract<Prompt, { k: 'exch' }> }) {
  const nOld = prompt.all.length - 2 < 0 ? 0 : prompt.all.length - Math.min(2, prompt.all.length);
  const [keep, setKeep] = useState<number[]>(() => Array.from({ length: prompt.keep }, (_, i) => i));
  const [drag, setDrag] = useState<{ i: number; dx: number; dy: number } | null>(null);
  const keepRow = useRef<HTMLDivElement>(null);
  const dropRow = useRef<HTMLDivElement>(null);
  const start = useRef<{ x: number; y: number; i: number; moved: boolean } | null>(null);

  const toggle = (i: number) => {
    setKeep((k) => {
      if (k.includes(i)) return k.filter((x) => x !== i);
      if (k.length < prompt.keep) return [...k, i].sort((a, b) => a - b);
      // full: swap out the oldest choice so a single click always does something
      return [...k.slice(1), i].sort((a, b) => a - b);
    });
  };
  const ready = keep.length === prompt.keep;
  const confirm = () => ready && match.answer([...keep].sort((a, b) => a - b));

  useKeys(
    (e) => {
      const n = Number(e.key);
      if (n >= 1 && n <= prompt.all.length) return toggle(n - 1), true;
      if (e.key === 'Enter' && ready) return confirm(), true;
    },
    [prompt, keep],
  );

  const onDown = (i: number) => (e: PointerEvent) => {
    if (e.button !== 0) return;
    start.current = { x: e.clientX, y: e.clientY, i, moved: false };
  };
  useEffect(() => {
    const move = (e: PointerEvent) => {
      const s = start.current;
      if (!s) return;
      const dx = e.clientX - s.x;
      const dy = e.clientY - s.y;
      if (!s.moved && Math.hypot(dx, dy) > 8) s.moved = true;
      if (s.moved) setDrag({ i: s.i, dx, dy });
    };
    const up = (e: PointerEvent) => {
      const s = start.current;
      start.current = null;
      setDrag(null);
      if (!s || !s.moved) return;
      const inRow = (el: HTMLElement | null) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top - 16 && e.clientY <= r.bottom + 16;
      };
      const kept = keep.includes(s.i);
      if ((kept && inRow(dropRow.current)) || (!kept && inRow(keepRow.current))) toggle(s.i);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
  }, [keep]);

  const card = (i: number) => {
    const c: Card = prompt.all[i];
    const isDrag = drag?.i === i;
    return (
      <div
        key={i}
        class={`ex-card ${isDrag ? 'is-dragging' : ''}`}
        style={isDrag ? { transform: `translate(${drag!.dx}px, ${drag!.dy}px) rotate(${drag!.dx / 40}deg)` } : undefined}
        onPointerDown={onDown(i) as any}
      >
        <CardView
          card={c}
          size="sm"
          selectable
          selected={keep.includes(i)}
          onClick={() => {
            if (!start.current?.moved) toggle(i);
          }}
          label={`${c}${i >= nOld ? ' (drawn)' : ''}${keep.includes(i) ? ', kept' : ', returning'}`}
        />
        <span class="ex-meta">
          <span class="kbd" aria-hidden="true">{i + 1}</span>
          {i >= nOld ? <span class="tag tag-new">drawn</span> : <span class="tag">in hand</span>}
        </span>
      </div>
    );
  };

  const kept = prompt.all.map((_, i) => i).filter((i) => keep.includes(i));
  const back = prompt.all.map((_, i) => i).filter((i) => !keep.includes(i));
  return (
    <div class="exchange">
      <div class="dock-head">
        <span class="eyebrow">01 / exchange</span>
        <h2 id="dock-q" class="dock-q">
          Keep {prompt.keep} of {prompt.all.length}
        </h2>
        <span class="dock-sub">Click or drag cards between the rows. The rest go back into the deck.</span>
      </div>
      <div class="ex-rows">
        <div class="ex-row ex-keep" ref={keepRow}>
          <span class="eyebrow">keep · {keep.length}/{prompt.keep}</span>
          <div class="ex-cards">{kept.map(card)}</div>
        </div>
        <div class="ex-row ex-return" ref={dropRow}>
          <span class="eyebrow">return to deck</span>
          <div class="ex-cards">{back.map(card)}</div>
        </div>
      </div>
      <div class="choices">
        <button type="button" class="btn btn-primary" disabled={!ready} onClick={confirm} data-primary>
          <Icon name="check" /> Keep {kept.map((i) => prompt.all[i]).join(' + ') || '…'} <Kbd k="↵" />
        </button>
      </div>
    </div>
  );
}

