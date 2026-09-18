/**
 * engine.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Sentence embedding via Google's **EmbeddingGemma-300M**, computed **server-side**
 * by the inference backend (`POST /api/embed`) — owner decision 2026-07-06:
 * "backend only". No in-browser model download; the frontend just sends text and
 * receives vectors, keeping the whole stack Google and the client lightweight.
 *
 * Trade-off (accepted): the Explorer now REQUIRES the backend to be reachable —
 * it does not run offline / on a bare static deploy without the inference server.
 * That is the deliberate cost of dropping the ~180 MB on-device model download.
 * (An earlier revision ran EmbeddingGemma in-browser via transformers.js; the
 * gating saga behind that lives in git history.)
 */

import type { EmbedProgress, EmbeddingVector } from './types';
import { SYNAPSE_API_BASE } from '../api-config';

/** Where embeddings were computed. Server-only now (kept as a type for the UI badge). */
export type EmbedBackend = 'server';

/**
 * Which retrieval role a text plays — EmbeddingGemma is prompt-conditioned and
 * expects DIFFERENT prefixes for a search query vs. a stored document (the
 * backend applies the official template). Using the wrong prefix measurably
 * degrades retrieval, so every caller declares its intent.
 */
export type EmbedTask = 'query' | 'document';

/** Metadata for a selectable embedding model in the registry below. */
export interface EmbeddingModelInfo {
  /** Registry id (also the value sent to the backend + shown in the UI selector). */
  id: string;
  name: string;
  /** Output embedding dimensionality (a Matryoshka truncation of the native 768). */
  dims: number;
  description: string;
}

/** Native output width of EmbeddingGemma-300M. Smaller `dims` = Matryoshka truncation. */
const NATIVE_DIMS = 768;

/** Default model — EmbeddingGemma at its native 768 dims. */
export const DEFAULT_EMBEDDING_MODEL_ID = 'embeddinggemma-300m';

/**
 * Ordered model registry, for UI selectors. All four entries are the SAME
 * Google EmbeddingGemma weights — only the output width differs. 768/512/
 * 256/128 are the officially-supported Matryoshka Representation Learning
 * (MRL) truncation points for this model. Every non-native entry is
 * truncated + re-normalized CLIENT-SIDE by `truncateAndNormalize` below
 * (see `embedDetailed`'s doc comment for why) rather than requested
 * pre-truncated from the backend.
 */
export const EMBEDDING_MODELS: readonly EmbeddingModelInfo[] = [
  {
    id: DEFAULT_EMBEDDING_MODEL_ID,
    name: 'EmbeddingGemma 300M',
    dims: NATIVE_DIMS,
    description:
      "Google's EmbeddingGemma (300M) — a Gemma-3-based multilingual retrieval embedding model, computed on the inference server. Native 768-dim output, highest quality.",
  },
  {
    id: 'embeddinggemma-300m-512',
    name: 'EmbeddingGemma 300M (512d)',
    dims: 512,
    description:
      'Same EmbeddingGemma weights and server call as the native model — Matryoshka-truncated to 512 dims client-side (then re-normalized) for smaller vectors at a small quality cost.',
  },
  {
    id: 'embeddinggemma-300m-256',
    name: 'EmbeddingGemma 300M (compact)',
    dims: 256,
    description:
      'Same EmbeddingGemma weights, Matryoshka-truncated to 256 dims client-side (then re-normalized) — 3× smaller vectors for faster search/plotting at a moderate quality cost.',
  },
  {
    id: 'embeddinggemma-300m-128',
    name: 'EmbeddingGemma 300M (128d)',
    dims: 128,
    description:
      'Same EmbeddingGemma weights, Matryoshka-truncated to 128 dims client-side (then re-normalized) — the smallest officially-supported MRL width, noticeably lossier.',
  },
];

/** Flat list of selectable model ids, in registry order. */
export const EMBEDDING_MODEL_LIST: readonly string[] = EMBEDDING_MODELS.map((m) => m.id);

/** Look up registry metadata for a model id, falling back to the default model if unknown. */
export function getEmbeddingModelInfo(modelId: string): EmbeddingModelInfo {
  const found = EMBEDDING_MODELS.find((m) => m.id === modelId);
  if (found) return found;
  const fallback = EMBEDDING_MODELS[0];
  if (!fallback) {
    // Unreachable in practice (the registry above is a non-empty literal),
    // but keeps this function honestly typed under noUncheckedIndexedAccess.
    throw new Error('[embedding] EMBEDDING_MODELS registry is empty');
  }
  return fallback;
}

/** Tracks whether at least one successful server embed has happened (for the UI badge). */
let _serverReached = false;

/** Full result of an embedding call — which model/backend served it, plus the vectors. */
export interface EmbedOutcome {
  vectors: EmbeddingVector[];
  /** Registry model id that produced these vectors. */
  modelId: string;
  backend: EmbedBackend;
}

