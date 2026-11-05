// Forward pass for a single step of coup/ppo_model.py CoupLSTMPPO (Gen5) and
// coup/gen7.py CoupGen7 (Gen7), chosen by the manifest:
//   fc1 -> relu -> fc2 -> relu -> LSTM(256) -> actor logits, tanh(critic)
//   [+ belief logits over the opponent's hand classes when the manifest has numBelief]
// Weights come from tools/export_weights.py (float16 matrices, float32 biases).

export interface TensorSpec {
  name: string;
  shape: number[];
  dtype: 'float16' | 'float32';
  offset: number;
  length: number;
}

export interface Manifest {
  format: string;
  model?: string;
  inputDim: number;
  hiddenDim: number;
  numActions: number;
  /** Gen7: number of belief classes (belief head present). */
  numBelief?: number;
  byteLength: number;
  tensors: TensorSpec[];
}

export interface LstmState {
  h: Float32Array;
  c: Float32Array;
}

export interface StepOutput {
  logits: Float32Array;
  value: number;
  /** Raw belief logits (models with a belief head only). */
  belief?: Float32Array;
}

let halfTable: Float32Array | null = null;
function halfToFloatTable(): Float32Array {
  if (halfTable) return halfTable;
  const t = new Float32Array(65536);
  for (let h = 0; h < 65536; h++) {
    const s = h & 0x8000 ? -1 : 1;
    const e = (h >> 10) & 0x1f;
    const f = h & 0x3ff;
    let v: number;
    if (e === 0) v = s * 2 ** -14 * (f / 1024);
    else if (e === 31) v = f ? NaN : s * Infinity;
    else v = s * 2 ** (e - 15) * (1 + f / 1024);
    t[h] = v;
  }
  return (halfTable = t);
}

function decode(buf: ArrayBuffer, spec: TensorSpec): Float32Array {
  if (spec.dtype === 'float32') {
    return new Float32Array(buf.slice(spec.offset, spec.offset + spec.length * 4));
  }
  const table = halfToFloatTable();
  const dv = new DataView(buf, spec.offset, spec.length * 2);
  const out = new Float32Array(spec.length);
  for (let i = 0; i < spec.length; i++) out[i] = table[dv.getUint16(i * 2, true)];
  return out;
}

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

export class CoupPolicy {
  readonly inputDim: number;
  readonly hidden: number;
  readonly numActions: number;
  /** 0 when the model has no belief head (Gen5). */
  readonly numBelief: number;
  private readonly w: Record<string, Float32Array> = {};
  // scratch buffers
  private readonly f1: Float32Array;
  private readonly f2: Float32Array;
  private readonly gates: Float32Array;

  constructor(manifest: Manifest, buf: ArrayBuffer) {
    if (buf.byteLength !== manifest.byteLength) {
      throw new Error(`weights: expected ${manifest.byteLength} bytes, got ${buf.byteLength}`);
    }
    for (const t of manifest.tensors) this.w[t.name] = decode(buf, t);
    this.inputDim = manifest.inputDim;
    this.hidden = manifest.hiddenDim;
    this.numActions = manifest.numActions;
    this.numBelief = manifest.numBelief ?? 0;
    const need = ['fc1', 'fc2', 'actor', 'critic', ...(this.numBelief ? ['belief'] : [])]
      .flatMap((n) => [`${n}.weight`, `${n}.bias`])
      .concat(['lstm.weight_ih_l0', 'lstm.weight_hh_l0', 'lstm.bias_ih_l0', 'lstm.bias_hh_l0']);
    for (const n of need) if (!this.w[n]) throw new Error(`weights: missing tensor ${n}`);
    this.f1 = new Float32Array(this.hidden);
    this.f2 = new Float32Array(this.hidden);
    this.gates = new Float32Array(4 * this.hidden);
  }

  initialState(): LstmState {
    return { h: new Float32Array(this.hidden), c: new Float32Array(this.hidden) };
  }

