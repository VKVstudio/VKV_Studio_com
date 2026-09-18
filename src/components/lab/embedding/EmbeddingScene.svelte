<script lang="ts">
  /**
   * EmbeddingScene.svelte
   * ───────────────────────────────────────────────────────────────────────
   * The 3D (or 2D-fallback) view of the embedded corpus. Pure presentation:
   * receives the already-reduced 3D layout + search state from
   * EmbeddingApp.svelte and never talks to engine.ts/reduce.ts itself.
   *
   * Three.js is dynamically imported inside onMount so it never lands in
   * this route's (or any other route's) initial bundle — only a visitor who
   * actually opens /lab/embeddings/ on a WebGL-capable, >=768px viewport
   * pays for it. Narrower viewports / no-WebGL browsers get a lightweight
   * 2D canvas scatter instead (see `initCanvas2D`) so the view is never
   * just a blank box.
   */
  import { onMount, onDestroy, tick } from 'svelte';
  import { t, type Lang } from '../../../i18n/utils';
  import type { ReducedPoint } from '../../../lib/embedding/types';
  import { CLUSTER_PALETTE } from '../../../lib/embedding/cluster';
  import { mountCanvas2DFallback, type Canvas2DFallback } from './canvas2d-fallback';

  const DEFAULT_POINT_COLOR = '#3d9970';
  /** Base colour = the UNSUPERVISED cluster the model put this point in (see cluster.ts) — never a hand-assigned category. */
  function clusterHex(index: number): string {
    const c = clusterAssignments[index];
    if (c === undefined) return DEFAULT_POINT_COLOR;
    return CLUSTER_PALETTE[c % CLUSTER_PALETTE.length] ?? DEFAULT_POINT_COLOR;
  }

  // ── Type-only aliases for the dynamically-imported three.js module ──────
  // `typeof import('three')` describes the module's runtime shape (class
  // constructors included) without ever emitting a static import — three.js
  // is only actually loaded via the `await import('three')` call below.
  type ThreeModule = typeof import('three');
  type ThreeScene = InstanceType<ThreeModule['Scene']>;
  type ThreeCamera = InstanceType<ThreeModule['PerspectiveCamera']>;
  type ThreeRenderer = InstanceType<ThreeModule['WebGLRenderer']>;
  type ThreePoints = InstanceType<ThreeModule['Points']>;
  type ThreeGeometry = InstanceType<ThreeModule['BufferGeometry']>;
  type ThreeBufferAttribute = InstanceType<ThreeModule['BufferAttribute']>;
  type ThreePointsMaterial = InstanceType<ThreeModule['PointsMaterial']>;
  type ThreeCanvasTexture = InstanceType<ThreeModule['CanvasTexture']>;
  type ThreeRaycaster = InstanceType<ThreeModule['Raycaster']>;
  type ThreeColor = InstanceType<ThreeModule['Color']>;
  type ThreeSprite = InstanceType<ThreeModule['Sprite']>;
  type ThreeSpriteMaterial = InstanceType<ThreeModule['SpriteMaterial']>;
  type OrbitControlsModule = typeof import('three/examples/jsm/controls/OrbitControls.js');
  type OrbitControlsInstance = InstanceType<OrbitControlsModule['OrbitControls']>;

  let {
    points = [],
    labels = [],
    clusterAssignments = [],
    clusterNames = [],
    showClusters = false,
    highlighted = [],
    scores = null,
    lang = 'en',
  }: {
    points: ReducedPoint[];
    labels: string[];
    /** Parallel array to `points` — the UNSUPERVISED cluster id (k-means, see cluster.ts) each point was assigned to; drives its base colour. */
    clusterAssignments?: number[];
    /** One auto-derived name per cluster id (the corpus word nearest that cluster's centroid) — never a hand-assigned category. */
    clusterNames?: string[];
    /** When false (default) the map is a calm single colour; only when the user opts in do we tint by the (often weak) discovered clusters + show cluster labels. */
    showClusters?: boolean;
    highlighted: number[];
    /** Parallel array to `points`/`labels` (cosine similarity to the last query); `null` when no search is active. */
    scores: number[] | null;
    lang?: Lang;
  } = $props();

  let hostEl = $state<HTMLDivElement | undefined>(undefined);

  type ViewMode = 'webgl' | 'canvas2d';

  /**
   * Decided once, synchronously, during component initialization — safe to
   * touch `window`/`document` here (unlike a normally-hydrated island) because
   * this component is only ever mounted via `client:only`, so this script
   * never runs during SSR. Deciding the mode BEFORE the first render (rather
   * than inside `onMount`) matters: `bind:this` needs the template to render
   * the right branch on its very first paint, or `hostEl` would briefly point
   * at a div that's about to be torn down and swapped for the other branch.
   */
  /** Why the view is currently showing the 2D fallback instead of the WebGL scene. */
  type FallbackReason = 'narrow' | 'no-webgl' | 'context-lost' | null;

  /**
   * The single source of truth for "is the viewport wide enough for the 3D
   * view" — deliberately the VIEWPORT (`window`/`matchMedia`), never the
   * scene container's own element width. The scene panel sits in a two-column
   * grid capped by the page's `max-width` (see embeddings.css), so on a wide
   * desktop (1920px, 2600px…) the container itself plateaus around
   * ~710-790px — comfortably UNDER the 768px breakpoint even though the
   * viewport is huge. Using container width here (as a previous version did
   * for the resize re-check) inverted the intent: 3D only ever showed in a
   * narrow window band, never on normal/large desktops. Both the initial
   * decision and every later re-check MUST use this same signal.
   */
  function isViewportWideEnough(): boolean {
    return window.matchMedia('(min-width: 768px)').matches;
  }

  function decideInitialMode(): { mode: ViewMode; reason: FallbackReason } {
    const webglSupported = detectWebGL();
    const wideEnough = isViewportWideEnough();
    if (webglSupported && wideEnough) return { mode: 'webgl', reason: null };
    return { mode: 'canvas2d', reason: webglSupported ? 'narrow' : 'no-webgl' };
  }

  const initialMode = decideInitialMode();
  let mode = $state<ViewMode>(initialMode.mode);
  let fallbackReason = $state<FallbackReason>(initialMode.reason);
  let threeReady = $state(false);
  // Re-entrancy guard: a resize + a context-loss event could both try to
  // switch modes around the same time — this makes sure only one teardown/
  // init cycle runs at once instead of two racing each other.
  let switchingMode = false;

  let hoverIndex = $state<number | null>(null);
  let tooltip = $state<{ visible: boolean; x: number; y: number }>({ visible: false, x: 0, y: 0 });

  // ── Three.js object graph — plain (non-reactive) bookkeeping, mutated
  // imperatively inside onMount/effects/onDestroy, never read by the
  // template directly. ─────────────────────────────────────────────────
  let THREE: ThreeModule | null = null;
  let renderer: ThreeRenderer | null = null;
  let scene: ThreeScene | null = null;
  let camera: ThreeCamera | null = null;
  let controls: OrbitControlsInstance | null = null;
  // Whether the viewer prefers reduced motion — decided in initThree and read
  // by resume logic so ambient auto-rotation never restarts for those users.
  let reducedMotion = false;
  let pointsGeometry: ThreeGeometry | null = null;
  let pointsMaterial: ThreePointsMaterial | null = null;
  // Runtime-generated soft round sprite for the point cloud (no external asset
  // → CSP-safe). Disposed in teardownThree alongside the other GPU resources.
  let pointsTexture: ThreeCanvasTexture | null = null;
  let pointsMesh: ThreePoints | null = null;
  // Position/color GPU buffers for the point cloud — allocated once and
  // reused across searches (see `ensurePointCapacity`/`updateGeometryFromProps`)
  // instead of orphaning a fresh Float32Array + BufferAttribute pair on every
  // keystroke, which would leak already-uploaded GPU memory over a long session.
  let pointsPositionArray: Float32Array | null = null;
  let pointsColorArray: Float32Array | null = null;
  let pointsPositionAttr: ThreeBufferAttribute | null = null;
  let pointsColorAttr: ThreeBufferAttribute | null = null;
  let raycaster: ThreeRaycaster | null = null;
  let rafId = 0;
  let resizeObserver: ResizeObserver | null = null;
  let lastFramedPoints: ReducedPoint[] | null = null; // reference-compared: only refit the camera when the layout array itself changes

  // ── Cluster-centroid labels — ONE larger, bold, tinted sprite per
  // UNSUPERVISED cluster the model actually found (not per point — always-on
  // per-point sprites read as clutter; a single hovered point's word is shown
  // by the existing tooltip instead, see `handlePointerMove`/the template's
  // tooltip block). Rebuilt wholesale (`rebuildClusterLabelSprites`) only
  // when `clusterNames` changes (a fresh k-means run); positions/opacity are
  // cheap per-frame updates in `updateClusterLabelSprites`, since the
  // centroid moves whenever the layout does (PCA → UMAP) even though the
  // text/tint never change. ─────────────────────────────────────────────
  let clusterLabelSprites: ThreeSprite[] = [];
  let clusterLabelMaterials: ThreeSpriteMaterial[] = [];
  let clusterLabelTextures: ThreeCanvasTexture[] = [];
  // Parallel to the three arrays above — which cluster id each sprite/material/
  // texture belongs to, so `updateClusterLabelSprites` knows which centroid to
  // place it at without recomputing text/tint every frame.
  let clusterLabelIds: number[] = [];
  let lastFramedClusterNames: string[] | null = null;

  // Fires precisely when the viewport crosses the 768px breakpoint. Needed
  // IN ADDITION to the ResizeObserver-driven `maybeSwitchMode()` calls above:
  // once the page's max-width grid caps the scene container's size (e.g. at
  // 1920px vs. 2600px viewport width), the container itself may not resize
  // at all even though the viewport did, so ResizeObserver alone could miss
  // the crossing on a container that's already pinned at its cap.
  let viewportQuery: MediaQueryList | null = null;
  function handleViewportChange(): void {
    maybeSwitchMode();
  }

  // 2D fallback bookkeeping — see canvas2d-fallback.ts
  let fallback: Canvas2DFallback | null = null;

  function truncate(text: string, max: number): string {
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
  }

  /**
   * Builds a soft radial-gradient sprite (white core → transparent edge) on an
   * offscreen 2D canvas and wraps it in a CanvasTexture. Used as the point
   * cloud's `map` so each point renders as a round, glowing dot tinted by its
   * per-vertex color — instead of three.js's default hard square — with no
   * external image (keeps the strict CSP intact).
   */
  function makeCircleSprite(three: ThreeModule): ThreeCanvasTexture {
    const size = 64;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      const c = size / 2;
      const g = ctx.createRadialGradient(c, c, 0, c, c, c);
      g.addColorStop(0, 'rgba(255,255,255,1)');
      g.addColorStop(0.35, 'rgba(255,255,255,0.9)');
      g.addColorStop(0.75, 'rgba(255,255,255,0.25)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, size, size);
    }
    const tex = new three.CanvasTexture(canvas);
    tex.needsUpdate = true;
    return tex;
  }

  /**
   * Renders `text` onto a tightly-cropped offscreen canvas (no external font
   * assets, no external image — CSP-safe, same reasoning as `makeCircleSprite`)
   * and wraps it as a `THREE.Sprite`. The canvas is sized to the measured text
   * width so the sprite's own aspect ratio (set via `sprite.scale`) keeps the
   * text legible instead of stretched. Bigger/bolder, tinted by `tintHex`
   * (falls back to a calm off-white if omitted) — used for the one
   * always-on label per DISCOVERED cluster.
   */
  function makeLabelSprite(
    three: ThreeModule,
    text: string,
    tintHex?: string
  ): { texture: ThreeCanvasTexture; sprite: ThreeSprite; material: ThreeSpriteMaterial } {
    const fontPx = 34;
    const fontWeight = 700;
    const font = `${fontWeight} ${fontPx}px "JetBrains Mono", ui-monospace, monospace`;
    const paddingX = 10;

    // Measure first (canvas dimensions aren't set yet, so any canvas works).
    const measure = document.createElement('canvas');
    const measureCtx = measure.getContext('2d');
    let textWidth = fontPx * Math.max(text.length, 1) * 0.6;
    if (measureCtx) {
      measureCtx.font = font;
      textWidth = measureCtx.measureText(text).width;
    }

    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.ceil(textWidth + paddingX * 2));
    canvas.height = Math.ceil(fontPx * 1.6);
    // Resizing the canvas above resets its 2D context state, so `font` must
    // be (re)applied on THIS context, not the measuring one.
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.font = font;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = tintHex ?? '#e6f0ea';
      ctx.fillText(text, paddingX, canvas.height / 2);
    }

    const texture = new three.CanvasTexture(canvas);
    texture.needsUpdate = true;
    const material = new three.SpriteMaterial({
      map: texture,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
    });
    const sprite = new three.Sprite(material);
    const worldHeight = 0.22;
    sprite.scale.set(worldHeight * (canvas.width / canvas.height), worldHeight, 1);
    return { texture, sprite, material };
  }

  /** Removes + disposes every cluster-centroid label sprite (GPU textures/materials included). */
  function disposeClusterLabelSprites(): void {
    for (const sprite of clusterLabelSprites) {
      scene?.remove(sprite);
    }
    for (const material of clusterLabelMaterials) material.dispose();
    for (const texture of clusterLabelTextures) texture.dispose();
    clusterLabelSprites = [];
    clusterLabelMaterials = [];
    clusterLabelTextures = [];
    clusterLabelIds = [];
  }

  /**
   * (Re)builds one label sprite per UNSUPERVISED cluster present in
   * `clusterNames` — text is the corpus word nameClusters() found nearest
   * that cluster's centroid, prefixed with "≈" as a reminder it's an
   * auto-derived read-out, not an author-assigned label. Called once from
   * `initThree` and again whenever `clusterNames` changes (a fresh k-means
   * run — new k, or the corpus/vectors changed).
   */
  function rebuildClusterLabelSprites(): void {
    if (!THREE || !scene) return;
    disposeClusterLabelSprites();
    for (let c = 0; c < clusterNames.length; c++) {
      const name = clusterNames[c];
      if (!name) continue;
      const color = CLUSTER_PALETTE[c % CLUSTER_PALETTE.length] ?? DEFAULT_POINT_COLOR;
      const { texture, sprite, material } = makeLabelSprite(THREE, `≈ ${name}`, color);
      scene.add(sprite);
      clusterLabelSprites.push(sprite);
      clusterLabelMaterials.push(material);
      clusterLabelTextures.push(texture);
      clusterLabelIds.push(c);
    }
  }

  /**
   * Averages the (x, y, z) of every point belonging to each DISCOVERED
   * cluster — recomputed every geometry update (not cached) since the layout
   * itself can change (PCA → UMAP swap), which moves every centroid.
   */
  function computeClusterCentroids(): Map<number, ReducedPoint> {
    const sums = new Map<number, { x: number; y: number; z: number; n: number }>();
    clusterAssignments.forEach((c, i) => {
      const p = points[i];
      if (!p) return;
      const acc = sums.get(c) ?? { x: 0, y: 0, z: 0, n: 0 };
      acc.x += p.x;
      acc.y += p.y;
      acc.z += p.z;
      acc.n += 1;
      sums.set(c, acc);
    });
    const centroids = new Map<number, ReducedPoint>();
    for (const [c, acc] of sums) {
      if (acc.n === 0) continue;
      centroids.set(c, { x: acc.x / acc.n, y: acc.y / acc.n, z: acc.z / acc.n });
    }
    return centroids;
  }

  /**
   * Per-geometry-update pass over the (always-on) cluster labels: repositions
   * each at its cluster's current centroid — offset a touch up so it floats
   * above the cluster rather than sitting on top of a point — and dims the
   * whole set a bit while a search is active, so the highlighted (top-k) hit
   * points read as the thing to look at instead of competing with several
   * bright cluster captions.
   */
  function updateClusterLabelSprites(): void {
    if (clusterLabelSprites.length === 0) return;
    const centroids = computeClusterCentroids();
    // Cluster captions only appear when the user opts into "show the groups";
    // hidden otherwise (and dimmed during a search so the hits lead).
    const opacity = !showClusters ? 0 : scores ? 0.35 : 0.9;
    for (let i = 0; i < clusterLabelSprites.length; i++) {
      const sprite = clusterLabelSprites[i];
      const material = clusterLabelMaterials[i];
      const c = clusterLabelIds[i];
      const centroid = c !== undefined ? centroids.get(c) : undefined;
      if (!sprite || !material || !centroid) {
        if (sprite) sprite.visible = false;
        continue;
      }
      sprite.visible = true;
      sprite.position.set(centroid.x, centroid.y + 0.18, centroid.z);
      material.opacity = opacity;
    }
  }

  /**
   * Pause ambient auto-rotation while the pointer is over the scene, so hovering
   * a point/connection to inspect it holds it still under the cursor instead of
   * letting it drift away. Resumed on pointer-leave (never for reduced-motion
   * users, who had it off to begin with).
   */
  function pauseAutoRotate(): void {
    if (controls) controls.autoRotate = false;
  }
  function resumeAutoRotate(): void {
    if (controls && !reducedMotion) controls.autoRotate = true;
  }

  function detectWebGL(): boolean {
    try {
      const canvas = document.createElement('canvas');
      return Boolean(canvas.getContext('webgl2') || canvas.getContext('webgl'));
    } catch {
      return false;
    }
  }

  /**
   * Bright = closer. Highlighted (top-k) hits stay a warm green whose
   * brightness scales with score; everything else fades toward a cool,
   * desaturated tone scaled by ITS OWN score too, so the whole cloud reads
   * as a continuous similarity gradient, not just a binary hit/miss set.
   * With no active search, every point gets the same calm default color.
   */
  function colorForIndex(index: number, highlightedSet: Set<number>): ThreeColor {
    if (!THREE) throw new Error('[embedding-scene] colorForIndex called before three.js loaded');

    // Active search → the HONEST hero: a clean cosine-similarity gradient.
    // Closest points glow green, everything else dims by its exact score. This
    // ignores clusters entirely — the number (cosine) is the truth.
    if (scores) {
      const score = Math.max(0, Math.min(1, scores[index] ?? 0));
      const isHit = highlightedSet.has(index);
      const hue = isHit ? 150 / 360 : 205 / 360;
      const saturation = Math.min(0.9, 0.3 + score * 0.55);
      const lightness = isHit
        ? Math.min(0.82, 0.34 + score * 0.42)
        : Math.max(0.12, 0.14 + score * 0.34);
      return new THREE.Color().setHSL(hue, saturation, lightness);
    }

    // No search: a calm neutral cloud by default. Only if the user opts into
    // "show the groups the model finds" do we tint by the (often weak, honestly
    // disclosed) k-means cluster.
    return new THREE.Color(showClusters ? clusterHex(index) : DEFAULT_POINT_COLOR);
  }

  function fitCameraToPoints(): void {
    if (!THREE || !camera || !controls || !pointsGeometry?.boundingSphere) return;
    const sphere = pointsGeometry.boundingSphere;
    const radius = Math.max(sphere.radius, 0.5);
    const dir = new THREE.Vector3(1, 0.6, 1).normalize();
    camera.position.copy(sphere.center.clone().add(dir.multiplyScalar(radius * 2.4)));
    controls.target.copy(sphere.center);
    controls.update();
  }

  /**
   * Ensures `pointsPositionArray`/`pointsColorArray` (+ the geometry
   * attributes wrapping them) exist and are sized for `n` points, allocating
   * a fresh pair ONLY when the point count actually changed (or on first
   * call). Otherwise the existing, already-GPU-uploaded arrays are reused —
   * callers mutate them in place and set `.needsUpdate = true` rather than
   * handing the geometry a brand-new `BufferAttribute` every time.
   */
  function ensurePointCapacity(n: number): void {
    if (!THREE || !pointsGeometry) return;
    if (!pointsPositionArray || pointsPositionArray.length !== n * 3) {
      pointsPositionArray = new Float32Array(n * 3);
      pointsPositionAttr = new THREE.BufferAttribute(pointsPositionArray, 3);
      pointsGeometry.setAttribute('position', pointsPositionAttr);
    }
    if (!pointsColorArray || pointsColorArray.length !== n * 3) {
      pointsColorArray = new Float32Array(n * 3);
      pointsColorAttr = new THREE.BufferAttribute(pointsColorArray, 3);
      pointsGeometry.setAttribute('color', pointsColorAttr);
    }
  }

  function updateGeometryFromProps(): void {
    if (!THREE || !pointsGeometry) return;

    const n = points.length;
    ensurePointCapacity(n);
    if (!pointsPositionArray || !pointsColorArray || !pointsPositionAttr || !pointsColorAttr)
      return;

    const highlightedSet = new Set(highlighted);
    for (let i = 0; i < n; i++) {
      const p = points[i];
      pointsPositionArray[i * 3] = p?.x ?? 0;
      pointsPositionArray[i * 3 + 1] = p?.y ?? 0;
      pointsPositionArray[i * 3 + 2] = p?.z ?? 0;
      const color = colorForIndex(i, highlightedSet);
      pointsColorArray[i * 3] = color.r;
      pointsColorArray[i * 3 + 1] = color.g;
      pointsColorArray[i * 3 + 2] = color.b;
    }
    pointsPositionAttr.needsUpdate = true;
    pointsColorAttr.needsUpdate = true;
    pointsGeometry.computeBoundingSphere();

    if (points !== lastFramedPoints) {
      lastFramedPoints = points;
      fitCameraToPoints();
    }

    updateClusterLabelSprites();
  }

  function handleResize(): void {
    if (!hostEl || !renderer || !camera) return;
    const w = hostEl.clientWidth || 1;
    const h = hostEl.clientHeight || 1;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  function handlePointerMove(e: PointerEvent): void {
    if (!THREE || !camera || !raycaster || !pointsMesh || !hostEl) return;
    const rect = hostEl.getBoundingClientRect();
    const mouse = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1
    );
    raycaster.setFromCamera(mouse, camera);
    const hit = raycaster.intersectObject(pointsMesh, false)[0];

    if (!hit || hit.index === undefined) {
      hoverIndex = null;
      tooltip = { ...tooltip, visible: false };
      return;
    }

    hoverIndex = hit.index;
    tooltip = { visible: true, x: e.clientX + 14, y: e.clientY - 12 };
  }

  function handlePointerLeave(): void {
    hoverIndex = null;
    tooltip = { ...tooltip, visible: false };
    resumeAutoRotate();
  }

  /**
   * `webglcontextlost` fires when the GPU/driver yanks the context away
   * (driver crash/reset, too many contexts, OS-level GPU reclaim, etc.).
   * The spec REQUIRES `preventDefault()` here or the browser won't even try
   * to hand the context back later. Left un-handled, the canvas would just
   * freeze on its last rendered frame forever — so instead we drop straight
   * to the always-available 2D fallback rather than leave that frozen frame
   * on screen.
   */
  function handleContextLost(e: Event): void {
    e.preventDefault();
    console.warn('[embedding-scene] WebGL context lost — switching to the 2D fallback.');
    void switchMode('canvas2d', 'context-lost');
  }

  /**
   * Fires if the browser later reinstates a context (rare, but it happens
   * after e.g. a transient driver reset). Since the lost context's own
   * canvas/renderer were already torn down by `handleContextLost`, "recovery"
   * here means a full fresh `initThree()` on a brand-new canvas/context
   * rather than trying to resurrect the dead one — simpler and just as
   * correct, since three.js scene state is cheap to rebuild from `points`/
   * `highlighted`/`scores` props already held by the parent.
   */
  function handleContextRestored(): void {
    console.info('[embedding-scene] WebGL context restored.');
    if (detectWebGL() && isViewportWideEnough()) {
      void switchMode('webgl', null);
    }
  }

  /** Tears down every WebGL/three.js resource — used both by `onDestroy` and by `switchMode` when leaving 'webgl'. */
  function teardownThree(): void {
    cancelAnimationFrame(rafId);
    rafId = 0;
    resizeObserver?.disconnect();
    resizeObserver = null;
    renderer?.domElement.removeEventListener('webglcontextlost', handleContextLost);
    renderer?.domElement.removeEventListener('webglcontextrestored', handleContextRestored);
    controls?.dispose();
    pointsGeometry?.dispose();
    pointsMaterial?.dispose();
    pointsTexture?.dispose();
    disposeClusterLabelSprites();
    renderer?.dispose();
    if (renderer?.domElement.parentElement) {
      renderer.domElement.parentElement.removeChild(renderer.domElement);
    }
    THREE = null;
    renderer = null;
    scene = null;
    camera = null;
    controls = null;
    pointsGeometry = null;
    pointsMaterial = null;
    pointsTexture = null;
    pointsMesh = null;
    pointsPositionArray = null;
    pointsColorArray = null;
    pointsPositionAttr = null;
    pointsColorAttr = null;
    raycaster = null;
    lastFramedPoints = null;
    lastFramedClusterNames = null;
    threeReady = false;
  }

  /** Tears down the 2D fallback canvas — used both by `onDestroy` and by `switchMode` when leaving 'canvas2d'. */
  function teardownCanvas2D(): void {
    resizeObserver?.disconnect();
    resizeObserver = null;
    fallback?.destroy();
    fallback = null;
  }

  async function initThree(): Promise<void> {
    const mod = await import('three');
    const { OrbitControls } = await import('three/examples/jsm/controls/OrbitControls.js');
    if (!hostEl) return; // component was destroyed while the dynamic import was in flight

    THREE = mod;
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(
      55,
      hostEl.clientWidth / (hostEl.clientHeight || 1),
      0.01,
      1000
    );
    camera.position.set(2, 1.4, 2.4);

    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(hostEl.clientWidth, hostEl.clientHeight);
    renderer.domElement.addEventListener('webglcontextlost', handleContextLost, false);
    renderer.domElement.addEventListener('webglcontextrestored', handleContextRestored, false);
    hostEl.appendChild(renderer.domElement);

    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    controls.autoRotate = !reducedMotion;
    controls.autoRotateSpeed = 0.5;

    pointsGeometry = new THREE.BufferGeometry();
    pointsTexture = makeCircleSprite(THREE);
    pointsMaterial = new THREE.PointsMaterial({
      size: 0.11,
      vertexColors: true,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.95,
      map: pointsTexture,
      depthWrite: false,
    });
    pointsMesh = new THREE.Points(pointsGeometry, pointsMaterial);
    scene.add(pointsMesh);

    raycaster = new THREE.Raycaster();
    raycaster.params.Points = { threshold: 0.09 };

    rebuildClusterLabelSprites();
    lastFramedClusterNames = clusterNames;

    updateGeometryFromProps();

    resizeObserver = new ResizeObserver(() => {
      handleResize();
      maybeSwitchMode();
    });
    resizeObserver.observe(hostEl);

    const animate = (): void => {
      rafId = requestAnimationFrame(animate);
      controls?.update();
      if (renderer && scene && camera) renderer.render(scene, camera);
    };
    animate();

    threeReady = true;
  }

  function initCanvas2D(): void {
    if (!hostEl) return;
    fallback = mountCanvas2DFallback(hostEl);
    resizeObserver = new ResizeObserver(() => {
      fallback?.resize();
      fallback?.draw(
        points,
        highlighted,
        scores,
        showClusters ? clusterAssignments : [],
        showClusters ? clusterNames : []
      );
      maybeSwitchMode();
    });
    resizeObserver.observe(hostEl);
    fallback.resize();
    fallback.draw(
      points,
      highlighted,
      scores,
      showClusters ? clusterAssignments : [],
      showClusters ? clusterNames : []
    );
  }

  /**
   * Re-evaluates whether the current VIEWPORT (not container) width still
   * matches the active mode, and switches if not — this is what lets a
   * resize crossing the 768px breakpoint (window resize, sidebar collapse,
   * orientation change, devtools docking, etc.) actually change the view
   * instead of being decided once at mount and frozen forever. A browser
   * that never supported WebGL never gets switched TO 'webgl' regardless of
   * width. Always reads `isViewportWideEnough()` — NEVER the scene
   * container's own (grid-capped) width — so this agrees with
   * `decideInitialMode()` at every width, including wide desktops where the
   * container itself plateaus well under 768px.
   */
  function maybeSwitchMode(): void {
    const webglSupported = detectWebGL();
    const wantsWebgl = webglSupported && isViewportWideEnough();
    if (wantsWebgl && mode !== 'webgl') {
      void switchMode('webgl', null);
    } else if (!wantsWebgl && mode !== 'canvas2d') {
      void switchMode('canvas2d', webglSupported ? 'narrow' : 'no-webgl');
    }
  }

  /**
   * Tears down whichever mode is currently active, flips `mode`/`fallbackReason`,
   * waits a tick for Svelte to swap the `{#if mode === 'webgl'}` template branch
   * (so `hostEl` rebinds to the OTHER branch's div), then initializes the new
   * mode. Used by context-loss recovery and by resize-driven mode switching —
   * never leaves the view on a torn-down, blank canvas in between.
   */
  async function switchMode(newMode: ViewMode, reason: FallbackReason): Promise<void> {
    if (mode === newMode || switchingMode) return;
    switchingMode = true;
    try {
      if (mode === 'webgl') {
        teardownThree();
      } else {
        teardownCanvas2D();
      }
      mode = newMode;
      fallbackReason = reason;
      await tick();
      if (!hostEl) return; // component was destroyed while switching
      if (newMode === 'webgl') {
        await initThree();
      } else {
        initCanvas2D();
      }
    } finally {
      switchingMode = false;
    }
  }

  onMount(() => {
    // `mode`/`fallbackReason` were already decided in `decideInitialMode()`
    // above, before the first render, so the correct branch's div is what
    // `hostEl` is bound to by the time this runs.
    viewportQuery = window.matchMedia('(min-width: 768px)');
    viewportQuery.addEventListener('change', handleViewportChange);
    if (mode === 'webgl') {
      void initThree();
    } else {
      initCanvas2D();
    }
  });

  onDestroy(() => {
    viewportQuery?.removeEventListener('change', handleViewportChange);
    viewportQuery = null;
    if (mode === 'webgl') {
      teardownThree();
    } else {
      teardownCanvas2D();
    }
  });

  // Re-render whenever the reduced-layout swaps (PCA → UMAP) or search state
  // changes. Guarded by `threeReady`/`mode` so this never touches WebGL
  // objects before `initThree()` has actually created them.
  $effect(() => {
    const _points = points;
    const _highlighted = highlighted;
    const _scores = scores;
    const _clusterAssignments = clusterAssignments;
    const _clusterNames = clusterNames;
    // Read `showClusters` so this effect also re-runs when the opt-in toggle
    // flips — the 2D fallback must drop its cluster colours/labels in lockstep
    // with the WebGL path (colorForIndex), not lag a frame behind.
    const _showClusters = showClusters;
    if (mode === 'webgl' && threeReady) {
      if (_clusterNames !== lastFramedClusterNames) {
        lastFramedClusterNames = _clusterNames;
        rebuildClusterLabelSprites();
      }
      updateGeometryFromProps();
    } else if (mode === 'canvas2d') {
      fallback?.draw(
        _points,
        _highlighted,
        _scores,
        _showClusters ? _clusterAssignments : [],
        _showClusters ? _clusterNames : []
      );
    }
  });
