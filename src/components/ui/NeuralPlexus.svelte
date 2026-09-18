<script lang="ts">
  /**
   * NeuralPlexus — the homepage hero's growing, mouse-reactive neural network,
   * extracted into a standalone island so any page can layer it over its own
   * background (the geo-audit hero puts it above the morph video).
   *
   * Same engine as HeroOverlay's canvas: three branches grow from the center,
   * settled nodes drift on smooth noise, one reactive fork per growth-cycle
   * reaches toward the cursor, hue blends 220→155 left-to-right. Same
   * lifecycle discipline: DPR capped at 2, IntersectionObserver stops the rAF
   * loop below the fold, reduced-motion draws exactly one static frame, and
   * resize re-seeds (canvas.width assignment always clears the bitmap).
   *
   * The container is pointer-events: none; the mouse is tracked on window and
   * mapped into container space — hover reactivity without stealing a single
   * click from the page.
   */

  interface MediaAnchor {
    /** The cover-fitted media element (img/video) whose frame holds the anchor. */
    selector: string;
    /** Natural frame size — only the aspect ratio matters for cover math. */
    width: number;
    height: number;
    /** Anchor point as fractions of the media frame (measure it in the file). */
    x: number;
    y: number;
  }

  interface Props {
    /**
     * Where the network is born, as fractions of the container (0..1).
     * Default is dead center (homepage behavior); the geo-audit hero aims
     * it at the glowing core of the video's neuron so the interactive web
     * grows out of the organic one.
     */
    originX?: number;
    originY?: number;
    /**
     * Lock the origin to a fixed point of a cover-cropped media frame.
     * Fixed container fractions drift with the viewport (cover crops
     * differently at every aspect ratio); this recomputes the on-screen
     * position of the media point from the element's box + computed
     * object-position on every resize. originX/originY become the
     * fallback when the element isn't found.
     */
    anchor?: MediaAnchor;
    /** Draw the constellation-menu breathing glow + pulse ring at the origin. */
    originGlow?: boolean;
    /**
     * Growth tempo multiplier: >1 stretches how long each segment takes to
     * grow and the pause between spawns (drift is untouched). 1 keeps the
     * homepage pace.
     */
    pace?: number;
    /**
     * 'stairs' snaps every segment to alternating left / down runs, so the
     * network descends the frame in steps instead of branching organically —
     * the services hero, where the art itself is a staircase.
     */
    growth?: 'organic' | 'stairs';
  }

  let {
    originX = 0.5,
    originY = 0.5,
    anchor,
    originGlow = false,
    pace = 1,
    growth = 'organic',
  }: Props = $props();

  // Stair runs: even steps travel horizontally, odd steps drop down. The jitter
  // keeps it hand-drawn rather than pixel-perfect CAD. `dir` lets a tread turn
  // back on itself when the run reaches the frame edge — clamping instead used
  // to weld a whole flight of nodes onto x = margin as overlapping duplicates.
  const STEP_JITTER = 0.22;
  const stepAngle = (step: number, dir = -1): number =>
    (step % 2 === 0 ? (dir < 0 ? Math.PI : 0) : Math.PI / 2) + (Math.random() - 0.5) * STEP_JITTER;

  // A pace <= 0 would make GROW_DURATION 0 and growProgress = 0/0 = NaN,
  // which never recovers (NaN < 1 is always false) — clamp before deriving
  // any interval from it.
  const safePace = Math.max(0.1, pace);

  // Resolved origin — either the props or the anchored media point.
  let orX = originX;
  let orY = originY;

  let container: HTMLDivElement | undefined = $state();
  let canvas: HTMLCanvasElement | undefined = $state();

  // Engine state — deliberately NOT runes: nothing in the template reads it,
  // and reactive tracking inside a 60fps loop would only add overhead.
  let rawMouseX = 0.5;
  let rawMouseY = 0.5;
  let mouseX = 0.5;
  let mouseY = 0.5;
  let reduceMotion = false;
  let inView = true;
  let frameCount = 0;
  let lastSpawn = [0, 0, 0];
  let lastMouseFork = 0;
  let animFrameId: number | null = null;
  // Under reduced motion animate() draws exactly one frame — this flags that
  // the single frame has already been fast-forwarded to a settled network,
  // so a re-entrant animate() call (e.g. from onResize) doesn't re-run
  // settleAll() and doesn't restart the growth schedule.
  let settledStatic = false;

  const MOUSE_LERP = 0.03;
  const CONNECTION_DIST = 160;
  const SPAWN_INTERVAL = 360 * safePace;
  const GROW_DURATION = 360 * safePace;
  const MAX_NODES = 60;
  const DRIFT_SPEED = 0.002;
  const DRIFT_AMP = 8;

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
    /** Run index for stairs mode: even = tread, odd = riser. Derived from the
        parent, never from branch length — that count includes side forks, so
        43% of consecutive segments repeated the same axis. */
    step: number;
  }

  let nodes: PlexNode[] = [];

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

  /**
   * object-fit: cover mapping — find where the anchor point of the media
   * frame lands inside the plexus container, in container fractions.
   */
  function resolveOrigin(rect: DOMRect): void {
    orX = originX;
    orY = originY;
    if (!anchor) return;
    const el = document.querySelector<HTMLElement>(anchor.selector);
    if (!el || rect.width === 0 || rect.height === 0) return;
    const box = el.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) return;

    const pos = getComputedStyle(el).objectPosition.split(' ');
    const posX = pos[0]?.endsWith('%') ? parseFloat(pos[0]) / 100 : 0.5;
    const posY = pos[1]?.endsWith('%') ? parseFloat(pos[1]) / 100 : 0.5;

    const scale = Math.max(box.width / anchor.width, box.height / anchor.height);
    const px = (box.width - anchor.width * scale) * posX + anchor.x * anchor.width * scale;
    const py = (box.height - anchor.height * scale) * posY + anchor.y * anchor.height * scale;
    orX = (box.left - rect.left + px) / rect.width;
    orY = (box.top - rect.top + py) / rect.height;
  }

  function initNetwork(width: number, height: number): void {
    frameCount = 0;
    nodes = [];
    lastMouseFork = 0;
    settledStatic = false;
    const cx = width * orX;
    const cy = height * orY;
    const base = Math.random() * Math.PI * 2;

    for (let i = 0; i < 3; i++) {
      // Stairs: all three runs leave the crest going left or down, staggered
      // so they read as separate flights rather than one thick line.
      const angle =
        growth === 'stairs'
          ? stepAngle(i) + (i === 2 ? Math.PI / 4 : 0)
          : base + (i / 3) * Math.PI * 2 + (Math.random() - 0.5) * 0.4;
      const seedDist = 15 + Math.random() * 10;
      const seedBorn = i * SPAWN_INTERVAL;
      const seedIdx = nodes.length;

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
        step: 0,
      });

      const childDist = 70 + Math.random() * 60;
      const childAngle =
        growth === 'stairs' ? stepAngle(i + 1) : angle + (Math.random() - 0.5) * 0.6;
      nodes.push({
        x: cx,
        y: cy,
        baseX: cx + Math.cos(childAngle) * childDist,
        baseY: cy + Math.sin(childAngle) * childDist,
        born: seedBorn + 30 * safePace,
        branch: i,
        parentIdx: seedIdx,
        noiseOffX: Math.random() * 1000,
        noiseOffY: Math.random() * 1000,
        growProgress: 0,
        lineWidth: 2.8 + Math.random() * 0.4,
        step: 1,
      });

      lastSpawn[i] = seedBorn + 30 * safePace;
    }
  }

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
    if (!parent) return;
    const branch = parent.branch;
    const branchNodes = nodes.filter((n) => n.branch === branch);
    if (branchNodes.length >= Math.floor(MAX_NODES / 3)) return;

    const grandparent = parent.parentIdx >= 0 ? nodes[parent.parentIdx] : undefined;
    const prevAngle = grandparent
      ? Math.atan2(parent.baseY - grandparent.baseY, parent.baseX - grandparent.baseX)
      : Math.atan2(parent.baseY - vh * orY, parent.baseX - vw * orX);
    const depth = branchNodes.length;
    const step = parent.step + 1;
    const margin = 50;

    // Treads run longer than risers — a staircase, not a chequerboard.
    const dist =
      growth === 'stairs'
        ? step % 2 === 0
          ? 90 + Math.random() * 50
          : 55 + Math.random() * 30
        : 70 + Math.random() * 70;

    // Turn the flight around before it hits the frame edge instead of piling
    // node after node onto the clamp.
    const treadDir = growth === 'stairs' && parent.baseX - dist < margin + 20 ? 1 : -1;
    const angle =
      growth === 'stairs' ? stepAngle(step, treadDir) : prevAngle + (Math.random() - 0.5) * 1.4;
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
      step,
    });

    if (Math.random() < 0.45 && depth < Math.floor(MAX_NODES / 3) - 1) {
      // A side branch steps off along the other axis, so forks stay on-grid.
      const fa =
        growth === 'stairs'
          ? stepAngle(step + 1, treadDir)
          : angle + (Math.random() > 0.5 ? 1 : -1) * (0.4 + Math.random() * 0.5);
      const fd = 50 + Math.random() * 60;
      nodes.push({
        x: parent.x,
        y: parent.y,
        baseX: Math.max(margin, Math.min(vw - margin, parent.baseX + Math.cos(fa) * fd)),
        baseY: Math.max(margin, Math.min(vh - margin, parent.baseY + Math.sin(fa) * fd)),
        born: frameCount + 90 * safePace,
        branch,
        parentIdx,
        noiseOffX: Math.random() * 1000,
        noiseOffY: Math.random() * 1000,
        growProgress: 0,
        lineWidth: Math.max(1.5, lw - 0.4),
        step: step + 1,
      });
    }
  }

  /**
   * Reduced-motion path: fast-forward every branch straight to its settled,
   * fully-grown state instead of letting the spawn schedule (born timers up
   * to 3 * SPAWN_INTERVAL + GROW_DURATION, ~1440 frames at pace 1) gate what
   * animate()'s single drawn frame can show. Without this, only the frame-0
   * seed of branch 0 is visible — every other node's `born` is still in the
   * future, so the "static state" the header promises was actually a
   * near-empty canvas (one 2.2px dot). Called once per initNetwork() (guarded
   * by settledStatic) so a resize that re-seeds the network re-settles it too.
   */
  function settleAll(vw: number, vh: number): void {
    for (const node of nodes) {
      node.born = 0;
      node.growProgress = 1;
      node.x = node.baseX;
      node.y = node.baseY;
    }

    const target = Math.floor(MAX_NODES / 3);
    for (let b = 0; b < 3; b++) {
      let guard = 0;
      // spawnNode() itself refuses once a branch reaches `target`, so this
      // loop's only job is to keep calling it (from the branch's newest
      // node) and settle whatever it pushes, until it declines.
      while (guard < MAX_NODES) {
        const branchNodes = nodes.filter((n) => n.branch === b);
        const last = branchNodes[branchNodes.length - 1];
        if (!last || branchNodes.length >= target) break;

        const before = nodes.length;
        spawnNode(nodes.indexOf(last), vw, vh);
        if (nodes.length === before) break; // declined — branch is full

        for (let i = before; i < nodes.length; i++) {
          const n = nodes[i];
          n.born = 0;
          n.growProgress = 1;
          n.x = n.baseX;
          n.y = n.baseY;
        }
        guard++;
      }
    }
  }

  function animate(): void {
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) return;

    mouseX += (rawMouseX - mouseX) * MOUSE_LERP;
    mouseY += (rawMouseY - mouseY) * MOUSE_LERP;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const vw = canvas.width / dpr;
    const vh = canvas.height / dpr;
    const mx = mouseX * vw;
    const my = mouseY * vh;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    frameCount++;

    if (reduceMotion) {
      // Fast-forward straight to the settled network instead of running the
      // spawn/grow schedule — see settleAll()'s doc comment.
      if (!settledStatic) {
        settleAll(vw, vh);
        settledStatic = true;
      }
    } else {
      // 1) Spawn
      for (let b = 0; b < 3; b++) {
        if (frameCount - (lastSpawn[b] ?? 0) >= SPAWN_INTERVAL) {
          const bNodes = nodes.filter((n) => n.branch === b && frameCount >= n.born);
          const lastBNode = bNodes[bNodes.length - 1];
          if (lastBNode && lastBNode.growProgress >= 0.9) {
            spawnNode(nodes.indexOf(lastBNode), vw, vh);
            lastSpawn[b] = frameCount;
          }
        }
      }

      // 2) Update positions
      for (const node of nodes) {
        if (frameCount < node.born) continue;
        const age = frameCount - node.born;

        if (node.growProgress < 1) {
          node.growProgress = Math.min(1, age / GROW_DURATION);
          const eased = 1 - (1 - node.growProgress) ** 3;
          const p = node.parentIdx >= 0 ? nodes[node.parentIdx] : undefined;
          if (p) {
            node.x = p.x + (node.baseX - p.x) * eased;
            node.y = p.y + (node.baseY - p.y) * eased;
          } else {
            const ox = vw * orX;
            const oy = vh * orY;
            node.x = ox + (node.baseX - ox) * eased;
            node.y = oy + (node.baseY - oy) * eased;
          }
        } else {
          const t = frameCount * DRIFT_SPEED;
          const dx = smoothNoise(t + node.noiseOffX, node.noiseOffY) * DRIFT_AMP;
          const dy = smoothNoise(node.noiseOffX, t + node.noiseOffY) * DRIFT_AMP;
          node.x += (node.baseX + dx - node.x) * 0.03;
          node.y += (node.baseY + dy - node.y) * 0.03;
        }
      }

      // 3) Reactive fork toward the mouse
      if (nodes.length < MAX_NODES && frameCount - lastMouseFork > GROW_DURATION) {
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
            const depth = nodes.filter((n) => n.branch === nearestNode!.branch).length;
            // Stairs: the cursor still summons a fork, but it must land on the
            // grid — snap to whichever run (left or down) points nearer the mouse.
            const toMouse = Math.atan2(my - nearestNode.y, mx - nearestNode.x);
            // Snap to the nearest of the four grid directions: snapping to only
            // left/down sent the fork away from a cursor that sat right or above.
            const angle =
              growth === 'stairs'
                ? Math.round(toMouse / (Math.PI / 2)) * (Math.PI / 2) +
                  (Math.random() - 0.5) * STEP_JITTER
                : toMouse + (Math.random() - 0.5) * 0.3;
            const dist = 60 + Math.random() * 60;
            const margin = 50;
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
              step: nearestNode.step + 1,
            });
            lastMouseFork = frameCount;
          }
        }
      }
    }

    // Origin glow — the constellation menu's idle-dot language verbatim
    // (soft radial halo + blurred-edge core, both breathing; no hard
    // ring — a stroked circle over the rope art read as a crooked blob).
    if (originGlow) {
      const gx = vw * orX;
      const gy = vh * orY;
      const breathe = Math.sin(frameCount * 0.025);

      const haloR = 30 + breathe * 8;
      const halo = ctx.createRadialGradient(gx, gy, 0, gx, gy, haloR);
      halo.addColorStop(0, `hsla(215, 70%, 60%, ${0.14 + breathe * 0.05})`);
      halo.addColorStop(1, 'hsla(215, 70%, 60%, 0)');
      ctx.beginPath();
      ctx.arc(gx, gy, haloR, 0, Math.PI * 2);
      ctx.fillStyle = halo;
      ctx.fill();

      const coreR = 7 + breathe * 2;
      const coreA = 0.4 + breathe * 0.1;
      const core = ctx.createRadialGradient(gx, gy, 0, gx, gy, coreR);
      core.addColorStop(0, `hsla(215, 70%, ${64 + breathe * 6}%, ${coreA})`);
      core.addColorStop(0.7, `hsla(215, 70%, 64%, ${coreA * 0.8})`);
      core.addColorStop(1, 'hsla(215, 70%, 64%, 0)');
      ctx.beginPath();
      ctx.arc(gx, gy, coreR, 0, Math.PI * 2);
      ctx.fillStyle = core;
      ctx.fill();
    }

    // Draw — branch lines, cross-links, nodes (hue 220→155 across x)
    const closestBranch = findClosestBranch(mx, my);

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

    for (const node of nodes) {
      if (frameCount < node.born) continue;
      const isNear = node.branch === closestBranch;
      const xFrac = node.x / vw;
      const hue = 220 + (155 - 220) * xFrac;
      const mDist = Math.sqrt((mx - node.x) ** 2 + (my - node.y) ** 2);
      const glow = mDist < 150 ? (1 - mDist / 150) * 0.4 : 0;

      if (glow > 0.05) {
        ctx.beginPath();
        ctx.arc(node.x, node.y, 10, 0, Math.PI * 2);
        ctx.fillStyle = `hsla(${hue}, 65%, 55%, ${glow * 0.1})`;
        ctx.fill();
      }

      const r = (isNear ? 3 : 2.2) * node.growProgress;
      ctx.beginPath();
      ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
      ctx.fillStyle = `hsla(${hue}, 65%, ${55 + glow * 20}%, ${(isNear ? 0.4 : 0.25) + glow * 0.3})`;
      ctx.fill();

      if (node.growProgress < 1 && node.growProgress > 0.1) {
        const pulse = Math.sin(frameCount * 0.08) * 0.12 + 0.15;
        ctx.beginPath();
        ctx.arc(node.x, node.y, 7, 0, Math.PI * 2);
        ctx.fillStyle = `hsla(${hue}, 70%, 60%, ${pulse * node.growProgress})`;
        ctx.fill();
      }
    }

    if (!reduceMotion && inView) {
      animFrameId = requestAnimationFrame(animate);
    } else {
      animFrameId = null;
    }
  }

  $effect(() => {
    if (!canvas || !container) return;

    // Last-seeded bitmap dimensions — a mobile URL bar showing/hiding fires
    // resize with a height-only delta; re-seeding the whole network on that
    // would wipe and restart the hero animation on every scroll tick.
    let lastWidth = -1;
    let lastHeight = -1;
    // Refreshed on every size() call so onMove never has to query layout.
    let cachedRect: DOMRect | null = null;

    const size = () => {
      const rect = container!.getBoundingClientRect();
      cachedRect = rect;
      if (rect.width === lastWidth && rect.height === lastHeight) return;

      // Re-read every call — a stale, once-captured dpr disagrees with the
      // one animate() recomputes live after a browser-zoom change or a move
      // to a different-DPR monitor.
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas!.width = rect.width * dpr;
      canvas!.height = rect.height * dpr;
      canvas!.style.width = `${rect.width}px`;
      canvas!.style.height = `${rect.height}px`;
      const c = canvas!.getContext('2d');
      if (c) c.scale(dpr, dpr);
      resolveOrigin(rect);

      // Width change (real layout shift) re-seeds; a height-only change
      // (URL bar) just resizes the bitmap and re-anchors the origin.
      if (rect.width !== lastWidth) {
        initNetwork(rect.width, rect.height);
      }
      lastWidth = rect.width;
      lastHeight = rect.height;
    };
    size();

    reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    animFrameId = requestAnimationFrame(animate);

    // Pointer-events stay none on the whole island — track the mouse on
    // window and map into container space instead.
    const onMove = (e: MouseEvent) => {
      const rect = cachedRect;
      if (!rect || rect.width === 0 || rect.height === 0) return;
      rawMouseX = (e.clientX - rect.left) / rect.width;
      rawMouseY = (e.clientY - rect.top) / rect.height;
    };
    window.addEventListener('mousemove', onMove, { passive: true });

    const io = new IntersectionObserver((entries) => {
      const last = entries[entries.length - 1];
      if (!last) return;
      if (last.isIntersecting) {
        inView = true;
        if (!reduceMotion && animFrameId === null) {
          animFrameId = requestAnimationFrame(animate);
        }
      } else {
        inView = false;
        if (animFrameId !== null) {
          cancelAnimationFrame(animFrameId);
          animFrameId = null;
        }
      }
    });
    io.observe(container);

    const onResize = () => {
      size();
      // canvas.width assignment cleared the bitmap; without the loop nothing
      // repaints it (checkpoint lesson), so under reduced motion draw once.
      if (reduceMotion) animate();
    };
    window.addEventListener('resize', onResize);

    return () => {
      if (animFrameId !== null) cancelAnimationFrame(animFrameId);
      io.disconnect();
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('resize', onResize);
    };
  });
</script>

<div class="neural-plexus" bind:this={container} aria-hidden="true">
  <canvas bind:this={canvas}></canvas>
</div>

<style>
  .neural-plexus {
    position: absolute;
    inset: 0;
    pointer-events: none;
    overflow: hidden;
  }

  .neural-plexus canvas {
    display: block;
  }
</style>
