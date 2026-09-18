<script lang="ts">
  /**
   * CookieConsent.svelte
   * ─────────────────────────────────────────────────────────────────────────────
   * Honest privacy/local-storage notice — not a granular consent manager,
   * because this site currently has nothing non-essential to opt out of:
   * it sets NO cookies at all (language comes from the URL path, not a
   * cookie), uses localStorage/IndexedDB only for on-device functionality
   * (dismissing this notice, caching Lab-tool data and model weights, and
   * local Synapse chat history), and there is no analytics/advertising/
   * tracking of any kind.
   *
   * Behavior
   * ────────
   *  • Shows once, on first visit (checked via localStorage, not a cookie —
   *    using a cookie to gate a cookie notice would be a little too ironic).
   *  • Dismissal ("Got it" / Escape key) persists so it never reappears.
   *  • Non-modal: fixed-position card, no backdrop, never blocks content or
   *    shifts layout (out of document flow the whole time).
   *  • Slide/fade-in motion lives entirely behind
   *    `@media (prefers-reduced-motion: no-preference)`; reduced-motion
   *    users just get an opacity fade.
   *
   * Svelte 5 runes used
   * ───────────────────
   *  • $props()  — typed lang prop
   *  • $state()  — mounted (in DOM at all) / visible (animate-in class)
   *  • $effect() — Escape-key listener, scoped to only while visible
   */
  import type { Lang } from '@i18n/utils';
  import { onMount } from 'svelte';

  // Strings arrive as pre-resolved props, not via `t()` at runtime. `t()` and
  // its `en.json`/`ru.json` dictionary (95,906 B raw / 25,510 B brotli for
  // BOTH locales, every Lab-tool string included) were previously imported
  // straight into this component's client bundle for exactly these four
  // strings, and this banner is `client:idle` on all 11 commercial pages —
  // on pages with no other island (the case-study pages), that one import
  // was ~32% of the entire page's JS transfer. BaseLayout.astro resolves
  // `t(lang, 'cookieConsent.*')` server-side, at build time, and passes the
  // already-localized strings down as ordinary Astro props — the dictionary
  // itself never needs to exist on the client for this banner. `lang` is
  // kept only to build the `/privacy/` link path, not for translation.
  interface Props {
    lang: Lang;
    message: string;
    learnMoreLabel: string;
    acceptLabel: string;
    ariaLabel: string;
  }

  const { lang, message, learnMoreLabel, acceptLabel, ariaLabel }: Props = $props();

  const STORAGE_KEY = 'vkv-cookie-consent-v1';
  const EXIT_DURATION_MS = 320;

  /** Whether the banner exists in the DOM at all (false once dismissed). */
  let mounted = $state(false);
  /** Whether the "visible" (animated-in) class is applied.
   *  Also drives `inert` on the wrapper: the banner is in the DOM but at
   *  `opacity: 0` twice — for one frame between mount and the animate-in
   *  flip, and again for the whole EXIT_DURATION_MS fade-out after dismissal.
   *  `pointer-events: none` covered the mouse for those windows but not the
   *  keyboard or the accessibility tree, so a Tab press could land on an
   *  invisible link, and a screen reader could still walk into a banner the
   *  user had already dismissed. `inert` closes both (it takes the subtree
   *  out of the tab order AND out of the a11y tree) without touching the
   *  consent flow — nothing about what is stored or when changes. */
  let visible = $state(false);

  // Set once at mount; only gates the JS-side exit-animation delay below —
  // the CSS animation itself is gated separately via the media query.
  let reducedMotion = false;

  function dismiss(): void {
    try {
      localStorage.setItem(STORAGE_KEY, '1');
    } catch {
      // localStorage unavailable (private browsing / disabled storage) —
      // the banner will simply reappear next visit. Not worth failing over.
    }
    visible = false;
    window.setTimeout(
      () => {
        mounted = false;
      },
      reducedMotion ? 0 : EXIT_DURATION_MS
    );
  }

  onMount(() => {
    reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    let alreadyConsented = false;
    try {
      alreadyConsented = localStorage.getItem(STORAGE_KEY) === '1';
    } catch {
      alreadyConsented = false;
    }
    if (alreadyConsented) return;

    mounted = true;
    // Next frame, so the initial (hidden) styles have painted before the
    // "visible" class flips in — otherwise the transition has nothing to
    // transition from.
    requestAnimationFrame(() => {
      visible = true;
    });
  });

  // Escape-key dismissal, only wired up while the banner is actually shown.
  $effect(() => {
    if (!visible) return;

    function onKeydown(e: KeyboardEvent): void {
      if (e.key === 'Escape') dismiss();
    }

    window.addEventListener('keydown', onKeydown);
    return () => window.removeEventListener('keydown', onKeydown);
  });

  // Publish this element's real height so the Synapse brain can step above it.
  // Below 640px the banner is a full-width sheet flush with the bottom edge,
  // and the brain is fixed at bottom:24px / 80px tall with z-index 90 against
  // the sheet's 500 — so on a first visit the site's entry point into the
  // assistant sits underneath the consent prompt. The sheet's height depends on
  // its content and therefore on the locale, so it is measured, not guessed.
  // The property only exists while the sheet is on screen; removing it on
  // teardown is what drops the brain back to its normal position.
  let el = $state<HTMLElement | null>(null);

  $effect(() => {
    const node = el;
    if (!visible || !node) return;

    const root = document.documentElement;
    const publish = (): void =>
      root.style.setProperty('--consent-sheet-height', `${node.offsetHeight}px`);
    publish();

    const ro = new ResizeObserver(publish);
    ro.observe(node);
    return () => {
      ro.disconnect();
      root.style.removeProperty('--consent-sheet-height');
    };
  });
