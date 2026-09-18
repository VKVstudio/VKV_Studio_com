<script lang="ts">
  /**
   * NeuralWaypoints — Premium scroll navigation rail
   *
   * Design principles (2026 best practices):
   *   - Ultra-minimal: thin track + tiny dots, no decorative lines
   *   - Active section: pill indicator with accent glow
   *   - Hover: label slides in with glassmorphism tooltip
   *   - Smooth Lenis scroll with distance-based duration
   *   - Appears from Career Arc (#about) onwards
   *
   * Inspired by: Linear, Vercel, Stripe, Apple navigation patterns.
   */

  import { onMount } from 'svelte';
  import { t } from '@i18n/utils';

  // ── Types ──────────────────────────────────────────────────────────────

  type Lang = 'en' | 'ru';

  interface Waypoint {
    id: string;
    labelEN: string;
    labelRU: string;
    target: string;
  }

  interface Props {
    lang?: Lang;
  }

  let { lang = 'en' }: Props = $props();

  // ── Data — matches page section order top → bottom ─────────────────

  const waypoints: Waypoint[] = [
    { id: 'hero-section', labelEN: 'HOME', labelRU: 'ГЛАВНАЯ', target: '#hero-section' },
    { id: 'about', labelEN: 'ABOUT', labelRU: 'ОБО МНЕ', target: '#about' },
    { id: 'lab', labelEN: 'LAB', labelRU: 'ЛАБОРАТОРИЯ', target: '#lab' },
    { id: 'stack', labelEN: 'STACK', labelRU: 'СТЕК', target: '#stack' },
    { id: 'contact', labelEN: 'CONTACT', labelRU: 'КОНТАКТ', target: '#contact' },
  ];

  // ── State ──────────────────────────────────────────────────────────────

  let activeId = $state<string>('');
  let hoveredId = $state<string | null>(null);
  let isVisible = $state(false);

  // ── Scroll navigation with distance-based duration ─────────────────

  function scrollTo(target: string): void {
    const lenis = (
      window as Window & {
        lenisInstance?: {
          scrollTo: (t: string | HTMLElement, o?: Record<string, unknown>) => void;
        };
      }
    ).lenisInstance;

    const targetEl = document.querySelector(target) as HTMLElement | null;
    if (!targetEl) return;

    const currentY = window.scrollY;
    const targetY = targetEl.getBoundingClientRect().top + currentY;
    const distance = Math.abs(targetY - currentY);

    // Hero portion scrolls 3× slower so video rewind is visible
    const heroEl = document.getElementById('hero-section');
    let multiplier = 0.04;

    if (heroEl && distance > 0) {
      const heroTop = heroEl.offsetTop;
      const heroBottom = heroTop + heroEl.offsetHeight;
      const pathStart = Math.min(currentY, targetY);
      const pathEnd = Math.max(currentY, targetY);
      const heroOverlap = Math.max(0, Math.min(pathEnd, heroBottom) - Math.max(pathStart, heroTop));
      const heroPortion = heroOverlap / distance;
      // 0.04 (normal ~2s) → 0.12 (hero ~10s)
      multiplier = 0.04 + heroPortion * 0.08;
    }

    const duration = Math.max(2, Math.sqrt(distance) * multiplier);

    if (lenis) {
      lenis.scrollTo(target, { duration });
    } else {
      targetEl.scrollIntoView({ behavior: 'smooth' });
    }
  }

  // ── Label helper ───────────────────────────────────────────────────

  function label(wp: Waypoint): string {
    return lang === 'ru' ? wp.labelRU : wp.labelEN;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────

  onMount(() => {
    // ── Visibility: show from Career Arc (#about) onwards ──
    const aboutSection = document.getElementById('about');

    const onScroll = (): void => {
      if (!aboutSection) return;
      const aboutTop = aboutSection.getBoundingClientRect().top;
      isVisible = aboutTop < window.innerHeight;
    };

    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();

    // ── Active section detection ──
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            activeId = entry.target.id;
          }
        }
      },
      { threshold: 0.3 }
    );

    for (const wp of waypoints) {
      const el = document.getElementById(wp.id);
      if (el) observer.observe(el);
    }

    return () => {
      window.removeEventListener('scroll', onScroll);
      observer.disconnect();
    };
  });
</script>

