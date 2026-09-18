/**
 * types.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Shared types for the Embedding Explorer library (`src/lib/embedding/*`).
 * No runtime code lives here — this file only defines the shapes that
 * engine.ts, search.ts, chunking.ts, corpus.ts and reduce.ts agree on.
 */

/**
 * A dense embedding vector. Everywhere in this library a vector produced by
 * `engine.ts`'s `embed()` is assumed to be L2-normalized (unit length) unless
 * documented otherwise — that assumption is what lets `cosineSimilarity` in
 * `search.ts` skip the norm division and use a plain dot product.
 */
export type EmbeddingVector = number[];

/**
 * A slice of a larger source text, with the character offsets it was cut
 * from (`start`/`end`, both into the ORIGINAL text — not the chunk text
 * itself). Produced by every chunking strategy in `chunking.ts`.
 */
export interface Chunk {
  id: string;
  text: string;
  /** Inclusive start offset (codepoint index) into the original text. */
  start: number;
  /** Exclusive end offset (codepoint index) into the original text. */
  end: number;
}

/** A generic (item, score) pair — used for ranked results of any item type. */
export interface ScoredItem<T> {
  item: T;
  score: number;
}

/**
 * One ranked hit from a search over the demo corpus — the shape a UI layer
 * would render in a results list.
 */
export interface SearchResult {
  chunkId: string;
  text: string;
  /** Final blended/ranked score (see `search.ts`'s `hybridSearch`). */
  score: number;
  /** Raw dense (embedding cosine similarity) score, before normalization. */
  denseScore?: number;
  /** Raw lexical (BM25) score, before normalization. */
  lexicalScore?: number;
}

/** One item after MMR (diversity-aware) reranking — see `search.ts`'s `mmrRerank`. */
export interface RerankResult {
  chunkId: string;
  text: string;
  score: number;
  /** 0-based position in the reranked order (0 = most preferred). */
  rank: number;
}

/**
 * Lifecycle status for an in-progress or completed embedding operation.
 * Mirrors the honest-degradation status pattern used by
 * `src/lib/tokenizer/engine.ts`'s `TokenizerStatus`.
 */
export type EmbedStatus = 'idle' | 'loading-model' | 'embedding' | 'ready' | 'error';

/**
 * Per-call progress/status callback for embedding operations. `detail` is an
 * optional human-readable message (e.g. a model-download progress note, or an
 * error string when EmbeddingGemma fails to load).
 */
export type EmbedProgress = (status: EmbedStatus, detail?: string) => void;

/**
 * A single point in a 3D dimensionality-reduction layout (output of
 * `reduce.ts`'s `pca()`/`umapReduce()`), ready to hand to a Three.js scene.
 */
export interface ReducedPoint {
  x: number;
  y: number;
  z: number;
}
