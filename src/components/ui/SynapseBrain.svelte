<script lang="ts">
  /**
   * SynapseBrain — Fixed circle with scroll-driven video scrub.
   *
   * Always 80×80 circle. Video fills by height (cover fit via canvas).
   * Opacity changes with scroll. At 70%+ becomes clickable.
   */

  import { initBrainMorph } from '@scripts/brain-morph';
  import type { BrainMorphInstance } from '@scripts/brain-morph';
  import { t, type Lang } from '@/i18n/utils';

  // ─── Props ────────────────────────────────────────────────────────────────────
  interface Props {
    /** Optional click callback — when provided, fires instead of tooltip toggle */
    onActivate?: () => void;
    /** First sign the visitor is about to use the orb: pointer enters it,
        keyboard focus lands on it, or it is clicked. Fires only once the
        orb is `ready` (before that it has pointer-events:none and
        tabindex=-1, so none of those events can reach it). SynapseApp uses
        it to mount the lazily-loaded terminal ahead of the click. */
    onIntent?: () => void;
    /** The scroll gate opened (`.ready` was added for the first time).
        SynapseApp uses it to warm the terminal chunk in an idle slot. */
    onReady?: () => void;
    /** Scale the orb away (1→0) while the terminal is open. A CSS transition
        on the `scale` property — see the stylesheet for why not GSAP. Only
        ever true once the terminal is mounted (SynapseApp derives it from
        that), so the orb never shrinks to nothing with nothing behind it. */
    collapsed?: boolean;
    /** The visitor clicked, the terminal chunk has not landed yet: the orb
        stays where it is, reports aria-busy and pulses until the terminal
        mounts and takes over (or the fetch fails and `pending` drops). */
    pending?: boolean;
    /** Two failed opens in a row: the label and a small tooltip say the
        assistant did not load and that a page reload recovers (the import
        is retried on every click anyway — SynapseApp explains why that
        alone is not enough). Cleared by the next successful mount. */
    failed?: boolean;
    /** Site language for the a11y label / tooltip. Defaults to EN if omitted. */
    lang?: Lang;
  }
  const {
    onActivate,
    onIntent,
    onReady,
    collapsed = false,
    pending = false,
    failed = false,
    lang = 'en',
  }: Props = $props();

  let containerEl: HTMLElement | undefined = $state();
  let canvasEl: HTMLCanvasElement | undefined = $state();
  let videoEl: HTMLVideoElement | undefined = $state();
  let onlineDocEl: HTMLElement | undefined = $state();

  let tooltipVisible: boolean = $state(false);
  let isReady: boolean = $state(false);
  /** Escape hides the failure tooltip (the label keeps saying it). Re-armed
      whenever `failed` clears, so a later failure shows it again. Reads
      `failed`, writes `failedTipDismissed` — two different states. */
  let failedTipDismissed: boolean = $state(false);
  $effect(() => {
    if (!failed) failedTipDismissed = false;
  });

  const ariaExpanded = $derived(tooltipVisible ? 'true' : 'false');

  /** Failure beats pending beats ready: a visitor whose second click just
      failed must hear why, not "loading". */
  const ariaLabel = $derived(
    failed
      ? t(lang, 'synapse.brain.failed')
      : pending
        ? t(lang, 'synapse.brain.pending')
        : isReady
          ? t(lang, 'synapse.brain.open')
          : t(lang, 'synapse.brain.loading')
  );

  let engine: BrainMorphInstance | null = null;

  $effect(() => {
    if (!containerEl || !canvasEl || !videoEl || !onlineDocEl) return;

    // `.ready` is toggled by brain-morph.ts (class + inline styles, outside
    // Svelte's reactivity), so it is mirrored into state here. onReady fires
    // on the first false→true edge only: the class comes and goes with every
    // scroll past #about, and the warm-up it triggers is a one-shot.
    let readyAnnounced = false;
    const observer = new MutationObserver(() => {
      const ready = containerEl?.classList.contains('ready') ?? false;
      isReady = ready;
      if (ready && !readyAnnounced) {
        readyAnnounced = true;
        onReady?.();
      }
    });
    observer.observe(containerEl, { attributes: true, attributeFilter: ['class'] });

    const heroSection = document.getElementById('hero-section');
    if (!heroSection) return;

    engine = initBrainMorph({
      canvas: canvasEl,
      video: videoEl,
      container: containerEl,
      onlineDoc: onlineDocEl,
      heroSection: heroSection,
    });

    // Publish how much of the footer is on screen so the orb (fixed
    // bottom-right) can ride above it instead of squatting on the footer's
    // links — same contract as CookieConsent's --consent-sheet-height.
    // Threshold steps + the CSS `translate` transition smooth out the ride.
    // `translate` is safe to drive from CSS: no script writes a transform
    // inline — brain-morph.ts writes only opacity/pointerEvents/cursor, and
    // the collapse is a class toggle, not a GSAP tween (GSAP 3.15.0, the
    // version this project pins, stamps `translate: none` inline on any
    // element it tweens, which would have frozen the ride — first seen in
    // the CLS culprit snippet 2026-09-20, re-checked against gsap.min.js
    // 3.15.0 in headless Chrome 2026-09-21: after gsap.set(el, { scale: 0 })
    // the element's style attribute carries `translate: none; rotate: none;
    // scale: none; transform: scale(0, 0)`).
    const footerEl = document.querySelector('footer');
    let footerObserver: IntersectionObserver | null = null;
    if (footerEl) {
      footerObserver = new IntersectionObserver(
        (entries) => {
          const last = entries[entries.length - 1];
          if (!last) return;
          const overlap = last.isIntersecting ? Math.round(last.intersectionRect.height) : 0;
          document.documentElement.style.setProperty('--footer-clearance', `${overlap}px`);
        },
        // 101 steps, not 8: the observer only fires on threshold CROSSINGS,
        // so a fling that rests between coarse steps left the published value
        // stale by up to ~15% of footer height. 1% bounds the error.
        { threshold: Array.from({ length: 101 }, (_, i) => i / 100) }
      );
      footerObserver.observe(footerEl);
    }

    return () => {
      engine?.destroy();
      engine = null;
      observer.disconnect();
      footerObserver?.disconnect();
      document.documentElement.style.removeProperty('--footer-clearance');
    };
  });

  function handleIntent(): void {
    if (!isReady) return;
    onIntent?.();
  }

  function handleClick(): void {
    if (!isReady) return;
    // If parent provided onActivate callback (SynapseApp), delegate to it
    if (onActivate) {
      // Belt and braces: a tap on a touch screen does fire pointerenter
      // first, but a synthetic click (assistive tech, tests) may not.
      onIntent?.();
      onActivate();
      return;
    }
    // Standalone fallback: toggle tooltip
    tooltipVisible = !tooltipVisible;
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      handleClick();
    }
    if (event.key === 'Escape') {
      tooltipVisible = false;
      failedTipDismissed = true;
    }
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div
  bind:this={containerEl}
  class="synapse-container"
  class:synapse-container--collapsed={collapsed}
  class:synapse-container--pending={pending}
  class:synapse-container--failed={failed}
  role="button"
  tabindex={isReady ? 0 : -1}
  aria-label={ariaLabel}
  aria-busy={pending ? 'true' : 'false'}
  style:cursor={pending ? 'progress' : isReady ? 'pointer' : null}
  aria-expanded={ariaExpanded}
  aria-haspopup="dialog"
  onclick={handleClick}
  onkeydown={handleKeydown}
  onpointerenter={handleIntent}
  onfocus={handleIntent}
