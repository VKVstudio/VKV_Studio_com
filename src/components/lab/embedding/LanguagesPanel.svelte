<script lang="ts">
  /**
   * LanguagesPanel.svelte
   * ───────────────────────────────────────────────────────────────────────
   * "Meaning survives translation" demo: embeds every EN/RU pair in
   * multilingual.ts's LANGUAGE_PAIRS in ONE batch call and shows each pair's
   * cross-language cosine similarity, sorted high to low, next to a
   * deliberately mismatched baseline (cat vs. собака — "dog") computed from
   * vectors already in that same batch — so the "translation beats a random
   * word" claim needs no extra, cherry-picked embed call.
   *
   * A free-input pair lets a visitor test their own words the same way —
   * honestly: whatever cosine score the model actually returns is what's
   * shown, no faked verdicts.
   *
   * Async pattern mirrors ChunkingPanel/RerankPanel: plain (non-`$state`)
   * request-id staleness guards for both the batch load and the free-input
   * compare; each does gets its own guard since they're independent async
   * flows. Every `$effect` below reads one set of state and writes only a
   * disjoint set — never the Svelte 5 read+write-same-`$state` trap.
   */
  import { t, type Lang } from '../../../i18n/utils';
  import { embed } from '../../../lib/embedding/engine';
  import { cosineSimilarity } from '../../../lib/embedding/search';
  import { LANGUAGE_PAIRS, type WordPair } from '../../../lib/embedding/multilingual';

  let {
    lang = 'en',
    /** Model id already serving the corpus, if any — reused so this batch
     * embed uses the exact same vector space as the rest of the Explorer. */
    modelId = null,
  }: { lang?: Lang; modelId?: string | null } = $props();

  interface PairResult extends WordPair {
    score: number;
  }

  let pairResults = $state<PairResult[]>([]);
  let baselineScore = $state<number | null>(null);
  let isLoadingPairs = $state(false);
  let pairsError = $state<string | null>(null);

  // Race-condition guard for the batch load — embed() calls the inference
  // server and has no AbortSignal wired up here, so staleness is checked by
  // request id instead (same intent as SearchPanel's).
  let latestBatchRequestId = 0;

  async function loadPairs(activeModelId: string, requestId: number): Promise<void> {
    isLoadingPairs = true;
    pairsError = null;
    try {
      const texts: string[] = [];
      for (const pair of LANGUAGE_PAIRS) {
        texts.push(pair.en, pair.ru);
      }
      const vectors = await embed(texts, undefined, activeModelId, 'document');
      if (requestId !== latestBatchRequestId) return;

      const results: PairResult[] = LANGUAGE_PAIRS.map((pair, i) => {
        const enVec = vectors[i * 2];
        const ruVec = vectors[i * 2 + 1];
        const score = enVec && ruVec ? cosineSimilarity(enVec, ruVec) : 0;
        return { en: pair.en, ru: pair.ru, emoji: pair.emoji, score };
      }).sort((a, b) => b.score - a.score);

      // Mismatched baseline — "cat" (EN) vs. "собака" ("dog", RU): looked up
      // by content rather than assuming LANGUAGE_PAIRS' array order, and both
      // vectors were already fetched in the batch above, so this costs
      // nothing extra and stays honest (no separate, cherry-picked call).
      const catIdx = LANGUAGE_PAIRS.findIndex((p) => p.en === 'cat');
      const dogIdx = LANGUAGE_PAIRS.findIndex((p) => p.en === 'dog');
      const catVec = catIdx >= 0 ? vectors[catIdx * 2] : undefined;
      const dogRuVec = dogIdx >= 0 ? vectors[dogIdx * 2 + 1] : undefined;
      baselineScore = catVec && dogRuVec ? cosineSimilarity(catVec, dogRuVec) : null;

      pairResults = results;
    } catch (err) {
      if (requestId !== latestBatchRequestId) return;
      console.warn('[embeddings] language-pairs batch failed:', err);
      pairsError = t(lang, 'embeddings.languagesErrorStatus');
      pairResults = [];
      baselineScore = null;
    } finally {
      if (requestId === latestBatchRequestId) isLoadingPairs = false;
    }
  }

  $effect(() => {
    const activeModelId = modelId;
    const requestId = ++latestBatchRequestId;
    if (!activeModelId) {
      isLoadingPairs = false;
      return;
    }
    void loadPairs(activeModelId, requestId);
  });

  let inputEn = $state('');
  let inputRu = $state('');
  let freeScore = $state<number | null>(null);
  let isComparingFree = $state(false);
  let freeError = $state<string | null>(null);

  // Independent request-id guard for the free-input compare — a separate
  // async flow from the batch load above, triggered only by the button click.
  let latestFreeRequestId = 0;

  async function compareFree(en: string, ru: string, activeModelId: string): Promise<void> {
    const requestId = ++latestFreeRequestId;
    isComparingFree = true;
    freeError = null;
    try {
      const [enVec, ruVec] = await embed([en, ru], undefined, activeModelId, 'document');
      if (requestId !== latestFreeRequestId) return;
      freeScore = enVec && ruVec ? cosineSimilarity(enVec, ruVec) : null;
    } catch (err) {
      if (requestId !== latestFreeRequestId) return;
      console.warn('[embeddings] free pair compare failed:', err);
      freeError = t(lang, 'embeddings.languagesFreeError');
      freeScore = null;
    } finally {
      if (requestId === latestFreeRequestId) isComparingFree = false;
    }
  }

  function handleCompareClick(): void {
    const en = inputEn.trim();
    const ru = inputRu.trim();
    if (!en || !ru || !modelId) return;
    void compareFree(en, ru, modelId);
  }

  /** Honest score-tier verdict — not a calibrated probability, just a plain-language read of the same cosine number shown next to it. */
  function verdictKey(score: number): string {
    if (score >= 0.75) return 'embeddings.languagesVerdictHigh';
    if (score >= 0.5) return 'embeddings.languagesVerdictMedium';
    return 'embeddings.languagesVerdictLow';
  }

  function scoreBarWidth(score: number): number {
    return Math.round(Math.max(0, Math.min(1, score)) * 100);
  }

  let compareDisabled = $derived(
    !modelId || !inputEn.trim() || !inputRu.trim() || isComparingFree
  );
