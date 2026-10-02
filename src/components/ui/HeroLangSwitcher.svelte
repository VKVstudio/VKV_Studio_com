<script lang="ts">
  /**
   * HeroLangSwitcher — Binary Star language switcher for the hero section.
   * Shows orbiting RU/EN stars in the bottom-left corner.
   * Visible only while the hero title is in the viewport.
   * No branches — just the eclipsing binary animation.
   */
  interface Props {
    lang: 'en' | 'ru';
    languageLabel: string;
  }

  let { lang, languageLabel }: Props = $props();

  const altLang = lang === 'en' ? 'ru' : 'en';

  /* ── State ─────────────────────────────────────────── */
  let canvasEl: HTMLCanvasElement | undefined = $state();
  let wrapperEl: HTMLElement | undefined = $state();
  let animFrameId: number | null = null;
  let frameCount = 0;
  let orbitAngle = 0;
  let orbitSpeed = 0.008;
  let isHov = false;
  let flashActive = false;
  let flashStart = 0;
  let visible = $state(true);

  const ORBIT_R = 18;

  /* Pointer-hover geometry, cached. onMove called getBoundingClientRect on
     EVERY mousemove — a layout read interleaved with the loop's canvas writes.
     The element is position:fixed, so its centre can only move on a resize or
     when the <640px consent-sheet offset changes; neither can happen while the
     pointer is already inside it. Measuring on resize + once per mouseenter is
     exact and costs one read per hover instead of one per pixel moved. */
  let centerX = 0;
  let centerY = 0;

  function measureCenter(): DOMRect | null {
    if (!wrapperEl) return null;
    const r = wrapperEl.getBoundingClientRect();
    centerX = r.left + r.width / 2;
    centerY = r.top + r.height / 2;
    return r; // resize() reuses it — one layout read per call, never two
  }

  /* ── Sync visibility with the hero ─────────────────────── */
  $effect(() => {
    // Same two-clause query as HeroCanvas.astro's hero--static gate — the
    // branches below MUST agree with it: on any viewport where the scrub
    // engine never runs, the desktop opacity signal is never written and
    // the switcher would float forever (that was hero-1 in portrait; a
    // rotated phone hits the identical trap through the width clause alone).
    const isMobile = window.matchMedia(
      '(max-width: 767px), ((max-height: 767px) and (pointer: coarse))'
    ).matches;

    if (isMobile) {
      // Mobile: scroll-engine.ts never runs (HeroCanvas's init() takes the
      // `.hero--static` branch), so #hero-overlay's inline opacity — the
      // desktop signal below — is never written and `visible` stayed true
      // forever: the switcher floated over About/Stack/FAQ all the way down.
      // `.hero--static` collapses the hero to one 100svh screen, so a plain
      // IntersectionObserver on it is the honest signal here. Do NOT use it
      // on desktop: the hero is 800vh there and isIntersecting would stay
      // true for ~700vh of scroll.
      const heroSection = document.getElementById('hero-section');
      if (!heroSection) return;
      const io = new IntersectionObserver(
        (entries) => {
          const last = entries[entries.length - 1];
          if (last) visible = last.isIntersecting;
        },
        { threshold: 0.3 }
      );
      io.observe(heroSection);
      return () => io.disconnect();
    }

    // Desktop: overlay opacity is written by scroll-engine.ts (inline style);
    // it hits 0.3 at ~18% of the scrub — that fraction-based fade is the
    // behaviour to keep.
    const overlayEl = document.getElementById('hero-overlay');
    if (!overlayEl) return;

    function checkOpacity() {
      const op = parseFloat(overlayEl!.style.opacity || '1');
      visible = op > 0.3;
    }
    checkOpacity();

    // Watch for inline style changes from scroll engine
    const mo = new MutationObserver(checkOpacity);
    mo.observe(overlayEl, { attributes: true, attributeFilter: ['style'] });
    return () => mo.disconnect();
  });

  /* ── Canvas setup & animation ─────────────────────── */

  // Assigned by the setup effect below; the visibility-gate effect after it
  // starts/stops the loop. Plain (non-$state) on purpose — only read from
  // event/rAF contexts, never from templates.
  // Takes `step`: how many 60fps frames this paint stands for (see FRAME_MS).
  let drawFrame: ((step: number) => void) | null = null;
  let reduceMotion = false;

  /* Every speed constant inside drawFrame — orbitSpeed, the 0.04 lerp, the
     0.03 breathe and 0.06 pulse rates, the 24-frame flash — was authored as
     "per 60fps frame". The loop no longer paints at 60fps everywhere, so it
     hands drawFrame a `step` multiplier and those constants scale by it.
     Without that the mobile cap below would literally halve the orbit speed,
     which is a visual change, and the brief forbids one.
     It also fixes a latent bug the cap work uncovered: the old loop advanced
     one fixed increment per rAF tick, so the orbit's real speed was whatever
     the display refresh happened to be. Measured at 1.73 rad/s in an
     unthrottled headless Chrome against the 0.48 rad/s the constants ask for
     — i.e. it ran ~2x fast on a 120Hz phone and correct only on 60Hz.
     `step` pins it to 0.4855 rad/s regardless of tick rate. */
  const FRAME_MS = 1000 / 60;

  // Minimum ms between paints; 0 = uncapped. Set from the mobile query in the
  // setup effect. 1.5 frames, not 2: a 33.33ms budget measured against rAF
  // ticks that land at 16.67/33.33ms falls on the wrong side of the compare
  // whenever a tick jitters late, and the loop drops to 20fps. 25ms always
  // rejects the 1st tick and always accepts the 2nd.
  let frameBudgetMs = 0;
  let lastFrameTs = 0;

  // Deferred first start (see startLoop). Two handle kinds because Safari has
  // no requestIdleCallback; stopLoop has to cancel whichever was scheduled.
  let idleHandle: number | null = null;
  let idleIsTimeout = false;
  let hasRunOnce = false;

  function animate(ts: number) {
    animFrameId = requestAnimationFrame(animate);
    if (lastFrameTs === 0) {
      lastFrameTs = ts;
      drawFrame?.(1);
      return;
    }
    const elapsed = ts - lastFrameTs;
    if (frameBudgetMs > 0 && elapsed < frameBudgetMs) return;
    lastFrameTs = ts;
    // Clamp: a long task, or a tab the visibility gate caught a beat late,
    // must not teleport the orbit a quarter turn on resume.
    drawFrame?.(Math.min(elapsed / FRAME_MS, 3));
  }

  function startLoop() {
    if (!drawFrame) return;
    if (reduceMotion) {
      // One static paint, no perpetual orbit — same contract as
      // HeroOverlay's neural canvas.
      drawFrame(0);
      return;
    }
    if (animFrameId !== null || idleHandle !== null) return;
    lastFrameTs = 0;

    if (hasRunOnce) {
      // A re-entry (scrolled back to the hero, tab refocused) must resume at
      // once — an idle deferral here would freeze the stars for up to 1.5s in
      // full view of the user. The deferral is only worth it before first paint.
      animFrameId = requestAnimationFrame(animate);
      return;
    }
    hasRunOnce = true;

    // Paint ONE frame now, so the widget is never a blank box during its 0.6s
    // fade-in, then hand the perpetual orbit to the idle queue. This island
    // hydrates inside the LCP window and the orbit is decorative; letting it
    // compete with hero paint for the main thread bought nothing.
    drawFrame(0);

    const begin = () => {
      idleHandle = null;
      if (animFrameId === null) animFrameId = requestAnimationFrame(animate);
    };
    if (typeof requestIdleCallback === 'function') {
      idleIsTimeout = false;
      idleHandle = requestIdleCallback(begin, { timeout: 1500 });
    } else {
      // Safari: rIC is Baseline "Limited". Plain timeout, same intent.
      idleIsTimeout = true;
      idleHandle = window.setTimeout(begin, 600);
    }
  }

  function stopLoop() {
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

  $effect(() => {
    if (!canvasEl || !wrapperEl) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    // Assigning canvas.width/height resets the ENTIRE 2D context state, font
    // included — so the cache below has to be invalidated from resize().
    let currentFont = '';

    let lastW = -1;
    let lastH = -1;

    function resize() {
      if (!canvasEl || !wrapperEl) return;
      // All reads first, then all writes. Mobile fires `resize` on every
      // URL-bar show/hide, i.e. repeatedly during a scroll, and the old
      // read → write → read order thrashed layout through all of it.
      const r = measureCenter();
      if (!r) return;
      // Same box: assigning canvas.width would clear the bitmap and buy a
      // full repaint for nothing. This is the common case on mobile, where
      // the URL-bar resize changes the viewport height but not this widget.
      if (r.width === lastW && r.height === lastH) return;
      lastW = r.width;
      lastH = r.height;
      canvasEl.width = r.width * dpr;
      canvasEl.height = r.height * dpr;
      canvasEl.style.width = `${r.width}px`;
      canvasEl.style.height = `${r.height}px`;
      currentFont = '';
      // Assigning canvas width/height CLEARS the bitmap (spec). The rAF loop
      // repaints within a frame, but under reduced motion there is no loop —
      // without this repaint, one toolbar show/hide or rotation left a blank
      // (still clickable) hitbox for the rest of the session.
      drawFrame?.(0);
    }
    resize();
    window.addEventListener('resize', resize);

    const ctx = canvasEl.getContext('2d', { alpha: true });
    if (!ctx) return;

    reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // 30fps on mobile. Same two-clause query as the visibility branch above
    // and HeroCanvas's hero--static gate — keep all three in lockstep. This is
    // a 64px decorative widget whose star travels 0.008 rad per 60fps frame;
    // halving its paint rate is not perceptible (the `step` multiplier keeps
    // the angular speed identical), and the rAF callback was the largest
    // single slice of this island's bootup-time on the mobile profile.
    // Measured over CDP on a visible mobile-emulated page: 190 distinct
    // canvas paints/s before, 38 after. A budget, not a divisor — a 60Hz
    // phone lands on 30fps, an unthrottled/high-refresh device on ~40.
    frameBudgetMs = window.matchMedia(
      '(max-width: 767px), ((max-height: 767px) and (pointer: coarse))'
    ).matches
      ? FRAME_MS * 1.5
      : 0;

    // Assigning ctx.font makes Chrome resolve the font shorthand against the
    // document — a style recalc, and the ONLY statement in this whole draw
    // that touches anything outside the canvas. It is the entirety of the
    // "forced reflow: HeroLangSwitcher.js" insight (72–103ms in the local
    // mobile run, 11ms on PSI). The Lighthouse trace was unambiguous: 537
    // rAF callbacks from this bundle, 535 forced UpdateLayoutTree events
    // hanging off them — one per frame, one per ctx.font. Re-assigning an
    // identical string still pays it, so cache and skip — but the cache only
    // hits while idle (not hovered): every frame then calls setFont once,
    // with the companion label's own string, "700 9px 'JetBrains Mono', 'SF
    // Mono', monospace" (line ~376), which never changes frame to frame, so
    // every call after the first is a no-op. While hovered, drawFrame calls
    // setFont TWICE per frame with two different strings — the companion
    // label's "700 10px …" (the size grows on hover) and the hover label's
    // "500 13px 'JetBrains Mono', 'SF Mono', monospace" (line ~394) — so the
    // cache is invalidated on every single call and never hits during hover.
    // The win described here is real only for the idle state, which is both
    // the Lighthouse case and most of real time on this widget. This is also
    // why the per-frame ctx.save()/scale() pair below became setTransform —
    // save/restore would reset font every frame and the cache could never
    // survive one.
    const setFont = (f: string) => {
      if (currentFont === f) return;
      ctx.font = f;
      currentFont = f;
    };

    drawFrame = (step: number) => {
      if (!canvasEl || !ctx) return;
      const w = canvasEl.width / dpr;
      const h = canvasEl.height / dpr;

      // setTransform, not save()/scale()/restore(): the restore at the end of
      // the frame would wipe the ctx.font cache above. clearRect runs in
      // device pixels, so identity first, then the dpr scale for the drawing.
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      frameCount += step;

      const lcx = w / 2;
      const lcy = 42; // fixed center — room for stars above and label below

      // Smooth speed lerp. `* step` on both lines keeps the angular velocity
      // frame-rate independent — a 30fps paint advances twice as far.
      const targetSpeed = isHov ? 0.022 : 0.008;
      orbitSpeed += (targetSpeed - orbitSpeed) * 0.04 * step;
      orbitAngle += orbitSpeed * step;

      // Active star (small, bright — current lang)
      const actX = lcx + Math.cos(orbitAngle) * ORBIT_R;
      const actY = lcy + Math.sin(orbitAngle) * ORBIT_R;

      // Companion star (large, dim — alt lang)
      const compX = lcx + Math.cos(orbitAngle + Math.PI) * ORBIT_R;
      const compY = lcy + Math.sin(orbitAngle + Math.PI) * ORBIT_R;

      const breathe = Math.sin(frameCount * 0.03) * 0.08;
      const compR = (isHov ? 13 : 11) * (1 + breathe);

      // --- Dashed orbital line ---
      ctx.save();
      ctx.beginPath();
      ctx.arc(lcx, lcy, ORBIT_R, 0, Math.PI * 2);
      ctx.setLineDash([4, 6]);
      ctx.lineDashOffset = -frameCount * 0.5;
      ctx.strokeStyle = `hsla(185, 50%, 55%, ${isHov ? 0.2 : 0.1})`;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();

      // --- Comet trail ---
      for (let i = 1; i <= 4; i++) {
        const ta = orbitAngle - i * 0.18;
        const tx = lcx + Math.cos(ta) * ORBIT_R;
        const ty = lcy + Math.sin(ta) * ORBIT_R;
        const tr = 3.5 - i * 0.6;
        const talpha = (0.35 - i * 0.07) * (isHov ? 1.3 : 1);
        if (tr > 0.5) {
          ctx.beginPath();
          ctx.arc(tx, ty, tr, 0, Math.PI * 2);
          ctx.fillStyle = `hsla(185, 80%, 65%, ${Math.max(0, talpha)})`;
          ctx.fill();
        }
      }

      // --- Active star ---
      const actGlow = ctx.createRadialGradient(actX, actY, 0, actX, actY, 16);
      actGlow.addColorStop(0, `hsla(185, 80%, 65%, ${isHov ? 0.35 : 0.25})`);
      actGlow.addColorStop(0.5, `hsla(185, 80%, 65%, 0.08)`);
      actGlow.addColorStop(1, `hsla(185, 80%, 65%, 0)`);
      ctx.beginPath();
      ctx.arc(actX, actY, 16, 0, Math.PI * 2);
      ctx.fillStyle = actGlow;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(actX, actY, 5, 0, Math.PI * 2);
      ctx.fillStyle = `hsla(185, 85%, 70%, 0.92)`;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(actX, actY, 2, 0, Math.PI * 2);
      ctx.fillStyle = `hsla(185, 90%, 88%, 0.9)`;
      ctx.fill();

      // --- Companion star ---
      const compGlow = ctx.createRadialGradient(
        compX,
        compY,
        compR * 0.5,
        compX,
        compY,
        compR + 14
      );
      compGlow.addColorStop(0, `hsla(210, 60%, 55%, ${isHov ? 0.22 : 0.1})`);
      compGlow.addColorStop(1, `hsla(210, 60%, 55%, 0)`);
      ctx.beginPath();
      ctx.arc(compX, compY, compR + 14, 0, Math.PI * 2);
      ctx.fillStyle = compGlow;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(compX, compY, compR, 0, Math.PI * 2);
      ctx.fillStyle = `hsla(210, 35%, 18%, ${isHov ? 0.75 : 0.55})`;
      ctx.fill();
      ctx.strokeStyle = `hsla(185, 55%, 55%, ${isHov ? 0.5 : 0.2})`;
      ctx.lineWidth = isHov ? 1.5 : 1;
      ctx.stroke();
      // Text inside companion
      setFont(`700 ${isHov ? 10 : 9}px 'JetBrains Mono', 'SF Mono', monospace`);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = `hsla(185, 50%, 72%, ${isHov ? 0.95 : 0.65})`;
      ctx.fillText(altLang.toUpperCase(), compX, compY + 0.5);

      // Pulse ring on hover
      if (isHov) {
        const pulse = Math.sin(frameCount * 0.06) * 0.12 + 0.22;
        ctx.beginPath();
        ctx.arc(compX, compY, compR + 8, 0, Math.PI * 2);
        ctx.strokeStyle = `hsla(185, 70%, 60%, ${pulse})`;
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      // --- Hover label (below) ---
      if (isHov) {
        setFont(`500 13px 'JetBrains Mono', 'SF Mono', monospace`);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        const labelText = `→ ${altLang.toUpperCase()}`;
        ctx.shadowColor = `hsla(185, 70%, 60%, 0.5)`;
        ctx.shadowBlur = 14;
        ctx.fillStyle = `hsla(0, 0%, 100%, 0.92)`;
        ctx.fillText(labelText, lcx, lcy + ORBIT_R + 16);
        ctx.shadowColor = 'transparent';
        ctx.shadowBlur = 0;
      }

      // --- Flash on click ---
      if (flashActive) {
        const elapsed = frameCount - flashStart;
        const duration = 24;
        if (elapsed < duration) {
          const t = elapsed / duration;
          const eased = 1 - (1 - t) ** 3;
          const flashR = eased * 65;
          const flashAlpha = 1 - eased;
          ctx.beginPath();
          ctx.arc(compX, compY, flashR, 0, Math.PI * 2);
          ctx.strokeStyle = `hsla(185, 90%, 80%, ${flashAlpha * 0.7})`;
          ctx.lineWidth = 3 * (1 - t);
          ctx.stroke();
          ctx.beginPath();
          ctx.arc(compX, compY, compR * (1 - t * 0.3), 0, Math.PI * 2);
          ctx.fillStyle = `hsla(185, 90%, 85%, ${flashAlpha * 0.8})`;
          ctx.fill();
          ctx.beginPath();
          ctx.arc(compX, compY, 4 + 16 * (1 - t), 0, Math.PI * 2);
          ctx.fillStyle = `hsla(0, 0%, 100%, ${flashAlpha})`;
          ctx.fill();
        }
      }
    };

    return () => {
      stopLoop();
      drawFrame = null;
      window.removeEventListener('resize', resize);
    };
  });

  /* A backgrounded tab throttles rAF rather than stopping it in every engine,
     and a page restored from the bfcache resumes mid-loop. The Page
     Visibility API is the only honest signal for "nobody is looking". Written
     here, read only by the gate effect below — never both in one $effect. */
  let docVisible = $state(true);

  $effect(() => {
    const sync = () => {
      docVisible = document.visibilityState === 'visible';
    };
    sync();
    document.addEventListener('visibilitychange', sync);
    return () => document.removeEventListener('visibilitychange', sync);
  });

  /* The loop runs only while the switcher is actually on screen (`visible`
     also feeds tabindex/inert/opacity). Before this gate the orbit burned
     up to 60fps for the entire visit — on mobile literally forever, since
     `visible` never flipped false there (hero-1).
     No IntersectionObserver on the widget itself: it is position:fixed, so it
     is ALWAYS intersecting the viewport and such an observer would report
     true for the whole session. `visible` is the real off-screen signal —
     an IO on #hero-section on mobile, the overlay's scrubbed opacity on
     desktop (see the effect at the top of this file). */
  $effect(() => {
    if (visible && docVisible) startLoop();
    else stopLoop();
  });

  /* ── Interaction ───────────────────────────────────── */
  function onMove(e: MouseEvent) {
    // Reads the cached centre (measured on resize and on mouseenter) instead
    // of measuring per mousemove — see measureCenter above.
    const dist = Math.sqrt((e.clientX - centerX) ** 2 + (e.clientY - centerY) ** 2);
    isHov = dist < 50;
  }

  function activate() {
    if (flashActive) return;
    flashActive = true;
    flashStart = frameCount;
    setTimeout(() => {
      window.location.href = `/${altLang}/`;
    }, 300);
  }

  // Mouse keeps the hover-radius guard (isHov, set by onMove). Keyboard has no
  // pointer position, so focus arms it and Enter/Space activate directly —
  // without this, tabbing here and pressing Enter was a silent no-op.
  function onClick() {
    if (!isHov) return;
    activate();
  }

  // Touch has no hover either: without arming isHov here, a tap only worked
  // if the browser happened to replay a synthetic mousemove inside the 50px
  // radius before its synthetic click. Arm on touchstart; disarm on a delay
  // (not on touchend directly) because the synthetic click fires AFTER
  // touchend — an immediate reset would swallow the very tap it enables.
  function onTouchStart() {
    isHov = true;
  }
  function onTouchEnd() {
    setTimeout(() => {
      isHov = false;
    }, 400);
  }

  function onKeydown(e: KeyboardEvent) {
    if (!visible) return; // hidden after scroll — no keyboard activation
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      activate();
    }
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="hero-lang"
  class:is-visible={visible}
  bind:this={wrapperEl}
  onmouseenter={measureCenter}
  onmousemove={onMove}
  onmouseleave={() => {
    isHov = false;
  }}
  onfocus={() => {
    isHov = true;
  }}
  onblur={() => {
    isHov = false;
  }}
  ontouchstart={onTouchStart}
  ontouchend={onTouchEnd}
  ontouchcancel={onTouchEnd}
  onclick={onClick}
  onkeydown={onKeydown}
  role="button"
  tabindex={visible ? 0 : -1}
  inert={!visible}
  aria-label={languageLabel}
>
  <canvas bind:this={canvasEl} class="hero-lang__canvas" aria-hidden="true"></canvas>
</div>

<style>
  .hero-lang {
    position: fixed;
    /* env() on the BASE rule too: a notched phone in landscape is ≥768px
       wide, so the mobile blocks below never fire there — without this the
       widget sat inside the ~44px notch inset. 0px on regular screens. */
    bottom: calc(3rem + env(safe-area-inset-bottom, 0px));
    left: calc(2rem + env(safe-area-inset-left, 0px));
    width: 80px;
    height: 110px;
    z-index: 20;
    cursor: pointer;
    opacity: 0;
    transform: translateY(12px);
    transition:
      opacity 0.6s ease-out,
      transform 0.6s ease-out;
    pointer-events: none;
  }

  .hero-lang.is-visible {
    opacity: 1;
    transform: translateY(0);
    pointer-events: auto;
  }

  .hero-lang__canvas {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
  }

  /* Hide when constellation nav is open */
  :global(.constellation-open) .hero-lang {
    opacity: 0 !important;
    pointer-events: none !important;
  }

  /* Same two-clause query as the JS logic split (this file's visibility
     branch + HeroCanvas's hero--static): 767 not 768 so an iPad portrait
     that runs the desktop scrub gets the desktop widget, and the
     short+coarse clause so a rotated phone gets the mobile one. */
  @media (max-width: 767px), ((max-height: 767px) and (pointer: coarse)) {
    .hero-lang {
      /* env(): viewport-fit=cover means the true screen edge — keep the
         widget clear of the home-indicator strip in the installed PWA. */
      bottom: calc(1.5rem + env(safe-area-inset-bottom, 0px));
      left: calc(1rem + env(safe-area-inset-left, 0px));
      width: 64px;
      height: 64px;
    }
  }

  /* Below 640px the cookie banner is a full-width bottom sheet (z-index 500
     against this element's 20) parked exactly over this corner — on a first
     visit the switcher was buried until the banner was dismissed. Step above
     it the same way SynapseBrain does: --consent-sheet-height is published on
     <html> by CookieConsent.svelte only while the sheet is on screen.
     Scoped to 640px, NOT the 767px block above: between 641–767px the banner
     is a centered floating card that never reaches this corner, so no push
     is needed there.

     The push used to be baked into `bottom:` here. Lighthouse flagged the
     result as a non-composited animation ("Unsupported CSS Property: bottom")
     — a bottom change relayouts the fixed box every frame of the transition,
     a translate rides the compositor. `translate` is the INDEPENDENT
     transform property, deliberately NOT `transform`: the entrance slide at
     the top of this block already owns `transform`, the two compose (translate
     is applied first), and each keeps its own duration. Folding both into one
     `transform` would have forced the consent push and the entrance slide to
     share a timing function — that was the rejected alternative. `bottom`
     itself stays put, inherited from the 767px block. */
  @media (max-width: 640px) {
    .hero-lang {
      translate: 0 calc(-1 * var(--consent-sheet-height, 0px));
    }
  }

  @media (max-width: 640px) and (prefers-reduced-motion: no-preference) {
    .hero-lang {
      transition:
        opacity 0.6s ease-out,
        transform 0.6s ease-out,
        translate var(--duration-normal) var(--ease-out);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .hero-lang {
      transition: none;
    }
  }
</style>
