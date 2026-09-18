<script lang="ts">
  /**
   * RerankPanel.svelte
   * ───────────────────────────────────────────────────────────────────────
   * Retrieval-quality demo: runs one query through FOUR retrieval strategies
   * over the SAME already-embedded corpus (accepted as props, so nothing
   * here re-embeds the corpus) and shows the ranked result lists side by
   * side — dense-only, hybrid (dense + BM25, fused by either min-max blend
   * or RRF), MMR-reranked, and an experimental LLM-as-judge rerank — with a
   * rank badge on each hit showing how its position moved relative to plain
   * dense search.
   *
   * Async pattern mirrors SearchPanel.svelte: a debounced, request-id-
   * guarded embed() call for the query. Everything downstream of the cached
   * query vector (dense/hybrid/MMR rankings) is plain `$derived` math over
   * `search.ts`'s primitives — no extra async, no extra `$effect`. The LLM
   * rerank column is the one genuinely async, explicitly-triggered exception
   * (see `runLlmRerank` below) — it costs a real model call, so it never
   * fires automatically per keystroke.
   */
  import { t, type Lang } from '../../../i18n/utils';
  import { embed } from '../../../lib/embedding/engine';
  import {
    topK,
    bm25Lite,
    hybridSearch,
    reciprocalRankFusion,
    mmrRerank,
  } from '../../../lib/embedding/search';
  import type { EmbeddingVector } from '../../../lib/embedding/types';
  import type { SynapseClient } from '../../../lib/synapse-client';

  /** How many ranked hits each column shows. */
  const RESULT_COUNT = 6;
  /** How many top dense candidates MMR reranking is allowed to draw from. */
  const CANDIDATE_POOL = 15;
  /** How many top dense candidates the LLM judge is asked to score — keep this small: it's one real model call, and a longer numbered list is harder for a small model to score reliably. */
  const LLM_CANDIDATE_COUNT = 8;
  /** Reciprocal Rank Fusion's damping constant — 60 is the literature/industry default (see search.ts's doc comment). */
  const RRF_K = 60;
  const DEBOUNCE_MS = 300;

  type FusionMethod = 'minmax' | 'rrf';
  type LlmRerankStatus = 'idle' | 'loading' | 'ready' | 'unavailable' | 'error';

  let {
    corpusVectors,
    corpusLabels,
    modelId,
    lang = 'en',
  }: {
    corpusVectors: EmbeddingVector[];
    corpusLabels: string[];
    modelId: string | null;
    lang?: Lang;
  } = $props();

  let query = $state('');
  let activeQuery = $state('');
  let queryVec = $state<EmbeddingVector | null>(null);
  let isSearching = $state(false);
  /** Set only when embed() itself throws — kept distinct from "no query yet",
   *  which is a legitimate idle state, not a failure. */
  let searchError = $state<string | null>(null);
  let alpha = $state(0.5);
  let lambda = $state(0.6);
  let fusionMethod = $state<FusionMethod>('minmax');

  let debounceTimer: ReturnType<typeof setTimeout>;
  // Race-condition guard — same intent as SearchPanel's: embed() calls the
  // inference server and has no AbortSignal wired up here, so staleness is
  // checked by request id instead.
  let latestRequestId = 0;

  // ── LLM-as-judge rerank (experimental) ──────────────────────────────────
  // Genuinely async and explicitly button-triggered (never per-keystroke —
  // it's one real chat() call to the self-hosted model). Lazy: the Synapse
  // client is only imported when the user actually clicks the button, same
  // pattern as LabCopilot.svelte's "Ask Synapse".
  let llmClient: SynapseClient | null = null;
  let llmStatus = $state<LlmRerankStatus>('idle');
  /** Split into `ranked` (candidates the judge actually scored, sorted by
   *  that score) and `unscored` (candidates the judge silently dropped from
   *  its reply) — see `parseLlmScores`'s doc comment. Rendering a dropped
   *  candidate as "0.0/10" would fabricate a relevance judgment that never
   *  happened, so `unscored` carries no score at all and is rendered as its
   *  own visually-distinct, un-ranked group after `ranked`. */
  let llmResults = $state<{
    ranked: { item: number; score: number }[];
    unscored: number[];
  } | null>(null);
  // Plain (non-`$state`) race-condition guard for the LLM call — same intent
  // as `latestRequestId` above, just for the independent LLM-rerank flow.
  let latestLlmRequestId = 0;

  /** Word split for the BM25 (lexical) half of hybrid retrieval.
   *
   *  This used to be /[a-z0-9]+/g, which silently returned [] for any Cyrillic
   *  query — on a site that is half Russian. The consequences were not "worse
   *  results", they were fake ones: with every lexical score tied at zero,
   *  min-max normalisation flattened them all, and JS's stable sort then
   *  returned the first N corpus words in array order for ANY query. Under RRF
   *  it was worse still, because tied scores still produce a rank, and that
   *  rank enters the fused score as though it were signal.
   *
   *  \p{L} covers every alphabet (Cyrillic, Greek, CJK, accented Latin) and
   *  \p{N} every numeral; the `u` flag is required for those to mean anything.
   */
  function tokenize(text: string): string[] {
    return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  }

  async function performSearch(q: string, activeModelId: string): Promise<void> {
    const myRequestId = ++latestRequestId;
    searchError = null; // a new attempt is underway — any previous failure no longer applies
    try {
      const [vec] = await embed([q], undefined, activeModelId, 'query');
      if (myRequestId !== latestRequestId || !vec) return;
      queryVec = vec;
      activeQuery = q;
      isSearching = false;
    } catch (err) {
      if (myRequestId !== latestRequestId) return;
      console.warn('[embeddings] retrieval comparison failed:', err);
      isSearching = false;
      searchError = t(lang, 'embeddings.searchError');
      // Drop any PREVIOUS query's columns too — otherwise a stale ranking
      // for an earlier, different query keeps rendering as if it answered
      // this one. This also feeds the LLM-rerank reset effect below (it
      // watches activeQuery/queryVec), so a stale judgment doesn't linger
      // under a query that never actually got re-embedded.
      activeQuery = '';
      queryVec = null;
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
      queryVec = null;
      activeQuery = '';
      searchError = null;
      return;
    }

    isSearching = true;
    debounceTimer = setTimeout(() => {
      void performSearch(q, activeModelId);
    }, DEBOUNCE_MS);

    return () => clearTimeout(debounceTimer);
  });

  // Reset any LLM-rerank result whenever the ACTIVE (debounced) query OR the
  // vector space it was embedded into changes — a stale relevance judgment
  // attached to the previous query/model would otherwise sit under the new
  // one looking current. `activeQuery` alone isn't a reliable dependency
  // here: Svelte 5 skips a value-equal `$state` reassignment, and
  // performSearch's `activeQuery = q` reassigns the SAME string when only
  // the embedding MODEL changed (query text unchanged) — so switching
  // models left this effect never re-firing, and the LLM column kept
  // rendering its old judgment (with freshly-recomputed, now-mismatched
  // rank-delta badges) against a corpus that had just been re-embedded into
  // a different vector space. `queryVec` is a new object reference every
  // time performSearch resolves — including on a model switch with an
  // unchanged query string — so it's the dependency that actually tracks
  // "the current search results are entirely new." Reads only
  // `activeQuery`/`queryVec` and writes the disjoint `llmStatus`/
  // `llmResults` state (never reads back what it just wrote), so this can't
  // loop.
  $effect(() => {
    const _q = activeQuery;
    const _vec = queryVec;
    void _q; void _vec; // dependency only — nothing here reads them, see comment above
    llmStatus = 'idle';
    llmResults = null;
    latestLlmRequestId++; // invalidate any in-flight LLM rerank tied to the previous query/model
  });

  // ── Dense ranking over the WHOLE corpus (not just top-k) — this doubles
  // as the baseline every rank badge below is measured against. ──────────
  let denseRankedFull = $derived(
    queryVec && corpusVectors.length > 0 ? topK(queryVec, corpusVectors, corpusVectors.length) : []
  );
  let denseRankPosition = $derived.by(() => {
    const map = new Map<number, number>();
    denseRankedFull.forEach((hit, pos) => map.set(hit.item, pos));
    return map;
  });
  let denseColumn = $derived(denseRankedFull.slice(0, RESULT_COUNT));

  // ── Hybrid: blend dense + BM25 lexical scores, both index-aligned to the
  // full corpus so hybridSearch()'s min-max normalization sees every item. ──
  let denseScoresByIndex = $derived.by(() => {
    const arr = new Array<number>(corpusVectors.length).fill(0);
    for (const hit of denseRankedFull) arr[hit.item] = hit.score;
    return arr;
  });
  let lexicalScoresByIndex = $derived(
    activeQuery.trim() ? bm25Lite(tokenize(activeQuery), corpusLabels.map(tokenize)) : []
  );
  // Fusion method is a straight swap of which pure function turns the two
  // index-aligned score arrays into one blended score array — RRF (rank-
  // based) has no `alpha` to apply, so that branch ignores it entirely.
  let hybridRankedFull = $derived.by(() => {
    if (denseScoresByIndex.length === 0 || lexicalScoresByIndex.length === 0) return [];
    const blended =
      fusionMethod === 'rrf'
        ? reciprocalRankFusion(denseScoresByIndex, lexicalScoresByIndex, RRF_K)
        : hybridSearch(denseScoresByIndex, lexicalScoresByIndex, alpha);
    return blended.map((score, item) => ({ item, score })).sort((a, b) => b.score - a.score);
  });
  let hybridColumn = $derived(hybridRankedFull.slice(0, RESULT_COUNT));

  // ── Reranked: MMR over the top CANDIDATE_POOL dense hits — "retrieve
  // broad, then rerank precise/diverse". ─────────────────────────────────
  let rerankedColumn = $derived.by(() => {
    if (!queryVec || denseRankedFull.length === 0) return [];
    const pool = denseRankedFull.slice(0, Math.min(CANDIDATE_POOL, denseRankedFull.length));
    const candidateIdx: number[] = [];
    const candidateVecs: EmbeddingVector[] = [];
    for (const hit of pool) {
      const vec = corpusVectors[hit.item];
      if (!vec) continue;
      candidateIdx.push(hit.item);
      candidateVecs.push(vec);
    }
    const orderedIdx = mmrRerank(queryVec, candidateVecs, candidateIdx, lambda, RESULT_COUNT);
    return orderedIdx.map((item) => ({ item, score: denseScoresByIndex[item] ?? 0 }));
  });

  // ── LLM-as-judge rerank (experimental) — one listwise chat() call over
  // the top LLM_CANDIDATE_COUNT dense hits. ──────────────────────────────
  let llmCandidates = $derived(denseRankedFull.slice(0, LLM_CANDIDATE_COUNT));

  /**
   * Defensively parses the judge model's reply. Expected shape:
   * `{"scores":[{"i":1,"s":7}, ...]}` — `i` is the 1-based candidate number
   * from the prompt, `s` a 0-10 relevance score. Small models are prone to
   * wrapping JSON in prose or markdown fences, dropping a candidate, or
   * emitting an out-of-range index, so every step here degrades to `null`
   * (a genuine parse failure, surfaced honestly) rather than guessing.
   * Returns a `candidateCount`-length array where each slot is either a 0-10
   * score or `null` (the judge never scored that candidate — a real,
   * observed failure mode of small models asked for a complete list), or
   * `null` for the whole array when nothing parseable came back at all.
   * `null` slots must NOT be coerced to 0 by the caller: an unscored
   * candidate is not the same fact as "the judge rated this irrelevant".
   */
  function parseLlmScores(content: string, candidateCount: number): (number | null)[] | null {
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(match[0]);
    } catch {
      return null;
    }

    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('scores' in parsed) ||
      !Array.isArray((parsed as { scores: unknown }).scores)
    ) {
      return null;
    }

    const entries = (parsed as { scores: unknown[] }).scores;
    const result = new Array<number | null>(candidateCount).fill(null);
    let filled = 0;
    for (const entry of entries) {
      if (typeof entry !== 'object' || entry === null) continue;
      const rec = entry as Record<string, unknown>;
      const i = rec.i;
      const s = rec.s;
      if (typeof i !== 'number' || typeof s !== 'number') continue;
      if (!Number.isFinite(i) || !Number.isFinite(s)) continue;
      const idx = Math.round(i) - 1;
      if (idx < 0 || idx >= candidateCount) continue;
      result[idx] = Math.max(0, Math.min(10, s));
      filled++;
    }
    if (filled === 0) return null;
    // Slots the model silently skipped stay `null` — an honest "not scored"
    // rather than a fabricated 0/10 relevance judgment.
    return result;
  }

  async function runLlmRerank(): Promise<void> {
    const myId = ++latestLlmRequestId;
    const q = activeQuery;
    const candidates = llmCandidates;
    if (!q.trim() || candidates.length === 0) return;

    llmStatus = 'loading';
    try {
      if (!llmClient) {
        const { createSynapseClient } = await import('../../../lib/synapse-client');
        llmClient = createSynapseClient();
      }

      const listText = candidates.map((hit, idx) => `${idx + 1}. ${labelFor(hit.item)}`).join('\n');
      const prompt = [
        'You are a relevance-judging function, not a conversational assistant.',
        "Given a QUERY and a numbered list of CANDIDATES, score every candidate's relevance to the query from 0 (irrelevant) to 10 (perfect match).",
        'Respond with ONLY one JSON object of the exact shape {"scores":[{"i":<candidate number>,"s":<0-10 integer>}, ...]} — one entry per candidate, no prose, no markdown fences, no extra keys.',
        '',
        `QUERY: "${q}"`,
        '',
        'CANDIDATES:',
        listText,
      ].join('\n');

      const res = await llmClient.chat({ message: prompt });
      if (myId !== latestLlmRequestId) return;

      // The client silently falls back to a canned mock reply whenever the
      // backend is unreachable — that reply is NOT a real relevance
      // judgment, so it must never be rendered as one.
      if (res.source === 'mock') {
        llmStatus = 'unavailable';
        return;
      }

      const scores = parseLlmScores(res.content, candidates.length);
      if (!scores) {
        llmStatus = 'error';
        return;
      }

      // Candidates the judge actually scored are ranked by that score;
      // candidates it silently dropped are tracked separately (in original
      // dense-candidate order) rather than defaulting to a fabricated 0/10 —
      // see parseLlmScores's doc comment.
      const ranked: { item: number; score: number }[] = [];
      const unscored: number[] = [];
      for (const [idx, hit] of candidates.entries()) {
        const score = scores[idx];
        if (score === null || score === undefined) {
          unscored.push(hit.item);
        } else {
          ranked.push({ item: hit.item, score });
        }
      }
      ranked.sort((a, b) => b.score - a.score);
      llmResults = { ranked, unscored };
      llmStatus = 'ready';
    } catch (err) {
      if (myId !== latestLlmRequestId) return;
      console.warn('[embeddings] LLM rerank failed:', err);
      llmStatus = 'error';
    }
  }

  type RankDelta = 'up' | 'down' | 'same';
  function rankDelta(item: number, columnPos: number): RankDelta {
    const basePos = denseRankPosition.get(item);
    if (basePos === undefined || basePos === columnPos) return 'same';
    return basePos > columnPos ? 'up' : 'down';
  }
  function rankDeltaLabel(delta: RankDelta): string {
    switch (delta) {
      case 'up':
        return t(lang, 'embeddings.retrievalRankUp');
      case 'down':
        return t(lang, 'embeddings.retrievalRankDown');
      case 'same':
        return t(lang, 'embeddings.retrievalRankSame');
    }
  }
  function rankDeltaGlyph(delta: RankDelta): string {
    return delta === 'up' ? '↑' : delta === 'down' ? '↓' : '=';
  }

  let candidatePoolNote = $derived(
    t(lang, 'embeddings.retrievalCandidatePoolNote').replace(
      '{n}',
      String(Math.min(CANDIDATE_POOL, corpusVectors.length))
    )
  );

  /** `noUncheckedIndexedAccess`-safe corpus text lookup for the template below. */
  function labelFor(item: number): string {
    return corpusLabels[item] ?? '';
  }
