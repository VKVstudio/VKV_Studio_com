<script lang="ts">
  import { t } from '../../../i18n/utils';
  import { TEMPLATES, type TemplatePreset } from '../../../lib/prompt/builder';

  let {
    lang = 'en',
    onSelect,
  } = $props<{
    lang?: 'en' | 'ru';
    onSelect: (template: TemplatePreset) => void;
  }>();

  let isOpen = $state(false);
  let buttonRef: HTMLButtonElement | null = $state(null);
  let dropdownRef: HTMLDivElement | null = $state(null);

  function toggle() {
    isOpen = !isOpen;
  }

  function select(tpl: TemplatePreset) {
    onSelect(tpl);
    isOpen = false;
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') isOpen = false;
  }

  // Close on outside click
  function handleOutsideClick(e: MouseEvent) {
    if (!buttonRef || !dropdownRef) return;
    const target = e.target as Node;
    if (!buttonRef.contains(target) && !dropdownRef.contains(target)) {
      isOpen = false;
    }
  }

  $effect(() => {
    if (isOpen) {
      window.addEventListener('click', handleOutsideClick);
      window.addEventListener('keydown', handleKeydown);
    } else {
      window.removeEventListener('click', handleOutsideClick);
      window.removeEventListener('keydown', handleKeydown);
    }
    return () => {
      window.removeEventListener('click', handleOutsideClick);
      window.removeEventListener('keydown', handleKeydown);
    };
  });

  // Template icons
  const ICONS: Record<string, string> = {
    'chat-assistant': '💬',
    'code-review': '🔍',
    'translation': '🌐',
    'rag-pipeline': '🔗',
    'few-shot': '📚',
    'tool-use': '🛠',
    'custom': '✦',
  };
</script>

<div class="tpl-selector" role="none">
  <button
    bind:this={buttonRef}
    class="tpl-btn"
    class:tpl-btn--open={isOpen}
    onclick={toggle}
    aria-haspopup="listbox"
    aria-expanded={isOpen}
    aria-label={t(lang, 'prompt.templates')}
  >
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
      <rect x="3" y="3" width="7" height="7" rx="1"/>
      <rect x="14" y="3" width="7" height="7" rx="1"/>
      <rect x="3" y="14" width="7" height="7" rx="1"/>
      <rect x="14" y="14" width="7" height="7" rx="1"/>
    </svg>
    {t(lang, 'prompt.templates')}
    <span class="tpl-chevron" class:tpl-chevron--open={isOpen} aria-hidden="true">▾</span>
  </button>

  {#if isOpen}
    <div
      bind:this={dropdownRef}
      class="tpl-dropdown"
      role="listbox"
      aria-label={t(lang, 'prompt.templates')}
    >
      <div class="tpl-dropdown__header">
        <span class="tpl-dropdown__title">{t(lang, 'prompt.chooseTemplate')}</span>
      </div>
      {#each TEMPLATES as tpl (tpl.id)}
        <button
          class="tpl-item"
          onclick={() => select(tpl)}
          role="option"
          aria-selected="false"
          title={t(lang, 'prompt.template.' + tpl.id + '.desc')}
        >
          <span class="tpl-item__icon">{ICONS[tpl.id] ?? '◈'}</span>
          <span class="tpl-item__info">
            <span class="tpl-item__name">{t(lang, 'prompt.template.' + tpl.id + '.name')}</span>
            <span class="tpl-item__desc">{t(lang, 'prompt.template.' + tpl.id + '.desc')}</span>
          </span>
          <span class="tpl-item__count">{tpl.blocks.length} {tpl.blocks.length === 1 ? t(lang, 'prompt.block') : t(lang, 'prompt.blocks')}</span>
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .tpl-selector {
    position: relative;
  }

  .tpl-btn {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    background: var(--bg-void);
    border: 1px solid var(--border-default);
    color: var(--text-muted);
    padding: var(--space-2) var(--space-4);
    border-radius: var(--radius-sm);
    font-size: var(--text-sm);
    font-family: var(--font-mono);
    text-transform: uppercase;
    letter-spacing: var(--tracking-wide);
    cursor: pointer;
    transition: var(--transition-all);
    white-space: nowrap;
  }

  .tpl-btn:hover,
  .tpl-btn--open {
    border-color: var(--accent-green-300);
    color: var(--accent-green-300);
    background: hsla(155, 70%, 50%, 0.05);
  }

  .tpl-chevron {
    font-size: 0.7rem;
    transition: transform var(--duration-fast, 150ms) var(--ease-out, ease);
  }

  .tpl-chevron--open {
    transform: rotate(180deg);
  }

  .tpl-dropdown {
    position: absolute;
    top: calc(100% + var(--space-2));
    left: 0;
    z-index: 100;
    min-width: 280px;
    background: var(--glass-bg, hsla(220, 20%, 12%, 0.9));
    backdrop-filter: blur(var(--glass-blur, 20px));
    -webkit-backdrop-filter: blur(var(--glass-blur, 20px));
    border: 1px solid var(--glass-border, hsla(220, 20%, 30%, 0.3));
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-xl, 0 16px 64px hsla(0,0%,0%,0.6));
    overflow: hidden;
    animation: dropdown-in 200ms var(--ease-out, cubic-bezier(0.16,1,0.3,1)) both;
  }

  /* Standard property restated where a CSS minifier cannot fold it into
     the -webkit- alias — without this Firefox renders it flat. */
  @supports (backdrop-filter: blur(1px)) {
    .tpl-dropdown {
      backdrop-filter: blur(var(--glass-blur, 20px));
    }
  }

  @keyframes dropdown-in {
    from { opacity: 0; transform: translateY(-6px) scale(0.98); }
    to   { opacity: 1; transform: translateY(0) scale(1); }
  }

  @media (prefers-reduced-motion: reduce) {
    .tpl-dropdown { animation: none; }
  }

  .tpl-dropdown__header {
    padding: var(--space-3) var(--space-4);
    border-bottom: 1px solid var(--border-subtle);
  }

  .tpl-dropdown__title {
    font-size: var(--text-xs);
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: var(--tracking-wider);
    font-family: var(--font-mono);
  }

  .tpl-item {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    width: 100%;
    padding: var(--space-3) var(--space-4);
    background: transparent;
    border: none;
    border-bottom: 1px solid var(--border-subtle);
    color: var(--text-primary);
    cursor: pointer;
    text-align: left;
    transition: background var(--duration-fast, 150ms) var(--ease-out, ease);
  }

  .tpl-item:last-child {
    border-bottom: none;
  }

  .tpl-item:hover {
    background: hsla(155, 70%, 50%, 0.06);
  }

  .tpl-item:hover .tpl-item__name {
    color: var(--accent-green-300);
  }

  .tpl-item__icon {
    font-size: 1.1rem;
    flex-shrink: 0;
    width: 24px;
    text-align: center;
  }

  .tpl-item__info {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .tpl-item__name {
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    transition: color var(--duration-fast, 150ms);
  }

  .tpl-item__desc {
    font-size: var(--text-xs);
    color: var(--text-muted);
    line-height: 1.4;
  }

  .tpl-item__count {
    font-size: 10px;
    font-family: var(--font-mono);
    color: var(--text-ghost);
    background: var(--bg-void);
    padding: 2px 6px;
    border-radius: var(--radius-full);
    border: 1px solid var(--border-subtle);
    white-space: nowrap;
    flex-shrink: 0;
  }
</style>
