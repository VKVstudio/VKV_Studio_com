/**
 * VKVstudio — Section Animations (GSAP ScrollTrigger)
 *
 * Orchestrates all scroll-triggered animations:
 *   - About: label/headline/body reveal + timeline items stagger
 *   - Lab: header reveal + cards translateZ entrance stagger
 *   - Stack: header reveal + badges stagger
 *   - Contact: scale-up + opacity reveal
 *
 * All animations are disabled for prefers-reduced-motion.
 * Lenis must be initialized before this script runs.
 *
 * Usage: import '@scripts/section-animations' in the page script.
 */

import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

/* ── Register plugin ───────────────────────────────────────── */

gsap.registerPlugin(ScrollTrigger);

/* ── Reduced motion guard ──────────────────────────────────── */

const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Make animated content visible immediately (reduced motion, or a failed
 *  init). Scoped: pass a section element to rescue ONLY that section — a
 *  Contact failure must not stomp About/Lab/Stack's healthy ScrollTriggers. */
function disableAnimations(root: Document | HTMLElement = document): void {
  // Kill this root's triggers FIRST: a forced inline style means nothing if
  // a stale scrubbed tween later replays against its recorded from-state.
  ScrollTrigger.getAll().forEach((st) => {
    const trigger = st.trigger;
    if (root === document || (trigger instanceof Element && root.contains(trigger))) {
      st.kill();
    }
  });
  const allAnimated = root.querySelectorAll<HTMLElement>(
    '.js-about-reveal, .js-timeline-item, .js-timeline-dot, .js-timeline-card, .js-timeline-line, .js-lab-header, .js-lab-card, .lab__card-visual, .lab__card-content, .lab__card-cta, .js-stack-header, .js-stack-card, .js-stack-glass, .js-contact-reveal'
  );
  allAnimated.forEach((el) => {
    el.style.opacity = '1';
    el.style.transform = 'none';
    el.style.filter = 'none';
  });
}

/* ── Main init ─────────────────────────────────────────────── */

export function initSectionAnimations(): void {
  // Stack hover/tap wiring attaches UNCONDITIONALLY — before the reduced-motion
  // early return. Previously all stack hover listeners lived inside
  // initStackAnimations(), which is skipped under reduced motion, so those
  // users got ZERO hover feedback ever. Reduced motion means "no eased
  // tweening", not "the interaction does not exist" — initStackHoverEffects()
  // resolves every duration to 0 internally instead.
  try {
    initStackHoverEffects();
  } catch (err) {
    console.error('[section-animations] stack hover init failed:', err);
  }

  if (prefersReducedMotion) {
    disableAnimations();
    return;
  }

  // Each section's init is isolated: About/Lab/Stack/Contact all start at
  // opacity:0 in their scoped CSS and rely on these calls to ever appear.
  // One throw used to abort the rest of this synchronous chain — every
  // section after the faulty one stayed invisible forever. A failure now
  // degrades ONLY that section to "visible, no animation": the scoped
  // disableAnimations also kills the section's own half-created triggers,
  // while the healthy sections keep their reveals untouched.
  const inits: Array<[string, () => void]> = [
    ['about', initAboutAnimations],
    ['lab', initLabAnimations],
    ['stack', initStackAnimations],
    ['contact', initContactAnimations],
  ];
  for (const [sectionId, init] of inits) {
    try {
      init();
    } catch (err) {
      console.error(`[section-animations] ${sectionId} init failed:`, err);
      const section = document.getElementById(sectionId);
      if (section) disableAnimations(section);
      else disableAnimations();
    }
  }
}

/* ── ABOUT SECTION ─────────────────────────────────────────── */