</script>

<div class="rerank-panel">
  <p class="rerank-panel__intro">{t(lang, 'embeddings.retrievalIntro')}</p>

  <div class="rerank-panel__query-row">
    <input
      type="text"
      class="rerank-panel__input"
      bind:value={query}
      placeholder={t(lang, 'embeddings.retrievalQueryPlaceholder')}
      aria-label={t(lang, 'embeddings.retrievalQueryLabel')}
      disabled={!modelId}
    />
    {#if isSearching}
      <span class="rerank-panel__spinner embeddings__micro-spinner" aria-hidden="true"></span>
    {/if}
  </div>

  <fieldset class="rerank-panel__fusion-fieldset">
    <legend class="embeddings__field-label">{t(lang, 'embeddings.retrievalFusionLabel')}</legend>
    <label class="rerank-panel__radio">
      <input type="radio" name="rerank-fusion-method" value="minmax" bind:group={fusionMethod} />
      <span>{t(lang, 'embeddings.retrievalFusionMinMax')}</span>
    </label>
    <label class="rerank-panel__radio">
      <input type="radio" name="rerank-fusion-method" value="rrf" bind:group={fusionMethod} />
      <span>{t(lang, 'embeddings.retrievalFusionRrf')}</span>
    </label>
  </fieldset>

  <div class="rerank-panel__controls">
    <label class="rerank-panel__field">
      <span class="embeddings__field-label"
        >{t(lang, 'embeddings.retrievalAlphaLabel')}: {alpha.toFixed(2)}</span
      >
      <input
        class="embeddings__range"
        type="range"
        min="0"
        max="1"
        step="0.05"
        bind:value={alpha}
        disabled={fusionMethod === 'rrf'}
        aria-describedby={fusionMethod === 'rrf' ? 'rerank-alpha-disabled-note' : undefined}
      />
      {#if fusionMethod === 'rrf'}
        <span id="rerank-alpha-disabled-note" class="rerank-panel__disabled-note">
          {t(lang, 'embeddings.retrievalAlphaDisabledNote')}
        </span>
      {/if}
    </label>
    <label class="rerank-panel__field">
      <span class="embeddings__field-label"
        >{t(lang, 'embeddings.retrievalLambdaLabel')}: {lambda.toFixed(2)}</span
      >
      <input
        class="embeddings__range"
        type="range"
        min="0"
        max="1"
        step="0.05"
        bind:value={lambda}
      />
    </label>
  </div>

  {#if !activeQuery.trim()}
    {#if isSearching}
      <div class="rerank-panel__empty">{t(lang, 'embeddings.retrievalSearching')}</div>
    {:else if searchError}
      <div class="embeddings__status-banner embeddings__status-banner--error" role="alert">
        ⚠️ {searchError}
      </div>
    {:else}
      <div class="rerank-panel__empty">{t(lang, 'embeddings.retrievalEmptyPlaceholder')}</div>
    {/if}
  {:else}
    <div class="rerank-panel__columns">
      <div class="rerank-panel__column">
        <h3 class="rerank-panel__column-header">{t(lang, 'embeddings.retrievalColDense')}</h3>
        {#each denseColumn as hit (hit.item)}
          <div class="rerank-panel__result">
            <p class="rerank-panel__result-text">{labelFor(hit.item)}</p>
            <span class="rerank-panel__result-score"
              >{t(lang, 'embeddings.retrievalScoreLabel')}: {hit.score.toFixed(3)}</span
            >
          </div>
        {/each}
      </div>

      <div class="rerank-panel__column">
        <h3 class="rerank-panel__column-header">{t(lang, 'embeddings.retrievalColHybrid')}</h3>
        <p class="rerank-panel__note rerank-panel__note--column">
          {fusionMethod === 'rrf'
            ? t(lang, 'embeddings.retrievalRrfScoreNote')
            : t(lang, 'embeddings.retrievalHybridScaleNote')}
        </p>
        {#each hybridColumn as hit, i (hit.item)}
          {@const delta = rankDelta(hit.item, i)}
          <div class="rerank-panel__result">
            <p class="rerank-panel__result-text">{labelFor(hit.item)}</p>
            <span class="rerank-panel__result-score">
              {t(lang, 'embeddings.retrievalScoreLabel')}: {fusionMethod === 'rrf'
                ? hit.score.toFixed(4)
                : hit.score.toFixed(3)}
              <span
                class="rerank-panel__badge rerank-panel__badge--{delta}"
                title={rankDeltaLabel(delta)}>{rankDeltaGlyph(delta)}</span
              >
            </span>
          </div>
        {/each}
      </div>

      <div class="rerank-panel__column">
        <h3 class="rerank-panel__column-header">{t(lang, 'embeddings.retrievalColReranked')}</h3>
        {#each rerankedColumn as hit, i (hit.item)}
          {@const delta = rankDelta(hit.item, i)}
          <div class="rerank-panel__result">
            <p class="rerank-panel__result-text">{labelFor(hit.item)}</p>
            <span class="rerank-panel__result-score">
              {t(lang, 'embeddings.retrievalScoreLabel')}: {hit.score.toFixed(3)}
              <span
                class="rerank-panel__badge rerank-panel__badge--{delta}"
                title={rankDeltaLabel(delta)}>{rankDeltaGlyph(delta)}</span
              >
            </span>
          </div>
        {/each}
      </div>

      <div class="rerank-panel__column">
        <h3 class="rerank-panel__column-header">{t(lang, 'embeddings.retrievalColLlm')}</h3>
        <p class="rerank-panel__note rerank-panel__note--column">
          {t(lang, 'embeddings.retrievalLlmExperimentalNote')}
        </p>

        {#if llmStatus === 'idle'}
          <button
            type="button"
            class="rerank-panel__llm-btn"
            onclick={() => void runLlmRerank()}
            disabled={llmCandidates.length === 0}
          >
            {t(lang, 'embeddings.retrievalLlmRunButton')}
          </button>
        {:else if llmStatus === 'loading'}
          <div class="rerank-panel__llm-status" role="status">
            <span class="embeddings__micro-spinner" aria-hidden="true"></span>
            {t(lang, 'embeddings.retrievalLlmLoading')}
          </div>
        {:else if llmStatus === 'unavailable'}
          <p class="rerank-panel__llm-status rerank-panel__llm-status--muted">
            {t(lang, 'embeddings.retrievalLlmUnavailable')}
          </p>
        {:else if llmStatus === 'error'}
          <div class="rerank-panel__llm-status rerank-panel__llm-status--error" role="alert">
            <p>{t(lang, 'embeddings.retrievalLlmParseError')}</p>
            <button type="button" class="rerank-panel__llm-btn" onclick={() => void runLlmRerank()}>
              {t(lang, 'embeddings.retrievalLlmRetryButton')}
            </button>
          </div>
        {:else if llmStatus === 'ready' && llmResults}
          <button
            type="button"
            class="rerank-panel__llm-btn rerank-panel__llm-btn--rerun"
            onclick={() => void runLlmRerank()}
          >
            {t(lang, 'embeddings.retrievalLlmRerunButton')}
          </button>
          {#each llmResults.ranked as hit, i (hit.item)}
            {@const delta = rankDelta(hit.item, i)}
            <div class="rerank-panel__result">
              <p class="rerank-panel__result-text">{labelFor(hit.item)}</p>
              <span class="rerank-panel__result-score">
                {t(lang, 'embeddings.retrievalLlmScoreLabel')}: {hit.score.toFixed(1)}/10
                <span
                  class="rerank-panel__badge rerank-panel__badge--{delta}"
                  title={rankDeltaLabel(delta)}>{rankDeltaGlyph(delta)}</span
                >
              </span>
            </div>
          {/each}
          <!-- Candidates the judge silently dropped from its reply (a real
               small-model failure mode) — NOT rendered as a fabricated
               "0.0/10", visually muted, and excluded from the ranked
               ordering above rather than sorted in among real scores. -->
          {#each llmResults.unscored as item (item)}
            <div class="rerank-panel__result rerank-panel__result--unscored">
              <p class="rerank-panel__result-text">{labelFor(item)}</p>
              <span class="rerank-panel__result-score rerank-panel__result-score--muted">
                {t(lang, 'embeddings.retrievalLlmNotScored')}
              </span>
            </div>
          {/each}
        {/if}
      </div>
    </div>

    <p class="rerank-panel__note">{candidatePoolNote}</p>
    <p class="rerank-panel__explainer">
      {fusionMethod === 'rrf'
        ? t(lang, 'embeddings.retrievalExplainerRrf')
        : t(lang, 'embeddings.retrievalExplainerHybrid')}
    </p>
    <p class="rerank-panel__explainer">{t(lang, 'embeddings.retrievalExplainerRerank')}</p>
  {/if}
</div>
