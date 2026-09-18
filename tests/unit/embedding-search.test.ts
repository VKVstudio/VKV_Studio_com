/**
 * Lab Quest Phase C — pure-function regression tests for lib/embedding/search.ts.
 * =============================================================================
 * Covers the retrieval/reranking math behind the Embedding Explorer: cosine
 * similarity, top-k dense ranking, BM25, min-max hybrid blending, Reciprocal
 * Rank Fusion (RRF), and MMR diversity reranking. All pure functions — no
 * DOM, no network, no Svelte runtime.
 */
import { describe, it, expect } from 'vitest';
import {
  cosineSimilarity,
  topK,
  bm25Lite,
  hybridSearch,
  reciprocalRankFusion,
  mmrRerank,
} from '@/lib/embedding/search';

// ─── cosineSimilarity ──────────────────────────────────────────────────────

describe('cosineSimilarity', () => {
  it('is 1 for identical (unit) vectors', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
  });

  it('is 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it('is -1 for opposite unit vectors', () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1);
  });

  it('computes a known dot product for a non-trivial pair', () => {
    // [3,4]·[1,2] = 3 + 8 = 11 — deliberately not unit-normalized here, since
    // the function is a plain dot product regardless of input norm.
    expect(cosineSimilarity([3, 4], [1, 2])).toBeCloseTo(11);
  });

  it('sums only over the shared prefix for mismatched lengths, instead of throwing', () => {
    expect(() => cosineSimilarity([1, 2, 3], [1, 2])).not.toThrow();
    expect(cosineSimilarity([1, 2, 3], [1, 2])).toBeCloseTo(1 * 1 + 2 * 2);
  });
});

// ─── topK ──────────────────────────────────────────────────────────────────

describe('topK', () => {
  const query = [1, 0];
  const corpus = [
    [0, 1], // orthogonal — score 0
    [1, 0], // identical — score 1
    [0.5, 0.5], // score 0.5
  ];

  it('orders results descending by cosine similarity', () => {
    const result = topK(query, corpus, 3);
    expect(result.map((r) => r.item)).toEqual([1, 2, 0]);
    expect(result[0]?.score).toBeCloseTo(1);
    expect(result[2]?.score).toBeCloseTo(0);
  });

  it('respects k, truncating to the top results only', () => {
    const result = topK(query, corpus, 1);
    expect(result).toHaveLength(1);
    expect(result[0]?.item).toBe(1);
  });

  it('clamps k above the corpus size to the corpus size, and k<=0 to empty', () => {
    expect(topK(query, corpus, 100)).toHaveLength(3);
    expect(topK(query, corpus, 0)).toHaveLength(0);
  });

  it('keeps tied scores in a stable, deterministic order', () => {
    const tiedCorpus = [
      [1, 0],
      [1, 0],
      [1, 0],
    ];
    const result = topK(query, tiedCorpus, 3);
    // All three tie at score 1 — a stable sort must preserve original order.
    expect(result.map((r) => r.item)).toEqual([0, 1, 2]);
  });
});

// ─── bm25Lite ──────────────────────────────────────────────────────────────

describe('bm25Lite', () => {
  it('scores a doc with higher term frequency higher (same doc length)', () => {
    const docs = [
      ['cat', 'sat', 'on', 'the', 'mat'], // "cat" appears once
      ['cat', 'cat', 'cat', 'is', 'here'], // "cat" appears three times, same length
    ];
    const scores = bm25Lite(['cat'], docs);
    expect(scores[1]).toBeGreaterThan(scores[0] ?? 0);
  });

  it('gives a query term with 0 hits in a doc a score of 0 from that term', () => {
    const docs = [['dog', 'ran'], ['cat', 'sat']];
    const scores = bm25Lite(['cat'], docs);
    expect(scores[0]).toBe(0);
    expect(scores[1]).toBeGreaterThan(0);
  });

  it('returns an all-zero array for an empty corpus', () => {
    expect(bm25Lite(['cat'], [])).toEqual([]);
  });

  it('rewards a rarer query term (lower document frequency) with a higher idf contribution', () => {
    // "rare" appears in only 1 of 4 docs; "common" appears in all 4 — a doc
    // containing one occurrence of each should score higher on "rare".
    const docs = [
      ['common', 'word'],
      ['common', 'word'],
      ['common', 'word'],
      ['common', 'rare', 'word'],
    ];
    const rareScore = bm25Lite(['rare'], docs)[3] ?? 0;
    const commonScore = bm25Lite(['common'], docs)[3] ?? 0;
    expect(rareScore).toBeGreaterThan(commonScore);
  });
});

