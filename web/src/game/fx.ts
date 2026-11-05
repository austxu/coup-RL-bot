// Imperative flight effects (coins, cards) drawn in a fixed overlay above the
// table. Anchors are elements carrying data-anchor="...".
//
// Coins are tossed: a ballistic arc whose height scales with distance, a spin
// about the horizontal axis (the disc narrows to its edge and back), a shadow
// that stays on the felt and shrinks while the coin is high, and a small bounce
// on landing. Cards slide with a tilt into the direction of travel.
import { prefersReducedMotion } from './timing';
import { BEAR } from './labels';
import { play } from './sound';

function layer(): HTMLElement | null {
  return document.getElementById('fx-layer');
}

function center(name: string): { x: number; y: number; w: number; h: number } | null {
  // several elements may carry an anchor (e.g. coin stack + coin chip); use the first visible one
  for (const el of document.querySelectorAll<HTMLElement>(`[data-anchor="${name}"]`)) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
  }
  return null;
}

const STEPS = 14;

/** Points along a parabola from a to b peaking `lift` px above the chord. */
function arc(a: { x: number; y: number }, b: { x: number; y: number }, lift: number, t: number) {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t - 4 * lift * t * (1 - t) };
}

export function flyCoins(from: string, to: string, n: number, speed = 1) {
  const L = layer();
  const a = center(from);
  const b = center(to);
  const k = Math.min(n, 7);
  if (!L || !a || !b || prefersReducedMotion()) {
    for (let i = 0; i < k; i++) play('coin', i * 70 * speed + 420 * speed);
    return;
  }
  const dist = Math.hypot(b.x - a.x, b.y - a.y);
  for (let i = 0; i < k; i++) {
    const coin = document.createElement('div');
    coin.className = 'fx-coin';
    const shadow = document.createElement('div');
    shadow.className = 'fx-coin-shadow';
    L.append(shadow, coin);
    const jitter = { x: (Math.random() - 0.5) * 14, y: (Math.random() - 0.5) * 8 };
    const end = { x: b.x + jitter.x, y: b.y + jitter.y };
    const lift = Math.min(160, 40 + dist * 0.28) * (0.9 + Math.random() * 0.25);
    const spins = 2 + Math.round(dist / 260) + (i % 2);
    const duration = (520 + Math.min(260, dist * 0.35)) * speed;
    const delay = i * 75 * speed;
    const frames: Keyframe[] = [];
    const shadows: Keyframe[] = [];
    for (let s = 0; s <= STEPS; s++) {
      const t = s / STEPS;
      const p = arc(a, end, lift, t);
      const h = 4 * t * (1 - t); // 0..1 height
      frames.push({
        transform: `perspective(300px) translate(${p.x - 9}px, ${p.y - 9}px) rotateX(${t * spins * 360}deg) scale(${1 + h * 0.25})`,
        opacity: t === 0 ? 0 : 1,
        offset: t * 0.82,
      });
      const g = { x: a.x + (end.x - a.x) * t, y: a.y + (end.y - a.y) * t + 10 };
      shadows.push({
        transform: `translate(${g.x - 10}px, ${g.y - 4}px) scale(${1 - h * 0.55})`,
        opacity: t === 0 ? 0 : 0.55 - h * 0.35,
        offset: t * 0.82,
      });
    }
    // bounce, settle, fade into the stack
    frames.push(
      { transform: `perspective(300px) translate(${end.x - 9}px, ${end.y - 15}px) rotateX(0deg) scale(1)`, opacity: 1, offset: 0.9 },
      { transform: `perspective(300px) translate(${end.x - 9}px, ${end.y - 9}px) rotateX(0deg) scale(1)`, opacity: 1, offset: 0.96 },
      { transform: `perspective(300px) translate(${end.x - 9}px, ${end.y - 9}px) rotateX(0deg) scale(0.9)`, opacity: 0 },
    );
    shadows.push(
      { transform: `translate(${end.x - 10}px, ${end.y + 6}px) scale(0.9)`, opacity: 0.4, offset: 0.9 },
      { transform: `translate(${end.x - 10}px, ${end.y + 6}px) scale(1)`, opacity: 0.5, offset: 0.96 },
      { transform: `translate(${end.x - 10}px, ${end.y + 6}px) scale(1)`, opacity: 0 },
    );
    const opts: KeyframeAnimationOptions = { duration, delay, easing: 'linear', fill: 'both' };
    const anim = coin.animate(frames, opts);
    const sh = shadow.animate(shadows, opts);
    const done = () => {
      coin.remove();
      shadow.remove();
    };
    anim.onfinish = done;
    anim.oncancel = done;
    sh.oncancel = done;
    play('coin', delay + duration * 0.82);
  }
}

export function flyCard(from: string, to: string, opts: { delay?: number; speed?: number; size?: 'sm' | 'md' } = {}) {
  const L = layer();
  const a = center(from);
  const b = center(to);
  const delay = opts.delay ?? 0;
  const speed = opts.speed ?? 1;
  play('card', delay);
  if (!L || !a || !b || prefersReducedMotion()) return;
  const c = document.createElement('div');
  c.className = `fx-card fx-card-${opts.size ?? 'md'}`;
  const img = document.createElement('img');
  img.src = BEAR.sm;
  img.alt = '';
  c.appendChild(img);
  L.appendChild(c);
  const w = c.offsetWidth;
  const h = c.offsetHeight;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  // lean into the direction of travel, flatten slightly as if sliding on felt
  const yaw = Math.max(-18, Math.min(18, dx / 22));
  const pitch = Math.max(-28, Math.min(28, -dy / 12));
  const mid = arc(a, b, 26, 0.5);
  const anim = c.animate(
    [
      { transform: `perspective(700px) translate(${a.x - w / 2}px, ${a.y - h / 2}px) rotateX(0deg) rotateZ(0deg) scale(0.92)`, opacity: 0 },
      { transform: `perspective(700px) translate(${a.x - w / 2}px, ${a.y - h / 2}px) rotateX(0deg) rotateZ(0deg) scale(1)`, opacity: 1, offset: 0.08 },
      {
        transform: `perspective(700px) translate(${mid.x - w / 2}px, ${mid.y - h / 2}px) rotateX(${pitch}deg) rotateZ(${yaw}deg) scale(1.08)`,
        opacity: 1,
        offset: 0.5,
        boxShadow: '0 34px 40px -18px rgba(0,0,0,.85)',
      },
      { transform: `perspective(700px) translate(${b.x - w / 2}px, ${b.y - h / 2}px) rotateX(0deg) rotateZ(0deg) scale(1)`, opacity: 1, offset: 0.92 },
      { transform: `perspective(700px) translate(${b.x - w / 2}px, ${b.y - h / 2}px) rotateX(0deg) rotateZ(0deg) scale(0.96)`, opacity: 0 },
    ],
    { duration: 600 * speed, delay, easing: 'cubic-bezier(.45,.05,.3,1)', fill: 'both' },
  );
  anim.onfinish = () => c.remove();
  anim.oncancel = () => c.remove();
}

/** Shake the table (bluff caught). */
export function shake(el: Element | null) {
  if (!el || prefersReducedMotion()) return;
  el.animate(
    [
      { transform: 'translate(0,0)' },
      { transform: 'translate(-6px,1px)' },
      { transform: 'translate(5px,-1px)' },
      { transform: 'translate(-3px,0)' },
      { transform: 'translate(2px,0)' },
      { transform: 'translate(0,0)' },
    ],
    { duration: 420, easing: 'ease-out' },
  );
}
