import type { ModelId } from '../bot/protocol';
// Local record + name. Keys match the previous Socket.IO frontend so existing
// visitors keep their W/L. Every access is guarded: storage can throw.
const STATS_KEY = 'coupStats';
const NAME_KEY = 'coupPlayerName';

export interface PlayerRecord {
  wins: number;
  losses: number;
  streak: number; // >0 win streak, <0 loss streak
  best: number;
}

const nat = (v: unknown) => (Number.isInteger(v) && (v as number) >= 0 ? (v as number) : 0);

export function loadRecord(): PlayerRecord {
  try {
    const raw = JSON.parse(localStorage.getItem(STATS_KEY) || 'null');
    return {
      wins: nat(raw?.wins),
      losses: nat(raw?.losses),
      streak: Number.isInteger(raw?.streak) ? raw.streak : 0,
      best: nat(raw?.best),
    };
  } catch {
    return { wins: 0, losses: 0, streak: 0, best: 0 };
  }
}

export function saveRecord(r: PlayerRecord) {
  try {
    localStorage.setItem(STATS_KEY, JSON.stringify(r));
  } catch {
    /* private mode / blocked storage: keep it in memory only */
  }
}

export function applyResult(r: PlayerRecord, won: boolean): PlayerRecord {
  const streak = won ? Math.max(0, r.streak) + 1 : Math.min(0, r.streak) - 1;
  return {
    wins: r.wins + (won ? 1 : 0),
    losses: r.losses + (won ? 0 : 1),
    streak,
    best: Math.max(r.best, streak),
  };
}

export function loadName(): string {
  try {
    return (localStorage.getItem(NAME_KEY) || '').slice(0, 24);
  } catch {
    return '';
  }
}

export function saveName(name: string) {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    /* ignore */
  }
}

const MODEL_KEY = 'coup.model';

export function loadModel(): ModelId {
  try {
    return localStorage.getItem(MODEL_KEY) === 'gen5' ? 'gen5' : 'gen7';
  } catch {
    return 'gen7';
  }
}

export function saveModel(m: ModelId) {
  try {
    localStorage.setItem(MODEL_KEY, m);
  } catch {
    /* private mode */
  }
}

const SIDE_KEY = 'coup.stats';

export function loadShowStats(): boolean {
  try {
    return localStorage.getItem(SIDE_KEY) === '1';
  } catch {
    return false;
  }
}

export function saveShowStats(on: boolean) {
  try {
    localStorage.setItem(SIDE_KEY, on ? '1' : '0');
  } catch {
    /* private mode */
  }
}
