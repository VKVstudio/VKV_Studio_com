<script lang="ts">
  /**
   * AnalogiesPanel.svelte
   * ───────────────────────────────────────────────────────────────────────
   * Vector arithmetic demo: a − b + c ≈ answer (the classic
   * king − man + woman ≈ queen). Preset chips (analogies.ts's
   * ANALOGY_PRESETS) were empirically verified to land on their expected
   * word; free-text input is honest about missing — the real top-5 nearest
   * words to the arithmetic result are always shown, never a faked hit.
   *
   * Self-contained: this panel does NOT rank against the main demo corpus
   * (its ~130 diverse words don't contain answers like "queen"/"rome"/
   * "kitten" — the correct word could never surface). Instead it embeds
   * analogies.ts's ANALOGY_VOCAB — a small candidate vocabulary built to
   * contain every preset's answer plus distractors — in ONE batch call on
   * mount/model-change, caches those vectors in state, and ranks every
   * a/b/c combination against THAT pool.
   *
   * Async pattern mirrors ChunkingPanel/RerankPanel: plain (non-`$state`)
   * request-id staleness guards for both the vocabulary batch and the
   * debounced a/b/c analogy run — two independent async flows, each with
   * its own guard. Every `$effect` below reads one set of state and writes
   * only a disjoint set — never the Svelte 5 read+write-same-`$state` trap.
   */
  import { t, type Lang } from '../../../i18n/utils';
  import { embed } from '../../../lib/embedding/engine';
  import { cosineSimilarity } from '../../../lib/embedding/search';
  import {
    ANALOGY_PRESETS,
    ANALOGY_VOCAB,
    analogyVector,
    type AnalogyPreset,
  } from '../../../lib/embedding/analogies';
  import type { EmbeddingVector } from '../../../lib/embedding/types';

  const DEBOUNCE_MS = 400;
  const RESULT_COUNT = 5;

  let {
    lang = 'en',
    /** Model id already serving the corpus, if any — reused so the vocabulary
     * and the a/b/c inputs share the exact same vector space. */
    modelId = null,
  }: { lang?: Lang; modelId?: string | null } = $props();

  // ── Candidate vocabulary — embedded once (per model id), cached, and
  // reused by every analogy run instead of re-embedding it each time. ──────
  let vocabVectors = $state<EmbeddingVector[] | null>(null);
  let vocabLoading = $state(false);
  let vocabError = $state<string | null>(null);

  // Race-condition guard for the vocabulary batch — embed() calls the
  // inference server and has no AbortSignal wired up here, so staleness is
  // checked by request id instead.
  let latestVocabRequestId = 0;

  async function loadVocab(activeModelId: string, requestId: number): Promise<void> {
    vocabLoading = true;
    vocabError = null;
    try {
      const vectors = await embed(ANALOGY_VOCAB, undefined, activeModelId, 'document');
      if (requestId !== latestVocabRequestId) return;
      vocabVectors = vectors;
    } catch (err) {
      if (requestId !== latestVocabRequestId) return;
      console.warn('[embeddings] analogy vocabulary batch failed:', err);
      vocabError = t(lang, 'embeddings.analogiesVocabError');
      vocabVectors = null;
    } finally {
      if (requestId === latestVocabRequestId) vocabLoading = false;
    }
  }

  $effect(() => {
    const activeModelId = modelId;
    const requestId = ++latestVocabRequestId;
    if (!activeModelId) {
      vocabLoading = false;
      return;
    }
    void loadVocab(activeModelId, requestId);
  });

  let aText = $state('');
  let bText = $state('');
  let cText = $state('');

  interface AnalogyResult {
    label: string;
    score: number;
  }

  let results = $state<AnalogyResult[]>([]);
  let computedA = $state('');
  let computedB = $state('');
  let computedC = $state('');
  let isComputing = $state(false);
  let computeError = $state<string | null>(null);

  let debounceTimer: ReturnType<typeof setTimeout>;
  // Independent request-id guard for the a/b/c analogy run — same intent as
  // `latestVocabRequestId` above, just for a different async flow.
  let latestRequestId = 0;

  function applyPreset(preset: AnalogyPreset): void {
    aText = preset.a;
    bText = preset.b;
    cText = preset.c;
  }

  async function runAnalogy(
    a: string,
    b: string,
    c: string,
    activeModelId: string,
    vocab: EmbeddingVector[]
  ): Promise<void> {
    const requestId = ++latestRequestId;
    isComputing = true;
    computeError = null;
    try {
      const [va, vb, vc] = await embed([a, b, c], undefined, activeModelId, 'document');
      if (requestId !== latestRequestId || !va || !vb || !vc) return;

      const analogyVec = analogyVector(va, vb, vc);

      // a, b, and c are all excluded from the results — a vocabulary entry
      // that happens to equal one of the inputs would trivially score high
      // against a vector built partly from that same word.
      const aLower = a.toLowerCase();
      const bLower = b.toLowerCase();
      const cLower = c.toLowerCase();
      const scored: AnalogyResult[] = [];
      for (let i = 0; i < ANALOGY_VOCAB.length; i++) {
        const label = ANALOGY_VOCAB[i];
        const vec = vocab[i];
        if (!label || !vec) continue;
        const lower = label.toLowerCase();
        if (lower === aLower || lower === bLower || lower === cLower) continue;
        scored.push({ label, score: cosineSimilarity(analogyVec, vec) });
      }
      scored.sort((x, y) => y.score - x.score);

      results = scored.slice(0, RESULT_COUNT);
      computedA = a;
      computedB = b;
      computedC = c;
    } catch (err) {
      if (requestId !== latestRequestId) return;
      console.warn('[embeddings] analogy failed:', err);
      computeError = t(lang, 'embeddings.analogiesError');
      results = [];
    } finally {
      if (requestId === latestRequestId) isComputing = false;
    }
  }

  $effect(() => {
    const a = aText.trim();
    const b = bText.trim();
    const c = cText.trim();
    const activeModelId = modelId;
    const vocab = vocabVectors;

    clearTimeout(debounceTimer);

    if (!a || !b || !c || !activeModelId || !vocab) {
      latestRequestId++; // invalidate any in-flight run
      isComputing = false;
      results = [];
      computedA = '';
      computedB = '';
      computedC = '';
      computeError = null;
      return;
    }

    isComputing = true;
    debounceTimer = setTimeout(() => {
      void runAnalogy(a, b, c, activeModelId, vocab);
    }, DEBOUNCE_MS);

    return () => clearTimeout(debounceTimer);
  });

  function scoreBarWidth(score: number): number {
    return Math.round(Math.max(0, Math.min(1, score)) * 100);
  }

  /** Localizes analogies.ts's plain-English `kind` strings for the chip tooltip. */
  function kindLabel(kind: string): string {
    switch (kind) {
      case 'gender':
        return t(lang, 'embeddings.analogiesKindGender');
      case 'capital city':
        return t(lang, 'embeddings.analogiesKindCapitalCity');
      case 'grown-up → baby':
        return t(lang, 'embeddings.analogiesKindBabyAnimal');
      case 'comparative':
        return t(lang, 'embeddings.analogiesKindComparative');
      case 'verb form':
        return t(lang, 'embeddings.analogiesKindVerbForm');
      case 'country ↔ capital':
        return t(lang, 'embeddings.analogiesKindCountryCapital');
      default:
        return kind;
    }
  }

  let topAnswer = $derived(results[0]?.label ?? null);
