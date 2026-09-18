/**
 * Lab Quest Phase C — pure-function regression tests for lib/embedding/engine.ts.
 * =============================================================================
 * Covers `truncateAndNormalize`, the client-side Matryoshka truncation that
 * makes the 512/128-dim registry entries work without any backend change
 * (see engine.ts's doc comment) — pure math, no network, no DOM.
 */
import { describe, it, expect } from 'vitest';
import {
  truncateAndNormalize,
  EMBEDDING_MODELS,
  getEmbeddingModelInfo,
} from '@/lib/embedding/engine';

function magnitude(v: number[]): number {
  return Math.sqrt(v.reduce((sum, x) => sum + x * x, 0));
}

describe('truncateAndNormalize', () => {
  it('slices to exactly `dims` components', () => {
    const vec = [1, 2, 3, 4, 5, 6, 7, 8];
    expect(truncateAndNormalize(vec, 4)).toHaveLength(4);
  });

  it('re-normalizes the truncated vector to unit length', () => {
    const vec = [3, 4, 0, 0]; // magnitude 5 over its first 2 components
    const truncated = truncateAndNormalize(vec, 2);
    expect(truncated).toEqual([3 / 5, 4 / 5]);
    expect(magnitude(truncated)).toBeCloseTo(1);
  });

  it('produces a unit-length vector for each officially-supported Matryoshka width (512/256/128)', () => {
    // A synthetic 768-dim "embedding" with varied, non-uniform values so
    // truncation actually changes the vector's direction, not just its scale.
    const native = Array.from({ length: 768 }, (_, i) => Math.sin(i + 1));
    for (const dims of [512, 256, 128]) {
      const truncated = truncateAndNormalize(native, dims);
      expect(truncated).toHaveLength(dims);
      expect(magnitude(truncated)).toBeCloseTo(1, 5);
    }
  });

  it('is a no-op on magnitude for an already-unit vector at full length', () => {
    const unit = [1, 0, 0];
    expect(truncateAndNormalize(unit, 3)).toEqual(unit);
  });

  it('returns the (zero-length) slice unchanged for an all-zero vector, instead of dividing by zero', () => {
    const zero = [0, 0, 0, 0];
    expect(() => truncateAndNormalize(zero, 2)).not.toThrow();
    expect(truncateAndNormalize(zero, 2)).toEqual([0, 0]);
  });
});

describe('EMBEDDING_MODELS registry — Matryoshka dims', () => {
  it('exposes all four officially-supported widths: 768/512/256/128', () => {
    const dims = EMBEDDING_MODELS.map((m) => m.dims).sort((a, b) => b - a);
    expect(dims).toEqual([768, 512, 256, 128]);
  });

  it('every registry id resolves back to itself via getEmbeddingModelInfo', () => {
    for (const model of EMBEDDING_MODELS) {
      expect(getEmbeddingModelInfo(model.id).id).toBe(model.id);
      expect(getEmbeddingModelInfo(model.id).dims).toBe(model.dims);
    }
  });

  it('an unknown model id falls back to the default (first) registry entry', () => {
    const fallback = getEmbeddingModelInfo('not-a-real-model-id');
    expect(fallback.id).toBe(EMBEDDING_MODELS[0]?.id);
  });
});
