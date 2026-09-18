<script lang="ts">
  /**
   * SearchPanel.svelte
   * ───────────────────────────────────────────────────────────────────────
   * Live semantic search over the already-embedded demo corpus: embeds the
   * query via the inference server, scores it against every corpus vector, and reports both
   * the full score array (for EmbeddingScene's similarity coloring) and the
   * top-k ranked hits (for the results list below) up to EmbeddingApp via
   * the `onResults` callback prop.
   */
  import { t, type Lang } from '../../../i18n/utils';
  import { embed } from '../../../lib/embedding/engine';
  import { cosineSimilarity, topK } from '../../../lib/embedding/search';
  import type { EmbeddingVector, SearchResult } from '../../../lib/embedding/types';

  /** How many top matches are shown in the results list AND highlighted in the 3D scene. */
  const RESULT_COUNT = 8;
  /** A short fixed debounce is enough to avoid sending a fresh embed request to the inference server on every keystroke. */
  const DEBOUNCE_MS = 300;
  /**
   * Below this cosine score, a result is "weak" — shown de-emphasized rather
   * than styled identically to a strong match. An out-of-domain query (e.g.
   * "the capital of France" against a RAG/embeddings corpus) still returns a
   * full ranked list — cosine similarity always returns SOME nearest
   * neighbors — but every score in it can be near-zero, which reads as a
   * confident match unless the UI says otherwise. 0.3 is a reasonable rule of
   * thumb for normalized sentence-embedding cosine similarity (not a
   * calibrated probability): most genuinely related passages score well
   * above it, off-topic queries typically fall well under it.
   */
  const LOW_RELEVANCE_THRESHOLD = 0.3;

  let {
    corpusVectors,
    corpusLabels,
    modelId,
    lang = 'en',
    onResults,
  }: {
    corpusVectors: EmbeddingVector[];
    corpusLabels: string[];
    /** The model id that ACTUALLY produced `corpusVectors` (may differ from the user's selection after a fallback) — the query must be embedded with this same model or the vector spaces won't line up. */
    modelId: string | null;
    lang?: Lang;
    onResults: (payload: {
      scores: number[] | null;
      highlighted: number[];
      results: SearchResult[];
      /** The raw query text that produced this result (empty string when cleared). */
      query: string;
    }) => void;
  } = $props();

  let query = $state('');
  let isSearching = $state(false);
  let results = $state<SearchResult[]>([]);
  /** Set only when embed() itself throws — kept distinct from "0 results",
   *  which is a legitimate search verdict, not a failure. */
  let searchError = $state<string | null>(null);

  let debounceTimer: ReturnType<typeof setTimeout>;
  // Race-condition guard: engine.ts's `embed()` calls the inference server
  // over plain fetch and doesn't accept an AbortSignal here, so the best
  // available guard is request-id staleness checking — same intent as the
  // tokenizer's controller pattern, just without anything to actually abort.
  let latestRequestId = 0;

  function emitEmpty(): void {
    results = [];
    onResults({ scores: null, highlighted: [], results: [], query: '' });
  }

  async function performSearch(
    q: string,
    vectors: EmbeddingVector[],
    activeModelId: string
  ): Promise<void> {
    const myRequestId = ++latestRequestId;
    searchError = null; // a new attempt is underway — any previous failure no longer applies
    try {
      const [queryVec] = await embed([q], undefined, activeModelId, 'query');
      if (myRequestId !== latestRequestId || !queryVec) return;

      // Full per-corpus-item similarity (drives the scene's continuous color
      // gradient) — separate from the ranked top-k below, which is the
      // "actual retrieval result" a RAG pipeline would act on.
      const scores = vectors.map((vec) => cosineSimilarity(queryVec, vec));
      const ranked = topK(queryVec, vectors, RESULT_COUNT);

      const hits: SearchResult[] = ranked.map((r) => ({
        chunkId: String(r.item),
        text: corpusLabels[r.item] ?? '',
        score: r.score,
        denseScore: r.score,
      }));

      isSearching = false;
      results = hits;
      onResults({ scores, highlighted: ranked.map((r) => r.item), results: hits, query: q });
    } catch (err) {
      if (myRequestId !== latestRequestId) return;
      console.warn('[embeddings] search failed:', err);
      isSearching = false;
      // Distinct from a genuine zero-match query: embed() never returned a
      // vector, so there's no honest verdict to show as "results" — emitEmpty()
      // clears the list/scene the same way a blank query would, and
      // searchError is what actually tells the visitor this was a failure.
      searchError = t(lang, 'embeddings.searchError');
      emitEmpty();
    }
  }

  $effect(() => {
    const q = query;
    const vectors = corpusVectors;
    const activeModelId = modelId;

    clearTimeout(debounceTimer);

    if (!q.trim() || vectors.length === 0 || !activeModelId) {
      latestRequestId++; // invalidate any in-flight search
      isSearching = false;
      searchError = null;
      emitEmpty();
      return;
    }

    isSearching = true;
    debounceTimer = setTimeout(() => {
      void performSearch(q, vectors, activeModelId);
    }, DEBOUNCE_MS);

    return () => clearTimeout(debounceTimer);
  });

  function handleKeydown(e: KeyboardEvent): void {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    clearTimeout(debounceTimer);
    if (!query.trim() || corpusVectors.length === 0 || !modelId) return;
    isSearching = true;
    void performSearch(query, corpusVectors, modelId);
  }

  function scoreBarWidth(score: number): number {
    return Math.round(Math.max(0, Math.min(1, score)) * 100);
  }

  function isLowScore(score: number): boolean {
    return score < LOW_RELEVANCE_THRESHOLD;
  }

  // Only the TOP result's score decides whether to show the "no strongly
  // relevant match" note — a single strong hit still means the query landed
  // somewhere in the corpus even if the rest of the top-k trails off.
  let topScore = $derived(results[0]?.score ?? null);
  let showLowRelevanceNotice = $derived(topScore !== null && isLowScore(topScore));
