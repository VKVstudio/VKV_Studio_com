/**
 * canvas2d-fallback.ts
 * ─────────────────────────────────────────────────────────────────────────
 * The lightweight 2D scatter-plot renderer EmbeddingScene.svelte falls back
 * to on narrow viewports / no-WebGL browsers (see that file's `decideInitialMode`).
 * Pulled out of the component so EmbeddingScene stays focused on the Three.js
 * scene graph — this module owns exactly one `<canvas>` and knows nothing
 * about Svelte, WebGL, or Three.js.
 *
 * When the caller opts into clustering, colours points by the UNSUPERVISED
 * cluster the model discovered (see `cluster.ts`) — never a hand-assigned
 * category; with clustering off (the default) the caller passes empty cluster
 * arrays and every dot stays the neutral base colour, matching the WebGL
 * path's `colorForIndex`. There is no fabricated query marker/connector lines
 * here either: a search only dims/brightens dots by their exact cosine score.
 */
import type { ReducedPoint } from '../../../lib/embedding/types';
import { CLUSTER_PALETTE } from '../../../lib/embedding/cluster';

const DEFAULT_POINT_COLOR = '#3d9970';

export interface Canvas2DFallback {
  /** Re-reads `host`'s current size (call from a ResizeObserver). */
  resize(): void;
  /**
   * Repaints for the given layout/search state. `clusterAssignments` is
   * parallel to `points` (drives each dot's colour); `clusterNames` is one
   * auto-derived name per cluster id, used to label each cluster's centroid.
   */
  draw(
    points: ReducedPoint[],
    highlighted: number[],
    scores: number[] | null,
    clusterAssignments?: number[],
    clusterNames?: string[]
  ): void;
  /** Removes the canvas element from `host`. */
  destroy(): void;
}

/** Creates and appends a `<canvas>` into `host`, returning a small imperative handle to drive it. */
export function mountCanvas2DFallback(host: HTMLDivElement): Canvas2DFallback {
  const canvas = document.createElement('canvas');
  host.appendChild(canvas);
  const ctx = canvas.getContext('2d');

  function resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, host.clientWidth * dpr);
    canvas.height = Math.max(1, host.clientHeight * dpr);
    ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function draw(
    points: ReducedPoint[],
    highlighted: number[],
    scores: number[] | null,
    clusterAssignments: number[] = [],
    clusterNames: string[] = []
  ): void {
    if (!ctx) return;
    const clusterHex = (i: number): string => {
      const c = clusterAssignments[i];
      if (c === undefined) return DEFAULT_POINT_COLOR;
      return CLUSTER_PALETTE[c % CLUSTER_PALETTE.length] ?? DEFAULT_POINT_COLOR;
    };
    const w = host.clientWidth || 1;
    const h = host.clientHeight || 1;
    ctx.clearRect(0, 0, w, h);
    if (points.length === 0) return;

    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const p of points) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    const spanX = maxX - minX || 1;
    const spanY = maxY - minY || 1;
    const pad = 20;
    const highlightedSet = new Set(highlighted);

    const project = (p: ReducedPoint): [number, number] => {
      const nx = (p.x - minX) / spanX;
      const ny = (p.y - minY) / spanY;
      return [pad + nx * (w - pad * 2), pad + (1 - ny) * (h - pad * 2)];
    };

    points.forEach((p, i) => {
      const [cx, cy] = project(p);
      const isHit = highlightedSet.has(i);
      const score = scores ? Math.max(0, Math.min(1, scores[i] ?? 0)) : 0;
      // Cluster colour is the base; a search dims non-hits and keeps hits bright.
      const alpha = !scores ? 0.85 : isHit ? 1 : 0.2 + score * 0.4;
      ctx.globalAlpha = alpha;
      ctx.fillStyle = clusterHex(i);
      ctx.beginPath();
      ctx.arc(cx, cy, isHit ? 5 : 3.5, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.globalAlpha = 1;

    // One small auto-derived name per DISCOVERED cluster, at its 2D centroid
    // (averaged in data space, then projected — same idea as the 3D scene's
    // cluster label sprites).
    if (clusterNames.length > 0) {
      const sums = new Map<number, { x: number; y: number; n: number }>();
      clusterAssignments.forEach((c, i) => {
        const p = points[i];
        if (p === undefined) return;
        const acc = sums.get(c) ?? { x: 0, y: 0, n: 0 };
        acc.x += p.x;
        acc.y += p.y;
        acc.n += 1;
        sums.set(c, acc);
      });
      ctx.font = '11px "JetBrains Mono", ui-monospace, monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.globalAlpha = scores ? 0.4 : 0.85;
      for (const [c, acc] of sums) {
        const name = clusterNames[c];
        if (!name || acc.n === 0) continue;
        const [cx, cy] = project({ x: acc.x / acc.n, y: acc.y / acc.n, z: 0 });
        ctx.fillStyle = CLUSTER_PALETTE[c % CLUSTER_PALETTE.length] ?? DEFAULT_POINT_COLOR;
        ctx.fillText(`≈ ${name}`, cx + 7, cy);
      }
      ctx.globalAlpha = 1;
    }
  }

  function destroy(): void {
    host.removeChild(canvas);
  }

  return { resize, draw, destroy };
}
