/**
 * reduce.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Dimensionality reduction: projects high-dimensional embeddings (256 or 768
 * numbers per point, per the selected EmbeddingGemma variant) down to 3D points
 * for a Three.js scatter plot.
 *
 * Two strategies, deliberately kept side by side:
 *  - `pca()`      — synchronous, instant, linear (covariance + power
 *                    iteration). Good as an immediate "first paint" layout.
 *  - `umapReduce()` — async, iterative, non-linear (via `umap-js`). Slower
 *                    but usually produces visually tighter, more meaningful
 *                    semantic clusters. See `reduce.worker.ts` for running
 *                    this off the main thread.
 */

import { UMAP, type UMAPParameters } from 'umap-js';
import type { EmbeddingVector, ReducedPoint } from './types';

// ── PCA (synchronous, covariance + power iteration) ────────────────────────

function meanVector(vectors: number[][], dim: number): number[] {
  const sum = new Array<number>(dim).fill(0);
  for (const v of vectors) {
    for (let i = 0; i < dim; i++) {
      sum[i] = (sum[i] ?? 0) + (v[i] ?? 0);
    }
  }
  const n = vectors.length || 1;
  return sum.map((s) => s / n);
}

function centerRows(vectors: number[][], mean: number[]): number[][] {
  return vectors.map((v) => v.map((val, i) => val - (mean[i] ?? 0)));
}

/** Covariance matrix (dim x dim) of already-centered row vectors. */
function covarianceMatrix(centered: number[][], dim: number): number[][] {
  const n = centered.length || 1;
  const cov: number[][] = Array.from({ length: dim }, () => new Array<number>(dim).fill(0));
  for (const row of centered) {
    for (let i = 0; i < dim; i++) {
      const ri = row[i] ?? 0;
      if (ri === 0) continue;
      const covRowI = cov[i];
      if (!covRowI) continue;
      for (let j = i; j < dim; j++) {
        const rj = row[j] ?? 0;
        const contrib = (ri * rj) / n;
        covRowI[j] = (covRowI[j] ?? 0) + contrib;
        if (j !== i) {
          const covRowJ = cov[j];
          if (covRowJ) covRowJ[i] = (covRowJ[i] ?? 0) + contrib;
        }
      }
    }
  }
  return cov;
}

