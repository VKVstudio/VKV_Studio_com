<script lang="ts">
  import { onMount } from 'svelte';
  import { t } from '../../../i18n/utils';
  import { publishLabState } from '../../../lib/lab-copilot-bus';
  import '../../../styles/lab/prompt.css';
  import {
    type PromptBlock,
    type BlockRole,
    type ModelConfig,
    MODELS,
    MAX_BLOCK_CONTENT_LENGTH,
    countTokens,
    calculateCost,
    calculateOutputCost,
    calculateCachedCost,
    chatWrappingOverhead,
    evaluateCacheEligibility,
    defaultCacheableForRole,
    exportAsAnthropicMessages,
    anthropicExportRoleOrderWarning,
    exportAsOpenAIChatCompletions,
    exportAsOpenAIResponsesAPI,
    exportAsPlainText,
    extractVariables,
    applyVariables,
    type TemplatePreset,
  } from '../../../lib/prompt/builder';
  import PromptBlockComponent from './PromptBlock.svelte';
  import VariablePanel from './VariablePanel.svelte';
  import TemplateSelector from './TemplateSelector.svelte';
  import MetaPromptGenerator from './MetaPromptGenerator.svelte';

  let { lang = 'en' } = $props<{ lang?: 'en' | 'ru' }>();

  // ─── Model ─────────────────────────────────────────────────────────────────
  let modelId = $state(MODELS[0].id);
  let selectedModel = $derived(MODELS.find((m) => m.id === modelId) || MODELS[0]);

  // ─── Blocks ────────────────────────────────────────────────────────────────
  let activeTab = $state<'build' | 'generate'>('build');
  let blocks = $state<PromptBlock[]>([
    {
      id: crypto.randomUUID(),
      role: 'system',
      content: t(lang, 'prompt.defaultSystemContent'),
      tokens: 0,
      collapsed: false,
      cacheable: defaultCacheableForRole('system'),
    },
    {
      id: crypto.randomUUID(),
      role: 'user',
      content: '',
      tokens: 0,
      collapsed: false,
      cacheable: defaultCacheableForRole('user'),
    },
  ]);

  // ─── Aggregates ────────────────────────────────────────────────────────────
  // `totalTokens` is the raw content of the blocks (what the TOKENS stat shows,
  // unchanged by the overhead-honesty work below).
  let totalTokens = $derived(blocks.reduce((acc, b) => acc + b.tokens, 0));
  // A real chat request also carries per-message wrapper + reply-priming
  // tokens. `chatWrappingOverhead` only applies OpenAI's documented ChatML
  // formula (tier 'documented') when the selected model's tokenizer backend
  // actually is tiktoken; every other provider gets a conservative flat
  // 'estimated' placeholder instead of silently borrowing OpenAI's formula —
  // see the function's doc comment in lib/prompt/builder.ts. `tools` blocks
  // are excluded from the message count: they're a top-level API field in
  // every export shape here, not a chat turn.
  let chatTurnCount = $derived(blocks.filter((b) => b.role !== 'tools').length);
  let overheadInfo = $derived(chatWrappingOverhead(chatTurnCount, selectedModel));
  let overheadTokens = $derived(overheadInfo.overhead);
  let billedInputTokens = $derived(totalTokens + overheadTokens);
  let budgetPercent = $derived(
    Math.min(100, (billedInputTokens / selectedModel.contextWindow) * 100)
  );
  let estimatedCostIn = $derived(calculateCost(billedInputTokens, selectedModel));

  // Chat-overhead honesty tier → i18n label + tooltip, mirrors the Tokenizer
  // tool's getChatOverheadInfo (see TokenizerApp.svelte) so both tools use
  // the exact same tier vocabulary.
  function overheadTierInfo(exactness: 'native' | 'documented' | 'estimated'): {
    label: string;
    tooltip: string;
  } {
    switch (exactness) {
      case 'native':
        return {
          label: t(lang, 'prompt.overheadTierNative'),
          tooltip: t(lang, 'prompt.overheadTierNativeTooltip'),
        };
      case 'documented':
        return {
          label: t(lang, 'prompt.overheadTierDocumented'),
          tooltip: t(lang, 'prompt.overheadTierDocumentedTooltip'),
        };
      case 'estimated':
        return {
          label: t(lang, 'prompt.overheadTierEstimated'),
          tooltip: t(lang, 'prompt.overheadTierEstimatedTooltip'),
        };
    }
  }
  let overheadTier = $derived(overheadTierInfo(overheadInfo.exactness));

  // Format a USD cost. A genuinely free (local) model reads "$0.0000"; a paid
  // model whose cost is real but rounds below the 4th decimal reads "<$0.0001"
  // instead — so a cheap-but-nonzero estimate isn't mistaken for free.
  function formatUsd(v: number): string {
    if (v <= 0) return '$0.0000';
    if (v < 0.0001) return '<$0.0001';
    return '$' + v.toFixed(4);
  }

  // ─── Expected output length ────────────────────────────────────────────────
  // Output-token count can't be derived from the input: it depends entirely
  // on how long the model's reply turns out to be, which swings wildly by
  // task (a translation echoes ~1x the input; a one-line chat answer might be
  // 50 tokens; a full code review can run into the thousands). Guessing with
  // a fixed ratio of the input size was arbitrary, so the user picks an
  // expected reply length directly via presets or a custom value.
  type OutputPreset = 'short' | 'medium' | 'long' | 'custom';
  const OUTPUT_PRESETS: { key: Exclude<OutputPreset, 'custom'>; tokens: number }[] = [
    { key: 'short', tokens: 150 },
    { key: 'medium', tokens: 500 },
    { key: 'long', tokens: 1500 },
  ];
  const MIN_OUTPUT_TOKENS = 1;
  const MAX_OUTPUT_TOKENS = 200_000;
  let outputPreset = $state<OutputPreset>('medium');
  let expectedOutputTokens = $state(500); // default = Medium

  function selectOutputPreset(preset: Exclude<OutputPreset, 'custom'>) {
    const found = OUTPUT_PRESETS.find((p) => p.key === preset);
    if (!found) return;
    outputPreset = preset;
    expectedOutputTokens = found.tokens;
  }

  function selectCustomOutputPreset() {
    outputPreset = 'custom';
  }

  function handleCustomOutputInput(e: Event) {
    const raw = Number((e.target as HTMLInputElement).value);
    if (!Number.isFinite(raw)) return;
    expectedOutputTokens = Math.min(
      MAX_OUTPUT_TOKENS,
      Math.max(MIN_OUTPUT_TOKENS, Math.round(raw))
    );
  }

  let outputPresetLabelKey = $derived(
    outputPreset === 'short'
      ? 'prompt.outputShort'
      : outputPreset === 'medium'
        ? 'prompt.outputMedium'
        : outputPreset === 'long'
          ? 'prompt.outputLong'
          : 'prompt.outputCustom'
  );
  // "Output: ~500 tokens (Medium)" — surfaced next to the output-cost stat so
  // the estimate driving that cost (and the caching panel below) is visible,
  // not a hidden assumption.
  let outputTokensLabel = $derived(
    t(lang, 'prompt.outputTokensLabel')
      .replace('{n}', expectedOutputTokens.toLocaleString())
      .replace('{preset}', t(lang, outputPresetLabelKey))
  );

  // `billedInputTokens` is passed because a long-context pricing tier is
  // triggered by the size of the PROMPT and then reprices the output too:
  // Gemini 3.1 Pro's output goes $12 → $18 once the prompt passes 200k, and
  // nothing about the output itself says so.
  let estimatedCostOut = $derived(
    calculateOutputCost(expectedOutputTokens, selectedModel, billedInputTokens)
  );

  // ─── Cache-aware cost ──────────────────────────────────────────────────────
  // Sums use `block.tokens`, which already reflect the active `countMode`
  // (template vs. resolved) via the debounced recompute below — so the
  // caching panel stays in sync with the same counts driving the budget bar.
  //
  // `evaluateCacheEligibility` floor-filters: a block marked cacheable but
  // below the model's `minCacheTokens` would not actually be cached by the
  // provider, so its tokens must NOT count toward `cacheableTokens` below (or
  // the "cached call" estimate would overstate real savings).
  let cacheEligibility = $derived(evaluateCacheEligibility(blocks, selectedModel));
  let cacheableTokens = $derived(cacheEligibility.eligibleCacheableTokens);
  // Everything that isn't actually cached (non-cacheable blocks + cacheable
  // blocks below the floor) plus wrapper overhead is billed fresh every call.
  let freshTokens = $derived(totalTokens - cacheableTokens + overheadTokens);

  // ─── Batch API toggle (item 4) ─────────────────────────────────────────────
  // Only offered when the selected model documents a batch discount (see
  // ModelConfig.batchDiscount) — Anthropic's Message Batches API / OpenAI's
  // Batch API, both −50%, stacking multiplicatively on top of any cache
  // discount (see calculateCachedCost's batchMultiplier doc comment).
  let batchMode = $state(false);
  const BATCH_API_NAME: Partial<Record<ModelConfig['provider'], string>> = {
    anthropic: 'Anthropic Message Batches API',
    openai: 'OpenAI Batch API',
  };
  let batchApiName = $derived(BATCH_API_NAME[selectedModel.provider] ?? '');
  let batchMultiplier = $derived(
    batchMode && selectedModel.batchDiscount ? selectedModel.batchDiscount : 1
  );

  let cachedCost = $derived(
    calculateCachedCost(
      cacheableTokens,
      freshTokens,
      expectedOutputTokens,
      selectedModel,
      batchMultiplier
    )
  );

  // Publish a short "on screen now" summary for the Lab Copilot panel, plus a
  // structured `detail` of the same honest facts already on screen — see
  // lab-copilot-bus.ts. `cacheSavingsPct`/`batchOn` are only included when
  // the corresponding UI is actually relevant (a cacheable block exists /
  // the model documents a batch discount), never a fabricated 0.
  $effect(() => {
    publishLabState(
      'prompt',
      `${selectedModel.name} · ${totalTokens.toLocaleString()} tokens · ${blocks.length} blocks`,
      {
        model: selectedModel.name,
        blocks: blocks.length,
        rawTokens: totalTokens,
        billedTokens: billedInputTokens,
        estCost: formatUsd(estimatedCostIn),
        ...(blocks.some((b) => b.cacheable) ? { cacheSavingsPct: cachedCost.savingsPct } : {}),
        ...(selectedModel.batchDiscount ? { batchOn: batchMode } : {}),
      }
    );
  });

  // ─── Variables ─────────────────────────────────────────────────────────────
  let variableValues = $state<Record<string, string>>({});
  let previewActive = $state(false);
  let showVariablesDrawer = $state(false);

  let detectedVars = $derived(extractVariables(blocks));

  /** Returns content to render: raw or with variables applied */
  function getDisplayContent(block: PromptBlock): string {
    if (previewActive) return applyVariables(block.content, variableValues);
    return block.content;
  }

  // ─── Token counting (debounced) ────────────────────────────────────────────
  // 'resolved' (default) counts the substituted text (variables filled in) —
  // this is what actually gets sent to the model. 'template' counts the raw
  // `{{var}}` text as authored, useful when comparing template weight itself.
  let countMode = $state<'template' | 'resolved'>('resolved');
  /**
   * Whether the total shown is the provider's own count or the local cl100k
   * approximation. `null` until the first run finishes. Deliberately NOT
   * defaulted to 'exact': claiming precision before anything has been counted
   * is exactly the kind of small lie this tool exists not to tell.
   */
  let countAccuracy = $state<'exact' | 'approx' | null>(null);

  /**
   * Plain `let`, not `$state` — it is read and written inside one async flow and
   * nothing renders from it, so making it reactive would only invite an effect
   * loop. Gates the one count that happens without anybody asking; see its use
   * in recomputeTokens.
   */
  let isInitialCount = true;

  let isCalculating = $state(false);
  // Set when a recompute run fails outright (e.g. tokenizer WASM/network
  // load failure). Last-known `blocks[].tokens` values are left untouched,
  // so the budget/cost stats stay visible — this only surfaces the warning.
  let calcError = $state(false);
  let debounceTimer: ReturnType<typeof setTimeout>;

  // Bookkeeping for the debounced tokenizer — plain (non-$state) locals.
  // They're not UI state, and mutating them inside an async callback would
  // otherwise be a read+write-in-$effect trap if they were reactive.
  let lastCalcModel = modelId;
  let lastCalcContents: Record<string, string> = {};
  /**
   * Each block's accuracy from the run that last counted it, kept because the
   * verdict is about the WHOLE prompt and most runs only recount one block.
   *
   * Without this the badge lied by forgetting. The verdict was computed from
   * the blocks touched by the current run alone, and blocks skipped as
   * unchanged were excluded on the reasoning that they "cannot upgrade the
   * verdict" — but excluding them is precisely what let them be upgraded.
   * Count an exact block and an approximated one: verdict "approx", correctly.
   * Now edit only the exact one. The next run recounts that block by itself,
   * finds it exact, and stamps the total "exact" while half of it is still a
   * cl100k stand-in. Reproduced on the live site. Parallel to
   * `lastCalcContents`, and maintained by the same delete/clone paths below.
   */
  let lastCalcAccuracy: Record<string, 'exact' | 'approx'> = {};
  let latestRequestId = 0;
  // Race-condition guard, mirrors TokenizerApp.svelte's activeController
  // pattern: a run's in-flight API tokenize calls (see countTokens's signal
  // param) are aborted the instant a newer run starts, instead of racing to
  // completion uncancelled on every keystroke.
  let activeController: AbortController | null = null;

  /** Text actually counted for a block, per the current count-mode toggle */
  function getCountText(block: PromptBlock): string {
    return countMode === 'template' ? block.content : applyVariables(block.content, variableValues);
  }

  /**
   * Tokenizes the given snapshot and writes results back onto `blocks`.
   * Guards against out-of-order async races: captures a monotonically
   * increasing request id before awaiting, and discards the result if a
   * newer run has already started by the time this one resolves — this
   * also prevents stamping `lastCalcContents` with a stale snapshot.
   */
  async function recomputeTokens(snapshot: { id: string; text: string }[], model: ModelConfig) {
    const myRequestId = ++latestRequestId;
    activeController?.abort();
    const controller = new AbortController();
    activeController = controller;
    isCalculating = true;
    calcError = false; // optimistic reset — this fresh run may succeed
    try {
      const modelChanged = lastCalcModel !== model.id;
      let hasChanges = false;
      const results = await Promise.all(
        snapshot.map(async (b) => {
          const changed = modelChanged || lastCalcContents[b.id] !== b.text;
          if (!changed) return { id: b.id, tokens: -1, accuracy: null, text: b.text };
          hasChanges = true;
          const counted = await countTokens(b.text, model, {
            signal: controller.signal,
            // The very first recompute happens 300 ms after mount, for a default
            // system block the visitor has not written or even read yet. Letting
            // it reach the network meant every page load fired a cross-origin
            // POST that, with no inference server deployed, could only fail —
            // logging a console error and waiting ~2.3 s for the connection to
            // give up before the local count even started. A count nobody asked
            // for stays local; the moment the visitor edits anything, exact
            // counts resume.
            allowNetwork: !isInitialCount,
          });
          return { id: b.id, tokens: counted.tokens, accuracy: counted.accuracy, text: b.text };
        })
      );

      if (myRequestId !== latestRequestId) return; // superseded — discard the stale result

      if (hasChanges) {
        for (const res of results) {
          if (res.tokens === -1) continue;
          const idx = blocks.findIndex((b) => b.id === res.id);
          if (idx !== -1) blocks[idx].tokens = res.tokens;
          lastCalcContents[res.id] = res.text;
          if (res.accuracy !== null) lastCalcAccuracy[res.id] = res.accuracy;
        }
        lastCalcModel = model.id;
        // The whole total is only as exact as its least exact part: one
        // approximated block makes the sum — and the cost derived from it — an
        // approximation too. Judged over every block in the prompt, using each
        // one's remembered verdict, not only over the blocks this run happened
        // to recount. A block with no remembered verdict has never been
        // counted, so it cannot vouch for anything either.
        const known = snapshot
          .map((b) => lastCalcAccuracy[b.id])
          .filter((a): a is 'exact' | 'approx' => a !== undefined);
        countAccuracy =
          known.length === 0
            ? countAccuracy
            : known.every((a) => a === 'exact')
              ? 'exact'
              : 'approx';
      }
      // Only after a run has actually completed: an aborted or superseded first
      // attempt must not convince the next one that the page is warm.
      isInitialCount = false;
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return; // intentionally cancelled
      if (myRequestId !== latestRequestId) return; // superseded — don't surface a stale error
      calcError = true; // last-known blocks[].tokens are untouched, so counts stay visible
    } finally {
      // Only the latest in-flight run may clear the loading flag — a
      // superseded run finishing late must not stomp on a newer run's state.
      if (myRequestId === latestRequestId) isCalculating = false;
    }
  }

  $effect(() => {
    const currentModel = selectedModel;
    // getCountText() reads countMode + variableValues synchronously below,
    // so both are tracked as effect dependencies (recomputes the budget when
    // the toggle flips or a variable value changes).
    const snapshot = blocks.map((b) => ({ id: b.id, text: getCountText(b) }));
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      void recomputeTokens(snapshot, currentModel);
    }, 300);
    return () => clearTimeout(debounceTimer);
  });

  // ─── DnD ───────────────────────────────────────────────────────────────────
  let dragSourceIndex = $state<number | null>(null);
  let dragOverIndex = $state<number | null>(null);

  function handleDragStart(index: number, e: DragEvent) {
    dragSourceIndex = index;
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(index));
    }
    // Ghost opacity
    const el = (e.target as HTMLElement).closest('.prompt-block') as HTMLElement | null;
    if (el) el.style.opacity = '0.5';
  }

  function handleDragOver(index: number, e: DragEvent) {
    e.preventDefault();
    dragOverIndex = index;
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  }

  function handleDrop(targetIndex: number, e: DragEvent) {
    e.preventDefault();
    if (dragSourceIndex === null || dragSourceIndex === targetIndex) {
      dragSourceIndex = null;
      dragOverIndex = null;
      return;
    }
    const newBlocks = [...blocks];
    const [moved] = newBlocks.splice(dragSourceIndex, 1);
    newBlocks.splice(targetIndex, 0, moved);
    blocks = newBlocks;
    dragSourceIndex = null;
    dragOverIndex = null;
  }

  function handleDragEnd(e: DragEvent) {
    const el = (e.target as HTMLElement).closest('.prompt-block') as HTMLElement | null;
    if (el) el.style.opacity = '';
    dragSourceIndex = null;
    dragOverIndex = null;
  }

  // ─── Block CRUD ────────────────────────────────────────────────────────────
  function addBlock() {
    blocks = [
      ...blocks,
      {
        id: crypto.randomUUID(),
        role: 'user',
        content: '',
        tokens: 0,
        collapsed: false,
        cacheable: defaultCacheableForRole('user'),
      },
    ];
  }

  function removeBlock(id: string) {
    if (blocks.length <= 1) return;
    blocks = blocks.filter((b) => b.id !== id);
    delete lastCalcContents[id]; // avoid unbounded growth of the tokenize memo
    delete lastCalcAccuracy[id];
  }

  function duplicateBlock(id: string) {
    const idx = blocks.findIndex((b) => b.id === id);
    if (idx === -1) return;
    const original = blocks[idx];
    const clone: PromptBlock = { ...original, id: crypto.randomUUID() };
    const newBlocks = [...blocks];
    newBlocks.splice(idx + 1, 0, clone);
    blocks = newBlocks;
    // Clone starts with the same content/tokens as the original — seed its
    // memo entry too, so it isn't (wrongly) treated as "changed" and
    // re-tokenized on the next debounce tick.
    if (original.id in lastCalcAccuracy) {
      lastCalcAccuracy[clone.id] = lastCalcAccuracy[original.id]!;
    }
    if (original.id in lastCalcContents) {
      lastCalcContents[clone.id] = lastCalcContents[original.id];
    }
  }

  function updateBlock(id: string, patch: Partial<PromptBlock>) {
    const idx = blocks.findIndex((b) => b.id === id);
    if (idx === -1) return;
    blocks[idx] = { ...blocks[idx], ...patch };
  }

  function moveBlock(id: string, direction: 'up' | 'down') {
    const idx = blocks.findIndex((b) => b.id === id);
    if (idx === -1) return;
    if (direction === 'up' && idx === 0) return;
    if (direction === 'down' && idx === blocks.length - 1) return;
    const newBlocks = [...blocks];
    const targetIdx = direction === 'up' ? idx - 1 : idx + 1;
    [newBlocks[idx], newBlocks[targetIdx]] = [newBlocks[targetIdx], newBlocks[idx]];
    blocks = newBlocks;
  }

  // ─── Clear All ─────────────────────────────────────────────────────────────
  let showClearConfirm = $state(false);
  /** The Clear-All trigger button — focus returns here when the modal closes. */
  let clearTriggerEl: HTMLElement | undefined = $state();

  function requestClearAll(e?: MouseEvent) {
    clearTriggerEl = (e?.currentTarget as HTMLElement) ?? clearTriggerEl;
    showClearConfirm = true;
  }
  /** Close + return focus to the trigger so a keyboard user isn't left on <body>. */
  function closeClearConfirm() {
    showClearConfirm = false;
    const trigger = clearTriggerEl;
    requestAnimationFrame(() => trigger?.focus());
  }
  function confirmClearAll() {
    blocks = [
      {
        id: crypto.randomUUID(),
        role: 'system',
        content: '',
        tokens: 0,
        collapsed: false,
        cacheable: defaultCacheableForRole('system'),
      },
    ];
    variableValues = {};
    previewActive = false;
    lastCalcContents = {}; // old block ids are gone — drop their memo entries
    closeClearConfirm();
  }
  function cancelClearAll() {
    closeClearConfirm();
  }

  /** Move focus onto Cancel when the modal mounts (Svelte action on the {#if}). */
  function focusOnMount(node: HTMLElement): void {
    node.querySelector<HTMLElement>('.confirm-btn--cancel')?.focus();
  }

  /** aria-modal="true" must actually trap: Escape cancels, Tab cycles inside. */
  function handleClearDialogKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      cancelClearAll();
      return;
    }
    if (e.key !== 'Tab') return;
    const dialog = e.currentTarget as HTMLElement;
    const focusables = dialog.querySelectorAll<HTMLElement>('button');
    if (focusables.length === 0) return;
    const first = focusables[0]!;
    const last = focusables[focusables.length - 1]!;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  // ─── Templates ─────────────────────────────────────────────────────────────
  function loadTemplate(tpl: TemplatePreset) {
    blocks = tpl.blocks.map((b) => ({ ...b, id: crypto.randomUUID(), tokens: 0 }));
    variableValues = {};
    previewActive = false;
    lastCalcContents = {}; // old block ids are gone — drop their memo entries
  }

  // ─── Export ────────────────────────────────────────────────────────────────
  let copySuccess = $state(false);
  // Which format "Copy All" writes to the clipboard. Selecting a format below
  // also copies immediately in that format, so the two ways of triggering an
  // export (pick-a-format vs. "Copy All") never disagree with each other.
  // Four explicit, honestly-labeled formats (item 1) rather than one
  // provider-auto-detected shape — a user comparing providers can see any
  // shape regardless of which model is selected in the cost calculator above.
  type ExportFormat = 'anthropic' | 'openai-chat' | 'openai-responses' | 'plain';
  let exportFormat = $state<ExportFormat>('plain');
  const EXPORT_FORMAT_LABEL_KEY: Record<ExportFormat, string> = {
    anthropic: 'prompt.exportAnthropic',
    'openai-chat': 'prompt.exportOpenaiChat',
    'openai-responses': 'prompt.exportOpenaiResponses',
    plain: 'prompt.exportPlain',
  };
  let exportFormatLabelKey = $derived(EXPORT_FORMAT_LABEL_KEY[exportFormat]);

  // Item 2 — the Anthropic Messages API 400s on an assistant-first
  // `messages` array. `anthropicExportRoleOrderWarning` is only true when
  // the prompt's first user/assistant block is assistant AND there's no
  // context block available to rescue it into a leading user turn (see its
  // doc comment in builder.ts) — role order doesn't depend on the
  // Template/Resolved toggle, so this reads raw `blocks` rather than
  // `getExportBlocks()`. Only surfaced while Anthropic is the active export
  // target, so it doesn't nag about a format the user isn't looking at.
  let anthropicRoleWarning = $derived(
    exportFormat === 'anthropic' && anthropicExportRoleOrderWarning(blocks)
  );

  /** Blocks with content resolved per the current Template/Resolved toggle —
   *  the same substitution Preview already applies via `getCountText`, so
   *  export never leaks raw `{{placeholders}}` while Resolved is active. */
  function getExportBlocks(): PromptBlock[] {
    return blocks.map((b) => ({ ...b, content: getCountText(b) }));
  }

  function buildExportText(format: ExportFormat): string {
    const expBlocks = getExportBlocks();
    switch (format) {
      case 'anthropic':
        return exportAsAnthropicMessages(expBlocks, selectedModel);
      case 'openai-chat':
        return exportAsOpenAIChatCompletions(expBlocks);
      case 'openai-responses':
        return exportAsOpenAIResponsesAPI(expBlocks, selectedModel);
      case 'plain':
        return exportAsPlainText(expBlocks);
    }
  }

  async function handleExportFormat(format: ExportFormat) {
    exportFormat = format;
    await navigator.clipboard.writeText(buildExportText(format));
    showCopySuccess();
  }
  async function handleCopyAll() {
    await navigator.clipboard.writeText(buildExportText(exportFormat));
    showCopySuccess();
  }

  function showCopySuccess() {
    copySuccess = true;
    setTimeout(() => (copySuccess = false), 2000);
  }

  // ─── Mobile detection ──────────────────────────────────────────────────────
  let isMobile = $state(false);
  $effect(() => {
    const mq = window.matchMedia('(max-width: 767px)');
    isMobile = mq.matches;
    const handler = (e: MediaQueryListEvent) => {
      isMobile = e.matches;
    };
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  });

  // ─── Cross-tool handoff (item 4): tokenizer → Prompt Architect ─────────────
  // See LabCopilot.svelte's handoffToPrompt(): the tokenizer stashes its
  // current text in sessionStorage before navigating here. Consumed once, on
  // mount, and the key is cleared immediately either way (stale/bad payloads
  // must not linger for a later visit to pick up).
  const HANDOFF_STORAGE_KEY = 'vkv-lab-handoff';
  const HANDOFF_MAX_AGE_MS = 5 * 60 * 1000;
  let handoffNotice = $state(false);
  // Root element + a stable fallback focus target, both used only by
  // `dismissHandoffNotice` below to restore focus somewhere sensible once
  // the notice (and the ✕ button that had focus) is removed from the DOM.
  let promptRootEl: HTMLDivElement | undefined = $state();
  let addBlockBtnEl: HTMLButtonElement | undefined = $state();

  function consumeHandoff(): void {
    if (typeof sessionStorage === 'undefined') return;
    let raw: string | null;
    try {
      raw = sessionStorage.getItem(HANDOFF_STORAGE_KEY);
    } catch {
      return;
    }
    if (!raw) return;
    sessionStorage.removeItem(HANDOFF_STORAGE_KEY);

    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof payload !== 'object' || payload === null) return;
    const { text, ts } = payload as Record<string, unknown>;
    if (typeof text !== 'string' || !text.trim() || typeof ts !== 'number') return;
    if (Date.now() - ts > HANDOFF_MAX_AGE_MS) return;

    const capped = text.slice(0, MAX_BLOCK_CONTENT_LENGTH);
    const firstUserIdx = blocks.findIndex((b) => b.role === 'user');
    // Narrowed local instead of indexing `blocks[firstUserIdx]` again inside
    // the condition — `noUncheckedIndexedAccess` types that as possibly
    // `undefined` regardless of the `!== -1` check above (TS doesn't narrow
    // an index access from an unrelated numeric comparison).
    const firstUserBlock = firstUserIdx !== -1 ? blocks[firstUserIdx] : undefined;
    if (firstUserBlock && !firstUserBlock.content.trim()) {
      blocks[firstUserIdx] = { ...firstUserBlock, content: capped };
    } else {
      blocks = [
        ...blocks,
        {
          id: crypto.randomUUID(),
          role: 'user',
          content: capped,
          tokens: 0,
          collapsed: false,
          cacheable: defaultCacheableForRole('user'),
        },
      ];
    }
    handoffNotice = true;
  }

  function dismissHandoffNotice(): void {
    handoffNotice = false;
    // The dismissed notice's ✕ button (which just had focus) is about to be
    // removed from the DOM — without an explicit new target, focus would
    // silently drop to <body>. Move it to the first block's textarea (where
    // the imported text actually landed), so keyboard/screen-reader users
    // land somewhere useful; the Add Block button is a stable fallback for
    // when no block textarea is currently rendered (e.g. the Generate tab
    // is active). Deferred a tick so it runs after Svelte removes the ✕
    // button, mirroring the `queueMicrotask` scroll idiom used elsewhere in
    // this codebase (e.g. LabCopilot.svelte's ask()).
    queueMicrotask(() => {
      const firstTextarea =
        promptRootEl?.querySelector<HTMLTextAreaElement>('.prompt-block__textarea');
      (firstTextarea ?? addBlockBtnEl)?.focus();
    });
  }

  // ─── Entrance animation ────────────────────────────────────────────────────
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
        '.prompt__header, .prompt__toolbar, .prompt-block, .prompt__actions, .prompt__footer',
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
            trigger: '.prompt',
            start: 'top 80%',
            scrub: false,
            toggleActions: 'play none none none',
          },
        }
      );
    } catch (err) {
      console.error('[prompt] motion failed to load:', err);
    }
  }

  onMount(() => {
    consumeHandoff();
    void initEntrance();
  });
