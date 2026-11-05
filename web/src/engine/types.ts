// Mirrors the enums and tables in coup/game.py. String values are identical to
// the Python Enum values so fixtures can be compared directly.

export type Card = 'Duke' | 'Assassin' | 'Captain' | 'Ambassador' | 'Contessa';
export const CARDS: readonly Card[] = ['Duke', 'Assassin', 'Captain', 'Ambassador', 'Contessa'];

export type ActionType =
  | 'Income'
  | 'Foreign Aid'
  | 'Coup'
  | 'Tax'
  | 'Assassinate'
  | 'Steal'
  | 'Exchange';

export const ACTION_CHARACTER: Partial<Record<ActionType, Card>> = {
  Tax: 'Duke',
  Assassinate: 'Assassin',
  Steal: 'Captain',
  Exchange: 'Ambassador',
};

export const COUNTERABLE_BY: Partial<Record<ActionType, Card[]>> = {
  'Foreign Aid': ['Duke'],
  Assassinate: ['Contessa'],
  Steal: ['Captain', 'Ambassador'],
};

export const ANYONE_CAN_BLOCK: ReadonlySet<ActionType> = new Set<ActionType>(['Foreign Aid']);

export interface Action {
  type: ActionType;
  player: number;
  target: number | null;
}

export interface PlayerState {
  id: number;
  coins: number;
  cards: Card[]; // hidden, alive influence (order matters: LOSE_CARD_0/1)
  revealed: Card[]; // face-up, dead influence
  claimed: Set<Card>;
  caught: number; // times this player lost a challenge as the claimer
}

export interface HistoryEntry {
  turn: number;
  player: number;
  action: ActionType;
  target: number | null;
  was_blocked: boolean;
  was_challenged: boolean;
  challenge_won: boolean;
  card_lost: boolean;
}

/** A decision the engine needs from a player, in the exact order Python asks. */
export type Prompt =
  | { k: 'act'; p: number; legal: Action[] }
  | { k: 'chl'; p: number; claimer: number; card: Card }
  | { k: 'blk'; p: number; actor: number; action: ActionType; cards: Card[] }
  | { k: 'lose'; p: number }
  | { k: 'exch'; p: number; all: Card[]; keep: number };

/** Answers, keyed by prompt kind. */
export type Answer =
  | number // act: index into legal; lose: card index
  | boolean // chl
  | Card
  | null // blk
  | number[]; // exch: indices of all[] to keep

/** Narrative events for the UI. Emitted synchronously as the engine runs. */
export type GameEvent =
  | { t: 'deal'; hands: Card[][]; deck: number }
  | { t: 'turn'; turn: number; player: number }
  | { t: 'declare'; player: number; action: ActionType; target: number | null; claim: Card | null }
  | { t: 'pay'; player: number; amount: number; action: ActionType }
  | { t: 'challenge'; challenger: number; claimer: number; card: Card; isBlock: boolean }
  | { t: 'proven'; claimer: number; card: Card; slot: number; newCard: Card }
  | { t: 'bluffCaught'; claimer: number; card: Card }
  | { t: 'lose'; player: number; card: Card; slot: number; eliminated: boolean; forced: boolean }
  | { t: 'block'; blocker: number; card: Card; action: ActionType; actor: number }
  | { t: 'blocked'; actor: number; action: ActionType; blocker: number; card: Card }
  | { t: 'coins'; player: number; delta: number; from: 'bank' | number; action: ActionType }
  | { t: 'exchangeDraw'; player: number; drawn: Card[] }
  | { t: 'exchangeDone'; player: number; kept: Card[]; returned: number }
  | { t: 'fizzle'; player: number; action: ActionType; reason: 'bluff' | 'target-dead' }
  | { t: 'gameOver'; winner: number | null; turns: number };