</script>

{#if mounted}
  <div
    bind:this={el}
    class="cookie-consent"
    class:cookie-consent--visible={visible}
    role="region"
    aria-label={ariaLabel}
    inert={!visible}
  >
    <p class="cookie-consent__message">
      {message}
      <a href={`/${lang}/privacy/`} class="cookie-consent__link">
        {learnMoreLabel}
      </a>
    </p>
    <button type="button" class="cookie-consent__accept" onclick={dismiss}>
      {acceptLabel}
    </button>
  </div>
{/if}

<style>
  .cookie-consent {
    position: fixed;
    left: var(--space-4);
    right: var(--space-4);
    /* max(): structural safe-area guarantee for the floating-card variant
       too, not just the ≤640px sheet — otherwise any future spacing tweak
       silently re-buries the card under the gesture strip. */
    bottom: max(var(--space-4), env(safe-area-inset-bottom, 0px));
    z-index: 500;
    max-width: 440px;
    margin-inline: auto;
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    padding: var(--space-5);
    background: var(--glass-bg);
    border: 1px solid var(--glass-border);
    border-radius: var(--radius-lg);
    backdrop-filter: blur(var(--glass-blur));
    -webkit-backdrop-filter: blur(var(--glass-blur));
    box-shadow: var(--glass-shadow);
    opacity: 0;
    pointer-events: none;
    transition: opacity var(--duration-slow) var(--ease-out);
  }

  /* The standard property, restated where the CSS minifier cannot rewrite it
     away — it collapses `backdrop-filter` into the -webkit- alias alone, which
     leaves Firefox with a flat fill. It does not collapse across an @supports
     boundary. Must stay AFTER the base rule: equal specificity, last wins. */
  @supports (backdrop-filter: blur(1px)) {
    .cookie-consent {
      backdrop-filter: blur(var(--glass-blur));
    }
  }

  .cookie-consent--visible {
    opacity: 1;
    pointer-events: auto;
  }

  /* Slide-in transform lives entirely behind the reduced-motion gate —
     users who don't want motion get a plain opacity fade instead. */
  @media (prefers-reduced-motion: no-preference) {
    .cookie-consent {
      transform: translateY(24px);
      transition:
        opacity var(--duration-slow) var(--ease-out),
        transform var(--duration-slow) var(--ease-out);
    }

    .cookie-consent--visible {
      transform: translateY(0);
    }
  }

  .cookie-consent__message {
    font-size: var(--text-sm);
    line-height: var(--leading-relaxed);
    color: var(--text-secondary);
  }

  .cookie-consent__link {
    display: inline-block;
    margin-left: var(--space-1);
    color: var(--accent-green-300);
    text-decoration: underline;
    text-underline-offset: 2px;
    white-space: nowrap;
    transition: color var(--duration-normal) var(--ease-out);
  }

  .cookie-consent__link:hover {
    color: var(--accent-green-200);
  }

  .cookie-consent__link:focus-visible {
    outline: 2px solid var(--accent-green-300);
    outline-offset: 2px;
    border-radius: var(--radius-sm);
  }

  .cookie-consent__accept {
    align-self: flex-end;
    min-height: 44px;
    padding: var(--space-2) var(--space-6);
    /* NOT --gradient-accent. That token runs accent-green-300 → accent-blue-300,
       and this button puts --bg-void (near-black) text on it at --text-sm
       (12.8–14px, semibold — not WCAG "large text", so the threshold is 4.5:1).
       Computed against the blue end: bg-void rgb(6,7,9) L=0.002146 vs
       accent-blue-300 rgb(66,103,215) L=0.157363 →
       (0.157363+0.05)/(0.002146+0.05) = 3.98:1 — a 1.4.3 AA failure. Sweeping
       the gradient axis, it drops under 4.5:1 from roughly t=0.86 onward, i.e.
       the bottom-right corner of a 135deg fill; at ≤640px the button is
       `align-self: stretch`, so the end of the label sits in exactly that zone.
       No text colour can rescue it: even pure #000 on accent-blue-300 is
       (0.157363+0.05)/0.05 = 4.15:1. So the fill has to change, and the token
       itself must not (it is shared with ContactSection's .btn-primary and
       anything else that may pick it up).
       Green-only ramp instead — the recipe already used by the form's submit
       button (ContactFunnel.svelte:476) and the hero CTA (HeroOverlay.svelte:902).
       Worst point is the green-400 end: rgb(43,171,118) L=0.310756 →
       (0.310756+0.05)/(0.002146+0.05) = 6.92:1. */
    background: linear-gradient(135deg, var(--accent-green-300), var(--accent-green-400));
    color: var(--bg-void);
    font-family: var(--font-sans);
    font-size: var(--text-sm);
    font-weight: var(--weight-semibold);
    border: none;
    border-radius: var(--radius-md);
    cursor: pointer;
    transition: var(--transition-all);
  }

  .cookie-consent__accept:hover {
    box-shadow: var(--glow-green);
  }

  .cookie-consent__accept:focus-visible {
    outline: 2px solid var(--accent-green-300);
    outline-offset: 2px;
  }

  @media (prefers-reduced-motion: no-preference) {
    .cookie-consent__accept:hover {
      transform: translateY(-1px);
    }
  }

  /* ── Mobile: bottom sheet ──────────────────────────────────── */
  @media (max-width: 640px) {
    .cookie-consent {
      left: 0;
      right: 0;
      bottom: 0;
      max-width: none;
      border-radius: var(--radius-lg) var(--radius-lg) 0 0;
      padding: var(--space-5) var(--space-5) calc(var(--space-5) + env(safe-area-inset-bottom, 0px));
    }

    .cookie-consent__accept {
      align-self: stretch;
    }
  }

  @media (max-width: 640px) and (prefers-reduced-motion: no-preference) {
    .cookie-consent {
      transform: translateY(100%);
    }

    .cookie-consent--visible {
      transform: translateY(0);
    }
  }
</style>