// ─── hybridSearch (min-max blend) ───────────────────────────────────────────

describe('hybridSearch', () => {
  const dense = [0.2, 0.8, 0.5];
  const lexical = [10, 0, 5];

  it('alpha=1 is equivalent to min-max normalized dense scores alone', () => {
    const result = hybridSearch(dense, lexical, 1);
    // min-max normalize dense manually: min=0.2, max=0.8, range=0.6
    expect(result[0]).toBeCloseTo((0.2 - 0.2) / 0.6);
    expect(result[1]).toBeCloseTo((0.8 - 0.2) / 0.6);
    expect(result[2]).toBeCloseTo((0.5 - 0.2) / 0.6);
  });

  it('alpha=0 is equivalent to min-max normalized lexical scores alone', () => {
    const result = hybridSearch(dense, lexical, 0);
    // min-max normalize lexical manually: min=0, max=10, range=10
    expect(result[0]).toBeCloseTo(1.0);
    expect(result[1]).toBeCloseTo(0.0);
    expect(result[2]).toBeCloseTo(0.5);
  });

  it('alpha=0.5 blends the two normalized scales evenly', () => {
    const result = hybridSearch(dense, lexical, 0.5);
    const normDense = [(0.2 - 0.2) / 0.6, (0.8 - 0.2) / 0.6, (0.5 - 0.2) / 0.6];
    const normLexical = [1.0, 0.0, 0.5];
    for (let i = 0; i < 3; i++) {
      expect(result[i]).toBeCloseTo(0.5 * (normDense[i] ?? 0) + 0.5 * (normLexical[i] ?? 0));
    }
  });

  it('maps an all-equal score array to all zeros instead of dividing by zero', () => {
    expect(hybridSearch([5, 5, 5], [1, 1, 1], 0.5)).toEqual([0, 0, 0]);
  });
});

// ─── reciprocalRankFusion (RRF) ─────────────────────────────────────────────

