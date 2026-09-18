/**
 * reduce.worker.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Runs `umapReduce` (see `reduce.ts`) off the main thread. UMAP's iterative
 * layout optimization can take a noticeable amount of time for a few dozen
 * points, and this keeps that work from janking scroll/animation on the
 * main thread.
 *
 * Callers import this via Vite/Astro's worker query suffix:
 *
 *   import ReduceWorker from './reduce.worker?worker';
 *   const worker = new ReduceWorker();
 *   worker.postMessage({ vectors, dims: 3, opts: { seed: 1337 } } satisfies ReduceWorkerRequest);
 *   worker.onmessage = (e: MessageEvent<ReduceWorkerMessage>) => { ... };
 *
 * Deliberately avoids the ambient `webworker` lib (`/// <reference lib="webworker" />`)
 * since this project's tsconfig has no per-file lib override and mixing the
 * `dom` and `webworker` libs in one program redeclares globals like `self`.
 * Instead, `self` is narrowed locally to the small interface this file
 * actually needs.
 */

import { umapReduce, type UmapOptions } from './reduce';
import type { EmbeddingVector, ReducedPoint } from './types';

/** Message shape callers must `postMessage()` to this worker. */
export interface ReduceWorkerRequest {
  vectors: EmbeddingVector[];
  dims?: number;
  opts?: Omit<UmapOptions, 'onEpoch'>;
}

/** Message shapes this worker posts back. */
export type ReduceWorkerMessage =
  | { type: 'progress'; epoch: number; totalEpochs: number }
  | { type: 'done'; points: ReducedPoint[] }
  | { type: 'error'; message: string };

/** Minimal worker-global surface this file needs — see file header for why not `lib.webworker.d.ts`. */
interface WorkerScope {
  onmessage: ((event: MessageEvent<ReduceWorkerRequest>) => void) | null;
  postMessage: (message: ReduceWorkerMessage) => void;
}

const workerScope = self as unknown as WorkerScope;

workerScope.onmessage = (event: MessageEvent<ReduceWorkerRequest>): void => {
  const { vectors, dims, opts } = event.data;

  umapReduce(vectors, dims ?? 3, {
    ...opts,
    onEpoch: (epoch, totalEpochs) => {
      workerScope.postMessage({ type: 'progress', epoch, totalEpochs });
    },
  })
    .then((points) => {
      workerScope.postMessage({ type: 'done', points });
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : 'UMAP reduction failed in worker.';
      workerScope.postMessage({ type: 'error', message });
    });
};
