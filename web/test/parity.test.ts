// Replays games recorded from the Python engine + PyTorch bot
// (tools/make_parity_fixtures.py) through the TypeScript port.
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CoupGame } from '../src/engine/game';
import { encodePrompt, exchangeHeuristic, rlToAnswer } from '../src/engine/encode';
import type { Answer, Card, Prompt } from '../src/engine/types';
import { CoupPolicy, maskedSoftmax, type Manifest } from '../src/bot/model';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const fixturePath = process.env.PARITY_FIXTURE ?? here('./fixtures/parity.json.gz');
const fixture = JSON.parse(gunzipSync(readFileSync(fixturePath)).toString());
const manifest: Manifest = JSON.parse(readFileSync(here('../src/model/gen5.json'), 'utf8'));
const bin = readFileSync(here('../src/model/gen5.bin'));
const policy = new CoupPolicy(manifest, bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength));

interface Snap {
  turn: number;
  cur: number;
  deck: string[];
  players: { coins: number; cards: string[]; revealed: string[]; claimed: string[]; caught: number }[];
}

function snap(g: CoupGame): Snap {
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

function promptShape(p: Prompt): Record<string, unknown> {
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

const stats = { botDecisions: 0, maxLogit16: 0, maxValue16: 0, maxLogit32: 0, maxValue32: 0, maxTV32: 0, argmaxAgree32: 0 };

describe('parity with the Python engine and PyTorch bot', () => {
  for (const game of fixture.games) {
    it(`replays ${game.matchup} game seed ${game.seed}`, () => {
      const shuffles: string[][] = game.shuffles.map((s: string[]) => [...s]);
      const g = new CoupGame(['A', 'B'], {
        shuffle: (deck) => {
          const next = shuffles.shift();
          expect(next, 'engine shuffled more often than Python').toBeDefined();
          expect([...deck].sort()).toEqual([...next!].sort());
          deck.splice(0, deck.length, ...(next as Card[]));
        },
      });
      const lstm = game.seats.map(() => policy.initialState());
      const play = g.play();
      let r = play.next();

      for (const d of game.decisions) {
        expect(r.done).toBe(false);
        const prompt = r.value as Prompt;
        const { answer: _a, state, bot, ...shape } = d;
        expect(promptShape(prompt)).toEqual(shape);
        expect(snap(g)).toEqual(state);

        let answer: Answer;
        if (game.seats[d.p] === 'ppo' && prompt.k === 'exch') {
          expect(exchangeHeuristic(prompt.all, prompt.keep)).toEqual(d.answer);
        }
        if (bot) {
          const enc = encodePrompt(g.state, prompt)!;
          expect(enc.req).toBe(bot.req);
          expect(Array.from(enc.obs)).toEqual(bot.obs);
          expect(Array.from(enc.mask)).toEqual(bot.mask);
          const out = policy.step(enc.obs, lstm[d.p]);
          stats.botDecisions++;
          for (let i = 0; i < 15; i++) {
            stats.maxLogit16 = Math.max(stats.maxLogit16, Math.abs(out.logits[i] - bot.logits16[i]));
            if (bot.mask[i]) stats.maxLogit32 = Math.max(stats.maxLogit32, Math.abs(out.logits[i] - bot.logits32[i]));
          }
          stats.maxValue16 = Math.max(stats.maxValue16, Math.abs(out.value - bot.value16));
          stats.maxValue32 = Math.max(stats.maxValue32, Math.abs(out.value - bot.value32));
          const p = maskedSoftmax(out.logits, enc.mask);
          const q = maskedSoftmax(bot.logits32, bot.mask);
          let tv = 0;
          for (let i = 0; i < 15; i++) tv += Math.abs(p[i] - q[i]) / 2;
          stats.maxTV32 = Math.max(stats.maxTV32, tv);
          if (p.indexOf(Math.max(...p)) === q.indexOf(Math.max(...q))) stats.argmaxAgree32++;
          expect(bot.mask[bot.choice]).toBe(1);
          // the RL index -> engine answer mapping must reproduce Python's answer
          const mapped = rlToAnswer(prompt, bot.choice);
          expect(mapped).toEqual(d.answer);
        }
        answer = d.answer as Answer;
        r = play.next(answer);
      }
      expect(r.done).toBe(true);
      expect(r.value).toBe(game.winner);
      expect(snap(g)).toEqual(game.final);
      expect(g.state.history).toEqual(game.history);
      expect(shuffles).toHaveLength(0);
    });
  }

  it('network outputs match the float16 reference within 1e-4 and float32 within quantisation noise', () => {
    // eslint-disable-next-line no-console
    console.log('[parity]', JSON.stringify({ games: fixture.games.length, ...stats }));
    expect(stats.botDecisions).toBeGreaterThan(500);
    expect(stats.maxLogit16).toBeLessThan(1e-4);
    expect(stats.maxValue16).toBeLessThan(1e-4);
    expect(stats.maxTV32).toBeLessThan(5e-3);
    expect(stats.argmaxAgree32).toBe(stats.botDecisions);
  });
});
