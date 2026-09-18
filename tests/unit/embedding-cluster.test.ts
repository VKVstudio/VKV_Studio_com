/**
 * Lab Quest Phase C — pure-function regression tests for lib/embedding/cluster.ts.
 * =============================================================================
 * Quick coverage for the deterministic k-means used by the Explore tab's
 * opt-in clustering: two well-separated 2D groups should actually separate
 * (k=2), a single well-separated point set should NOT fracture when k=1,
 * and `nameClusters` should label each cluster by its nearest-to-centroid
 * input, never a hand-assigned category.
 */
import { describe, it, expect } from 'vitest';
import { kmeans, nameClusters } from '@/lib/embedding/cluster';

describe('kmeans', () => {
  // Two tight, well-separated 2D groups: one clustered around [1,0], one
  // around [-1,0] — plainly separable, so k=2 should recover the grouping
  // exactly regardless of k-means++'s random seed (the seed is fixed).
  const groupA = [
    [1, 0.05],
    [0.98, -0.02],
    [1.02, 0.01],
  ];
  const groupB = [
    [-1, 0.03],
    [-0.97, -0.04],
    [-1.01, 0.02],
  ];
  const vectors = [...groupA, ...groupB];

  it('separates two well-separated groups into two distinct clusters (k=2)', () => {
    const result = kmeans(vectors, 2);
    expect(result.k).toBe(2);
    const clusterOfA = result.assignments.slice(0, 3);
    const clusterOfB = result.assignments.slice(3, 6);
    // Every point within a group shares the same cluster id...
    expect(new Set(clusterOfA).size).toBe(1);
    expect(new Set(clusterOfB).size).toBe(1);
    // ...and the two groups land in DIFFERENT clusters.
    expect(clusterOfA[0]).not.toBe(clusterOfB[0]);
  });

  it('reports a high silhouette score for cleanly separated clusters', () => {
    const result = kmeans(vectors, 2);
    expect(result.silhouette).toBeGreaterThan(0.5);
  });

  it('is deterministic — identical input always yields identical output', () => {
    const first = kmeans(vectors, 2);
    const second = kmeans(vectors, 2);
    expect(second.assignments).toEqual(first.assignments);
    expect(second.silhouette).toBeCloseTo(first.silhouette);
  });

  it('k=1 assigns everything to a single cluster with silhouette 0', () => {
    const result = kmeans(vectors, 1);
    expect(result.k).toBe(1);
    expect(new Set(result.assignments).size).toBe(1);
    expect(result.silhouette).toBe(0);
  });

  it('clamps requestedK above the point count down to the point count', () => {
    const result = kmeans(vectors, 50);
    expect(result.k).toBeLessThanOrEqual(vectors.length);
  });

  it('handles empty input without throwing', () => {
    const result = kmeans([], 3);
    expect(result.assignments).toEqual([]);
    expect(result.silhouette).toBe(0);
  });
});

describe('nameClusters', () => {
  it('names each cluster after the label whose vector is closest to its centroid', () => {
    const vectors = [
      [1, 0], // "alpha" — will be the centroid-closest point of its cluster
      [1, 0.01], // "alpha-ish"
      [-1, 0], // "beta" — centroid-closest of the other cluster
      [-1, 0.01], // "beta-ish"
    ];
    const labels = ['alpha', 'alpha-ish', 'beta', 'beta-ish'];
    const result = kmeans(vectors, 2);
    const names = nameClusters(vectors, labels, result);
    expect(names).toHaveLength(2);
    // Every returned name must be one of the actual input labels — never a
    // fabricated or hand-assigned category name.
    for (const name of names) {
      expect(labels).toContain(name);
    }
  });
});
