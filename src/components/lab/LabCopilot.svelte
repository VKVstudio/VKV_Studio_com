<script lang="ts">
  /**
   * LabCopilot.svelte
   * ─────────────────────────────────────────────────────────────────────────────
   * A right-docked, collapsible contextual assistant panel for the Lab tools —
   * "browser side-panel" feel (Claude/Gemini). Two halves:
   *   1. STATIC guide (curated, bilingual, offline-reliable): what the tool does,
   *      recommended actions, tips. Sourced from lab-copilot-content.ts — never
   *      model-generated, so it can't confabulate about tool mechanics.
   *   2. "Ask Synapse": open-ended questions go to the real Synapse client (live
   *      when the backend is up, graceful mock otherwise), with the in-training
   *      disclaimer. Context (which tool + a live "on screen now" line from the
   *      tool's own event bus) is seeded so answers are page-aware.
   *
   * Non-modal (role="complementary"): it never traps the page. Open by default on
   * desktop, collapsed to a tab on mobile. Escape collapses. Opens in site language.
   */
  import { t, localizedPath, type Lang } from '@/i18n/utils';
  import { COPILOT_CONTENT, type LabTool } from '@/lib/lab-copilot-content';
  import type { SynapseClient } from '@/lib/synapse-client';
  import { onLabState, type LabStateDetail } from '@/lib/lab-copilot-bus';

  interface Props {
    tool: LabTool;
    lang: Lang;
  }
  const { tool, lang }: Props = $props();

  const guide = $derived(COPILOT_CONTENT[tool][lang] ?? COPILOT_CONTENT[tool].en);

  // SSR-safe default: CLOSED. The server cannot know the viewport, and shipping
  // this open meant every Lab tool on a phone was covered by a full-screen panel
  // from first paint until the island hydrated — with the ✕ inert the whole time,
  // because closing it is a hydrated handler. Desktop is opened on mount instead
  // (see the effect below): a rail appearing slightly late is cosmetic, an
  // undismissable overlay over the tool is not.
  let open = $state(false);
  let mounted = $state(false);

  // Live "on screen now" context published by the tool island (optional).
  let liveState = $state<LabStateDetail | null>(null);

  // ── Cross-tool handoff (item 4): tokenizer → Prompt Architect ────────────────
  // The tokenizer publishes its current text (capped) in `detail.text` — see
  // TokenizerApp.svelte's publish effect. Only truthy once real text exists.
  const handoffText = $derived(
    tool === 'tokenizer' && typeof liveState?.detail?.text === 'string'
      ? (liveState.detail.text as string)
      : ''
  );

  // ── Ask Synapse ─────────────────────────────────────────────────────────────
  interface AskMsg {
    id: string;
    // 'error' is visually and semantically distinct from 'assistant' — a
    // failed stream is NEVER rendered as if the disclaimer text were a real
    // answer (see onError below).
    role: 'user' | 'assistant' | 'error';
    text: string;
  }
  let askInput = $state('');
  let askLog = $state<AskMsg[]>([]);
  let asking = $state(false);
  // Screen-reader announcement of the COMPLETED reply. The visible log below
  // is deliberately NOT a live region — token-by-token streaming would spam a
  // screen reader with partial sentences. Mirrors SynapseTerminal.svelte's
  // `liveAnnouncement` pattern: announce once, politely, when the answer (or
  // error) is final.
  let liveAnnouncement = $state('');
  // Lazy: the Synapse client (+ its deps) is only pulled in when the user actually
  // asks, so it stays off every Lab page's initial bundle.
  let client: SynapseClient | null = null;
  // Aborts the in-flight ask when a new question is sent, or on unmount (see
  // the teardown effect below) — never lets a stale stream write into a newer
  // question's message.
  let askAbort: AbortController | null = null;
  // ID of the assistant placeholder belonging to the CURRENTLY in-flight ask
  // (plain, non-`$state` bookkeeping — same idiom as `askAbort` above and
  // e.g. RerankPanel's `latestLlmRequestId`). When a new `ask()` supersedes
  // it before it ever received a single token, that empty placeholder is
  // purged from `askLog` (see `ask()`) instead of being left behind: without
  // this, the old bubble's `thinking` condition (`asking && !m.text`) would
  // re-light on the NEXT ask (any in-flight ask sets `asking = true`), and
  // after that ask finished it would sit in the log forever as a permanent
  // empty ghost bubble.
  let pendingAssistantId: string | null = null;

  let panelEl: HTMLElement | undefined = $state();
  let logEl: HTMLElement | undefined = $state();

  function nextAskMsgId(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  /**
   * Compact "key=value, key=value" line from the tool's own bus `detail` —
   * only the honest, already-on-screen facts the tool published (see
   * lab-copilot-bus.ts), never fabricated. `text` is excluded on purpose:
   * it's the tokenizer's raw input, wired through `detail` solely for the
   * cross-tool "send to Prompt Architect" handoff (see handoffToPrompt
   * below), not something every question's context should be bloated with.
   */
  function liveFacts(): string {
    const detail = liveState?.detail;
    if (!detail) return '';
    return Object.entries(detail)
      .filter(([key, value]) => key !== 'text' && String(value).length < 200)
      .map(([key, value]) => `${key}=${value}`)
      .join(', ');
  }

  // Item 5: remember open/collapsed across loads. A stored value always wins;
  // the mobile media-query default only applies the FIRST time a visitor
  // opens a Lab page (nothing stored yet).
  const OPEN_STORAGE_KEY = 'vkv-copilot-open';

  function readStoredOpen(): boolean | null {
    try {
      const raw = localStorage.getItem(OPEN_STORAGE_KEY);
      if (raw === 'true') return true;
      if (raw === 'false') return false;
      return null;
    } catch {
      return null; // localStorage unavailable (private mode) — fall back to the media-query default
    }
  }

  $effect(() => {
    mounted = true;
    const stored = readStoredOpen();
    if (stored !== null) {
      open = stored;
    } else if (!window.matchMedia('(max-width: 1023px)').matches) {
      // No stored preference yet — expand by default on wide viewports only.
      // Inverted from "collapse on narrow" when the SSR default became closed:
      // the narrow case is now the one that needs no action, so a phone never
      // renders the panel at all rather than rendering it and taking it away.
      open = true;
    }
    const unsub = onLabState(tool, (detail) => (liveState = detail));
    return unsub;
  });

  // Reflect open state to <body> so the Lab page can reserve space on desktop,
  // and persist it (item 5) — SSR-safe: $effect never runs during SSR.
  $effect(() => {
    if (!mounted) return;
    // Inverted on purpose — see the LAB COPILOT block in global.css. The desktop
    // gutter is reserved by default so the page does not jump when the panel
    // arrives; this class marks the exception, not the norm.
    document.body.classList.toggle('lab-copilot-closed', !open);
    try {
      localStorage.setItem(OPEN_STORAGE_KEY, String(open));
    } catch {
      // localStorage unavailable (private mode / quota) — persistence just degrades gracefully
    }
    return () => document.body.classList.remove('lab-copilot-closed');
  });

  // Abort any in-flight "Ask Synapse" stream on unmount — no reactive reads,
  // so this teardown only ever fires once, when the island is destroyed.
  $effect(() => {
    return () => askAbort?.abort();
  });

  function toggle(): void {
    open = !open;
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape' && open) {
      open = false;
    }
  }

  const HANDOFF_STORAGE_KEY = 'vkv-lab-handoff';

  /**
   * Cross-tool handoff (item 4): stashes the tokenizer's current text in
   * sessionStorage and navigates to Prompt Architect in the same language.
   * PromptApp's onMount consumes + clears the key if it's fresh (< 5 min) —
   * see its `consumeHandoff()`. Only ever called from a click handler, so
   * `sessionStorage`/`window` are always defined here (no SSR concern).
   */
  function handoffToPrompt(): void {
    if (!handoffText) return;
    try {
      sessionStorage.setItem(
        HANDOFF_STORAGE_KEY,
        JSON.stringify({ from: 'tokenizer', text: handoffText, ts: Date.now() })
      );
    } catch {
      // sessionStorage unavailable (private mode / quota) — navigate anyway;
      // PromptApp just won't find a handoff to consume.
    }
    window.location.href = localizedPath(lang, '/lab/prompt/');
  }

  async function ask(): Promise<void> {
    const q = askInput.trim();
    if (!q || asking) return;
    askInput = '';

    // Cancel any still-in-flight answer before starting a new one — belt and
    // braces alongside the `asking` guard above (the guard is what the UI
    // relies on day to day; the abort is what actually protects state if
    // this is ever reached with a stream still in flight, e.g. unmount mid-ask).
    askAbort?.abort();
    // The just-aborted ask's assistant bubble never gets a text update after
    // this (markError() itself no-ops once `controller.signal.aborted`) — if
    // it never received a single token, purge it now rather than leaving an
    // empty "ghost" bubble in the log (see `pendingAssistantId`'s doc
    // comment). A bubble that already has partial text is left alone.
    if (pendingAssistantId) {
      const staleId = pendingAssistantId;
      askLog = askLog.filter((m) => m.id !== staleId || m.text !== '');
      pendingAssistantId = null;
    }
    const controller = new AbortController();
    askAbort = controller;

    askLog = [...askLog, { id: nextAskMsgId(), role: 'user', text: q }];
    const assistantId = nextAskMsgId();
    askLog = [...askLog, { id: assistantId, role: 'assistant', text: '' }];
    pendingAssistantId = assistantId;
    asking = true;

    // Seed context as a prior assistant turn — keeps the user's message clean while
    // making the answer page-aware. (No backend contract change needed.)
    // `guide.intro` + `guide.tips` are the model's only source of TOOL-MECHANICS
    // facts (never model-generated — see lab-copilot-content.ts) — the pills'
    // questions are only offered where those tips actually cover the answer.
    // `liveFacts()` adds the honest per-session numbers (item 2); `text` is
    // deliberately excluded from it (see the function) so a large tokenizer
    // input doesn't bloat every question's context.
    const facts = liveFacts();
    const ctxBits = [
      `You are helping the user inside the VKVstudio Lab, on the ${tool} tool. ${guide.intro} ${guide.tips.join(' ')}`,
      liveState?.summary ? `On screen now: ${liveState.summary}.` : '',
      facts ? `Live state: ${facts}.` : '',
      'Answer briefly and concretely about this tool or the concept behind it.',
    ].filter(Boolean);

    function markError(): void {
      if (controller.signal.aborted) return;
      askLog = askLog.map((m) =>
        m.id === assistantId ? { ...m, role: 'error', text: t(lang, 'assistant.askError') } : m
      );
      liveAnnouncement = t(lang, 'assistant.askError');
    }

    // The inference backend is self-hosted and is often simply not running.
    // When it isn't, synapse-client silently answers from synapse-mock.ts —
    // canned text that ignores the page context assembled above and is
    // hardcoded Russian regardless of `lang`. Streaming that into an
    // assistant bubble would pass a stub off as a real, page-aware answer.
    // `onModel` fires before the first token in the mock path, so we can
    // catch it and say plainly that Synapse is offline instead.
    let isMock = false;
    function markOffline(): void {
      if (controller.signal.aborted) return;
      isMock = true;
      askLog = askLog.map((m) =>
        m.id === assistantId ? { ...m, role: 'error', text: t(lang, 'assistant.askOffline') } : m
      );
      liveAnnouncement = t(lang, 'assistant.askOffline');
    }

    try {
      if (!client) {
        const { createSynapseClient } = await import('@/lib/synapse-client');
        client = createSynapseClient();
      }
      await client.chatStream(
        { message: q, history: [{ role: 'assistant', content: ctxBits.join(' ') }] },
        {
          // Fires before the first token, including on the mock path.
          onModel(model) {
            if (model === 'mock') markOffline();
          },
          onToken(token) {
            if (controller.signal.aborted || isMock) return;
            askLog = askLog.map((m) =>
              m.id === assistantId ? { ...m, text: m.text + token } : m
            );
          },
          onDone(fullText) {
            if (controller.signal.aborted || isMock) return;
            const finalText = askLog.find((m) => m.id === assistantId)?.text || fullText;
            // Announce the finished reply once, politely — never per-token.
            liveAnnouncement = finalText;
          },
          onError: markError,
        },
        controller.signal
      );
    } catch {
      markError();
    } finally {
      if (!controller.signal.aborted) asking = false;
      if (askAbort === controller) askAbort = null;
      // This ask settled on its own (finished or errored, not superseded) —
      // its bubble is done being written to, so it's no longer "pending" and
      // must not be purged by a later ask's cleanup above.
      if (pendingAssistantId === assistantId) pendingAssistantId = null;
      queueMicrotask(() => logEl?.scrollTo({ top: logEl.scrollHeight }));
    }
  }

  function onAskKeydown(e: KeyboardEvent): void {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      ask();
    }
  }

  /** Pill click: fills the input with the curated question and sends it immediately. */
  function askSuggested(question: string): void {
    askInput = question;
    ask();
  }