</script>

<div class="analogies-panel">
  <p class="analogies-panel__intro">{t(lang, 'embeddings.analogiesIntro')}</p>

  {#if vocabLoading}
    <div class="analogies-panel__status">
      <span class="embeddings__micro-spinner" aria-hidden="true"></span>
      {t(lang, 'embeddings.analogiesVocabLoading')}
    </div>
  {:else if vocabError}
    <div class="analogies-panel__status analogies-panel__status--error" role="alert">
      ⚠️ {vocabError}
    </div>
  {/if}

  <div
    class="analogies-panel__chips"
    role="group"
    aria-label={t(lang, 'embeddings.analogiesPresetsHeader')}
  >
    {#each ANALOGY_PRESETS as preset (preset.a + preset.b + preset.c)}
      <button
        type="button"
        class="analogies-panel__chip"
        onclick={() => applyPreset(preset)}
        title={kindLabel(preset.kind)}
      >
        {preset.a} − {preset.b} + {preset.c}
      </button>
    {/each}
  </div>

  <div class="analogies-panel__inputs">
    <label class="analogies-panel__field">
      <span class="embeddings__field-label">{t(lang, 'embeddings.analogiesInputALabel')}</span>
      <input
        type="text"
        class="analogies-panel__input"
        bind:value={aText}
        placeholder={t(lang, 'embeddings.analogiesInputAPlaceholder')}
        disabled={!modelId}
      />
    </label>
    <span class="analogies-panel__operator" aria-hidden="true">−</span>
    <label class="analogies-panel__field">
      <span class="embeddings__field-label">{t(lang, 'embeddings.analogiesInputBLabel')}</span>
      <input
        type="text"
        class="analogies-panel__input"
        bind:value={bText}
        placeholder={t(lang, 'embeddings.analogiesInputBPlaceholder')}
        disabled={!modelId}
      />
    </label>
    <span class="analogies-panel__operator" aria-hidden="true">+</span>
    <label class="analogies-panel__field">
      <span class="embeddings__field-label">{t(lang, 'embeddings.analogiesInputCLabel')}</span>
      <input
        type="text"
        class="analogies-panel__input"
        bind:value={cText}
        placeholder={t(lang, 'embeddings.analogiesInputCPlaceholder')}
        disabled={!modelId}
      />
    </label>
  </div>

  {#if isComputing}
    <div class="analogies-panel__status">
      <span class="embeddings__micro-spinner" aria-hidden="true"></span>
      {t(lang, 'embeddings.analogiesComputing')}
    </div>
  {:else if computeError}
    <div class="analogies-panel__status analogies-panel__status--error" role="alert">
      ⚠️ {computeError}
    </div>
  {:else if results.length === 0}
    <p class="analogies-panel__empty">{t(lang, 'embeddings.analogiesEmptyPlaceholder')}</p>
  {:else}
    <p class="analogies-panel__equation">
      {computedA} − {computedB} + {computedC} ≈
      <strong class="analogies-panel__answer">{topAnswer}</strong>
    </p>

    <div class="analogies-panel__results" aria-live="polite">
      <div class="analogies-panel__results-header">
        {t(lang, 'embeddings.analogiesResultsHeader')}
      </div>
      {#each results as result, i (result.label)}
        <div class="analogies-panel__result" class:analogies-panel__result--top={i === 0}>
          <span class="analogies-panel__result-rank">#{i + 1}</span>
          <span class="analogies-panel__result-label">{result.label}</span>
          <span class="analogies-panel__bar">
            <span
              class="analogies-panel__bar-fill"
              style="width: {scoreBarWidth(result.score)}%"
            ></span>
          </span>
          <span class="analogies-panel__result-score">{result.score.toFixed(3)}</span>
        </div>
      {/each}
    </div>
  {/if}

  <p class="analogies-panel__note">{t(lang, 'embeddings.analogiesHonestNote')}</p>
</div>