<nav class="waypoints" class:visible={isVisible} aria-label={t(lang, 'nav.pageSections')}>
  <!-- Track line -->
  <div class="track" aria-hidden="true"></div>

  <!-- Progress fill (animated to active dot position) -->
  <div
    class="track-fill"
    aria-hidden="true"
    style:--fill-index={waypoints.findIndex((w) => w.id === activeId)}
  ></div>

  {#each waypoints as wp, i (wp.id)}
    {@const isActive = activeId === wp.id}
    {@const isHovered = hoveredId === wp.id}

    <button
      class="dot-wrap"
      class:active={isActive}
      style:--i={i}
      aria-label={t(lang, 'nav.navigateToSection').replace('{label}', label(wp))}
      aria-current={isActive ? 'true' : undefined}
      onmouseenter={() => {
        hoveredId = wp.id;
      }}
      onmouseleave={() => {
        hoveredId = null;
      }}
      onfocus={() => {
        hoveredId = wp.id;
      }}
      onblur={() => {
        hoveredId = null;
      }}
      onclick={() => scrollTo(wp.target)}
    >
      <!-- Dot -->
      <span class="dot" aria-hidden="true">
        {#if isActive}
          <span class="dot-pulse"></span>
        {/if}
      </span>

      <!-- Label tooltip -->
      {#if isHovered || isActive}
        <span class="label" class:label--active={isActive}>
          {label(wp)}
        </span>
      {/if}
    </button>
  {/each}
</nav>

<style>
  /* ── Rail container ──────────────────────────────────── */
  .waypoints {
    position: fixed;
    right: 28px;
    top: 50%;
    transform: translateY(-50%);
    z-index: 90;

    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 28px;

    opacity: 0;
    pointer-events: none;
    transition: opacity 0.5s cubic-bezier(0.16, 1, 0.3, 1);
  }

  .waypoints.visible {
    opacity: 1;
    pointer-events: auto;
  }

  /* ── Track line ──────────────────────────────────────── */
  .track {
    position: absolute;
    top: 4px;
    bottom: 4px;
    width: 1px;
    background: hsla(0, 0%, 100%, 0.06);
    border-radius: 1px;
  }

  /* ── Track progress fill ─────────────────────────────── */
  .track-fill {
    position: absolute;
    top: 4px;
    width: 1px;
    border-radius: 1px;

    /* Height grows to the active dot position */
    height: calc((var(--fill-index, 0)) * 36px);
    background: linear-gradient(to bottom, hsla(155, 70%, 50%, 0.05), hsla(155, 70%, 50%, 0.25));
    transition: height 0.6s cubic-bezier(0.16, 1, 0.3, 1);
  }

  /* ── Dot wrapper (button) ────────────────────────────── */
  .dot-wrap {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;

    /* Hit target >= 24x24 per WCAG 2.5.8 (swarm audit 2026-09-06): the
       visible dot keeps its size — the padding only grows the button's
       clickable box. */
    width: 24px;
    height: 24px;

    background: none;
    border: none;
    cursor: pointer;
    padding: 0;
    z-index: 1;
  }

  .dot-wrap:focus-visible {
    outline: 1px solid hsla(155, 70%, 50%, 0.4);
    outline-offset: 6px;
    border-radius: 2px;
  }

  /* ── Dot ──────────────────────────────────────────────── */
  .dot {
    position: relative;
    display: block;
    width: 4px;
    height: 4px;
    border-radius: 50%;
    background: hsla(0, 0%, 100%, 0.2);
    transition:
      width 0.35s cubic-bezier(0.16, 1, 0.3, 1),
      height 0.35s cubic-bezier(0.16, 1, 0.3, 1),
      background 0.35s ease,
      box-shadow 0.35s ease,
      border-radius 0.35s cubic-bezier(0.16, 1, 0.3, 1);
  }

  .dot-wrap:hover .dot {
    width: 6px;
    height: 6px;
    background: hsla(0, 0%, 100%, 0.45);
  }

  .dot-wrap.active .dot {
    width: 6px;
    height: 16px;
    border-radius: 3px;
    background: hsl(155, 65%, 52%);
    box-shadow:
      0 0 8px hsla(155, 70%, 50%, 0.35),
      0 0 20px hsla(155, 70%, 50%, 0.12);
  }

  /* ── Active dot pulse ring ───────────────────────────── */
  .dot-pulse {
    position: absolute;
    inset: -3px;
    border-radius: inherit;
    border: 1px solid hsla(155, 70%, 50%, 0.2);
    animation: pulse-ring 2.5s cubic-bezier(0.16, 1, 0.3, 1) infinite;
  }

  @keyframes pulse-ring {
    0%,
    100% {
      opacity: 0.6;
      transform: scale(1);
    }
    50% {
      opacity: 0;
      transform: scale(1.8);
    }
  }

  /* ── Label tooltip ───────────────────────────────────── */
  .label {
    position: absolute;
    right: calc(100% + 14px);
    top: 50%;

    font-family: var(--font-mono, 'JetBrains Mono', monospace);
    font-size: 10px;
    font-weight: 500;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    white-space: nowrap;
    line-height: 1;

    color: hsla(0, 0%, 100%, 0.45);
    padding: 5px 10px;
    border-radius: 4px;
    background: hsla(220, 20%, 10%, 0.65);
    border: 1px solid hsla(0, 0%, 100%, 0.06);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);

    transform: translateY(-50%) translateX(4px);
    opacity: 0;
    animation: label-in 0.25s cubic-bezier(0.16, 1, 0.3, 1) forwards;
    pointer-events: none;
  }

  /* The standard property, restated where the CSS minifier cannot rewrite it
     away — it collapses `backdrop-filter` into the -webkit- alias alone, which
     leaves Firefox with a flat fill. It does not collapse across an @supports
     boundary. Must stay AFTER the base rule: equal specificity, last wins. */
  @supports (backdrop-filter: blur(1px)) {
    .label {
      backdrop-filter: blur(8px);
    }
  }

  .label--active {
    color: hsl(155, 65%, 58%);
    border-color: hsla(155, 60%, 50%, 0.1);
  }

  @keyframes label-in {
    to {
      opacity: 1;
      transform: translateY(-50%) translateX(0);
    }
  }

  /* ── Mobile: hidden ──────────────────────────────────── */
  @media (max-width: 767px) {
    .waypoints {
      display: none;
    }
  }

  /* ── Reduced motion ──────────────────────────────────── */
  @media (prefers-reduced-motion: reduce) {
    .waypoints {
      transition: none;
    }
    .dot {
      transition: none;
    }
    .track-fill {
      transition: none;
    }
    .dot-pulse {
      animation: none;
    }
    .label {
      animation: none;
      opacity: 1;
      transform: translateY(-50%);
    }
  }
</style>
