/**
 * cluster.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * UNSUPERVISED clustering of embedding vectors — the honest core of the
 * Embedding Explorer redesign.
 *
 * The whole point of the lab is that STRUCTURE EMERGES from the model, not from
 * the author. So we never colour points by a hand-assigned category. Instead we
 * run k-means over the raw 768-d vectors and colour by the DISCOVERED cluster,
 * and we NAME each cluster only AFTER the fact — by the corpus word whose vector
 * is closest to the cluster centroid. Nothing here knows or uses any human label.
 *
 * All deterministic: k-means++ seeding uses a seeded PRNG (mulberry32) so the
 * same vectors + same k always give the same clustering — no jitter between
 * runs, and the layout cache stays meaningful.
 *
 * Cosine space: EmbeddingGemma vectors are compared by cosine similarity, so we
 * L2-normalise every vector up front and then use Euclidean k-means on the unit
 * sphere (on normalised vectors, squared-Euclidean distance is a monotonic
 * function of cosine, so Euclidean k-means === spherical k-means here).
 */

export interface ClusterResult {
  /** Cluster id per input vector (0..k-1), parallel to the input array. */
  assignments: number[];
  /** k centroids (each an L2-normalised 768-d vector). */
  centroids: number[][];
  /** Mean silhouette score over all points, in [-1, 1] — higher = cleaner separation. */
  silhouette: number;
  /** k actually used (may be < requested k if there are fewer points). */
  k: number;
}

// ── seeded PRNG (same generator the reducers use) ────────────────────────────
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CLUSTER_SEED = 20260708;

function l2normalize(v: number[]): number[] {
  let n = 0;
  for (const x of v) n += x * x;
  const inv = 1 / (Math.sqrt(n) || 1);
  return v.map((x) => x * inv);
}

/** Squared Euclidean distance (on unit vectors this tracks cosine distance). */
function sqDist(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    s += d * d;
  }
  return s;
}

/** k-means++ seeding: pick spread-out initial centroids, deterministically. */
function kmeansppInit(vectors: number[][], k: number, rng: () => number): number[][] {
  const n = vectors.length;
  const first = Math.floor(rng() * n);
  const centroids: number[][] = [vectors[first]!.slice()];
  const d2 = new Array<number>(n).fill(Infinity);

  for (let c = 1; c < k; c++) {
    let total = 0;
    for (let i = 0; i < n; i++) {
      const dist = sqDist(vectors[i]!, centroids[c - 1]!);
      if (dist < d2[i]!) d2[i] = dist;
      total += d2[i]!;
    }
    // Sample the next centroid proportional to squared distance (D² sampling).
    let target = rng() * total;
    let chosen = n - 1;
    for (let i = 0; i < n; i++) {
      target -= d2[i]!;
      if (target <= 0) {
        chosen = i;
        break;
      }
    }
    centroids.push(vectors[chosen]!.slice());
  }
  return centroids;
}

/**
 * Lloyd's k-means over L2-normalised vectors. Deterministic (seeded). Returns
 * assignments + centroids + a mean silhouette score for choosing/showing "how
 * natural" this k is.
 */
