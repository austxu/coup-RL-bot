import { useEffect, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import type { BotClient } from '../bot/client';
import { Match, type Outcome, type SeatConfig } from '../game/match';
import { useStore } from '../game/store';
import {
  applyResult,
  loadModel,
  loadName,
  loadRecord,
  loadShowStats,
  saveModel,
  saveName,
  saveRecord,
  saveShowStats,
  type PlayerRecord,
} from '../game/storage';
import type { ModelId } from '../bot/protocol';
import type { Card } from '../engine/types';
import { ART, ROLE_CLASS } from '../game/labels';
import { Table } from './Table';
import { MindPanel, Timeline } from './Mind';
import { Lobby, RecordChip, RulesBody } from './Lobby';
import { Replay } from './Replay';
import { Icon } from './Icon';
import { onSoundChange, setSound, soundAllowed, soundOn } from '../game/sound';

type Screen = 'lobby' | 'game' | 'replay';

export interface AppProps {
  bot: BotClient;
  embed: boolean;
  autoplay: boolean;
}

const BOT_NAME = 'PPO-AI';

export function App({ bot, embed, autoplay }: AppProps) {
  const [screen, setScreen] = useState<Screen>(autoplay ? 'game' : 'lobby');
  const [match, setMatch] = useState<Match | null>(null);
  const [record, setRecord] = useState<PlayerRecord>(loadRecord);
  const [name, setName] = useState(() => loadName() || '');
  const [model, setModel] = useState<ModelId>(loadModel);
  const [rules, setRules] = useState(false);
  const [stats, setStats] = useState(loadShowStats);
  const [zoom, setZoom] = useState<Card | null>(null);
  const matchRef = useRef<Match | null>(null);
  const vm = useStore(match?.store);

  const begin = (m: Match) => {
    matchRef.current?.cancel();
    matchRef.current = m;
    setMatch(m);
    setScreen('game');
    void m.run();
  };

  const startAttract = () => {
    const seats: SeatConfig[] = [
      { kind: 'bot', name: 'Gen 7 A', model: 'gen7' },
      { kind: 'bot', name: 'Gen 7 B', model: 'gen7' },
    ];
    const m: Match = new Match(
      seats,
      bot,
      'attract',
      () => {
        window.setTimeout(() => {
          if (matchRef.current === m) startAttract();
        }, 4200);
      },
    );
    begin(m);
  };

  const startHuman = (playerName = name || 'You', opp: ModelId = model) => {
    const seats: SeatConfig[] = [
      { kind: 'human', name: playerName },
      { kind: 'bot', name: BOT_NAME, model: opp },
    ];
    if (Math.random() < 0.5) seats.reverse(); // like web.py: random seat, random first player
    const m = new Match(seats, bot, 'human', (o: Outcome, mm: Match) => {
      if (o.winner === null) return;
      const won = o.winner === mm.vm.viewer;
      setRecord((r) => {
        const next = applyResult(r, won);
        saveRecord(next);
        return next;
      });
    });
    begin(m);
  };

  const play = (n: string, m: ModelId) => {
    setName(n);
    saveName(n);
    setModel(m);
    saveModel(m);
    startHuman(n, m);
  };

  useEffect(() => {
    if (autoplay) startAttract();
    return () => matchRef.current?.cancel();
  }, []);

  // global shortcuts
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      if (e.key === '?' && !document.querySelector('dialog[open]')) {
        setRules(true);
        e.preventDefault();
      }
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, []);

  const toLobby = () => {
    matchRef.current?.cancel();
    matchRef.current = null;
    setMatch(null);
    setScreen('lobby');
  };

  const resetRecord = () => {
    const r = { wins: 0, losses: 0, streak: 0, best: 0 };
    saveRecord(r);
    setRecord(r);
  };

  const attract = vm?.mode === 'attract';
  // the bot's panels are opt-in while you play; the self-play demo always shows them
  const side = attract || stats;
  const toggleStats = () => {
    saveShowStats(!stats);
    setStats(!stats);
  };

  return (
    <div class={`app screen-${screen} ${embed ? 'is-embed' : ''} ${attract ? 'is-attract' : ''}`}>
      {!embed && (
        <header class="topbar">
          <button type="button" class="brand" onClick={toLobby} aria-label="Coup RL Bot — back to lobby">
            <span class="brand-mark" aria-hidden="true">
              <img src="images/coup-card-favicon-v1-180.png" alt="" />
            </span>
            <span class="brand-name">Coup RL Bot</span>
          </button>
          <div class="topbar-right">
            <RecordChip record={record} />
            {screen !== 'lobby' && (
              <button type="button" class="btn btn-sm" onClick={() => startHuman()}>
                <Icon name="play" size={14} /> New game
              </button>
            )}
            <SoundToggle />
            <button type="button" class="btn btn-sm btn-icon" onClick={() => setRules(true)} aria-label="Rules and shortcuts" aria-keyshortcuts="?">
              <Icon name="help" size={16} />
            </button>
          </div>
        </header>
      )}

      {embed && (
        <a class="embed-chip" href="https://coup.austxu.dev/" target="_blank" rel="noopener">
          coup.austxu.dev <Icon name="external" size={12} />
        </a>
      )}

      <main class="main" id="main">
        {screen === 'lobby' && (
          <Lobby
            bot={bot}
            name={name}
            model={model}
            record={record}
            embed={embed}
            onPlay={play}
            onWatch={startAttract}
            onRules={() => setRules(true)}
            onResetRecord={resetRecord}
          />
        )}

        {screen === 'game' && match && vm && (
          <div class={`game ${side ? '' : 'no-side'}`}>
            <div class="game-table">
              <Table
                match={match}
                vm={vm}
                embed={embed}
                onZoom={setZoom}
                onAgain={() => startHuman()}
                onReplay={() => setScreen('replay')}
                onLobby={toLobby}
                stats={attract ? undefined : stats}
                onStats={toggleStats}
              />
              {attract && (
                <div class="attract-cta">
                  <span class="live-dot" aria-hidden="true" />
                  <span class="attract-copy">
                    <strong>Live self-play</strong>
                  </span>
                  <button type="button" class="btn btn-primary" onClick={() => (embed ? startHuman() : toLobby())}>
                    <Icon name="play" /> Play the bot
                  </button>
                </div>
              )}
            </div>
            {side && (
              <aside class="game-side">
                <MindPanel vm={vm} />
                <Timeline vm={vm} />
              </aside>
            )}
          </div>
        )}

        {screen === 'replay' && match && vm && (
          <Replay vm={vm} onClose={() => setScreen('game')} onAgain={() => startHuman()} />
        )}
      </main>

      {/* narration for screen readers */}
      <div class="sr-only" aria-live="polite" aria-atomic="true">
        {vm?.narration}
      </div>

      <Modal open={rules} onClose={() => setRules(false)} title="How to play">
        <RulesBody />
      </Modal>
      <Modal open={zoom !== null} onClose={() => setZoom(null)} title={zoom ?? ''} wide={false} bare>
        {zoom && (
          <img class={`zoom-img ${ROLE_CLASS[zoom]}`} src={ART[zoom].lg} alt={zoom} width={360} height={504} />
        )}
      </Modal>
      <div id="fx-layer" aria-hidden="true" />
    </div>
  );
}

