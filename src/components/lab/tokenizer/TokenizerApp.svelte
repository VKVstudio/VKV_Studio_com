<script lang="ts">
  import { onMount } from 'svelte';
  import { placeTooltip, pointerXY } from '../../../lib/tokenizer/tooltip-position';
  import {
    tokenize,
    MODELS,
    MODEL_LIST,
    getModelInfo,
    MAX_TOKENIZER_INPUT_LENGTH,
    type Accuracy,
    type FallbackReason,
    type ModelId,
    type TokenResult,
    type TokenizerStatus,
  } from '../../../lib/tokenizer/engine';
  import { publishLabState } from '../../../lib/lab-copilot-bus';
  import '../../../styles/lab/tokenizer.css';
  import TokenHeatmap from './TokenHeatmap.svelte';
  import TokenCompare from './TokenCompare.svelte';
  import { t } from '../../../i18n/utils';

  let { lang = 'en' } = $props<{ lang?: 'en' | 'ru' }>();

  type ViewMode = 'blocks' | 'heatmap';
  // 'raw' = count the text as-is (current/default behavior). 'chat' = also
  // wrap it as a single chat/user turn and surface the CHAT-TEMPLATE OVERHEAD.
  type InputMode = 'raw' | 'chat';

  let text = $state('');
  let model = $state<ModelId>(MODEL_LIST[0]);
  let result = $state<TokenResult | null>(null);
  let isTyping = $state(false);
  let viewMode = $state<ViewMode>('blocks');
  let showCompare = $state(false);
  let inputMode = $state<InputMode>('raw');
  // Mode that the CURRENTLY DISPLAYED result/number actually corresponds to.
  // Deliberately separate from `inputMode` (which flips the instant the user
  // clicks Raw/Chat): the "Tokens"/"Wrapped total" label must stay pinned to
  // whichever mode `displayTokens` currently shows, not to the live toggle
  // state, or a toggle click briefly shows a number under the wrong label
  // while the matching performTokenize() call is still in flight. Only ever
  // written where the corresponding number is written (performTokenize's
  // success path, and the empty-text reset), so label and value always change
  // in lockstep.
  let displayedMode = $state<InputMode>('raw');

  // Status tracking from engine.ts
  let tokenizerStatus = $state<TokenizerStatus>('ready');
  let statusModel = $state<ModelId | null>(null);
  // Track whether current result used fallback (API offline)
  let usedFallback = $state(false);

  // Raw text included in the bus `detail.text` field is capped independently
  // of MAX_TOKENIZER_INPUT_LENGTH (100k) — big enough for a realistic
  // "send to Prompt Architect" handoff (see LabCopilot.svelte's
  // handoffToPrompt), small enough to keep the CustomEvent payload light.
  // LabCopilot explicitly excludes long values (this one included) from the
  // "Live state:" fact line it builds for Ask Synapse's context — `text` is
  // wired through purely for the cross-tool handoff, not to be summarized.
  const HANDOFF_TEXT_CAP = 20_000;

  // Publish a short "on screen now" summary for the Lab Copilot panel (a separate
  // island). Reads model + result + text; the publish is a pure side effect.
  $effect(() => {
    const name = MODELS[model]?.name ?? String(model);
    publishLabState(
      'tokenizer',
      result ? `${name} · ${result.totalTokens.toLocaleString()} tokens` : name,
      {
        model: name,
        backend: MODELS[model]?.backend.type ?? 'unknown',
        accuracy: result?.accuracy ?? 'n/a',
        totalTokens: result?.totalTokens ?? 0,
        chars: result?.totalChars ?? text.length,
        inputMode,
        text: text.slice(0, HANDOFF_TEXT_CAP),
      }
    );
  });

  // Animated counter target values
  let displayTokens = $state(0);
  let displayChars = $state(0);
  let displayDensity = $state(0);
  // Real wall-clock latency (ms) of the last tokenize() call — see
  // engine.ts TokenResult.latencyMs for why this replaced a derived
  // "tokens/sec" figure (unstable/non-credible for tiny on-device inputs).
  let displayLatencyMs = $state(0);

  // Debounce timer ref
  let debounceTimer: ReturnType<typeof setTimeout>;

  // Race-condition guards: per-call request id + AbortController.
  // Plain (non-$state) locals — they're bookkeeping, not UI state, and
  // mutating them inside an async callback is not the read+write-in-$effect trap.
  let latestRequestId = 0;
  let activeController: AbortController | null = null;

  // Tooltip state for block tokens
  let tooltip = $state<{
    visible: boolean;
    x: number;
    y: number;
    token: { id: number; text: string; bytes: number[]; partial?: boolean } | null;
  }>({ visible: false, x: 0, y: 0, token: null });

  function showTooltip(
    // KeyboardEvent belongs here: every token is role="button" with tabindex="0"
    // and an onkeydown handler, so Enter and Space reach this function too.
    e: MouseEvent | TouchEvent | KeyboardEvent,
    token: { id: number; text: string; bytes: number[]; partial?: boolean }
  ) {
    const pointer = pointerXY(e);
    const { x, y } = placeTooltip(pointer.x, pointer.y);
    tooltip = { visible: true, x, y, token };
  }

  function hideTooltip() {
    tooltip = { ...tooltip, visible: false };
  }

  // Honest latency display — real performance.now() measurement, rounded
  // sensibly rather than shown with fake decimal precision. Sub-millisecond
  // on-device tokenize() calls (very common for short inputs) show "<1"
  // instead of "0" or a misleadingly-precise fraction.
  function formatLatencyMs(ms: number): string {
    if (ms < 1) return '<1';
    return String(Math.round(ms));
  }

  // Animated counter helper — lerp displayed value toward target
  function animateCounter(
    current: number,
    target: number,
    setter: (v: number) => void,
    isFloat = false,
    duration = 400
  ) {
    const steps = 20;
    const interval = duration / steps;
    let step = 0;
    const id = setInterval(() => {
      step++;
      const progress = step / steps;
      const value = current + (target - current) * progress;
      setter(isFloat ? parseFloat(value.toFixed(2)) : Math.round(value));
      if (step >= steps) clearInterval(id);
    }, interval);
  }

  // Get debounce delay based on model backend type
  function getDebounceDelay(modelId: ModelId): number {
    const info = getModelInfo(modelId);
    // API models: 500ms debounce to avoid spamming backend
    // tiktoken/transformers: 200ms (instant enough)
    return info.backend.type === 'api' ? 500 : 200;
  }

  // Honest, reason-specific message for an 'approx' result — a backend that
  // is up but whose upstream provider rejected the request (billing/rate
  // limit/bad request) is NOT "backend offline", and an on-device
  // transformers.js vocab load failure has nothing to do with the backend
  // at all. Sharing one "Backend offline" string across all three was
  // misleading (live QA finding) — this keeps each message honest about
  // what actually failed.
  function getFallbackMessage(reason: FallbackReason | undefined): string {
    switch (reason) {
      case 'provider':
        return t(lang, 'tokenizer.providerUnavailable');
      case 'onDeviceLoad':
        return t(lang, 'tokenizer.onDeviceTokenizerUnavailable');
      case 'closedWeight':
        return t(lang, 'tokenizer.closedWeightTokenizer');
      case 'network':
      default:
        return t(lang, 'tokenizer.backendOffline');
    }
  }

  // Get accuracy badge info from the RESULT's explicit accuracy tier — never
  // inferred from tokens.length or backend type, so it can't contradict the
  // engine. `forModel` identifies which model produced this result (needed
  // only for the 'verified' tier, to check ModelInfo.verifiedViaSameFamilyModel
  // — see engine.ts: some "verified" counts are real API round-trips against a
  // DIFFERENT underlying model, and the tooltip must disclose that honestly
  // rather than showing the unqualified "Verified — provider API count").
  function getAccuracyInfo(
    res: TokenResult | null,
    forModel: ModelId
  ): {
    emoji: string;
    label: string;
    tooltip: string;
  } | null {
    if (!res) return null;
    switch (res.accuracy) {
      case 'native':
        return {
          emoji: '🟢',
          label: t(lang, 'tokenizer.accuracyNative'),
          tooltip: t(lang, 'tokenizer.accuracyNativeTooltip'),
        };
      case 'verified':
        return {
          emoji: '🔵',
          label: t(lang, 'tokenizer.accuracyVerified'),
          tooltip: getModelInfo(forModel).verifiedViaSameFamilyModel
            ? t(lang, 'tokenizer.accuracyVerifiedSameFamilyTooltip')
            : t(lang, 'tokenizer.accuracyVerifiedTooltip'),
        };
      case 'approx':
        return {
          emoji: '🟡',
          label: t(lang, 'tokenizer.accuracyApprox'),
          tooltip: getFallbackMessage(res.fallbackReason),
        };
    }
  }

  // Headline "no breakdown" stat label (API models, or a transformers/API
  // fallback with an empty tokens[]) — MUST track the same result.accuracy
  // tier as the badge above it, never a hardcoded "Exact count", or the
  // headline number silently claims more certainty than the badge does
  // (e.g. Claude falling back to the tiktoken approximation would otherwise
  // show 🟡 Approximate right next to a bolded "Exact count").
  function getCountLabelKey(accuracy: Accuracy): string {
    switch (accuracy) {
      case 'native':
        return 'tokenizer.exactCount';
      case 'verified':
        return 'tokenizer.verifiedCount';
      case 'approx':
        return 'tokenizer.approxCountLabel';
    }
  }

  // Chat-overhead honesty tier → label + tooltip. Mirrors getAccuracyInfo:
  // sourced only from result.chatOverhead.exactness, which the engine sets
  // explicitly per backend (native / documented / estimated) — never guessed
  // here from the model or backend type.
  function getChatOverheadInfo(res: TokenResult | null): {
    label: string;
    tooltip: string;
  } | null {
    if (!res?.chatOverhead) return null;
    switch (res.chatOverhead.exactness) {
      case 'native':
        return {
          label: t(lang, 'tokenizer.chatOverheadExactnessNative'),
          tooltip: t(lang, 'tokenizer.chatOverheadTooltipNative'),
        };
      case 'documented':
        return {
          label: t(lang, 'tokenizer.chatOverheadExactnessDocumented'),
          tooltip: t(lang, 'tokenizer.chatOverheadTooltipDocumented'),
        };
      case 'estimated':
        return {
          label: t(lang, 'tokenizer.chatOverheadExactnessEstimated'),
          tooltip: t(lang, 'tokenizer.chatOverheadTooltipEstimated'),
        };
    }
  }

  /**
   * Single entry point for running a tokenize() call from any trigger
   * (debounce, Ctrl+Enter, retry). Guards against races: captures a
   * monotonically increasing request id before awaiting, aborts the
   * previous in-flight call, and discards the result if a newer call
   * has started by the time this one resolves.
   */
  async function performTokenize(
    currentText: string,
    currentModel: ModelId,
    currentMode: InputMode,
    animate = false
  ) {
    const myRequestId = ++latestRequestId;
    activeController?.abort();
    const controller = new AbortController();
    activeController = controller;

    isTyping = true;

    try {
      const r = await tokenize(currentText, currentModel, {
        signal: controller.signal,
        includeChatTemplate: currentMode === 'chat',
        onStatus: (status, modelId) => {
          if (myRequestId !== latestRequestId) return; // stale — a newer call superseded this one
          tokenizerStatus = status;
          statusModel = modelId;
        },
      });

      if (myRequestId !== latestRequestId) return; // superseded — discard the stale result

      result = r;
      displayedMode = currentMode; // number below is about to reflect currentMode — flip the label in the same breath
      isTyping = false;
      usedFallback = r.accuracy === 'approx';

      // In "as chat message" mode the headline Tokens counter reflects the
      // wrapped total (raw text + template overhead), not the raw count —
      // chars/density/latency stay tied to the raw text, which is what they measure.
      const tokensTarget =
        currentMode === 'chat' && r.chatOverhead ? r.chatOverhead.wrappedTotal : r.totalTokens;

      if (animate) {
        animateCounter(displayTokens, tokensTarget, (v) => (displayTokens = v));
        animateCounter(displayChars, r.totalChars, (v) => (displayChars = v));
        animateCounter(displayDensity, r.density, (v) => (displayDensity = v), true);
        animateCounter(displayLatencyMs, r.latencyMs, (v) => (displayLatencyMs = v), true);
      } else {
        displayTokens = tokensTarget;
        displayChars = r.totalChars;
        displayDensity = r.density;
        displayLatencyMs = r.latencyMs;
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return; // intentionally cancelled
      if (myRequestId !== latestRequestId) return;
      isTyping = false;
      tokenizerStatus = 'error';
    }
  }

  // Determine if tokens array is empty (API model or fallback)
  let hasTokenBreakdown = $derived(result !== null && result.tokens.length > 0);

  // ─── Input length cap ──────────────────────────────────────────────────
  // The textarea otherwise accepts unbounded pasted text (~4MB reproduced in
  // live persona testing hung the tokenizer with no feedback at all).
  // `maxlength` below enforces the hard cap; this hint only surfaces once
  // the user is close to it, so normal-sized input sees nothing extra.
  const CHAR_LIMIT_WARN_RATIO = 0.9;
  let nearCharLimit = $derived(text.length >= MAX_TOKENIZER_INPUT_LENGTH * CHAR_LIMIT_WARN_RATIO);

  $effect(() => {
    const currentText = text;
    const currentModel = model;
    const currentMode = inputMode; // toggling Raw ↔ As chat message recomputes too

    clearTimeout(debounceTimer);

    if (!currentText.trim()) {
      // Cancel any in-flight request and invalidate it so a late resolution
      // can't repopulate `result` after the user cleared the textarea.
      activeController?.abort();
      latestRequestId++;
      result = null;
      isTyping = false;
      usedFallback = false;
      displayedMode = currentMode; // resets synchronously (no pending fetch) — safe to sync immediately
      displayTokens = 0;
      displayChars = 0;
      displayDensity = 0;
      displayLatencyMs = 0;
      return;
    }

    isTyping = true;
    const delay = getDebounceDelay(currentModel);

    debounceTimer = setTimeout(() => {
      void performTokenize(currentText, currentModel, currentMode, false);
    }, delay);

    return () => clearTimeout(debounceTimer);
  });

  // Ctrl+Enter → tokenize immediately (flush debounce)
  function handleKeydown(e: KeyboardEvent) {
    if (e.ctrlKey && e.key === 'Enter') {
      e.preventDefault();
      clearTimeout(debounceTimer);
      if (!text.trim()) return;
      void performTokenize(text, model, inputMode, true);
    }
  }

  // Retry tokenization (for error state)
  function retryTokenize() {
    if (!text.trim()) return;
    usedFallback = false;
    void performTokenize(text, model, inputMode, false);
  }

  // Raw ↔ As chat message toggle — just flips plain $state; the $effect
  // above (which reads `inputMode`) picks it up and recomputes through the
  // normal debounced performTokenize path, so it gets the same race guards.
  function setInputMode(nextMode: InputMode) {
    inputMode = nextMode;
  }

  // Copy JSON result
  let copySuccess = $state(false);
  async function copyResult() {
    if (!result) return;
    const payload = {
      model,
      totalTokens: result.totalTokens,
      totalChars: result.totalChars,
      density: result.density,
      ...(result.chatOverhead ? { chatOverhead: result.chatOverhead } : {}),
      tokens: result.tokens.map((tk) => ({
        id: tk.id,
        text: tk.text,
        bytes: tk.bytes,
        ...(tk.partial ? { partial: true } : {}),
      })),
    };
    await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
    copySuccess = true;
    setTimeout(() => (copySuccess = false), 2000);
  }

  // Track stagger index so tokens animate in sequence
  let tokenKey = $state(0);
  $effect(() => {
    // Only READ result (dependency), only WRITE tokenKey (no read = no cycle)
    if (result) tokenKey = Date.now();
  });

  // Derived: accuracy info for display — sourced from the result's own
  // accuracy tier, so the badge can never contradict what actually happened.
  let accuracyInfo = $derived(getAccuracyInfo(result, model));

  // Reasoning-token disclosure — a static, honest note (no fabricated numeric
  // estimate) shown whenever the SELECTED model has hidden/billable reasoning
  // tokens, regardless of whether a result exists yet. See
  // ModelInfo.hiddenReasoning in engine.ts for the model list.
  let hasHiddenReasoning = $derived(getModelInfo(model).hiddenReasoning === true);

  // Chat-overhead honesty info for the current result — null when in Raw
  // mode or before a result exists (result.chatOverhead is only set when
  // tokenize() was called with includeChatTemplate: true).
  let chatOverheadInfo = $derived(getChatOverheadInfo(result));

  /**
   * The motion library is loaded ONLY when it will be used. `gsap` and
   * `ScrollTrigger` used to be static imports, so the island's entry chunk
   * pulled ~113KB of them on hydration — on every visit, including visitors
   * who prefer reduced motion and will never see the tween. Deferred behind
   * the gate it costs them nothing and everyone else pays for it after mount
   * rather than on the critical path. Same shape as initTrustMotion /
   * initContactMotion on the page side.
   *
   * The trade-off, stated plainly: the library now arrives AFTER mount, so if
   * a visitor lands with the tool already in view (a deep link to #lab-tool)
   * on a slow connection, the panels are briefly visible before the tween's
   * start state hides them and plays them back in. The hero is a full
   * viewport tall, so on a normal visit the tool is below the fold and gsap
   * has long arrived by the time it is scrolled to. Measured on the dev
   * server: island at 391ms, gsap at 692ms.
   */
  async function initEntrance(): Promise<void> {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    try {
      const [{ gsap }, { ScrollTrigger }] = await Promise.all([
        import('gsap'),
        import('gsap/ScrollTrigger'),
      ]);
      gsap.registerPlugin(ScrollTrigger);

      gsap.fromTo(
        ['.js-reveal-input', '.js-reveal-stats', '.js-reveal-output'],
        { opacity: 0, y: 30 },
        {
          opacity: 1,
          y: 0,
          duration: 0.6,
          stagger: 0.15,
          ease: 'power3.out',
          // Without this the panels keep an inline opacity and transform
          // for good — a permanent stacking context that makes any later
          // CSS state on them dead on arrival. Every other tween on the
          // site clears; these two were missed.
          clearProps: 'all',
          scrollTrigger: {
            trigger: '.tokenizer',
            start: 'top 80%',
            end: 'top 20%',
            scrub: false,
            toggleActions: 'play none none none',
          },
        }
      );
    } catch (err) {
      console.error('[tokenizer] motion failed to load:', err);
    }
  }

  onMount(() => {
    void initEntrance();
  });
</script>

<!-- Keyboard and window click listener -->
<svelte:window onkeydown={handleKeydown} onclick={hideTooltip} />

<div class="tokenizer glass-panel">
  <!-- ══════════════════════════════════════════════════════ -->
  <!-- INPUT PANEL                                           -->
  <!-- ══════════════════════════════════════════════════════ -->
  <div class="tokenizer__input-panel">
    <div class="tokenizer__input-group js-reveal-input">
      <div class="tokenizer__input-header">
        <!-- Model select + accuracy badge -->
        <div class="tokenizer__model-row">
          <select
            bind:value={model}
            class="tokenizer__model-select"
            aria-label={t(lang, 'tokenizer.model')}
          >
            {#each MODEL_LIST as mid (mid)}
              <option value={mid}>{MODELS[mid].name}</option>
            {/each}
          </select>

          <!-- Accuracy indicator badge — tier comes from result.accuracy, never guessed -->
          {#if result && accuracyInfo}
            <span
              class="tokenizer__accuracy-badge tokenizer__accuracy-badge--{result.accuracy}"
              title={accuracyInfo.tooltip}
              aria-label={accuracyInfo.tooltip}
            >
              {accuracyInfo.emoji}
              {accuracyInfo.label}
            </span>
          {/if}
        </div>

        <p class="tokenizer__roster-stamp">{t(lang, 'tokenizer.rosterStamp')}</p>

        <!-- Action buttons row -->
        <div class="tokenizer__actions">
          <!-- Raw text ↔ As chat message toggle (CHAT-TEMPLATE OVERHEAD) -->
          <div
            class="tokenizer__input-mode-toggle"
            role="group"
            aria-label={t(lang, 'tokenizer.inputMode')}
          >
            <button
              type="button"
              class="tokenizer__input-mode-btn {inputMode === 'raw'
                ? 'tokenizer__input-mode-btn--active'
                : ''}"
              onclick={() => setInputMode('raw')}
              aria-pressed={inputMode === 'raw'}
              id="input-mode-raw">{t(lang, 'tokenizer.rawText')}</button
            >
            <button
              type="button"
              class="tokenizer__input-mode-btn {inputMode === 'chat'
                ? 'tokenizer__input-mode-btn--active'
                : ''}"
              onclick={() => setInputMode('chat')}
              aria-pressed={inputMode === 'chat'}
              id="input-mode-chat">{t(lang, 'tokenizer.asChatMessage')}</button
            >
          </div>

          <!-- View mode toggle -->
          <div
            class="tokenizer__mode-toggle"
            role="group"
            aria-label={t(lang, 'tokenizer.viewMode') || 'View mode'}
          >
            <button
              type="button"
              class="tokenizer__mode-btn {viewMode === 'blocks'
                ? 'tokenizer__mode-btn--active'
                : ''}"
              aria-pressed={viewMode === 'blocks'}
              onclick={() => (viewMode = 'blocks')}
              id="mode-blocks">{t(lang, 'tokenizer.blocks')}</button
            >
            <button
              type="button"
              class="tokenizer__mode-btn {viewMode === 'heatmap'
                ? 'tokenizer__mode-btn--active'
                : ''}"
              aria-pressed={viewMode === 'heatmap'}
              onclick={() => (viewMode = 'heatmap')}
              id="mode-heatmap">{t(lang, 'tokenizer.heatmap')}</button
            >
          </div>

          <!-- Compare toggle -->
          <button
            type="button"
            class="tokenizer__action-btn {showCompare ? 'tokenizer__action-btn--active' : ''}"
            onclick={() => (showCompare = !showCompare)}
            id="btn-compare"
            aria-pressed={showCompare}
          >
            {showCompare ? '✕ ' + t(lang, 'tokenizer.close') : '⇄ ' + t(lang, 'tokenizer.compare')}
          </button>

          <!-- Copy JSON -->
          <button
            type="button"
            class="tokenizer__action-btn"
            onclick={copyResult}
            id="btn-copy-json"
            disabled={!result}
            aria-label={t(lang, 'tokenizer.copy') || 'Copy tokens as JSON'}
          >
            {copySuccess ? '✓ ' + t(lang, 'tokenizer.copied') : '⎘ ' + t(lang, 'tokenizer.copy')}
          </button>
        </div>
      </div>

      <!-- Reasoning-token disclosure — static honesty note, no numeric
           estimate. Shown whenever the SELECTED model can generate hidden,
           billable reasoning tokens (see ModelInfo.hiddenReasoning). -->
      {#if hasHiddenReasoning}
        <p class="tokenizer__reasoning-notice" role="note">
          ⚠️ {t(lang, 'tokenizer.hiddenReasoningNotice')}
        </p>
      {/if}

      <!-- Status banner: loading/fetching/error -->
      {#if tokenizerStatus === 'loading' && isTyping}
        <div class="tokenizer__status-banner tokenizer__status-banner--loading">
          <span class="tokenizer__micro-spinner"></span>
          {t(lang, 'tokenizer.loadingTokenizer')}
        </div>
      {:else if tokenizerStatus === 'fetching' && isTyping}
        <div class="tokenizer__status-banner tokenizer__status-banner--fetching">
          <span class="tokenizer__micro-spinner"></span>
          {t(lang, 'tokenizer.fetchingApi')}
        </div>
      {:else if usedFallback && result}
        <div class="tokenizer__status-banner tokenizer__status-banner--error">
          <span>⚠️ {getFallbackMessage(result.fallbackReason)}</span>
          <button type="button" class="tokenizer__retry-btn" onclick={retryTokenize}>
            {t(lang, 'tokenizer.retry')}
          </button>
        </div>
      {/if}

      <!-- Textarea -->
      <textarea
        bind:value={text}
        class="tokenizer__textarea"
        placeholder={t(lang, 'tokenizer.placeholder')}
        aria-label={t(lang, 'tokenizer.textareaLabel') || 'Text to tokenize'}
        maxlength={MAX_TOKENIZER_INPUT_LENGTH}
      ></textarea>

      {#if nearCharLimit}
        <div class="tokenizer__char-limit-hint" role="status">
          {t(lang, 'tokenizer.charLimitHint')
            .replace('{count}', text.length.toLocaleString())
            .replace('{max}', MAX_TOKENIZER_INPUT_LENGTH.toLocaleString())}
        </div>
      {/if}

      <!-- Keyboard hint -->
      <div class="tokenizer__hint" aria-label={t(lang, 'tokenizer.keyboardShortcutLabel')}>
        <kbd>Ctrl</kbd> + <kbd>Enter</kbd> — {t(lang, 'tokenizer.tokenizeNow')}
      </div>
    </div>

    <!-- Stats -->
    <div class="tokenizer__stats js-reveal-stats">
      <div class="tokenizer__stat-card">
        <span class="tokenizer__stat-label">
          {displayedMode === 'chat'
            ? t(lang, 'tokenizer.wrappedTotal')
            : t(lang, 'tokenizer.tokens')}
        </span>
        <span class="tokenizer__stat-value">{displayTokens}</span>
        {#if displayedMode === 'chat' && result?.chatOverhead && chatOverheadInfo}
          <span
            class="tokenizer__chat-overhead-badge tokenizer__chat-overhead-badge--{result
              .chatOverhead.exactness}"
            title="{t(lang, 'tokenizer.chatOverheadExplain')} {chatOverheadInfo.tooltip}"
          >
            +{result.chatOverhead.overhead}
            {t(lang, 'tokenizer.chatOverhead')} · {chatOverheadInfo.label}
          </span>
        {/if}
      </div>
      <div class="tokenizer__stat-card">
        <span class="tokenizer__stat-label">{t(lang, 'tokenizer.characters')}</span>
        <span class="tokenizer__stat-value">{displayChars}</span>
      </div>
      <div class="tokenizer__stat-card">
        <span class="tokenizer__stat-label">{t(lang, 'tokenizer.density')}</span>
        <span class="tokenizer__stat-value">{displayDensity.toFixed(2)}</span>
      </div>
      <div class="tokenizer__stat-card">
        <span class="tokenizer__stat-label">{t(lang, 'tokenizer.latency')}</span>
        <span class="tokenizer__stat-value"
          >{formatLatencyMs(displayLatencyMs)} <span class="tokenizer__stat-unit">ms</span></span
        >
      </div>
    </div>
    {#if !result}
      <!-- Generic disclaimer before any tokenization has run. Once a result
           exists, the accuracy badge above states the real tier — showing
           this generic note too would contradict it. -->
      <p class="tokenizer__approx-note">{t(lang, 'tokenizer.approxNote')}</p>
    {/if}
  </div>

  <!-- ══════════════════════════════════════════════════════ -->
  <!-- OUTPUT PANEL                                          -->
  <!-- ══════════════════════════════════════════════════════ -->
  <div class="tokenizer__output-panel js-reveal-output">
    <div class="tokenizer__output-header">
      {t(lang, 'tokenizer.outputHeader')}
      {#if isTyping}
        <span class="tokenizer__typing-indicator" aria-label={t(lang, 'tokenizer.tokenizing')}
          >●</span
        >
      {/if}
    </div>

    <div class="tokenizer__output" aria-live="polite">
      {#if result}
        {#if hasTokenBreakdown}
          <!-- Token breakdown available (tiktoken / transformers models) -->
          {#if viewMode === 'blocks'}
            {#each result.tokens as token, i (tokenKey + '-' + token.id + '-' + i)}
              <!-- svelte-ignore a11y_mouse_events_have_key_events -->
              <span
                class="token"
                style="--hue: {token.hue}; animation-delay: {Math.min(i, 60) * 20}ms"
                role="button"
                tabindex="0"
                aria-label={t(lang, 'tokenizer.tokenAriaLabel')
                  .replace('{id}', String(token.id))
                  .replace('{text}', token.text)}
                onmousemove={(e) => showTooltip(e, token)}
                onmouseleave={hideTooltip}
                onclick={(e) => {
                  e.stopPropagation();
                  showTooltip(e, token);
                }}
                onkeydown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    showTooltip(e, token);
                  }
                }}>{token.text}</span
              >
            {/each}
          {:else}
            <!-- Heatmap mode — position: relative for tooltip -->
            <div style="position: relative;">
              <TokenHeatmap tokens={result.tokens} {lang} />
            </div>
          {/if}
        {:else}
          <!-- No token breakdown (API models: Claude, Gemini, Gemma) -->
          <div class="tokenizer__no-breakdown">
            <div class="tokenizer__no-breakdown-count">
              {t(lang, getCountLabelKey(result.accuracy))}:
              <strong>{result.totalTokens.toLocaleString()}</strong>
              {t(lang, 'tokenizer.tokensUnit')}
            </div>
            <p class="tokenizer__no-breakdown-msg">
              {t(lang, 'tokenizer.noBreakdown')}
            </p>
          </div>
        {/if}
      {:else if tokenizerStatus === 'error'}
        <!-- Genuine tokenizer failure (not the API-offline fallback, which
             still produces a result) — keep this reachable even though it
             sits alongside the `{#if result}` branch above, not behind it. -->
        <div class="tokenizer__error-state" role="alert">
          <span class="tokenizer__error-msg">⚠️ {t(lang, 'tokenizer.errorLoading')}</span>
          <button type="button" class="tokenizer__retry-btn" onclick={retryTokenize}>
            {t(lang, 'tokenizer.retry')}
          </button>
        </div>
      {:else if !text.trim()}
        <span class="tokenizer__output-placeholder">
          {t(lang, 'tokenizer.emptyPlaceholder')}
        </span>
      {/if}
    </div>
  </div>

  <!-- ══════════════════════════════════════════════════════ -->
  <!-- COMPARE PANEL (conditionally rendered)                -->
  <!-- ══════════════════════════════════════════════════════ -->
  {#if showCompare}
    <div class="tokenizer__compare-panel">
      <div class="tokenizer__compare-header">
        {t(lang, 'tokenizer.compareTitle')}
      </div>
      <TokenCompare {text} {lang} />
    </div>
  {/if}
</div>

{#if tooltip.visible && tooltip.token}
  <div class="token__tooltip" style="left: {tooltip.x}px; top: {tooltip.y}px;" role="tooltip">
    <div class="token__tooltip-row">
      <span class="token__tooltip-key">id</span>
      <span class="token__tooltip-val">{tooltip.token.id}</span>
    </div>
    <div class="token__tooltip-row">
      <span class="token__tooltip-key">text</span>
      <span class="token__tooltip-val token__tooltip-text"
        >"{tooltip.token.text.replace(/\n/g, '↵').replace(/ /g, '·')}"</span
      >
    </div>
    {#if tooltip.token.partial}
      <div class="token__tooltip-row">
        <span class="token__tooltip-key">bytes</span>
        <span
          class="token__tooltip-val token__tooltip-val--partial"
          title={t(lang, 'tokenizer.partialByteSequenceTooltip')}
        >
          ⚠ {t(lang, 'tokenizer.partialByteSequence')}
        </span>
      </div>
    {:else}
      <div class="token__tooltip-row">
        <span class="token__tooltip-key">bytes</span>
        <span class="token__tooltip-val">[{tooltip.token.bytes.join(', ')}]</span>
      </div>
      <div class="token__tooltip-row">
        <span class="token__tooltip-key">len</span>
        <span class="token__tooltip-val">{tooltip.token.bytes.length}B</span>
      </div>
    {/if}
  </div>
{/if}