</script>

<svelte:window onkeydown={onKeydown} />

<!-- Collapsed tab (always available to reopen) -->
{#if !open}
  <!-- Accessible name starts with the visible label ("Guide"/"Гид") so it
       satisfies WCAG 2.5.3 Label in Name (voice control can target it). -->
  <button
    class="copilot-tab"
    onclick={toggle}
    aria-label={`${t(lang, 'assistant.tabLabel')} — ${t(lang, 'assistant.openLabel')}`}
  >
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      aria-hidden="true"
    >
      <path
        d="M12 2a4 4 0 0 1 4 4v1a4 4 0 0 1 3 3.87V12a3 3 0 0 1-3 3h-1l-3 3v-3H8a3 3 0 0 1-3-3v-1.13A4 4 0 0 1 8 7V6a4 4 0 0 1 4-4Z"
      />
    </svg>
    <span class="copilot-tab__label">{t(lang, 'assistant.tabLabel')}</span>
  </button>
{/if}

<aside
  bind:this={panelEl}
  class="copilot"
  class:copilot--open={open}
  role="complementary"
  aria-label={t(lang, 'assistant.title')}
  aria-hidden={!open}
>
  <header class="copilot__head">
    <div class="copilot__brand">
      <span class="copilot__dot" aria-hidden="true"></span>
      {t(lang, 'assistant.title')}
    </div>
    <button class="copilot__close" onclick={toggle} aria-label={t(lang, 'assistant.closeLabel')}>
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        aria-hidden="true"
      >
        <path d="M9 6l6 6-6 6" />
      </svg>
    </button>
  </header>

  <div class="copilot__body">
    <p class="copilot__intro">{guide.intro}</p>

    {#if liveState?.summary}
      <p class="copilot__live">
        <span class="copilot__live-label">{t(lang, 'assistant.currentlyLabel')}:</span>
        {liveState.summary}
      </p>
    {/if}

    {#if handoffText}
      <button type="button" class="copilot__handoff" onclick={handoffToPrompt}>
        {t(lang, 'assistant.handoffToPrompt')}
      </button>
    {/if}

    <section class="copilot__section" aria-label={t(lang, 'assistant.actionsHeading')}>
      <h2 class="copilot__h">{t(lang, 'assistant.actionsHeading')}</h2>
      <ol class="copilot__actions">
        {#each guide.actions as action}
          <li>{action}</li>
        {/each}
      </ol>
    </section>

    <section class="copilot__section" aria-label={t(lang, 'assistant.tipsHeading')}>
      <h2 class="copilot__h">{t(lang, 'assistant.tipsHeading')}</h2>
      <ul class="copilot__tips">
        {#each guide.tips as tip}
          <li>{tip}</li>
        {/each}
      </ul>
    </section>

    <section class="copilot__section copilot__ask" aria-label={t(lang, 'assistant.askHeading')}>
      <h2 class="copilot__h">{t(lang, 'assistant.askHeading')}</h2>
      {#if askLog.length}
        <!-- Deliberately NOT a live region: token-by-token streaming would
             spam a screen reader with partial sentences (see SynapseTerminal
             for the same trap). The finished answer is announced once,
             politely, via the visually-hidden node below instead. -->
        <div class="copilot__log" bind:this={logEl}>
          {#each askLog as m (m.id)}
            {@const thinking = m.role === 'assistant' && asking && !m.text}
            <p
              class="copilot__msg copilot__msg--{m.role}"
              class:copilot__msg--thinking={thinking}
              role={m.role === 'error' ? 'alert' : undefined}
            >
              {thinking ? t(lang, 'assistant.thinking') : m.text}
            </p>
          {/each}
        </div>
      {/if}
      <div class="visually-hidden" aria-live="polite" aria-atomic="true">{liveAnnouncement}</div>
      {#if guide.suggestions.length}
        <div class="copilot__pills" role="group" aria-label={t(lang, 'assistant.suggestionsLabel')}>
          {#each guide.suggestions as q}
            <button
              type="button"
              class="copilot__pill"
              disabled={asking}
              onclick={() => askSuggested(q)}
            >
              {q}
            </button>
          {/each}
        </div>
      {/if}
      <div class="copilot__composer">
        <textarea
          class="copilot__input"
          rows="2"
          bind:value={askInput}
          onkeydown={onAskKeydown}
          placeholder={t(lang, 'assistant.askPlaceholder')}
          aria-label={t(lang, 'assistant.askHeading')}
        ></textarea>
        <button class="copilot__send" onclick={ask} disabled={asking || !askInput.trim()}>
          {t(lang, 'assistant.askSend')}
        </button>
      </div>
      <p class="copilot__disclaimer" role="note">{t(lang, 'synapse.disclaimerShort')}</p>
    </section>
  </div>
</aside>

<style>
  /* ── Collapsed tab ─────────────────────────────────────────────────────────── */
  .copilot-tab {
    position: fixed;
    top: 50%;
    right: 0;
    transform: translateY(-50%);
    z-index: 60;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-1);
    padding: var(--space-3) var(--space-2);
    border: 1px solid var(--accent-green-400);
    border-right: none;
    border-radius: var(--radius-md) 0 0 var(--radius-md);
    background: var(--glass-bg);
    backdrop-filter: blur(var(--glass-blur));
    color: var(--text-primary);
    cursor: pointer;
    transition: var(--transition-colors, 0.2s);
  }
  .copilot-tab:hover {
    background: var(--bg-elevated);
    box-shadow: 0 0 16px var(--accent-glow);
  }
  .copilot-tab__label {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    writing-mode: vertical-rl;
    letter-spacing: var(--tracking-wide);
  }

  /* ── Panel ─────────────────────────────────────────────────────────────────── */
  .copilot {
    position: fixed;
    top: 0;
    right: 0;
    z-index: 60;
    width: min(360px, 92vw);
    height: 100dvh;
    display: flex;
    flex-direction: column;
    background: var(--glass-bg);
    border-left: 1px solid var(--glass-border);
    backdrop-filter: blur(var(--glass-blur));
    box-shadow: var(--glass-shadow);
    transform: translateX(100%);
    transition: transform 0.28s ease;
    visibility: hidden;
    /* viewport-fit=cover: the fixed full-height panel reaches the true screen
       edges — pad the flex column so its header and input row stay clear of
       the status bar and home-indicator strip in the installed PWA. */
    padding-top: env(safe-area-inset-top, 0px);
    padding-bottom: env(safe-area-inset-bottom, 0px);
  }
  .copilot--open {
    transform: translateX(0);
    visibility: visible;
  }

  .copilot__head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--space-4) var(--space-5);
    border-bottom: 1px solid var(--border-subtle);
  }
  .copilot__brand {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    font-weight: var(--weight-semibold);
    color: var(--text-primary);
    letter-spacing: var(--tracking-wide);
  }
  .copilot__dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--accent-green-300);
    box-shadow: 0 0 8px var(--accent-green-300);
  }
  .copilot__close {
    display: grid;
    place-items: center;
    width: 32px;
    height: 32px;
    /* Measured 20x20 on a 375px viewport despite the 32px above: it is a
       flex item next to a long title, and the default flex-shrink:1 let the
       row squeeze it below the WCAG 2.2 SC 2.5.8 minimum. */
    flex-shrink: 0;
    border: none;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-secondary);
    cursor: pointer;
  }
  .copilot__close:hover {
    background: var(--bg-elevated);
    color: var(--text-primary);
  }

  .copilot__body {
    flex: 1;
    overflow-y: auto;
    padding: var(--space-5);
    display: flex;
    flex-direction: column;
    gap: var(--space-5);
  }
  .copilot__intro {
    font-size: var(--text-sm);
    line-height: var(--leading-normal);
    color: var(--text-secondary);
  }
  .copilot__live {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--text-secondary);
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    background: var(--bg-void);
  }
  .copilot__live-label {
    color: var(--accent-green-300);
  }
  .copilot__handoff {
    display: block;
    width: 100%;
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--accent-green-400);
    border-radius: var(--radius-sm);
    background: var(--accent-glow);
    color: var(--text-primary);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    text-align: left;
    line-height: var(--leading-snug);
    cursor: pointer;
    transition: var(--transition-colors, 0.2s);
  }
  .copilot__handoff:hover {
    background: var(--bg-elevated);
    box-shadow: 0 0 12px var(--accent-glow);
  }
  .copilot__h {
    font-size: var(--text-xs);
    text-transform: uppercase;
    letter-spacing: var(--tracking-wider);
    color: var(--text-muted);
    margin-bottom: var(--space-3);
  }
  .copilot__actions {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    counter-reset: step;
    list-style: none;
  }
  .copilot__actions li {
    position: relative;
    padding-left: var(--space-8);
    font-size: var(--text-sm);
    line-height: var(--leading-snug);
    color: var(--text-secondary);
    counter-increment: step;
  }
  .copilot__actions li::before {
    content: counter(step);
    position: absolute;
    left: 0;
    top: 0;
    width: 22px;
    height: 22px;
    display: grid;
    place-items: center;
    border-radius: 50%;
    background: var(--accent-glow);
    border: 1px solid var(--accent-green-400);
    color: var(--accent-green-200);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
  }
  .copilot__tips {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    list-style: none;
  }
  .copilot__tips li {
    position: relative;
    padding-left: var(--space-5);
    font-size: var(--text-sm);
    line-height: var(--leading-snug);
    color: var(--text-secondary);
  }
  .copilot__tips li::before {
    content: '→';
    position: absolute;
    left: 0;
    color: var(--accent-green-300);
  }

  /* ── Ask ───────────────────────────────────────────────────────────────────── */
  .copilot__ask {
    margin-top: auto;
  }
  .copilot__log {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    max-height: 34vh;
    overflow-y: auto;
    margin-bottom: var(--space-3);
  }
  .copilot__msg {
    font-size: var(--text-sm);
    line-height: var(--leading-snug);
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-md);
  }
  .copilot__msg--user {
    align-self: flex-end;
    background: var(--accent-glow);
    border: 1px solid var(--accent-green-400);
    color: var(--text-primary);
  }
  .copilot__msg--assistant {
    background: var(--bg-void);
    border: 1px solid var(--border-subtle);
    color: var(--text-secondary);
  }
  .copilot__msg--thinking {
    opacity: 0.7;
    font-style: italic;
  }
  /* Distinct from --assistant on purpose: a failed stream must never read
     like a real, if terse, answer (see LabCopilot's ask()/markError). Amber
     tone matches the error banners used across the other Lab tools. */
  .copilot__msg--error {
    background: hsla(40, 90%, 55%, 0.1);
    border: 1px solid hsla(40, 90%, 55%, 0.3);
    color: hsl(40, 90%, 75%);
  }

  /* ── Suggested-question pills ─────────────────────────────────────────────── */
  .copilot__pills {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    margin-bottom: var(--space-3);
  }
  .copilot__pill {
    padding: var(--space-1) var(--space-3);
    /* WCAG 2.2 SC 2.5.8: measured 23.9px tall on mobile — a hair under the
       24px minimum target size. A button centres its content vertically, so
       min-height grows the target without shifting the label. */
    min-height: 24px;
    border: 1px solid var(--border-default);
    border-radius: var(--radius-full, 999px);
    background: var(--bg-void);
    color: var(--text-secondary);
    font-family: var(--font-sans);
    font-size: var(--text-xs);
    line-height: var(--leading-snug);
    text-align: left;
    cursor: pointer;
    transition: var(--transition-colors, 0.2s);
  }
  .copilot__pill:hover:not(:disabled) {
    border-color: var(--accent-green-400);
    color: var(--text-primary);
  }
  .copilot__pill:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .copilot__composer {
    display: flex;
    gap: var(--space-2);
    align-items: flex-end;
  }
  .copilot__input {
    flex: 1;
    resize: none;
    background: var(--bg-void);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-md);
    padding: var(--space-2) var(--space-3);
    color: var(--text-primary);
    font-family: var(--font-sans);
    font-size: var(--text-sm);
    outline: none;
  }
  .copilot__input:focus {
    border-color: var(--accent-green-400);
  }
  .copilot__input:focus-visible {
    outline: 2px solid var(--accent-green-400);
    outline-offset: 2px;
  }
  .copilot__send {
    padding: var(--space-2) var(--space-4);
    border: none;
    border-radius: var(--radius-md);
    background: var(--accent-green-400);
    color: var(--bg-obsidian);
    font-family: var(--font-mono);
    font-weight: var(--weight-semibold);
    font-size: var(--text-sm);
    cursor: pointer;
  }
  .copilot__send:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .copilot__disclaimer {
    margin-top: var(--space-2);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    line-height: var(--leading-snug);
    color: hsl(40, 90%, 68%);
  }

  @media (max-width: 767px) {
    .copilot {
      width: 100vw;
    }
    /* Prevent iOS zoom on focus */
    .copilot__input {
      font-size: 16px;
    }
  }

  /* The standard property, restated where the CSS minifier cannot rewrite it away.
     Measured in dist: the minifier collapses `backdrop-filter` into its -webkit-
     alias and drops the standard declaration, so Firefox renders these glass
     surfaces as a flat fill. It does not collapse across an @supports boundary.
     Must stay AFTER the base rules — equal specificity, last one wins. */
  @supports (backdrop-filter: blur(1px)) {
    .copilot-tab {
      backdrop-filter: blur(var(--glass-blur));
    }

    .copilot {
      backdrop-filter: blur(var(--glass-blur));
    }
  }
</style>
