import { useEffect, useState } from 'preact/hooks';
import type { ModelId } from '../bot/protocol';
import type { BotClient } from '../bot/client';
import { useSubscribe } from '../game/store';
import type { PlayerRecord } from '../game/storage';
import { ART, ROLES, ROLE_CLASS } from '../game/labels';
import { Icon } from './Icon';
import { CardView } from './CardView';
import { Bear } from './Bear';
import { StrengthCard } from './Strength';

export function RecordChip({ record, onReset }: { record: PlayerRecord; onReset?: () => void }) {
  const games = record.wins + record.losses;
  if (games === 0) return null;
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
      {onReset && (
        <button type="button" class="link-btn" onClick={onReset}>
          reset
        </button>
      )}
    </span>
  );
}

// training games behind the shipped Gen 7 checkpoint (versions/gen7/training_log_gen7.txt)
const GEN7_GAMES = '12 million';

const OPPONENTS: { id: ModelId; name: string; tag?: string; sub: string }[] = [
  { id: 'gen7', name: 'Gen 7', tag: 'strongest', sub: 'Guesses your hand' },
  { id: 'gen5', name: 'Gen 5', sub: 'The previous bot' },
];

export function Lobby({
  bot,
  name,
  model,
  record,
  embed,
  onPlay,
  onWatch,
  onRules,
  onResetRecord,
}: {
  bot: BotClient;
  name: string;
  model: ModelId;
  record: PlayerRecord;
  embed: boolean;
  onPlay: (name: string, model: ModelId) => void;
  onWatch: () => void;
  onRules: () => void;
  onResetRecord: () => void;
}) {
  useSubscribe(bot);
  const [n, setN] = useState(name);
  const [m, setM] = useState<ModelId>(model);
  const st = bot.models[m];
  const ready = st.status === 'ready';
  const pick = (id: ModelId) => {
    setM(id);
    bot.preload(id);
  };
  useEffect(() => bot.preload(m), []);
  const submit = (e: Event) => {
    e.preventDefault();
    if (st.status === 'error') return;
    onPlay(n.trim().slice(0, 24) || 'You', m);
  };

  return (
    <div class={`lobby ${embed ? 'lobby-embed' : ''}`}>
      <section class="lobby-hero">
        <div class="lobby-bear">
          <Bear base="idle" react="wave" reactKey={1} size={embed ? 120 : 208} label="PPO-AI, a pixel-art bear, waves hello" />
        </div>
        <h1 class="lobby-h">Read the bluff.</h1>
        <p class="lobby-lede">
          A Coup bot trained by reinforcement learning on {GEN7_GAMES} games. It guesses your hidden cards as it plays,
          and runs entirely in your browser.
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
          <fieldset class="opp-pick">
            <legend class="eyebrow">opponent</legend>
            {OPPONENTS.map((o) => (
              <label class={`opp ${m === o.id ? 'is-on' : ''}`} key={o.id}>
                <input type="radio" name="opp" value={o.id} checked={m === o.id} onChange={() => pick(o.id)} />
                <span class="opp-name">
                  {o.name}
                  {o.tag && <span class="opp-tag">{o.tag}</span>}
                </span>
                <span class="opp-sub">{o.sub}</span>
              </label>
            ))}
          </fieldset>
          <button type="submit" class="btn btn-primary btn-lg" disabled={st.status === 'error'}>
            <Icon name="play" /> {st.status === 'error' ? 'Bot failed to load' : 'Play the bot'}
            <kbd class="kbd">↵</kbd>
          </button>
          <button type="button" class="btn btn-lg" onClick={onWatch}>
            <Icon name="eye" /> Watch it play itself
          </button>
        </form>
        <p class="lobby-status" role="status">
          {!ready && (
            <>
              <span class={`status-dot ${st.status === 'error' ? 'error' : 'loading'}`} aria-hidden="true" />
              {st.status === 'error' ? `Could not load the model: ${st.error}` : 'Loading the model…'}
            </>
          )}
        </p>
        {record.wins + record.losses > 0 && (
          <div class="lobby-record">
            <RecordChip record={record} onReset={onResetRecord} />
            {record.best > 1 && <span class="rec-best">best streak {record.best}</span>}
          </div>
        )}
      </section>

      {!embed && (
        <section class="lobby-roles" aria-labelledby="roles-h">
          <div class="roles-head">
            <span class="eyebrow" id="roles-h">
              the court
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
          <StrengthCard />
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
        It sees what you would see from its seat: its own cards, coins, face-up cards, claims and recent moves. An LSTM
        remembers the whole game; one head picks a move, another estimates its chance to win, and Gen 7 has a third that
        guesses your two hidden cards. It never sees them.
      </p>
    </div>
  );
}
