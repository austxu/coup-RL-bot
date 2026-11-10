// Teddy's avatar: the user's Djungelskog pixel bear, animated from one atlas.
import { useEffect, useRef, useState } from 'preact/hooks';
import atlasUrl from '../assets/bear/bear-atlas.webp';
import { BEAR_CELL, BEAR_FRAMES } from '../game/bearAtlas';
import { prefersReducedMotion } from '../game/timing';

export type BearMood = 'idle' | 'wave' | 'jump' | 'fail' | 'review' | 'think' | 'wait' | 'look';

const FPS: Record<BearMood, number> = { idle: 5, wave: 8, jump: 10, fail: 7, review: 5, think: 7, wait: 6, look: 1 };
/** One-shot moods play this many times, then fall back to the base mood. */
const ONESHOT: Partial<Record<BearMood, number>> = { wave: 2, jump: 2, fail: 1 };

let atlasReady: Promise<void> | null = null;
function loadAtlas(): Promise<void> {
  if (!atlasReady) {
    atlasReady = new Promise((resolve) => {
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => resolve();
      img.onerror = () => resolve();
      img.src = atlasUrl;
    });
  }
  return atlasReady;
}

export interface BearProps {
  /** Looping mood when nothing else is happening. */
  base: BearMood;
  /** A reaction to play over the base mood; retriggered whenever `reactKey` changes. */
  react?: BearMood | null;
  reactKey?: number;
  /** Head pose 0-15 for `react === 'look'` (0 = up, clockwise as seen by the viewer). */
  look?: number;
  /** Rendered height in CSS px (cells are 192x208). */
  size?: number;
  hold?: boolean; // keep the last frame of a one-shot reaction (e.g. losing)
  class?: string;
  label?: string;
}

export function Bear({ base, react = null, reactKey = 0, look = 8, size = 88, hold = false, class: cls = '', label }: BearProps) {
  const [ready, setReady] = useState(false);
  const [frame, setFrame] = useState(0);
  const [active, setActive] = useState<BearMood | null>(null);
  const reduced = useRef(prefersReducedMotion());

  useEffect(() => {
    let live = true;
    loadAtlas().then(() => live && setReady(true));
    return () => {
      live = false;
    };
  }, []);

  // start a reaction
  useEffect(() => {
    if (!react) return;
    setActive(react);
    setFrame(0);
  }, [reactKey]);

  const mood: BearMood = reduced.current ? 'idle' : (active ?? base);

  useEffect(() => {
    if (reduced.current || !ready) return;
    if (mood === 'look') {
      const t = window.setTimeout(() => setActive(null), 1300);
      return () => clearTimeout(t);
    }
    const frames = BEAR_FRAMES[mood].length;
    const loops = active ? ONESHOT[active] : undefined;
    let n = 0;
    setFrame(0);
    const t = window.setInterval(() => {
      n++;
      if (loops !== undefined && n >= frames * loops) {
        clearInterval(t);
        if (hold) setFrame(frames >> 1); // e.g. the drooped head of 'fail'
        else setActive(null);
        return;
      }
      setFrame(n % frames);
    }, 1000 / FPS[mood]);
    return () => clearInterval(t);
  }, [mood, ready, reactKey]);

  const list = BEAR_FRAMES[mood];
  const [c, r] = mood === 'look' ? BEAR_FRAMES.look[look % 16] : list[Math.min(frame, list.length - 1)];
  const scale = size / BEAR_CELL.h;
  const w = BEAR_CELL.w * scale;
  return (
    <span
      class={`bear ${ready ? 'is-ready' : ''} ${scale >= 1 ? 'is-upscaled' : ''} ${cls}`}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : 'true'}
      style={{
        width: `${w}px`,
        height: `${size}px`,
        backgroundImage: ready ? `url(${atlasUrl})` : undefined,
        backgroundSize: `${BEAR_CELL.cols * w}px ${BEAR_CELL.rows * size}px`,
        backgroundPosition: `${-c * w}px ${-r * size}px`,
      }}
    />
  );
}
