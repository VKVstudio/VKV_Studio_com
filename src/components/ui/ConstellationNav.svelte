<script lang="ts">
  /**
   * ConstellationNav — Fullscreen neural overlay navigation
   *
   * Same PlexNode system as HeroOverlay but:
   *   - Branches grow FROM hovered node TOWARD connected target nodes
   *   - Each spawn biases direction toward the target (60% target + 40% organic)
   *   - On hover change: OLD branches slow down 8× but persist
   *   - New branches are ADDED, not replaced
   *   - Mouse glow on lines (same as hero), no direction tracking
   */

  import { t } from '@i18n/utils';

  interface NavItem {
    id: string;
    labelEN: string;
    labelRU: string;
    target: string;
    x: number;
    y: number;
    /** Label position relative to dot */
    labelPos: 'top' | 'left' | 'right' | 'bottom';
    /** Optional: draw glassmorphism background behind label */
    labelBg?: boolean;
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
    /** Which nav node this branch is heading toward (only for About branches) */
    targetNavId: string;
    /** Which nav node spawned this branch */
    sourceNavId: string;
    /** Group ID */
    groupId: number;
    /** True if this node is the final anchor at the target position */
    isAnchor: boolean;
  }

  interface Props {
    lang: 'en' | 'ru';
  }
  const { lang }: Props = $props();

  let isOpen = $state(false);

  // Cached, not re-queried per mousemove — the guard in onMouseMove sits in a
  // hot handler and a fresh matchMedia() parse per event is the naive form of
  // the repo's own idiom (PromptApp/EmbeddingScene cache + change-listen).
  // Width-based on purpose: it must agree with the CSS that hides .nav-canvas
  // and shows .mobile-nav, both gated at (max-width: 767px).
  let isMobileNav = false;
  $effect(() => {
    const mq = window.matchMedia('(max-width: 767px)');
    isMobileNav = mq.matches;
    const onChange = (e: MediaQueryListEvent) => {
      isMobileNav = e.matches;
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  });

  let canvasEl: HTMLCanvasElement | undefined = $state();
  let overlayEl: HTMLElement | undefined = $state();
  let videoEl: HTMLVideoElement | undefined = $state();
  let hoveredNode = $state<string | null>(null);

  /** Video playback state */
  let videoPlaying = $state(false);
  let videoEnded = $state(false);
  let videoPlayedOnce = $state(false);
  let canvasOpacity = 1;
  // Stall watchdog: the whole node/label choreography is gated on the brain
  // video reaching onended. A decoder stall (seen in the wild: playback
  // freezing mid-video on the owner's machine) used to freeze the MENU
  // forever. If currentTime stops advancing for ~1.5s while the video is
  // supposed to be playing, we force the ended state — same effects as
  // onended — and the constellation proceeds. Defense in depth: the menu
  // must never depend on a media pipeline behaving.
  let watchdogLastT = -1;
  let watchdogStill = 0;
  /** Nodes hovered during video — branches created after video ends */
  let pendingBranches: Set<string> = new Set();
  /** Dark overlay alpha — lerps to target after video ends */
  let darkOverlayAlpha = 0;
  /** Whether playbackRate has already been slowed for the second half */
  let videoSlowed = false;

  // ── Binary Star — Language Switcher ────────────────────────
  const langNode = {
    cx: 0.15, // center x (relative)
    cy: 0.93, // center y (relative) — low position, shorter branches
    orbitR: 18, // orbital radius in px
  };
  const altLang = lang === 'en' ? 'ru' : 'en';
  let isLangHov = false;
  let langFlashActive = false;
  let langFlashStart = 0;
  /** Whether the lang branches have been spawned */
  let langBranchSpawned = false;
  /** Accumulated orbit angle (prevents jump on speed change) */
  let langOrbitAngle = 0;
  let langOrbitSpeed = 0.008;

  // ── Build Log — special route node (mirrors the lang node, bottom-right) ──
  const logNode = {
    cx: 0.85, // center x (relative) — mirror of the lang node's 0.150
    cy: 0.93, // center y (relative) — same low row as the lang node
  };
  let isLogHov = false;
  let logFlashActive = false;
  let logFlashStart = 0;

  let animFrameId: number | null = null;
  let mouseX = 0.5,
    mouseY = 0.5;
  let rawMouseX = 0.5,
    rawMouseY = 0.5;

  // ── Nav data ───────────────────────────────────────────────
  const navItems: NavItem[] = [
    {
      id: 'home',
      labelEN: 'HOME',
      labelRU: 'ГЛАВНАЯ',
      target: '#hero-section',
      x: 0.5,
      y: 0.147,
      labelPos: 'top',
    },
    {
      id: 'lab',
      labelEN: 'LAB',
      labelRU: 'ЛАБОРАТОРИЯ',
      target: '#lab',
      x: 0.248,
      y: 0.466,
      labelPos: 'left',
    },
    {
      id: 'about',
      labelEN: 'ABOUT',
      labelRU: 'ОБО МНЕ',
      target: '#about',
      x: 0.513,
      y: 0.56,
      labelPos: 'bottom',
    },
    {
      id: 'stack',
      labelEN: 'STACK',
      labelRU: 'СТЕК',
      target: '#stack',
      x: 0.74,
      y: 0.623,
      labelPos: 'right',
    },
    {
      id: 'contact',
      labelEN: 'CONTACT',
      labelRU: 'КОНТАКТ',
      target: '#contact',
      x: 0.578,
      y: 0.9,
      labelPos: 'bottom',
    },
  ];

  /** Growth config per nav node */
  interface GrowConfig {
    baseAngle: number; // primary direction (radians)
    deviation: number; // max deviation (radians)
    branchCount: number;
    lineHue: number; // line color hue
    targets?: string[]; // if set, branches seek these targets (About only)
  }
  const growConfig: Record<string, GrowConfig> = {
    home: { baseAngle: -Math.PI / 2, deviation: Math.PI / 3, branchCount: 2, lineHue: 155 },
    lab: { baseAngle: Math.PI, deviation: Math.PI / 3, branchCount: 2, lineHue: 155 },
    stack: { baseAngle: 0, deviation: Math.PI / 3, branchCount: 2, lineHue: 155 },
    contact: {
      baseAngle: Math.PI / 2,
      deviation: (80 * Math.PI) / 180,
      branchCount: 2,
      lineHue: 155,
    },
    about: {
      baseAngle: 0,
      deviation: 0,
      branchCount: 4,
      lineHue: 220,
      targets: ['home', 'lab', 'stack', 'contact'],
    },
    // Lang branch color configs (used for hue lookup only)
    __lang__: { baseAngle: 0, deviation: Math.PI, branchCount: 0, lineHue: 155 },
    __lang_b__: { baseAngle: 0, deviation: Math.PI, branchCount: 0, lineHue: 220 },
  };

  const navMap: Record<string, NavItem> = Object.fromEntries(navItems.map((n) => [n.id, n]));

  // ── PlexNode system ────────────────────────────────────────

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

  const MOUSE_LERP = 0.03;
  const CONNECTION_DIST = 140;
  const SPAWN_INTERVAL = 160;
  const GROW_SPEED_ACTIVE = 1 / 200; // progress per frame when active
  const GROW_SPEED_SLOW = 1 / 1600; // 8× slower when not active
  const MAX_NODES_PER_BRANCH = 16;
  const DRIFT_SPEED = 0.002;
  const DRIFT_AMP = 6;

  let plexNodes: PlexNode[] = [];
  let frameCount = 0;
  let lastSpawn: Map<number, number> = new Map();
  let currentGroupId = 0;
  let activeGroupId = -1;
  let branchCounter = 0;
  /** Nav items that were hovered (source of branches) */
  let activatedNavIds: Set<string> = new Set();
  /** Nav items that a branch has reached */
  let reachedNavIds: Set<string> = new Set();
  /** Branches that already anchored to their target */
  let anchoredBranches: Set<number> = new Set();
  /** Source nav id → groupId (prevent duplicate branches) */
  let sourceToGroupId: Map<string, number> = new Map();

  function findClosestBranch(px: number, py: number): number {
    let best = 0,
      bestD = Infinity;
    for (const n of plexNodes) {
      if (frameCount < n.born) continue;
      const d = (n.x - px) ** 2 + (n.y - py) ** 2;
      if (d < bestD) {
        bestD = d;
        best = n.branch;
      }
    }
    return best;
  }

  /**
   * Add branches OR reactivate existing ones.
   */
  function addBranches(nodeId: string, vw: number, vh: number): void {
    activatedNavIds.add(nodeId);

    const existingGroup = sourceToGroupId.get(nodeId);
    if (existingGroup !== undefined) {
      activeGroupId = existingGroup;
      return;
    }

    currentGroupId++;
    activeGroupId = currentGroupId;
    sourceToGroupId.set(nodeId, currentGroupId);

    const source = navMap[nodeId];
    const config = growConfig[nodeId];
    const sx = source.x * vw;
    const sy = source.y * vh;

    if (config.targets) {
      // ABOUT: one branch per target (toward HOME, LAB, STACK, CONTACT)
      for (let i = 0; i < config.targets.length; i++) {
        const targetId = config.targets[i];
        const target = navMap[targetId];
        const tx = target.x * vw;
        const ty = target.y * vh;
        const branchId = branchCounter++;
        const angle = Math.atan2(ty - sy, tx - sx) + (Math.random() - 0.5) * 0.3;
        const seedDist = 12 + Math.random() * 8;
        const seedIdx = plexNodes.length;

        plexNodes.push({
          x: sx,
          y: sy,
          baseX: sx + Math.cos(angle) * seedDist,
          baseY: sy + Math.sin(angle) * seedDist,
          born: frameCount + i * 30,
          branch: branchId,
          parentIdx: -1,
          noiseOffX: Math.random() * 1000,
          noiseOffY: Math.random() * 1000,
          growProgress: 1,
          lineWidth: 5 + Math.random() * 1,
          targetNavId: targetId,
          sourceNavId: nodeId,
          groupId: currentGroupId,
          isAnchor: false,
        });

        const childDist = 55 + Math.random() * 45;
        const childAngle = angle + (Math.random() - 0.5) * 0.4;
        plexNodes.push({
          x: sx,
          y: sy,
          baseX: sx + Math.cos(childAngle) * childDist,
          baseY: sy + Math.sin(childAngle) * childDist,
          born: frameCount + i * 30 + 15,
          branch: branchId,
          parentIdx: seedIdx,
          noiseOffX: Math.random() * 1000,
          noiseOffY: Math.random() * 1000,
          growProgress: 0,
          lineWidth: 4.5 + Math.random() * 0.8,
          targetNavId: targetId,
          sourceNavId: nodeId,
          groupId: currentGroupId,
          isAnchor: false,
        });
        lastSpawn.set(branchId, frameCount + i * 30 + 15);
      }
    } else {
      // HOME, LAB, STACK, CONTACT: directional branches (no target)
      for (let i = 0; i < config.branchCount; i++) {
        const branchId = branchCounter++;
        // Spread branches apart: one goes left of center, other goes right
        const spread = (i === 0 ? -1 : 1) * (0.3 + Math.random() * 0.7) * config.deviation;
        const angle = config.baseAngle + spread;
        const seedDist = 12 + Math.random() * 8;
        const seedIdx = plexNodes.length;

        plexNodes.push({
          x: sx,
          y: sy,
          baseX: sx + Math.cos(angle) * seedDist,
          baseY: sy + Math.sin(angle) * seedDist,
          born: frameCount + i * 40,
          branch: branchId,
          parentIdx: -1,
          noiseOffX: Math.random() * 1000,
          noiseOffY: Math.random() * 1000,
          growProgress: 1,
          lineWidth: 5 + Math.random() * 1,
          targetNavId: '',
          sourceNavId: nodeId,
          groupId: currentGroupId,
          isAnchor: false,
        });

        const childDist = 55 + Math.random() * 45;
        const childAngle = angle + (Math.random() - 0.5) * 0.5;
        plexNodes.push({
          x: sx,
          y: sy,
          baseX: sx + Math.cos(childAngle) * childDist,
          baseY: sy + Math.sin(childAngle) * childDist,
          born: frameCount + i * 40 + 15,
          branch: branchId,
          parentIdx: seedIdx,
          noiseOffX: Math.random() * 1000,
          noiseOffY: Math.random() * 1000,
          growProgress: 0,
          lineWidth: 4.5 + Math.random() * 0.8,
          targetNavId: '',
          sourceNavId: nodeId,
          groupId: currentGroupId,
          isAnchor: false,
        });
        lastSpawn.set(branchId, frameCount + i * 40 + 15);
      }
    }
  }

  /** Spawn node — directional or target-seeking depending on source config */
  function spawnNode(parentIdx: number, vw: number, vh: number): void {
    const parent = plexNodes[parentIdx];
    if (parent.isAnchor) return;

    const branch = parent.branch;
    const branchNodes = plexNodes.filter((n) => n.branch === branch);
    if (branchNodes.length >= MAX_NODES_PER_BRANCH) return;

    const config = growConfig[parent.sourceNavId];
    const hasTarget = parent.targetNavId !== '';
    const margin = 40;
    const depth = branchNodes.length;
    const lw = Math.max(2, 5.5 - depth * 0.4 + (Math.random() - 0.5) * 0.8);

    if (hasTarget && !anchoredBranches.has(branch)) {
      // ABOUT branches: target-seeking + anchoring
      const target = navMap[parent.targetNavId];
      const tx = target.x * vw;
      const ty = target.y * vh;
      const distToTarget = Math.sqrt((tx - parent.baseX) ** 2 + (ty - parent.baseY) ** 2);

      if (distToTarget < 120) {
        plexNodes.push({
          x: parent.x,
          y: parent.y,
          baseX: tx,
          baseY: ty,
          born: frameCount,
          branch,
          parentIdx,
          noiseOffX: Math.random() * 1000,
          noiseOffY: Math.random() * 1000,
          growProgress: 0,
          lineWidth: 2.5,
          targetNavId: parent.targetNavId,
          sourceNavId: parent.sourceNavId,
          groupId: parent.groupId,
          isAnchor: true,
        });
        anchoredBranches.add(branch);
        reachedNavIds.add(parent.targetNavId);
        return;
      }

      const toTargetAngle = Math.atan2(ty - parent.baseY, tx - parent.baseX);
      const prevAngle =
        parent.parentIdx >= 0
          ? Math.atan2(
              parent.baseY - plexNodes[parent.parentIdx].baseY,
              parent.baseX - plexNodes[parent.parentIdx].baseX
            )
          : toTargetAngle;
      const angle = toTargetAngle * 0.55 + prevAngle * 0.45 + (Math.random() - 0.5) * 0.9;
      const dist = 55 + Math.random() * 55;

      plexNodes.push({
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
        targetNavId: parent.targetNavId,
        sourceNavId: parent.sourceNavId,
        groupId: parent.groupId,
        isAnchor: false,
      });

      if (Math.random() < 0.45 && depth < MAX_NODES_PER_BRANCH - 1) {
        const fa = angle + (Math.random() > 0.5 ? 1 : -1) * (0.4 + Math.random() * 0.5);
        const fd = 40 + Math.random() * 45;
        plexNodes.push({
          x: parent.x,
          y: parent.y,
          baseX: Math.max(margin, Math.min(vw - margin, parent.baseX + Math.cos(fa) * fd)),
          baseY: Math.max(margin, Math.min(vh - margin, parent.baseY + Math.sin(fa) * fd)),
          born: frameCount + 50,
          branch,
          parentIdx,
          noiseOffX: Math.random() * 1000,
          noiseOffY: Math.random() * 1000,
          growProgress: 0,
          lineWidth: Math.max(1.5, lw - 0.4),
          targetNavId: parent.targetNavId,
          sourceNavId: parent.sourceNavId,
          groupId: parent.groupId,
          isAnchor: false,
        });
      }
    } else {
      // Directional growth (HOME/LAB/STACK/CONTACT) or post-anchor branching
      const prevAngle =
        parent.parentIdx >= 0
          ? Math.atan2(
              parent.baseY - plexNodes[parent.parentIdx].baseY,
              parent.baseX - plexNodes[parent.parentIdx].baseX
            )
          : config.baseAngle;

      // Clamp angle within the allowed cone
      let angle = prevAngle + (Math.random() - 0.5) * 1.2;
      // Normalize to [-PI, PI]
      let diff = angle - config.baseAngle;
      while (diff > Math.PI) diff -= 2 * Math.PI;
      while (diff < -Math.PI) diff += 2 * Math.PI;
      if (Math.abs(diff) > config.deviation) {
        angle = config.baseAngle + Math.sign(diff) * config.deviation * (0.6 + Math.random() * 0.4);
      }

      const dist = 50 + Math.random() * 55;
      plexNodes.push({
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
        targetNavId: parent.targetNavId,
        sourceNavId: parent.sourceNavId,
        groupId: parent.groupId,
        isAnchor: false,
      });

      // 45% fork
      if (Math.random() < 0.45 && depth < MAX_NODES_PER_BRANCH - 1) {
        let fa = angle + (Math.random() > 0.5 ? 1 : -1) * (0.3 + Math.random() * 0.5);
        let fDiff = fa - config.baseAngle;
        while (fDiff > Math.PI) fDiff -= 2 * Math.PI;
        while (fDiff < -Math.PI) fDiff += 2 * Math.PI;
        if (Math.abs(fDiff) > config.deviation) {
          fa = config.baseAngle + Math.sign(fDiff) * config.deviation * (0.5 + Math.random() * 0.5);
        }
        const fd = 40 + Math.random() * 45;
        plexNodes.push({
          x: parent.x,
          y: parent.y,
          baseX: Math.max(margin, Math.min(vw - margin, parent.baseX + Math.cos(fa) * fd)),
          baseY: Math.max(margin, Math.min(vh - margin, parent.baseY + Math.sin(fa) * fd)),
          born: frameCount + 50,
          branch,
          parentIdx,
          noiseOffX: Math.random() * 1000,
          noiseOffY: Math.random() * 1000,
          growProgress: 0,
          lineWidth: Math.max(1.5, lw - 0.4),
          targetNavId: parent.targetNavId,
          sourceNavId: parent.sourceNavId,
          groupId: parent.groupId,
          isAnchor: false,
        });
      }
    }
  }

  // ── Lang→ALL branches (5 branches to every nav node) ──────
  function spawnLangBranches(vw: number, vh: number): void {
    if (langBranchSpawned) return;
    langBranchSpawned = true;

    currentGroupId++;
    const gid = currentGroupId;
    activeGroupId = gid;

    const sx = langNode.cx * vw;
    const sy = langNode.cy * vh;

    const targets = ['home', 'lab', 'stack', 'contact', 'about'];
    for (let ti = 0; ti < targets.length; ti++) {
      const targetId = targets[ti];
      const targetItem = navMap[targetId];
      const branchId = branchCounter++;
      const tx = targetItem.x * vw;
      const ty = targetItem.y * vh;
      const isAbout = targetId === 'about';
      const srcId = isAbout ? '__lang_b__' : '__lang__';

      const angle = Math.atan2(ty - sy, tx - sx);
      const totalDist = Math.sqrt((tx - sx) ** 2 + (ty - sy) ** 2);
      const steps = Math.max(4, Math.floor(totalDist / 70));
      const stagger = ti * 12; // stagger branches

      let prevIdx = -1;
      for (let i = 0; i < steps; i++) {
        const t = (i + 1) / steps;
        const wobble = i < steps - 1 ? (Math.random() - 0.5) * 30 : 0;
        const perpAngle = angle + Math.PI / 2;
        const nx = sx + (tx - sx) * t + Math.cos(perpAngle) * wobble;
        const ny = sy + (ty - sy) * t + Math.sin(perpAngle) * wobble;
        const idx = plexNodes.length;

        plexNodes.push({
          x: sx,
          y: sy,
          baseX: nx,
          baseY: ny,
          born: frameCount + stagger + i * 12,
          branch: branchId,
          parentIdx: prevIdx === -1 ? -1 : prevIdx,
          noiseOffX: Math.random() * 1000,
          noiseOffY: Math.random() * 1000,
          growProgress: prevIdx === -1 ? 1 : 0,
          lineWidth: Math.max(1.5, 2.2 - i * 0.15),
          targetNavId: targetId,
          sourceNavId: srcId,
          groupId: gid,
          isAnchor: i === steps - 1,
        });
        prevIdx = idx;
      }
      lastSpawn.set(branchId, frameCount + stagger + steps * 12);
    }
  }

  // ── Animation ──────────────────────────────────────────────

  function animate(): void {
    if (!canvasEl || !overlayEl) return;
    const ctx = canvasEl.getContext('2d', { alpha: true });
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = canvasEl.width / dpr;
    const h = canvasEl.height / dpr;

    mouseX += (rawMouseX - mouseX) * MOUSE_LERP;
    mouseY += (rawMouseY - mouseY) * MOUSE_LERP;
    const mx = mouseX * w;
    const my = mouseY * h;

    ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
    ctx.save();
    ctx.scale(dpr, dpr);
    frameCount++;

    // Video stall watchdog (see declaration above).
    if (videoPlaying && !videoEnded && videoEl) {
      const t = videoEl.currentTime;
      if (Math.abs(t - watchdogLastT) < 0.001) {
        watchdogStill++;
        if (watchdogStill === 90) {
          console.warn(
            '[constellation] brain video stalled — forcing end state',
            JSON.stringify({
              t,
              readyState: videoEl.readyState,
              networkState: videoEl.networkState,
              rate: videoEl.playbackRate,
              paused: videoEl.paused,
            })
          );
          videoEnded = true;
          videoPlayedOnce = true;
          videoSlowed = false;
          try {
            videoEl.pause();
            videoEl.currentTime = videoEl.duration || t;
          } catch {
            // A broken pipeline may refuse the seek — the post-ended dark
            // overlay covers the frozen frame either way.
          }
        }
      } else {
        watchdogLastT = t;
        watchdogStill = 0;
      }
    }

    // Flush pending branches once video ends
    if (videoEnded && pendingBranches.size > 0) {
      for (const nodeId of pendingBranches) {
        addBranches(nodeId, w, h);
      }
      pendingBranches.clear();
    }

    // Spawn lang branches on first hover
    if (isLangHov && !langBranchSpawned) {
      spawnLangBranches(w, h);
    }

    // === 1) SPAWN — new nodes per branch ===
    const branches = new Set(plexNodes.map((n) => n.branch));
    for (const b of branches) {
      // Lang branches are static connections — don't spawn new nodes
      const sampleNode = plexNodes.find((n) => n.branch === b);
      if (
        sampleNode &&
        (sampleNode.sourceNavId === '__lang__' || sampleNode.sourceNavId === '__lang_b__')
      )
        continue;

      const ls = lastSpawn.get(b) ?? 0;
      if (frameCount - ls >= SPAWN_INTERVAL) {
        const bNodes = plexNodes.filter((n) => n.branch === b && frameCount >= n.born);
        if (bNodes.length === 0) continue;

        if (anchoredBranches.has(b)) {
          // Branch reached target → pick a random non-anchor settled node to fork from
          const eligible = bNodes.filter((n) => !n.isAnchor && n.growProgress >= 0.9);
          if (eligible.length > 0) {
            const pick = eligible[Math.floor(Math.random() * eligible.length)];
            spawnNode(plexNodes.indexOf(pick), w, h);
            lastSpawn.set(b, frameCount);
          }
        } else {
          // Branch still growing → spawn from tip (last node)
          if (bNodes[bNodes.length - 1].growProgress >= 0.9) {
            spawnNode(plexNodes.indexOf(bNodes[bNodes.length - 1]), w, h);
            lastSpawn.set(b, frameCount);
          }
        }
      }
    }

    // === 2) UPDATE POSITIONS ===
    for (const node of plexNodes) {
      if (frameCount < node.born) continue;
      const age = frameCount - node.born;

      // Speed: lang branches 1.8× faster, active group fast, others 8× slower
      const isLangBranch = node.sourceNavId === '__lang__' || node.sourceNavId === '__lang_b__';
      const speed = isLangBranch
        ? GROW_SPEED_ACTIVE * 1.8
        : node.groupId === activeGroupId
          ? GROW_SPEED_ACTIVE
          : GROW_SPEED_SLOW;

      if (node.growProgress < 1) {
        node.growProgress = Math.min(1, node.growProgress + speed);
        const eased = 1 - (1 - node.growProgress) ** 3;

        if (node.parentIdx >= 0) {
          const p = plexNodes[node.parentIdx];
          node.x = p.x + (node.baseX - p.x) * eased;
          node.y = p.y + (node.baseY - p.y) * eased;
        } else {
          // Seed nodes grow from their origin
          node.x = node.baseX;
          node.y = node.baseY;
        }
      } else {
        const t = frameCount * DRIFT_SPEED;
        const dx = smoothNoise(t + node.noiseOffX, node.noiseOffY) * DRIFT_AMP;
        const dy = smoothNoise(node.noiseOffX, t + node.noiseOffY) * DRIFT_AMP;
        node.x += (node.baseX + dx - node.x) * 0.03;
        node.y += (node.baseY + dy - node.y) * 0.03;
      }
    }

    // === 3) DRAW ===

    // Dark overlay over video after it ends — smooth fade-in
    if (videoEnded) {
      darkOverlayAlpha += (0.88 - darkOverlayAlpha) * 0.035;
      ctx.fillStyle = `rgba(5, 10, 20, ${darkOverlayAlpha})`;
      ctx.fillRect(0, 0, w, h);
    }

    const closestBranch = findClosestBranch(mx, my);

    // 3a) Parent→child lines (dim by default, glow on hover)
    for (const node of plexNodes) {
      if (frameCount < node.born || node.parentIdx < 0) continue;
      const parent = plexNodes[node.parentIdx];
      if (!parent || frameCount < parent.born) continue;

      const srcConfig = growConfig[node.sourceNavId];
      const hue = srcConfig ? srcConfig.lineHue : 155;
      const isNear = node.branch === closestBranch;
      const isActive = node.groupId === activeGroupId;

      const midX = (parent.x + node.x) / 2;
      const midY = (parent.y + node.y) / 2;
      const mDist = Math.sqrt((mx - midX) ** 2 + (my - midY) ** 2);
      const glow = mDist < 200 ? (1 - mDist / 200) * 0.3 : 0;

      const baseAlpha = isActive ? (isNear ? 0.3 : 0.18) : isNear ? 0.12 : 0.06;
      const alpha = baseAlpha + glow;

      ctx.beginPath();
      ctx.moveTo(parent.x, parent.y);
      ctx.lineTo(node.x, node.y);
      ctx.strokeStyle = `hsla(${hue}, 65%, 55%, ${alpha})`;
      ctx.lineWidth = node.lineWidth * (isNear ? 1.15 : 1) * (isActive ? 1 : 0.7);
      ctx.lineCap = 'round';
      ctx.stroke();
    }

    // 3b) Cross-branch connections (capped to avoid O(n²) blowup)
    const connDistSq = CONNECTION_DIST * CONNECTION_DIST;
    const maxConnChecks = Math.min(plexNodes.length, 120);
    for (let i = 0; i < maxConnChecks; i++) {
      if (frameCount < plexNodes[i].born || plexNodes[i].growProgress < 0.8) continue;
      for (let j = i + 1; j < maxConnChecks; j++) {
        if (frameCount < plexNodes[j].born || plexNodes[j].growProgress < 0.8) continue;
        if (plexNodes[j].parentIdx === i || plexNodes[i].parentIdx === j) continue;
        if (plexNodes[i].branch === plexNodes[j].branch) continue;

        const dx = plexNodes[i].x - plexNodes[j].x;
        const dy = plexNodes[i].y - plexNodes[j].y;
        const distSq = dx * dx + dy * dy;

        if (distSq < connDistSq) {
          const dist = Math.sqrt(distSq);
          const proximity = 1 - dist / CONNECTION_DIST;
          const midX = (plexNodes[i].x + plexNodes[j].x) / 2;
          const mDist = Math.sqrt(
            (mx - midX) ** 2 + (my - (plexNodes[i].y + plexNodes[j].y) / 2) ** 2
          );
          const glow = mDist < 180 ? (1 - mDist / 180) * 0.18 : 0;
          const hue = plexNodes[i].sourceNavId === 'about' ? 220 : 155;

          ctx.beginPath();
          ctx.moveTo(plexNodes[i].x, plexNodes[i].y);
          ctx.lineTo(plexNodes[j].x, plexNodes[j].y);
          ctx.strokeStyle = `hsla(${hue}, 65%, 55%, ${proximity * 0.08 + glow})`;
          ctx.lineWidth = 2 + proximity;
          ctx.lineCap = 'round';
          ctx.stroke();
        }
      }
    }

    // 3c) Node dots — sized proportional to lineWidth, glow on hover
    for (const node of plexNodes) {
      if (frameCount < node.born) continue;
      const isNear = node.branch === closestBranch;
      const isActive = node.groupId === activeGroupId;
      const srcConfig = growConfig[node.sourceNavId];
      const hue = srcConfig ? srcConfig.lineHue : 155;
      const mDist = Math.sqrt((mx - node.x) ** 2 + (my - node.y) ** 2);
      const glow = mDist < 150 ? (1 - mDist / 150) * 0.4 : 0;

      const r = (node.lineWidth * 0.7 + 0.3) * node.growProgress * (isActive ? 1 : 0.8);
      const dotAlpha = (isNear ? 0.35 : 0.18) + glow * 0.3;

      if (r > 0.5) {
        if (glow > 0.05) {
          ctx.beginPath();
          ctx.arc(node.x, node.y, r + 6, 0, Math.PI * 2);
          ctx.fillStyle = `hsla(${hue}, 65%, 55%, ${glow * 0.1})`;
          ctx.fill();
        }
        ctx.beginPath();
        ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
        ctx.fillStyle = `hsla(${hue}, 65%, 58%, ${dotAlpha})`;
        ctx.fill();
      }

      if (node.growProgress < 1 && node.growProgress > 0.1 && isActive) {
        const pulse = Math.sin(frameCount * 0.08) * 0.12 + 0.15;
        ctx.beginPath();
        ctx.arc(node.x, node.y, r + 4, 0, Math.PI * 2);
        ctx.fillStyle = `hsla(${hue}, 70%, 60%, ${pulse * node.growProgress})`;
        ctx.fill();
      }
    }

    // === 4) NAV DOTS & LABELS ===
    // During video: hide nav dots (they’re part of the video animation)
    // After video: show dots + labels on hover/activation
    if (!videoPlaying || videoEnded) {
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';

      for (const item of navItems) {
        const nx = item.x * w;
        const ny = item.y * h;
        const isHov = hoveredNode === item.id;
        const isLit = activatedNavIds.has(item.id) || reachedNavIds.has(item.id);
        const lbl = lang === 'ru' ? item.labelRU : item.labelEN;
        const xFrac = nx / w;
        const hue = 155 + (220 - 155) * xFrac;

        const idx = navItems.indexOf(item);

        let dotR: number, dotGlowR: number, dotHue: number, dotLight: number, dotAlpha: number;

        if (isHov) {
          dotR = 14;
          dotGlowR = 40;
          dotHue = 210;
          dotLight = 72;
          dotAlpha = 1;
        } else if (isLit) {
          dotR = 12;
          dotGlowR = 32;
          dotHue = 215;
          dotLight = 68;
          dotAlpha = 0.9;
        } else {
          const breathe = Math.sin(frameCount * 0.025 + idx * 1.3);
          dotR = 14 + breathe * 4;
          dotGlowR = 28 + breathe * 8;
          dotHue = 215;
          dotLight = videoEnded ? 72 : 60 + breathe * 6;
          dotAlpha = videoEnded ? 0.85 + breathe * 0.1 : 0.55 + breathe * 0.15;
        }

        // Glow halo
        ctx.beginPath();
        ctx.arc(nx, ny, dotGlowR, 0, Math.PI * 2);
        const grad = ctx.createRadialGradient(nx, ny, 0, nx, ny, dotGlowR);
        const glowAlpha = isHov
          ? 0.35
          : isLit
            ? 0.2
            : (videoEnded ? 0.18 : 0.06) + Math.sin(frameCount * 0.025 + idx * 1.3) * 0.04;
        grad.addColorStop(0, `hsla(${dotHue}, 70%, 60%, ${glowAlpha})`);
        grad.addColorStop(1, `hsla(${dotHue}, 70%, 60%, 0)`);
        ctx.fillStyle = grad;
        ctx.fill();

        // Pulse ring for activated/reached items
        if (isLit && !isHov) {
          const pulse = Math.sin(frameCount * 0.03 + idx * 1.5) * 0.08 + 0.12;
          ctx.beginPath();
          ctx.arc(nx, ny, dotR + 6, 0, Math.PI * 2);
          ctx.strokeStyle = `hsla(${dotHue}, 70%, 60%, ${pulse})`;
          ctx.lineWidth = 1;
          ctx.stroke();
        }

        // Core dot
        if (isHov) {
          // Hover: blue glow + black outline
          ctx.shadowColor = `hsla(215, 80%, 55%, 0.6)`;
          ctx.shadowBlur = 18;
          ctx.beginPath();
          ctx.arc(nx, ny, dotR, 0, Math.PI * 2);
          ctx.fillStyle = `hsla(${dotHue}, 70%, ${dotLight}%, ${dotAlpha})`;
          ctx.fill();
          ctx.strokeStyle = `hsla(0, 0%, 0%, 0.7)`;
          ctx.lineWidth = 2;
          ctx.stroke();
          ctx.shadowColor = 'transparent';
          ctx.shadowBlur = 0;
        } else {
          // Idle/Lit: soft blurred edges via radial gradient
          const softGrad = ctx.createRadialGradient(nx, ny, 0, nx, ny, dotR + 2);
          softGrad.addColorStop(0, `hsla(${dotHue}, 70%, ${dotLight}%, ${dotAlpha})`);
          softGrad.addColorStop(0.7, `hsla(${dotHue}, 70%, ${dotLight}%, ${dotAlpha * 0.8})`);
          softGrad.addColorStop(1, `hsla(${dotHue}, 70%, ${dotLight}%, 0)`);
          ctx.beginPath();
          ctx.arc(nx, ny, dotR + 2, 0, Math.PI * 2);
          ctx.fillStyle = softGrad;
          ctx.fill();
        }

        // Labels — all buttons after video ended
        if (videoEnded) {
          const fontSize = isHov ? 20 : 16;
          ctx.font = `500 ${fontSize}px 'JetBrains Mono', 'SF Mono', monospace`;

          const gap = isHov ? 20 : 16;
          let lx = nx,
            ly = ny;

          switch (item.labelPos) {
            case 'top':
              ctx.textAlign = 'center';
              ctx.textBaseline = 'bottom';
              ly = ny - gap;
              break;
            case 'bottom':
              ctx.textAlign = 'center';
              ctx.textBaseline = 'top';
              ly = ny + gap;
              break;
            case 'left':
              ctx.textAlign = 'right';
              ctx.textBaseline = 'middle';
              lx = nx - gap;
              break;
            case 'right':
              ctx.textAlign = 'left';
              ctx.textBaseline = 'middle';
              lx = nx + gap;
              break;
          }

          // Glassmorphism background for About
          if (item.labelBg) {
            const metrics = ctx.measureText(lbl);
            const tw = metrics.width;
            const th = fontSize;
            const padX = 10,
              padY = 6,
              radius = 6;
            let bgX = lx - tw / 2 - padX;
            let bgY = ly - padY;
            if (item.labelPos === 'top') bgY = ly - th - padY;
            if (item.labelPos === 'left') {
              bgX = lx - tw - padX;
              bgY = ly - th / 2 - padY;
            }
            if (item.labelPos === 'right') {
              bgX = lx - padX;
              bgY = ly - th / 2 - padY;
            }
            const bgW = tw + padX * 2;
            const bgH = th + padY * 2;

            ctx.beginPath();
            ctx.roundRect(bgX, bgY, bgW, bgH, radius);
            ctx.fillStyle = `hsla(210, 60%, 25%, ${isHov ? 0.55 : 0.35})`;
            ctx.fill();
            ctx.strokeStyle = `hsla(210, 50%, 45%, ${isHov ? 0.3 : 0.15})`;
            ctx.lineWidth = 1;
            ctx.stroke();
          }

          ctx.shadowColor = `hsla(${hue}, 70%, 60%, ${isHov ? 0.7 : 0.4})`;
          ctx.shadowBlur = isHov ? 20 : 12;
          ctx.fillStyle = `hsla(0, 0%, 100%, ${isHov ? 1 : 0.92})`;
          ctx.fillText(lbl, lx, ly);
          ctx.shadowColor = 'transparent';
          ctx.shadowBlur = 0;
        }
      } // end for navItems
    } // end if !videoPlaying || videoEnded

    // === 5) BINARY STAR — LANGUAGE SWITCHER (Eclipsing Binary) ===
    // Always rendered so the user can switch language immediately
    {
      const lcx = langNode.cx * w;
      const lcy = langNode.cy * h;
      // Smooth speed lerp — prevents jarring position jump on hover
      const targetSpeed = isLangHov ? 0.022 : 0.008;
      langOrbitSpeed += (targetSpeed - langOrbitSpeed) * 0.04;
      langOrbitAngle += langOrbitSpeed;
      const orbitAngle = langOrbitAngle;
      const orbitR = langNode.orbitR;

      // Active star position (small, bright — "you're here")
      const actX = lcx + Math.cos(orbitAngle) * orbitR;
      const actY = lcy + Math.sin(orbitAngle) * orbitR;

      // Companion star position (large, dim — "go here")
      const compX = lcx + Math.cos(orbitAngle + Math.PI) * orbitR;
      const compY = lcy + Math.sin(orbitAngle + Math.PI) * orbitR;

      // Breathing pulsation for companion
      const breathe = Math.sin(frameCount * 0.03) * 0.08;
      const compR = (isLangHov ? 13 : 11) * (1 + breathe);

      // --- Dashed orbital line with animated dashOffset ---
      ctx.save();
      ctx.beginPath();
      ctx.arc(lcx, lcy, orbitR, 0, Math.PI * 2);
      ctx.setLineDash([4, 6]);
      ctx.lineDashOffset = -frameCount * 0.5;
      ctx.strokeStyle = `hsla(185, 50%, 55%, ${isLangHov ? 0.2 : 0.1})`;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();

      // --- Active star comet trail (4 ghost dots) ---
      const trailCount = 4;
      for (let i = 1; i <= trailCount; i++) {
        const trailAngle = orbitAngle - i * 0.18;
        const tx = lcx + Math.cos(trailAngle) * orbitR;
        const ty = lcy + Math.sin(trailAngle) * orbitR;
        const trailR = 3.5 - i * 0.6;
        const trailAlpha = (0.35 - i * 0.07) * (isLangHov ? 1.3 : 1);
        if (trailR > 0.5) {
          ctx.beginPath();
          ctx.arc(tx, ty, trailR, 0, Math.PI * 2);
          ctx.fillStyle = `hsla(185, 80%, 65%, ${Math.max(0, trailAlpha)})`;
          ctx.fill();
        }
      }

      // --- Active star (small, intense) ---
      // Glow halo
      const actGlow = ctx.createRadialGradient(actX, actY, 0, actX, actY, 16);
      actGlow.addColorStop(0, `hsla(185, 80%, 65%, ${isLangHov ? 0.35 : 0.25})`);
      actGlow.addColorStop(0.5, `hsla(185, 80%, 65%, 0.08)`);
      actGlow.addColorStop(1, `hsla(185, 80%, 65%, 0)`);
      ctx.beginPath();
      ctx.arc(actX, actY, 16, 0, Math.PI * 2);
      ctx.fillStyle = actGlow;
      ctx.fill();
      // Core dot
      ctx.beginPath();
      ctx.arc(actX, actY, 5, 0, Math.PI * 2);
      ctx.fillStyle = `hsla(185, 85%, 70%, 0.92)`;
      ctx.fill();
      // Tiny bright center
      ctx.beginPath();
      ctx.arc(actX, actY, 2, 0, Math.PI * 2);
      ctx.fillStyle = `hsla(185, 90%, 88%, 0.9)`;
      ctx.fill();

      // --- Companion star (large, semi-transparent, text inside) ---
      // Outer glow
      const compGlow = ctx.createRadialGradient(
        compX,
        compY,
        compR * 0.5,
        compX,
        compY,
        compR + 14
      );
      compGlow.addColorStop(0, `hsla(210, 60%, 55%, ${isLangHov ? 0.22 : 0.1})`);
      compGlow.addColorStop(1, `hsla(210, 60%, 55%, 0)`);
      ctx.beginPath();
      ctx.arc(compX, compY, compR + 14, 0, Math.PI * 2);
      ctx.fillStyle = compGlow;
      ctx.fill();
      // Body
      ctx.beginPath();
      ctx.arc(compX, compY, compR, 0, Math.PI * 2);
      ctx.fillStyle = `hsla(210, 35%, 18%, ${isLangHov ? 0.75 : 0.55})`;
      ctx.fill();
      // Border
      ctx.strokeStyle = `hsla(185, 55%, 55%, ${isLangHov ? 0.5 : 0.2})`;
      ctx.lineWidth = isLangHov ? 1.5 : 1;
      ctx.stroke();
      // Text label inside
      ctx.font = `700 ${isLangHov ? 10 : 9}px 'JetBrains Mono', 'SF Mono', monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = `hsla(185, 50%, 72%, ${isLangHov ? 0.95 : 0.65})`;
      ctx.fillText(altLang.toUpperCase(), compX, compY + 0.5);

      // Pulse ring on companion when hovered
      if (isLangHov) {
        const pulse = Math.sin(frameCount * 0.06) * 0.12 + 0.22;
        ctx.beginPath();
        ctx.arc(compX, compY, compR + 8, 0, Math.PI * 2);
        ctx.strokeStyle = `hsla(185, 70%, 60%, ${pulse})`;
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      // --- Hover label (below) ---
      if (isLangHov) {
        ctx.font = `500 13px 'JetBrains Mono', 'SF Mono', monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        const labelText = `→ ${altLang.toUpperCase()}`;
        const labelX = lcx;
        const labelY = lcy + orbitR + 16;
        ctx.shadowColor = `hsla(185, 70%, 60%, 0.5)`;
        ctx.shadowBlur = 14;
        ctx.fillStyle = `hsla(0, 0%, 100%, 0.92)`;
        ctx.fillText(labelText, labelX, labelY);
        ctx.shadowColor = 'transparent';
        ctx.shadowBlur = 0;
      }

      // --- Flash animation on click ---
      if (langFlashActive) {
        const elapsed = frameCount - langFlashStart;
        const duration = 24;
        if (elapsed < duration) {
          const t = elapsed / duration;
          const eased = 1 - (1 - t) ** 3; // ease-out cubic
          const flashR = eased * 65;
          const flashAlpha = 1 - eased;
          // Expanding white ring
          ctx.beginPath();
          ctx.arc(compX, compY, flashR, 0, Math.PI * 2);
          ctx.strokeStyle = `hsla(185, 90%, 80%, ${flashAlpha * 0.7})`;
          ctx.lineWidth = 3 * (1 - t);
          ctx.stroke();
          // Core flare
          ctx.beginPath();
          ctx.arc(compX, compY, compR * (1 - t * 0.3), 0, Math.PI * 2);
          ctx.fillStyle = `hsla(185, 90%, 85%, ${flashAlpha * 0.8})`;
          ctx.fill();
          // Central white burst
          ctx.beginPath();
          ctx.arc(compX, compY, 4 + 16 * (1 - t), 0, Math.PI * 2);
          ctx.fillStyle = `hsla(0, 0%, 100%, ${flashAlpha})`;
          ctx.fill();
        }
      }
    }

    // === 6) BUILD LOG — special route node (bottom-right) ===
    {
      const gcx = logNode.cx * w;
      const gcy = logNode.cy * h;
      const breathe = Math.sin(frameCount * 0.03) * 0.08;
      const coreR = (isLogHov ? 7 : 5.5) * (1 + breathe);

      // Glow halo
      const glow = ctx.createRadialGradient(gcx, gcy, 0, gcx, gcy, 22);
      glow.addColorStop(0, `hsla(155, 75%, 60%, ${isLogHov ? 0.35 : 0.22})`);
      glow.addColorStop(0.5, `hsla(155, 75%, 60%, 0.07)`);
      glow.addColorStop(1, `hsla(155, 75%, 60%, 0)`);
      ctx.beginPath();
      ctx.arc(gcx, gcy, 22, 0, Math.PI * 2);
      ctx.fillStyle = glow;
      ctx.fill();

      // Core dot
      ctx.beginPath();
      ctx.arc(gcx, gcy, coreR, 0, Math.PI * 2);
      ctx.fillStyle = `hsla(155, 80%, 65%, ${isLogHov ? 0.95 : 0.8})`;
      ctx.fill();
      // Bright center
      ctx.beginPath();
      ctx.arc(gcx, gcy, 2, 0, Math.PI * 2);
      ctx.fillStyle = `hsla(155, 90%, 88%, 0.9)`;
      ctx.fill();

      // Pulse ring on hover
      if (isLogHov) {
        const pulse = Math.sin(frameCount * 0.06) * 0.12 + 0.22;
        ctx.beginPath();
        ctx.arc(gcx, gcy, coreR + 9, 0, Math.PI * 2);
        ctx.strokeStyle = `hsla(155, 70%, 60%, ${pulse})`;
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      // Label (always visible, brighter on hover)
      ctx.font = `500 12px 'JetBrains Mono', 'SF Mono', monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      const logLabel = lang === 'ru' ? 'ЖУРНАЛ' : 'LOG';
      ctx.shadowColor = isLogHov ? `hsla(155, 70%, 60%, 0.5)` : 'transparent';
      ctx.shadowBlur = isLogHov ? 12 : 0;
      ctx.fillStyle = `hsla(0, 0%, 100%, ${isLogHov ? 0.95 : 0.6})`;
      ctx.fillText(logLabel, gcx, gcy + coreR + 8);
      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;

      // Flash animation on click
      if (logFlashActive) {
        const elapsed = frameCount - logFlashStart;
        const duration = 24;
        if (elapsed < duration) {
          const tt = elapsed / duration;
          const eased = 1 - (1 - tt) ** 3;
          ctx.beginPath();
          ctx.arc(gcx, gcy, eased * 60, 0, Math.PI * 2);
          ctx.strokeStyle = `hsla(155, 90%, 80%, ${(1 - eased) * 0.7})`;
          ctx.lineWidth = 3 * (1 - tt);
          ctx.stroke();
        }
      }
    }

    ctx.restore();
    animFrameId = requestAnimationFrame(animate);
  }

  // ── Mouse tracking ─────────────────────────────────────────

  let prevHovered: string | null = null;

  function onMouseMove(e: MouseEvent): void {
    if (!overlayEl || !canvasEl) return;
    // Mobile taps replay as synthetic mousemoves; the canvas hit-testing
    // below would then arm hoveredNode/isLangHov/isLogHov against node
    // positions that only exist in the DESKTOP canvas layout (the canvas is
    // display:none on phones) — a background tap could navigate somewhere
    // random instead of just closing. handleClick's else-branch (onClose)
    // is still wanted on mobile, so only the hit-testing is gated.
    if (isMobileNav) return;
    const rect = overlayEl.getBoundingClientRect();
    rawMouseX = (e.clientX - rect.left) / rect.width;
    rawMouseY = (e.clientY - rect.top) / rect.height;

    const hitR = 50;
    let found: string | null = null;
    for (const item of navItems) {
      const nx = item.x * rect.width;
      const ny = item.y * rect.height;
      const dx = e.clientX - rect.left - nx;
      const dy = e.clientY - rect.top - ny;
      if (Math.sqrt(dx * dx + dy * dy) < hitR) {
        found = item.id;
        break;
      }
    }

    // Binary Star hover detection (50px hitbox around center)
    const langCX = langNode.cx * rect.width;
    const langCY = langNode.cy * rect.height;
    const langDist = Math.sqrt(
      (e.clientX - rect.left - langCX) ** 2 + (e.clientY - rect.top - langCY) ** 2
    );
    isLangHov = langDist < 50;

    // Build Log node hover detection (50px hitbox around center)
    const logCX = logNode.cx * rect.width;
    const logCY = logNode.cy * rect.height;
    const logDist = Math.sqrt(
      (e.clientX - rect.left - logCX) ** 2 + (e.clientY - rect.top - logCY) ** 2
    );
    isLogHov = logDist < 50;

    hoveredNode = found;

    if (hoveredNode !== prevHovered) {
      if (hoveredNode) {
        // First hover on any dot → start the brain video
        if (!videoPlaying && videoEl) {
          videoPlaying = true;
          videoEl.currentTime = 0;
          videoEl.playbackRate = 3.5;
          videoEl.play().catch(() => {
            /* autoplay blocked */
          });
        }

        if (videoEnded) {
          // Video done → grow branches immediately
          const dpr = Math.min(window.devicePixelRatio || 1, 2);
          addBranches(hoveredNode, canvasEl.width / dpr, canvasEl.height / dpr);
        } else {
          // During video → queue for later
          pendingBranches.add(hoveredNode);
        }
      } else {
        activeGroupId = -1;
      }
      prevHovered = hoveredNode;
    }
  }

  function handleClick(e: MouseEvent): void {
    // Check Binary Star click first
    if (isLangHov && !langFlashActive) {
      e.stopPropagation();
      triggerLangSwitch();
      return;
    }
    // Build Log node — navigates to a separate route, not an on-page anchor
    if (isLogHov && !logFlashActive) {
      e.stopPropagation();
      triggerLogNav();
      return;
    }
    if (hoveredNode) navigateTo(navMap[hoveredNode].target);
    else onClose();
  }

  function triggerLangSwitch(): void {
    langFlashActive = true;
    langFlashStart = frameCount;
    // Mobile: the flash canvas is display:none, so the 300ms delay shows
    // nothing — and if the navigation stalls on a bad connection the dialog
    // stayed mounted with the focus trap armed and aria-expanded stuck.
    // Close immediately; the timeout still fires and navigates.
    if (isMobileNav) onClose();
    setTimeout(() => {
      window.location.href = `/${altLang}/`;
    }, 300);
  }

  function triggerLogNav(): void {
    logFlashActive = true;
    logFlashStart = frameCount;
    if (isMobileNav) onClose(); // see triggerLangSwitch
    setTimeout(() => {
      window.location.href = `/${lang}/log/`;
    }, 300);
  }

  // ── Navigation ─────────────────────────────────────────────

  function navigateTo(target: string): void {
    const lenis = (
      window as Window & {
        lenisInstance?: { scrollTo: (t: string, o?: Record<string, unknown>) => void };
      }
    ).lenisInstance;
    if (lenis) lenis.scrollTo(target, { duration: 2 });
    else document.querySelector(target)?.scrollIntoView({ behavior: 'smooth' });
    onClose();
  }

  function onClose(): void {
    isOpen = false;
    plexNodes = [];
    hoveredNode = null;
    prevHovered = null;
    activeGroupId = -1;
    lastSpawn.clear();
    activatedNavIds.clear();
    reachedNavIds.clear();
    anchoredBranches.clear();
    sourceToGroupId.clear();
    videoPlaying = false;
    videoEnded = false;
    watchdogLastT = -1;
    watchdogStill = 0;
    canvasOpacity = 1;
    pendingBranches.clear();
    darkOverlayAlpha = 0;
    isLangHov = false;
    langFlashActive = false;
    langBranchSpawned = false;
    langOrbitAngle = 0;
    langOrbitSpeed = 0.008;
    isLogHov = false;
    logFlashActive = false;
    if (videoEl) {
      videoEl.pause();
      videoEl.currentTime = 0;
    }
    if (animFrameId !== null) {
      cancelAnimationFrame(animFrameId);
      animFrameId = null;
    }
    window.dispatchEvent(new CustomEvent('vkv:constellation-close'));
  }

  function openNav(): void {
    isOpen = true;
    plexNodes = [];
    frameCount = 0;
    hoveredNode = null;
    prevHovered = null;
    activeGroupId = -1;
    currentGroupId = 0;
    branchCounter = 0;
    lastSpawn.clear();
    activatedNavIds.clear();
    reachedNavIds.clear();
    anchoredBranches.clear();
    sourceToGroupId.clear();
    videoPlaying = false;
    videoEnded = false;
    watchdogLastT = -1;
    watchdogStill = 0;
    canvasOpacity = 1;
    pendingBranches.clear();
    darkOverlayAlpha = 0;
    requestAnimationFrame(() => {
      setupCanvas();
      if (videoPlayedOnce) {
        // Skip video on re-open: jump to end state
        videoPlaying = true;
        videoEnded = true;
        darkOverlayAlpha = 0.88;
        if (videoEl) {
          videoEl.currentTime = videoEl.duration || 0;
        }
      } else if (videoEl) {
        videoEl.pause();
        videoEl.currentTime = 0;
      }
      if (animFrameId !== null) cancelAnimationFrame(animFrameId);
      animFrameId = requestAnimationFrame(animate);
    });
  }

  function setupCanvas(): void {
    if (!canvasEl || !overlayEl) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = overlayEl.getBoundingClientRect();
    canvasEl.width = rect.width * dpr;
    canvasEl.height = rect.height * dpr;
    canvasEl.style.width = `${rect.width}px`;
    canvasEl.style.height = `${rect.height}px`;
  }

  // ── Effects ────────────────────────────────────────────────

  $effect(() => {
    function handleToggle(e: Event): void {
      const detail = (e as CustomEvent<{ open: boolean }>).detail;
      if (detail.open) openNav();
      else onClose();
    }
    window.addEventListener('vkv:constellation-toggle', handleToggle);
    return () => window.removeEventListener('vkv:constellation-toggle', handleToggle);
  });

  $effect(() => {
    if (!isOpen) return;

    // Full modal focus management, not just Escape. The overlay is
    // role="dialog" aria-modal="true", so a keyboard user must be moved INTO
    // it, kept inside it on Tab, and returned to the trigger on close —
    // otherwise Tab walks straight out of the modal into the page hidden
    // behind it. Same pattern SynapseTerminal already uses.
    const previouslyFocused = document.activeElement as HTMLElement | null;

    // aria-modal alone doesn't remove the page behind the dialog from the
    // accessibility tree — a screen reader's virtual cursor could still reach
    // and activate the hero language switcher through the opaque overlay.
    // Native inert on every body child except our own wrapper does. Only
    // elements WE inerted get restored, so anything already inert stays so.
    //
    // The wrapper is found by walking UP from the overlay element to the
    // body-child ancestor (the astro-island). It used to be looked up by an
    // id that existed in no markup — getElementById returned null, the
    // comparison below never matched, and the menu inerted ITSELF: it opened,
    // the canvas animated, and every mouse event inside was dead. Never
    // exclude-by-id an element you don't render.
    let overlayRoot: HTMLElement | null = overlayEl;
    while (
      overlayRoot &&
      overlayRoot.parentElement &&
      overlayRoot.parentElement !== document.body
    ) {
      overlayRoot = overlayRoot.parentElement;
    }
    // Besides inert, HIDE the page behind the opaque overlay: freshly added
    // backdrop-filter glass layers kept compositing underneath and starved
    // the brain video's frame budget on iGPU-driven laptops (playback came
    // out as torn bursts). visibility:hidden stops the compositor from
    // painting any of it; the overlay covers everything anyway.
    const inerted: HTMLElement[] = [];
    for (const child of Array.from(document.body.children)) {
      if (child instanceof HTMLElement && child !== overlayRoot && !child.inert) {
        child.inert = true;
        child.style.visibility = 'hidden';
        inerted.push(child);
      }
    }

    const focusables = (): HTMLElement[] => {
      if (!overlayEl) return [];
      return Array.from(
        overlayEl.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      ).filter((el) => el.offsetParent !== null);
    };

    // Move focus off the trigger and into the dialog.
    requestAnimationFrame(() => {
      focusables()[0]?.focus();
    });

    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (e.key !== 'Tab' || !overlayEl) return;
      const items = focusables();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (!overlayEl.contains(active)) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }

    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      // Un-inert BEFORE restoring focus — an inert element refuses focus.
      inerted.forEach((el) => {
        el.inert = false;
        el.style.visibility = '';
      });
      // Return focus to whatever opened the menu.
      if (previouslyFocused && typeof previouslyFocused.focus === 'function') {
        previouslyFocused.focus();
      }
    };
  });

  $effect(() => {
    if (!isOpen) return;
    function onResize(): void {
      setupCanvas();
    }
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  });

  $effect(() => {
    return () => {
      if (animFrameId !== null) {
        cancelAnimationFrame(animFrameId);
        animFrameId = null;
      }
    };
  });
</script>

{#if isOpen}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    bind:this={overlayEl}
    class="overlay"
    role="dialog"
    aria-modal="true"
    aria-label={t(lang, 'nav.navigationMenu')}
    onmousemove={onMouseMove}
    onclick={handleClick}
  >
    <!-- Brain morphing video layer -->
    <video
      bind:this={videoEl}
      class="brain-video"
      src="/menu-brain.mp4"
      poster="/menu-start-frame.webp"
      muted
      playsinline
      preload="auto"
      onended={() => {
        videoEnded = true;
        videoPlayedOnce = true;
        videoSlowed = false;
      }}
      ontimeupdate={() => {
        if (!videoSlowed && videoEl && videoEl.duration) {
          const progress = videoEl.currentTime / videoEl.duration;
          if (progress >= 0.5) {
            videoEl.playbackRate = 2;
            videoSlowed = true;
          }
        }
      }}
    ></video>

    <!-- End frame shown on re-open (skip video) -->
    {#if videoPlayedOnce}
      <picture>
        <source srcset="/menu-end-frame.avif" type="image/avif" />
        <source srcset="/menu-end-frame.webp" type="image/webp" />
        <img class="brain-video" src="/menu-end-frame.jpg" alt="" aria-hidden="true" />
      </picture>
    {/if}

    <canvas bind:this={canvasEl} class="nav-canvas"></canvas>

    {#each navItems as item (item.id)}
      <button
        class="a11y-btn"
        style="left: {item.x * 100}%; top: {item.y * 100}%;"
        aria-label={t(lang, 'nav.navigateTo').replace(
          '{label}',
          lang === 'ru' ? item.labelRU : item.labelEN
        )}
        onfocus={() => {
          hoveredNode = item.id;
        }}
        onblur={() => {
          hoveredNode = null;
        }}
        onclick={(e) => {
          e.stopPropagation();
          navigateTo(item.target);
        }}
      ></button>
    {/each}

    <button
      class="a11y-btn"
      style="left: {logNode.cx * 100}%; top: {logNode.cy * 100}%;"
      aria-label={lang === 'ru' ? 'Открыть журнал сборки' : 'Open Build Log'}
      onfocus={() => {
        isLogHov = true;
      }}
      onblur={() => {
        isLogHov = false;
      }}
      onclick={(e) => {
        e.stopPropagation();
        triggerLogNav();
      }}
    ></button>

    <button
      class="close-btn"
      aria-label={t(lang, 'nav.closeMenu')}
      onclick={(e) => {
        e.stopPropagation();
        onClose();
      }}
    >
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linecap="round"
        aria-hidden="true"
      >
        <path d="M18 6 6 18" /><path d="m6 6 12 12" />
      </svg>
    </button>

    <nav class="mobile-nav" aria-label={t(lang, 'nav.siteNavigation')}>
      {#each navItems as item, i (item.id)}
        <!-- stopPropagation on all three mobile buttons: without it every tap
             also bubbled to the overlay's handleClick (double-fire), matching
             the guard the a11y/close buttons already carry. -->
        <button
          class="mobile-item"
          style="animation-delay: {i * 80}ms"
          onclick={(e) => {
            e.stopPropagation();
            navigateTo(item.target);
          }}
        >
          {lang === 'ru' ? item.labelRU : item.labelEN}
        </button>
      {/each}
      <button
        class="mobile-item"
        style="animation-delay: {navItems.length * 80}ms"
        onclick={(e) => {
          e.stopPropagation();
          triggerLogNav();
        }}
      >
        {lang === 'ru' ? 'ЖУРНАЛ' : 'LOG'}
      </button>
      <button
        class="lang-switch-mobile"
        style="animation-delay: {(navItems.length + 1) * 80}ms"
        onclick={(e) => {
          e.stopPropagation();
          triggerLangSwitch();
        }}
      >
        <span class="lang-active">{lang.toUpperCase()}</span>
        <span class="lang-arrow">→</span>
        <span class="lang-alt">{altLang.toUpperCase()}</span>
      </button>
    </nav>
  </div>
{/if}

<style>
  .overlay {
    position: fixed;
    inset: 0;
    z-index: 1000;
    background: hsl(220, 20%, 3%);
    cursor: crosshair;
    animation: fade-in 0.3s ease both;
  }
  @keyframes fade-in {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }

  /* `<picture>` is inline by default — make it a transparent wrapper so the
     absolutely-positioned end-frame `<img>` inside lays out exactly as before. */
  picture {
    display: contents;
  }

  .nav-canvas {
    position: absolute;
    inset: 0;
    z-index: 5;
  }
  @media (max-width: 767px) {
    .nav-canvas {
      display: none;
    }
  }

  .brain-video {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: fill;
    z-index: 0;
    pointer-events: none;
  }
  @media (max-width: 767px) {
    .brain-video {
      display: none;
    }
  }

  .a11y-btn {
    position: absolute;
    transform: translate(-50%, -50%);
    width: 70px;
    height: 50px;
    background: none;
    border: none;
    cursor: pointer;
    opacity: 0;
    z-index: 10;
  }
  .a11y-btn:focus-visible {
    opacity: 1;
    outline: 2px solid hsla(155, 70%, 50%, 0.5);
    outline-offset: 4px;
    border-radius: 4px;
  }
  @media (max-width: 767px) {
    .a11y-btn {
      display: none;
    }
  }

  .close-btn {
    position: absolute;
    /* env(): the overlay is inset:0 over a viewport-fit=cover page — keep
       the close control out of the status-bar strip in the installed PWA. */
    top: calc(20px + env(safe-area-inset-top, 0px));
    right: calc(20px + env(safe-area-inset-right, 0px));
    z-index: 10;
    background: hsla(220, 20%, 12%, 0.5);
    border: 1px solid hsla(220, 15%, 30%, 0.3);
    border-radius: 50%;
    width: 40px;
    height: 40px;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    color: hsla(0, 0%, 100%, 0.4);
    backdrop-filter: blur(8px);
    transition:
      color 0.25s ease,
      border-color 0.25s ease,
      transform 0.25s ease;
  }
  /* The standard property, restated where the CSS minifier cannot rewrite it
     away — it collapses `backdrop-filter` into the -webkit- alias alone, which
     leaves Firefox with a flat fill. It does not collapse across an @supports
     boundary. Must stay AFTER the base rule: equal specificity, last wins. */
  @supports (backdrop-filter: blur(1px)) {
    .close-btn {
      backdrop-filter: blur(8px);
    }
  }

  .close-btn:hover {
    color: hsl(155, 70%, 60%);
    border-color: hsla(155, 60%, 50%, 0.3);
    transform: rotate(90deg);
  }

  .mobile-nav {
    display: none;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    /* Safety net, unconditional: if content ever outgrows the viewport
       (landscape, large text, a new item), it scrolls instead of clipping. */
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
  }
  @media (max-width: 767px) {
    .mobile-nav {
      display: flex;
    }
  }

  /* Short viewports (phone landscape): centering an overflowing flex column
     clips BOTH edges — switch to flex-start and tighten spacing so all items
     fit or scroll cleanly from the top. */
  @media (max-width: 767px) and (max-height: 480px) {
    .mobile-nav {
      justify-content: flex-start;
      padding-block: 16px;
    }
    .mobile-item {
      padding: 10px 24px;
    }
    .lang-switch-mobile {
      margin-top: 12px;
    }
  }

  .mobile-item {
    font-family: var(--font-mono, 'JetBrains Mono', monospace);
    font-size: 18px;
    font-weight: 500;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: hsla(0, 0%, 100%, 0.45);
    background: none;
    border: none;
    cursor: pointer;
    padding: 18px 24px;
    animation: stagger-in 0.4s ease both;
    transition: color 0.2s ease;
  }
  .mobile-item:hover {
    color: hsl(155, 70%, 60%);
  }

  /* ── Binary Star mobile lang switch ──────────────────────── */
  .lang-switch-mobile {
    font-family: var(--font-mono, 'JetBrains Mono', monospace);
    font-size: 13px;
    font-weight: 500;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    background: none;
    border: 1px solid hsla(210, 50%, 40%, 0.2);
    border-radius: 20px;
    padding: 10px 24px;
    margin-top: 24px;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 8px;
    animation: stagger-in 0.4s ease both;
    transition:
      border-color 0.25s ease,
      box-shadow 0.25s ease;
  }
  .lang-switch-mobile:hover {
    border-color: hsla(210, 60%, 55%, 0.4);
    box-shadow: 0 0 16px hsla(210, 70%, 55%, 0.15);
  }
  .lang-active {
    color: hsla(210, 70%, 65%, 0.9);
  }
  .lang-arrow {
    color: hsla(0, 0%, 100%, 0.3);
  }
  .lang-alt {
    color: hsla(0, 0%, 100%, 0.45);
  }

  @keyframes stagger-in {
    from {
      opacity: 0;
      transform: translateY(12px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .overlay {
      animation: none;
    }
    .mobile-item {
      animation: none;
      opacity: 1;
    }
    .nav-canvas {
      display: none;
    }
    .mobile-nav {
      display: flex !important;
    }
  }
</style>
