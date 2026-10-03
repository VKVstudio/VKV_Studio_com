<script lang="ts">
  /**
   * SynapseApp.svelte
   * ─────────────────────────────────────────────────────────────────────────────
   * Orchestrator component — bridges SynapseBrain (trigger) and SynapseTerminal
   * (fullscreen overlay).
   *
   * Responsibilities:
   *  • Renders SynapseBrain immediately; loads and mounts SynapseTerminal LAZILY
   *  • Owns two separate facts and derives the orb's state from both:
   *      terminalOpen — the visitor ASKED for the terminal (click / Enter / Space)
   *      Terminal     — the terminal component is MOUNTED (chunk landed + mounted)
   *  • Brain collapse (1→0 on open, 0→1 on close) is a CSS transition inside
   *    SynapseBrain driven by the `collapsed` prop — no GSAP in this file
   *
   * Loading policy (2026-10-04)
   * ─────────────────────────────────────────────────────────────────────────────
   * This island hydrates at client:idle, but hydration and window load do not
   * fetch the terminal. import() fetches AND evaluates its dependency graph;
   * that work belongs to readiness or intent, not every homepage visit.
   *
   *  • Scroll readiness (`onReady`) fetches the chunk when the orb becomes
   *    available near #about. Coarse-pointer devices also mount it hidden in
   *    an idle slot, since a tap has no preceding hover.
   *  • Pointer / focus intent mounts the terminal ahead of a likely click.
   *  • Activation also requests a mount, sharing any in-flight import. An
   *    immediate first activation can pay the fetch / evaluation cost; the
   *    orb stays visible and reports pending until the terminal is available.
   *
   * The orb never collapses ahead of the terminal: `collapsed` derives from
   * `Terminal !== null`, not from the wish alone. A click that lands before
   * the chunk arrives leaves the orb in place with aria-busy and a pulse
   * (`pending`), and the terminal opens the moment it mounts — its
   * open-watcher effect runs playEntry() on mount. A failed chunk fetch
   * withdraws the wish (terminalOpen → false) so the orb stays clickable and
   * the next click runs the import again; the second failure in a row
   * switches the orb's label and tooltip to "reload the page to retry". It
   * says reload, not click, because that is what recovers: the HTML module
   * map records a failed module fetch as null for the life of the document.
   * A repeated import may therefore fail without another network request.
   * The retry remains available for browsers that can recover immediately.
   *
   * Svelte 5 runes: $state, $derived
   */

  import SynapseBrain from '@/components/ui/SynapseBrain.svelte';
  import type { Lang } from '@/i18n/utils';
  import type SynapseTerminal from '@/components/ui/SynapseTerminal.svelte';

  // ─── Props ────────────────────────────────────────────────────────────────────

  interface Props {
    /** Site language — threaded to SynapseBrain so its a11y label is correct
        at SSR time (the terminal self-detects from the URL on mount). */
    lang: Lang;
  }
  const { lang }: Props = $props();

  // ─── State ────────────────────────────────────────────────────────────────────

  /** The visitor asked for the terminal. Withdrawn again if the chunk fails. */
  let terminalOpen = $state(false);

  /**
   * The terminal component once MOUNTED, or null. `{#if Terminal}` below
   * doubles as the old client-side mount guard: a dynamic import never runs
   * during Astro's static build, so the terminal's browser-only APIs (Canvas,
   * AudioContext, IndexedDB) are never touched at SSR time.
   *
   * Two stages on purpose — fetched and mounted are different bills:
   *   • `terminalModule` (plain `let`, non-reactive) holds the evaluated
   *     chunk after a readiness / intent fetch. Evaluation does not mount it.
   *   • assigning `Terminal` (reactive) is what mounts it, and mounting is
   *     what runs the terminal's onMount: IndexedDB open + migration + purge,
   *     conversation creation, audio engine, auth subscription, heartbeat.
   * The first version of this file set `Terminal` straight from the import,
   * so the "warm-up" on the scroll gate mounted the whole thing for every
   * visitor who merely scrolled past #about (seen in the headless product
   * check: terminal in the DOM before any pointer had touched the orb).
   */
  let Terminal = $state<typeof SynapseTerminal | null>(null);
  let terminalModule: typeof SynapseTerminal | null = null;

  /** Click-path chunk failures in a row. Reset by a successful mount. */
  let loadFailures = $state(0);

  /** The orb may only collapse behind a terminal that exists. */
  const collapsed = $derived(terminalOpen && Terminal !== null);
  /** Asked for, not yet mounted: the orb stays, shows aria-busy and pulses. */
  const pending = $derived(terminalOpen && Terminal === null);
  /** Two failed opens in a row: the orb's label and tooltip say so. */
  const failed = $derived(loadFailures >= 2);

  /** In-flight (or settled) import — the loader is idempotent. Plain `let`,
      never read inside an effect. */
  let terminalLoad: Promise<typeof SynapseTerminal | null> | null = null;

  // ─── Loader ───────────────────────────────────────────────────────────────────

  /** Stage 1: fetch + evaluate the chunk. Mounts nothing. Resolves to the
      component, or to null when the fetch failed (never rejects). */
  function fetchTerminal(): Promise<typeof SynapseTerminal | null> {
    if (terminalLoad) return terminalLoad;
    terminalLoad = import('@/components/ui/SynapseTerminal.svelte')
      .then((mod) => {
        terminalModule = mod.default;
        return terminalModule;
      })
      .catch((err: unknown) => {
        // A failed chunk fetch (flaky mobile network) must not wedge the orb
        // forever: forget the attempt so the next intent retries.
        terminalLoad = null;
        console.error('[SynapseApp] SynapseTerminal chunk failed to load:', err);
        return null;
      });
    return terminalLoad;
  }

  /** Mount — intent on the orb, the click itself, or the coarse-
      pointer warm-up. Resolves to whether the terminal is mounted. */
  function mountTerminal(): Promise<boolean> {
    if (Terminal) return Promise.resolve(true);
    return fetchTerminal().then((mod) => {
      if (mod && !Terminal) Terminal = mod;
      return Terminal !== null;
    });
  }

  /**
   * requestIdleCallback where it exists; Safari has none (Baseline
   * "Limited"), so a flat delay stands in — the same fallback BaseLayout
   * uses for the WebMCP registration.
   */
  function whenIdle(fn: () => void, timeout: number, fallbackDelay: number): void {
    if ('requestIdleCallback' in window) {
      window.requestIdleCallback(() => fn(), { timeout });
    } else {
      window.setTimeout(fn, fallbackDelay);
    }
  }

  /** No hover on the primary input: a tap is the first and only intent. */
  function coarsePointer(): boolean {
    return window.matchMedia('(hover: none), (pointer: coarse)').matches;
  }

  /**
   * Fetch on the scroll gate opening. Fine pointers stop after fetching —
   * pointerenter / focus will mount ahead of the click. Coarse pointers mount
   * hidden in an idle slot: mounted with open=false, the terminal's overlay
   * keeps its inline `opacity: 0; visibility: hidden` and its open-watcher
   * plays nothing, so the visitor sees no change until the tap.
   */
  function warmTerminal(): void {
    void fetchTerminal();
    if (!coarsePointer()) return;
    whenIdle(() => void mountTerminal(), 3000, 500);
  }

  // ─── Handlers ─────────────────────────────────────────────────────────────────

  function openTerminal(): void {
    // A second tap while the first is still pending must not queue a second
    // failure count (and cannot open anything the first will not).
    if (terminalOpen) return;
    terminalOpen = true;
    void mountTerminal().then((mounted) => {
      if (mounted) {
        loadFailures = 0;
        return;
      }
      // The chunk did not arrive. Withdraw the wish: the orb is still at
      // scale 1 (collapsed derives from Terminal), so it stays the retry
      // surface, and the next click runs the import again (see the header
      // for why the message after two failures says reload).
      terminalOpen = false;
      loadFailures += 1;
    });
  }

  function closeTerminal(): void {
    terminalOpen = false;
  }
</script>

<!-- Brain trigger button — always mounted, tiny. `collapsed` drives its own
     CSS scale transition (1→0 behind the terminal, spring back on close);
     `pending` / `failed` are the two states of a click the terminal could
     not answer yet. -->
<SynapseBrain
  onActivate={openTerminal}
  onIntent={mountTerminal}
  onReady={warmTerminal}
  {collapsed}
  {pending}
  {failed}
  {lang}
/>

<!-- Terminal overlay — mounted on first intent, then kept (it owns chat
     state, the audio engine and the auth subscription; unmounting on close
     would throw those away). -->
{#if Terminal}
  <Terminal open={terminalOpen} onClose={closeTerminal} />
{/if}