/** mulberry32 — tiny, fast, deterministic PRNG (see umapReduce below for why determinism matters here too). */
function mulberry32(seed: number): () => number {
  let a = seed;
  return function next(): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fixed seed for PCA's power-iteration starting vectors — see `pca()` doc comment. */
const PCA_SEED = 42;

function seededUnitVector(dim: number, seed: number): number[] {
  const rng = mulberry32(seed);
  const v = Array.from({ length: dim }, () => rng() * 2 - 1);
  let normSq = 0;
  for (const x of v) normSq += x * x;
  const norm = Math.sqrt(normSq) || 1;
  return v.map((x) => x / norm);
}

function matVecMul(matrix: number[][], vec: number[], dim: number): number[] {
  const out = new Array<number>(dim).fill(0);
  for (let i = 0; i < dim; i++) {
    const row = matrix[i];
    if (!row) continue;
    let sum = 0;
    for (let j = 0; j < dim; j++) {
      sum += (row[j] ?? 0) * (vec[j] ?? 0);
    }
    out[i] = sum;
  }
  return out;
}

/** Power iteration: converges to the dominant eigenvector of a symmetric matrix. */
function powerIteration(matrix: number[][], dim: number, seed: number, iterations = 100): number[] {
  let vec = seededUnitVector(dim, seed);
  for (let iter = 0; iter < iterations; iter++) {
    const next = matVecMul(matrix, vec, dim);
    let normSq = 0;
    for (const x of next) normSq += x * x;
    const norm = Math.sqrt(normSq);
    if (norm < 1e-12) return vec; // degenerate direction (e.g. rank exhausted) — stop early
    vec = next.map((x) => x / norm);
  }
  return vec;
}

function rayleighQuotient(matrix: number[][], vec: number[], dim: number): number {
  const mv = matVecMul(matrix, vec, dim);
  let num = 0;
  for (let i = 0; i < dim; i++) num += (vec[i] ?? 0) * (mv[i] ?? 0);
  return num;
}

/** Deflates matrix by subtracting `eigenvalue * vec * vec^T`, exposing the next-largest eigenvector to power iteration. */
function deflate(matrix: number[][], vec: number[], eigenvalue: number, dim: number): number[][] {
  return Array.from({ length: dim }, (_, i) => {
    const row = matrix[i] ?? new Array<number>(dim).fill(0);
    const vi = vec[i] ?? 0;
    return row.map((val, j) => val - eigenvalue * vi * (vec[j] ?? 0));
  });
}

/** Finds the top `nComponents` eigenvectors of `cov` via repeated power-iteration + deflation. */
function topComponents(cov: number[][], dim: number, nComponents: number): number[][] {
  let matrix = cov;
  const components: number[][] = [];
  for (let c = 0; c < nComponents; c++) {
    const vec = powerIteration(matrix, dim, PCA_SEED + c);
    components.push(vec);
    const eigenvalue = rayleighQuotient(matrix, vec, dim);
    matrix = deflate(matrix, vec, eigenvalue, dim);
  }
  return components;
}

function projectOnto(centered: number[][], components: number[][], dim: number): number[][] {
  return centered.map((row) =>
    components.map((comp) => {
      let sum = 0;
      for (let i = 0; i < dim; i++) sum += (row[i] ?? 0) * (comp[i] ?? 0);
      return sum;
    })
  );
}

/**
 * Synchronous PCA — reduces `vectors` (each a high-dimensional embedding) to
 * `dims` components (default 3) via covariance-matrix eigendecomposition
 * (power iteration + deflation, no external linear-algebra dependency).
 *
 * PCA finds the directions of maximum VARIANCE in the whole point cloud and
 * projects onto them — a single fast linear transform, unlike UMAP's async
 * iterative optimization (see `umapReduce` below). It preserves global
 * structure (which points are far apart overall) better than local
 * neighborhood structure, which is exactly the tradeoff that makes it a good
 * cheap "first paint" layout while a UMAP layout computes in the background.
 *
 * Deterministic: power iteration's starting vectors are seeded (`PCA_SEED`),
 * never `Math.random()`, so calling this twice on the same input always
 * produces the same output — required for the embedding cache in
 * `corpus.ts` to actually behave like a cache.
 */
export function pca(vectors: EmbeddingVector[], dims: number = 3): ReducedPoint[] {
  if (vectors.length === 0) return [];

  const dim = vectors[0]?.length ?? 0;
  if (dim === 0) return vectors.map(() => ({ x: 0, y: 0, z: 0 }));

  const nComponents = Math.max(1, Math.min(dims, dim, vectors.length));
  const mean = meanVector(vectors, dim);
  const centered = centerRows(vectors, mean);
  const cov = covarianceMatrix(centered, dim);
  const components = topComponents(cov, dim, nComponents);
  const projected = projectOnto(centered, components, dim);

  return projected.map((row) => ({
    x: row[0] ?? 0,
    y: row[1] ?? 0,
    z: row[2] ?? 0,
  }));
}

// ── UMAP (async, via umap-js) ────────────────────────────────────────────────

/** Fixed seed for `umapReduce`'s PRNG — see doc comment below for why this matters. */
const UMAP_SEED = 1337;

export interface UmapOptions {
  nNeighbors?: number;
  minDist?: number;
  nEpochs?: number;
  /** Overrides `UMAP_SEED` — same input + same seed always yields the same layout. */
  seed?: number;
  /** Called after each optimization epoch (for progress UI / worker postMessage). */
  onEpoch?: (epoch: number, totalEpochs: number) => void;
}

/**
 * UMAP dimensionality reduction (via `umap-js`), reducing `vectors` to `dims`
 * components (default 3). Unlike `pca()`'s single linear projection, UMAP
 * builds a fuzzy simplicial set modeling each point's LOCAL neighborhood and
 * then iteratively optimizes a low-dimensional layout to match it —
 * asynchronous and slower, but it typically produces visually tighter,
 * more semantically meaningful clusters for embeddings than PCA does.
 *
 * Seeded with a fixed PRNG (`mulberry32`, seed `UMAP_SEED` by default) passed
 * as `umap-js`'s `random` option, INSTEAD of the library's default
 * `Math.random()`-backed generator. `Math.random()` is not seedable, so two
 * runs on identical input embeddings would produce different (if similarly-
 * shaped) layouts — which would show up as visual jitter every time a
 * cached corpus is reloaded. A fixed seed makes the layout a pure function
 * of its input, which is what makes caching it in `corpus.ts` meaningful
 * (recomputing gives byte-identical points, so the cache is never "stale
 * but different-looking").
 */
export async function umapReduce(
  vectors: EmbeddingVector[],
  dims: number = 3,
  opts: UmapOptions = {}
): Promise<ReducedPoint[]> {
  if (vectors.length === 0) return [];

  if (vectors.length < 3) {
    // umap-js needs at least a couple of neighbors to build a meaningful
    // fuzzy simplicial set; for a 1-2 point input there's no neighborhood
    // structure to learn. Fall back to a trivial deterministic layout
    // instead of feeding umap-js a neighbor count it can't satisfy.
    return vectors.map((_, i) => ({ x: i, y: 0, z: 0 }));
  }

  const nNeighbors = Math.max(2, Math.min(opts.nNeighbors ?? 15, vectors.length - 1));

  const params: UMAPParameters = {
    nComponents: Math.max(1, dims),
    nNeighbors,
    minDist: opts.minDist ?? 0.1,
    random: mulberry32(opts.seed ?? UMAP_SEED),
  };
  if (opts.nEpochs !== undefined) {
    params.nEpochs = opts.nEpochs;
  }

  const umap = new UMAP(params);
  const totalEpochs = params.nEpochs ?? -1;
  const embedding = await umap.fitAsync(vectors, (epoch) => {
    opts.onEpoch?.(epoch, totalEpochs);
  });

  return embedding.map((row) => ({
    x: row[0] ?? 0,
    y: row[1] ?? 0,
    z: row[2] ?? 0,
  }));
}
