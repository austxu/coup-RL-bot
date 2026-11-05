import type { ActionType, Card } from '../engine/types';
import { RL } from '../engine/encode';
import type { ReqType } from '../engine/encode';

import duke320 from '../assets/cards/duke-320.webp';
import duke720 from '../assets/cards/duke-720.webp';
import assassin320 from '../assets/cards/assassin-320.webp';
import assassin720 from '../assets/cards/assassin-720.webp';
import captain320 from '../assets/cards/captain-320.webp';
import captain720 from '../assets/cards/captain-720.webp';
import ambassador320 from '../assets/cards/ambassador-320.webp';
import ambassador720 from '../assets/cards/ambassador-720.webp';
import contessa320 from '../assets/cards/contessa-320.webp';
import contessa720 from '../assets/cards/contessa-720.webp';
import bear160 from '../assets/cards/bear-160.webp';
import bear320 from '../assets/cards/bear-320.webp';

export const ART: Record<Card, { sm: string; lg: string }> = {
  Duke: { sm: duke320, lg: duke720 },
  Assassin: { sm: assassin320, lg: assassin720 },
  Captain: { sm: captain320, lg: captain720 },
  Ambassador: { sm: ambassador320, lg: ambassador720 },
  Contessa: { sm: contessa320, lg: contessa720 },
};
export const BEAR = { sm: bear160, lg: bear320 };

export const ROLE_CLASS: Record<Card, string> = {
  Duke: 'r-duke',
  Assassin: 'r-assassin',
  Captain: 'r-captain',
  Ambassador: 'r-ambassador',
  Contessa: 'r-contessa',
};

export interface RoleInfo {
  card: Card;
  action: string | null;
  actionText: string | null;
  blocks: string | null;
}

export const ROLES: RoleInfo[] = [
  { card: 'Duke', action: 'Tax', actionText: 'Take 3 coins from the treasury.', blocks: 'Blocks Foreign Aid.' },
  { card: 'Assassin', action: 'Assassinate', actionText: 'Pay 3 coins: your opponent loses an influence.', blocks: null },
  { card: 'Captain', action: 'Steal', actionText: 'Take up to 2 coins from your opponent.', blocks: 'Blocks stealing.' },
  { card: 'Ambassador', action: 'Exchange', actionText: 'Draw 2 from the court deck, return 2.', blocks: 'Blocks stealing.' },
  { card: 'Contessa', action: null, actionText: null, blocks: 'Blocks assassination.' },
];

export interface ActionInfo {
  type: ActionType;
  key: string;
  short: string;
  icon: IconName;
  role: Card | null;
  effect: string;
  cost: number;
}

export type IconName =
  | 'income'
  | 'aid'
  | 'coup'
  | 'tax'
  | 'assassinate'
  | 'steal'
  | 'exchange'
  | 'challenge'
  | 'block'
  | 'lose'
  | 'trophy'
  | 'turn'
  | 'eye'
  | 'eyeOff'
  | 'check'
  | 'x'
  | 'deal'
  | 'spark'
  | 'arrowLeft'
  | 'arrowRight'
  | 'play'
  | 'external'
  | 'help'
  | 'replay'
  | 'coin'
  | 'cpu'
  | 'sound'
  | 'mute'
  | 'brain';

export const ACTIONS: ActionInfo[] = [
  { type: 'Income', key: 'i', short: 'Income', icon: 'income', role: null, effect: '+1 coin', cost: 0 },
  { type: 'Foreign Aid', key: 'f', short: 'Foreign Aid', icon: 'aid', role: null, effect: '+2 · Duke can block', cost: 0 },
  { type: 'Tax', key: 't', short: 'Tax', icon: 'tax', role: 'Duke', effect: '+3 coins', cost: 0 },
  { type: 'Steal', key: 's', short: 'Steal', icon: 'steal', role: 'Captain', effect: 'take 2', cost: 0 },
  { type: 'Exchange', key: 'e', short: 'Exchange', icon: 'exchange', role: 'Ambassador', effect: 'swap cards', cost: 0 },
  { type: 'Assassinate', key: 'a', short: 'Assassinate', icon: 'assassinate', role: 'Assassin', effect: 'pay 3 · kill 1', cost: 3 },
  { type: 'Coup', key: 'c', short: 'Coup', icon: 'coup', role: null, effect: 'pay 7 · unblockable', cost: 7 },
];
export const ACTION_INFO = Object.fromEntries(ACTIONS.map((a) => [a.type, a])) as Record<ActionType, ActionInfo>;

export const ACTION_PAST: Record<ActionType, string> = {
  Income: 'took Income',
  'Foreign Aid': 'took Foreign Aid',
  Coup: 'launched a Coup',
  Tax: 'collected Tax',
  Assassinate: 'assassinated',
  Steal: 'stole',
  Exchange: 'exchanged',
};

/** "PPO-AI claims Duke → Tax", "You take Income" */
export function declareText(name: string, you: boolean, action: ActionType, claim: Card | null, target: string | null) {
  const verb = you ? '' : 's';
  if (claim) return `${name} claim${verb} ${claim} → ${action}${target ? ` on ${target}` : ''}`;
  if (action === 'Coup') return `${name} launch${you ? '' : 'es'} a Coup on ${target}`;
  return `${name} take${verb} ${action}`;
}

/** Label for one RL output index in a given decision context. */
export function optionLabel(req: ReqType, idx: number, opts: { loseLabels?: [string, string] } = {}): string {
  if (req === 'ACT') {
    const names = ['Income', 'Foreign Aid', 'Coup', 'Tax', 'Assassinate', 'Steal', 'Exchange'];
    return names[idx] ?? `#${idx}`;
  }
  if (req === 'CHL' || req === 'CC') return idx === RL.YES ? 'Challenge' : 'Allow';
  if (req === 'CTR') {
    if (idx === RL.NO) return 'Allow';
    const m: Record<number, string> = {
      [RL.BLOCK_DUKE]: 'Block · Duke',
      [RL.BLOCK_CAPTAIN]: 'Block · Captain',
      [RL.BLOCK_AMBASSADOR]: 'Block · Ambassador',
      [RL.BLOCK_CONTESSA]: 'Block · Contessa',
    };
    return m[idx] ?? `#${idx}`;
  }
  if (req === 'LOSE') {
    const [a, b] = opts.loseLabels ?? ['Left card', 'Right card'];
    return idx === RL.LOSE_CARD_0 ? a : b;
  }
  return `#${idx}`;
}

export function optionRole(req: ReqType, idx: number): Card | null {
  if (req === 'ACT') return ([null, null, null, 'Duke', 'Assassin', 'Captain', 'Ambassador'] as (Card | null)[])[idx] ?? null;
  if (req === 'CTR') {
    const m: Record<number, Card> = {
      [RL.BLOCK_DUKE]: 'Duke',
      [RL.BLOCK_CAPTAIN]: 'Captain',
      [RL.BLOCK_AMBASSADOR]: 'Ambassador',
      [RL.BLOCK_CONTESSA]: 'Contessa',
    };
    return m[idx] ?? null;
  }
  return null;
}

export const pct = (p: number) => `${Math.round(p * 100)}%`;
export const pad2 = (n: number) => String(n).padStart(2, '0');
