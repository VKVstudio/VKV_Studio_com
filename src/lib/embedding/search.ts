/**
 * search.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Pure, dependency-free retrieval/reranking primitives — the actual "RAG"
 * math behind the Embedding Explorer. Every function here is synchronous and
 * side-effect-free so it can be unit-tested and re-run cheaply as a user
 * tweaks weights/sliders in the UI.
 */

import type { EmbeddingVector, ScoredItem } from './types';

/**
 * Cosine similarity between two embedding vectors — implemented as a plain
 * dot product, which is mathematically exact ONLY when both vectors are
 * already L2-normalized (unit length). That is the standing assumption for
 * every vector produced by `engine.ts`'s `embed()` (it always requests
 * `normalize: true`), so this stays a cheap dot product rather than paying
 * for the norm divisions on every comparison.
 *
 * Guards against mismatched lengths (e.g. comparing vectors from two
 * different-dimension models) by only summing over the shared prefix,
 * rather than throwing — a partial/garbage score is more useful to a caller
 * than a crash, and mismatched-dimension comparisons are a caller bug this
 * function can't fully prevent anyway.
 */
export function cosineSimilarity(a: EmbeddingVector, b: EmbeddingVector): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < len; i++) {
    dot += (a[i] ?? 0) * (b[i] ?? 0);
  }
  return dot;
}

/**
 * Dense retrieval: scores every vector in `corpusVecs` against `queryVec`
 * (cosine similarity) and returns the top `k` as `{ item, score }` pairs,
 * where `item` is the corpus index — sorted descending by score. This is
 * the textbook "nearest neighbor search" step of RAG: given a query
 * embedding, find the semantically closest passages.
 */
export function topK(
  queryVec: EmbeddingVector,
  corpusVecs: EmbeddingVector[],
  k: number,
): ScoredItem<number>[] {
  const scored: ScoredItem<number>[] = corpusVecs.map((vec, index) => ({
    item: index,
    score: cosineSimilarity(queryVec, vec),
  }));
  scored.sort((x, y) => y.score - x.score);
  return scored.slice(0, Math.max(0, k));
}

/** Tunable BM25 parameters — defaults are the standard Okapi BM25 values. */
export interface Bm25Options {
  /** Term-frequency saturation — higher lets repeated terms keep adding score for longer. */
  k1?: number;
  /** Document-length normalization strength (0 = ignore length, 1 = fully normalize). */
  b?: number;
}

/**
 * A small, self-contained BM25 (Okapi) lexical scorer — the classic
 * inverted-index ranking function search engines used before dense/embedding
 * retrieval existed. Rewards a document for containing rare query terms
 * often, while discounting long documents so they don't win purely by
 * containing more words overall.
 *
 * This is the "lexical" half of hybrid search (see `hybridSearch` below): it
 * catches exact keyword/acronym/ID matches that a dense embedding sometimes
 * blurs past, complementing semantic similarity rather than replacing it.
 *
 * `docs` must already be tokenized (lowercased word arrays) — this function
 * does no tokenization itself, so callers control what "a term" means.
 */
export function bm25Lite(queryTerms: string[], docs: string[][], opts: Bm25Options = {}): number[] {
  const k1 = opts.k1 ?? 1.5;
  const b = opts.b ?? 0.75;
  const docCount = docs.length;
  if (docCount === 0) return [];

  const docLengths = docs.map((d) => d.length);
  const avgDocLen = docLengths.reduce((sum, len) => sum + len, 0) / docCount || 1;

  const uniqueQueryTerms = Array.from(new Set(queryTerms));

  // Document frequency per query term — how many docs contain it at all.
  const documentFrequency = new Map<string, number>();
  for (const term of uniqueQueryTerms) {
    let count = 0;
    for (const doc of docs) {
      if (doc.includes(term)) count++;
    }
    documentFrequency.set(term, count);
  }

  const scores = new Array<number>(docCount).fill(0);
  for (let d = 0; d < docCount; d++) {
    const doc = docs[d] ?? [];
    const docLen = docLengths[d] ?? 0;

    const termFrequency = new Map<string, number>();
    for (const word of doc) {
      termFrequency.set(word, (termFrequency.get(word) ?? 0) + 1);
    }

    let score = 0;
    for (const term of uniqueQueryTerms) {
      const freq = termFrequency.get(term) ?? 0;
      if (freq === 0) continue;
      const df = documentFrequency.get(term) ?? 0;
      // Okapi BM25 idf, "+1 inside the log" variant — keeps idf non-negative
      // even for terms that appear in the majority of documents.
      const idf = Math.log(1 + (docCount - df + 0.5) / (df + 0.5));
      const denom = freq + k1 * (1 - b + (b * docLen) / avgDocLen);
      score += idf * ((freq * (k1 + 1)) / denom);
    }
    scores[d] = score;
  }
  return scores;
}

/** Min-max normalizes a score array into [0, 1]; an all-equal array maps to all-0. */
function minMaxNormalize(scores: number[]): number[] {
  if (scores.length === 0) return [];
  let min = Infinity;
  let max = -Infinity;
  for (const s of scores) {
    if (s < min) min = s;
    if (s > max) max = s;
  }
  const range = max - min;
  if (range === 0) return scores.map(() => 0);
  return scores.map((s) => (s - min) / range);
}

