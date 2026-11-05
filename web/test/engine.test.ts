import { describe, expect, it } from 'vitest';
import { CoupGame } from '../src/engine/game';
import { encodePrompt, exchangeHeuristic } from '../src/engine/encode';
import type { Answer, Card, GameEvent, Prompt } from '../src/engine/types';

function randomAnswer(p: Prompt, rnd: () => number): Answer {
  switch (p.k) {
    case 'act':
      return Math.floor(rnd() * p.legal.length);
    case 'chl':
      return rnd() < 0.3;
    case 'blk':
      return rnd() < 0.4 ? p.cards[Math.floor(rnd() * p.cards.length)] : null;
    case 'lose':
      return Math.floor(rnd() * 2);
    case 'exch': {
      const idx = p.all.map((_, i) => i).sort(() => rnd() - 0.5);
      return idx.slice(0, p.keep).sort((a, b) => a - b);
    }
  }
}

function mulberry(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('engine invariants', () => {
  it('random self-play terminates and conserves cards / coins sanity', () => {
    for (let seed = 0; seed < 3000; seed++) {
      const rnd = mulberry(seed);
      const events: GameEvent[] = [];
      const g = new CoupGame(['A', 'B'], { onEvent: (e) => events.push(e) });
      const play = g.play();
      let r = play.next();
      while (!r.done) {
        const p = r.value;
        // every prompt the bot could receive must encode without throwing
        const enc = encodePrompt(g.state, p);
        if (enc) expect(enc.mask.some((m) => m === 1)).toBe(true);
        if (p.k === 'lose') expect(g.state.players[p.p].cards.length).toBe(2);
        if (p.k === 'act' && g.state.players[p.p].coins >= 10) {
          expect(p.legal.every((a) => a.type === 'Coup')).toBe(true);
        }
        r = play.next(randomAnswer(p, rnd));
        g.state.players.forEach((pl) => expect(pl.coins).toBeGreaterThanOrEqual(0));
      }
      expect(events[0].t).toBe('deal');
      expect(events.at(-1)!.t).toBe('gameOver');
      if (r.value !== null) expect(g.state.players[r.value].cards.length).toBeGreaterThan(0);
    }
  });

  it('exchange heuristic keeps the highest-value cards, stable on ties', () => {
    const all: Card[] = ['Contessa', 'Duke', 'Captain', 'Duke'];
    expect(exchangeHeuristic(all, 2)).toEqual([1, 3]);
    expect(exchangeHeuristic(['Ambassador', 'Captain', 'Ambassador'], 1)).toEqual([1]);
    expect(exchangeHeuristic(['Contessa', 'Contessa', 'Contessa'], 1)).toEqual([0]);
  });

  it('invalid exchange selections fall back to keeping the original hand', () => {
    const g = new CoupGame(['A', 'B'], { shuffle: () => {} });
    const before = [...g.state.players[0].cards];
    const play = g.play();
    let r = play.next();
    const act = r.value as Extract<Prompt, { k: 'act' }>;
    r = play.next(act.legal.findIndex((a) => a.type === 'Exchange'));
    expect(r.value).toMatchObject({ k: 'chl', p: 1 });
    r = play.next(false);
    expect(r.value).toMatchObject({ k: 'exch', p: 0, keep: 2 });
    r = play.next([0, 0]);
    expect(g.state.players[0].cards).toEqual(before);
  });
});
