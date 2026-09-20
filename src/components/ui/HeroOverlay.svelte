<script lang="ts">
  /**
   * HeroOverlay — Premium interactive hero overlay
   *
   * Features:
   *   1. Neural network canvas (nodes + connections, mouse-reactive)
   *   2. Parallax text layers (cursor tracking)
   *   3. Animated gradient title (follows mouse)
   *   4. Entrance stagger animation (on mount)
   *   5. Magnetic CTA button
   */

  interface Props {
    label: string;
    tagline: string;
    subtitle: string;
    cta: string;
    ctaHref: string;
    /**
     * Optional ghost link under the primary CTA (commercial v2: primary sells,
     * secondary keeps the Lab entrance). Deliberately NOT magnetic — the
     * mousemove handler targets `.hero-overlay__cta` only, and duplicating
     * that logic for a text link would buy nothing.
     */
    ctaSecondary?: string;
    ctaSecondaryHref?: string;
  }

  let { label, tagline, subtitle, cta, ctaHref, ctaSecondary, ctaSecondaryHref }: Props = $props();

  /* ── State ──────────────────────────────────────────── */
  let rawMouseX = $state(0.5); // Raw cursor position
  let rawMouseY = $state(0.5);
  let mouseX = $state(0.5); // Smoothed (lerped) position
  let mouseY = $state(0.5);
  let isVisible = $state(false);
  let isHoveringCta = $state(false);
  let ctaOffsetX = $state(0);
  let ctaOffsetY = $state(0);
  let neuralCanvas: HTMLCanvasElement | undefined = $state();
  let containerEl: HTMLElement | undefined = $state();

  /* ── Growing Plexus: organic node network ────────────── */

  // Smooth noise for organic drift
  function noise2D(x: number, y: number): number {
    const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
    return (n - Math.floor(n)) * 2 - 1;
  }
  function smoothNoise(x: number, y: number): number {
    const ix = Math.floor(x),
      iy = Math.floor(y);
    const fx = x - ix,
      fy = y - iy;
    const sx = fx * fx * (3 - 2 * fx),
      sy = fy * fy * (3 - 2 * fy);
    const a = noise2D(ix, iy),
      b = noise2D(ix + 1, iy);
    const c = noise2D(ix, iy + 1),
      d = noise2D(ix + 1, iy + 1);
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
  }

  interface PlexNode {
    x: number;
    y: number;
    baseX: number;
    baseY: number;
    born: number;
    branch: number;
    parentIdx: number;
    noiseOffX: number;
    noiseOffY: number;
    growProgress: number;
    lineWidth: number;
  }

  const MOUSE_LERP = 0.03;
  const CONNECTION_DIST = 160;
  const SPAWN_INTERVAL = 360;
  const GROW_DURATION = 360;
  const MAX_NODES = 60;
  const DRIFT_SPEED = 0.002;
  const DRIFT_AMP = 8;

  let nodes: PlexNode[] = [];
  let animFrameId: number | null = null;
  // When the user asks for reduced motion, we draw ONE static frame of the neural
  // network instead of running the continuous rAF loop (CSS can't stop rAF).
  let reduceMotion = false;
  // This island never unmounts, so without a visibility gate the loop ran at
  // up to 60fps for the ENTIRE visit — including while the user reads
  // About/Stack/FAQ far below the fold. IntersectionObserver (lifecycle
  // effect) flips this and starts/stops the loop.
  let heroInView = true;
  // Page Visibility: a backgrounded tab throttles rAF rather than stopping it
  // in every engine, and a bfcache restore resumes mid-loop. Written by the
  // visibilitychange listener, read by gate() — plain variables, no $effect
  // reads them, so there is nothing for reactivity to loop on.
  let docVisible = true;
  let frameCount = 0;
  let lastSpawn = [0, 0, 0];
  let lastMouseFork = 0;

  /* ── Frame pacing (same discipline as HeroLangSwitcher) ──────────
     Every rate in animateNeural — SPAWN_INTERVAL, GROW_DURATION, the 0.03
     settle lerp, MOUSE_LERP, DRIFT_SPEED, the tip pulse — was authored as
     "per 60fps frame". The loop no longer paints at 60fps everywhere, so
     each paint receives a `step` = how many 60fps frames it stands for, and
     frameCount plus the two lerps scale by it. Without that the mobile cap
     would halve the growth speed of the plexus, which is a visible change.
     A budget, not a divisor: a 60Hz phone lands on 30fps, a 120Hz one on
     ~40fps, and the plexus grows at the same rate on all of them. */
  const FRAME_MS = 1000 / 60;
  // 0 = uncapped (desktop). 1.5 frames, not 2: a 33.33ms budget compared
  // against rAF ticks landing at 16.67/33.33ms falls on the wrong side of
  // the compare whenever a tick jitters late, and the loop drops to 20fps.
  // 25ms always rejects the 1st tick and always accepts the 2nd.
  let frameBudgetMs = 0;
  let lastFrameTs = 0;
  // Deferred first start (see startLoop). Two handle kinds: Safari has no
  // requestIdleCallback, and stopLoop must cancel whichever was scheduled.
  let idleHandle: number | null = null;
  let idleIsTimeout = false;
  let hasRunOnce = false;
  // The 2D context, fetched once in the setup effect. The old loop called
  // getContext('2d') on every frame; it returns the same object each time,
  // but it is a call into the canvas bindings per frame for nothing.
  let ctx: CanvasRenderingContext2D | null = null;

  function initNetwork(width: number, height: number): void {
    frameCount = 0;
    nodes = [];
    lastMouseFork = 0;

    const cx = width / 2;
    const cy = height / 2;
    const base = Math.random() * Math.PI * 2;

    for (let i = 0; i < 3; i++) {
      const angle = base + (i / 3) * Math.PI * 2 + (Math.random() - 0.5) * 0.4;
      const seedDist = 15 + Math.random() * 10;
      const seedBorn = i * 360;
      const seedIdx = nodes.length;

      // Seed node
      nodes.push({
        x: cx,
        y: cy,
        baseX: cx + Math.cos(angle) * seedDist,
        baseY: cy + Math.sin(angle) * seedDist,
        born: seedBorn,
        branch: i,
        parentIdx: -1,
        noiseOffX: Math.random() * 1000,
        noiseOffY: Math.random() * 1000,
        growProgress: 1,
        lineWidth: 3 + Math.random() * 0.5,
      });

      // First child — immediate
      const childDist = 70 + Math.random() * 60;
      const childAngle = angle + (Math.random() - 0.5) * 0.6;
      nodes.push({
        x: cx,
        y: cy,
        baseX: cx + Math.cos(childAngle) * childDist,
        baseY: cy + Math.sin(childAngle) * childDist,
        born: seedBorn + 30,
        branch: i,
        parentIdx: seedIdx,
        noiseOffX: Math.random() * 1000,
        noiseOffY: Math.random() * 1000,
        growProgress: 0,
        lineWidth: 2.8 + Math.random() * 0.4,
      });

      lastSpawn[i] = seedBorn + 30;
    }
  }

  /** Find which branch has ANY node closest to point (for draw brightness) */
  function findClosestBranch(px: number, py: number): number {
    let best = 0,
      bestD = Infinity;
    for (const n of nodes) {
      if (frameCount < n.born) continue;
      const d = (n.x - px) ** 2 + (n.y - py) ** 2;
      if (d < bestD) {
        bestD = d;
        best = n.branch;
      }
    }
    return best;
  }

  function spawnNode(parentIdx: number, vw: number, vh: number): void {
    const parent = nodes[parentIdx];
    const branch = parent.branch;
    const branchNodes = nodes.filter((n) => n.branch === branch);
    if (branchNodes.length >= Math.floor(MAX_NODES / 3)) return;

    // ALL regular spawns: organic direction, NO mouse influence
    const prevAngle =
      parent.parentIdx >= 0
        ? Math.atan2(
            parent.baseY - nodes[parent.parentIdx].baseY,
            parent.baseX - nodes[parent.parentIdx].baseX
          )
        : Math.atan2(parent.baseY - vh / 2, parent.baseX - vw / 2);
    const angle = prevAngle + (Math.random() - 0.5) * 1.4;

    const dist = 70 + Math.random() * 70;
    const margin = 50;
    const depth = branchNodes.length;
    const lw = Math.max(1.5, 3.5 - depth * 0.35 + (Math.random() - 0.5) * 0.5);

    nodes.push({
      x: parent.x,
      y: parent.y,
      baseX: Math.max(margin, Math.min(vw - margin, parent.baseX + Math.cos(angle) * dist)),
      baseY: Math.max(margin, Math.min(vh - margin, parent.baseY + Math.sin(angle) * dist)),
      born: frameCount,
      branch,
      parentIdx,
      noiseOffX: Math.random() * 1000,
      noiseOffY: Math.random() * 1000,
      growProgress: 0,
      lineWidth: lw,
    });

    // 45% fork
    if (Math.random() < 0.45 && depth < Math.floor(MAX_NODES / 3) - 1) {
      const fa = angle + (Math.random() > 0.5 ? 1 : -1) * (0.4 + Math.random() * 0.5);
      const fd = 50 + Math.random() * 60;
      nodes.push({
        x: parent.x,
        y: parent.y,
        baseX: Math.max(margin, Math.min(vw - margin, parent.baseX + Math.cos(fa) * fd)),
        baseY: Math.max(margin, Math.min(vh - margin, parent.baseY + Math.sin(fa) * fd)),
        born: frameCount + 90,
        branch,
        parentIdx,
        noiseOffX: Math.random() * 1000,
        noiseOffY: Math.random() * 1000,
        growProgress: 0,
        lineWidth: Math.max(1.5, lw - 0.4),
      });
    }
  }

  /** One paint. `step` = how many 60fps frames this paint stands for. */
  function animateNeural(step: number): void {
    if (!neuralCanvas || !ctx) return;

    // Lerps scaled by step so a 30fps paint moves as far as two 60fps ones.
    mouseX += (rawMouseX - mouseX) * Math.min(1, MOUSE_LERP * step);
    mouseY += (rawMouseY - mouseY) * Math.min(1, MOUSE_LERP * step);

    const w = neuralCanvas.width;
    const h = neuralCanvas.height;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const vw = w / dpr;
    const vh = h / dpr;
    const mx = mouseX * vw;
    const my = mouseY * vh;

    ctx.clearRect(0, 0, w, h);
    frameCount += step;

    // === 1) SPAWN — new nodes when ready (no mouse) ===
    for (let b = 0; b < 3; b++) {
      if (frameCount - lastSpawn[b] >= SPAWN_INTERVAL) {
        const bNodes = nodes.filter((n) => n.branch === b && frameCount >= n.born);
        if (bNodes.length > 0 && bNodes[bNodes.length - 1].growProgress >= 0.9) {
          spawnNode(nodes.indexOf(bNodes[bNodes.length - 1]), vw, vh);
          lastSpawn[b] = frameCount;
        }
      }
    }

    // === 2) UPDATE POSITIONS ===
    for (const node of nodes) {
      if (frameCount < node.born) continue;
      const age = frameCount - node.born;

      if (node.growProgress < 1) {
        // Growing: fly straight to baseX/baseY
        node.growProgress = Math.min(1, age / GROW_DURATION);
        const eased = 1 - (1 - node.growProgress) ** 3;

        if (node.parentIdx >= 0) {
          const p = nodes[node.parentIdx];
          node.x = p.x + (node.baseX - p.x) * eased;
          node.y = p.y + (node.baseY - p.y) * eased;
        } else {
          node.x = vw / 2 + (node.baseX - vw / 2) * eased;
          node.y = vh / 2 + (node.baseY - vh / 2) * eased;
        }
      } else {
        // Settled: organic noise drift
        const t = frameCount * DRIFT_SPEED;
        const dx = smoothNoise(t + node.noiseOffX, node.noiseOffY) * DRIFT_AMP;
        const dy = smoothNoise(node.noiseOffX, t + node.noiseOffY) * DRIFT_AMP;
        const settle = Math.min(1, 0.03 * step);
        node.x += (node.baseX + dx - node.x) * settle;
        node.y += (node.baseY + dy - node.y) * settle;
      }
    }

    // === 3) REACTIVE FORK — one branch toward mouse per GROW_DURATION ===
    if (nodes.length < MAX_NODES && frameCount - lastMouseFork > GROW_DURATION) {
      // Check: is any node already growing toward mouse? If so, skip.
      let alreadyGrowing = false;
      for (const n of nodes) {
        if (n.growProgress >= 1 || n.growProgress <= 0 || n.parentIdx < 0) continue;
        const dToMouse = Math.sqrt((n.baseX - mx) ** 2 + (n.baseY - my) ** 2);
        if (dToMouse < 200) {
          alreadyGrowing = true;
          break;
        }
      }

      if (!alreadyGrowing) {
        let nearestNode: PlexNode | null = null;
        let nearestDist = 400;
        let nearestIdx = -1;
        for (let i = 0; i < nodes.length; i++) {
          const n = nodes[i];
          if (frameCount < n.born || n.growProgress < 0.8) continue;
          const childCount = nodes.filter((c) => c.parentIdx === i).length;
          if (childCount >= 3) continue;
          const d = Math.sqrt((n.x - mx) ** 2 + (n.y - my) ** 2);
          if (d < nearestDist) {
            nearestDist = d;
            nearestNode = n;
            nearestIdx = i;
          }
        }
        if (nearestNode) {
          const angle =
            Math.atan2(my - nearestNode.y, mx - nearestNode.x) + (Math.random() - 0.5) * 0.3;
          const dist = 60 + Math.random() * 60;
          const margin = 50;
          const depth = nodes.filter((n) => n.branch === nearestNode!.branch).length;
          const lw = Math.max(1.5, 3.5 - depth * 0.35 + (Math.random() - 0.5) * 0.5);
          nodes.push({
            x: nearestNode.x,
            y: nearestNode.y,
            baseX: Math.max(
              margin,
              Math.min(vw - margin, nearestNode.baseX + Math.cos(angle) * dist)
            ),
            baseY: Math.max(
              margin,
              Math.min(vh - margin, nearestNode.baseY + Math.sin(angle) * dist)
            ),
            born: frameCount,
            branch: nearestNode.branch,
            parentIdx: nearestIdx,
            noiseOffX: Math.random() * 1000,
            noiseOffY: Math.random() * 1000,
            growProgress: 0,
            lineWidth: lw,
          });
          lastMouseFork = frameCount;
        }
      }
    }

    // === DRAW ===
    const closestBranch = findClosestBranch(mx, my);

    // 1) Primary: parent→child branch lines (animated growth)
    for (const node of nodes) {
      if (frameCount < node.born || node.parentIdx < 0) continue;
      const parent = nodes[node.parentIdx];
      if (!parent || frameCount < parent.born) continue;

      const xFrac = node.x / vw;
      const hue = 220 + (155 - 220) * xFrac;
      const isNear = node.branch === closestBranch;

      const midX = (parent.x + node.x) / 2;
      const midY = (parent.y + node.y) / 2;
      const mDist = Math.sqrt((mx - midX) ** 2 + (my - midY) ** 2);
      const glow = mDist < 200 ? (1 - mDist / 200) * 0.25 : 0;
      const alpha = (isNear ? 0.28 : 0.18) + glow;

      ctx.beginPath();
      ctx.moveTo(parent.x, parent.y);
      ctx.lineTo(node.x, node.y);
      ctx.strokeStyle = `hsla(${hue}, 65%, 55%, ${alpha})`;
      ctx.lineWidth = node.lineWidth * (isNear ? 1.1 : 1);
      ctx.lineCap = 'round';
      ctx.stroke();
    }

    // 2) Cross-branch connections (medium thickness)
    for (let i = 0; i < nodes.length; i++) {
      if (frameCount < nodes[i].born || nodes[i].growProgress < 0.8) continue;
      for (let j = i + 1; j < nodes.length; j++) {
        if (frameCount < nodes[j].born || nodes[j].growProgress < 0.8) continue;
        if (nodes[j].parentIdx === i || nodes[i].parentIdx === j) continue;

        const dx = nodes[i].x - nodes[j].x;
        const dy = nodes[i].y - nodes[j].y;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist < CONNECTION_DIST) {
          const proximity = 1 - dist / CONNECTION_DIST;
          const midX = (nodes[i].x + nodes[j].x) / 2;
          const mDist = Math.sqrt((mx - midX) ** 2 + (my - (nodes[i].y + nodes[j].y) / 2) ** 2);
          const glow = mDist < 180 ? (1 - mDist / 180) * 0.15 : 0;
          const xFrac = midX / vw;
          const hue = 220 + (155 - 220) * xFrac;

          ctx.beginPath();
          ctx.moveTo(nodes[i].x, nodes[i].y);
          ctx.lineTo(nodes[j].x, nodes[j].y);
          ctx.strokeStyle = `hsla(${hue}, 65%, 55%, ${proximity * 0.1 + glow})`;
          ctx.lineWidth = 1.5 + proximity * 0.5;
          ctx.lineCap = 'round';
          ctx.stroke();
        }
      }
    }

    // 3) Nodes
    for (const node of nodes) {
      if (frameCount < node.born) continue;
      const isNear = node.branch === closestBranch;
      const xFrac = node.x / vw;
      const hue = 220 + (155 - 220) * xFrac;
      const mDist = Math.sqrt((mx - node.x) ** 2 + (my - node.y) ** 2);
      const glow = mDist < 150 ? (1 - mDist / 150) * 0.4 : 0;

      // Glow halo near mouse
      if (glow > 0.05) {
        ctx.beginPath();
        ctx.arc(node.x, node.y, 10, 0, Math.PI * 2);
        ctx.fillStyle = `hsla(${hue}, 65%, 55%, ${glow * 0.1})`;
        ctx.fill();
      }

      // Core dot
      const r = (isNear ? 3 : 2.2) * node.growProgress;
      ctx.beginPath();
      ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
      ctx.fillStyle = `hsla(${hue}, 65%, ${55 + glow * 20}%, ${(isNear ? 0.4 : 0.25) + glow * 0.3})`;
      ctx.fill();

      // Growing tip pulse
      if (node.growProgress < 1 && node.growProgress > 0.1) {
        const pulse = Math.sin(frameCount * 0.08) * 0.12 + 0.15;
        ctx.beginPath();
        ctx.arc(node.x, node.y, 7, 0, Math.PI * 2);
        ctx.fillStyle = `hsla(${hue}, 70%, 60%, ${pulse * node.growProgress})`;
        ctx.fill();
      }
    }
  }

  /* ── Loop control ───────────────────────────────────── */
  function tick(ts: number): void {
    animFrameId = requestAnimationFrame(tick);
    if (lastFrameTs === 0) {
      lastFrameTs = ts;
      animateNeural(1);
      return;
    }
    const elapsed = ts - lastFrameTs;
    if (frameBudgetMs > 0 && elapsed < frameBudgetMs) return;
    lastFrameTs = ts;
    // Clamp: a long task, or a tab the visibility gate caught a beat late,
    // must not teleport every node three seconds ahead on resume.
    animateNeural(Math.min(elapsed / FRAME_MS, 3));
  }

  function startLoop(): void {
    if (reduceMotion) {
      // One static paint, no perpetual loop — CSS cannot stop rAF, so this
      // is where prefers-reduced-motion is honoured for the canvas.
      animateNeural(1);
      return;
    }
    if (animFrameId !== null || idleHandle !== null) return;
    lastFrameTs = 0;

    if (hasRunOnce) {
      // A re-entry (scrolled back to the hero, tab refocused) resumes at
      // once — an idle deferral here would freeze the plexus in full view.
      animFrameId = requestAnimationFrame(tick);
      return;
    }
    hasRunOnce = true;

    // Paint ONE frame now so the canvas is never blank while its 1.5s CSS
    // fade-in runs, then hand the perpetual loop to the idle queue AFTER the
    // load event. This island hydrates inside the LCP window and the plexus
    // is decorative; its per-frame work (60 nodes, O(n²) cross-links) was
    // competing with hero paint and the load for the main thread.
    // Lighthouse mobile, bootup-time for the HeroOverlay chunk, two builds
    // off one source snapshot, 2026-09-21, three runs each, twice:
    //   batch 1 (quiet box)          before 1658 / 1553 / 1454 ms
    //                                after      0 /   50 /  826 ms
    //   batch 2 (interleaved, box    before 1334 / 1770 / 1461 ms
    //   shared with a GPU render)    after   1123 /   83 /   57 ms
    // Medians 1553 -> 50 and 1461 -> 83. The spread on the "after" side is
    // whether the idle callback fired inside the trace window at all.
    animateNeural(1);

    const begin = (): void => {
      idleHandle = null;
      if (animFrameId === null && heroInView && docVisible) {
        animFrameId = requestAnimationFrame(tick);
      }
    };
    const schedule = (): void => {
      if (typeof requestIdleCallback === 'function') {
        idleIsTimeout = false;
        idleHandle = requestIdleCallback(begin, { timeout: 1500 });
      } else {
        // Safari: rIC is Baseline "Limited". Plain timeout, same intent.
        idleIsTimeout = true;
        idleHandle = window.setTimeout(begin, 600);
      }
    };
    if (document.readyState === 'complete') {
      schedule();
    } else {
      // Marker handle so a stopLoop() before `load` cancels the pending start
      // instead of letting the listener resurrect the loop off-screen.
      idleIsTimeout = true;
      idleHandle = window.setTimeout(() => {}, 0);
      window.addEventListener(
        'load',
        () => {
          if (idleHandle === null) return; // stopLoop() ran first
          idleHandle = null;
          schedule();
        },
        { once: true }
      );
    }
  }

  function stopLoop(): void {
    if (animFrameId !== null) {
      cancelAnimationFrame(animFrameId);
      animFrameId = null;
    }
    if (idleHandle !== null) {
      if (idleIsTimeout) clearTimeout(idleHandle);
      else cancelIdleCallback(idleHandle);
      idleHandle = null;
    }
    lastFrameTs = 0;
  }

  /** The loop runs only while the hero is on screen AND the tab is visible. */
  function gate(): void {
    if (heroInView && docVisible) startLoop();
    else stopLoop();
  }

  /* ── Mouse tracking ─────────────────────────────────── */
  function onMouseMove(e: MouseEvent): void {
    if (!containerEl) return;
    const rect = containerEl.getBoundingClientRect();
    rawMouseX = (e.clientX - rect.left) / rect.width;
    rawMouseY = (e.clientY - rect.top) / rect.height;

    // Magnetic CTA
    if (isHoveringCta) {
      const ctaEl = containerEl.querySelector('.hero-overlay__cta') as HTMLElement;
      if (ctaEl) {
        const ctaRect = ctaEl.getBoundingClientRect();
        const cx = e.clientX - ctaRect.left - ctaRect.width / 2;
        const cy = e.clientY - ctaRect.top - ctaRect.height / 2;
        ctaOffsetX = cx * 0.25;
        ctaOffsetY = cy * 0.25;
      }
    }
  }

  function onCtaEnter(): void {
    isHoveringCta = true;
  }
  function onCtaLeave(): void {
    isHoveringCta = false;
    ctaOffsetX = 0;
    ctaOffsetY = 0;
  }

  /* ── Lifecycle ──────────────────────────────────────── */
  $effect(() => {
    if (!neuralCanvas || !containerEl) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = containerEl.getBoundingClientRect();
    neuralCanvas.width = rect.width * dpr;
    neuralCanvas.height = rect.height * dpr;
    neuralCanvas.style.width = `${rect.width}px`;
    neuralCanvas.style.height = `${rect.height}px`;

    ctx = neuralCanvas.getContext('2d', { alpha: true });
    if (ctx) ctx.scale(dpr, dpr);

    reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    // 30fps on mobile. Same two-clause query as HeroCanvas's hero--static
    // gate and HeroLangSwitcher's budget — keep them in lockstep. The
    // measured effect of the budget + the deferred start together is in
    // the startLoop comment.
    frameBudgetMs = window.matchMedia(
      '(max-width: 767px), ((max-height: 767px) and (pointer: coarse))'
    ).matches
      ? FRAME_MS * 1.5
      : 0;
    initNetwork(rect.width, rect.height);
    docVisible = document.visibilityState === 'visible';
    // Start outside any reactive read: animateNeural writes mouseX/mouseY
    // ($state) and this effect must never track them. gate() → startLoop()
    // paints one frame now and defers the loop to idle time after `load`.
    gate();

    // Visibility gate for the loop (see heroInView above). Observing the
    // container works on both branches: mobile's .hero--static is one 100svh
    // screen, and on desktop this element leaves the viewport when the 800vh
    // scrub is over — either way, below the fold the plexus stops burning CPU.
    const visObserver = new IntersectionObserver((entries) => {
      const last = entries[entries.length - 1];
      if (!last) return;
      heroInView = last.isIntersecting;
      gate();
    });
    visObserver.observe(containerEl);

    const onVisibility = (): void => {
      docVisible = document.visibilityState === 'visible';
      gate();
    };
    document.addEventListener('visibilitychange', onVisibility);

    // Entrance animation
    setTimeout(() => {
      isVisible = true;
    }, 100);

    // Resize handler
    const onResize = () => {
      const r = containerEl!.getBoundingClientRect();
      neuralCanvas!.width = r.width * dpr;
      neuralCanvas!.height = r.height * dpr;
      neuralCanvas!.style.width = `${r.width}px`;
      neuralCanvas!.style.height = `${r.height}px`;
      // Assigning width/height reset the context's transform (spec) — same
      // context object, so re-apply the dpr scale on the cached one.
      if (ctx) ctx.scale(dpr, dpr);
      initNetwork(r.width, r.height);
      // Resizing cleared the bitmap; under reduced motion no loop repaints it.
      // Guarded: with the loop running, tick() repaints within a frame.
      if (reduceMotion) animateNeural(1);
    };
    window.addEventListener('resize', onResize);

    return () => {
      stopLoop();
      visObserver.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('resize', onResize);
    };
  });

  /* ── Derived transforms ─────────────────────────────── */
  let parallax1 = $derived(`translate(${(mouseX - 0.5) * -3}px, ${(mouseY - 0.5) * -2}px)`);
  let parallax2 = $derived(`translate(${(mouseX - 0.5) * -5}px, ${(mouseY - 0.5) * -4}px)`);
  let parallax3 = $derived(`translate(${(mouseX - 0.5) * -3}px, ${(mouseY - 0.5) * -2}px)`);
  let parallax4 = $derived(
    `translate(${(mouseX - 0.5) * -4}px, ${(mouseY - 0.5) * -3}px) translate(${ctaOffsetX}px, ${ctaOffsetY}px)`
  );
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="hero-overlay"
  class:is-visible={isVisible}
  bind:this={containerEl}
  onmousemove={onMouseMove}
