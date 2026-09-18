<script lang="ts">
  /**
   * SynapseOrb.svelte
   * ─────────────────────────────────────────────────────────────────────────────
   * Central visual element of the Synapse AI interface.
   *
   * Usage:
   *   <SynapseOrb state="idle" audioAmplitude={0} size={200} />
   *
   * Props
   * ─────
   *  • state          — 'idle' | 'listening' | 'thinking' | 'speaking'
   *  • audioAmplitude — 0-1 from AudioContext AnalyserNode
   *  • size           — logical CSS size in px (canvas scales for HiDPI)
   *
   * Architecture
   * ────────────
   *  • $effect (mount/unmount) — creates OrbRenderer on the canvas element
   *    and registers the ResizeObserver. Returns cleanup that calls destroy().
   *  • $effect (reactive) — watches state + audioAmplitude and pushes
   *    changes to the renderer without recreating it.
   *  • ResizeObserver watches the wrapper div so size changes (e.g. responsive
   *    breakpoints) are propagated to the canvas without re-mounting.
   *
   * Svelte 5 runes used
   * ───────────────────
   *  • $props()  — typed component props
   *  • $state()  — reactive DOM refs and derived values
   *  • $effect() — side-effects with cleanup (replaces onMount/onDestroy)
   */

  import { untrack } from 'svelte';
  import { createOrbRenderer } from '@/lib/synapse-orb-renderer';
  import type { OrbRenderer, OrbState } from '@/lib/synapse-orb-renderer';

  // ─── Props ──────────────────────────────────────────────────────────────────

  interface Props {
    /** Visual state of the orb */
    orbState?: OrbState;
    /**
     * Audio amplitude from 0 (silence) to 1 (max).
     * Drives particle displacement in 'listening' and wave intensity in 'speaking'.
     */
    audioAmplitude?: number;
    /** Logical CSS size of the orb in pixels */
    size?: number;
    /** Additional CSS classes forwarded to the wrapper element */
    class?: string;
  }

  const {
    orbState = 'idle',
    audioAmplitude = 0,
    size = 200,
    class: className = '',
  }: Props = $props();

  // ─── DOM refs ───────────────────────────────────────────────────────────────

  let wrapperEl: HTMLDivElement | undefined = $state();
  let canvasEl: HTMLCanvasElement | undefined = $state();

  // ─── Renderer instance (lives for the component lifetime) ───────────────────

  let renderer: OrbRenderer | null = null;

  // ─── Mount / unmount effect ─────────────────────────────────────────────────

  $effect(() => {
    if (!canvasEl || !wrapperEl) return;
    const wrapper = wrapperEl;

    // Initialise renderer — sets up RAF loop internally
    const r = createOrbRenderer(canvasEl);
    renderer = r;

    /* The initial push is UNTRACKED, and that is the whole point of this
       block. An $effect subscribes to every reactive value it reads, and its
       cleanup runs before each re-run — so reading `audioAmplitude` here made
       this the mount effect AND an amplitude watcher. `audioAmplitude` is
       driven by an AudioContext AnalyserNode, i.e. it changes every animation
       frame while Synapse is speaking. The orb was therefore destroying its
       renderer, tearing down the RAF loop and the ResizeObserver, and building
       all three again, sixty times a second, for the entire length of every
       spoken reply — on the one element the whole landing page is built
       around. `orbState` and `size` had the same problem, more slowly.

       The dedicated bridge effects below already push all three whenever they
       change; that is what they are for. This one only has to seed the
       renderer before the first paint, so it reads the current values without
       subscribing to them. */
    untrack(() => {
      r.resize(size);
      r.setState(orbState);
      r.setAmplitude(audioAmplitude);
    });

    // ResizeObserver: propagate logical size changes to the canvas
    // (fired when the `size` prop changes via CSS container or parent resize)
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry || !renderer) return;
      const logical = entry.contentRect.width;
      if (logical > 0) renderer.resize(logical);
    });
    ro.observe(wrapper);

    // Cleanup — called when component unmounts or $effect re-runs
    return () => {
      ro.disconnect();
      renderer?.destroy();
      renderer = null;
    };
  });

  // ─── Reactive prop → renderer bridge ────────────────────────────────────────

  /**
   * Push `state` changes to the renderer.
   * This runs AFTER the mount effect because $effects are ordered by
   * declaration order in Svelte 5.
   */
  $effect(() => {
    if (!renderer) return;
    renderer.setState(orbState);
  });

  /**
   * Push `audioAmplitude` changes to the renderer.
   * Kept separate from state to allow high-frequency updates from AudioContext
   * without triggering unnecessary state transitions.
   */
  $effect(() => {
    if (!renderer) return;
    renderer.setAmplitude(audioAmplitude);
  });

  /**
   * Push `size` changes to the renderer.
   * ResizeObserver handles runtime layout changes, but the prop can also change
   * programmatically (e.g. when the panel opens and the orb enlarges).
   */
  $effect(() => {
    if (!renderer) return;
    renderer.resize(size);
  });
