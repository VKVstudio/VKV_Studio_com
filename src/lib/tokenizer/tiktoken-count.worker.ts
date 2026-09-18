/**
 * Off-main-thread token counting for the tiktoken APPROXIMATION path.
 *
 * WHY THIS EXISTS
 * The Prompt Architect opens with a non-empty default system block and a default
 * model (`gemini-3.1-pro`) whose tokenizer backend is `api`. On the deployed site
 * the inference server is not reachable, so 300 ms after mount every visitor's
 * browser fires a doomed fetch, falls back to tiktoken, loads the `cl100k_base`
 * rank table (~1 MB) and builds a `Tiktoken` out of it. That construction is one
 * long task landing between FCP and TTI — exactly the window Lighthouse sums into
 * Total Blocking Time. The page measured 730 ms of it.
 *
 * Scheduling that work in `requestIdleCallback` was considered first and would
 * not have helped: an idle callback still runs on the main thread and still lands
 * inside the TBT window. The parse has to LEAVE the thread.
 *
 * WHY cl100k ONLY, AND WHY A STATIC IMPORT
 * This worker serves one caller — `tokenizeWithTiktokenFallback` — and that
 * function hardcodes `cl100k_base`, deliberately, so the numbers it reports never
 * silently change basis. An earlier draft mirrored engine.ts and kept the
 * o200k branch behind a dynamic import; Vite bundles a worker into one
 * self-contained file, so BOTH tables were inlined and the chunk came out at
 * 3.3 MB. With a single encoding the whole thing is ~1.07 MB, and since the
 * worker is only constructed on first use, that download is already lazy.
 *
 * The native tiktoken path is untouched and stays on the main thread: it builds
 * per-token text, bytes and hues for the heatmap, and the Tokenizer page that
 * consumes them already scores 100.
 */

import { Tiktoken } from 'js-tiktoken/lite';
import cl100k from 'js-tiktoken/ranks/cl100k_base';

export interface CountRequest {
  id: number;
  text: string;
}

export type CountResponse =
  | { id: number; ok: true; count: number; ms: number }
  | { id: number; ok: false; error: string };

/** Built once, on the first message — not at module scope, so a worker that is
 *  spawned and never used does not pay for the table. */
let encoder: Tiktoken | null = null;

self.onmessage = (e: MessageEvent<CountRequest>): void => {
  const { id, text } = e.data;
  try {
    encoder ??= new Tiktoken(cl100k);
    // Time the encode, not the one-off table build — the main thread reports
    // this as tokenization speed, and folding a 1 MB parse into it would make
    // the first run look ~100x slower than the tokenizer actually is.
    const start = performance.now();
    const count = encoder.encode(text).length;
    const reply: CountResponse = { id, ok: true, count, ms: performance.now() - start };
    self.postMessage(reply);
  } catch (err) {
    const reply: CountResponse = {
      id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
    self.postMessage(reply);
  }
};
