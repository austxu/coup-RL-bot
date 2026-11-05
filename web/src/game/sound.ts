// Small synthesised sound set (Web Audio, no files). Off by default, never on
// in the embed; the choice is remembered. Every sound is a few ms of noise or a
// couple of decaying partials, kept quiet and short.

export type Sfx = 'card' | 'flip' | 'coin' | 'claim' | 'challenge' | 'proven' | 'bluff' | 'lose' | 'win' | 'defeat' | 'tick';

const KEY = 'coup.sound';
let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let noise: AudioBuffer | null = null;
let enabled = false;
let allowed = true;
const listeners = new Set<() => void>();

export function initSound(opts: { embed: boolean }) {
  allowed = !opts.embed;
  try {
    enabled = allowed && localStorage.getItem(KEY) === '1';
  } catch {
    enabled = false;
  }
}

export const soundAllowed = () => allowed;
export const soundOn = () => enabled;

export function onSoundChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Toggle from a user gesture (creates / resumes the AudioContext). */
export function setSound(on: boolean) {
  enabled = allowed && on;
  try {
    localStorage.setItem(KEY, enabled ? '1' : '0');
  } catch {
    /* private mode */
  }
  if (enabled) {
    ensure();
    void ctx?.resume();
    play('tick');
  }
  listeners.forEach((f) => f());
}

function ensure(): AudioContext | null {
  if (ctx) return ctx;
  const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return null;
  ctx = new AC();
  master = ctx.createGain();
  master.gain.value = 0.32;
  const comp = ctx.createDynamicsCompressor();
  master.connect(comp).connect(ctx.destination);
  noise = ctx.createBuffer(1, ctx.sampleRate * 0.5, ctx.sampleRate);
  const d = noise.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return ctx;
}

function env(g: GainNode, t: number, peak: number, attack: number, decay: number) {
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
}

function burst(t: number, dur: number, freq: number, q: number, peak: number, type: BiquadFilterType = 'bandpass') {
  const c = ctx!;
  const src = c.createBufferSource();
  src.buffer = noise;
  const f = c.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  const g = c.createGain();
  env(g, t, peak, 0.004, dur);
  src.connect(f).connect(g).connect(master!);
  src.start(t, Math.random() * 0.3);
  src.stop(t + dur + 0.05);
}

function tone(t: number, freq: number, dur: number, peak: number, type: OscillatorType = 'sine', glide?: number) {
  const c = ctx!;
  const o = c.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (glide) o.frequency.exponentialRampToValueAtTime(glide, t + dur);
  const g = c.createGain();
  env(g, t, peak, 0.006, dur);
  o.connect(g).connect(master!);
  o.start(t);
  o.stop(t + dur + 0.05);
}

/** Play a sound now (or `delay` ms from now). No-op when sound is off. */
export function play(name: Sfx, delay = 0) {
  if (!enabled || document.hidden) return;
  const c = ensure();
  if (!c || c.state !== 'running') {
    void c?.resume();
    if (!c || c.state !== 'running') return;
  }
  const t = c.currentTime + delay / 1000 + 0.01;
  const j = (k: number) => k * (0.94 + Math.random() * 0.12); // slight variation per hit
  switch (name) {
    case 'card':
      burst(t, 0.07, j(2600), 0.9, 0.5);
      burst(t + 0.012, 0.05, j(5200), 1.4, 0.18, 'highpass');
      break;
    case 'flip':
      burst(t, 0.05, j(1800), 1.2, 0.35);
      burst(t + 0.06, 0.06, j(3400), 1.0, 0.25);
      break;
    case 'coin': {
      const f = j(2350);
      tone(t, f, 0.22, 0.12, 'sine');
      tone(t, f * 2.76, 0.12, 0.05, 'sine');
      tone(t + 0.035, f * 1.18, 0.16, 0.06, 'triangle');
      burst(t, 0.02, 6000, 2, 0.08, 'highpass');
      break;
    }
    case 'claim':
      tone(t, j(392), 0.18, 0.08, 'triangle');
      tone(t + 0.07, j(523), 0.22, 0.07, 'triangle');
      break;
    case 'challenge':
      tone(t, 110, 0.35, 0.22, 'sine', 70);
      burst(t, 0.18, 300, 0.7, 0.3, 'lowpass');
      tone(t + 0.05, 311, 0.4, 0.05, 'sawtooth');
      tone(t + 0.05, 330, 0.4, 0.05, 'sawtooth');
      break;
    case 'proven':
      [523, 659, 784, 1047].forEach((f, i) => tone(t + i * 0.07, f, 0.5 - i * 0.06, 0.09, 'sine'));
      break;
    case 'bluff':
      tone(t, 392, 0.3, 0.12, 'triangle', 300);
      tone(t + 0.14, 311, 0.42, 0.12, 'triangle', 220);
      burst(t + 0.02, 0.25, 900, 0.6, 0.2);
      break;
    case 'lose':
      burst(t, 0.3, 500, 0.8, 0.35, 'lowpass');
      tone(t, 180, 0.4, 0.12, 'sine', 90);
      break;
    case 'win':
      [523, 659, 784, 1047, 1319].forEach((f, i) => tone(t + i * 0.09, f, 0.7, 0.08, 'triangle'));
      break;
    case 'defeat':
      [392, 349, 311, 262].forEach((f, i) => tone(t + i * 0.16, f, 0.6, 0.08, 'triangle'));
      break;
    case 'tick':
      tone(t, 1400, 0.05, 0.06, 'square');
      break;
  }
}