/**
 * Hybrid search: blends normalized dense (embedding cosine similarity) and
 * lexical (BM25) scores for the same corpus, `alpha * dense + (1-alpha) * lexical`.
 *
 * Both inputs are min-max normalized to [0, 1] first because raw cosine
 * similarities and raw BM25 scores live on completely different, incomparable
 * scales — without normalizing, whichever signal happens to have the larger
 * numeric range would dominate the blend regardless of `alpha`.
 *
 * `alpha = 1` → pure dense/semantic search. `alpha = 0` → pure lexical/keyword
 * search. Values in between trade off "understands meaning" vs. "matches
 * exact words" — the classic RAG hybrid-retrieval knob.
 */
export function hybridSearch(dense: number[], lexical: number[], alpha: number): number[] {
  const normDense = minMaxNormalize(dense);
  const normLexical = minMaxNormalize(lexical);
  const len = Math.max(normDense.length, normLexical.length);
  const result: number[] = new Array(len);
  for (let i = 0; i < len; i++) {
    const d = normDense[i] ?? 0;
    const l = normLexical[i] ?? 0;
    result[i] = alpha * d + (1 - alpha) * l;
  }
  return result;
}

/**
 * Reciprocal Rank Fusion (RRF) — fuses two rankings (index-aligned score
 * arrays, the same "one score per corpus item" shape `hybridSearch` takes)
 * by RANK rather than raw magnitude: each list is sorted independently, and
 * item i's fused score is the sum of `1 / (k + rank)` over every list it
 * appears in (rank is 1-based; an item missing from a shorter array simply
 * contributes 0 from that list).
 *
 * Because RRF only looks at ORDER, not by how much one item beat the next,
 * it needs no normalization step first and is immune to one signal's score
 * scale dominating the blend — `hybridSearch`'s real failure mode when raw
 * cosine similarities and raw BM25 scores have very different spreads. That
 * robustness is why RRF is the "boring but safe" 2026 default fusion method
 * in production hybrid search (Elastic, Qdrant, and OpenSearch all ship it
 * out of the box). The trade-off: it discards magnitude entirely, so a
 * landslide winner and a result that barely edged out its neighbor look
 * identical as long as their rank matches.
 *
 * `k` dampens the influence of top ranks — 60 is the literature/industry
 * default (Cormack, Clarke & Buettcher 2009) and rarely needs tuning; a
 * smaller `k` weights rank-1 much more heavily than rank-2, a larger `k`
 * flattens the curve toward "every ranked item counts about the same".
 */
export function reciprocalRankFusion(
  denseScores: number[],
  lexicalScores: number[],
  k: number = 60
): number[] {
  const len = Math.max(denseScores.length, lexicalScores.length);
  const fused = new Array<number>(len).fill(0);

  const applyRanks = (scores: number[]): void => {
    const order = scores
      .map((score, item) => ({ item, score }))
      .sort((a, b) => b.score - a.score);
    order.forEach((entry, rankIndex) => {
      const rank = rankIndex + 1; // 1-based, per the RRF definition
      fused[entry.item] = (fused[entry.item] ?? 0) + 1 / (k + rank);
    });
  };

  if (denseScores.length > 0) applyRanks(denseScores);
  if (lexicalScores.length > 0) applyRanks(lexicalScores);

  return fused;
}

/**
 * Maximal Marginal Relevance (MMR) reranking — a diversity-aware reranker
 * that needs no extra model. Greedily builds an ordered top-`k` selection
 * from `candidateVecs`/`candidateIdx`, at each step picking whichever
 * remaining candidate maximizes
 * `lambda * relevance(candidate, query) - (1-lambda) * max_similarity(candidate, already_selected)`.
 *
 * This is the standard RAG fix for "top-k retrieval returns k near-duplicate
 * chunks that all say the same thing": MMR still favors relevant results,
 * but penalizes ones too similar to what's already been picked, so the final
 * set covers more distinct facets of the query.
 *
 * `lambda = 1` → pure relevance (same order as plain `topK`). `lambda = 0` →
 * pure diversity (ignores the query entirely after the first pick).
 *
 * Returns the selected items' original corpus indices (`candidateIdx`
 * values), in reranked order — NOT positions into `candidateVecs`.
 */
export function mmrRerank(
  queryVec: EmbeddingVector,
  candidateVecs: EmbeddingVector[],
  candidateIdx: number[],
  lambda: number,
  k: number,
): number[] {
  const n = candidateVecs.length;
  if (n === 0 || k <= 0) return [];

  const relevance = candidateVecs.map((vec) => cosineSimilarity(queryVec, vec));
  const selectedPositions: number[] = [];
  const remaining = new Set<number>(Array.from({ length: n }, (_, i) => i));

  const targetCount = Math.min(k, n);
  while (selectedPositions.length < targetCount && remaining.size > 0) {
    let bestPos = -1;
    let bestScore = -Infinity;

    for (const pos of remaining) {
      const rel = relevance[pos] ?? 0;
      const candVec = candidateVecs[pos];
      let maxSimToSelected = 0;
      if (candVec) {
        for (const chosenPos of selectedPositions) {
          const chosenVec = candidateVecs[chosenPos];
          if (!chosenVec) continue;
          const sim = cosineSimilarity(candVec, chosenVec);
          if (sim > maxSimToSelected) maxSimToSelected = sim;
        }
      }
      const mmrScore = lambda * rel - (1 - lambda) * maxSimToSelected;
      if (mmrScore > bestScore) {
        bestScore = mmrScore;
        bestPos = pos;
      }
    }

    if (bestPos === -1) break;
    selectedPositions.push(bestPos);
    remaining.delete(bestPos);
  }

  return selectedPositions
    .map((pos) => candidateIdx[pos])
    .filter((idx): idx is number => idx !== undefined);
}