function initAboutAnimations(): void {
  const section = document.getElementById('about');
  if (!section) return;

  // Reveal elements stagger (label, headline, body, philosophy)
  const revealEls = section.querySelectorAll<HTMLElement>('.js-about-reveal');

  if (revealEls.length > 0) {
    gsap.fromTo(
      revealEls,
      { opacity: 0, y: 40 },
      {
        opacity: 1,
        y: 0,
        duration: 0.8,
        stagger: 0.15,
        ease: 'expo.out',
        scrollTrigger: {
          trigger: section,
          start: 'top 80%',
          toggleActions: 'play none none none',
        },
      }
    );
  }

  // ── PREMIUM TIMELINE: "Neural Signal Propagation" ──────────

  const timeline = section.querySelector<HTMLElement>('.about__timeline');
  if (!timeline) return;

  // 1. VERTICAL LINE — position from first dot center to last dot center, then grow
  const line = timeline.querySelector<HTMLElement>('.js-timeline-line');
  const dots = timeline.querySelectorAll<HTMLElement>('.js-timeline-dot');

  if (line && dots.length >= 2) {
    const timelineRect = timeline.getBoundingClientRect();
    const firstDot = dots[0];
    const lastDot = dots[dots.length - 1];
    const firstDotRect = firstDot.getBoundingClientRect();
    const lastDotRect = lastDot.getBoundingClientRect();

    // Calculate top/height relative to timeline container
    const lineTop = firstDotRect.top - timelineRect.top + firstDotRect.height / 2;
    const lineBottom = lastDotRect.top - timelineRect.top + lastDotRect.height / 2;
    const lineHeight = lineBottom - lineTop;

    line.style.top = `${lineTop}px`;
    line.style.height = `${lineHeight}px`;

    gsap.to(line, {
      scaleY: 1,
      ease: 'none',
      scrollTrigger: {
        trigger: timeline,
        start: 'top 75%',
        end: 'bottom 40%',
        scrub: 0.8,
      },
    });
  }

  // 2. TIMELINE ITEMS — individual per-item choreography
  const items = timeline.querySelectorAll<HTMLElement>('.js-timeline-item');

  items.forEach((item, index) => {
    const dot = item.querySelector<HTMLElement>('.js-timeline-dot');
    const icon = item.querySelector<HTMLElement>('.timeline-item__icon');
    const card = item.querySelector<HTMLElement>('.js-timeline-card');

    // ── Create per-item timeline ─────────────────────────────
    const itemTl = gsap.timeline({
      scrollTrigger: {
        trigger: item,
        start: 'top 78%',
        toggleActions: 'play none none none',
      },
    });

    // Phase 1: Dot springs into existence
    if (dot) {
      itemTl.fromTo(
        dot,
        {
          scale: 0,
          boxShadow: '0 0 0px transparent',
        },
        {
          scale: 1,
          boxShadow: '0 0 20px hsla(155, 70%, 50%, 0.4)',
          duration: 0.6,
          ease: 'back.out(2.5)',
          onComplete: () => {
            // Activate perpetual glow pulse
            dot.classList.add('is-active');
          },
        },
        0
      );
    }

    // Phase 2: Icon rotates in (slightly delayed)
    if (icon) {
      itemTl.fromTo(
        icon,
        { rotation: -90, scale: 0.6, opacity: 0 },
        {
          rotation: 0,
          scale: 1,
          opacity: 1,
          duration: 0.5,
          ease: 'back.out(1.8)',
        },
        0.15
      );
    }

    // Phase 3: Card slides in from blur
    if (card) {
      itemTl.fromTo(
        card,
        {
          opacity: 0,
          x: -30,
          filter: 'blur(6px)',
        },
        {
          opacity: 1,
          x: 0,
          filter: 'blur(0px)',
          duration: 0.7,
          ease: 'expo.out',
        },
        0.25
      );
    }
  });
}

/* ── LAB SECTION ───────────────────────────────────────────── */