export function kmeans(rawVectors: number[][], requestedK: number): ClusterResult {
  const vectors = rawVectors.map(l2normalize);
  const n = vectors.length;
  const dim = vectors[0]?.length ?? 0;
  const k = Math.max(1, Math.min(requestedK, n));

  if (n === 0 || dim === 0) {
    return { assignments: [], centroids: [], silhouette: 0, k };
  }
  if (k === 1) {
    return {
      assignments: new Array<number>(n).fill(0),
      centroids: [meanVec(vectors, dim)],
      silhouette: 0,
      k,
    };
  }

  const rng = mulberry32(CLUSTER_SEED);
  let centroids = kmeansppInit(vectors, k, rng);
  const assignments = new Array<number>(n).fill(0);

  const MAX_ITERS = 50;
  for (let iter = 0; iter < MAX_ITERS; iter++) {
    let moved = false;
    // Assign step.
    for (let i = 0; i < n; i++) {
      let best = 0;
      let bestD = Infinity;
      for (let c = 0; c < k; c++) {
        const d = sqDist(vectors[i]!, centroids[c]!);
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      if (assignments[i] !== best) {
        assignments[i] = best;
        moved = true;
      }
    }
    // Update step.
    const sums = Array.from({ length: k }, () => new Array<number>(dim).fill(0));
    const counts = new Array<number>(k).fill(0);
    for (let i = 0; i < n; i++) {
      const c = assignments[i]!;
      counts[c]!++;
      const row = vectors[i]!;
      const acc = sums[c]!;
      for (let d = 0; d < dim; d++) acc[d]! += row[d]!;
    }
    for (let c = 0; c < k; c++) {
      if (counts[c] === 0) continue; // keep an empty cluster's old centroid rather than NaN it
      const acc = sums[c]!;
      const inv = 1 / counts[c]!;
      centroids[c] = l2normalize(acc.map((x) => x * inv));
    }
    if (!moved && iter > 0) break;
  }

  return { assignments, centroids, silhouette: meanSilhouette(vectors, assignments, k), k };
}

function meanVec(vectors: number[][], dim: number): number[] {
  const acc = new Array<number>(dim).fill(0);
  for (const v of vectors) for (let d = 0; d < dim; d++) acc[d]! += v[d]!;
  return l2normalize(acc.map((x) => x / (vectors.length || 1)));
}

/**
 * Mean silhouette coefficient. For each point: a = mean distance to its own
 * cluster, b = mean distance to the nearest OTHER cluster; s = (b-a)/max(a,b).
 * O(n²) — fine for the few-hundred-point corpus this lab uses.
 */
function meanSilhouette(vectors: number[][], assignments: number[], k: number): number {
  const n = vectors.length;
  if (n <= k || k < 2) return 0;
  const clusters: number[][] = Array.from({ length: k }, () => []);
  for (let i = 0; i < n; i++) clusters[assignments[i]!]!.push(i);

  let total = 0;
  for (let i = 0; i < n; i++) {
    const ci = assignments[i]!;
    const own = clusters[ci]!;
    // a: mean distance to own cluster (excluding self).
    let a = 0;
    if (own.length > 1) {
      for (const j of own) if (j !== i) a += Math.sqrt(sqDist(vectors[i]!, vectors[j]!));
      a /= own.length - 1;
    }
    // b: min over other clusters of mean distance to that cluster.
    let b = Infinity;
    for (let c = 0; c < k; c++) {
      if (c === ci) continue;
      const other = clusters[c]!;
      if (other.length === 0) continue;
      let m = 0;
      for (const j of other) m += Math.sqrt(sqDist(vectors[i]!, vectors[j]!));
      m /= other.length;
      if (m < b) b = m;
    }
    if (b === Infinity) continue;
    const denom = Math.max(a, b);
    total += denom > 0 ? (b - a) / denom : 0;
  }
  return total / n;
}

/**
 * Name each cluster AFTER the fact: the label of the corpus word whose
 * (normalised) vector is closest to the cluster centroid — a read-out of what
 * the model grouped, never a pre-assigned category.
 */
export function nameClusters(
  rawVectors: number[][],
  labels: string[],
  result: ClusterResult
): string[] {
  const vectors = rawVectors.map(l2normalize);
  const names: string[] = [];
  for (let c = 0; c < result.k; c++) {
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < vectors.length; i++) {
      if (result.assignments[i] !== c) continue;
      const d = sqDist(vectors[i]!, result.centroids[c]!);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    names.push(best >= 0 ? (labels[best] ?? `cluster ${c + 1}`) : `cluster ${c + 1}`);
  }
  return names;
}

/**
 * A fixed, visually-distinct palette for DISCOVERED clusters (up to 8). These
 * are assigned to k-means cluster ids at render time — they carry no semantic
 * meaning, they just distinguish the groups the model found.
 */
export const CLUSTER_PALETTE: string[] = [
  '#4a9eff', // blue
  '#f5a623', // amber
  '#3ddc84', // green
  '#ff5c7a', // coral
  '#b57cff', // violet
  '#ffd93d', // yellow
  '#5ee0d0', // teal
  '#ff8f5e', // orange
];
