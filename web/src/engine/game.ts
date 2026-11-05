// Line-for-line port of coup/game.py (CoupGame + GameState).
//
// The Python engine calls agents synchronously; here every agent call is a
// `yield` of a Prompt, and the driver resumes the generator with the Answer.
// The order of prompts, state mutations and shuffles is identical, which the
// parity tests check against recorded Python games.

import {
  ACTION_CHARACTER,
  ANYONE_CAN_BLOCK,
  CARDS,
  COUNTERABLE_BY,
  type Action,
  type ActionType,
  type Answer,
  type Card,
  type GameEvent,
  type HistoryEntry,
  type PlayerState,
  type Prompt,
} from './types';

export type Shuffler = (deck: Card[]) => void;
type Step<T> = Generator<Prompt, T, Answer>;

/** Fisher–Yates with a crypto-quality source when available. */
export function randomShuffle(deck: Card[]): void {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
}

export function randomInt(n: number): number {
  const c = globalThis.crypto;
  if (c?.getRandomValues) {
    // rejection sampling to avoid modulo bias
    const lim = Math.floor(0x100000000 / n) * n;
    const buf = new Uint32Array(1);
    for (;;) {
      c.getRandomValues(buf);
      if (buf[0] < lim) return buf[0] % n;
    }
  }
  return Math.floor(Math.random() * n);
}

export class GameState {
  readonly names: string[];
  deck: Card[] = [];
  players: PlayerState[] = [];
  current = 0;
  turn = 0;
  history: HistoryEntry[] = [];

  constructor(names: string[], shuffle: Shuffler) {
    if (names.length < 2 || names.length > 6) throw new Error('Coup supports 2-6 players');
    this.names = [...names];
    for (const card of CARDS) this.deck.push(card, card, card);
    shuffle(this.deck);
    for (let i = 0; i < names.length; i++) {
      const cards = [this.deck.pop()!, this.deck.pop()!];
      this.players.push({ id: i, coins: 2, cards, revealed: [], claimed: new Set(), caught: 0 });
    }
  }

  get numAlive(): number {
    return this.players.filter((p) => p.cards.length > 0).length;
  }
  get gameOver(): boolean {
    return this.numAlive <= 1;
  }
  get winner(): number | null {
    if (!this.gameOver) return null;
    const p = this.players.find((q) => q.cards.length > 0);
    return p ? p.id : null;
  }
  alive(i: number): boolean {
    return this.players[i].cards.length > 0;
  }
  advanceToNextAlive(): void {
    const n = this.players.length;
    let idx = (this.current + 1) % n;
    while (!this.alive(idx)) idx = (idx + 1) % n;
    this.current = idx;
  }
  totalCardsCheck(): void {
    let total = this.deck.length;
    for (const p of this.players) total += p.cards.length + p.revealed.length;
    if (total !== 15) throw new Error(`Card integrity violation: ${total} cards (expected 15)`);
  }
}

export interface GameOptions {
  shuffle?: Shuffler;
  onEvent?: (e: GameEvent) => void;
  maxTurns?: number;
}

export class CoupGame {
  readonly state: GameState;
  readonly maxTurns: number;
  private readonly shuffle: Shuffler;
  private readonly emit: (e: GameEvent) => void;

  constructor(names: string[], opts: GameOptions = {}) {
    this.shuffle = opts.shuffle ?? randomShuffle;
    this.emit = opts.onEvent ?? (() => {});
    this.maxTurns = opts.maxTurns ?? 500;
    this.state = new GameState(names, this.shuffle);
  }

  // ---------------------------------------------------------------------------
  // Legal actions
  // ---------------------------------------------------------------------------

  legalActions(p: number): Action[] {
    const player = this.state.players[p];
    const opps = this.state.players.filter((q) => q.cards.length > 0 && q.id !== p).map((q) => q.id);
    const out: Action[] = [];
    const add = (type: ActionType, target: number | null = null) => out.push({ type, player: p, target });

    if (player.coins >= 10) {
      for (const t of opps) add('Coup', t);
      return out;
    }
    add('Income');
    add('Foreign Aid');
    if (player.coins >= 7) for (const t of opps) add('Coup', t);
    add('Tax');
    add('Exchange');
    if (player.coins >= 3) for (const t of opps) add('Assassinate', t);
    for (const t of opps) add('Steal', t);
    return out;
  }

  // ---------------------------------------------------------------------------
  // Challenges
  // ---------------------------------------------------------------------------