</script>

<div class="languages-panel">
  <p class="languages-panel__intro">{t(lang, 'embeddings.languagesIntro')}</p>

  {#if isLoadingPairs}
    <div class="languages-panel__status">
      <span class="embeddings__micro-spinner" aria-hidden="true"></span>
      {t(lang, 'embeddings.languagesLoadingStatus')}
    </div>
  {:else if pairsError}
    <div class="languages-panel__status languages-panel__status--error" role="alert">
      ⚠️ {pairsError}
    </div>
  {:else if pairResults.length > 0}
    <ul class="languages-panel__list" aria-label={t(lang, 'embeddings.languagesPairsHeader')}>
      {#each pairResults as pair (pair.en + pair.ru)}
        <li class="languages-panel__row">
          <span class="languages-panel__emoji" aria-hidden="true">{pair.emoji ?? ''}</span>
          <span class="languages-panel__word languages-panel__word--en">{pair.en}</span>
          <span class="languages-panel__arrow" aria-hidden="true">↔</span>
          <span class="languages-panel__word languages-panel__word--ru">{pair.ru}</span>
          <span class="languages-panel__bar">
            <span
              class="languages-panel__bar-fill"
              style="width: {scoreBarWidth(pair.score)}%"
            ></span>
          </span>
          <span class="languages-panel__score">{pair.score.toFixed(2)}</span>
        </li>
      {/each}
    </ul>

    {#if baselineScore !== null}
      <div class="languages-panel__baseline">
        <p class="languages-panel__baseline-label">
          {t(lang, 'embeddings.languagesBaselineLabel')}
        </p>
        <div class="languages-panel__row languages-panel__row--baseline">
          <span class="languages-panel__emoji" aria-hidden="true">🚫</span>
          <span class="languages-panel__word languages-panel__word--en">cat</span>
          <span class="languages-panel__arrow" aria-hidden="true">↔</span>
          <span class="languages-panel__word languages-panel__word--ru">собака</span>
          <span class="languages-panel__bar">
            <span
              class="languages-panel__bar-fill languages-panel__bar-fill--baseline"
              style="width: {scoreBarWidth(baselineScore)}%"
            ></span>
          </span>
          <span class="languages-panel__score">{baselineScore.toFixed(2)}</span>
        </div>
        <p class="languages-panel__baseline-note">{t(lang, 'embeddings.languagesBaselineNote')}</p>
      </div>
    {/if}
  {/if}

  <div class="languages-panel__free">
    <h3 class="languages-panel__free-title">{t(lang, 'embeddings.languagesFreeTitle')}</h3>
    <div class="languages-panel__free-fields">
      <label class="languages-panel__field">
        <span class="embeddings__field-label">{t(lang, 'embeddings.languagesFreeEnLabel')}</span>
        <input
          type="text"
          class="languages-panel__input"
          bind:value={inputEn}
          placeholder={t(lang, 'embeddings.languagesFreeEnPlaceholder')}
          disabled={!modelId}
        />
      </label>
      <label class="languages-panel__field">
        <span class="embeddings__field-label">{t(lang, 'embeddings.languagesFreeRuLabel')}</span>
        <input
          type="text"
          class="languages-panel__input"
          bind:value={inputRu}
          placeholder={t(lang, 'embeddings.languagesFreeRuPlaceholder')}
          disabled={!modelId}
        />
      </label>
      <button
        type="button"
        class="languages-panel__button"
        onclick={handleCompareClick}
        disabled={compareDisabled}
      >
        {isComparingFree
          ? t(lang, 'embeddings.languagesFreeComparing')
          : t(lang, 'embeddings.languagesFreeButton')}
      </button>
    </div>

    {#if freeError}
      <p class="languages-panel__status languages-panel__status--error" role="alert">
        ⚠️ {freeError}
      </p>
    {:else if freeScore !== null}
      <div class="languages-panel__row" aria-live="polite">
        <span class="languages-panel__emoji" aria-hidden="true">🔎</span>
        <span class="languages-panel__word languages-panel__word--en">{inputEn}</span>
        <span class="languages-panel__arrow" aria-hidden="true">↔</span>
        <span class="languages-panel__word languages-panel__word--ru">{inputRu}</span>
        <span class="languages-panel__bar">
          <span
            class="languages-panel__bar-fill"
            style="width: {scoreBarWidth(freeScore)}%"
          ></span>
        </span>
        <span class="languages-panel__score">{freeScore.toFixed(2)}</span>
      </div>
      <p class="languages-panel__verdict">{t(lang, verdictKey(freeScore))}</p>
    {:else}
      <p class="languages-panel__empty-note">{t(lang, 'embeddings.languagesFreeEmptyNote')}</p>
    {/if}
  </div>
</div>
