import { DEFAULT_MODEL, type Decision, type ModelId, type WorkerRequest, type WorkerResponse } from './protocol';

type Status = 'loading' | 'ready' | 'error';
/** Per-model load state; 'idle' = not requested yet (Gen5 loads on first use). */
export interface ModelStatus {
  status: Status | 'idle';
  loadMs: number;
  error: string;
}

/** Promise wrapper around the inference worker. */
export class BotClient {
  /** Status, error and load time of the default model (Gen7), which loads at start-up. */
  status: Status = 'loading';
  error = '';
  loadMs = 0;
  readonly models: Record<ModelId, ModelStatus> = {
    gen5: { status: 'idle', loadMs: 0, error: '' },
    gen7: { status: 'idle', loadMs: 0, error: '' },
  };
  private worker: Worker;
  private nextId = 1;
  private pending = new Map<
    number,
    { model: ModelId; resolve: (d: Decision) => void; reject: (e: Error) => void }
  >();
  private listeners = new Set<() => void>();

  constructor() {
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (ev: MessageEvent<WorkerResponse>) => this.onMessage(ev.data);
    this.worker.onerror = (ev) => {
      this.status = 'error';
      this.error = ev.message || 'worker failed to start';
      this.notify();
    };
    this.models[DEFAULT_MODEL].status = 'loading';
    this.send({ type: 'init' });
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Start fetching a model's weights now (e.g. when it is picked in the lobby). */
  preload(model: ModelId) {
    const m = this.models[model];
    if (m.status === 'ready' || m.status === 'loading') return;
    m.status = 'loading';
    this.notify();
    this.send({ type: 'load', model });
  }

  reset(key: string) {
    this.send({ type: 'reset', key });
  }
  release(key: string) {
    this.send({ type: 'release', key });
  }

  /**
   * One policy step for seat `key` (its LSTM state persists until reset/release).
   * Gen7 also takes the belief mask from encodePrompt7 and returns `belief`.
   */
  decide(key: string, model: ModelId, obs: Float32Array, mask: Uint8Array, bmask?: Uint8Array): Promise<Decision> {
    const m = this.models[model];
    if (m.status === 'idle' || m.status === 'error') {
      m.status = 'loading';
      this.notify();
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { model, resolve, reject });
      this.send({ type: 'decide', id, key, model, obs, mask, ...(bmask ? { bmask } : {}) });
    });
  }

  private send(msg: WorkerRequest) {
    this.worker.postMessage(msg);
  }

  private notify() {
    this.listeners.forEach((fn) => fn());
  }

  private onMessage(msg: WorkerResponse) {
    if (msg.type === 'ready') {
      Object.assign(this.models[msg.model], { status: 'ready', loadMs: msg.ms, error: '' });
      if (msg.model === DEFAULT_MODEL) {
        this.status = 'ready';
        this.loadMs = msg.ms;
      }
      this.notify();
    } else if (msg.type === 'error') {
      Object.assign(this.models[msg.model], { status: 'error', error: msg.message });
      if (msg.model === DEFAULT_MODEL) {
        this.status = 'error';
        this.error = msg.message;
      }
      this.notify();
      for (const [id, p] of this.pending) {
        if (p.model !== msg.model) continue;
        p.reject(new Error(msg.message));
        this.pending.delete(id);
      }
    } else if (msg.type === 'failed') {
      this.pending.get(msg.id)?.reject(new Error(msg.message));
      this.pending.delete(msg.id);
    } else if (msg.type === 'decision') {
      this.pending.get(msg.id)?.resolve(msg);
      this.pending.delete(msg.id);
    }
  }
}