describe('reciprocalRankFusion', () => {
  it('produces exact 1/(k+rank) sums for known, disjoint-winner rankings', () => {
    // dense ranks: item1 (0.9) > item0 (0.5) > item2 (0.1)
    // lexical ranks: item2 (10) > item0 (5) > item1 (0)
    const dense = [0.5, 0.9, 0.1];
    const lexical = [5, 0, 10];
    const fused = reciprocalRankFusion(dense, lexical, 60);

    // item0: rank 2 in dense (1/62), rank 2 in lexical (1/62)
    expect(fused[0]).toBeCloseTo(1 / 62 + 1 / 62);
    // item1: rank 1 in dense (1/61), rank 3 in lexical (1/63)
    expect(fused[1]).toBeCloseTo(1 / 61 + 1 / 63);
    // item2: rank 3 in dense (1/63), rank 1 in lexical (1/61)
    expect(fused[2]).toBeCloseTo(1 / 63 + 1 / 61);

    // item1 and item2 are symmetric (one wins each list at rank 1, loses the
    // other at rank 3) so they fuse to an identical score, both beating the
    // "consistently mediocre" item0.
    expect(fused[1]).toBeCloseTo(fused[2]!);
    expect(fused[1]).toBeGreaterThan(fused[0]!);
  });

  it('reproduces a consensus ranking item-for-item when both lists agree exactly', () => {
    // Both lists rank the same 4 items in the same order — RRF should just
    // reflect that agreement: strictly decreasing fused scores, in order.
    const agreed = [0.9, 0.7, 0.5, 0.3];
    const fused = reciprocalRankFusion(agreed, agreed, 60);
    expect(fused[0]).toBeGreaterThan(fused[1] ?? 0);
    expect(fused[1]).toBeGreaterThan(fused[2] ?? 0);
    expect(fused[2]).toBeGreaterThan(fused[3] ?? 0);
    // Exact values: agreeing at rank r in both lists sums to 2/(k+r).
    expect(fused[0]).toBeCloseTo(2 / 61);
    expect(fused[3]).toBeCloseTo(2 / 64);
  });

  it('a smaller k weights rank-1 more heavily relative to lower ranks than a larger k', () => {
    const dense = [0.9, 0.5, 0.1];
    const lexical: number[] = [];
    const smallK = reciprocalRankFusion(dense, lexical, 1);
    const largeK = reciprocalRankFusion(dense, lexical, 1000);

    // Ratio of rank-1's score to rank-3's score should shrink toward 1 as k
    // grows (RRF flattens out for large k).
    const ratioSmallK = (smallK[0] ?? 0) / (smallK[2] ?? 1);
    const ratioLargeK = (largeK[0] ?? 0) / (largeK[2] ?? 1);
    expect(ratioSmallK).toBeGreaterThan(ratioLargeK);
    expect(ratioLargeK).toBeCloseTo(1, 1); // near-flat at k=1000
  });

  it('defaults k to 60 when omitted', () => {
    const withDefault = reciprocalRankFusion([0.9, 0.1], []);
    const explicit60 = reciprocalRankFusion([0.9, 0.1], [], 60);
    expect(withDefault).toEqual(explicit60);
  });

  it('an item missing from a shorter array contributes 0 from that list', () => {
    const dense = [0.9, 0.5, 0.1]; // 3 items
    const lexical = [0.9]; // only item 0 has a lexical score
    const fused = reciprocalRankFusion(dense, lexical, 60);
    // item2 only ever appears (rank 3) in dense: 1/(60+3), nothing from lexical.
    expect(fused[2]).toBeCloseTo(1 / 63);
  });
});

// ─── mmrRerank ───────────────────────────────────────────────────────────────

describe('mmrRerank — lambda extremes', () => {
  const query = [1, 0];
  // v0/v1 are identical near-duplicates (both maximally relevant); v2 is
  // orthogonal to the query (irrelevant) and to v0/v1 (maximally diverse).
  const candidateVecs = [
    [1, 0],
    [1, 0],
    [0, 1],
  ];
  const candidateIdx = [10, 11, 12];

  it('lambda=1 (pure relevance) matches plain relevance ranking, duplicates and all', () => {
    const order = mmrRerank(query, candidateVecs, candidateIdx, 1, 3);
    // Both relevant duplicates (10, 11) sort ahead of the irrelevant item (12).
    expect(order).toEqual([10, 11, 12]);
  });

  it('lambda=0 (pure diversity) picks the most-diverse remaining item over a near-duplicate', () => {
    const order = mmrRerank(query, candidateVecs, candidateIdx, 0, 3);
    // First pick has no prior selections to diversify against (ties broken
    // by iteration order → item 10). The SECOND pick then favors the
    // maximally-diverse orthogonal item 12 over the near-duplicate item 11,
    // even though item 11 has equal raw relevance — the entire point of MMR.
    expect(order[0]).toBe(10);
    expect(order[1]).toBe(12);
    expect(order[2]).toBe(11);
  });

  it('returns candidateIdx values (corpus ids), never candidateVecs positions', () => {
    const order = mmrRerank(query, candidateVecs, candidateIdx, 1, 3);
    for (const id of order) {
      expect(candidateIdx).toContain(id);
    }
  });

  it('returns at most k items, and empty for an empty candidate pool', () => {
    expect(mmrRerank(query, candidateVecs, candidateIdx, 0.5, 2)).toHaveLength(2);
    expect(mmrRerank(query, [], [], 0.5, 3)).toEqual([]);
  });
});
