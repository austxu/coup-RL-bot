import type { Decision, WorkerRequest, WorkerResponse } from './protocol';

type Status = 'loading' | 'ready' | 'error';

/** Promise wrapper around the inference worker. */
export class BotClient {
  status: Status = 'loading';
  error = '';
  loadMs = 0;
  private worker: Worker;
  private nextId = 1;
  private pending = new Map<number, { resolve: (d: Decision) => void; reject: (e: Error) => void }>();
  private listeners = new Set<() => void>();

  constructor() {
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (ev: MessageEvent<WorkerResponse>) => this.onMessage(ev.data);
    this.worker.onerror = (ev) => {
      this.status = 'error';
      this.error = ev.message || 'worker failed to start';
      this.notify();
    };
    this.send({ type: 'init' });
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  reset(key: string) {
    this.send({ type: 'reset', key });
  }
  release(key: string) {
    this.send({ type: 'release', key });
  }

  decide(key: string, obs: Float32Array, mask: Uint8Array): Promise<Decision> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ type: 'decide', id, key, obs, mask });
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
      this.status = 'ready';
      this.loadMs = msg.ms;
      this.notify();
    } else if (msg.type === 'error') {
      this.status = 'error';
      this.error = msg.message;
      this.notify();
      this.pending.forEach((p) => p.reject(new Error(msg.message)));
      this.pending.clear();
    } else if (msg.type === 'failed') {
      this.pending.get(msg.id)?.reject(new Error(msg.message));
      this.pending.delete(msg.id);
    } else if (msg.type === 'decision') {
      this.pending.get(msg.id)?.resolve(msg);
      this.pending.delete(msg.id);
    }
  }
}