</script>

<div class="prompt" bind:this={promptRootEl}>
  {#if handoffNotice}
    <div class="prompt__handoff-notice" role="status">
      <span>{t(lang, 'prompt.handoffNotice')}</span>
      <button
        type="button"
        class="prompt__handoff-dismiss"
        onclick={dismissHandoffNotice}
        aria-label={t(lang, 'prompt.handoffDismiss')}
      >
        ✕
      </button>
    </div>
  {/if}

  <!-- ═══ Header Panel ══════════════════════════════════════════════════════ -->
  <div class="prompt__header">
    <div class="prompt__stat">
      <label for="prompt-model-select" class="prompt__stat-label">{t(lang, 'prompt.model')}</label>
      <select id="prompt-model-select" bind:value={modelId} class="prompt__model-select">
        {#each MODELS as m}
          <option value={m.id}>{m.name}</option>
        {/each}
      </select>
      <p class="prompt__roster-stamp">{t(lang, 'prompt.rosterStamp')}</p>
    </div>

    <div class="prompt__budget">
      <div class="prompt__stat-label prompt__budget-label-row">
        <span
          >{t(lang, 'prompt.budget')}{isCalculating
            ? ' (' + t(lang, 'prompt.tokenizing') + ')'
            : ''}</span
        >
        <span
          class="prompt__budget-value"
          class:prompt__budget--warn={budgetPercent > 70}
          class:prompt__budget--danger={budgetPercent > 90}
        >
          {budgetPercent.toFixed(1)}%
        </span>
      </div>
      <div class="prompt__budget-bar-bg">
        <div
          class="prompt__budget-bar-fill"
          class:prompt__budget-bar--warn={budgetPercent > 70}
          class:prompt__budget-bar--danger={budgetPercent > 90}
          style="width: {budgetPercent}%"
        ></div>
      </div>
      {#if calcError}
        <div class="prompt__budget-error" role="alert">
          ⚠ {t(lang, 'prompt.countError')}
        </div>
      {/if}
      {#if overheadTokens > 0}
        <span
          class="prompt__overhead-badge prompt__overhead-badge--{overheadInfo.exactness}"
          title="{t(lang, 'prompt.overheadExplain')} {overheadTier.tooltip}"
        >
          +{overheadTokens}
          {t(lang, 'prompt.overhead')} · {overheadTier.label}
        </span>
      {/if}
    </div>

    <div class="prompt__stats">
      <div class="prompt__stat">
        <span class="prompt__stat-label">
          {t(lang, 'prompt.tokens')}
          {#if countAccuracy}
            <!-- Says which tokenizer produced this number. Without it the tool
                 showed a count, and a dollar figure derived from it, with no way
                 to tell a provider's own count from the cl100k stand-in. -->
            <span
              class="prompt__basis"
              class:prompt__basis--approx={countAccuracy === 'approx'}
              title={countAccuracy === 'exact'
                ? t(lang, 'prompt.basisExactTooltip')
                : t(lang, 'prompt.basisApproxTooltip')}
            >
              {countAccuracy === 'exact'
                ? t(lang, 'prompt.basisExact')
                : t(lang, 'prompt.basisApprox')}
            </span>
          {/if}
        </span>
        <span class="prompt__stat-value font-mono">
          {totalTokens.toLocaleString()}
          <span class="prompt__stat-dim">/ {selectedModel.contextWindow.toLocaleString()}</span>
        </span>
      </div>
      <div class="prompt__stat">
        <span class="prompt__stat-label">{t(lang, 'prompt.cost')} (in)</span>
        <span class="prompt__stat-value font-mono">{formatUsd(estimatedCostIn)}</span>
      </div>
      <div class="prompt__stat">
        <span class="prompt__stat-label">{t(lang, 'prompt.cost')} (out~)</span>
        <span class="prompt__stat-value font-mono">{formatUsd(estimatedCostOut)}</span>
        <span class="prompt__stat-dim">{outputTokensLabel}</span>
        {#if selectedModel.reasoningCapable}
          <p class="prompt__reasoning-notice" role="note">
            {t(lang, 'prompt.hiddenReasoningNotice')}
          </p>
        {/if}
      </div>
      <div class="prompt__stat">
        <span class="prompt__stat-label" title={t(lang, 'prompt.outputHint')}
          >{t(lang, 'prompt.expectedOutput')}</span
        >
        <div
          class="prompt__output-toggle"
          role="group"
          aria-label={t(lang, 'prompt.expectedOutput')}
          title={t(lang, 'prompt.outputHint')}
        >
          <button
            type="button"
            class="prompt__output-toggle-btn"
            class:active={outputPreset === 'short'}
            onclick={() => selectOutputPreset('short')}
            aria-pressed={outputPreset === 'short'}>{t(lang, 'prompt.outputShort')}</button
          >
          <button
            type="button"
            class="prompt__output-toggle-btn"
            class:active={outputPreset === 'medium'}
            onclick={() => selectOutputPreset('medium')}
            aria-pressed={outputPreset === 'medium'}>{t(lang, 'prompt.outputMedium')}</button
          >
          <button
            type="button"
            class="prompt__output-toggle-btn"
            class:active={outputPreset === 'long'}
            onclick={() => selectOutputPreset('long')}
            aria-pressed={outputPreset === 'long'}>{t(lang, 'prompt.outputLong')}</button
          >
          <button
            type="button"
            class="prompt__output-toggle-btn"
            class:active={outputPreset === 'custom'}
            onclick={selectCustomOutputPreset}
            aria-pressed={outputPreset === 'custom'}>{t(lang, 'prompt.outputCustom')}</button
          >
          {#if outputPreset === 'custom'}
            <input
              type="number"
              class="prompt__output-custom-input"
              min={MIN_OUTPUT_TOKENS}
              max={MAX_OUTPUT_TOKENS}
              value={expectedOutputTokens}
              oninput={handleCustomOutputInput}
              aria-label={t(lang, 'prompt.outputCustom')}
            />
          {/if}
        </div>
      </div>
    </div>
  </div>

  <!-- ═══ Caching Cost Panel ════════════════════════════════════════════════ -->
  <div class="prompt__caching">
    <div class="prompt__caching-head">
      <span class="prompt__stat-label">{t(lang, 'prompt.caching')}</span>
      {#if !selectedModel.supportsCaching}
        <span class="prompt__caching-unsupported">{t(lang, 'prompt.cacheUnsupported')}</span>
      {/if}
      {#if selectedModel.batchDiscount}
        <label class="prompt__batch-toggle">
          <input type="checkbox" bind:checked={batchMode} />
          {t(lang, 'prompt.batchToggle').replace('{api}', batchApiName)}
        </label>
      {/if}
    </div>
    {#if selectedModel.supportsCaching}
      <div class="prompt__caching-stats">
        <div class="prompt__stat">
          <span class="prompt__stat-label" title={t(lang, 'prompt.firstCallHint')}
            >{t(lang, 'prompt.firstCall')}</span
          >
          <span class="prompt__stat-value font-mono">{formatUsd(cachedCost.firstCall)}</span>
        </div>
        <div class="prompt__stat">
          <span class="prompt__stat-label" title={t(lang, 'prompt.cachedCallHint')}
            >{t(lang, 'prompt.cachedCall')}</span
          >
          <span class="prompt__stat-value font-mono prompt__caching-value--cheap"
            >{formatUsd(cachedCost.cachedCall)}</span
          >
        </div>
        <div class="prompt__stat">
          <span class="prompt__stat-label">{t(lang, 'prompt.cacheSavings')}</span>
          <span class="prompt__stat-value font-mono prompt__caching-savings">
            {t(lang, 'prompt.cacheSavingsValue').replace('{pct}', cachedCost.savingsPct.toFixed(0))}
          </span>
        </div>
      </div>
      {#if cacheEligibility.belowFloorTokens > 0}
        <p class="prompt__caching-note" role="note">
          {t(lang, 'prompt.cacheBelowFloorSummary')
            .replace('{tokens}', cacheEligibility.belowFloorTokens.toLocaleString())
            .replace('{min}', selectedModel.minCacheTokens.toLocaleString())}
        </p>
      {/if}
      {#if cacheEligibility.exceedsBreakpointLimit}
        <p class="prompt__caching-warning" role="alert">
          ⚠ {t(lang, 'prompt.cacheBreakpointWarning').replace(
            '{count}',
            String(cacheEligibility.eligibleBlockCount)
          )}
        </p>
      {/if}
      <!-- Item 1c: honest note on whether the savings above are realizable
           via the export as-is. Anthropic's export embeds real cache_control
           markers (see exportAsAnthropicMessages); every other caching
           provider here applies its own automatic prefix caching server-side,
           so no export marker is needed for those savings to apply. -->
      <p class="prompt__caching-note" role="note">
        {selectedModel.provider === 'anthropic'
          ? t(lang, 'prompt.cacheExportNoteAnthropic')
          : t(lang, 'prompt.cacheExportNoteAutomatic')}
      </p>
    {/if}
  </div>

  <div class="prompt__tabs">
    <button
      class="prompt__tab"
      class:active={activeTab === 'build'}
      aria-pressed={activeTab === 'build'}
      onclick={() => (activeTab = 'build')}
      type="button"
    >
      {t(lang, 'prompt.tabBuild')}
    </button>
    <button
      class="prompt__tab"
      class:active={activeTab === 'generate'}
      aria-pressed={activeTab === 'generate'}
      onclick={() => (activeTab = 'generate')}
      type="button"
    >
      {t(lang, 'prompt.tabGenerate')}
    </button>
  </div>

  {#if activeTab === 'build'}
    <!-- ═══ Toolbar ══════════════════════════════════════════════════════════ -->
    <div class="prompt__toolbar">
      <TemplateSelector {lang} onSelect={loadTemplate} />
      <button
        class="prompt__toolbar-btn prompt__toolbar-btn--danger"
        onclick={requestClearAll}
        title={t(lang, 'prompt.clearAll')}
        aria-label={t(lang, 'prompt.clearAll')}
      >
        ⊘ {t(lang, 'prompt.clearAll')}
      </button>
      <div class="prompt__count-toggle" role="group" aria-label={t(lang, 'prompt.countMode')}>
        <span class="prompt__count-toggle-label">{t(lang, 'prompt.countMode')}:</span>
        <button
          type="button"
          class="prompt__count-toggle-btn"
          class:active={countMode === 'template'}
          onclick={() => (countMode = 'template')}
          aria-pressed={countMode === 'template'}
          title={t(lang, 'prompt.countTemplateHint')}>{t(lang, 'prompt.countTemplate')}</button
        >
        <button
          type="button"
          class="prompt__count-toggle-btn"
          class:active={countMode === 'resolved'}
          onclick={() => (countMode = 'resolved')}
          aria-pressed={countMode === 'resolved'}
          title={t(lang, 'prompt.countResolvedHint')}>{t(lang, 'prompt.countResolved')}</button
        >
      </div>
      {#if detectedVars.length > 0}
        <button
          class="prompt__toolbar-btn prompt__variables-toggle-btn"
          onclick={() => (showVariablesDrawer = !showVariablesDrawer)}
          title={t(lang, 'prompt.variables')}
          aria-label={t(lang, 'prompt.variables')}
        >
          🎛 {t(lang, 'prompt.variables')} ({detectedVars.length})
        </button>
      {/if}
    </div>

    <!-- ═══ Variable Panel ════════════════════════════════════════════════════ -->
    <VariablePanel
      {lang}
      variables={detectedVars}
      values={variableValues}
      {previewActive}
      isDrawerOpen={showVariablesDrawer}
      onCloseDrawer={() => (showVariablesDrawer = false)}
      onValuesChange={(v) => (variableValues = v)}
      onPreview={() => (previewActive = !previewActive)}
    />

    <!-- ═══ Preview Banner ════════════════════════════════════════════════════ -->
    {#if previewActive}
      <div class="prompt__preview-banner" role="status" aria-live="polite">
        <span>◉ {t(lang, 'prompt.previewMode')}</span>
        <button
          class="preview-close-btn"
          onclick={() => (previewActive = false)}
          aria-label={t(lang, 'prompt.editMode')}
        >
          ✎ {t(lang, 'prompt.editMode')}
        </button>
      </div>
    {/if}

    <!-- ═══ Blocks ════════════════════════════════════════════════════════════ -->
    <div class="prompt__blocks" role="list" aria-label={t(lang, 'prompt.blocksListLabel')}>
      {#each blocks as block, i (block.id)}
        <div
          class="prompt-block-wrapper"
          class:drag-over-wrapper={dragOverIndex === i &&
            dragSourceIndex !== null &&
            dragSourceIndex !== i}
          role="listitem"
        >
          {#if previewActive}
            <!-- Preview mode: show rendered content -->
            <div class="prompt-block prompt-block--{block.role} prompt-block--preview">
              <div class="prompt-block__header">
                <span
                  class="prompt-block__role-select prompt-block__{block.role}-label"
                  style="font-family:var(--font-mono);font-size:var(--text-sm);text-transform:uppercase;"
                  >{t(lang, 'prompt.' + block.role)}</span
                >
                <span
                  class="prompt-block__tokens"
                  style="font-family:var(--font-mono);font-size:var(--text-xs);color:var(--text-muted);"
                >
                  {block.tokens.toLocaleString()}
                  {t(lang, 'prompt.tokens')}
                </span>
              </div>
              <div class="prompt-block__content" style="padding:var(--space-4);">
                <p class="prompt-block__preview-text">{getDisplayContent(block)}</p>
              </div>
            </div>
          {:else}
            <PromptBlockComponent
              {lang}
              {block}
              {totalTokens}
              modelContextWindow={selectedModel.contextWindow}
              modelMinCacheTokens={selectedModel.minCacheTokens}
              index={i}
              isFirst={i === 0}
              isLast={i === blocks.length - 1}
              {isMobile}
              onUpdate={(patch) => updateBlock(block.id, patch)}
              onRemove={() => removeBlock(block.id)}
              onDuplicate={() => duplicateBlock(block.id)}
              onMoveUp={() => moveBlock(block.id, 'up')}
              onMoveDown={() => moveBlock(block.id, 'down')}
              onDragStart={(e) => handleDragStart(i, e)}
              onDragOver={(e) => handleDragOver(i, e)}
              onDragDrop={(e) => handleDrop(i, e)}
              onDragEnd={(e) => handleDragEnd(e)}
            />
          {/if}
        </div>
      {/each}
    </div>

    <!-- ═══ Add Block ═════════════════════════════════════════════════════════ -->
    <div class="prompt__actions">
      <button
        bind:this={addBlockBtnEl}
        class="prompt__add-btn"
        onclick={addBlock}
        aria-label={t(lang, 'prompt.addBlock')}
      >
        + {t(lang, 'prompt.addBlock')}
      </button>
    </div>

    <!-- ═══ Footer / Export ══════════════════════════════════════════════════ -->
    <div class="prompt__footer">
      <div class="prompt__stat">
        <span class="prompt__stat-label">{t(lang, 'prompt.export')}</span>
      </div>
      <div class="prompt__export-group">
        <button
          class="prompt__export-btn"
          class:active={exportFormat === 'anthropic'}
          aria-pressed={exportFormat === 'anthropic'}
          onclick={() => handleExportFormat('anthropic')}
          >{t(lang, 'prompt.exportAnthropic')}</button
        >
        <button
          class="prompt__export-btn"
          class:active={exportFormat === 'openai-chat'}
          aria-pressed={exportFormat === 'openai-chat'}
          onclick={() => handleExportFormat('openai-chat')}
          >{t(lang, 'prompt.exportOpenaiChat')}</button
        >
        <button
          class="prompt__export-btn"
          class:active={exportFormat === 'openai-responses'}
          aria-pressed={exportFormat === 'openai-responses'}
          onclick={() => handleExportFormat('openai-responses')}
          >{t(lang, 'prompt.exportOpenaiResponses')}</button
        >
        <button
          class="prompt__export-btn"
          class:active={exportFormat === 'plain'}
          aria-pressed={exportFormat === 'plain'}
          title={t(lang, 'prompt.exportPlainHint')}
          onclick={() => handleExportFormat('plain')}>{t(lang, 'prompt.exportPlain')}</button
        >
        <button
          class="prompt__export-btn prompt__export-btn--copy"
          title={t(lang, exportFormatLabelKey)}
          onclick={handleCopyAll}
        >
          {copySuccess ? '✓ ' + t(lang, 'prompt.copied') : '⎘ ' + t(lang, 'prompt.copyAll')}
        </button>
      </div>
      {#if anthropicRoleWarning}
        <p class="prompt__export-warning" role="alert">
          ⚠ {t(lang, 'prompt.exportAnthropicRoleWarning')}
        </p>
      {/if}
    </div>
  {:else}
    <MetaPromptGenerator
      {lang}
      onGenerated={(newBlocks) => {
        blocks = newBlocks.map((b) => {
          const role = b.role as BlockRole;
          return {
            id: crypto.randomUUID(),
            role,
            content: b.content,
            tokens: 0,
            collapsed: false,
            cacheable: defaultCacheableForRole(role),
          };
        });
        activeTab = 'build';
      }}
    />
  {/if}

  <!-- ═══ Clear All Confirm Modal ══════════════════════════════════════════ -->
  {#if showClearConfirm}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="prompt__overlay" onclick={cancelClearAll} role="presentation">
      <div
        class="prompt__confirm-modal glass-panel"
        onclick={(e) => e.stopPropagation()}
        onkeydown={handleClearDialogKeydown}
        use:focusOnMount
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
      >
        <p id="confirm-title" class="confirm-title">{t(lang, 'prompt.clearConfirm')}</p>
        <p class="confirm-body">{t(lang, 'prompt.clearAllBody')}</p>
        <div class="confirm-actions">
          <button class="confirm-btn confirm-btn--cancel" onclick={cancelClearAll}
            >{t(lang, 'prompt.cancel')}</button
          >
          <button class="confirm-btn confirm-btn--danger" onclick={confirmClearAll}
            >{t(lang, 'prompt.clearAll')}</button
          >
        </div>
      </div>
    </div>
  {/if}
</div>

<style>
  /* ─── Toolbar ─────────────────────────────────────────────────────────── */
  .prompt__toolbar {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    flex-wrap: wrap;
    position: relative;
    z-index: 10;
  }

  .prompt__toolbar-btn {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    background: transparent;
    border: 1px solid var(--border-subtle);
    color: var(--text-muted);
    padding: var(--space-2) var(--space-4);
    border-radius: var(--radius-sm);
    font-size: var(--text-xs);
    font-family: var(--font-mono);
    text-transform: uppercase;
    letter-spacing: var(--tracking-wide);
    cursor: pointer;
    transition: var(--transition-all);
    white-space: nowrap;
  }

  .prompt__toolbar-btn--danger:hover {
    border-color: var(--color-error);
    /* --color-error is 4.38:1 on --bg-obsidian (< AA for this text-xs label). */
    color: hsl(0, 70%, 68%);
    background: hsla(0, 70%, 55%, 0.06);
  }

  .prompt__variables-toggle-btn {
    display: none;
  }

  /* ─── Count mode toggle ───────────────────────────────────────────────── */
  .prompt__count-toggle {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    margin-left: auto;
  }

  .prompt__count-toggle-label {
    font-size: var(--text-xs);
    font-family: var(--font-mono);
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: var(--tracking-wide);
    white-space: nowrap;
  }

  .prompt__count-toggle-btn {
    background: transparent;
    border: 1px solid var(--border-subtle);
    color: var(--text-muted);
    padding: var(--space-1) var(--space-3);
    border-radius: var(--radius-sm);
    font-size: var(--text-xs);
    font-family: var(--font-mono);
    text-transform: uppercase;
    letter-spacing: var(--tracking-wide);
    cursor: pointer;
    transition: var(--transition-all);
    white-space: nowrap;
  }

  .prompt__count-toggle-btn:hover:not(.active) {
    border-color: var(--text-muted);
    color: var(--text-secondary);
  }

  .prompt__count-toggle-btn.active {
    background: hsla(155, 70%, 50%, 0.12);
    border-color: var(--accent-green-400);
    color: var(--accent-green-300);
  }

  @media (min-width: 768px) and (max-width: 1024px) {
    .prompt__variables-toggle-btn {
      display: inline-flex;
      border-color: var(--accent-green-300);
      color: var(--accent-green-300);
      background: hsla(155, 70%, 50%, 0.05);
    }
  }

  /* ─── Expected output-length toggle ────────────────────────────────────── */
  .prompt__output-toggle {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    flex-wrap: wrap;
  }

  .prompt__output-toggle-btn {
    background: transparent;
    border: 1px solid var(--border-subtle);
    color: var(--text-muted);
    padding: var(--space-1) var(--space-3);
    border-radius: var(--radius-sm);
    font-size: var(--text-xs);
    font-family: var(--font-mono);
    text-transform: uppercase;
    letter-spacing: var(--tracking-wide);
    cursor: pointer;
    transition: var(--transition-all);
    white-space: nowrap;
  }

  .prompt__output-toggle-btn:hover:not(.active) {
    border-color: var(--text-muted);
    color: var(--text-secondary);
  }

  .prompt__output-toggle-btn.active {
    background: hsla(155, 70%, 50%, 0.12);
    border-color: var(--accent-green-400);
    color: var(--accent-green-300);
  }

  .prompt__output-custom-input {
    width: 5.5em;
    background: var(--bg-void);
    color: var(--text-primary);
    border: 1px solid var(--border-default);
    padding: var(--space-1) var(--space-2);
    border-radius: var(--radius-sm);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    outline: none;
    transition: var(--transition-all);
  }

  .prompt__output-custom-input:focus {
    border-color: var(--accent-green-300);
  }

  @media (max-width: 767px) {
    /* Prevent iOS Safari auto-zoom on focus (requires >=16px font-size) */
    .prompt__output-custom-input {
      font-size: 16px;
    }
  }

  /* ─── Preview Banner ──────────────────────────────────────────────────── */
  .prompt__preview-banner {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--space-2) var(--space-4);
    background: hsla(190, 80%, 50%, 0.08);
    border: 1px solid hsla(190, 80%, 50%, 0.25);
    border-radius: var(--radius-sm);
    font-size: var(--text-xs);
    font-family: var(--font-mono);
    color: hsl(190, 80%, 65%);
    text-transform: uppercase;
    letter-spacing: var(--tracking-wide);
  }

  .preview-close-btn {
    background: transparent;
    border: 1px solid hsla(190, 80%, 50%, 0.3);
    color: hsl(190, 80%, 65%);
    padding: 2px var(--space-3);
    border-radius: var(--radius-sm);
    font-size: var(--text-xs);
    font-family: var(--font-mono);
    cursor: pointer;
    transition: var(--transition-all);
  }

  .preview-close-btn:hover {
    background: hsla(190, 80%, 50%, 0.15);
  }

  /* ─── Drag-over wrapper indicator ─────────────────────────────────────── */
  .drag-over-wrapper {
    outline: 2px dashed var(--accent-green-300);
    outline-offset: 4px;
    border-radius: var(--radius-lg);
  }

  /* ─── Preview block text ──────────────────────────────────────────────── */
  .prompt-block--preview {
    opacity: 0.95;
  }

  .prompt-block__preview-text {
    font-family: var(--font-sans);
    font-size: var(--text-base);
    line-height: var(--leading-relaxed);
    color: var(--text-secondary);
    white-space: pre-wrap;
    margin: 0;
  }

  /* ─── Cost dim ────────────────────────────────────────────────────────── */
  .prompt__stat-dim {
    color: var(--text-muted);
    font-size: var(--text-xs);
  }

  /* ─── Budget label row ─────────────────────────────────────────────────── */
  /* `justify-content: space-between` alone only separates the label/value
   * when the row has slack to distribute — inside `.prompt__budget`'s
   * `max-width: 300px` it can shrink to content width, at which point the
   * two spans butt up against each other ("BUDGET0.0%"). An explicit `gap`
   * guarantees a minimum separation regardless of available width. */
  .prompt__budget-label-row {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: var(--space-3);
  }

  .prompt__budget-value {
    white-space: nowrap;
    flex-shrink: 0;
  }

  /* ─── Budget bar colors ────────────────────────────────────────────────── */
  :global(.prompt__budget--warn) {
    color: var(--color-warning) !important;
  }
  :global(.prompt__budget--danger) {
    color: var(--color-error) !important;
  }
  :global(.prompt__budget-bar--warn) {
    background: var(--color-warning) !important;
  }
  :global(.prompt__budget-bar--danger) {
    background: var(--color-error) !important;
  }

  /* ─── Token-count error (recompute failed; last-known counts stay shown) ── */
  .prompt__budget-error {
    margin-top: var(--space-1);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--color-error);
  }

  /* ─── Copy button ─────────────────────────────────────────────────────── */
  .prompt__export-btn--copy {
    background: hsla(155, 70%, 50%, 0.08);
    border-color: var(--accent-green-400);
    color: var(--accent-green-300);
  }

  .prompt__export-btn--copy:hover {
    background: hsla(155, 70%, 50%, 0.15);
    box-shadow: var(--glow-green);
  }

  /* ─── Overlay / Modal ─────────────────────────────────────────────────── */
  .prompt__overlay {
    position: fixed;
    inset: 0;
    background: hsla(220, 20%, 3%, 0.7);
    backdrop-filter: blur(4px);
    z-index: 999;
    display: flex;
    align-items: center;
    justify-content: center;
    animation: overlay-in 200ms ease both;
  }

  /* Standard property restated where a CSS minifier cannot fold it into
     the -webkit- alias — without this Firefox renders it flat. */
  @supports (backdrop-filter: blur(1px)) {
    .prompt__overlay {
      backdrop-filter: blur(4px);
    }
  }

  @keyframes overlay-in {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .prompt__overlay {
      animation: none;
    }
  }

  .prompt__confirm-modal {
    padding: var(--space-8);
    max-width: 360px;
    width: 90%;
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    animation: modal-in 250ms var(--ease-spring, cubic-bezier(0.34, 1.56, 0.64, 1)) both;
  }

  @keyframes modal-in {
    from {
      opacity: 0;
      transform: scale(0.92) translateY(12px);
    }
    to {
      opacity: 1;
      transform: scale(1) translateY(0);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .prompt__confirm-modal {
      animation: none;
    }
  }

  .confirm-title {
    font-size: var(--text-h4);
    font-weight: var(--weight-semibold);
    color: var(--text-primary);
    margin: 0;
  }

  .confirm-body {
    font-size: var(--text-sm);
    color: var(--text-muted);
    margin: 0;
    line-height: var(--leading-normal);
  }

  .confirm-actions {
    display: flex;
    gap: var(--space-3);
    justify-content: flex-end;
  }

  .confirm-btn {
    padding: var(--space-2) var(--space-5);
    border-radius: var(--radius-sm);
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    cursor: pointer;
    transition: var(--transition-all);
  }

  .confirm-btn--cancel {
    background: transparent;
    border: 1px solid var(--border-default);
    color: var(--text-secondary);
  }

  .confirm-btn--cancel:hover {
    border-color: var(--text-muted);
    color: var(--text-primary);
  }

  .confirm-btn--danger {
    /* White-on-(--color-error) is 4.40:1 (< AA). The darker red (the existing
       :hover value) is 5.29:1 with white; use it at rest too. */
    background: hsl(0, 70%, 48%);
    border: 1px solid hsl(0, 70%, 48%);
    color: white;
  }

  .confirm-btn--danger:hover {
    background: hsl(0, 70%, 48%);
    box-shadow: 0 0 16px hsla(0, 70%, 55%, 0.3);
  }
</style>
