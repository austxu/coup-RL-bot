// Port of coup/gen7.py: the Gen7 observation (127 dims), action mask, belief
// classes over the opponent's hidden hand and the belief mask. Shares the view,
// RL index tables, answer mapping and exchange heuristic with encode.ts.

import type { GameState } from './game';
import type { Action, ActionType, Card, Prompt } from './types';
import { ACT_TYPE_TO_RL, BLOCK_TO_RL, RL, playerView, reqTypeFor, type PlayerView } from './encode';

export const OBS_DIM7 = 127;
export const HIST_LEN7 = 4;
const HIST_DIM = 12; // 7 action one-hot, actor is me, blocked, challenged, challenge won, card lost

export type ReqType7 = 'ACT' | 'CHL' | 'CTR' | 'LOSE';

const CARD_IDX: Record<Card, number> = { Duke: 0, Assassin: 1, Captain: 2, Ambassador: 3, Contessa: 4 };
const ROLES: readonly Card[] = ['Duke', 'Assassin', 'Captain', 'Ambassador', 'Contessa'];
const DEC_IDX: Record<ReqType7, number> = { ACT: 0, CHL: 1, CTR: 2, LOSE: 3 };
const CTR_IDX: Partial<Record<ActionType, number>> = { 'Foreign Aid': 0, Assassinate: 1, Steal: 2 };

/** Belief classes: the 15 unordered two-card hands (i <= j, role order), then the 5 single cards. */
export const HANDS2: readonly (readonly [number, number])[] = (() => {
  const out: [number, number][] = [];
  for (let i = 0; i < 5; i++) for (let j = i; j < 5; j++) out.push([i, j]);
  return out;
})();
export const NUM_BELIEF = HANDS2.length + 5; // 20

/** MEMBERSHIP[k][r] = copies of role r in hand class k. */
export const MEMBERSHIP: readonly (readonly number[])[] = (() => {
  const m = Array.from({ length: NUM_BELIEF }, () => [0, 0, 0, 0, 0]);
  HANDS2.forEach(([i, j], k) => {
    m[k][i] += 1;
    m[k][j] += 1;
  });
  for (let r = 0; r < 5; r++) m[HANDS2.length + r][r] = 1;
  return m;
})();

/** The cards in belief class k (role order). */
export function classCards(k: number): Card[] {
  return k < HANDS2.length ? HANDS2[k].map((r) => ROLES[r]) : [ROLES[k - HANDS2.length]];
}

/** Belief class index of a (1- or 2-card) hand. */
export function handClass(cards: readonly Card[]): number {
  const idx = cards.map((c) => CARD_IDX[c]).sort((a, b) => a - b);
  if (idx.length === 2) return HANDS2.findIndex(([i, j]) => i === idx[0] && j === idx[1]);
  return HANDS2.length + idx[0];
}

/** Hand classes the opponent can hold given unseen copies per role. */
export function beliefMask(unseen: readonly number[], oppInfluence: number): Uint8Array {
  const m = new Uint8Array(NUM_BELIEF);
  if (oppInfluence === 2) {
    HANDS2.forEach(([i, j], k) => {
      m[k] = (i === j ? unseen[i] >= 2 : unseen[i] >= 1 && unseen[j] >= 1) ? 1 : 0;
    });
  } else if (oppInfluence === 1) {
    for (let r = 0; r < 5; r++) m[HANDS2.length + r] = unseen[r] >= 1 ? 1 : 0;
  }
  return m;
}

/** P(opponent holds at least one copy of each role), in role order, from class probabilities. */
export function roleMarginals(probs: ArrayLike<number>): number[] {
  const out = [0, 0, 0, 0, 0];
  for (let k = 0; k < NUM_BELIEF; k++) for (let r = 0; r < 5; r++) if (MEMBERSHIP[k][r] > 0) out[r] += probs[k];
  return out;
}

export interface Ctx7 {
  legal?: Action[]; // ACT
  card?: Card; // CHL: the claimed card
  action?: ActionType; // CTR: the action a block would counter
  cards?: Card[]; // CTR: cards that can block it
}

export interface Encoded7 {
  obs: Float32Array;
  mask: Uint8Array;
  bmask: Uint8Array;
}

