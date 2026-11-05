// Imperative flight effects (coins, cards) drawn in a fixed overlay above the
// table. Anchors are elements carrying data-anchor="...".
import { prefersReducedMotion } from './timing';
import { BEAR } from './labels';

function layer(): HTMLElement | null {
  return document.getElementById('fx-layer');
}

function center(name: string): { x: number; y: number; w: number; h: number } | null {
  const el = document.querySelector<HTMLElement>(`[data-anchor="${name}"]`);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return null;
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
}

function fly(el: HTMLElement, from: string, to: string, opts: { delay?: number; duration?: number; arc?: number; spin?: number }) {
  const L = layer();
  const a = center(from);
  const b = center(to);
  if (!L || !a || !b || prefersReducedMotion()) return;
  L.appendChild(el);
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  const ax = a.x - w / 2;
  const ay = a.y - h / 2;
  const bx = b.x - w / 2;
  const by = b.y - h / 2;
  const arc = opts.arc ?? -40;
  const mx = (ax + bx) / 2;
  const my = (ay + by) / 2 + arc;
  const spin = opts.spin ?? 0;
  const anim = el.animate(
    [
      { transform: `translate(${ax}px, ${ay}px) rotate(0deg) scale(0.9)`, opacity: 0 },
      { transform: `translate(${ax}px, ${ay}px) rotate(0deg) scale(1)`, opacity: 1, offset: 0.08 },
      { transform: `translate(${mx}px, ${my}px) rotate(${spin / 2}deg) scale(1.08)`, opacity: 1, offset: 0.55 },
      { transform: `translate(${bx}px, ${by}px) rotate(${spin}deg) scale(1)`, opacity: 1, offset: 0.92 },
      { transform: `translate(${bx}px, ${by}px) rotate(${spin}deg) scale(0.92)`, opacity: 0 },
    ],
    { duration: opts.duration ?? 560, delay: opts.delay ?? 0, easing: 'cubic-bezier(.45,.05,.3,1)', fill: 'both' },
  );
  anim.onfinish = () => el.remove();
  anim.oncancel = () => el.remove();
}

export function flyCoins(from: string, to: string, n: number, speed = 1) {
  for (let i = 0; i < Math.min(n, 7); i++) {
    const c = document.createElement('div');
    c.className = 'fx-coin';
    fly(c, from, to, { delay: i * 70 * speed, duration: 520 * speed, arc: -30 - i * 4 });
  }
}

export function flyCard(from: string, to: string, opts: { delay?: number; speed?: number; size?: 'sm' | 'md' } = {}) {
  const c = document.createElement('div');
  c.className = `fx-card fx-card-${opts.size ?? 'md'}`;
  const img = document.createElement('img');
  img.src = BEAR.sm;
  img.alt = '';
  c.appendChild(img);
  fly(c, from, to, { delay: opts.delay ?? 0, duration: 600 * (opts.speed ?? 1), arc: -24, spin: 0 });
}
