// Port of GameState.get_player_view + CoupEnv._encode_state (coup/coup_env.py)
// and the PPO agent's fixed exchange heuristic (coup/ppo_agent.py).

import type { GameState } from './game';
import type { Action, ActionType, Card, HistoryEntry, Prompt } from './types';

/** RLAction indices (coup_env.RLAction). */
export const RL = {
  INCOME: 0,
  FOREIGN_AID: 1,
  COUP: 2,
  TAX: 3,
  ASSASSINATE: 4,
  STEAL: 5,
  EXCHANGE: 6,
  YES: 7,
  NO: 8,
  BLOCK_DUKE: 9,
  BLOCK_CAPTAIN: 10,
  BLOCK_AMBASSADOR: 11,
  BLOCK_CONTESSA: 12,
  LOSE_CARD_0: 13,
  LOSE_CARD_1: 14,
  SIZE: 15,
} as const;

export const OBS_DIM = 70;

export const ACT_TYPE_TO_RL: Record<ActionType, number> = {
  Income: 0,
  'Foreign Aid': 1,
  Coup: 2,
  Tax: 3,
  Assassinate: 4,
  Steal: 5,
  Exchange: 6,
};
export const RL_TO_ACT_TYPE: Record<number, ActionType> = Object.fromEntries(
  Object.entries(ACT_TYPE_TO_RL).map(([k, v]) => [v, k as ActionType]),
);
export const BLOCK_TO_RL: Partial<Record<Card, number>> = {
  Duke: RL.BLOCK_DUKE,
  Captain: RL.BLOCK_CAPTAIN,
  Ambassador: RL.BLOCK_AMBASSADOR,
  Contessa: RL.BLOCK_CONTESSA,
};
export const RL_TO_BLOCK: Record<number, Card> = {
  [RL.BLOCK_DUKE]: 'Duke',
  [RL.BLOCK_CAPTAIN]: 'Captain',
  [RL.BLOCK_AMBASSADOR]: 'Ambassador',
  [RL.BLOCK_CONTESSA]: 'Contessa',
};

const CARD_IDX: Record<Card, number> = { Duke: 0, Assassin: 1, Captain: 2, Ambassador: 3, Contessa: 4 };

export type ReqType = 'ACT' | 'CHL' | 'CTR' | 'CC' | 'LOSE';

export interface OpponentView {
  player_id: number;
  coins: number;
  influence_count: number;
  revealed: Card[];
  claimed_cards: Card[];
  caught_bluff_count: number;
  alive: boolean;
}

export interface PlayerView {
  player_id: number;
  my_cards: Card[];
  my_revealed: Card[];
  my_claimed_cards: Card[];
  my_caught_bluff_count: number;
  my_coins: number;
  opponents: OpponentView[];
  action_history: HistoryEntry[];
  turn_number: number;
  court_deck_size: number;
}

export function playerView(s: GameState, p: number): PlayerView {
  const me = s.players[p];
  return {
    player_id: p,
    my_cards: [...me.cards],
    my_revealed: [...me.revealed],
    my_claimed_cards: [...me.claimed],
    my_caught_bluff_count: me.caught,
    my_coins: me.coins,
    opponents: s.players
      .filter((q) => q.id !== p)
      .map((q) => ({
        player_id: q.id,
        coins: q.coins,
        influence_count: q.cards.length,
        revealed: [...q.revealed],
        claimed_cards: [...q.claimed],
        caught_bluff_count: q.caught,
        alive: q.cards.length > 0,
      })),
    action_history: s.history,
    turn_number: s.turn,
    court_deck_size: s.deck.length,
  };
}

/** What the engine's prompt means to the RL agent. */
export function reqTypeFor(prompt: Prompt): ReqType | null {
  switch (prompt.k) {
    case 'act':
      return 'ACT';
    case 'chl':
      return 'CHL'; // the engine routes block-challenges through choose_challenge too
    case 'blk':
      return 'CTR';
    case 'lose':
      return 'LOSE';
    case 'exch':
      return null; // fixed heuristic, no network call
  }
}

