export class Cancelled extends Error {
  constructor() {
    super('cancelled');
  }
}

export const prefersReducedMotion = (): boolean =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * setTimeout that (a) rejects when the match is cancelled and (b) does not
 * start counting while the tab is hidden, so nothing plays out unseen.
 */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Cancelled());
    let timer = 0;
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      document.removeEventListener('visibilitychange', onVisible);
    };
    const onAbort = () => {
      cleanup();
      reject(new Cancelled());
    };
    const start = () => {
      timer = window.setTimeout(() => {
        cleanup();
        resolve();
      }, Math.max(0, ms));
    };
    const onVisible = () => {
      if (document.hidden) return;
      document.removeEventListener('visibilitychange', onVisible);
      start();
    };
    signal.addEventListener('abort', onAbort);
    if (document.hidden) document.addEventListener('visibilitychange', onVisible);
    else start();
  });
}

export const uniform = (a: number, b: number) => a + Math.random() * (b - a);