</script>

<!--
  Wrapper div — sized by `size` prop, centres the canvas.
  The canvas is position:absolute so it can be exactly size×size
  regardless of parent layout.
-->
<div
  bind:this={wrapperEl}
  class="synapse-orb-wrapper {className}"
  style="width: {size}px; height: {size}px;"
  aria-hidden="true"
  data-state={orbState}
>
  <!--
    The canvas element.
    - width/height attributes are set programmatically via renderer.resize()
      to correctly apply devicePixelRatio.
    - CSS width/height are also set by resize() to `size` px.
    - aria-hidden: the orb is decorative — no meaningful text content.
  -->
  <canvas bind:this={canvasEl} class="synapse-orb-canvas" aria-hidden="true"></canvas>

  <!--
    Reduced-motion fallback: a simple static glow ring.
    Visible only when prefers-reduced-motion: reduce matches.
    The renderer still draws a basic glow on the canvas, but this CSS-only
    ring ensures something meaningful is visible even with JS disabled.
  -->
  <span class="synapse-orb-fallback" aria-hidden="true"></span>
</div>

<style>
  /* ── Wrapper ──────────────────────────────────────────────────────── */
  .synapse-orb-wrapper {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;

    /*
     * Outer ring — a subtle cyan border that shifts colour with the state.
     * CSS custom properties are set via data-state attribute selectors below,
     * so the ring colour follows the visual state even before JS runs.
     */
    border-radius: 50%;
    border: 1px solid var(--orb-border-color, hsla(185, 80%, 60%, 0.15));
    box-shadow: 0 0 32px var(--orb-glow-color, hsla(185, 80%, 60%, 0.08));
    transition:
      border-color 600ms cubic-bezier(0.16, 1, 0.3, 1),
      box-shadow 600ms cubic-bezier(0.16, 1, 0.3, 1);

    /*
     * will-change: allow compositor to promote the layer ahead of animations.
     * Only applied here (not on canvas) — promotes the entire orb at once.
     */
    will-change: opacity, transform;
  }

  /* ── State-driven CSS custom properties ──────────────────────────── */

  .synapse-orb-wrapper[data-state='idle'] {
    --orb-border-color: hsla(185, 80%, 60%, 0.15);
    --orb-glow-color: hsla(185, 80%, 60%, 0.06);
  }

  .synapse-orb-wrapper[data-state='listening'] {
    --orb-border-color: hsla(155, 60%, 50%, 0.3);
    --orb-glow-color: hsla(155, 60%, 50%, 0.12);
  }

  .synapse-orb-wrapper[data-state='thinking'] {
    --orb-border-color: hsla(195, 20%, 85%, 0.25);
    --orb-glow-color: hsla(195, 20%, 85%, 0.1);
  }

  .synapse-orb-wrapper[data-state='speaking'] {
    --orb-border-color: hsla(185, 80%, 60%, 0.4);
    --orb-glow-color: hsla(185, 80%, 60%, 0.18);
  }

  /* ── Canvas ───────────────────────────────────────────────────────── */
  .synapse-orb-canvas {
    position: absolute;
    inset: 0;
    display: block;
    border-radius: 50%;
    /*
     * CSS border-radius clips the canvas visually — keeps the orb circular
     * without needing to clip paths in the drawing code.
     */
  }

  /* ── Reduced-motion fallback ──────────────────────────────────────── */
  .synapse-orb-fallback {
    display: none; /* hidden by default; shown via media query below */
    position: absolute;
    inset: 15%;
    border-radius: 50%;
    background: radial-gradient(
      circle,
      hsla(185, 80%, 60%, 0.2) 0%,
      hsla(185, 80%, 60%, 0.06) 50%,
      transparent 100%
    );
  }

  @media (prefers-reduced-motion: reduce) {
    /*
     * When the user prefers reduced motion:
     *  • Hide the animated canvas (renderer still draws a minimal static glow)
     *  • Show the pure-CSS fallback ring instead
     *  • Remove the will-change hint (no compositor promotion needed)
     */
    .synapse-orb-canvas {
      opacity: 0.4; /* don't fully hide — renderer still draws static glow */
    }

    .synapse-orb-fallback {
      display: block;
    }

    .synapse-orb-wrapper {
      will-change: auto;
      /* Remove animated border transition */
      transition: none;
    }
  }
</style>
