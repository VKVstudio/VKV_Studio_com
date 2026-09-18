/**
 * Main-thread half of the off-thread token counter.
 *
 * Owns one lazily-created module worker and a request map. Every failure mode
 * resolves to `null`, which the caller reads as "do it here instead" — so the
 * worst case is exactly today's behaviour, never a page with no token count.
 * The failure modes worth naming:
 *
 *  • no `Worker` at all (SSR, and any environment without workers)
 *  • construction throws (CSP, a blocked chunk)
 *  • `onerror` fires — the worker is marked dead so later calls stop trying
 *  • the worker never answers — see the timeout below
 *
 * The timeout is the important one. A promise that simply never settles would
 * leave the token count spinning forever, which is a worse failure than the
 * blocking parse this exists to avoid.
 */

import type { CountRequest, CountResponse } from './tiktoken-count.worker';

/** `undefined` = not tried yet, `null` = unavailable, don't retry. */
let worker: Worker | null | undefined;
let seq = 0;

interface Pending {
  resolve: (value: { count: number; ms: number }) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pending = new Map<number, Pending>();

/**
 * Generous: this covers downloading and parsing a ~1 MB rank table on a slow
 * phone, not the encode. Only a genuinely stuck worker should hit it.
 */
const WORKER_TIMEOUT_MS = 10_000;

function failAll(reason: Error): void {
  for (const p of pending.values()) {
    clearTimeout(p.timer);
    p.reject(reason);
  }
  pending.clear();
}

function getWorker(): Worker | null {
  if (worker !== undefined) return worker;

  if (typeof Worker === 'undefined') {
    worker = null;
    return null;
  }

  try {
    const w = new Worker(new URL('./tiktoken-count.worker.ts', import.meta.url), {
      type: 'module',
    });

    w.onmessage = (e: MessageEvent<CountResponse>): void => {
      const msg = e.data;
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve({ count: msg.count, ms: msg.ms });
      else p.reject(new Error(msg.error));
    };

    w.onerror = (): void => {
      // Retire it: whatever broke will break again, and silently retrying a
      // dead worker on every keystroke would add latency to every count.
      worker = null;
      failAll(new Error('tiktoken worker errored'));
    };

    worker = w;
  } catch {
    worker = null;
  }

  return worker;
}

/**
 * Count tokens off the main thread, with the `cl100k_base` encoding the
 * approximation path is fixed to.
 *
 * @returns the count and the encode time, or `null` when no worker is available
 *          — in which case the caller should do the work itself.
 */
export function countOffThread(text: string): Promise<{ count: number; ms: number }> | null {
  const w = getWorker();
  if (!w) return null;

  const id = ++seq;
  return new Promise<{ count: number; ms: number }>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('tiktoken worker timed out'));
    }, WORKER_TIMEOUT_MS);

    pending.set(id, { resolve, reject, timer });
    const req: CountRequest = { id, text };
    w.postMessage(req);
  });
}