>
  <!-- Neural network canvas -->
  <canvas bind:this={neuralCanvas} class="hero-overlay__neural" aria-hidden="true"></canvas>

  <!-- Text layers with parallax -->
  <div class="hero-overlay__content">
    <!-- data-label feeds the two glow twins (::before / ::after in the CSS):
         the same nine characters, colour transparent, carrying the resting
         and the peak text-shadow. See .hero-overlay__label::before. -->
    <p class="hero-overlay__label" data-label={label} style:transform={parallax1}>
      {label}
    </p>

    <!-- Per-letter spans, carrying the hover effect. They are safe as long as
         nothing applied to them creates a new rendering surface \u2014 the
         .hero-letter rule below lists exactly which properties are forbidden
         and why the doubled glyph happened.
         aria-label on the h1 plus aria-hidden on each span keeps a screen
         reader announcing the line as a line, not as a column of letters. -->
    <h1
      class="hero-overlay__title"
      style:transform={parallax2}
      aria-label={tagline.replace(/\|/g, ' ')}
    >
      {#each tagline.split('|') as line, lineIdx}
        {#if lineIdx > 0}<br aria-hidden="true" />{/if}
        {#each line.split('') as char}
          <span class="hero-letter" aria-hidden="true">{char === ' ' ? '\u00a0' : char}</span>
        {/each}
      {/each}
    </h1>

    <p class="hero-overlay__subtitle" style:transform={parallax3}>
      {subtitle}
    </p>

    <a
      href={ctaHref}
      class="hero-overlay__cta"
      class:is-magnetic={isHoveringCta}
      style:transform={parallax4}
      onmouseenter={onCtaEnter}
      onmouseleave={onCtaLeave}
    >
      {cta}
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d="M5 12h14" /><path d="m12 5 7 7-7 7" />
      </svg>
    </a>

    {#if ctaSecondary && ctaSecondaryHref}
      <a href={ctaSecondaryHref} class="hero-overlay__cta-ghost" style:transform={parallax3}>
        {ctaSecondary}
      </a>
    {/if}
  </div>
</div>

<style>
  .hero-overlay {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 3;
    pointer-events: none;
  }

  /* ── Neural canvas ─────────────────────────────────── */
  .hero-overlay__neural {
    position: absolute;
    inset: 0;
    pointer-events: none;
    opacity: 0;
    transition: opacity 1.5s ease-out;
  }

  .hero-overlay.is-visible .hero-overlay__neural {
    opacity: 1;
  }

  /* ── Content ───────────────────────────────────────── */
  .hero-overlay__content {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    gap: var(--space-4);
    pointer-events: auto;
    padding-inline: var(--container-padding);
    max-width: 900px;
  }

  /* ── Label ─────────────────────────────────────────── */
  .hero-overlay__label {
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    letter-spacing: var(--tracking-widest);
    text-transform: uppercase;
    color: hsl(155, 85%, 65%);
    padding: var(--space-1) var(--space-4);
    background: hsla(220, 25%, 6%, 0.9);
    border: 1px solid hsla(155, 50%, 40%, 0.2);
    border-radius: var(--radius-full);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    transition:
      color 0.4s ease-out,
      border-color 0.4s ease-out,
      background 0.4s ease-out;
    cursor: default;
    /* The two glow twins (::before / ::after, below) are absolutely
       positioned over this text, so the pill is their positioning root.
       backdrop-filter already makes it a stacking context; `isolation`
       states the intent: z-index:-1 children paint ABOVE the pill background
       and BELOW this element's real, coloured inline text (CSS 2.1 App. E,
       steps 1 → 2 → 5). That order holds here because the label's glyphs are
       ordinary text — NOT the case for a background-clip: text element,
       whose glyphs are its background and paint in step 1, before any
       negative-z child. That is why the subtitle carries no halo any more. */
    position: relative;
    isolation: isolate;
    /* Entrance driven by a CSS keyframe (animation-fill-mode: backwards),
       not the JS-toggled `.is-visible` class — the label paints + animates
       in on its own as soon as CSS is parsed, so it never waits on Svelte
       hydration.

       THE CASCADE (label → headline → line → CTA, the «резонанс-проход»)
       and the LCP floors, read together with the title and subtitle rules:
         label     0.00s  from opacity 0.2   0.8s ease-out
         headline  0.20s  from opacity 0.2   1.0s ease-out (transform 1.2s)
         subtitle  0.50s  from opacity 0.1   0.8s ease-out
         CTA       0.80s  from opacity 0     0.8s ease-out
         ghost     0.95s  from opacity 0     0.8s ease-out
       Every element starts at its floor and brightens in that order. With
       one easing curve, floors that never increase down the list, and delays
       that never decrease, the painted opacity keeps the order
       label >= headline >= subtitle >= CTA at EVERY instant (the difference
       between two neighbours is at least (floor_a − floor_b)·(1 − ease_b),
       never negative) — so the label always leads, and the line can never
       be brighter than the headline it sits under. Verified on the built
       page with every animation paused and stepped through 0–2.5 s
       (tests/unit/hero-overlay-lcp.test.ts locks the floors and delays).
       The beats are the original ones, 0.2/0.3/0.3/0.15 s apart; only the
       0.2 s of emptiness before the first beat is gone, because with floors
       there is no empty frame to wait through.

       `label-breathe` used to be the second animation here. It animated
       text-shadow — a paint property — so every one of its frames repainted
       the text on the main thread and Lighthouse's non-composited-animations
       audit named this element. The breathing now happens on the twins. */
    animation: hero-fade-up-20 0.8s ease-out 0s backwards;
  }

  /* The breathing, moved off the real text onto two invisible copies of it.
     The old keyframes interpolated the pill's text-shadow between the
     resting `0 0 12px accent-glow` and the peak `0 0 20px accent-glow-strong,
     0 0 40px accent-glow`. text-shadow is a paint property: every frame
     repainted the text. Here the real text carries NO shadow; ::before holds
     the resting shadow and ::after the peak shadow, each on a transparent
     copy of the same nine characters (content: attr(data-label)) sitting
     exactly over the real glyphs — same font, size, tracking, padding — and
     the two cross-fade on OPACITY only, which the compositor handles without
     touching the text. Both endpoints match the old ones exactly: at rest
     ::before is at 1 and ::after at 0 (= 12px glow); at the peak ::before is
     at 0 and ::after at 1 (= 20px strong + 40px glow). Between them the old
     code interpolated blur radii; this cross-fades two fixed radii — same
     colours, same 40px reach, glyph-hugging like the shadow it replaces
     (the wave-1 elliptical box was a 30%-alpha cloud filling the pill).
     A nine-character twin is text to Chrome's paint-timing detector, but
     its paint area (the pill measures 135×32 px at 1280 wide) is a fraction
     of the headline's or the line's, so it cannot become the LCP candidate:
     across 3 mobile + 3 desktop Lighthouse runs of the built page
     (2026-09-21) the LCP element was the subtitle on mobile and the
     headline on desktop, and the non-composited-animations audit listed
     nothing (the baseline listed the label and the subtitle).
     `content: attr() / ''` is the alt-text form: assistive tech reads the
     label once, not three times (Chrome 77+, Safari 17.4+, Firefox 128+;
     older engines fall back to the plain form and may announce the copy). */
  .hero-overlay__label::before,
  .hero-overlay__label::after {
    content: attr(data-label);
    content: attr(data-label) / '';
    position: absolute;
    inset: 0;
    padding: inherit;
    z-index: -1;
    pointer-events: none;
    color: transparent;
    white-space: nowrap;
    will-change: opacity;
  }

  .hero-overlay__label::before {
    text-shadow: 0 0 12px var(--accent-glow);
    opacity: 1;
    animation: hero-halo-rest 4s ease-in-out 1.5s infinite;
  }

  .hero-overlay__label::after {
    text-shadow:
      0 0 20px var(--accent-glow-strong),
      0 0 40px var(--accent-glow);
    opacity: 0;
    animation: hero-halo-breathe 4s ease-in-out 1.5s infinite;
  }

  /* `from` opacity is an LCP floor — see .hero-overlay__subtitle. */
  @keyframes hero-fade-up-20 {
    from {
      opacity: 0.2;
      transform: translateY(20px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  /* The pair that cross-fades the two twins: rest fades out as peak fades in. */
  @keyframes hero-halo-breathe {
    0%,
    100% {
      opacity: 0;
    }
    50% {
      opacity: 1;
    }
  }

  @keyframes hero-halo-rest {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0;
    }
  }

  /* Hover recolours the pill blue. The old rule also set a blue 12px
     text-shadow here, but the breathing animation animated the same
     property on the same element and an animation outranks a normal rule,
     so that shadow never showed while the page was not reduced-motion. The
     twins keep breathing green underneath; this rule only does what it
     visibly did before. */
  .hero-overlay__label:hover {
    color: hsl(220, 70%, 65%);
    border-color: hsla(220, 50%, 50%, 0.25);
  }

  /* ── Title — Neural connections texture ─────────────── */
  .hero-overlay__title {
    font-size: var(--text-display);
    font-weight: var(--weight-bold);
    letter-spacing: -0.03em;
    line-height: 1.05;
    margin: 0;
    /* Solid fallback for the clipped texture below. With text-fill-color
       transparent this never shows; it is what an engine WITHOUT
       background-clip: text paints instead (the @supports not (…) block after
       the letter rules also resets the fill there). Lighthouse's Baseline
       audit lists background-clip-text as Limited — this is the answer. */
    color: var(--text-primary);

    /* Neural connections texture clipped to text.

       The JPEG fallback lives in the @supports block below rather than as a
       preceding declaration of the same property. Written the usual way — plain
       `url()` first, `image-set()` after — the CSS minifier saw two
       declarations of `background-image` in one rule, concluded the first was
       dead, and pruned it: verified against the built output, where
       `neural-texture.jpg` appeared zero times. That is not a cosmetic loss.
       This element also sets `-webkit-text-fill-color: transparent` and
       `background-clip: text`, so a browser without image-set() support
       computed `background-image: none` and rendered the site's H1 as nothing
       but its thin 2px stroke outline. @supports survives minification because
       the fallback is no longer a duplicate declaration the minifier may drop.

       Sizing: this box measures 424x168 CSS px and does not grow with the
       viewport — measured in the browser, identical at 1280 and at 2560. With
       `cover` the texture paints at 547x168, so 1094x336 device pixels is
       everything a DPR-2 display can resolve. The file was 2400x737 / 369 KB,
       roughly five times the pixels that can ever be shown, and it dominated
       the desktop payload. It is now 1200x368 / 101 KB — still native at DPR 2.
       Compared against the old file at every DPR the browser can ask for, the
       difference is invisible: the content is a mesh of thin lines seen only
       through letterforms, and four candidate encodings were indistinguishable
       side by side. Do not "restore quality" by re-exporting this at 2400 —
       the pixels have nowhere to go. */
    background-image: image-set(
      url('/neural-texture.avif') type('image/avif'),
      url('/neural-texture.webp') type('image/webp')
    );
    background-position: center center;
    background-size: cover;
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;

    -webkit-text-stroke: 2px hsla(180, 80%, 55%, 0.7);

    filter: drop-shadow(0 0 2px hsla(0, 0%, 0%, 0.8)) drop-shadow(0 0 6px hsla(0, 0%, 0%, 0.5));

    /* Entrance: CSS keyframes, not the JS `.is-visible` class — this is an
       LCP candidate (the largest text on the page; on desktop its clipped
       texture makes it an image candidate too). It must be RECORDED at first
       paint, so the fade starts from a floor, not from 0 — the rule and the
       measurements are on .hero-overlay__subtitle below; the floor here is
       0.2, never lower than the subtitle's, so the headline is always the
       brighter of the two. The texture is preloaded from the page head
       (src/pages/[lang]/index.astro) so a headline that is visible from the
       first frame does not pop its fill in later. Two animations reproduce
       the original per-property timing (opacity 1s vs. transform 1.2s). */
    animation:
      hero-title-opacity-in 1s ease-out 0.2s backwards,
      hero-title-transform-in 1.2s cubic-bezier(0.16, 1, 0.3, 1) 0.2s backwards;
  }

  /* The fallback the minifier kept deleting. In its own conditional rule it is
     no longer a duplicate declaration inside .hero-overlay__title, so nothing
     can prune it as dead. Without this an engine lacking image-set() paints the
     H1 as an empty outline, because background-clip:text +
     -webkit-text-fill-color:transparent are applied unconditionally above. */
  @supports not (background-image: image-set(url('/neural-texture.avif') type('image/avif'))) {
    .hero-overlay__title {
      background-image: url('/neural-texture.jpg');
    }
  }

  /* `from` opacity is an LCP floor — see .hero-overlay__subtitle. */
  @keyframes hero-title-opacity-in {
    from {
      opacity: 0.2;
    }
    to {
      opacity: 1;
    }
  }

  @keyframes hero-title-transform-in {
    from {
      transform: translateY(20px);
    }
    to {
      transform: translateY(0);
    }
  }

  /* The headline's visible fill is the H1's background image clipped to text
     (background-clip: text + transparent text-fill-color). The letters carry
     no fill of their own — they inherit only -webkit-text-stroke.

     So the one rule here is: NOTHING on .hero-letter may create a new
     rendering surface. filter, transform, opacity below 1, backdrop-filter,
     mask, will-change, perspective, isolation and position+z-index all do.
     Any of them renders the letter into its own buffer, where the parent's
     clipped background does not exist — the glyph then paints as a bare
     stroke outline sitting beside the filled glyph, which is the doubled
     first letter that was reported three times.

     The earlier fix removed `transform` and kept `filter: brightness()`,
     with a comment asserting filter was safe because it "recolours in place".
     That was wrong: filter is precisely a new rendering surface, so the bug
     survived, and the whole effect was then deleted rather than corrected.

     text-shadow and -webkit-text-stroke-color create no such surface: they
     are painted by the same element, in the same pass, so the parent's clip
     still applies. That is what the hover uses. */
  .hero-letter {
    transition:
      -webkit-text-stroke-color var(--duration-slow, 0.4s) var(--ease-out, ease-out),
      text-shadow var(--duration-slow, 0.4s) var(--ease-out, ease-out);
    cursor: default;
  }

  .hero-letter:hover {
    -webkit-text-stroke-color: hsla(180, 90%, 70%, 0.95);
    text-shadow:
      0 0 10px hsla(180, 85%, 60%, 0.55),
      0 0 22px hsla(180, 85%, 55%, 0.3);
  }

  @media (prefers-reduced-motion: reduce) {
    .hero-letter {
      transition: none;
    }
  }

  /* ── Subtitle — gradient accent + breathing glow ───── */
  .hero-overlay__subtitle {
    font-size: var(--text-lg);
    line-height: var(--leading-relaxed);
    max-width: 520px;
    letter-spacing: 0.01em;
    /* Solid fallback — see .hero-overlay__title. */
    color: var(--text-secondary);

    /* Subtle gradient instead of flat color */
    background: linear-gradient(
      90deg,
      hsla(155, 30%, 75%, 0.7) 0%,
      var(--text-secondary) 40%,
      var(--text-secondary) 60%,
      hsla(220, 30%, 75%, 0.7) 100%
    );
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;

    /* Entrance: CSS keyframe, not the JS `.is-visible` class — this is an
       LCP element of the homepage (.system/metrics/p1-lcp.md, p6-lcp-chain.md:
       text, no resource, only "element render delay"); on desktop the
       headline's clipped texture can win instead, and either is fine.

       THE RULE THIS LINE OBEYS — measured 2026-09-20 on an isolated replica
       of the hero, Lighthouse mobile profile, and re-measured 2026-09-21 on
       the built page (see the label comment for the cascade):
         opacity 0 -> 1, delay + 0.8s, + text-shadow glow      = 1553 ms delay
         opacity .45 -> 1, same delay/duration, no glow on text =  196 ms
         opacity .1 -> 1 (this floor), headline floor .2 — element render
           delay, two batches of 3 runs per profile on the built page:
           quiet box:   mobile 216 / 231 / 288 ms, desktop 247 / 255 / 308 ms
           box shared with a GPU render, runs interleaved with the baseline:
                        mobile 398 / 410 / 1359 ms, desktop 235 / 243 / 417 ms
           In all twelve runs the observed LCP time EQUALLED the observed
           first-paint time (e.g. 254 = 254, 1367 = 1367): what is left of
           the "delay" is first paint itself, not this animation. Baseline
           in the same two batches: 2096–4158 ms mobile, 2136–2286 desktop,
           and there LCP came ~1.9 s after first paint every time.
           LCP element: the subtitle on mobile, the headline on desktop.
       Chrome refuses to record text at opacity 0 and, once a fade-from-0 is
       running, waits for the animation to END before it takes the paint time
       (delay + duration). The trigger is opacity == 0 exactly: start the fade
       from a non-zero floor and the paragraph is recorded at first paint,
       animation still running. 0.1 is the floor because at 0.1 the line is
       genuinely painted (not the 0.01 lie) yet reads as absent — about
       1.4:1 against the obsidian — until the headline, which starts at 0.2
       and 0.3 s earlier, has landed; the wave-1 value of 0.45 was legible on
       its own and put the third beat of the cascade on screen first.
       The `subtitle-glow` that used to be the second animation here peaked at
       `0 0 20px hsla(155, 60%, 60%, 0.08)` — an 8% haze nobody could see,
       repainting the LCP element every frame. It is gone, not moved: a
       negative-z pseudo cannot sit behind background-clip: text glyphs (they
       ARE the background, painted first), so the wave-1 halo covered the
       letters instead of glowing behind them. Resting state was no shadow at
       all; that is what the line has now. */
    animation: hero-subtitle-settle 0.8s ease-out 0.5s backwards;
  }

  /* `from` opacity is the LCP floor. It must stay > 0 and never above the
     headline's — see the comment above — and both are test-enforced
     (tests/unit/hero-overlay-lcp.test.ts). */
  @keyframes hero-subtitle-settle {
    from {
      opacity: 0.1;
      transform: translateY(15px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  /* ── CTA Button ────────────────────────────────────── */
  .hero-overlay__cta {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-3) var(--space-8);
    font-family: var(--font-sans);
    font-size: var(--text-sm);
    font-weight: var(--weight-semibold);
    letter-spacing: var(--tracking-wide);
    text-transform: uppercase;
    text-decoration: none;
    color: var(--bg-void);
    background: linear-gradient(135deg, var(--accent-green-300), var(--accent-green-400));
    border: 1px solid var(--accent-green-200);
    border-radius: var(--radius-md);
    cursor: pointer;
    position: relative;
    overflow: hidden;

    /* NOTE: `transform` here only matters before JS attaches — the anchor
       always carries an inline `style:transform={parallax4}` (magnetic/
       parallax offset) which, once present, wins over this rule by
       specificity. Unaffected by this change either way. */
    transform: translateY(20px) scale(0.9);
    transition:
      transform 0.15s ease-out,
      box-shadow 0.3s ease-out,
      background 0.3s ease-out;
    /* Entrance opacity: CSS keyframe, not the JS `.is-visible` class — see
       .hero-overlay__title above. The CTA is the last beat and is never an
       LCP candidate, so it is the one element still allowed to start at 0. */
    animation: hero-cta-opacity-in 0.8s ease-out 0.8s backwards;
  }

  @keyframes hero-cta-opacity-in {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }

  /* CTA shimmer sweep. The keyframes were missing from the repo entirely —
     the animation name referenced nothing and the sweep silently never ran
     (found during the geo-audit idiom transplant).
     Now a transform, not background-position: the old keyframes moved a
     250%-wide background image, and background-position is a paint
     property — Lighthouse's non-composited-animations audit listed this
     pseudo. The geometry is identical, just expressed on the box instead of
     its background: a pseudo 250% as wide as the button, gradient at its
     natural size, translated by −120% of its own width (= −3 button widths,
     what `background-position: 200% 0` resolved to with a 2.5× image) at
     rest and +30% (= +0.75 widths, what `-50% 0` resolved to) at the end. */
  @keyframes shimmer-pass {
    0%,
    60% {
      transform: translateX(-120%);
    }
    100% {
      transform: translateX(30%);
    }
  }

  .hero-overlay__cta::before {
    content: '';
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    width: 250%;
    background: linear-gradient(
      105deg,
      transparent 30%,
      hsla(0, 0%, 100%, 0.2) 50%,
      transparent 70%
    );
    transform: translateX(-120%);
    animation: shimmer-pass 4s ease-in-out 3s infinite;
    pointer-events: none;
  }

  .hero-overlay__cta:hover {
    box-shadow:
      0 0 20px var(--accent-glow-strong),
      0 0 60px var(--accent-glow),
      inset 0 0 20px hsla(155, 70%, 70%, 0.15);
    border-color: var(--accent-green-100);
  }

  .hero-overlay__cta.is-magnetic {
    transition-duration: 0.08s;
  }

  .hero-overlay__cta svg {
    transition: transform 0.3s var(--ease-spring);
  }

  .hero-overlay__cta:hover svg {
    transform: translateX(4px);
  }

  .hero-overlay__cta-ghost {
    display: inline-flex;
    align-items: center;
    min-height: 24px;
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    letter-spacing: var(--tracking-wide);
    text-transform: uppercase;
    text-decoration: none;
    color: var(--text-muted);
    transition: color 0.3s ease-out;
    /* Same CSS-keyframe entrance as the primary CTA, a beat later. */
    animation: hero-cta-opacity-in 0.8s ease-out 0.95s backwards;
  }

  .hero-overlay__cta-ghost:hover {
    color: var(--accent-green-300);
  }

  /* ── Responsive ────────────────────────────────────── */
  /* Same two-clause query as HeroCanvas's hero--static gate: 767 (not 768 —
     an iPad portrait runs the desktop scrub and must get desktop styles),
     plus short+coarse so a rotated phone gets the frosted panel over the
     static poster instead of a desktop layout squeezed into 375px height. */
  @media (max-width: 767px), ((max-height: 767px) and (pointer: coarse)) {
    .hero-overlay__content {
      gap: var(--space-3);
      /* Frosted backdrop so the text stops drowning in the bright neural
         video (owner's phone screenshot). The Stack section's 2026 glass
         recipe, gentled for a text panel: lighter veil, no grain — the
         letters need a calm surface. Mobile-only: on desktop the text has
         breathing room and the panel would read as a box. */
      background: hsla(220, 20%, 8%, 0.55);
      backdrop-filter: blur(18px) saturate(150%);
      -webkit-backdrop-filter: blur(18px) saturate(150%);
      border: 1px solid hsla(0, 0%, 100%, 0.06);
      border-radius: var(--radius-xl, 16px);
      box-shadow:
        inset 0 1px 0 hsla(0, 0%, 100%, 0.06),
        0 8px 32px hsla(0, 0%, 0%, 0.35);
      padding: var(--space-6) var(--space-4);
      margin-inline: var(--space-4);
    }
    .hero-overlay__title {
      font-size: clamp(1.8rem, 8vw, 3rem);

      /* A 512x157 texture instead of the desktop one. This element paints it
         into a box of roughly 175x69 CSS px — ~306x121 device pixels at
         DPR 1.75 — and then clips it to the inside of the glyphs, so the
         full-size asset was sending ~60x more pixels than could ever be shown.
         It is not the LCP element and never becomes one, but it was the largest
         asset on the page and sat inside the byte graph the LCP is simulated
         against.

         Measured, not assumed: swapping this one file for a small stand-in and
         changing nothing else moved simulated mobile LCP from 6004 ms to
         4056 ms (4132 on a repeat). Observed LCP was unmoved at ~2.1 s, which
         is the tell that this is a byte-weight problem, not a render one.

         A losing declaration's background-image is never fetched, so phones
         take only the 23.5 KB file and desktops only the 101 KB one. The
         @supports fallback further up still points at the JPEG on purpose: it
         only fires on engines without image-set() support, which are not the
         ones being optimised here. */
      background-image: image-set(
        url('/neural-texture-mobile.avif') type('image/avif'),
        url('/neural-texture-mobile.webp') type('image/webp')
      );
    }
  }

  /* ── Reduced motion ────────────────────────────────── */
  @media (prefers-reduced-motion: reduce) {
    .hero-overlay__neural {
      display: none;
    }
    .hero-overlay__label,
    .hero-overlay__title,
    .hero-overlay__subtitle,
    .hero-overlay__cta,
    .hero-overlay__cta-ghost {
      opacity: 1 !important;
      filter: none !important;
      transform: none !important;
      transition: none !important;
      animation: none !important;
    }
    .hero-overlay__title::after {
      display: none;
    }
    /* Static resting state, no motion: the rest twin stays at opacity 1
       (the old 12px glow), the peak twin at 0, and the shimmer stays parked
       off the left edge of the button where its keyframes hold it. Every
       `animation:` declared in this sheet is named here — test-enforced. */
    .hero-overlay__label::before,
    .hero-overlay__label::after,
    .hero-overlay__cta::before {
      animation: none;
    }
    /* The arrow's hover slide was the one transition in this sheet not
       named here. */
    .hero-overlay__cta svg {
      transition: none;
    }
  }

  /* ── No background-clip: text — solid text instead ── */
  /* Both clipped texts (title, subtitle) set -webkit-text-fill-color:
     transparent unconditionally. On an engine without background-clip: text
     that leaves a box-shaped texture behind invisible glyphs — so the whole
     clip recipe is undone here and the solid `color` tokens declared on the
     base rules take over.
     This block is LAST in the sheet on purpose and must stay last: it has
     the same specificity as every base and @media rule above it and wins
     only by source order — the mobile texture override at 767px included.
     A first draft sat between the title and the subtitle; the built CSS
     showed it losing to both the subtitle base rule and the mobile block,
     which is why the position is now test-enforced
     (tests/unit/hero-overlay-lcp.test.ts). Written as `not (…)` rather than
     wrapping the recipe in `@supports (…)`, because the JPEG fallback for
     the title is already a conditional rule the minifier must not read as a
     duplicate declaration — see the comment on that block. */
  @supports not ((-webkit-background-clip: text) or (background-clip: text)) {
    .hero-overlay__title {
      background-image: none;
      -webkit-text-fill-color: var(--text-primary);
      -webkit-text-stroke: 0;
    }
    .hero-overlay__subtitle {
      background: none;
      -webkit-text-fill-color: var(--text-secondary);
    }
  }
</style>