/** gen7.encode: observation, action mask and belief mask for one decision. */
export function encodeState7(req: ReqType7, view: PlayerView, ctx: Ctx7, prev: number): Encoded7 {
  const obs = new Float32Array(OBS_DIM7);
  const mask = new Uint8Array(RL.SIZE);
  const opp = view.opponents[0];
  const me = view.player_id;
  const myCards = view.my_cards;

  myCards.slice(0, 2).forEach((c, s) => {
    obs[s * 5 + CARD_IDX[c]] = 1;
    obs[10 + CARD_IDX[c]] += 1;
  });
  const myCoins = view.my_coins;
  const oppCoins = opp.coins;
  obs[15] = myCoins / 10;
  obs[16] = oppCoins / 10;
  obs[17] = myCoins >= 3 ? 1 : 0;
  obs[18] = myCoins >= 7 ? 1 : 0;
  obs[19] = oppCoins >= 3 ? 1 : 0;
  obs[20] = oppCoins >= 7 ? 1 : 0;
  obs[21] = myCards.length / 2;
  obs[22] = opp.influence_count / 2;
  const seen = [0, 0, 0, 0, 0];
  for (const c of myCards) seen[CARD_IDX[c]] += 1;
  for (const c of view.my_revealed) {
    obs[23 + CARD_IDX[c]] += 1;
    seen[CARD_IDX[c]] += 1;
  }
  for (const c of opp.revealed) {
    obs[28 + CARD_IDX[c]] += 1;
    seen[CARD_IDX[c]] += 1;
  }
  const unseen = seen.map((s) => 3 - s);
  for (let r = 0; r < 5; r++) obs[33 + r] = unseen[r] / 3;
  for (const c of view.my_claimed_cards) obs[38 + CARD_IDX[c]] = 1;
  for (const c of opp.claimed_cards) obs[43 + CARD_IDX[c]] = 1;
  obs[48] = view.my_caught_bluff_count / 2;
  obs[49] = opp.caught_bluff_count / 2;

  obs[50 + DEC_IDX[req]] = 1;
  const history = view.action_history;
  if (req === 'CHL') {
    obs[54 + CARD_IDX[ctx.card!]] = 1;
    // in 1v1 a claim on my challenge prompt is a block iff the turn is mine
    if (history.length && history[history.length - 1].player === me) obs[59] = 1;
  } else if (req === 'CTR') {
    obs[60 + CTR_IDX[ctx.action!]!] = 1;
  }
  if (prev >= 0) obs[63 + prev] = 1;

  let base = 78;
  for (const h of history.slice(-HIST_LEN7)) {
    obs[base + ACT_TYPE_TO_RL[h.action]] = 1;
    obs[base + 7] = h.player === me ? 1 : 0;
    obs[base + 8] = h.was_blocked ? 1 : 0;
    obs[base + 9] = h.was_challenged ? 1 : 0;
    obs[base + 10] = h.challenge_won ? 1 : 0;
    obs[base + 11] = h.card_lost ? 1 : 0;
    base += HIST_DIM;
  }
  obs[126] = Math.min(view.turn_number, 40) / 20;

  if (req === 'ACT') {
    for (const a of ctx.legal ?? []) mask[ACT_TYPE_TO_RL[a.type]] = 1;
  } else if (req === 'CHL') {
    mask[RL.YES] = 1;
    mask[RL.NO] = 1;
  } else if (req === 'CTR') {
    mask[RL.NO] = 1;
    for (const c of ctx.cards ?? []) mask[BLOCK_TO_RL[c]!] = 1;
  } else if (req === 'LOSE') {
    mask[RL.LOSE_CARD_0] = 1;
    if (myCards.length > 1) mask[RL.LOSE_CARD_1] = 1;
  }

  return { obs, mask, bmask: beliefMask(unseen, opp.influence_count) };
}

/**
 * Encode what the Gen7 bot in seat `prompt.p` sees right now. `prev` is that
 * seat's previous RL decision index this game (-1 before its first decision);
 * after deciding, the caller feeds the chosen index back in as the next `prev`.
 * Exchange prompts return null (fixed heuristic, no network call, prev unchanged).
 */
export function encodePrompt7(
  s: GameState,
  prompt: Prompt,
  prev: number,
): ({ req: ReqType7 } & Encoded7) | null {
  const req = reqTypeFor(prompt) as ReqType7 | null;
  if (!req) return null;
  const view = playerView(s, prompt.p);
  const ctx: Ctx7 =
    prompt.k === 'act'
      ? { legal: prompt.legal }
      : prompt.k === 'chl'
        ? { card: prompt.card }
        : prompt.k === 'blk'
          ? { action: prompt.action, cards: prompt.cards }
          : {};
  return { req, ...encodeState7(req, view, ctx, prev) };
}
