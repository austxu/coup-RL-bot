/// <reference lib="webworker" />
// Runs the Gen5 policy off the main thread. Each game seat keeps its own LSTM
// state for the whole game, exactly like PPOAgent.hidden_state in Python.

import manifestJson from '../model/gen5.json';
import { CoupPolicy, maskedSoftmax, sampleIndex, type LstmState, type Manifest } from './model';
import type { WorkerRequest, WorkerResponse } from './protocol';

declare const self: DedicatedWorkerGlobalScope;

const manifest = manifestJson as Manifest;
const weightsUrl = new URL('../model/gen5.bin', import.meta.url).href;
const states = new Map<string, LstmState>();
let policy: CoupPolicy | null = null;
let loading: Promise<CoupPolicy> | null = null;

function post(msg: WorkerResponse) {
  self.postMessage(msg);
}

function load(): Promise<CoupPolicy> {
  if (policy) return Promise.resolve(policy);
  if (!loading) {
    const t0 = performance.now();
    loading = fetch(weightsUrl)
      .then((r) => {
        if (!r.ok) throw new Error(`weights HTTP ${r.status}`);
        return r.arrayBuffer();
      })
      .then((buf) => {
        policy = new CoupPolicy(manifest, buf);
        post({ type: 'ready', ms: Math.round(performance.now() - t0), bytes: buf.byteLength });
        return policy;
      })
      .catch((err) => {
        loading = null;
        post({ type: 'error', message: String(err?.message ?? err) });
        throw err;
      });
  }
  return loading;
}

function uniform(): number {
  const b = new Uint32Array(1);
  crypto.getRandomValues(b);
  return b[0] / 0x100000000;
}

self.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  const msg = ev.data;
  try {
    if (msg.type === 'init') {
      await load();
    } else if (msg.type === 'reset') {
      const p = await load();
      states.set(msg.key, p.initialState());
    } else if (msg.type === 'release') {
      states.delete(msg.key);
    } else if (msg.type === 'decide') {
      const p = await load();
      let st = states.get(msg.key);
      if (!st) states.set(msg.key, (st = p.initialState()));
      const t0 = performance.now();
      const out = p.step(msg.obs, st);
      const probs = maskedSoftmax(out.logits, msg.mask);
      const choice = sampleIndex(probs, uniform());
      post({
        type: 'decision',
        id: msg.id,
        logits: Array.from(out.logits),
        probs: Array.from(probs),
        value: out.value,
        choice,
        ms: performance.now() - t0,
      });
    }
  } catch (err) {
    if (msg.type === 'decide') post({ type: 'failed', id: msg.id, message: String((err as Error)?.message ?? err) });
  }
};
