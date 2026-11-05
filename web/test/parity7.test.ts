// Replays Gen7 games recorded from the Python engine + PyTorch Gen7 bot
// (tools/make_parity_fixtures.py --model gen7) through the TypeScript port.
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CoupGame } from '../src/engine/game';
import { exchangeHeuristic, rlToAnswer } from '../src/engine/encode';
import { HANDS2, MEMBERSHIP, NUM_BELIEF, classCards, encodePrompt7, handClass, roleMarginals } from '../src/engine/encode7';
import type { Answer, Card, Prompt } from '../src/engine/types';
import { CoupPolicy, beliefProbs, maskedSoftmax, type Manifest } from '../src/bot/model';
import { promptShape, snap } from './replay';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const fixturePath = process.env.PARITY7_FIXTURE ?? here('./fixtures/parity7.json.gz');
const fixture = JSON.parse(gunzipSync(readFileSync(fixturePath)).toString());
const manifest: Manifest = JSON.parse(readFileSync(here('../src/model/gen7.json'), 'utf8'));
const bin = readFileSync(here('../src/model/gen7.bin'));
const policy = new CoupPolicy(manifest, bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength));

const tv = (p: ArrayLike<number>, q: ArrayLike<number>) => {
  let d = 0;
  for (let i = 0; i < p.length; i++) d += Math.abs(p[i] - q[i]) / 2;
  return d;
};
const argmax = (p: ArrayLike<number>) => {
  let best = 0;
  for (let i = 1; i < p.length; i++) if (p[i] > p[best]) best = i;
  return best;
};

const stats = {
  botDecisions: 0,
  maxLogit16: 0,
  maxValue16: 0,
  maxBelief16: 0,
  maxLogit32: 0,
  maxValue32: 0,
  maxTV32: 0,
  argmaxAgree32: 0,
  argmaxNearTies32: 0, // argmax differs only because fp32's top two are within 1e-3
  maxBeliefTV32: 0,
  meanBeliefTV32: 0,
};

describe('Gen7 belief classes', () => {
  it('match gen7.HANDS2 / MEMBERSHIP', () => {
    expect(HANDS2.map((h) => [...h])).toEqual(fixture.classes);
    expect(NUM_BELIEF).toBe(20);
    for (let k = 0; k < NUM_BELIEF; k++) {
      expect(handClass(classCards(k))).toBe(k);
      expect(MEMBERSHIP[k].reduce((a, b) => a + b, 0)).toBe(k < 15 ? 2 : 1);
    }
    expect(handClass(['Contessa', 'Duke'])).toBe(4);
    // one-hot class -> P(holds role) is 1 exactly for the roles in it
    expect(roleMarginals(Array.from({ length: 20 }, (_, k) => (k === 6 ? 1 : 0)))).toEqual([0, 1, 1, 0, 0]);
  });
});

describe('Gen7 parity with the Python engine and PyTorch bot', () => {
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
      const prev = game.seats.map(() => -1);
      const play = g.play();
      let r = play.next();

      for (const d of game.decisions) {
        expect(r.done).toBe(false);
        const prompt = r.value as Prompt;
        const { answer: _a, state, bot, ...shape } = d;
        expect(promptShape(prompt)).toEqual(shape);
        expect(snap(g)).toEqual(state);

        if (game.seats[d.p] === 'gen7') {
          const enc = encodePrompt7(g.state, prompt, prev[d.p]);
          if (prompt.k === 'exch') {
            expect(enc).toBeNull();
            expect(bot).toBeUndefined();
            expect(exchangeHeuristic(prompt.all, prompt.keep)).toEqual(d.answer);
          } else {
            expect(bot, 'every non-exchange Gen7 prompt is a network decision').toBeDefined();
            expect(enc).not.toBeNull();
            expect(bot.prev).toBe(prev[d.p]);
            expect(enc!.req).toBe(bot.req);
            expect(Array.from(enc!.obs)).toEqual(bot.obs.map(Math.fround));
            expect(Array.from(enc!.mask)).toEqual(bot.mask);
            expect(Array.from(enc!.bmask)).toEqual(bot.bmask);
            // card counting never rules out the opponent's true hand
            const oppCards = g.state.players[1 - d.p].cards;
            if (oppCards.length) expect(enc!.bmask[handClass(oppCards)]).toBe(1);

            const out = policy.step(enc!.obs, lstm[d.p]);
            const belief = out.belief!;
            stats.botDecisions++;
            for (let i = 0; i < 15; i++) {
              stats.maxLogit16 = Math.max(stats.maxLogit16, Math.abs(out.logits[i] - bot.logits16[i]));
              if (bot.mask[i]) stats.maxLogit32 = Math.max(stats.maxLogit32, Math.abs(out.logits[i] - bot.logits32[i]));
            }
            for (let i = 0; i < NUM_BELIEF; i++) {
              stats.maxBelief16 = Math.max(stats.maxBelief16, Math.abs(belief[i] - bot.belief16[i]));
            }
            stats.maxValue16 = Math.max(stats.maxValue16, Math.abs(out.value - bot.value16));
            stats.maxValue32 = Math.max(stats.maxValue32, Math.abs(out.value - bot.value32));

            const p = maskedSoftmax(out.logits, enc!.mask);
            const q = maskedSoftmax(bot.logits32, bot.mask);
            stats.maxTV32 = Math.max(stats.maxTV32, tv(p, q));
            if (argmax(p) === argmax(q)) stats.argmaxAgree32++;
            else if (q[argmax(q)] - q[argmax(p)] < 1e-3) stats.argmaxNearTies32++;
            const bp = beliefProbs(belief, enc!.bmask);
            const bq = beliefProbs(bot.belief32, bot.bmask);
            const btv = tv(bp, bq);
            stats.maxBeliefTV32 = Math.max(stats.maxBeliefTV32, btv);
            stats.meanBeliefTV32 += btv;

            expect(bot.mask[bot.choice]).toBe(1);
            // the RL index -> engine answer mapping must reproduce Python's answer
            expect(rlToAnswer(prompt, bot.choice)).toEqual(d.answer);
            prev[d.p] = bot.choice;
          }
        } else {
          expect(bot).toBeUndefined();
        }
        r = play.next(d.answer as Answer);
      }
      expect(r.done).toBe(true);
      expect(r.value).toBe(game.winner);
      expect(snap(g)).toEqual(game.final);
      expect(g.state.history).toEqual(game.history);
      expect(shuffles).toHaveLength(0);
    });
  }

  it('network outputs match the float16 reference within 1e-4 and float32 within quantisation noise', () => {
    stats.meanBeliefTV32 /= stats.botDecisions;
    // eslint-disable-next-line no-console
    console.log('[parity7]', JSON.stringify({ games: fixture.games.length, ...stats }));
    expect(stats.botDecisions).toBeGreaterThan(500);
    expect(stats.maxLogit16).toBeLessThan(1e-4);
    expect(stats.maxValue16).toBeLessThan(1e-4);
    expect(stats.maxBelief16).toBeLessThan(1e-4);
    expect(stats.maxTV32).toBeLessThan(5e-3);
    expect(stats.argmaxAgree32 + stats.argmaxNearTies32).toBe(stats.botDecisions);
    expect(stats.maxBeliefTV32).toBeLessThan(1e-2);
  });
});
