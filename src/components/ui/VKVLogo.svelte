<script lang="ts">
  import { t } from '@i18n/utils';

  /**
   * VKVLogo — Scroll-journey logo component
   *
   * Phase transitions based on page scroll progress:
   *   0–70%  hidden:  completely invisible (hero has its own logo)
   *   70%+   pill:    fixed top-left pill with compact logo, click → scroll to top
   *
   * @default lang 'en'
   */
  type Lang = 'en' | 'ru';

  /** @prop lang - UI language for alt/aria text */
  let { lang = 'en' }: { lang?: Lang } = $props();

  // ---------------------------------------------------------------------------
  // Phase type (hero logo removed — hero section has its own)
  // ---------------------------------------------------------------------------
  type Phase = 'hidden' | 'pill';

  // ---------------------------------------------------------------------------
  // Reactive state
  // ---------------------------------------------------------------------------
  let scrollProgress = $state<number>(0); // 0–1
  let prefersReduced = $state<boolean>(false);
  let mounted = $state<boolean>(false);

  // ---------------------------------------------------------------------------
  // Derived phase
  // ---------------------------------------------------------------------------
  function computePhase(): Phase {
    if (scrollProgress < 0.7) return 'hidden';
    return 'pill';
  }

  const phase: Phase = $derived(computePhase());

  // ---------------------------------------------------------------------------
  // Derived inline styles for .logo-hero
  // ---------------------------------------------------------------------------
  function computeHeroStyle(): string {
    if (phase === 'hero') {
      return 'opacity:0.9; transform:scale(1) translateY(0); visibility:visible;';
    }
    if (phase === 'fadeout') {
      // linear interpolation within 25–35%
      const t = (scrollProgress - 0.25) / 0.1; // 0→1
      const opacity = 0.9 * (1 - t);
      const scale = 1 - 0.2 * t;
      const y = -20 * t;
      return `opacity:${opacity.toFixed(3)}; transform:scale(${scale.toFixed(3)}) translateY(${y.toFixed(1)}px); visibility:visible;`;
    }
    return 'opacity:0; transform:scale(0.8) translateY(-20px); visibility:hidden;';
  }

  const heroStyle: string = $derived(computeHeroStyle());

  // ---------------------------------------------------------------------------
  // Derived inline styles for .logo-pill
  // ---------------------------------------------------------------------------
  // opacity + pointer-events hide this from the mouse only. The button stayed in
  // the tab order while invisible — a dead focus stop near the top of both home
  // pages — and its own `:focus-visible` outline could never show, because this
  // inline opacity outranks any stylesheet rule short of !important, which the
  // house rules forbid. The `inert` attribute on the element below removes it
  // from the tab order and the accessibility tree while hidden, which is the
  // honest version of "not there".
  const pillStyle: string = $derived(
    phase === 'pill' ? 'opacity:1; pointer-events:auto;' : 'opacity:0; pointer-events:none;'
  );

  // ---------------------------------------------------------------------------
  // Alt / aria text
  // ---------------------------------------------------------------------------
  const altText: string = $derived(lang === 'ru' ? 'Логотип VKVstudio' : 'VKVstudio logo');

  // ---------------------------------------------------------------------------
  // Scroll handler
  // ---------------------------------------------------------------------------
  function handleScroll(): void {
    const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
    if (maxScroll <= 0) {
      scrollProgress = 0;
      return;
    }
    scrollProgress = Math.min(1, Math.max(0, window.scrollY / maxScroll));
  }

  // ---------------------------------------------------------------------------
  // Click-to-top handler
  // ---------------------------------------------------------------------------
  function scrollToTop(): void {
    const lenis = (window as { lenisInstance?: { scrollTo: (target: number) => void } })
      .lenisInstance;
    if (lenis) {
      lenis.scrollTo(0);
    } else {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }

  // ---------------------------------------------------------------------------
  // Effects
  // ---------------------------------------------------------------------------
  $effect(() => {
    // prefers-reduced-motion
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    prefersReduced = mq.matches;
    const onMqChange = (e: MediaQueryListEvent): void => {
      prefersReduced = e.matches;
    };
    mq.addEventListener('change', onMqChange);

    // scroll listener
    window.addEventListener('scroll', handleScroll, { passive: true });
    handleScroll(); // initial read

    mounted = true;

    return () => {
      mq.removeEventListener('change', onMqChange);
      window.removeEventListener('scroll', handleScroll);
    };
  });
</script>

<!-- Hero logo removed: hero section already has its own logo -->

<!-- ============================================================
     Pill  (fixed top-left, appears at 70%+)
     ============================================================ -->
{#if mounted}
  <button
    type="button"
    class="logo-pill"
    style={pillStyle}
    inert={phase !== 'pill'}
    aria-label={t(lang, 'nav.logoScrollToTop')}
    onclick={scrollToTop}
    tabindex={phase === 'pill' ? 0 : -1}
  >
    <picture>
      <source srcset="/vkv-logo-compact.avif" type="image/avif" />
      <source srcset="/vkv-logo-compact.webp" type="image/webp" />
      <img
        src="/vkv-logo-compact.png"
        alt=""
        class="logo-img-compact"
        draggable="false"
        width="40"
        height="28"
      />
    </picture>
  </button>
{/if}

<style>
  picture {
    display: contents;
  }


  /* ------------------------------------------------------------------
     Pill
  ------------------------------------------------------------------ */
  .logo-pill {
    position: fixed;
    top: 16px;
    left: 16px;
    height: 36px;
    padding: 4px 12px;
    background: hsla(220, 25%, 8%, 0.7);
    border: 1px solid hsla(155, 60%, 50%, 0.15);
    border-radius: 320px;
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    cursor: pointer;
    z-index: 100;
    display: flex;
    align-items: center;
    transition:
      opacity 0.3s ease,
      border-color 0.25s ease,
      box-shadow 0.25s ease;
    /* reset button styles */
    appearance: none;
    -webkit-appearance: none;
    background-clip: padding-box;
    will-change: opacity;
  }

  /* The standard property, restated where the CSS minifier cannot rewrite it
     away — it collapses `backdrop-filter` into the -webkit- alias alone, which
     leaves Firefox with a flat fill. It does not collapse across an @supports
     boundary. Must stay AFTER the base rule: equal specificity, last wins. */
  @supports (backdrop-filter: blur(1px)) {
    .logo-pill {
      backdrop-filter: blur(12px);
    }
  }

  .logo-pill:hover {
    border-color: hsla(155, 60%, 50%, 0.3);
    box-shadow: 0 0 20px hsla(155, 60%, 50%, 0.1);
  }

  .logo-pill:focus-visible {
    outline: 2px solid hsla(155, 60%, 50%, 0.6);
    outline-offset: 2px;
  }

  .logo-img-compact {
    display: block;
    width: 40px;
    height: 28px;
    object-fit: contain;
    user-select: none;
  }


  /* Respect reduced motion globally */
  @media (prefers-reduced-motion: reduce) {
    .logo-pill {
      transition: none;
      animation: none;
    }
  }
</style>
