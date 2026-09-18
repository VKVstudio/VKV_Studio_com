/**
 * VKVstudio — Lenis Smooth Scroll Initialization
 *
 * Integrates Lenis with GSAP ticker for smooth scroll behavior.
 * Pattern from design_system.md §7 (Lenis + GSAP Integration).
 *
 * GSAP + ScrollTrigger are dynamically imported, AFTER the reduced-motion
 * check, not statically at module top. This module used to `import { gsap }
 * from 'gsap'` at the top level, and it is itself imported statically by
 * every page entry script (HeroCanvas, the rung pages, trust, contact) —
 * so that one static import pulled in the full 131 KB raw GSAP+ScrollTrigger
 * graph on EVERY page load, including for prefers-reduced-motion visitors,
 * for whom this module does nothing but return null. Each page also already
 * wraps its OWN gsap/ScrollTrigger usage in a `if (!prefersReducedMotion)
 * await Promise.all([import('gsap'), ...])` guard, but ES module semantics
 * evaluate a static import's whole graph before anything else runs, so that
 * guard was resolving from a module already loaded — it saved zero bytes.
 * Making the import here dynamic too, gated behind the same check, makes
 * that guard (both here and on the page) real: a reduced-motion visitor, or
 * a page with no motion at all, now downloads none of it.
 *
 * Usage:
 *   import { initLenis, getLenis } from '@scripts/lenis-init';
 *   void initLenis();
 */

import type Lenis from 'lenis';

/* ── Singleton instance ────────────────────────────────────── */

let lenisInstance: Lenis | null = null;
let initPromise: Promise<Lenis | null> | null = null;

/* ── EaseOutExpo curve ─────────────────────────────────────── */

function easeOutExpo(t: number): number {
  return t === 1 ? 1 : 1 - Math.pow(2, -10 * t);
}

/* ── Initialize Lenis ──────────────────────────────────────── */

/**
 * Fire-and-forget from most call sites (they don't await it — the singleton
 * is published on `window.lenisInstance` for anyone who needs it later, e.g.
 * a click handler on a scroll-hint button). Returns the same in-flight
 * promise on repeat calls so concurrent callers never trigger two imports or
 * two Lenis instances.
 */
export function initLenis(): Promise<Lenis | null> {
  // Respect reduced motion — bail before ever importing GSAP/Lenis.
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    return Promise.resolve(null);
  }

  // Fine-pointer-only, same gate the hero's own cursor-parallax code already
  // uses. touchMultiplier below only makes sense once a JS transform loop is
  // hijacking scroll from a mouse wheel — on a touch device it was silently
  // replacing the compositor's native scroll with a per-frame rAF (plus a
  // GSAP ticker with lag smoothing disabled), the exact place a phone on
  // 4x CPU throttling can least afford it. Coarse pointers keep native
  // scroll; ScrollTrigger still updates correctly off the native scroll
  // event without Lenis in the loop.
  if (!window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
    return Promise.resolve(null);
  }

  // Prevent double initialization
  if (lenisInstance) return Promise.resolve(lenisInstance);
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const [{ default: LenisCtor }, { gsap }, { ScrollTrigger }] = await Promise.all([
      import('lenis'),
      import('gsap'),
      import('gsap/ScrollTrigger'),
    ]);

    gsap.registerPlugin(ScrollTrigger);

    lenisInstance = new LenisCtor({
      duration: 1.2,
      easing: easeOutExpo,
      touchMultiplier: 1.5,
    });

    // Expose on window for Svelte islands (they can't import module singletons)
    (window as Window & { lenisInstance?: Lenis }).lenisInstance = lenisInstance;

    // Pipe Lenis scroll events to GSAP ScrollTrigger
    lenisInstance.on('scroll', ScrollTrigger.update);

    // Connect Lenis to GSAP ticker (runs on every frame)
    gsap.ticker.add((time: number) => {
      lenisInstance?.raf(time * 1000);
    });

    // Disable GSAP's lag smoothing for buttery scroll
    gsap.ticker.lagSmoothing(0);

    return lenisInstance;
  })();

  return initPromise;
}

/* ── Get current Lenis instance ────────────────────────────── */

export function getLenis(): Lenis | null {
  return lenisInstance;
}

/* ── Destroy Lenis ─────────────────────────────────────────── */

export function destroyLenis(): void {
  if (lenisInstance) {
    lenisInstance.destroy();
    lenisInstance = null;
  }
}