>
  <picture>
    <source srcset="/neural-brain.avif" type="image/avif" />
    <source srcset="/neural-brain.webp" type="image/webp" />
    <img
      src="/neural-brain.png"
      alt={t(lang, 'synapse.brain.alt')}
      class="synapse-fallback"
      aria-hidden="true"
      width="80"
      height="80"
    />
  </picture>

  <!-- Static ready-state identity for mobile: a REAL <img>, not a canvas
       draw. The mobile `.ready` swap used to hand the circle back to the
       canvas, whose synapse-text drawImage silently failed on phones —
       leaving an empty dark circle exactly where the brand should be
       (owner's screenshot). A static identity must never depend on a
       runtime draw succeeding. -->
  <picture>
    <source srcset="/synapse-text.avif" type="image/avif" />
    <source srcset="/synapse-text.webp" type="image/webp" />
    <img
      src="/synapse-text.png"
      alt=""
      class="synapse-ready-img"
      aria-hidden="true"
      width="80"
      height="80"
    />
  </picture>

  <!-- NO src attribute in the static markup: on mobile / prefers-reduced-motion,
       brain-morph.ts never assigns one, so the 2.1MB file is never
       requested, mirroring HeroCanvas's hero-scroll.mp4 gating. Desktop
       assigns data-src to src before starting the scrub loop. -->
  <video
    bind:this={videoEl}
    class="synapse-video-source"
    data-src="/brain-morph.v2.mp4"
    data-poster="/neural-brain.webp"
    preload="none"
    muted
    playsinline
    aria-hidden="true"
  ></video>

  <canvas bind:this={canvasEl} class="synapse-canvas" aria-hidden="true"></canvas>

  <span
    bind:this={onlineDocEl}
    class="synapse-online"
    aria-label="Synapse online"
    aria-hidden="true"
  ></span>
</div>

{#if tooltipVisible}
  <div
    class="synapse-tooltip"
    role="dialog"
    aria-label={t(lang, 'synapse.brain.statusLabel')}
    aria-modal="false"
  >
    <p class="synapse-tooltip__text">{t(lang, 'synapse.brain.tooltipTitle')}</p>
    <p class="synapse-tooltip__sub">{t(lang, 'synapse.brain.tooltipSub')}</p>
  </div>
{/if}

<!-- Two failed opens in a row: the same tooltip surface, one line, polite
     live region so a screen reader hears it without focus moving. Hidden
     while a retry is pending, on Escape, and gone once a mount succeeds. -->
{#if failed && !pending && !failedTipDismissed}
  <div class="synapse-tooltip synapse-tooltip--failed" role="status" aria-live="polite">
    <p class="synapse-tooltip__sub">{t(lang, 'synapse.brain.failed')}</p>
  </div>
{/if}

<style>
  /* `<picture>` is inline by default — make it a transparent wrapper so the
     absolutely-positioned fallback `<img>` inside lays out exactly as before. */
  picture {
    display: contents;
  }

  /* ── Container: ALWAYS a circle ────────────────────────────────── */
  .synapse-container {
    position: fixed;
    /* `bottom` is now STATIC: the orb's resting edge and nothing else.
       The ride above the footer / cookie sheet is `translate` below, on the
       compositor. It used to be folded into `bottom` and transitioned there,
       which Lighthouse flagged twice on 2026-09-20: a non-composited
       animation (Unsupported CSS Property: bottom) AND the page's whole CLS —
       0.0162 of 0.0163 — because a fixed element moving through `bottom`
       counts as a layout shift while a transform does not. env(): landscape
       notch side + gesture strip, same as the mobile block. */
    bottom: 24px;
    right: calc(24px + env(safe-area-inset-right, 0px));
    z-index: 90;

    /* --footer-clearance on the BASE rule, not just mobile: at 768-1023px
       (and desktop) the orb's 80px box fully covered the footer's GitHub/
       LinkedIn links at page bottom — measured, not guessed. Negative =
       upward. The individual `translate` property, not `transform`: it is
       untouched by the mobile `transform: none` rule below and cannot be
       clobbered by any inline transform writer. */
    translate: 0 calc(-1 * var(--footer-clearance, 0px));
    /* Collapse state for SynapseApp (terminal open). `scale` is its own
       property for the same reason, and composes with the translate above
       around the centre — the orb shrinks in place, where it currently rides.
       This replaced a GSAP scale tween: GSAP 3.15.0 (the pinned version)
       writes `translate: none` inline on first touch of an element (seen in
       the Lighthouse snippet 2026-09-20, re-checked 2026-09-21 — see the
       script comment above the footer observer), which would have pinned
       the ride at zero for the rest of the visit. */
    scale: 1;

    width: 80px;
    height: 80px;
    border-radius: 50%;

    background: var(--bg-void);
    overflow: hidden;
    pointer-events: none;
    opacity: 0.6;
    cursor: default;

    border: 1px solid var(--border-subtle);
    box-shadow: var(--shadow-md);

    transition:
      box-shadow var(--duration-normal) var(--ease-out),
      border-color var(--duration-normal) var(--ease-out);
  }

  /* On EVERY viewport, phones included — a conscious call (2026-09-21), not
     a side effect. The old GSAP collapse wrote an inline `transform`, which
     the mobile block's historic `transform: none !important` cancelled, so
     phones never saw the orb shrink; the individual `scale` property is not
     touched by that rule. Collapsing on phones is the better behaviour: the
     terminal is a fixed inset:0 overlay at z-index 9999, so the orb is
     covered either way, and the spring back on close (0→1) is the one cue
     that shows where the assistant went. The historic rule stays as it is —
     removing it is the owner's call. */
  .synapse-container--collapsed {
    scale: 0;
  }

  /* Click landed, terminal chunk still in flight: the orb stays put (scale
     stays 1 — `collapsed` cannot be true before the terminal exists) and
     signals work-in-progress. The pulse is opacity only (compositor) and
     lives behind the motion query below. The static cue that survives
     reduced motion, next to aria-busy, is `cursor: progress` — written by
     the `style:cursor` directive on the element, not by a rule here: a
     class rule loses to the inline `cursor: pointer` brain-morph.ts writes
     in the ready state (measured 2026-09-21 — the first cut used a rule and
     the probe still read `pointer` while pending). */

  /* Two failed opens: a warning ring, and the tooltip below says why. The
     orb keeps its hit area — a click retries the import. */
  .synapse-container--failed {
    border-color: var(--color-warning);
  }

  .synapse-tooltip--failed {
    border-color: var(--color-warning);
  }

  .synapse-tooltip--failed .synapse-tooltip__sub {
    color: var(--text-secondary);
    letter-spacing: normal;
    max-width: 20ch;
  }

  /* The cookie-sheet offset lives in the 640px block at the BOTTOM of this
     stylesheet — it must come after the 767px geometry block to win the
     cascade on `translate`. A 640px block here used to hold the consent
     offset, and the later 767px block silently overrode it on every phone. */

  /* Ready glow */
  .synapse-container:global(.ready) {
    border-color: var(--border-accent);
    box-shadow: var(--shadow-lg), var(--glow-green);
  }

  .synapse-container:global(.ready):hover {
    box-shadow:
      var(--shadow-xl),
      0 0 32px var(--accent-glow-strong);
  }

  .synapse-container:focus-visible {
    outline: 2px solid var(--accent-green-300);
    outline-offset: 3px;
  }

  /* ── Canvas ─────────────────────────────────────────────────────── */
  .synapse-canvas {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    display: block;
    border-radius: 50%;
  }

  /* ── Hidden video source ────────────────────────────────────────── */
  .synapse-video-source {
    position: absolute;
    width: 1px;
    height: 1px;
    opacity: 0;
    pointer-events: none;
  }

  /* ── Reduced-motion fallback ───────────────────────────────────── */
  .synapse-fallback {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: none;
    border-radius: 50%;
  }

  /* Static ready-state image (mobile) — same geometry as the fallback;
     `contain` because synapse-text is a wordmark, not a photo. */
  .synapse-ready-img {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: contain;
    display: none;
    border-radius: 50%;
  }

  @media (prefers-reduced-motion: reduce) {
    .synapse-fallback {
      display: block;
    }
    .synapse-canvas {
      display: none;
    }
    .synapse-container {
      opacity: 1 !important;
    }
  }

  /* ── Online dot ────────────────────────────────────────────────── */
  .synapse-online {
    position: absolute;
    bottom: 6px;
    right: 6px;
    width: 6px;
    height: 6px;
    border-radius: var(--radius-full);
    background: var(--color-success);
    box-shadow: 0 0 6px var(--color-success);
    visibility: hidden;
    opacity: 0;
  }

  /* ── Tooltip ───────────────────────────────────────────────────── */
  /* Standalone-fallback only (unreachable while SynapseApp always passes
     onActivate) — but keep it riding the same offsets as the orb so the
     fallback does not detach the day it is exercised. */
  .synapse-tooltip {
    position: fixed;
    bottom: calc(24px + 88px + var(--consent-sheet-height, 0px) + var(--footer-clearance, 0px));
    right: 24px;
    z-index: 91;

    padding: var(--space-3) var(--space-4);
    border-radius: var(--radius-md);

    background: var(--glass-bg);
    border: 1px solid var(--glass-border);
    backdrop-filter: blur(var(--glass-blur));
    -webkit-backdrop-filter: blur(var(--glass-blur));
    box-shadow: var(--glass-shadow);

    max-width: 200px;
    animation: tooltip-in var(--duration-slow) var(--ease-out) both;
  }

  /* The standard property, restated where the CSS minifier cannot rewrite it
     away — it collapses `backdrop-filter` into the -webkit- alias alone, which
     leaves Firefox with a flat fill. It does not collapse across an @supports
     boundary. Must stay AFTER the base rule: equal specificity, last wins. */
  @supports (backdrop-filter: blur(1px)) {
    .synapse-tooltip {
      backdrop-filter: blur(var(--glass-blur));
    }
  }

  .synapse-tooltip__text {
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    color: var(--text-primary);
    margin: 0 0 var(--space-1);
    line-height: var(--leading-snug);
  }

  .synapse-tooltip__sub {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--text-muted);
    margin: 0;
    letter-spacing: var(--tracking-wide);
  }

  @keyframes tooltip-in {
    from {
      opacity: 0;
      transform: translateY(6px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  /* ── Mobile ────────────────────────────────────────────────────── */
  @media (max-width: 767px) {
    .synapse-container {
      left: auto !important;
      /* env(safe-area-inset-bottom): with viewport-fit=cover the page reaches
         the true screen edge — in the installed PWA (standalone) the old flat
         16px put the orb inside the home-indicator swipe strip.
         The footer ride is the base rule's `translate` — it applies here
         unchanged, so it no longer needs restating in this block. */
      bottom: calc(16px + env(safe-area-inset-bottom, 0px));
      right: calc(16px + env(safe-area-inset-right, 0px));
      /* Historic guard against inline transforms (pre-dates the individual
         `translate`/`scale` properties this file now rides on, which it does
         not touch — so the collapse above DOES run on phones now; see the
         note on .synapse-container--collapsed). Kept: harmless, and removal
         is the owner's call. */
      transform: none !important;
      width: 64px;
      height: 64px;
    }

    .synapse-tooltip {
      right: 16px;
      bottom: calc(16px + 72px + var(--consent-sheet-height, 0px) + var(--footer-clearance, 0px));
    }
  }

  /* Step clear of the cookie sheet while it is on screen. Below 640px that
     banner is a full-width sheet flush with the bottom edge and it wins on
     z-index (500 against this element's 90), so on a first visit the entry
     point into the assistant is buried under the consent prompt.
     --consent-sheet-height is published by CookieConsent.svelte only while
     the sheet is visible; once dismissed the property disappears and this
     collapses back. This is the move Lighthouse used to score as CLS on
     every first visit — now a transform, which layout-shift ignores.
     AFTER the 767px block on purpose: an earlier placement lost the cascade
     and was dead on every phone. */
  @media (max-width: 640px) {
    .synapse-container {
      translate: 0 calc(-1 * (var(--consent-sheet-height, 0px) + var(--footer-clearance, 0px)));
    }
  }

  /* One block for every viewport: the ride above the footer / cookie sheet
     eases (without it the observer's 1% steps would jump-cut), and the
     collapse behind the terminal springs. --ease-spring is cubic-bezier
     (0.34, 1.56, 0.64, 1) — the same curve as GSAP's back.out(1.7) that the
     old tween used, so the feel is unchanged. Under reduced motion neither
     transitions: the state still changes (the orb must still hide behind the
     terminal and come back), only the tween goes — the house rule. */
  @media (prefers-reduced-motion: no-preference) {
    .synapse-container {
      transition:
        box-shadow var(--duration-normal) var(--ease-out),
        border-color var(--duration-normal) var(--ease-out),
        translate var(--duration-normal) var(--ease-out),
        scale 300ms var(--ease-spring);
    }

    /* Going away is an ease-in (GSAP's power2.in), coming back is the spring. */
    .synapse-container--collapsed {
      transition:
        box-shadow var(--duration-normal) var(--ease-out),
        border-color var(--duration-normal) var(--ease-out),
        translate var(--duration-normal) var(--ease-out),
        scale 300ms cubic-bezier(0.55, 0.085, 0.68, 0.53);
    }

    /* Pending pulse: 1 → 0.55 → 1 every 1.8 s. An animation on opacity
       outranks the inline `opacity: 1` brain-morph.ts writes in the ready
       state (animations sit above author inline styles in the cascade), and
       stops the moment the class goes — the collapse transition then starts
       from wherever the pulse left off. */
    .synapse-container--pending {
      animation: synapse-pending 900ms var(--ease-out) infinite alternate;
    }
  }

  @keyframes synapse-pending {
    from {
      opacity: 1;
    }
    to {
      opacity: 0.55;
    }
  }

  @media (max-width: 767px) {
    /* brain-morph.mp4 is never fetched on mobile (see brain-morph.ts) —
       show the static neural-brain fallback image instead of a blank
       canvas while the hero is in view. */
    .synapse-fallback {
      display: block;
    }
    .synapse-canvas {
      display: none;
    }

    /* Once "ready" (About visible): show the STATIC synapse-text <img>,
       never the canvas — on phones the canvas ready-draw silently failed
       and left an empty circle where the brand should be. The circle now
       always shows something real: brain image before ready, wordmark
       after. Canvas stays a desktop-only concern. */
    .synapse-container:global(.ready) .synapse-fallback {
      display: none;
    }
    .synapse-container:global(.ready) .synapse-ready-img {
      display: block;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .synapse-tooltip {
      animation: none;
    }
  }
</style>
