// Drives one game: runs the engine generator, turns engine events into paced
// "beats" for the table, asks the human or the bot for each decision, and
// records frames for the post-game replay.

import { CoupGame } from '../engine/game';
import { encodePrompt, exchangeHeuristic, rlToAnswer, RL, type ReqType } from '../engine/encode';
import type { Answer, Card, GameEvent, Prompt } from '../engine/types';
import { ACTION_CHARACTER } from '../engine/types';
import type { BotClient } from '../bot/client';
import { Store } from './store';
import { flyCard, flyCoins } from './fx';
import { Cancelled, prefersReducedMotion, sleep, uniform } from './timing';
import { ACTION_INFO, declareText, optionLabel, optionRole, type IconName } from './labels';

export type Mode = 'human' | 'attract';

export interface Slot {
  id: number;
  card: Card;
  dead: boolean;
  dealt: boolean; // visible on the table at all
  open: boolean; // face-up for whoever may see it (owner / x-ray)
  flash: '' | 'proven' | 'lost' | 'swap' | 'new';
  flashKey: number;
}

export interface SeatVM {
  idx: number;
  name: string;
  kind: 'human' | 'bot';
  coins: number;
  slots: Slot[];
  order: number[]; // engine card order -> slot ids
  eliminated: boolean;
  thinking: boolean;
  extra: number; // exchange: cards drawn and held while choosing
  coinPulse: number;
  /** Avatar reaction (bot seats): see ui/Bear.tsx. */
  react: ReactMood | null;
  reactKey: number;
  lookAt: LookTarget;
}

export type ReactMood = 'wave' | 'jump' | 'fail' | 'look';
export type LookTarget = 'opponent' | 'deck' | 'treasury' | 'center';

export type CalloutKind = 'claim' | 'plain' | 'challenge' | 'block' | 'pass' | 'coup';
export interface Callout {
  id: number;
  seat: number;
  kind: CalloutKind;
  text: string;
  role: Card | null;
  bluff: boolean | null;
}

export interface Showdown {
  id: number;
  claimer: number;
  challenger: number;
  card: Card;
  isBlock: boolean;
  result: 'pending' | 'proven' | 'bluff';
}

export interface Toast {
  id: number;
  text: string;
  tone: 'neutral' | 'good' | 'bad' | 'accent';
}

export type Tone = 'neutral' | 'good' | 'bad' | 'accent' | 'muted';
export interface LogEntry {
  id: number;
  turn: number;
  seat: number | null;
  icon: IconName;
  text: string;
  tone: Tone;
  role: Card | null;
}

export interface MindOption {
  idx: number;
  label: string;
  prob: number;
  chosen: boolean;
  role: Card | null;
}

export interface MindEntry {
  id: number;
  seat: number;
  turn: number;
  req: ReqType | 'EXCH';
  title: string;
  options: MindOption[];
  value: number | null;
  sampledBelowTop: boolean;
  ms: number;
}

export interface FrameSeat {
  name: string;
  kind: 'human' | 'bot';
  coins: number;
  cards: Card[];
  revealed: Card[];
}

export interface Frame {
  n: number;
  turn: number;
  seat: number;
  kind: Prompt['k'];
  question: string;
  seats: FrameSeat[];
  deck: number;
  mind: MindEntry | null;
  choice: string;
  claim: { card: Card; held: boolean } | null;
  challengedBy: number | null; // this decision's claim was challenged by…
  caught: boolean; // …and it was a bluff
  challenge: { won: boolean | null } | null; // this decision WAS a challenge
  after: string[];
}

export interface SeatSummary {
  claims: number;
  bluffs: number;
  bluffsCaught: number;
  challenges: number;
  challengesWon: number;
  blocks: number;
}

export interface Outcome {
  winner: number | null;
  turns: number;
  summaries: SeatSummary[];
  finalHands: Card[][];
}

export interface MatchVM {
  mode: Mode;
  viewer: number | null;
  xray: boolean;
  seats: SeatVM[];
  deck: number;
  turn: number;
  current: number | null;
  phase: 'dealing' | 'playing' | 'over';
  callouts: Callout[];
  showdown: Showdown | null;
  toast: Toast | null;
  recap: { text: string; icon: IconName; role: Card | null } | null;
  prompt: Prompt | null;
  log: LogEntry[];
  mind: MindEntry[];
  values: { seat: number; v: number; n: number; turn: number }[];
  narration: string;
  narrationKey: number;
  outcome: Outcome | null;
  frames: Frame[];
  error: string | null;
}