function Modal({
  open,
  onClose,
  title,
  children,
  bare = false,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ComponentChildren;
  wide?: boolean;
  bare?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      class={`modal ${bare ? 'modal-bare' : ''}`}
      aria-label={title}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      {open && (
        <div class="modal-body">
          {!bare && (
            <header class="modal-head">
              <h2>{title}</h2>
              <button type="button" class="btn btn-sm btn-icon" onClick={onClose} aria-label="Close">
                <Icon name="x" />
              </button>
            </header>
          )}
          {children}
          {bare && (
            <button type="button" class="btn btn-sm btn-icon modal-x" onClick={onClose} aria-label="Close">
              <Icon name="x" />
            </button>
          )}
        </div>
      )}
    </dialog>
  );
}

function SoundToggle() {
  const [on, setOn] = useState(soundOn);
  useEffect(() => onSoundChange(() => setOn(soundOn())), []);
  if (!soundAllowed()) return null;
  return (
    <button
      type="button"
      class={`btn btn-sm btn-icon ${on ? 'is-on' : ''}`}
      onClick={() => setSound(!on)}
      aria-pressed={on}
      aria-label={on ? 'Sound on — mute' : 'Sound off — unmute'}
      title={on ? 'Sound on' : 'Sound off'}
    >
      <Icon name={on ? 'sound' : 'mute'} size={16} />
    </button>
  );
}
