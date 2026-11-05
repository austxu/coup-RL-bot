/** Policies the worker can run. Gen7 loads at start-up; Gen5 is fetched on first use. */
export type ModelId = 'gen5' | 'gen7';
export const DEFAULT_MODEL: ModelId = 'gen7';

export type WorkerRequest =
  | { type: 'init' }
  | { type: 'load'; model: ModelId }
  | { type: 'reset'; key: string }
  | { type: 'release'; key: string }
  | {
      type: 'decide';
      id: number;
      key: string;
      model: ModelId;
      obs: Float32Array;
      mask: Uint8Array;
      /** Gen7 belief mask (possible opponent hand classes). */
      bmask?: Uint8Array;
    };

export type WorkerResponse =
  | { type: 'ready'; model: ModelId; ms: number; bytes: number }
  | { type: 'error'; model: ModelId; message: string }
  | { type: 'failed'; id: number; message: string }
  | {
      type: 'decision';
      id: number;
      model: ModelId;
      logits: number[];
      probs: number[];
      value: number;
      choice: number;
      /** Gen7: probabilities of the 20 opponent hand classes (softmax over bmask; zeros if none possible). */
      belief?: number[];
      ms: number;
    };

export type Decision = Extract<WorkerResponse, { type: 'decision' }>;
