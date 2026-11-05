export type WorkerRequest =
  | { type: 'init' }
  | { type: 'reset'; key: string }
  | { type: 'release'; key: string }
  | { type: 'decide'; id: number; key: string; obs: Float32Array; mask: Uint8Array };

export type WorkerResponse =
  | { type: 'ready'; ms: number; bytes: number }
  | { type: 'error'; message: string }
  | { type: 'failed'; id: number; message: string }
  | {
      type: 'decision';
      id: number;
      logits: number[];
      probs: number[];
      value: number;
      choice: number;
      ms: number;
    };

export type Decision = Extract<WorkerResponse, { type: 'decision' }>;