interface EmbedApiResponse {
  vectors: number[][];
  model: string;
  dims: number;
  backend: string;
}

/**
 * Matryoshka truncation + L2 re-normalization — mirrors the backend's own
 * `_truncate_normalize` (`inference/embeddings.py`, read-only from here) bit
 * for bit: slice to the first `dims` components, then rescale to unit
 * length so `cosineSimilarity`'s dot-product shortcut (search.ts) stays
 * valid for the truncated vector. Pure and side-effect-free.
 */
export function truncateAndNormalize(vec: EmbeddingVector, dims: number): EmbeddingVector {
  const sliced = vec.slice(0, dims);
  let sumSq = 0;
  for (const v of sliced) sumSq += v * v;
  const norm = Math.sqrt(sumSq);
  if (norm === 0) return sliced;
  return sliced.map((v) => v / norm);
}

/**
 * Embeds one or more texts via the backend's EmbeddingGemma (`POST /api/embed`).
 * Returns the full outcome (vectors + which model served it).
 *
 *  • `taskType` selects EmbeddingGemma's query vs. document prompt prefix — pass
 *    'query' for a search query and 'document' (the default) for corpus text.
 *  • An unknown model id resolves to the default (native 768-dim) entry.
 *  • Every request to the backend asks for the NATIVE 768-dim vector — the
 *    backend (`inference/main.py`'s `_EMBED_MODEL_DIMS`) only recognizes the
 *    native and legacy "-256" ids, and it's a separately-deployed, read-only
 *    surface from here, so it's out of scope to teach it the new 512/128
 *    widths. Any Matryoshka-truncated registry entry (512/256/128) is
 *    produced by slicing + re-normalizing that native response CLIENT-SIDE
 *    via `truncateAndNormalize` instead — mathematically identical to the
 *    backend's own truncation, just computed here so every width beyond
 *    768/256 doesn't need a backend change to add.
 *  • `signal` (optional) is threaded straight through to `fetch` — pass an
 *    `AbortController`'s signal to make this call genuinely cancellable.
 *
 * On any failure (backend unreachable, HTTP error) surfaces the error via
 * `onStatus('error', …)` and rethrows — there is no on-device fallback (that is
 * the accepted trade of "backend only"; the Explorer needs the server). An
 * abort (`signal` fired) rethrows the original `AbortError` without touching
 * `onStatus`, so a caller that intentionally cancelled doesn't see a spurious
 * error banner.
 */
export async function embedDetailed(
  texts: string[],
  onStatus?: EmbedProgress,
  modelId: string = DEFAULT_EMBEDDING_MODEL_ID,
  taskType: EmbedTask = 'document',
  signal?: AbortSignal
): Promise<EmbedOutcome> {
  const info = getEmbeddingModelInfo(modelId);

  if (texts.length === 0) {
    return { vectors: [], modelId: info.id, backend: 'server' };
  }

  try {
    onStatus?.('embedding', `Embedding ${texts.length} item(s) on the server…`);
    const res = await fetch(`${SYNAPSE_API_BASE}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ texts, task: taskType, model: DEFAULT_EMBEDDING_MODEL_ID }),
      signal,
    });

    if (!res.ok) {
      throw new Error(`Embedding backend returned HTTP ${res.status}`);
    }

    const data = (await res.json()) as EmbedApiResponse;
    if (!data || !Array.isArray(data.vectors)) {
      throw new Error('Unexpected response shape from /api/embed');
    }

    _serverReached = true;
    onStatus?.('ready');
    const vectors =
      info.dims < NATIVE_DIMS
        ? data.vectors.map((v) => truncateAndNormalize(v, info.dims))
        : data.vectors;
    return { vectors, modelId: info.id, backend: 'server' };
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw err;
    }
    onStatus?.(
      'error',
      err instanceof Error ? err.message : 'Embedding failed — is the inference server running?'
    );
    throw err;
  }
}

/**
 * Convenience wrapper around `embedDetailed()` returning just the vectors.
 * See `embedDetailed` for the prompt-prefix / error/abort behavior.
 */
export async function embed(
  texts: string[],
  onStatus?: EmbedProgress,
  modelId: string = DEFAULT_EMBEDDING_MODEL_ID,
  taskType: EmbedTask = 'document',
  signal?: AbortSignal
): Promise<EmbeddingVector[]> {
  const { vectors } = await embedDetailed(texts, onStatus, modelId, taskType, signal);
  return vectors;
}

/**
 * The backend that served embeddings — always 'server' once one has succeeded
 * this session, else `undefined`. (Kept for API parity with the old on-device
 * engine, which reported webgpu/wasm.)
 */
export function getActiveBackend(_modelId: string): EmbedBackend | undefined {
  return _serverReached ? 'server' : undefined;
}
