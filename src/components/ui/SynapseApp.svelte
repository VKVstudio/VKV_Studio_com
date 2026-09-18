<script lang="ts">
  /**
   * SynapseApp.svelte
   * ─────────────────────────────────────────────────────────────────────────────
   * Orchestrator component — bridges SynapseBrain (trigger) and SynapseTerminal
   * (fullscreen overlay).
   *
   * Responsibilities:
   *  • Renders SynapseBrain and SynapseTerminal
   *  • Manages `terminalOpen` state between them
   *  • GSAP scale transition: Brain scales 1→0 on open, 0→1 on close
   *  • Guards SynapseTerminal with `mounted` flag to prevent SSR hydration
   *    errors (terminal uses browser-only APIs: Canvas, AudioContext, stores)
   *
   * Svelte 5 runes: $state, $effect
   */

  import { gsap } from 'gsap';
  import { onMount } from 'svelte';
  import SynapseBrain from '@/components/ui/SynapseBrain.svelte';
  import SynapseTerminal from '@/components/ui/SynapseTerminal.svelte';
  import type { Lang } from '@/i18n/utils';

  // ─── Props ────────────────────────────────────────────────────────────────────

  interface Props {
    /** Site language — threaded to SynapseBrain so its a11y label is correct
        at SSR time (the terminal self-detects from the URL on mount). */
    lang: Lang;
  }
  const { lang }: Props = $props();

  // ─── State ────────────────────────────────────────────────────────────────────

  let terminalOpen = $state(false);

  /**
   * Client-side mount guard.
   * SynapseTerminal uses browser-only APIs (Canvas, AudioContext, Svelte stores
   * with RAF loops) that cannot run during Astro's static-site generation.
   * We defer rendering until the component mounts in the browser.
   */
  let mounted = $state(false);

  /** Wrapper element around SynapseBrain — used to locate brain for GSAP */
  let brainWrapEl: HTMLElement | undefined = $state();

  onMount(() => {
    mounted = true;
  });

  // ─── Handlers ─────────────────────────────────────────────────────────────────

  function openTerminal(): void {
    terminalOpen = true;
  }

  function closeTerminal(): void {
    terminalOpen = false;
  }

  // ─── GSAP: Brain scale transition ─────────────────────────────────────────────
  //
  // The SynapseBrain renders a position:fixed `.synapse-container`.
  // We animate *that* element directly (not a parent wrapper) to avoid
  // creating a new containing block that would break fixed positioning.

  $effect(() => {
    if (!brainWrapEl) return;

    // Find the brain's fixed-position container rendered by SynapseBrain
    const brainContainer = brainWrapEl.querySelector('.synapse-container') as HTMLElement | null;
    if (!brainContainer) return;

    // House motion rule: under prefers-reduced-motion the STATE change still
    // happens (the brain must hide behind the terminal and come back), only
    // the tween between the two states goes — jump straight to the end value.
    // This effect re-runs on toggle, so a live OS-setting change is honored
    // on the next open/close without a listener (swarm audit 2026-09-06).
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (terminalOpen) {
      if (reduce) {
        gsap.set(brainContainer, { scale: 0, overwrite: true });
        return;
      }
      // Scale brain down — it disappears behind the terminal overlay
      gsap.to(brainContainer, {
        scale: 0,
        duration: 0.3,
        ease: 'power2.in',
        overwrite: true,
      });
    } else {
      if (reduce) {
        gsap.set(brainContainer, { scale: 1, overwrite: true });
        return;
      }
      // Scale brain back up with a spring overshoot
      gsap.to(brainContainer, {
        scale: 1,
        duration: 0.3,
        ease: 'back.out(1.7)',
        overwrite: true,
      });
    }
  });
</script>

<!-- Brain trigger button — existing component, wrapped for DOM access -->
<div bind:this={brainWrapEl} style="display: contents;">
  <SynapseBrain onActivate={openTerminal} {lang} />
</div>

<!-- Terminal overlay — client-only to avoid SSR errors from browser-only APIs -->
{#if mounted}
  <SynapseTerminal open={terminalOpen} onClose={closeTerminal} />
{/if}