  /** Returns true if the challenge SUCCEEDED (claimer was bluffing). */
  private *resolveChallenge(claimerIdx: number, challengerIdx: number, card: Card): Step<boolean> {
    const claimer = this.state.players[claimerIdx];
    claimer.claimed.add(card);

    if (claimer.cards.includes(card)) {
      const slot = claimer.cards.indexOf(card);
      claimer.cards.splice(slot, 1);
      this.state.deck.push(card);
      this.shuffle(this.state.deck);
      const newCard = this.state.deck.pop()!;
      claimer.cards.push(newCard);
      this.emit({ t: 'proven', claimer: claimerIdx, card, slot, newCard });
      yield* this.loseInfluence(challengerIdx);
      return false;
    }
    claimer.caught += 1;
    this.emit({ t: 'bluffCaught', claimer: claimerIdx, card });
    yield* this.loseInfluence(claimerIdx);
    return true;
  }

  private *loseInfluence(p: number): Step<void> {
    const player = this.state.players[p];
    if (player.cards.length === 0) return;

    let idx: number;
    let forced = false;
    if (player.cards.length === 1) {
      idx = 0;
      forced = true;
    } else {
      const a = yield { k: 'lose', p };
      idx = typeof a === 'number' && Number.isFinite(a) ? Math.trunc(a) : 0;
      idx = Math.max(0, Math.min(idx, player.cards.length - 1));
    }
    const [card] = player.cards.splice(idx, 1);
    player.revealed.push(card);
    this.emit({ t: 'lose', player: p, card, slot: idx, eliminated: player.cards.length === 0, forced });
  }

  private *askForChallenges(claimerIdx: number, card: Card, isBlock: boolean): Step<number | null> {
    const n = this.state.players.length;
    for (let off = 1; off < n; off++) {
      const p = (claimerIdx + off) % n;
      if (!this.state.alive(p)) continue;
      const a = yield { k: 'chl', p, claimer: claimerIdx, card };
      if (a === true) {
        this.emit({ t: 'challenge', challenger: p, claimer: claimerIdx, card, isBlock });
        return p;
      }
    }
    return null;
  }