function initLabAnimations(): void {
  const section = document.getElementById('lab');
  if (!section) return;

  // Header reveal
  const header = section.querySelector<HTMLElement>('.js-lab-header');
  if (header) {
    gsap.fromTo(
      header,
      { opacity: 0, y: 40 },
      {
        opacity: 1,
        y: 0,
        duration: 0.8,
        ease: 'expo.out',
        scrollTrigger: {
          trigger: header,
          start: 'top 85%',
          toggleActions: 'play none none none',
        },
      }
    );
  }

  // Cards: per-card premium choreography
  const cards = section.querySelectorAll<HTMLElement>('.js-lab-card');

  cards.forEach((card, index) => {
    const visual = card.querySelector<HTMLElement>('.lab__card-visual');
    const content = card.querySelector<HTMLElement>('.lab__card-content');
    const cta = card.querySelector<HTMLElement>('.lab__card-cta');

    const cardTl = gsap.timeline({
      scrollTrigger: {
        trigger: card,
        start: 'top 82%',
        toggleActions: 'play none none none',
      },
    });

    // Phase 1: Card wrapper fades in with scale
    cardTl.fromTo(
      card,
      { opacity: 0, y: 50, scale: 0.92 },
      {
        opacity: 1,
        y: 0,
        scale: 1,
        duration: 0.7,
        ease: 'expo.out',
      },
      0
    );

    // Phase 2: Image reveals with slight zoom out
    if (visual) {
      cardTl.fromTo(
        visual,
        { scale: 1.15, opacity: 0 },
        {
          scale: 1,
          opacity: 1,
          duration: 0.8,
          ease: 'power2.out',
        },
        0.15
      );
    }

    // Phase 3: Content slides up
    if (content) {
      cardTl.fromTo(
        content,
        { opacity: 0, y: 20 },
        {
          opacity: 1,
          y: 0,
          duration: 0.5,
          ease: 'expo.out',
        },
        0.35
      );
    }

    // Phase 4: CTA fades in
    if (cta) {
      cardTl.fromTo(
        cta,
        { opacity: 0, x: -8 },
        {
          opacity: 0.6,
          x: 0,
          duration: 0.4,
          ease: 'power2.out',
          // Hand opacity BACK to the stylesheet when the reveal ends: the
          // tween's inline 0.6 otherwise pins the CTA forever, and every CSS
          // state — :hover 1, touch-rest 0.85, :active 1 — is dead against an
          // inline style. x stays GSAP-owned (CSS never styles it at rest).
          clearProps: 'opacity',
        },
        0.5
      );
    }
  });
}

/* ── STACK SECTION ─────────────────────────────────────────── */

function initStackAnimations(): void {
  const section = document.getElementById('stack');
  if (!section) return;

  // Header reveal
  const header = section.querySelector<HTMLElement>('.js-stack-header');
  if (header) {
    gsap.fromTo(
      header,
      { opacity: 0, y: 40 },
      {
        opacity: 1,
        y: 0,
        duration: 0.8,
        ease: 'expo.out',
        scrollTrigger: {
          trigger: header,
          start: 'top 85%',
          toggleActions: 'play none none none',
        },
      }
    );
  }

  // Cards: staggered reveal with scale + subtle rotation
  const cards = section.querySelectorAll<HTMLElement>('.js-stack-card');

  if (cards.length > 0) {
    gsap.fromTo(
      cards,
      { opacity: 0, y: 40, scale: 0.9 },
      {
        opacity: 1,
        y: 0,
        scale: 1,
        duration: 0.7,
        stagger: 0.08,
        ease: 'expo.out',
        scrollTrigger: {
          trigger: section.querySelector('.stack__grid'),
          start: 'top 80%',
          toggleActions: 'play none none none',
          onEnter: () => drawNeuralLines(section),
        },
      }
    );
  }

}

/* ── STACK CARD HOVER/TAP — frosted-fade reveal + glass parallax ──
   NO mask, by design (tests/unit/stack-glass-reveal.test.ts enforces the
   absence). The reveal is ONE opacity tween on the frosted glass: at rest
   the pane fully hides the logo; on open it melts and the logo emerges with
   its glow — the beloved pre-deploy behaviour, which (history!) only ever
   existed because the original mask grammar was invalid and the browser
   dropped it whole. Edge-free, identical on every logo, and
   resolution-independent: nothing left that can silently break. */

// Tunable by eye: lower = clearer logo at open. 0.3–0.6 all read well.
const GLASS_OPEN_OPACITY = 0.35;

// blur() first, matching the CSS rest filter — GSAP interpolates the pair.
const GLOW_REST = 'blur(7px) drop-shadow(0 0 12px hsla(155, 70%, 50%, 0.3))';
const GLOW_HOVER = 'blur(0px) drop-shadow(0 0 24px hsla(155, 70%, 50%, 0.6))';

