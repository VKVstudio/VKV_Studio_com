<script lang="ts">
  /**
   * ChunkingPanel.svelte
   * ───────────────────────────────────────────────────────────────────────
   * Chunking-strategy demo: runs the same sample document through
   * chunkFixed / chunkBySentence / chunkBySemantic (chunking.ts) and renders
   * the resulting chunks so the strategy's effect on retrieval-unit
   * boundaries is directly visible rather than just described.
   *
   * Mirrors SearchPanel.svelte's async conventions: a debounced, request-id-
   * guarded embed() call for the semantic strategy (same ~300ms debounce +
   * plain non-`$state` staleness-guard idiom as SearchPanel's query search —
   * the backend's rate limit is 60/min, so firing a fresh POST /api/embed on
   * every keystroke while typing the sample document was one keystroke away
   * from tripping it), and an `$effect` that reads text/strategy/knobs and
   * writes only `chunks`/`isEmbedding`/`chunkError` — it never reads back
   * what it just wrote, so there's no read+write-same-`$state` loop.
   */
  import { t, type Lang } from '../../../i18n/utils';
  import { embed, DEFAULT_EMBEDDING_MODEL_ID } from '../../../lib/embedding/engine';
  import { chunkFixed, chunkBySentence, chunkBySemantic } from '../../../lib/embedding/chunking';
  import type { Chunk } from '../../../lib/embedding/types';

  type Strategy = 'fixed' | 'sentence' | 'semantic';

  /**
   * Hard cap on the sample-document textarea. Semantic chunking sends every
   * sentence to the inference server in one embedding call (no AbortSignal
   * wired up here — see the race-guard note below), so without a ceiling a
   * huge paste means a very slow, unabortable network round trip.
   * `maxlength` on the textarea below enforces this at the input level
   * (including paste, per the HTML spec).
   */
  const DOC_MAX_LENGTH = 20000;

  /**
   * Independent of the character cap above: semantic chunking's cost scales
   * with SENTENCE count (one embedding call covers all of them, but the
   * sentence-similarity loop and the corpus of vectors held in memory both
   * grow linearly with it). Capping how many sentences actually get embedded
   * keeps the demo responsive even for a dense, punctuation-heavy paste that
   * still fits under `DOC_MAX_LENGTH` chars.
   */
  const SEMANTIC_SENTENCE_CAP = 200;

  /** Same debounce window as SearchPanel.svelte's query search — enough to
   *  avoid sending a fresh embed request to the inference server on every
   *  keystroke while editing the sample document under the semantic
   *  strategy. */
  const SEMANTIC_DEBOUNCE_MS = 300;

  let {
    lang = 'en',
    /** Model id already loaded for the corpus (if any) — reused here so the
     * semantic strategy doesn't trigger a second, redundant model download.
     * Falls back to the default model when the corpus hasn't finished
     * loading yet. */
    modelId = null,
  }: { lang?: Lang; modelId?: string | null } = $props();

  let docText = $state(t(lang, 'embeddings.chunkingSampleText'));
  let strategy = $state<Strategy>('fixed');
  let fixedSize = $state(220);
  let fixedOverlap = $state(40);
  let semanticThreshold = $state(0.55);

  let chunks = $state<Chunk[]>([]);
  let isEmbedding = $state(false);
  let chunkError = $state<string | null>(null);
  /** True when the last semantic-chunking run had to truncate to `SEMANTIC_SENTENCE_CAP` sentences. */
  let semanticTruncated = $state(false);

  // Race-condition guard for the async semantic strategy — same intent as
  // SearchPanel's request-id staleness check: the inference-server call
  // behind embed() has no AbortSignal wired up here, so staleness is
  // checked by request id instead.
  let latestRequestId = 0;
  // Debounce timer for the semantic strategy's embed() call — same idiom as
  // SearchPanel.svelte's `debounceTimer`.
  let debounceTimer: ReturnType<typeof setTimeout>;

  /** Cheap, model-free length estimate (~4 chars/token) — "token-ish", not exact. */
  function estimateTokens(text: string): number {
    return Math.max(1, Math.round(text.length / 4));
  }

  async function runSemantic(text: string, threshold: number, activeModelId: string): Promise<void> {
    // Incremented here (once the debounce delay has actually elapsed and
    // this run is starting), not by the caller — mirrors SearchPanel's
    // performSearch, so rapid keystrokes within the debounce window never
    // burn more than one request id each.
    const requestId = ++latestRequestId;
    isEmbedding = true;
    try {
      // Cap the number of sentences actually embedded — see
      // `SEMANTIC_SENTENCE_CAP`'s doc comment. `chunkBySentence` gives us
      // start/end offsets, so capping is just slicing the source text at the
      // Nth sentence's end and handing chunkBySemantic that shorter text (it
      // re-splits internally, but now over a bounded input).
      const allSentences = chunkBySentence(text);
      const truncated = allSentences.length > SEMANTIC_SENTENCE_CAP;
      const capSentence = allSentences[SEMANTIC_SENTENCE_CAP - 1];
      const cappedText = truncated && capSentence ? text.slice(0, capSentence.end) : text;

      const result = await chunkBySemantic(cappedText, (texts) => embed(texts, undefined, activeModelId), threshold);
      if (requestId !== latestRequestId) return;
      chunks = result;
      chunkError = null;
      semanticTruncated = truncated;
    } catch (err) {
      if (requestId !== latestRequestId) return;
      console.warn('[chunking] semantic chunking failed:', err);
      chunks = [];
      chunkError = t(lang, 'embeddings.chunkingError');
      semanticTruncated = false;
    } finally {
      if (requestId === latestRequestId) isEmbedding = false;
    }
  }

  $effect(() => {
    const text = docText;
    const strat = strategy;
    const size = fixedSize;
    const overlap = fixedOverlap;
    const threshold = semanticThreshold;
    const activeModelId = modelId ?? DEFAULT_EMBEDDING_MODEL_ID;

    clearTimeout(debounceTimer);

    if (!text.trim()) {
      latestRequestId++; // invalidate any in-flight semantic run
      chunks = [];
      isEmbedding = false;
      chunkError = null;
      semanticTruncated = false;
      return;
    }

    if (strat === 'semantic') {
      // Debounced (item 4): typing under the semantic strategy would
      // otherwise fire a fresh POST /api/embed per keystroke against the
      // inference server's 60/min rate limit. `isEmbedding` flips on
      // immediately (same as SearchPanel's `isSearching`) so the status line
      // reflects the pending request while the debounce timer is still
      // waiting, not just once the network call actually starts.
      isEmbedding = true;
      debounceTimer = setTimeout(() => {
        void runSemantic(text, threshold, activeModelId);
      }, SEMANTIC_DEBOUNCE_MS);
      return () => clearTimeout(debounceTimer);
    }

    latestRequestId++; // invalidate any in-flight semantic run (switched away from it)
    isEmbedding = false;
    semanticTruncated = false;
    try {
      chunks = strat === 'fixed' ? chunkFixed(text, Math.max(1, size), Math.max(0, overlap)) : chunkBySentence(text);
      chunkError = null;
    } catch (err) {
      console.warn('[chunking] chunking failed:', err);
      chunks = [];
      chunkError = t(lang, 'embeddings.chunkingError');
    }
  });

  function explainerKey(strat: Strategy): string {
    switch (strat) {
      case 'fixed':
        return 'embeddings.chunkingExplainerFixed';
      case 'sentence':
        return 'embeddings.chunkingExplainerSentence';
      case 'semantic':
        return 'embeddings.chunkingExplainerSemantic';
    }
  }

  function charRangeLabel(chunk: Chunk): string {
    return t(lang, 'embeddings.chunkingCharRange').replace('{start}', String(chunk.start)).replace('{end}', String(chunk.end));
  }

  function tokenLengthLabel(chunk: Chunk): string {
    return pluralLabelFor(lang, estimateTokens(chunk.text), 'chunkingTokenLength');
  }

  /**
   * Standard Slavic plural-category rule (matches CLDR / `Intl.PluralRules('ru')`):
   * n%10===1 && n%100!==11 → "one" (1 чанк, 21 чанк);
   * n%10 in 2..4 && n%100 not in 12..14 → "few" (2 чанка, 23 чанка);
   * everything else → "many" (0, 5-20, 25 чанков, etc.).
   */
  function pluralizeRu(n: number): 'one' | 'few' | 'many' {
    const mod10 = n % 10;
    const mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return 'one';
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'few';
    return 'many';
  }

  /**
   * English only distinguishes singular/plural; Russian needs the full
   * one/few/many split above. `${keyBase}` itself (with no suffix) carries
   * the "many"/English-plural form, so it doubles as the shared default in
   * both keysets. Shared by the chunk-COUNT label (`chunkingCount*`) and the
   * per-chunk token-count label (`chunkingTokenLength*`) — both need the
   * exact same one/few/many (ru) or one/other (en) split, just against a
   * different key prefix and a different `n`.
   */
  function pluralLabelFor(activeLang: Lang, n: number, keyBase: string): string {
    if (activeLang === 'ru') {
      const category = pluralizeRu(n);
      const key = category === 'one' ? `${keyBase}_one` : category === 'few' ? `${keyBase}_few` : keyBase;
      return t(activeLang, `embeddings.${key}`).replace('{n}', String(n));
    }
    const key = n === 1 ? `${keyBase}_one` : keyBase;
    return t(activeLang, `embeddings.${key}`).replace('{n}', String(n));
  }

  function countLabelFor(activeLang: Lang, n: number): string {
    return pluralLabelFor(activeLang, n, 'chunkingCount');
  }

  let countLabel = $derived(countLabelFor(lang, chunks.length));
  let charCountLabel = $derived(
    t(lang, 'embeddings.chunkingCharCount').replace('{n}', String(docText.length)).replace('{max}', String(DOC_MAX_LENGTH)),
  );
  let semanticTruncatedNotice = $derived(t(lang, 'embeddings.chunkingSemanticTruncatedNotice').replace('{n}', String(SEMANTIC_SENTENCE_CAP)));