export interface SeatConfig {
  kind: 'human' | 'bot';
  name: string;
}

let uid = 1;
const nextId = () => uid++;

export class Match {
  readonly store: Store<MatchVM>;
  readonly key = `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  private game!: CoupGame;
  private pending: GameEvent[] = [];
  private abort = new AbortController();
  private resolveHuman: ((a: Answer) => void) | null = null;
  private readonly tempo: number;
  private frame: Frame | null = null;
  private lastClaimFrame: Frame | null = null;
  private lastChallengeFrame: Frame | null = null;

  constructor(
    private readonly seats: SeatConfig[],
    private readonly bot: BotClient,
    readonly mode: Mode,
    private readonly onFinish?: (o: Outcome, m: Match) => void,
  ) {
    const viewer = seats.findIndex((s) => s.kind === 'human');
    this.tempo = mode === 'attract' ? 1.45 : 1;
    this.store = new Store<MatchVM>({
      mode,
      viewer: viewer >= 0 ? viewer : null,
      xray: viewer < 0,
      seats: seats.map((s, idx) => ({
        idx,
        name: s.name,
        kind: s.kind,
        coins: 2,
        slots: [],
        order: [],
        eliminated: false,
        thinking: false,
        extra: 0,
        coinPulse: 0,
        react: null,
        reactKey: 0,
        lookAt: 'opponent',
      })),
      deck: 15,
      turn: 0,
      current: null,
      phase: 'dealing',
      callouts: [],
      showdown: null,
      toast: null,
      recap: null,
      prompt: null,
      log: [],
      mind: [],
      values: [],
      narration: '',
      narrationKey: 0,
      outcome: null,
      frames: [],
      error: null,
    });
  }

  get vm(): MatchVM {
    return this.store.state;
  }

  private emit() {
    this.store.emit();
  }

  /** Visible beat length, scaled for attract mode and reduced motion. */
  private wait(ms: number) {
    const k = prefersReducedMotion() ? 0.45 : 1;
    return sleep(ms * this.tempo * k, this.abort.signal);
  }

  private name(i: number) {
    return this.vm.seats[i].name;
  }
  private isViewer(i: number) {
    return this.vm.viewer === i;
  }
  /** "You" for the viewer, the seat name otherwise. */
  private who(i: number) {
    return this.isViewer(i) ? 'You' : this.name(i);
  }

  cancel() {
    this.abort.abort();
    this.resolveHuman = null;
    this.vm.seats.forEach((s) => s.kind === 'bot' && this.bot.release(`${this.key}:${s.idx}`));
  }

  get cancelled() {
    return this.abort.signal.aborted;
  }

  /** Human answer from the UI. Ignored unless a prompt is open (guards double clicks). */
  answer(a: Answer) {
    const r = this.resolveHuman;
    if (!r || !this.vm.prompt) return;
    this.resolveHuman = null;
    this.vm.prompt = null;
    this.emit();
    r(a);
  }

  async run(): Promise<void> {
    try {
      this.game = new CoupGame(
        this.seats.map((s) => s.name),
        { onEvent: (e) => this.pending.push(e) },
      );
      this.seats.forEach((s, i) => s.kind === 'bot' && this.bot.reset(`${this.key}:${i}`));
      const play = this.game.play();
      let r = play.next();
      for (;;) {
        await this.drain();
        if (r.done) break;
        const prompt = r.value;
        this.beginFrame(prompt);
        const answer = this.seats[prompt.p].kind === 'human' ? await this.askHuman(prompt) : await this.askBot(prompt);
        this.finishFrame(prompt, answer);
        r = play.next(answer);
      }
    } catch (err) {
      if (err instanceof Cancelled) return;
      console.error(err);
      this.vm.error = String((err as Error)?.message ?? err);
      this.emit();
    }
  }

  // ---------------------------------------------------------------------------
  // Decisions
  // ---------------------------------------------------------------------------

  private askHuman(prompt: Prompt): Promise<Answer> {
    return new Promise((resolve, reject) => {
      if (this.cancelled) return reject(new Cancelled());
      this.abort.signal.addEventListener('abort', () => reject(new Cancelled()), { once: true });
      this.resolveHuman = resolve;
      this.vm.prompt = prompt;
      this.emit();
    });
  }

  private thinkTime() {
    return this.mode === 'attract' ? uniform(850, 1500) : uniform(500, 1100);
  }

  private async askBot(prompt: Prompt): Promise<Answer> {
    const seat = this.vm.seats[prompt.p];
    const t0 = performance.now();
    const think = this.thinkTime();
    seat.thinking = true;
    this.emit();

    let answer: Answer;
    let entry: MindEntry;
    if (prompt.k === 'exch') {
      answer = exchangeHeuristic(prompt.all, prompt.keep);
      entry = {
        id: nextId(),
        seat: prompt.p,
        turn: this.vm.turn,
        req: 'EXCH',
        title: 'Exchange · keeps its highest-value cards',
        options: [],
        value: null,
        sampledBelowTop: false,
        ms: 0,
      };
    } else {
      const enc = encodePrompt(this.game.state, prompt)!;
      const d = await this.bot.decide(`${this.key}:${prompt.p}`, enc.obs, enc.mask);
      if (this.cancelled) throw new Cancelled();
      answer = rlToAnswer(prompt, d.choice) as Answer;
      const loseLabels = this.loseLabels(prompt.p);
      const options: MindOption[] = [];
      for (let i = 0; i < enc.mask.length; i++) {
        if (!enc.mask[i]) continue;
        options.push({
          idx: i,
          label: optionLabel(enc.req, i, { loseLabels }),
          prob: d.probs[i],
          chosen: i === d.choice,
          role: optionRole(enc.req, i),
        });
      }
      const top = Math.max(...options.map((o) => o.prob));
      entry = {
        id: nextId(),
        seat: prompt.p,
        turn: this.vm.turn,
        req: enc.req,
        title: this.mindTitle(prompt),
        options,
        value: d.value,
        sampledBelowTop: d.probs[d.choice] < top - 1e-9,
        ms: d.ms,
      };
    }
    const left = think - (performance.now() - t0);
    if (left > 0) await sleep(left, this.abort.signal);

    seat.thinking = false;
    this.vm.mind.push(entry);
    if (entry.value !== null) {
      this.vm.values.push({ seat: prompt.p, v: entry.value, n: this.vm.values.length, turn: this.vm.turn });
    }
    if (this.frame) this.frame.mind = entry;
    this.emit();
    return answer;
  }

  private loseLabels(p: number): [string, string] {
    const seat = this.vm.seats[p];
    const pos = (slotId: number) => (seat.slots.findIndex((s) => s.id === slotId) === 0 ? 'Left card' : 'Right card');
    return [pos(seat.order[0]), pos(seat.order[1])];
  }

  private mindTitle(p: Prompt): string {
    switch (p.k) {
      case 'act':
        return p.legal.every((a) => a.type === 'Coup') ? 'Forced to Coup (10+ coins)' : 'Choosing an action';
      case 'chl': {
        const blk = this.game.state.history.at(-1);
        const isBlock = this.vm.callouts.some((c) => c.seat === p.claimer && c.kind === 'block');
        void blk;
        return `Challenge ${this.isViewer(p.claimer) ? 'your' : `${this.name(p.claimer)}'s`} ${p.card}${isBlock ? ' block' : ''}?`;
      }
      case 'blk':
        return `Block ${this.isViewer(p.actor) ? 'your' : `${this.name(p.actor)}'s`} ${p.action}?`;
      case 'lose':
        return 'Which influence to give up';
      case 'exch':
        return 'Exchange';
    }
  }

  // ---------------------------------------------------------------------------
  // Replay frames
  // ---------------------------------------------------------------------------

  private beginFrame(prompt: Prompt) {
    const s = this.game.state;
    const f: Frame = {
      n: this.vm.frames.length,
      turn: s.turn,
      seat: prompt.p,
      kind: prompt.k,
      question: this.frameQuestion(prompt),
      seats: s.players.map((pl, i) => ({
        name: this.name(i),
        kind: this.seats[i].kind,
        coins: pl.coins,
        cards: [...pl.cards],
        revealed: [...pl.revealed],
      })),
      deck: s.deck.length,
      mind: null,
      choice: '',
      claim: null,
      challengedBy: null,
      caught: false,
      challenge: null,
      after: [],
    };
    this.frame = f;
    this.vm.frames.push(f);
  }

  private frameQuestion(p: Prompt): string {
    const you = this.isViewer(p.p);
    const n = you ? 'You' : this.name(p.p);
    const s = you ? '' : 's';
    const their = (i: number) => (this.isViewer(i) ? 'your' : `${this.name(i)}'s`);
    switch (p.k) {
      case 'act':
        return p.legal.every((a) => a.type === 'Coup') ? `${n} must Coup` : `${n} choose${s} an action`;
      case 'chl':
        return `${n}: challenge ${their(p.claimer)} ${p.card}?`;
      case 'blk':
        return `${n}: block ${their(p.actor)} ${p.action}?`;
      case 'lose':
        return `${n} must give up an influence`;
      case 'exch':
        return `${n} exchange${s}: keep ${p.keep} of ${p.all.length}`;
    }
  }

  private finishFrame(prompt: Prompt, a: Answer) {
    const f = this.frame;
    if (!f) return;
    const hand = this.game.state.players[prompt.p].cards;
    switch (prompt.k) {
      case 'act': {
        const act = prompt.legal[a as number];
        const claim = ACTION_CHARACTER[act.type] ?? null;
        f.choice = claim ? `${act.type} (claims ${claim})` : act.type;
        if (claim) {
          f.claim = { card: claim, held: hand.includes(claim) };
          this.lastClaimFrame = f;
        }
        break;
      }
      case 'chl':
        f.choice = a ? 'Challenge' : 'Allow';
        if (a) {
          f.challenge = { won: null };
          this.lastChallengeFrame = f;
          if (this.lastClaimFrame) this.lastClaimFrame.challengedBy = prompt.p;
        }
        break;
      case 'blk':
        if (a) {
          const card = a as Card;
          f.choice = `Block with ${card}`;
          f.claim = { card, held: hand.includes(card) };
          this.lastClaimFrame = f;
        } else f.choice = 'Allow';
        break;
      case 'lose':
        f.choice = `Reveal ${hand[Math.max(0, Math.min(a as number, hand.length - 1))]}`;
        break;
      case 'exch': {
        const kept = (a as number[]).map((i) => prompt.all[i]);
        f.choice = `Keep ${kept.join(' + ')}`;
        break;
      }
    }
  }

  private note(text: string) {
    this.frame?.after.push(text);
  }

  // ---------------------------------------------------------------------------
  // Beats
  // ---------------------------------------------------------------------------

  private say(text: string, icon: IconName, tone: Tone = 'neutral', seat: number | null = null, role: Card | null = null) {
    this.vm.log.push({ id: nextId(), turn: this.vm.turn, seat, icon, text, tone, role });
    if (this.vm.log.length > 400) this.vm.log.splice(0, this.vm.log.length - 400);
    this.vm.narration = text;
    this.vm.narrationKey++;
    this.note(text);
  }

  private callout(c: Omit<Callout, 'id'>) {
    this.vm.callouts = [...this.vm.callouts.filter((x) => x.seat !== c.seat), { ...c, id: nextId() }];
  }

  /** Make a bot seat's avatar react. */
  private react(seat: number, mood: ReactMood, lookAt: LookTarget = 'opponent') {
    const s = this.vm.seats[seat];
    if (s.kind !== 'bot') return;
    s.react = mood;
    s.lookAt = lookAt;
    s.reactKey++;
  }

  private toast(text: string, tone: Toast['tone']) {
    this.vm.toast = { id: nextId(), text, tone };
  }

  private async drain() {
    while (this.pending.length) {
      const e = this.pending.shift()!;
      await this.beat(e);
    }
  }

  private slotFor(seat: SeatVM, engineIdx: number): Slot {
    return seat.slots.find((s) => s.id === seat.order[engineIdx])!;
  }

  private async beat(e: GameEvent) {
    const vm = this.vm;
    switch (e.t) {
      case 'deal': {
        vm.phase = 'dealing';
        vm.deck = 15;
        vm.seats.forEach((seat, i) => {
          seat.slots = e.hands[i].map((card, k) => ({
            id: k,
            card,
            dead: false,
            dealt: false,
            open: false,
            flash: '',
            flashKey: 0,
          }));
          seat.order = e.hands[i].map((_, k) => k);
        });
        vm.seats.forEach((s) => this.react(s.idx, 'wave'));
        this.emit();
        await this.wait(250);
        for (let k = 0; k < 2; k++) {
          for (let i = 0; i < vm.seats.length; i++) {
            flyCard('deck', `seat-${i}-slot-${k}`, { speed: this.tempo });
            await this.wait(150);
            vm.deck--;
            this.emit();
          }
        }
        await this.wait(450);
        vm.seats.forEach((s) => s.slots.forEach((sl) => (sl.dealt = true)));
        this.emit();
        await this.wait(250);
        vm.seats.forEach((s, i) => {
          if (this.isViewer(i) || vm.xray) s.slots.forEach((sl) => (sl.open = true));
        });
        vm.phase = 'playing';
        this.say(
          vm.viewer !== null
            ? `Cards dealt. You hold ${e.hands[vm.viewer].join(' and ')}.`
            : `Cards dealt. ${this.name(0)} holds ${e.hands[0].join(' + ')}; ${this.name(1)} holds ${e.hands[1].join(' + ')}.`,
          'deal',
          'muted',
        );
        this.emit();
        await this.wait(550);
        break;
      }
      case 'turn': {
        vm.turn = e.turn;
        vm.current = e.player;
        vm.callouts = [];
        vm.showdown = null;
        vm.toast = null;
        this.emit();
        await this.wait(220);
        break;
      }
      case 'declare': {
        const you = this.isViewer(e.player);
        const target = e.target !== null ? this.who(e.target) : null;
        const text = declareText(this.who(e.player), you, e.action, e.claim, target === 'You' ? 'you' : target);
        const seat = vm.seats[e.player];
        const bluff =
          e.claim && (you || vm.xray) ? !seat.slots.some((s) => !s.dead && s.card === e.claim) : null;
        const info = ACTION_INFO[e.action];
        this.callout({
          seat: e.player,
          kind: e.claim ? 'claim' : e.action === 'Coup' ? 'coup' : 'plain',
          text: e.claim ? `${e.claim} → ${e.action}` : e.action,
          role: e.claim,
          bluff,
        });
        vm.recap = { text, icon: info.icon, role: e.claim };
        this.react(1 - e.player, 'look', 'opponent');
        this.say(text, info.icon, e.action === 'Coup' || e.action === 'Assassinate' ? 'bad' : 'neutral', e.player, e.claim);
        this.emit();
        await this.wait(you ? 520 : 950);
        break;
      }
      case 'pay': {
        const seat = vm.seats[e.player];
        flyCoins(`seat-${e.player}-coins`, 'treasury', e.amount, this.tempo);
        seat.coins -= e.amount;
        seat.coinPulse++;
        this.emit();
        await this.wait(560);
        break;
      }
      case 'challenge': {
        this.callout({ seat: e.challenger, kind: 'challenge', text: 'Challenge!', role: null, bluff: null });
        this.react(e.claimer, 'look', 'center');
        vm.showdown = {
          id: nextId(),
          claimer: e.claimer,
          challenger: e.challenger,
          card: e.card,
          isBlock: e.isBlock,
          result: 'pending',
        };
        this.say(
          `${this.who(e.challenger)} challenge${this.isViewer(e.challenger) ? '' : 's'} ${this.isViewer(e.claimer) ? 'your' : `${this.name(e.claimer)}'s`} ${e.card}${e.isBlock ? ' block' : ''}`,
          'challenge',
          'accent',
          e.challenger,
          e.card,
        );
        this.emit();
        await this.wait(1100);
        break;
      }
      case 'proven': {
        const seat = vm.seats[e.claimer];
        const slot = this.slotFor(seat, e.slot);
        vm.showdown = vm.showdown ? { ...vm.showdown, result: 'proven' } : null;
        slot.flash = 'proven';
        slot.flashKey++;
        if (vm.xray || this.isViewer(e.claimer)) slot.open = true;
        if (this.lastChallengeFrame?.challenge) this.lastChallengeFrame.challenge.won = false;
        this.react(e.claimer, 'jump');
        this.react(1 - e.claimer, 'fail');
        this.say(
          `${this.who(e.claimer)} reveal${this.isViewer(e.claimer) ? '' : 's'} ${e.card}: the claim holds. The card is shuffled back and replaced.`,
          'check',
          'good',
          e.claimer,
          e.card,
        );
        this.emit();
        await this.wait(1500);
        // card goes back into the deck, a fresh one comes out
        flyCard(`seat-${e.claimer}-slot-${slot.id}`, 'deck', { speed: this.tempo });
        slot.open = false;
        slot.dealt = false;
        this.emit();
        await this.wait(420);
        flyCard('deck', `seat-${e.claimer}-slot-${slot.id}`, { speed: this.tempo });
        await this.wait(520);
        slot.card = e.newCard;
        slot.dealt = true;
        slot.flash = 'new';
        slot.flashKey++;
        seat.order = [...seat.order.filter((id) => id !== slot.id), slot.id];
        this.emit();
        await this.wait(200);
        if (vm.xray || this.isViewer(e.claimer)) slot.open = true;
        this.emit();
        await this.wait(380);
        break;
      }
      case 'bluffCaught': {
        vm.showdown = vm.showdown ? { ...vm.showdown, result: 'bluff' } : null;
        if (this.lastChallengeFrame?.challenge) this.lastChallengeFrame.challenge.won = true;
        if (this.lastClaimFrame) this.lastClaimFrame.caught = true;
        this.react(1 - e.claimer, 'jump');
        this.react(e.claimer, 'fail');
        this.say(
          `Bluff exposed: ${this.isViewer(e.claimer) ? "you don't" : `${this.name(e.claimer)} doesn't`} have ${e.card}.`,
          'x',
          'bad',
          e.claimer,
          e.card,
        );
        this.emit();
        await this.wait(1400);
        break;
      }
      case 'lose': {
        const seat = vm.seats[e.player];
        const slot = this.slotFor(seat, e.slot);
        seat.order = seat.order.filter((id) => id !== slot.id);
        slot.card = e.card;
        slot.open = true;
        slot.dead = true;
        slot.flash = 'lost';
        slot.flashKey++;
        if (e.eliminated) seat.eliminated = true;
        this.react(e.player, 'fail');
        this.say(
          `${this.who(e.player)} lose${this.isViewer(e.player) ? '' : 's'} ${e.card}${e.eliminated ? ' and ' + (this.isViewer(e.player) ? 'are' : 'is') + ' out' : ''}.`,
          'lose',
          'bad',
          e.player,
          e.card,
        );
        this.emit();
        await this.wait(e.eliminated ? 1300 : 1050);
        vm.showdown = null;
        this.emit();
        break;
      }
      case 'block': {
        this.callout({ seat: e.blocker, kind: 'block', text: `Blocks with ${e.card}`, role: e.card, bluff: null });
        const bluff = this.isViewer(e.blocker) || vm.xray
          ? !vm.seats[e.blocker].slots.some((s) => !s.dead && s.card === e.card)
          : null;
        if (bluff !== null) this.vm.callouts.at(-1)!.bluff = bluff;
        this.say(
          `${this.who(e.blocker)} block${this.isViewer(e.blocker) ? '' : 's'} the ${e.action} with ${e.card}`,
          'block',
          'accent',
          e.blocker,
          e.card,
        );
        this.emit();
        await this.wait(this.isViewer(e.blocker) ? 520 : 950);
        break;
      }
      case 'blocked': {
        this.toast(`${e.action} blocked`, 'neutral');
        vm.recap = { text: `${this.who(e.actor)}${this.isViewer(e.actor) ? 'r' : "'s"} ${e.action} was blocked by ${e.card}`, icon: 'block', role: e.card };
        this.say(`The ${e.action} is blocked.`, 'block', 'muted', e.actor);
        this.emit();
        await this.wait(750);
        break;
      }
      case 'coins': {
        const seat = vm.seats[e.player];
        const from = e.from === 'bank' ? 'treasury' : `seat-${e.from}-coins`;
        if (e.delta > 0) flyCoins(from, `seat-${e.player}-coins`, e.delta, this.tempo);
        this.react(e.player, 'look', e.from === 'bank' ? 'treasury' : 'opponent');
        await this.wait(260);
        seat.coins += e.delta;
        seat.coinPulse++;
        if (e.from !== 'bank') {
          vm.seats[e.from].coins -= e.delta;
          vm.seats[e.from].coinPulse++;
        }
        const you = this.isViewer(e.player);
        const txt =
          e.from === 'bank'
            ? `${this.who(e.player)} gain${you ? '' : 's'} ${e.delta} coin${e.delta === 1 ? '' : 's'} (${e.action})`
            : `${this.who(e.player)} steal${you ? '' : 's'} ${e.delta} coin${e.delta === 1 ? '' : 's'} from ${this.isViewer(e.from) ? 'you' : this.name(e.from)}`;
        vm.recap = { text: txt, icon: ACTION_INFO[e.action].icon, role: ACTION_CHARACTER[e.action] ?? null };
        this.say(txt, 'coin', 'good', e.player);
        this.emit();
        await this.wait(520);
        break;
      }
      case 'exchangeDraw': {
        const seat = vm.seats[e.player];
        for (let k = 0; k < e.drawn.length; k++) {
          flyCard('deck', `seat-${e.player}-hand`, { delay: k * 120, speed: this.tempo });
        }
        await this.wait(380);
        vm.deck -= e.drawn.length;
        seat.extra = e.drawn.length;
        this.react(1 - e.player, 'look', 'deck');
        this.say(`${this.who(e.player)} draw${this.isViewer(e.player) ? '' : 's'} ${e.drawn.length} from the court deck`, 'exchange', 'neutral', e.player, 'Ambassador');
        this.emit();
        await this.wait(500);
        break;
      }
      case 'exchangeDone': {
        const seat = vm.seats[e.player];
        e.kept.forEach((card, i) => {
          const slot = seat.slots.find((s) => s.id === seat.order[i])!;
          if (slot.card !== card) {
            slot.card = card;
          }
          slot.flash = 'swap';
          slot.flashKey++;
          if (!(vm.xray || this.isViewer(e.player))) slot.open = false;
        });
        seat.extra = 0;
        for (let k = 0; k < e.returned; k++) flyCard(`seat-${e.player}-hand`, 'deck', { delay: k * 120, speed: this.tempo });
        await this.wait(420);
        vm.deck += e.returned;
        vm.recap = { text: `${this.who(e.player)} exchanged cards with the court deck`, icon: 'exchange', role: 'Ambassador' };
        this.say(`${this.who(e.player)} return${this.isViewer(e.player) ? '' : 's'} ${e.returned} card${e.returned === 1 ? '' : 's'} and shuffle${this.isViewer(e.player) ? '' : 's'} the deck`, 'exchange', 'muted', e.player);
        this.emit();
        await this.wait(500);
        break;
      }
      case 'fizzle': {
        const txt = e.reason === 'bluff' ? `${e.action} fails — the claim was a bluff` : `${e.action} fizzles — target already out`;
        this.toast(txt, 'bad');
        vm.recap = { text: txt, icon: 'x', role: null };
        this.say(txt, 'x', 'muted', e.player);
        this.emit();
        await this.wait(700);
        break;
      }
      case 'gameOver': {
        vm.current = null;
        vm.callouts = [];
        vm.toast = null;
        const outcome: Outcome = {
          winner: e.winner,
          turns: e.turns,
          summaries: this.summaries(),
          finalHands: this.game.state.players.map((p) => [...p.cards]),
        };
        // the game is over: everything may be shown now
        vm.seats.forEach((s) => s.slots.forEach((sl) => (sl.open = true)));
        vm.outcome = outcome;
        vm.phase = 'over';
        vm.seats.forEach((s) => this.react(s.idx, s.idx === e.winner ? 'jump' : 'fail'));
        const txt =
          e.winner === null
            ? 'Draw — the 500-turn limit was reached.'
            : this.isViewer(e.winner)
              ? `You win in ${e.turns} turns.`
              : `${this.name(e.winner)} wins in ${e.turns} turns.`;
        this.say(txt, 'trophy', e.winner !== null && this.isViewer(e.winner) ? 'good' : 'accent', e.winner);
        this.emit();
        this.onFinish?.(outcome, this);
        break;
      }
    }
  }

  summaries(): SeatSummary[] {
    return this.vm.seats.map((_, i) => {
      const s: SeatSummary = { claims: 0, bluffs: 0, bluffsCaught: 0, challenges: 0, challengesWon: 0, blocks: 0 };
      for (const f of this.vm.frames) {
        if (f.seat !== i) continue;
        if (f.claim) {
          s.claims++;
          if (f.kind === 'blk') s.blocks++;
          if (!f.claim.held) {
            s.bluffs++;
            if (f.caught) s.bluffsCaught++;
          }
        }
        if (f.challenge) {
          s.challenges++;
          if (f.challenge.won) s.challengesWon++;
        }
      }
      return s;
    });
  }
}

export const RL_INDEX = RL;
