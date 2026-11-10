import { useEffect, useRef } from 'preact/hooks';
import type { MatchVM, SeatSummary } from '../game/match';
import { CardView } from './CardView';
import { Icon } from './Icon';

export function summaryLines(vm: MatchVM): string[] {
  const o = vm.outcome;
  if (!o) return [];
  const lines: string[] = [];
  const name = (i: number) => (i === vm.viewer ? 'You' : vm.seats[i].name);
  const other = (i: number) => (1 - i === vm.viewer ? 'you' : vm.seats[1 - i].name);
  // the bot's lines first: "Teddy bluffed 3 times; you caught 1."
  const order = o.summaries.map((_, i) => i).sort((a, b) => Number(vm.seats[b].kind === 'bot') - Number(vm.seats[a].kind === 'bot'));
  order.forEach((i) => {
    const s: SeatSummary = o.summaries[i];
    if (s.bluffs === 0) lines.push(`${name(i)} never bluffed${s.claims ? ` (${s.claims} honest claim${s.claims === 1 ? '' : 's'})` : ''}.`);
    else
      lines.push(
        `${name(i)} bluffed ${s.bluffs} time${s.bluffs === 1 ? '' : 's'}; ${other(i)} caught ${s.bluffsCaught}.`,
      );
    if (s.challenges)
      lines.push(
        `${name(i)} challenged ${s.challenges} time${s.challenges === 1 ? '' : 's'}, right ${s.challengesWon}.`,
      );
  });
  // Gen 7's belief head: how often its single most likely hand was exactly right
  const reader = vm.seats.find((s) => s.kind === 'bot' && s.model === 'gen7');
  const reads = reader ? vm.beliefs.filter((b) => b.seat === reader.idx) : [];
  if (reader && reads.length) {
    const key = (cs: string[]) => [...cs].sort().join('+');
    const hits = reads.filter((b) => b.b.top[0] && key(b.b.top[0].cards) === key(b.b.truth)).length;
    lines.push(
      `${name(reader.idx)}'s top guess at ${other(reader.idx) === 'you' ? 'your' : `${other(reader.idx)}'s`} hand was exactly right ${hits} of ${reads.length} time${reads.length === 1 ? '' : 's'}.`,
    );
  }
  return lines;
}

export function GameOver({
  vm,
  onAgain,
  onReplay,
  onLobby,
  embed,
}: {
  vm: MatchVM;
  onAgain: () => void;
  onReplay: () => void;
  onLobby: () => void;
  embed: boolean;
}) {
  const o = vm.outcome!;
  const ref = useRef<HTMLDivElement>(null);
  const youWon = o.winner !== null && o.winner === vm.viewer;
  const attract = vm.mode === 'attract';
  const bot = vm.seats.findIndex((s) => s.kind === 'bot');

  useEffect(() => {
    if (attract) return;
    ref.current?.querySelector<HTMLElement>('[data-primary]')?.focus({ preventScroll: true });
    const on = (e: KeyboardEvent) => {
      if (document.querySelector('dialog[open]')) return;
      const t = e.target as HTMLElement | null;
      if (t && t.tagName === 'INPUT') return;
      const k = e.key.toLowerCase();
      if (k === 'n') onAgain();
      else if (k === 'r') onReplay();
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, []);

  const headline =
    o.winner === null
      ? 'Draw'
      : attract
        ? `${vm.seats[o.winner].name} wins`
        : youWon
          ? 'You win'
          : `${vm.seats[o.winner].name} wins`;

  return (
    <div class={`gameover ${youWon ? 'is-win' : 'is-loss'} ${attract ? 'is-attract' : ''}`} ref={ref} role="dialog" aria-labelledby="go-h" aria-modal="false">
      <div class="gameover-card">
        <h2 id="go-h" class="gameover-h">
          <Icon name="trophy" size={22} /> {headline}
        </h2>
        {!attract && bot >= 0 && (
          <div class="gameover-hand">
            <span class="eyebrow">{vm.seats[bot].name}'s final hand</span>
            <div class="mini-hand">
              {vm.seats[bot].slots.map((s) => (
                <CardView key={s.id} card={s.card} dead={s.dead} size="sm" />
              ))}
            </div>
          </div>
        )}
        {attract ? (
          <p class="gameover-next">Next game starting…</p>
        ) : (
          <div class="choices">
            <button type="button" class="btn btn-primary" data-primary onClick={onAgain}>
              <Icon name="play" /> Play again <kbd class="kbd">N</kbd>
            </button>
            <button type="button" class="btn" onClick={onReplay}>
              <Icon name="replay" /> Review the game <kbd class="kbd">R</kbd>
            </button>
            {!embed && (
              <button type="button" class="btn btn-ghost" onClick={onLobby}>
                Lobby
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
