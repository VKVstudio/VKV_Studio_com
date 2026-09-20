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
   * Why the terminal is lazy (Lighthouse 13.5, mobile, 2026-09-20)
   * ─────────────────────────────────────────────────────────────────────────────
   * This island hydrates at client:idle on the homepage. With the terminal
   * mounted eagerly, SynapseApp.*.js cost 1635 ms total / 1569 ms scripting in
   * bootup-time on a page load where nobody had opened the chat — the terminal's
   * onMount opens IndexedDB, migrates old storage, purges stale anonymous chats,
   * creates a conversation, subscribes to auth, builds an AudioContext engine,
   * and starts a 20 s heartbeat. All of it for a panel behind a click that is
   * itself scroll-gated (the orb only becomes clickable once #about is on
   * screen — see brain-morph.ts; that gate is a feature).
   *
   * Three stages, three different bills (2026-09-21):
   *  1. PREFETCH — the chunk is imported in an idle slot right after the window
   *     `load` event, on every visit, gated on nothing. `import()` fetches AND
   *     evaluates the module graph (terminal + sidebar + orb renderer + gsap +
   *     Dexie + client); evaluation defines functions and registers nothing —
   *     the terminal's onMount is what costs, and nothing mounts here.
   *  2. WARM-UP on the scroll gate opening (`onReady`): fine-pointer devices
   *     only make sure stage 1 happened; coarse-pointer devices (touch, no
   *     hover) MOUNT the terminal hidden in an idle slot, because there is no
   *     pointerenter to mount it ahead of the tap — the tap would otherwise pay
   *     the whole onMount bill before anything opens.
   *  3. INTENT on the orb (pointerenter / focus) → mount, so a click on a
   *     fine-pointer device finds the terminal already there.
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
   * map records a failed module fetch as null for the life of the document,
   * so a repeated import() of the same URL fails without touching the
   * network (measured 2026-09-21, Chrome 153 against a server answering 503
   * on the chunk: one 503 on the wire, five failed imports across prefetch,
   * warm-up and three clicks). The retry still runs — it is free, and a
   * browser that does not cache the failure recovers on the spot. The first
   * version of this file set terminalOpen and collapsed the orb before
   * importing, so a 503 on the chunk left a scale(0) orb with no hit area —
   * the assistant was gone until reload (audit 2026-09-21, reproduced
   * against the build).
   *
   * Rejected: client:visible for the whole island — the orb is position:fixed
   * and always in the viewport, so it hydrates at once and changes nothing.
   * Rejected: keeping the eager mount and deferring only the onMount work —
   * the chunk itself (terminal + sidebar + orb renderer + Dexie + audio
   * engine + client) is the larger part of the bill.
   * Rejected: a network-only prefetch (<link rel="modulepreload">) — Vite gives
   * source code no handle on the hashed chunk URL of a dynamic import, and the
   * chunk's own static imports (gsap, synapse-client) are only discovered on
   * evaluation anyway, so a preload of the top chunk alone would still leave a
   * round-trip waterfall for the click. `import()` fetches the whole graph.
   *
   * Svelte 5 runes: $state, $derived
   */

  import { onMount } from 'svelte';
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
   *     chunk after the prefetch. Evaluating it costs a parse; nothing runs.
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

  /** Stage 3: mount — intent on the orb, the click itself, or the coarse-
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

  /**
   * Stage 1 on every visit: fetch the chunk in an idle slot right after the
   * window `load` event, regardless of the scroll gate. This island hydrates
   * at client:idle, which can be before or after `load` — both are handled.
   */
  function prefetchTerminal(): void {
    if (terminalLoad) return;
    const schedule = (): void => whenIdle(() => void fetchTerminal(), 5000, 1000);
    if (document.readyState === 'complete') {
      schedule();
    } else {
      window.addEventListener('load', schedule, { once: true });
    }
  }

  onMount(() => {
    prefetchTerminal();
  });

  /** No hover on the primary input: a tap is the first and only intent. */
  function coarsePointer(): boolean {
    return window.matchMedia('(hover: none), (pointer: coarse)').matches;
  }

  /**
   * Stage 2, on the scroll gate opening. Fine pointers stop at stage 1 —
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
