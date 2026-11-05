/// <reference lib="webworker" />
// Runs the policies off the main thread. Each game seat keeps its own LSTM
// state for the whole game, exactly like the Python agents' hidden state.
// Gen7 (the default opponent) loads at init; Gen5 is fetched on first use.

import gen5Json from '../model/gen5.json';
import gen7Json from '../model/gen7.json';
import { CoupPolicy, beliefProbs, maskedSoftmax, sampleIndex, type LstmState, type Manifest } from './model';
import { DEFAULT_MODEL, type ModelId, type WorkerRequest, type WorkerResponse } from './protocol';

declare const self: DedicatedWorkerGlobalScope;

const MODELS: Record<ModelId, { manifest: Manifest; url: string }> = {
  gen5: { manifest: gen5Json as Manifest, url: new URL('../model/gen5.bin', import.meta.url).href },
  gen7: { manifest: gen7Json as Manifest, url: new URL('../model/gen7.bin', import.meta.url).href },
};

const states = new Map<string, { model: ModelId; st: LstmState }>();
const policies: Partial<Record<ModelId, CoupPolicy>> = {};
const loading: Partial<Record<ModelId, Promise<CoupPolicy>>> = {};

function post(msg: WorkerResponse) {
  self.postMessage(msg);
}

function load(model: ModelId): Promise<CoupPolicy> {
  const ready = policies[model];
  if (ready) return Promise.resolve(ready);
  if (!loading[model]) {
    const { manifest, url } = MODELS[model];
    const t0 = performance.now();
    loading[model] = fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`${model} weights HTTP ${r.status}`);
        return r.arrayBuffer();
      })
      .then((buf) => {
        const p = (policies[model] = new CoupPolicy(manifest, buf));
        post({ type: 'ready', model, ms: Math.round(performance.now() - t0), bytes: buf.byteLength });
        return p;
      })
      .catch((err) => {
        delete loading[model];
        post({ type: 'error', model, message: String(err?.message ?? err) });
        throw err;
      });
  }
  return loading[model]!;
}

function uniform(): number {
  const b = new Uint32Array(1);
  crypto.getRandomValues(b);
  return b[0] / 0x100000000;
}

async function handle(msg: WorkerRequest) {
  try {
    if (msg.type === 'init') {
      await load(DEFAULT_MODEL);
    } else if (msg.type === 'load') {
      await load(msg.model);
    } else if (msg.type === 'reset' || msg.type === 'release') {
      // the next decide for this key starts from a fresh LSTM state
      states.delete(msg.key);
    } else if (msg.type === 'decide') {
      const p = await load(msg.model);
      let seat = states.get(msg.key);
      if (!seat || seat.model !== msg.model) states.set(msg.key, (seat = { model: msg.model, st: p.initialState() }));
      const t0 = performance.now();
      const out = p.step(msg.obs, seat.st);
      const probs = maskedSoftmax(out.logits, msg.mask);
      const choice = sampleIndex(probs, uniform());
      post({
        type: 'decision',
        id: msg.id,
        model: msg.model,
        logits: Array.from(out.logits),
        probs: Array.from(probs),
        value: out.value,
        choice,
        ...(out.belief
          ? { belief: Array.from(beliefProbs(out.belief, msg.bmask ?? new Uint8Array(out.belief.length))) }
          : {}),
        ms: performance.now() - t0,
      });
    }
  } catch (err) {
    if (msg.type === 'decide') post({ type: 'failed', id: msg.id, message: String((err as Error)?.message ?? err) });
  }
}

// Handle messages strictly in order, so a reset sent after a decide that is
// still waiting for its weights cannot be overtaken by it.
let queue: Promise<void> = Promise.resolve();
self.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  queue = queue.then(() => handle(ev.data));
};
