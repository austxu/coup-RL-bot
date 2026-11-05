// Shared helpers for replaying fixtures from tools/make_parity_fixtures.py.
import type { CoupGame } from '../src/engine/game';
import type { Prompt } from '../src/engine/types';

export interface Snap {
  turn: number;
  cur: number;
  deck: string[];
  players: { coins: number; cards: string[]; revealed: string[]; claimed: string[]; caught: number }[];
}

export function snap(g: CoupGame): Snap {
  const s = g.state;
  return {
    turn: s.turn,
    cur: s.current,
    deck: [...s.deck],
    players: s.players.map((p) => ({
      coins: p.coins,
      cards: [...p.cards],
      revealed: [...p.revealed],
      claimed: [...p.claimed].sort(),
      caught: p.caught,
    })),
  };
}

export function promptShape(p: Prompt): Record<string, unknown> {
  switch (p.k) {
    case 'act':
      return { k: p.k, p: p.p, legal: p.legal.map((a) => [a.type, a.target]) };
    case 'chl':
      return { k: p.k, p: p.p, claimer: p.claimer, card: p.card };
    case 'blk':
      return { k: p.k, p: p.p, actor: p.actor, action: p.action, cards: p.cards };
    case 'lose':
      return { k: p.k, p: p.p };
    case 'exch':
      return { k: p.k, p: p.p, all: p.all, keep: p.keep };
  }
}
