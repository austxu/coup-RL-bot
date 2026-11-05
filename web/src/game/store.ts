import { useEffect, useState } from 'preact/hooks';

/** Minimal mutable store: mutate `state`, then call `emit()`. */
export class Store<T> {
  private listeners = new Set<() => void>();
  constructor(public state: T) {}
  emit() {
    this.listeners.forEach((fn) => fn());
  }
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

export function useStore<T>(store: Store<T> | null | undefined): T | undefined {
  const [, force] = useState(0);
  useEffect(() => {
    if (!store) return;
    return store.subscribe(() => force((n) => n + 1));
  }, [store]);
  return store?.state;
}

export function useSubscribe(sub: { subscribe(fn: () => void): () => void } | null | undefined) {
  const [, force] = useState(0);
  useEffect(() => sub?.subscribe(() => force((n) => n + 1)), [sub]);
}