</script>

<div class="embedding-scene">
  {#if mode === 'webgl'}
    <div
      class="embedding-scene__canvas-host"
      bind:this={hostEl}
      onpointerenter={pauseAutoRotate}
      onpointermove={handlePointerMove}
      onpointerleave={handlePointerLeave}
      role="img"
      aria-label={t(lang, 'embeddings.viewerHeader')}
    ></div>
    <div class="embedding-scene__hint">{t(lang, 'embeddings.hoverHint')}</div>
  {:else}
    <div class="embedding-scene__fallback">
      <div
        class="embedding-scene__fallback-canvas-host"
        bind:this={hostEl}
        role="img"
        aria-label={t(lang, 'embeddings.viewerHeader')}
      ></div>
      <p class="embedding-scene__fallback-notice">
        {#if fallbackReason === 'no-webgl'}
          {t(lang, 'embeddings.fallbackNoWebglNotice')}
        {:else if fallbackReason === 'context-lost'}
          {t(lang, 'embeddings.fallbackContextLostNotice')}
        {:else}
          {t(lang, 'embeddings.fallback2dNotice')}
        {/if}
      </p>
    </div>
  {/if}
  <p class="embedding-scene__shadow-note">{t(lang, 'embeddings.mapShadowNote')}</p>
</div>

{#if tooltip.visible && hoverIndex !== null}
  <div
    class="embedding-scene__tooltip"
    style="left:{tooltip.x}px; top:{tooltip.y}px;"
    role="tooltip"
  >
    <p>{truncate(labels[hoverIndex] ?? '', 180)}</p>
    {#if scores}
      <span class="embedding-scene__tooltip-score">
        {t(lang, 'embeddings.similarityLabel')}: {(scores[hoverIndex] ?? 0).toFixed(3)}
      </span>
    {/if}
  </div>
{/if}