const PARALLAX_MAX = 6;

// Reduced motion = duration 0 everywhere: gsap.to() with duration 0 applies
// the end state immediately, so there is exactly ONE code path for both
// motion preferences — no duplicate CSS block whose numbers could drift
// (two drifting sources is the exact root cause this component regressed on).
const OPEN_FADE_DURATION = prefersReducedMotion ? 0 : 0.65;
const OPEN_GLOW_DURATION = prefersReducedMotion ? 0 : 0.5;
const CLOSE_RELEASE_DURATION = prefersReducedMotion ? 0 : 0.5;
const CLOSE_GLOW_DURATION = prefersReducedMotion ? 0 : 0.4;

// Gates which USER GESTURE opens a card (mouse vs tap) — never whether the
// visual state exists. Touch users get the identical open()/close() via click.
const supportsHover = window.matchMedia('(hover: hover) and (pointer: fine)').matches;

function initStackHoverEffects(): void {
  const section = document.getElementById('stack');
  if (!section) return;

  const cards = section.querySelectorAll<HTMLElement>('.js-stack-card');

  // Touch singleton: at most one card open at a time (mirrors a single
  // cursor). Holds the close() of the currently-open card.
  let activeTapClose: (() => void) | null = null;

  cards.forEach((card) => {
    const glass = card.querySelector<HTMLElement>('.js-stack-glass');
    const logoImg = card.querySelector<HTMLElement>('.stack__card-logo-img');
    if (!glass) return;

    // open()/close() are the ONLY places that touch these animated
    // properties — for mouse and touch, for both motion preferences.
    // `.is-open` drives the purely cosmetic CSS crossfades (ring, glass
    // border/shadow, name color); GSAP exclusively owns everything with
    // real motion (iris vars, glass opacity + parallax x/y, logo glow/scale).

    const open = () => {
      card.classList.add('is-open');
      // will-change only WHILE interacting — never blanket on all cards
      // at rest (gsap-performance skill rule).
      glass.style.willChange = 'transform, opacity';

      // The melt: the frosted pane thins and the logo emerges through it.
      gsap.to(glass, {
        opacity: GLASS_OPEN_OPACITY,
        duration: OPEN_FADE_DURATION,
        ease: 'power2.out',
        overwrite: 'auto',
      });

      if (logoImg) {
        gsap.to(logoImg, {
          filter: GLOW_HOVER,
          scale: 1.05,
          duration: OPEN_GLOW_DURATION,
          ease: 'power2.out',
          overwrite: 'auto',
        });
      }
    };

    const close = () => {
      card.classList.remove('is-open');

      // The signature elastic "boing" on release — same ease as the original.
      // Under reduced motion duration is 0, so this simply snaps.
      gsap.to(glass, {
        x: 0,
        y: 0,
        opacity: 1,
        duration: CLOSE_RELEASE_DURATION,
        ease: 'elastic.out(1, 0.5)',
        overwrite: 'auto',
        onComplete: () => {
          glass.style.willChange = 'auto';
        },
      });

      if (logoImg) {
        gsap.to(logoImg, {
          filter: GLOW_REST,
          scale: 1,
          duration: CLOSE_GLOW_DURATION,
          ease: 'power2.out',
          overwrite: 'auto',
        });
      }
    };

    if (supportsHover) {
      // quickTo reuses ONE tween per axis across every mousemove instead of
      // allocating a new gsap.to() per event — mousemove fires far more often
      // than anything else here (gsap-performance skill pattern).
      const xTo = gsap.quickTo(glass, 'x', { duration: 0.4, ease: 'power2.out' });
      const yTo = gsap.quickTo(glass, 'y', { duration: 0.4, ease: 'power2.out' });

      card.addEventListener('mouseenter', open);

      card.addEventListener('mousemove', (e: MouseEvent) => {
        if (prefersReducedMotion) return; // parallax is pure motion — gate it
        const rect = card.getBoundingClientRect();
        const nx = (e.clientX - rect.left) / rect.width - 0.5;
        const ny = (e.clientY - rect.top) / rect.height - 0.5;
        xTo(-nx * PARALLAX_MAX * 2);
        yTo(-ny * PARALLAX_MAX * 2);
      });

      card.addEventListener('mouseleave', close);
    } else {
      // Touch/coarse pointers: mouseenter/leave are unreliable (mobile Safari
      // fires a synthetic hover on tap with no matching leave — a stuck card).
      // Explicit tap-to-open/tap-to-close with the SAME open()/close(), so
      // touch users get the full effect on their own terms.
      card.addEventListener('click', () => {
        const reopening = activeTapClose !== close;
        if (activeTapClose) activeTapClose();
        if (reopening) {
          open();
          activeTapClose = close;
        } else {
          activeTapClose = null;
        }
      });
    }
  });
}