  private *askForCounteraction(action: Action): Step<[number, Card] | null> {
    const cards = COUNTERABLE_BY[action.type];
    if (!cards) return null;

    let eligible: number[];
    if (ANYONE_CAN_BLOCK.has(action.type)) {
      eligible = this.state.players.filter((q) => q.cards.length > 0 && q.id !== action.player).map((q) => q.id);
    } else {
      if (action.target === null) return null;
      eligible = this.state.alive(action.target) ? [action.target] : [];
    }

    for (const p of eligible) {
      const a = yield { k: 'blk', p, actor: action.player, action: action.type, cards: [...cards] };
      if (a !== null && a !== undefined) {
        const card = a as Card;
        if (!cards.includes(card)) throw new Error(`illegal block card ${String(a)}`);
        this.emit({ t: 'block', blocker: p, card, action: action.type, actor: action.player });
        return [p, card];
      }
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Resolution
  // ---------------------------------------------------------------------------

  private *resolveAction(action: Action): Step<void> {
    const player = this.state.players[action.player];
    switch (action.type) {
      case 'Income':
        player.coins += 1;
        this.emit({ t: 'coins', player: action.player, delta: 1, from: 'bank', action: action.type });
        break;
      case 'Foreign Aid':
        player.coins += 2;
        this.emit({ t: 'coins', player: action.player, delta: 2, from: 'bank', action: action.type });
        break;
      case 'Coup':
        yield* this.loseInfluence(action.target!);
        break;
      case 'Tax':
        player.coins += 3;
        this.emit({ t: 'coins', player: action.player, delta: 3, from: 'bank', action: action.type });
        break;
      case 'Assassinate':
        if (this.state.alive(action.target!)) yield* this.loseInfluence(action.target!);
        break;
      case 'Steal': {
        const target = this.state.players[action.target!];
        const stolen = Math.min(2, target.coins);
        target.coins -= stolen;
        player.coins += stolen;
        this.emit({ t: 'coins', player: action.player, delta: stolen, from: action.target!, action: action.type });
        break;
      }
      case 'Exchange':
        yield* this.resolveExchange(action.player);
        break;
    }
  }

  private *resolveExchange(p: number): Step<void> {
    const player = this.state.players[p];
    const drawn: Card[] = [];
    const nDraw = Math.min(2, this.state.deck.length);
    for (let i = 0; i < nDraw; i++) drawn.push(this.state.deck.pop()!);
    if (drawn.length === 0) return;

    const all = [...player.cards, ...drawn];
    const keep = player.cards.length;
    this.emit({ t: 'exchangeDraw', player: p, drawn: [...drawn] });

    const a = yield { k: 'exch', p, all: [...all], keep };
    let kept = Array.isArray(a) ? (a as number[]) : null;
    if (
      kept === null ||
      kept.length !== keep ||
      kept.some((i) => !Number.isInteger(i) || i < 0 || i >= all.length) ||
      new Set(kept).size !== keep
    ) {
      kept = Array.from({ length: keep }, (_, i) => i);
    }
    const newCards = kept.map((i) => all[i]);
    const returned = all.filter((_, i) => !kept!.includes(i));
    player.cards = newCards;
    this.state.deck.push(...returned);
    this.shuffle(this.state.deck);
    this.emit({ t: 'exchangeDone', player: p, kept: [...newCards], returned: returned.length });
  }

  // ---------------------------------------------------------------------------
  // Turn flow
  // ---------------------------------------------------------------------------

  private *playTurn(): Step<void> {
    const s = this.state;
    const pIdx = s.current;
    const player = s.players[pIdx];
    if (!s.alive(pIdx)) {
      s.advanceToNextAlive();
      return;
    }
    s.turn += 1;
    this.emit({ t: 'turn', turn: s.turn, player: pIdx });

    // 1. choose an action
    const legal = this.legalActions(pIdx);
    const a = yield { k: 'act', p: pIdx, legal };
    if (typeof a !== 'number' || !legal[a]) throw new Error(`illegal action index ${String(a)}`);
    const action = legal[a];
    this.emit({
      t: 'declare',
      player: pIdx,
      action: action.type,
      target: action.target,
      claim: ACTION_CHARACTER[action.type] ?? null,
    });

    const entry: HistoryEntry = {
      turn: s.turn,
      player: pIdx,
      action: action.type,
      target: action.target,
      was_blocked: false,
      was_challenged: false,
      challenge_won: false,
      card_lost: false,
    };
    s.history.push(entry);

    // 2. pay costs up front
    if (action.type === 'Coup') {
      player.coins -= 7;
      this.emit({ t: 'pay', player: pIdx, amount: 7, action: action.type });
    } else if (action.type === 'Assassinate') {
      player.coins -= 3;
      this.emit({ t: 'pay', player: pIdx, amount: 3, action: action.type });
    }

    // 3. coup / income: unchallengeable, unblockable
    if (action.type === 'Coup' || action.type === 'Income') {
      if (action.type === 'Coup') entry.card_lost = true;
      yield* this.resolveAction(action);
      s.totalCardsCheck();
      if (!s.gameOver) s.advanceToNextAlive();
      return;
    }

    // 4. challenge phase
    let actionBlocked = false;
    const claimed = ACTION_CHARACTER[action.type];
    if (claimed) {
      const challenger = yield* this.askForChallenges(pIdx, claimed, false);
      if (challenger !== null) {
        entry.was_challenged = true;
        const bluffing = yield* this.resolveChallenge(pIdx, challenger, claimed);
        entry.challenge_won = bluffing;
        if (bluffing) actionBlocked = true;
        if (s.gameOver) return;
      }
    }

    if (actionBlocked) {
      this.emit({ t: 'fizzle', player: pIdx, action: action.type, reason: 'bluff' });
      s.totalCardsCheck();
      if (!s.gameOver) s.advanceToNextAlive();
      return;
    }

    if (action.target !== null && !s.alive(action.target)) {
      this.emit({ t: 'fizzle', player: pIdx, action: action.type, reason: 'target-dead' });
      s.totalCardsCheck();
      if (!s.gameOver) s.advanceToNextAlive();
      return;
    }

    // 5. counteraction phase
    const counter = yield* this.askForCounteraction(action);
    if (counter !== null) {
      const [blocker, blockCard] = counter;
      const counterChallenger = yield* this.askForChallenges(blocker, blockCard, true);
      if (counterChallenger !== null) {
        const counterWasBluff = yield* this.resolveChallenge(blocker, counterChallenger, blockCard);
        if (s.gameOver) return;
        if (counterWasBluff) {
          if (action.target === null || s.alive(action.target)) {
            if (action.type === 'Assassinate') entry.card_lost = true;
            yield* this.resolveAction(action);
          }
        } else {
          entry.was_blocked = true;
          this.emit({ t: 'blocked', actor: pIdx, action: action.type, blocker, card: blockCard });
        }
      } else {
        entry.was_blocked = true;
        this.emit({ t: 'blocked', actor: pIdx, action: action.type, blocker, card: blockCard });
      }
    } else {
      if (action.type === 'Assassinate') entry.card_lost = true;
      yield* this.resolveAction(action);
    }

    s.totalCardsCheck();
    if (!s.gameOver) s.advanceToNextAlive();
  }

  /** Full game. Resolves to the winner's index, or null on the 500-turn cap. */
  *play(): Step<number | null> {
    this.emit({
      t: 'deal',
      hands: this.state.players.map((p) => [...p.cards]),
      deck: this.state.deck.length,
    });
    while (!this.state.gameOver && this.state.turn < this.maxTurns) {
      yield* this.playTurn();
    }
    const winner = this.state.winner;
    this.emit({ t: 'gameOver', winner, turns: this.state.turn });
    return winner;
  }
}
