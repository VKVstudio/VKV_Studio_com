<script lang="ts">
  /**
   * EmbeddingTabs.svelte
   * ───────────────────────────────────────────────────────────────────────
   * Mode switcher for the Embedding Explorer (Explore / Chunking / Retrieval).
   * A self-contained WAI-ARIA APG "automatic activation" tabs widget: arrow
   * keys move focus AND selection together, Home/End jump to the first/last
   * tab. Owns only the tab bar's own DOM/keyboard behavior — which panel is
   * actually shown lives in the parent (EmbeddingApp.svelte), reached via the
   * `onchange` callback, mirroring this codebase's props+callback convention
   * (see SearchPanel.svelte's `onResults`) rather than a bindable prop.
   */
  import { t, type Lang } from '../../../i18n/utils';
  import { TAB_IDS, type TabId } from './embeddingTabs';

  let {
    activeTab,
    lang = 'en',
    onchange,
  }: { activeTab: TabId; lang?: Lang; onchange: (id: TabId) => void } = $props();

  function focusTab(id: TabId): void {
    document.getElementById(`embeddings-tab-${id}`)?.focus();
  }

  function handleKeydown(e: KeyboardEvent, id: TabId): void {
    const idx = TAB_IDS.indexOf(id);
    let nextId: TabId | undefined;
    if (e.key === 'ArrowRight') nextId = TAB_IDS[(idx + 1) % TAB_IDS.length];
    else if (e.key === 'ArrowLeft') nextId = TAB_IDS[(idx - 1 + TAB_IDS.length) % TAB_IDS.length];
    else if (e.key === 'Home') nextId = TAB_IDS[0];
    else if (e.key === 'End') nextId = TAB_IDS[TAB_IDS.length - 1];
    if (!nextId) return;
    e.preventDefault();
    onchange(nextId);
    focusTab(nextId);
  }

  function labelKey(id: TabId): string {
    switch (id) {
      case 'explore':
        return 'embeddings.tabExplore';
      case 'languages':
        return 'embeddings.tabLanguages';
      case 'analogies':
        return 'embeddings.tabAnalogies';
      case 'chunking':
        return 'embeddings.tabChunking';
      case 'retrieval':
        return 'embeddings.tabRetrieval';
    }
  }
</script>

<div class="embeddings__tabs" role="tablist" aria-label={t(lang, 'embeddings.tabsLabel')}>
  {#each TAB_IDS as id (id)}
    <button
      id="embeddings-tab-{id}"
      class="embeddings__tab"
      class:active={activeTab === id}
      role="tab"
      type="button"
      aria-selected={activeTab === id}
      aria-controls={activeTab === id ? `embeddings-panel-${id}` : undefined}
      tabindex={activeTab === id ? 0 : -1}
      onclick={() => onchange(id)}
      onkeydown={(e) => handleKeydown(e, id)}
    >
      {t(lang, labelKey(id))}
    </button>
  {/each}
</div>
