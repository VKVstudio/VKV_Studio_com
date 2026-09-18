<script lang="ts">
  import { t } from '../../../i18n/utils';

  let {
    lang = 'en',
    variables = [],
    values = {},
    onValuesChange,
    onPreview,
    previewActive = false,
    isDrawerOpen = false,
    onCloseDrawer = () => {},
  } = $props<{
    lang?: 'en' | 'ru';
    variables: string[];
    values: Record<string, string>;
    onValuesChange: (values: Record<string, string>) => void;
    onPreview: () => void;
    previewActive?: boolean;
    isDrawerOpen?: boolean;
    onCloseDrawer?: () => void;
  }>();

  function handleInput(name: string, val: string) {
    onValuesChange({ ...values, [name]: val });
  }

  function handleClear() {
    onValuesChange({});
  }
</script>

{#if variables.length > 0}
<!-- Backdrop overlay (only visible on tablet, controlled via CSS) -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
{#if isDrawerOpen}
  <div class="var-drawer-backdrop" onclick={onCloseDrawer}></div>
{/if}

<div
  class="var-panel glass-panel"
  class:var-panel--drawer-open={isDrawerOpen}
  role="complementary"
  aria-label={t(lang, 'prompt.variables')}
>
  <div class="var-panel__header">
    <span class="var-panel__title">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
        <path d="M8 3H5a2 2 0 0 0-2 2v14c0 1.1.9 2 2 2h3M16 3h3a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-3M12 8v8M9 11l3-3 3 3"/>
      </svg>
      {t(lang, 'prompt.variables')}
      <span class="var-count">{variables.length}</span>
    </span>
    <div class="var-panel__actions">
      <button
        class="var-action-btn"
        class:var-action-btn--active={previewActive}
        onclick={onPreview}
        title={previewActive ? t(lang, 'prompt.editMode') : t(lang, 'prompt.previewMode')}
        aria-pressed={previewActive}
      >
        {previewActive ? '✎ ' + t(lang, 'prompt.editMode') : '◉ ' + t(lang, 'prompt.previewMode')}
      </button>
      <button
        class="var-action-btn var-action-btn--ghost"
        onclick={handleClear}
        title={t(lang, 'prompt.clearVars')}
        aria-label={t(lang, 'prompt.clearVars')}
      >✕</button>
      
      <!-- Close drawer button (tablet only, hidden by default) -->
      <button
        class="var-action-btn var-action-btn--close-drawer"
        onclick={onCloseDrawer}
        title={t(lang, 'prompt.collapse')}
        aria-label={t(lang, 'prompt.collapse')}
      >✕</button>
    </div>
  </div>

  <div class="var-panel__grid">
    {#each variables as name (name)}
      <div class="var-item">
        <label class="var-item__label" for="var-{name}">
          <span class="var-item__tag">{'{{' + name + '}}'}</span>
        </label>
        <input
          id="var-{name}"
          type="text"
          class="var-item__input"
          placeholder={name}
          value={values[name] ?? ''}
          oninput={(e) => handleInput(name, (e.target as HTMLInputElement).value)}
          aria-label="{t(lang, 'prompt.valueFor')} {name}"
        />
      </div>
    {/each}
  </div>
</div>
{/if}

<style>
  .var-panel {
    padding: var(--space-4) var(--space-5);
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    animation: var-panel-in 300ms var(--ease-out, cubic-bezier(0.16,1,0.3,1)) both;
  }

  @keyframes var-panel-in {
    from { opacity: 0; transform: translateY(-8px); }
    to   { opacity: 1; transform: translateY(0); }
  }

  @media (prefers-reduced-motion: reduce) {
    .var-panel { animation: none; }
  }

  .var-panel__header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
  }

  .var-panel__title {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: var(--tracking-wide);
  }

  .var-count {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    background: hsla(190, 80%, 50%, 0.15);
    border: 1px solid hsla(190, 80%, 50%, 0.3);
    border-radius: var(--radius-full);
    font-size: 10px;
    color: hsl(190, 80%, 65%);
  }

  .var-panel__actions {
    display: flex;
    gap: var(--space-2);
  }

  .var-action-btn {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    background: hsla(190, 80%, 50%, 0.08);
    border: 1px solid hsla(190, 80%, 50%, 0.25);
    color: hsl(190, 80%, 65%);
    padding: var(--space-1) var(--space-3);
    border-radius: var(--radius-sm);
    font-size: var(--text-xs);
    font-family: var(--font-mono);
    cursor: pointer;
    transition: var(--transition-all);
    text-transform: uppercase;
    letter-spacing: var(--tracking-wide);
  }

  .var-action-btn:hover {
    background: hsla(190, 80%, 50%, 0.15);
    border-color: hsl(190, 80%, 50%);
  }

  .var-action-btn--active {
    background: hsla(190, 80%, 50%, 0.2);
    border-color: hsl(190, 80%, 65%);
    color: hsl(190, 80%, 80%);
  }

  .var-action-btn--ghost {
    background: transparent;
    border-color: var(--border-subtle);
    color: var(--text-muted);
  }

  .var-action-btn--ghost:hover {
    border-color: var(--color-error);
    color: var(--color-error);
  }

  .var-panel__grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    gap: var(--space-3);
  }

  .var-item {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .var-item__label {
    display: block;
    cursor: pointer;
  }

  .var-item__tag {
    display: inline-block;
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: hsl(190, 80%, 65%);
    background: hsla(190, 80%, 50%, 0.12);
    border-radius: 4px;
    padding: 2px 6px;
    border: 1px solid hsla(190, 80%, 50%, 0.25);
  }

  .var-item__input {
    background: var(--bg-void);
    border: 1px solid var(--border-default);
    color: var(--text-primary);
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-sm);
    font-family: var(--font-sans);
    font-size: var(--text-sm);
    outline: none;
    transition: var(--transition-all);
    width: 100%;
  }

  .var-item__input:focus-visible {
    border-color: hsl(190, 80%, 50%);
    box-shadow: 0 0 0 3px hsla(190, 80%, 50%, 0.1);
  }

  .var-item__input::placeholder {
    color: var(--text-ghost);
  }

  .var-action-btn--close-drawer {
    display: none;
  }

  @media (max-width: 767px) {
    /* Prevent iOS Safari auto-zoom on focus (requires >=16px font-size) */
    .var-item__input {
      font-size: 16px;
    }
  }

  .var-drawer-backdrop {
    display: none;
  }

  @media (min-width: 768px) and (max-width: 1024px) {
    .var-panel {
      position: fixed;
      top: 0;
      right: 0;
      bottom: 0;
      width: 320px;
      z-index: 1000;
      background: var(--glass-bg, hsla(220, 20%, 10%, 0.95));
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      border-left: 1px solid var(--border-default);
      box-shadow: -10px 0 30px rgba(0, 0, 0, 0.5);
      transform: translateX(100%);
      transition: transform 0.3s cubic-bezier(0.16, 1, 0.3, 1);
      flex-direction: column;
      padding: var(--space-6) var(--space-5);
      margin: 0;
    }

    .var-panel--drawer-open {
      transform: translateX(0);
    }

    .var-panel__grid {
      grid-template-columns: 1fr;
      overflow-y: auto;
      flex: 1;
      padding-right: var(--space-1);
    }

    .var-action-btn--close-drawer {
      display: inline-flex;
    }

    .var-drawer-backdrop {
      display: block;
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.5);
      backdrop-filter: blur(4px);
      z-index: 999;
    }

    /* Standard property restated where a CSS minifier cannot fold it into
       the -webkit- alias — without this Firefox renders it flat. */
    @supports (backdrop-filter: blur(1px)) {
      .var-panel {
        backdrop-filter: blur(20px);
      }

      .var-drawer-backdrop {
        backdrop-filter: blur(4px);
      }
    }
  }
</style>