  /** One recurrent step. Mutates `state` in place (like the agent's hidden_state). */
  step(x: ArrayLike<number>, state: LstmState): StepOutput {
    const H = this.hidden;
    const D = this.inputDim;
    const w = this.w;
    dense(w['fc1.weight'], w['fc1.bias'], x, D, this.f1, H, true);
    dense(w['fc2.weight'], w['fc2.bias'], this.f1, H, this.f2, H, true);

    const wih = w['lstm.weight_ih_l0'];
    const whh = w['lstm.weight_hh_l0'];
    const bih = w['lstm.bias_ih_l0'];
    const bhh = w['lstm.bias_hh_l0'];
    const g = this.gates;
    const xin = this.f2;
    const hp = state.h;
    for (let r = 0; r < 4 * H; r++) {
      let acc = bih[r] + bhh[r];
      const o = r * H;
      for (let k = 0; k < H; k++) acc += wih[o + k] * xin[k] + whh[o + k] * hp[k];
      g[r] = acc;
    }
    // PyTorch gate order: input, forget, cell, output
    for (let j = 0; j < H; j++) {
      const i = sigmoid(g[j]);
      const f = sigmoid(g[H + j]);
      const gg = Math.tanh(g[2 * H + j]);
      const o = sigmoid(g[3 * H + j]);
      const c = f * state.c[j] + i * gg;
      state.c[j] = c;
      state.h[j] = o * Math.tanh(c);
    }

    const logits = new Float32Array(this.numActions);
    dense(w['actor.weight'], w['actor.bias'], state.h, H, logits, this.numActions, false);
    const v = new Float32Array(1);
    dense(w['critic.weight'], w['critic.bias'], state.h, H, v, 1, false);
    const out: StepOutput = { logits, value: Math.tanh(v[0]) };
    if (this.numBelief) {
      out.belief = new Float32Array(this.numBelief);
      dense(w['belief.weight'], w['belief.bias'], state.h, H, out.belief, this.numBelief, false);
    }
    return out;
  }
}

function dense(
  W: Float32Array,
  b: Float32Array,
  x: ArrayLike<number>,
  inDim: number,
  out: Float32Array,
  outDim: number,
  relu: boolean,
): void {
  for (let r = 0; r < outDim; r++) {
    let acc = b[r];
    const o = r * inDim;
    for (let k = 0; k < inDim; k++) acc += W[o + k] * x[k];
    out[r] = relu && acc < 0 ? 0 : acc;
  }
}

/** Softmax restricted to legal actions (masked entries get exactly 0). */
export function maskedSoftmax(logits: ArrayLike<number>, mask: ArrayLike<number>): Float64Array {
  const p = new Float64Array(logits.length);
  let m = -Infinity;
  for (let i = 0; i < logits.length; i++) if (mask[i] && logits[i] > m) m = logits[i];
  let z = 0;
  for (let i = 0; i < logits.length; i++) {
    if (!mask[i]) continue;
    p[i] = Math.exp(logits[i] - m);
    z += p[i];
  }
  for (let i = 0; i < p.length; i++) p[i] /= z;
  return p;
}

/** Belief class probabilities: softmax over the classes in `bmask`; all zeros if none is possible. */
export function beliefProbs(logits: ArrayLike<number>, bmask: ArrayLike<number>): Float64Array {
  for (let i = 0; i < bmask.length; i++) if (bmask[i]) return maskedSoftmax(logits, bmask);
  return new Float64Array(logits.length);
}

/** Sample an index from a probability vector with uniform draw u in [0, 1). */
export function sampleIndex(probs: ArrayLike<number>, u: number): number {
  let acc = 0;
  let last = -1;
  for (let i = 0; i < probs.length; i++) {
    if (probs[i] <= 0) continue;
    acc += probs[i];
    last = i;
    if (u < acc) return i;
  }
  return last;
}