</script>

<div class="search-panel">
  <div class="search-panel__input-row">
    <input
      type="text"
      class="search-panel__input"
      bind:value={query}
      onkeydown={handleKeydown}
      placeholder={t(lang, 'embeddings.searchPlaceholder')}
      aria-label={t(lang, 'embeddings.searchLabel')}
      disabled={!modelId}
    />
    {#if isSearching}
      <span class="search-panel__spinner" aria-hidden="true"></span>
    {/if}
  </div>

  {#if query.trim()}
    <div class="search-panel__header">
      <span>{t(lang, 'embeddings.searchResultsHeader')}</span>
      <span class="search-panel__count">{results.length}</span>
    </div>
    {#if results.length > 0}
      <p class="search-panel__approx-note">{t(lang, 'embeddings.exactScoreNote')}</p>
      {#if showLowRelevanceNotice}
        <p class="search-panel__low-relevance-notice" role="status">
          {t(lang, 'embeddings.lowRelevanceNotice')}
        </p>
      {/if}
    {/if}
    <div class="search-panel__results" aria-live="polite">
      {#if results.length === 0}
        {#if isSearching}
          <div class="search-panel__empty">{t(lang, 'embeddings.searching')}</div>
        {:else if searchError}
          <div class="embeddings__status-banner embeddings__status-banner--error" role="alert">
            ⚠️ {searchError}
          </div>
        {:else}
          <div class="search-panel__empty">{t(lang, 'embeddings.noResultsFound')}</div>
        {/if}
      {:else}
        {#each results as hit (hit.chunkId)}
          <div
            class="search-panel__result"
            class:search-panel__result--low-relevance={isLowScore(hit.score)}
          >
            <p class="search-panel__result-text">{hit.text}</p>
            <div class="search-panel__result-score">
              <span>{t(lang, 'embeddings.similarityLabel')}: {hit.score.toFixed(3)}</span>
              <span class="search-panel__score-bar">
                <span
                  class="search-panel__score-bar-fill"
                  style="width: {scoreBarWidth(hit.score)}%"
                ></span>
              </span>
            </div>
          </div>
        {/each}
      {/if}
    </div>
  {:else}
    <div class="search-panel__empty">{t(lang, 'embeddings.noQueryPlaceholder')}</div>
  {/if}
</div>
