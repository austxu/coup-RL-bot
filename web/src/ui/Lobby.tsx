import { useState } from 'preact/hooks';
import type { BotClient } from '../bot/client';
import { useSubscribe } from '../game/store';
import type { PlayerRecord } from '../game/storage';
import { ART, ROLES, ROLE_CLASS } from '../game/labels';
import { Icon } from './Icon';
import { CardView } from './CardView';
import { Bear } from './Bear';

export function RecordChip({ record, onReset }: { record: PlayerRecord; onReset?: () => void }) {
  const games = record.wins + record.losses;
  return (
    <span class="record" aria-label={`Record: ${record.wins} wins, ${record.losses} losses`}>
      <span class="rec-w">{record.wins}W</span>
      <span class="rec-sep">·</span>
      <span class="rec-l">{record.losses}L</span>
      {record.streak !== 0 && (
        <span class={`rec-streak ${record.streak > 0 ? 'up' : 'down'}`}>
          {record.streak > 0 ? `${record.streak} win streak` : `${-record.streak} loss${record.streak < -1 ? 'es' : ''} in a row`}
        </span>
      )}
      {onReset && games > 0 && (
        <button type="button" class="link-btn" onClick={onReset}>
          reset
        </button>
      )}
    </span>
  );
}

export function Lobby({
  bot,
  name,
  record,
  embed,
  onPlay,
  onWatch,
  onRules,
  onResetRecord,
}: {
  bot: BotClient;
  name: string;
  record: PlayerRecord;
  embed: boolean;
  onPlay: (name: string) => void;
  onWatch: () => void;
  onRules: () => void;
  onResetRecord: () => void;
}) {
  useSubscribe(bot);
  const [n, setN] = useState(name);
  const ready = bot.status === 'ready';
  const submit = (e: Event) => {
    e.preventDefault();
    if (bot.status === 'error') return;
    onPlay(n.trim().slice(0, 24) || 'You');
  };

  return (
    <div class={`lobby ${embed ? 'lobby-embed' : ''}`}>
      <section class="lobby-hero">
        <div class="lobby-bear">
          <Bear base="idle" react="wave" reactKey={1} size={embed ? 120 : 208} label="PPO-AI, a pixel-art bear, waves hello" />
          <span class="lobby-bear-tag">
            <span class="eyebrow">your opponent</span>
            <strong>PPO-AI</strong>
          </span>
        </div>
        <span class="eyebrow">01 / coup · reinforcement learning</span>
        <h1 class="lobby-h">Read the bluff.</h1>
        <p class="lobby-lede">
          A 1v1 Coup bot trained with PPO and an LSTM memory over 3.5 million games, mostly against itself. It runs entirely in
          your browser — 1.2&nbsp;MB of weights, no server, no waiting.
        </p>

        <form class="lobby-form" onSubmit={submit}>
          <label class="field">
            <span class="eyebrow">your name</span>
            <input
              type="text"
              value={n}
              maxLength={24}
              autoComplete="nickname"
              spellcheck={false}
              placeholder="You"
              onInput={(e) => setN((e.target as HTMLInputElement).value)}
            />
          </label>
          <button type="submit" class="btn btn-primary btn-lg" disabled={bot.status === 'error'}>
            <Icon name="play" /> {ready ? 'Play the bot' : bot.status === 'error' ? 'Bot failed to load' : 'Play the bot'}
            <kbd class="kbd">↵</kbd>
          </button>
          <button type="button" class="btn btn-lg" onClick={onWatch}>
            <Icon name="eye" /> Watch it play itself
          </button>
        </form>
        <p class="lobby-status" role="status">
          <span class={`status-dot ${bot.status}`} aria-hidden="true" />
          {bot.status === 'ready'
            ? `Model loaded in ${bot.loadMs} ms · inference runs in a Web Worker`
            : bot.status === 'error'
              ? `Could not load the model: ${bot.error}`
              : 'Loading the model…'}
        </p>
        <div class="lobby-record">
          <RecordChip record={record} onReset={onResetRecord} />
          {record.best > 1 && <span class="rec-best">best streak {record.best}</span>}
        </div>
      </section>

      {!embed && (
        <section class="lobby-roles" aria-labelledby="roles-h">
          <div class="roles-head">
            <span class="eyebrow" id="roles-h">
              02 / the court
            </span>
            <button type="button" class="link-btn" onClick={onRules}>
              <Icon name="help" size={14} /> full rules
            </button>
          </div>
          <ul class="role-grid">
            {ROLES.map((r) => (
              <li class={`role-tile ${ROLE_CLASS[r.card]}`} key={r.card}>
                <CardView card={r.card} size="sm" />
                <div class="role-copy">
                  <strong>{r.card}</strong>
                  {r.action && (
                    <span>
                      <span class="role-act">{r.action}</span> {r.actionText}
                    </span>
                  )}
                  {r.blocks && <span class="role-block">{r.blocks}</span>}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

export function RulesBody() {
  return (
    <div class="rules">
      <p>
        Each player starts with <strong>2 coins</strong> and <strong>2 face-down influence cards</strong>. Lose both and
        you're out; the last player with influence wins.
      </p>
      <h3>On your turn, take one action</h3>
      <ul class="rules-list">
        <li>
          <strong>Income</strong> — take 1 coin. Can't be blocked or challenged.
        </li>
        <li>
          <strong>Foreign Aid</strong> — take 2 coins. Anyone claiming Duke can block it.
        </li>
        <li>
          <strong>Coup</strong> — pay 7: your opponent loses an influence. Unstoppable. At 10+ coins you must Coup.
        </li>
      </ul>
      <h3>Character actions — claims you can bluff</h3>
      <ul class="rules-roles">
        {ROLES.map((r) => (
          <li key={r.card} class={ROLE_CLASS[r.card]}>
            <img src={ART[r.card].sm} alt="" width={44} height={62} />
            <span>
              <strong>{r.card}</strong>
              {r.action ? ` · ${r.action}: ${r.actionText}` : ''} {r.blocks}
            </span>
          </li>
        ))}
      </ul>
      <h3>Challenges</h3>
      <p>
        Any claim — an action or a block — can be challenged. If the claimer has the card, they reveal it, shuffle it back
        and draw a new one, and the challenger loses an influence. If they were bluffing, they lose an influence and the
        claim fails.
      </p>
      <h3>Keyboard</h3>
      <ul class="rules-keys">
        <li>
          <kbd class="kbd">I</kbd> <kbd class="kbd">F</kbd> <kbd class="kbd">T</kbd> <kbd class="kbd">S</kbd>{' '}
          <kbd class="kbd">E</kbd> <kbd class="kbd">A</kbd> <kbd class="kbd">C</kbd> actions
        </li>
        <li>
          <kbd class="kbd">C</kbd> challenge · <kbd class="kbd">A</kbd> allow · <kbd class="kbd">1</kbd>
          <kbd class="kbd">2</kbd> block / pick a card
        </li>
        <li>
          <kbd class="kbd">N</kbd> new game · <kbd class="kbd">R</kbd> review · <kbd class="kbd">?</kbd> rules
        </li>
      </ul>
      <h3>How the bot works</h3>
      <p>
        A 70-number observation (your public state, its own cards, claims, caught bluffs and the last five actions) feeds
        two dense layers and a 256-unit LSTM that remembers the whole game. An actor head picks a move by sampling from its
        policy; a critic head estimates its chance to win. The TypeScript port is checked against the original PyTorch
        model on recorded games.
      </p>
    </div>
  );
}