</script>

<div class="chunking-panel">
  <p class="chunking-panel__intro">{t(lang, 'embeddings.chunkingIntro')}</p>

  <label class="chunking-panel__field" for="chunking-textarea">
    <span class="embeddings__field-label">{t(lang, 'embeddings.chunkingTextareaLabel')}</span>
    <textarea
      id="chunking-textarea"
      class="chunking-panel__textarea"
      bind:value={docText}
      rows="7"
      maxlength={DOC_MAX_LENGTH}
      aria-describedby="chunking-char-hint"
    ></textarea>
    <span id="chunking-char-hint" class="chunking-panel__char-hint">{charCountLabel}</span>
  </label>

  <div class="chunking-panel__controls">
    <label class="chunking-panel__field">
      <span class="embeddings__field-label">{t(lang, 'embeddings.chunkingStrategyLabel')}</span>
      <select class="chunking-panel__select" bind:value={strategy}>
        <option value="fixed">{t(lang, 'embeddings.chunkingStrategyFixed')}</option>
        <option value="sentence">{t(lang, 'embeddings.chunkingStrategySentence')}</option>
        <option value="semantic">{t(lang, 'embeddings.chunkingStrategySemantic')}</option>
      </select>
    </label>

    {#if strategy === 'fixed'}
      <label class="chunking-panel__field">
        <span class="embeddings__field-label">{t(lang, 'embeddings.chunkingSizeLabel')}: {fixedSize}</span>
        <input class="embeddings__range" type="range" min="60" max="600" step="10" bind:value={fixedSize} />
      </label>
      <label class="chunking-panel__field">
        <span class="embeddings__field-label">{t(lang, 'embeddings.chunkingOverlapLabel')}: {fixedOverlap}</span>
        <input class="embeddings__range" type="range" min="0" max={Math.max(0, fixedSize - 10)} step="10" bind:value={fixedOverlap} />
      </label>
    {:else if strategy === 'semantic'}
      <label class="chunking-panel__field">
        <span class="embeddings__field-label">{t(lang, 'embeddings.chunkingThresholdLabel')}: {semanticThreshold.toFixed(2)}</span>
        <input class="embeddings__range" type="range" min="0.1" max="0.9" step="0.05" bind:value={semanticThreshold} />
      </label>
    {/if}
  </div>

  <p class="chunking-panel__explainer">{t(lang, explainerKey(strategy))}</p>
  <p class="chunking-panel__note">{t(lang, 'embeddings.chunkingLateChunkingNote')}</p>

  {#if isEmbedding}
    <div class="chunking-panel__status">
      <span class="embeddings__micro-spinner" aria-hidden="true"></span>
      {t(lang, 'embeddings.chunkingEmbeddingStatus')}
    </div>
  {:else if chunkError}
    <div class="chunking-panel__status chunking-panel__status--error" role="alert">⚠️ {chunkError}</div>
  {:else if strategy === 'semantic' && semanticTruncated}
    <div class="chunking-panel__status chunking-panel__status--info" role="status">{semanticTruncatedNotice}</div>
  {/if}

  <div class="chunking-panel__header">
    <span>{t(lang, 'embeddings.chunkingResultsHeader')}</span>
    <span class="chunking-panel__count">{countLabel}</span>
  </div>

  <div class="chunking-panel__list" aria-live="polite">
    {#each chunks as chunk, i (chunk.id)}
      <div class="chunking-panel__chunk">
        <div class="chunking-panel__chunk-meta">
          <span class="chunking-panel__chunk-index">#{i + 1}</span>
          <span class="chunking-panel__chunk-range">{charRangeLabel(chunk)}</span>
          <span class="chunking-panel__chunk-tokens">{tokenLengthLabel(chunk)}</span>
        </div>
        <p class="chunking-panel__chunk-text">{chunk.text}</p>
      </div>
    {/each}
  </div>
</div>
