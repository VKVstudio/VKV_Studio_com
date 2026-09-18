<script lang="ts">
  /**
   * HeroLangSwitcher — Binary Star language switcher for the hero section.
   * Shows orbiting RU/EN stars in the bottom-left corner.
   * Visible only while the hero title is in the viewport.
   * No branches — just the eclipsing binary animation.
   */
  import { getAltLang, t } from '@i18n/utils';

  interface Props {
    lang: 'en' | 'ru';
  }

  let { lang }: Props = $props();

  const altLang = getAltLang(lang);

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
  let drawFrame: (() => void) | null = null;
  let reduceMotion = false;

  function animate() {
    drawFrame?.();
    animFrameId = requestAnimationFrame(animate);
  }

  function startLoop() {
    if (!drawFrame) return;
    if (reduceMotion) {
      // One static paint, no perpetual orbit — same contract as
      // HeroOverlay's neural canvas.
      drawFrame();
      return;
    }
    if (animFrameId !== null) return;
    animFrameId = requestAnimationFrame(animate);
  }

  function stopLoop() {
    if (animFrameId !== null) {
      cancelAnimationFrame(animFrameId);
      animFrameId = null;
    }
  }

  $effect(() => {
    if (!canvasEl || !wrapperEl) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    function resize() {
      if (!canvasEl || !wrapperEl) return;
      const r = wrapperEl.getBoundingClientRect();
      canvasEl.width = r.width * dpr;
      canvasEl.height = r.height * dpr;
      canvasEl.style.width = `${r.width}px`;
      canvasEl.style.height = `${r.height}px`;
      // Assigning canvas width/height CLEARS the bitmap (spec). The rAF loop
      // repaints within a frame, but under reduced motion there is no loop —
      // without this repaint, one toolbar show/hide or rotation left a blank
      // (still clickable) hitbox for the rest of the session.
      drawFrame?.();
    }
    resize();
    window.addEventListener('resize', resize);

    const ctx = canvasEl.getContext('2d', { alpha: true });
    if (!ctx) return;

    reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    drawFrame = () => {
      if (!canvasEl || !ctx) return;
      const w = canvasEl.width / dpr;
      const h = canvasEl.height / dpr;

      ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
      ctx.save();
      ctx.scale(dpr, dpr);
      frameCount++;

      const lcx = w / 2;
      const lcy = 42; // fixed center — room for stars above and label below

      // Smooth speed lerp
      const targetSpeed = isHov ? 0.022 : 0.008;
      orbitSpeed += (targetSpeed - orbitSpeed) * 0.04;
      orbitAngle += orbitSpeed;

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
      ctx.strokeStyle = `hsla(185, 50%, 55%, ${isHov ? 0.20 : 0.10})`;
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
      const compGlow = ctx.createRadialGradient(compX, compY, compR * 0.5, compX, compY, compR + 14);
      compGlow.addColorStop(0, `hsla(210, 60%, 55%, ${isHov ? 0.22 : 0.10})`);
      compGlow.addColorStop(1, `hsla(210, 60%, 55%, 0)`);
      ctx.beginPath();
      ctx.arc(compX, compY, compR + 14, 0, Math.PI * 2);
      ctx.fillStyle = compGlow;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(compX, compY, compR, 0, Math.PI * 2);
      ctx.fillStyle = `hsla(210, 35%, 18%, ${isHov ? 0.75 : 0.55})`;
      ctx.fill();
      ctx.strokeStyle = `hsla(185, 55%, 55%, ${isHov ? 0.50 : 0.20})`;
      ctx.lineWidth = isHov ? 1.5 : 1;
      ctx.stroke();
      // Text inside companion
      ctx.font = `700 ${isHov ? 10 : 9}px 'JetBrains Mono', 'SF Mono', monospace`;
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
        ctx.font = `500 13px 'JetBrains Mono', 'SF Mono', monospace`;
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

      ctx.restore();
    };

    return () => {
      stopLoop();
      drawFrame = null;
      window.removeEventListener('resize', resize);
    };
  });

  /* The loop runs only while the switcher is actually on screen (`visible`
     also feeds tabindex/inert/opacity). Before this gate the orbit burned
     up to 60fps for the entire visit — on mobile literally forever, since
     `visible` never flipped false there (hero-1). */
  $effect(() => {
    if (visible) startLoop();
    else stopLoop();
  });

  /* ── Interaction ───────────────────────────────────── */
  function onMove(e: MouseEvent) {
    if (!wrapperEl) return;
    const rect = wrapperEl.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const dist = Math.sqrt((e.clientX - cx) ** 2 + (e.clientY - cy) ** 2);
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
  onmousemove={onMove}
  onmouseleave={() => { isHov = false; }}
  onfocus={() => { isHov = true; }}
  onblur={() => { isHov = false; }}
  ontouchstart={onTouchStart}
  ontouchend={onTouchEnd}
  ontouchcancel={onTouchEnd}
  onclick={onClick}
  onkeydown={onKeydown}
  role="button"
  tabindex={visible ? 0 : -1}
  inert={!visible}
  aria-label={t(lang, 'nav.switchLanguageTo').replace('{lang}', altLang.toUpperCase())}
>
  <canvas
    bind:this={canvasEl}
    class="hero-lang__canvas"
    aria-hidden="true"
  ></canvas>
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
    transition: opacity 0.6s ease-out, transform 0.6s ease-out;
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
     is needed there. Must come after the 767px block to win the cascade. */
  @media (max-width: 640px) {
    .hero-lang {
      bottom: calc(1.5rem + env(safe-area-inset-bottom, 0px) + var(--consent-sheet-height, 0px));
    }
  }

  @media (max-width: 640px) and (prefers-reduced-motion: no-preference) {
    .hero-lang {
      transition:
        opacity 0.6s ease-out,
        transform 0.6s ease-out,
        bottom var(--duration-normal) var(--ease-out);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .hero-lang {
      transition: none;
    }
  }
</style>