export function encodeState(
  req: ReqType,
  view: PlayerView,
  ctx: { legal?: Action[]; card?: Card; cards?: Card[] },
): { obs: Float32Array; mask: Uint8Array } {
  const obs = new Float32Array(OBS_DIM);
  const mask = new Uint8Array(RL.SIZE);

  for (const c of view.my_cards) obs[0 + CARD_IDX[c]] += 1;
  obs[5] = view.my_coins;
  const opp = view.opponents[0];
  obs[6] = opp.coins;
  obs[7] = opp.influence_count;
  for (const c of view.my_revealed) obs[8 + CARD_IDX[c]] += 1;
  for (const c of opp.revealed) obs[8 + CARD_IDX[c]] += 1;
  for (const c of view.my_claimed_cards) obs[13 + CARD_IDX[c]] = 1;
  for (const c of opp.claimed_cards) obs[18 + CARD_IDX[c]] = 1;
  obs[23] = view.my_caught_bluff_count;
  obs[24] = opp.caught_bluff_count;

  const dec: Record<ReqType, number> = { ACT: 25, CHL: 26, CTR: 27, CC: 28, LOSE: 29 };
  obs[dec[req]] = 1;
  if ((req === 'CHL' || req === 'CC') && ctx.card) obs[30 + CARD_IDX[ctx.card]] = 1;
  // CTR leaves the context block at zero (as in Python).

  const hist = view.action_history.slice(-5);
  let base = 35;
  const me = view.player_id;
  for (const h of hist) {
    obs[base + 0] = ACT_TYPE_TO_RL[h.action] ?? 0;
    obs[base + 1] = h.player === me ? 0 : 1;
    obs[base + 2] = h.target === null ? -1 : h.target === me ? 0 : 1;
    obs[base + 3] = h.was_blocked ? 1 : 0;
    obs[base + 4] = h.was_challenged ? 1 : 0;
    obs[base + 5] = h.challenge_won ? 1 : 0;
    obs[base + 6] = h.card_lost ? 1 : 0;
    base += 7;
  }

  if (req === 'ACT') {
    for (const a of ctx.legal ?? []) mask[ACT_TYPE_TO_RL[a.type]] = 1;
  } else if (req === 'CHL' || req === 'CC') {
    mask[RL.YES] = 1;
    mask[RL.NO] = 1;
  } else if (req === 'CTR') {
    mask[RL.NO] = 1;
    for (const c of ctx.cards ?? []) mask[BLOCK_TO_RL[c]!] = 1;
  } else if (req === 'LOSE') {
    mask[RL.LOSE_CARD_0] = 1;
    if (view.my_cards.length > 1) mask[RL.LOSE_CARD_1] = 1;
  }
  return { obs, mask };
}

/** Encode the observation the bot in seat `prompt.p` would see right now. */
export function encodePrompt(s: GameState, prompt: Prompt): { req: ReqType; obs: Float32Array; mask: Uint8Array } | null {
  const req = reqTypeFor(prompt);
  if (!req) return null;
  const view = playerView(s, prompt.p);
  const ctx =
    prompt.k === 'act'
      ? { legal: prompt.legal }
      : prompt.k === 'chl'
        ? { card: prompt.card }
        : prompt.k === 'blk'
          ? { cards: prompt.cards }
          : {};
  return { req, ...encodeState(req, view, ctx) };
}

/** Map the network's chosen RL index back to an engine answer. */
export function rlToAnswer(prompt: Prompt, idx: number): number | boolean | Card | null {
  switch (prompt.k) {
    case 'act': {
      const type = RL_TO_ACT_TYPE[idx];
      const i = prompt.legal.findIndex((a) => a.type === type);
      return i >= 0 ? i : 0; // PPOAgent falls back to legal_actions[0]
    }
    case 'chl':
      return idx === RL.YES;
    case 'blk':
      return idx === RL.NO ? null : (RL_TO_BLOCK[idx] ?? null);
    case 'lose':
      return idx === RL.LOSE_CARD_0 ? 0 : 1;
    case 'exch':
      throw new Error('exchange uses the heuristic');
  }
}

const CARD_VALUE: Record<Card, number> = { Duke: 5, Assassin: 4, Captain: 3, Ambassador: 2, Contessa: 1 };

/** PPOAgent.choose_exchange_cards: keep the highest-value cards (stable on ties). */
export function exchangeHeuristic(all: Card[], keep: number): number[] {
  const ranked = all.map((_, i) => i).sort((a, b) => CARD_VALUE[all[b]] - CARD_VALUE[all[a]]);
  return ranked.slice(0, keep).sort((a, b) => a - b);
}