/** Draw neural connection lines between card centers */
function drawNeuralLines(section: HTMLElement): void {
  const svg = section.querySelector<SVGSVGElement>('.js-neural-svg');
  const cards = section.querySelectorAll<HTMLElement>('.js-stack-card');
  if (!svg || cards.length < 2) return;

  const wrapRect = svg.parentElement!.getBoundingClientRect();
  svg.replaceChildren();

  // Compute card centers relative to wrapper
  const centers: { x: number; y: number }[] = [];
  cards.forEach((card) => {
    const r = card.getBoundingClientRect();
    centers.push({
      x: r.left + r.width / 2 - wrapRect.left,
      y: r.top + r.height / 2 - wrapRect.top,
    });
  });

  // Connect adjacent cards by their ACTUAL rendered positions. The grid is a
  // flex-wrap layout (centred last row), so `gridTemplateColumns` computes to
  // "none" here — the old code read it anyway, got cols=1, and silently drew a
  // degenerate chain: zero horizontal lines, "below" meaning "next in DOM".
  // Row membership is detected from the y coordinate instead; works for any
  // wrap count (6+5 desktop, 4+4+3 tablet, 2-per-row mobile) automatically.
  const rowTol = 10; // px — cards whose centers differ less than this share a row

  for (let i = 0; i < centers.length; i++) {
    const c = centers[i]!;

    // Right neighbour: the next card, only if it sits on the same visual row.
    const next = centers[i + 1];
    if (next && Math.abs(next.y - c.y) < rowTol) {
      addLine(svg, c, next, i * 0.15);
    }

    // Below neighbour: the horizontally-closest card in the NEXT row only
    // (centred rows are offset, so nearest-x gives clean, natural diagonals).
    let below: { x: number; y: number } | undefined;
    let belowRowY: number | undefined;
    for (let j = i + 1; j < centers.length; j++) {
      const cand = centers[j]!;
      if (cand.y <= c.y + rowTol) continue; // same row
      if (belowRowY === undefined) belowRowY = cand.y;
      if (cand.y > belowRowY + rowTol) break; // past the next row
      if (!below || Math.abs(cand.x - c.x) < Math.abs(below.x - c.x)) below = cand;
    }
    if (below) addLine(svg, c, below, i * 0.15 + 0.05);
  }

  // Trigger visibility after a beat
  requestAnimationFrame(() => svg.classList.add('is-visible'));
}

function addLine(
  svg: SVGSVGElement,
  a: { x: number; y: number },
  b: { x: number; y: number },
  delay: number
): void {
  const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  line.setAttribute('x1', String(a.x));
  line.setAttribute('y1', String(a.y));
  line.setAttribute('x2', String(b.x));
  line.setAttribute('y2', String(b.y));
  line.style.animationDelay = `${delay}s`;
  svg.appendChild(line);
}

/* ── CONTACT SECTION ───────────────────────────────────────── */

function initContactAnimations(): void {
  const section = document.getElementById('contact');
  if (!section) return;

  const inner = section.querySelector<HTMLElement>('.js-contact-reveal');
  if (!inner) return;

  gsap.fromTo(
    inner,
    { opacity: 0, scale: 0.92 },
    {
      opacity: 1,
      scale: 1,
      duration: 0.9,
      ease: 'back.out(1.4)',
      scrollTrigger: {
        trigger: section,
        start: 'top 75%',
        toggleActions: 'play none none none',
      },
    }
  );
}
