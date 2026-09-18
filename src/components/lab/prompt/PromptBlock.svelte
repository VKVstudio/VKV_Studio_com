<script lang="ts">
  import { t } from '../../../i18n/utils';
  import { MAX_BLOCK_CONTENT_LENGTH, type PromptBlock } from '../../../lib/prompt/builder';

  let {
    lang = 'en',
    block,
    totalTokens = 0,
    modelContextWindow = 128000,
    modelMinCacheTokens = 1024,
    index = 0,
    isFirst = false,
    isLast = false,
    isMobile = false,
    onUpdate,
    onRemove,
    onDuplicate,
    onMoveUp,
    onMoveDown,
    onDragStart,
    onDragOver,
    onDragDrop,
    onDragEnd,
  } = $props<{
    lang?: 'en' | 'ru';
    block: PromptBlock;
    totalTokens?: number;
    modelContextWindow?: number;
    /** The selected model's minimum cacheable-prefix token floor (item 2) —
     *  used to gray this block's cache badge when it's marked cacheable but
     *  too small for the provider to actually cache. */
    modelMinCacheTokens?: number;
    index?: number;
    isFirst?: boolean;
    isLast?: boolean;
    isMobile?: boolean;
    onUpdate: (patch: Partial<PromptBlock>) => void;
    onRemove: () => void;
    onDuplicate: () => void;
    onMoveUp: () => void;
    onMoveDown: () => void;
    onDragStart: (e: DragEvent) => void;
    onDragOver: (e: DragEvent) => void;
    onDragDrop: (e: DragEvent) => void;
    onDragEnd: (e: DragEvent) => void;
  }>();

  let isDragOver = $state(false);
  let isCollapsed = $derived(block.collapsed);

  // ─── Content length cap ────────────────────────────────────────────────────
  // Blocks otherwise accept unbounded pasted content (50MB+ reproduced in live
  // testing), which lags the tokenizer/highlight-overlay/DnD. `maxlength` on
  // the textarea below enforces the hard cap; this hint only surfaces once the
  // user is close to it, so normal (short) prompts see nothing extra.
  const CHAR_LIMIT_WARN_RATIO = 0.9;
  let contentLength = $derived(block.content.length);
  let nearCharLimit = $derived(contentLength >= MAX_BLOCK_CONTENT_LENGTH * CHAR_LIMIT_WARN_RATIO);

  // Mini token bar: % of total tokens this block takes
  let blockPercent = $derived(
    totalTokens > 0 ? Math.min(100, (block.tokens / totalTokens) * 100) : 0
  );

  // Budget warning level based on this block's share of context window
  let budgetLevel = $derived(
    (() => {
      const pct = (block.tokens / modelContextWindow) * 100;
      if (pct > 60) return 'danger';
      if (pct > 30) return 'warn';
      return 'ok';
    })()
  );

  // Cache floor (item 2): a block the user marked cacheable but whose token
  // count is below the selected model's minCacheTokens would not actually be
  // cached by the provider — the pill still shows the user's intent but is
  // grayed with an honest tooltip instead of implying real savings.
  let belowCacheFloor = $derived(block.cacheable && block.tokens < modelMinCacheTokens);

  // Tool-definitions block (item 5): defensive JSON validity check, purely
  // for the UI hint below — the actual export parsing (builder.ts's
  // parseToolsBlocks) has its own independent try/catch and never depends on
  // this.
  let toolsJsonValid = $derived(
    block.role !== 'tools' || block.content.trim() === '' || isValidJson(block.content)
  );

  function isValidJson(text: string): boolean {
    try {
      JSON.parse(text);
      return true;
    } catch {
      return false;
    }
  }

  function handleDragOver(e: DragEvent) {
    e.preventDefault();
    isDragOver = true;
    onDragOver(e);
  }

  function handleDragLeave() {
    isDragOver = false;
  }

  function handleDrop(e: DragEvent) {
    isDragOver = false;
    onDragDrop(e);
  }

  // Highlight {{variable}} in textarea (done via overlay div)
  function highlightVariables(text: string): string {
    if (!text) return '<span class="pb-placeholder">...</span>';
    const escaped = text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\n/g, '<br>');
    const ob = '{' + '{';
    const cb = '}' + '}';
    return escaped.replace(
      /\{\{([a-zA-Z_][a-zA-Z0-9_]*)\}\}/g,
      (_match: string, name: string) => `<mark class="var-highlight">${ob}${name}${cb}</mark>`
    );
  }

  function handleHeaderClick(e: MouseEvent) {
    const target = e.target as HTMLElement;
    if (target.closest('button') || target.closest('select')) {
      return;
    }
    onUpdate({ collapsed: !block.collapsed });
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="prompt-block prompt-block--{block.role}"
  class:drag-over={isDragOver}
  class:collapsed={block.collapsed}
  draggable={!isMobile}
  ondragstart={onDragStart}
  ondragover={handleDragOver}
  ondragleave={handleDragLeave}
  ondrop={handleDrop}
  ondragend={onDragEnd}
  role="article"
  aria-label={`${t(lang, 'prompt.' + block.role)} ${t(lang, 'prompt.blockLabel')}`}
>
  <!-- Block Header -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div class="prompt-block__header" onclick={handleHeaderClick} style="cursor: pointer;">
    <!-- Drag Handle (desktop only) -->
    {#if !isMobile}
      <span class="pb-drag-handle" aria-hidden="true" title={t(lang, 'prompt.dragToReorder')}
        >⠿</span
      >
    {/if}

    <!-- Role Selector -->
    <select
      bind:value={block.role}
      onchange={(e) =>
        onUpdate({ role: (e.target as HTMLSelectElement).value as PromptBlock['role'] })}
      class="prompt-block__role-select prompt-block__{block.role}-label"
      aria-label={t(lang, 'prompt.roleSelectLabel')}
    >
      <option value="system">{t(lang, 'prompt.system')}</option>
      <option value="user">{t(lang, 'prompt.user')}</option>
      <option value="assistant">{t(lang, 'prompt.assistant')}</option>
      <option value="context">{t(lang, 'prompt.context')}</option>
      <option value="tools">{t(lang, 'prompt.tools')}</option>
    </select>

    <!-- Controls -->
    <div class="prompt-block__controls">
      <!-- Cacheable toggle -->
      <button
        type="button"
        class="pb-cache-pill"
        class:active={block.cacheable}
        class:pb-cache-pill--below-floor={belowCacheFloor}
        onclick={() => onUpdate({ cacheable: !block.cacheable })}
        title={belowCacheFloor
          ? t(lang, 'prompt.cacheBelowFloorHint').replace(
              '{min}',
              modelMinCacheTokens.toLocaleString()
            )
          : t(lang, 'prompt.cacheableHint')}
        aria-pressed={block.cacheable}
      >
        {block.cacheable ? '◈' : '◇'}
        {t(lang, 'prompt.cacheable')}
      </button>

      <!-- Token mini-bar -->
      <div
        class="pb-mini-bar"
        title="{block.tokens} {t(lang, 'prompt.tokens')} ({blockPercent.toFixed(1)}% of total)"
      >
        <div
          class="pb-mini-bar__fill pb-mini-bar--{budgetLevel}"
          style="width: {blockPercent}%"
        ></div>
        <span class="pb-mini-bar__label">{block.tokens.toLocaleString()}</span>
      </div>

      <!--
        Move buttons, on every viewport. These used to be `{#if isMobile}`,
        which made reordering drag-only above 767px — a hard WCAG 2.2 SC 2.5.7
        (Dragging Movements) failure on essentially every desktop, with no
        exception that applies: a keyboard, switch or motor-impaired user had
        no path at all to move a block. `isMobile` is a VIEWPORT query, not an
        input-modality one, so it could never have been the right gate for this
        — a 1440px window says nothing about whether the person at it can drag.
        Drag stays available for those who want it; this is the alternative
        route the success criterion requires, and it already worked.
      -->
      <button
        class="prompt-block__btn"
        onclick={onMoveUp}
        disabled={isFirst}
        title={t(lang, 'prompt.moveUp')}
        aria-label={t(lang, 'prompt.moveUp')}>↑</button
      >
      <button
        class="prompt-block__btn"
        onclick={onMoveDown}
        disabled={isLast}
        title={t(lang, 'prompt.moveDown')}
        aria-label={t(lang, 'prompt.moveDown')}>↓</button
      >

      <!-- Collapse -->
      <button
        class="prompt-block__btn"
        onclick={() => onUpdate({ collapsed: !block.collapsed })}
        title={block.collapsed ? t(lang, 'prompt.expand') : t(lang, 'prompt.collapse')}
        aria-label={block.collapsed ? t(lang, 'prompt.expand') : t(lang, 'prompt.collapse')}
        aria-expanded={!block.collapsed}
      >
        {block.collapsed ? '▼' : '▲'}
      </button>

      <!-- Duplicate -->
      <button
        class="prompt-block__btn"
        onclick={onDuplicate}
        title={t(lang, 'prompt.duplicate')}
        aria-label={t(lang, 'prompt.duplicate')}>⧉</button
      >

      <!-- Delete -->
      <button
        class="prompt-block__btn prompt-block__btn--delete"
        onclick={onRemove}
        title={t(lang, 'prompt.delete')}
        aria-label={t(lang, 'prompt.delete')}>✕</button
      >
    </div>
  </div>

  <!-- Collapsible Content -->
  <div class="prompt-block__body" class:prompt-block__body--collapsed={block.collapsed}>
    <div class="prompt-block__content">
      <!-- Variable-highlighted overlay -->
      <div class="pb-highlight-overlay" aria-hidden="true">
        {@html highlightVariables(block.content)}
      </div>

      <!-- Actual textarea -->
      <textarea
        class="prompt-block__textarea"
        bind:value={block.content}
        oninput={(e) => onUpdate({ content: (e.target as HTMLTextAreaElement).value })}
        placeholder={block.role === 'tools'
          ? t(lang, 'prompt.toolsPlaceholder')
          : t(lang, 'prompt.placeholder')}
        spellcheck="false"
        maxlength={MAX_BLOCK_CONTENT_LENGTH}
        aria-label={`${t(lang, 'prompt.' + block.role)} ${t(lang, 'prompt.contentLabel')}`}
      ></textarea>
    </div>
    {#if block.role === 'tools' && !toolsJsonValid}
      <div class="pb-json-invalid-hint" role="status">
        ⚠ {t(lang, 'prompt.toolsInvalidJson')}
      </div>
    {/if}
    {#if nearCharLimit}
      <div class="pb-char-limit-hint" role="status">
        {t(lang, 'prompt.charLimitHint')
          .replace('{count}', contentLength.toLocaleString())
          .replace('{max}', MAX_BLOCK_CONTENT_LENGTH.toLocaleString())}
      </div>
    {/if}
  </div>
</div>

<style>
  .prompt-block__body {
    display: grid;
    grid-template-rows: 1fr;
    transition:
      grid-template-rows 300ms var(--ease-out, cubic-bezier(0.16, 1, 0.3, 1)),
      opacity 250ms var(--ease-out, cubic-bezier(0.16, 1, 0.3, 1));
    overflow: hidden;
  }

  .prompt-block__body--collapsed {
    grid-template-rows: 0fr;
    opacity: 0;
  }

  @media (prefers-reduced-motion: reduce) {
    .prompt-block__body {
      transition: none;
    }
  }

  .prompt-block__content {
    position: relative;
    min-height: 0;
    overflow: hidden;
    padding: var(--space-4);
  }

  /* Drag handle */
  .pb-drag-handle {
    cursor: grab;
    color: var(--text-ghost);
    font-size: 1.1rem;
    padding: 0 var(--space-2);
    user-select: none;
    transition: color var(--duration-fast, 150ms);
  }

  .pb-drag-handle:hover {
    color: var(--text-muted);
  }

  .pb-drag-handle:active {
    cursor: grabbing;
  }

  /* DragOver drop zone highlight */
  :global(.drag-over) {
    border-color: var(--accent-green-300) !important;
    box-shadow: 0 0 0 2px var(--accent-glow, hsla(155, 70%, 50%, 0.15)) !important;
  }

  /* Dragging ghost: opacity applied inline by JS */

  /* Variable highlight overlay */
  .pb-highlight-overlay {
    position: absolute;
    inset: var(--space-4);
    pointer-events: none;
    font-family: var(--font-sans);
    font-size: var(--text-base);
    line-height: var(--leading-relaxed);
    white-space: pre-wrap;
    word-wrap: break-word;
    color: transparent;
    z-index: 1;
  }

  :global(.var-highlight) {
    background: hsla(190, 80%, 50%, 0.15);
    border-radius: 4px;
    color: transparent;
    outline: 1px solid hsla(190, 80%, 50%, 0.35);
  }

  .pb-placeholder {
    color: var(--text-ghost);
  }

  /* Character-limit hint, shown only once content nears the maxlength cap */
  .pb-char-limit-hint {
    position: relative;
    z-index: 2;
    margin: 0 var(--space-4) var(--space-3);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--color-warning);
  }

  /* Cacheable toggle pill */
  .pb-cache-pill {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    background: transparent;
    border: 1px solid var(--border-subtle);
    color: var(--text-muted);
    padding: 2px var(--space-2);
    border-radius: var(--radius-full);
    font-size: 10px;
    font-family: var(--font-mono);
    text-transform: uppercase;
    letter-spacing: var(--tracking-wide);
    cursor: pointer;
    transition: var(--transition-all);
    white-space: nowrap;
  }

  .pb-cache-pill:hover {
    border-color: var(--text-secondary);
    color: var(--text-secondary);
  }

  .pb-cache-pill.active {
    background: hsla(155, 70%, 50%, 0.12);
    border-color: var(--accent-green-400);
    color: var(--accent-green-300);
  }

  /* Cache floor (item 2): marked cacheable but below the model's
   * minCacheTokens — the provider would not actually cache this block, so
   * the pill stays visibly "on" (the user's intent) but grayed rather than
   * green, with an honest tooltip explaining why. Updated to --text-muted
   * (4.70:1 contrast ratio) to meet WCAG AA threshold of 4.5:1. */
  .pb-cache-pill--below-floor.active {
    background: transparent;
    border-color: var(--border-default);
    color: var(--text-muted);
  }

  /* Tool-definitions JSON validity hint */
  .pb-json-invalid-hint {
    position: relative;
    z-index: 2;
    margin: 0 var(--space-4) var(--space-3);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--color-warning);
  }

  /* Mini token bar */
  .pb-mini-bar {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--space-2);
    position: relative;
    width: 80px;
    height: 20px;
    background: var(--bg-void);
    border-radius: var(--radius-full);
    overflow: hidden;
    border: 1px solid var(--border-subtle);
  }

  .pb-mini-bar__fill {
    position: absolute;
    left: 0;
    top: 0;
    height: 100%;
    border-radius: var(--radius-full);
    transition: width var(--duration-normal, 250ms) var(--ease-out, ease);
  }

  .pb-mini-bar--ok {
    background: var(--accent-green-400);
  }
  .pb-mini-bar--warn {
    background: var(--color-warning);
  }
  .pb-mini-bar--danger {
    background: var(--color-error);
  }

  .pb-mini-bar__label {
    position: relative;
    z-index: 2;
    font-size: 10px;
    font-family: var(--font-mono);
    color: var(--text-primary);
    /* Solid dark pill so the digits always sit on --bg-void (well above AA
       with --text-primary) instead of on the variable green/amber/red fill,
       where white-on-amber fell to ~1.7:1. The coloured fill still shows
       around the pill, so the budget signal is preserved. */
    background: var(--bg-void);
    border-radius: var(--radius-full);
    text-align: center;
    line-height: 1;
    padding: 1px var(--space-2);
    white-space: nowrap;
  }

  /* Textarea stacking on top of highlight layer */
  .prompt-block__textarea {
    position: relative;
    z-index: 2;
    background: transparent;
    caret-color: var(--text-primary);
    color: var(--text-secondary);
  }

  .prompt-block__textarea:focus {
    color: var(--text-primary);
  }

  /* Hover glow per role */
  .prompt-block--system:hover {
    box-shadow: 0 0 16px hsla(190, 80%, 50%, 0.1);
  }
  .prompt-block--user:hover {
    box-shadow: 0 0 16px hsla(155, 70%, 50%, 0.1);
  }
  .prompt-block--assistant:hover {
    box-shadow: 0 0 16px hsla(270, 70%, 65%, 0.1);
  }
  .prompt-block--context:hover {
    box-shadow: 0 0 16px hsla(35, 90%, 55%, 0.1);
  }
  .prompt-block--tools:hover {
    box-shadow: 0 0 16px hsla(280, 65%, 60%, 0.1);
  }
</style>
