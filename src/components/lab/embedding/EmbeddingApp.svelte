<script lang="ts">
  /**
   * EmbeddingApp.svelte
   * ───────────────────────────────────────────────────────────────────────
   * Orchestrator for the Embedding Space Explorer: embeds the demo corpus
   * via the inference server's EmbeddingGemma (`POST /api/embed`, or reuses
   * a cached run), reduces the result to 3D — instantly via PCA, then
   * refined via a UMAP Web Worker — and wires the result into
   * <EmbeddingScene> + <SearchPanel>.
   *
   * Mirrors TokenizerApp.svelte's conventions: plain (non-`$state`) request-id
   * bookkeeping to discard stale async results, honesty-tiered status badges
   * sourced only from what the engine actually reports, and no `$effect` that
   * reads and writes the same `$state` (each effect below reads one set of
   * state and writes a disjoint one).
   */
  import { onDestroy, onMount } from 'svelte';
  import { t, type Lang } from '../../../i18n/utils';
  import { publishLabState } from '../../../lib/lab-copilot-bus';
  import '../../../styles/lab/embeddings.css';
  import {
    embedDetailed,
    EMBEDDING_MODEL_LIST,
    DEFAULT_EMBEDDING_MODEL_ID,
    getEmbeddingModelInfo,
    type EmbedBackend,
  } from '../../../lib/embedding/engine';
  import { pca } from '../../../lib/embedding/reduce';
  import type {
    ReduceWorkerMessage,
    ReduceWorkerRequest,
  } from '../../../lib/embedding/reduce.worker';
  import ReduceWorkerCtor from '../../../lib/embedding/reduce.worker?worker';
  import { kmeans, nameClusters, CLUSTER_PALETTE } from '../../../lib/embedding/cluster';
  import {
    DEMO_CORPUS,
    CORPUS_VERSION,
    getCachedEmbeddings,
    setCachedEmbeddings,
    getCachedLayout,
    setCachedLayout,
  } from '../../../lib/embedding/corpus';
  import type {
    EmbeddingVector,
    EmbedStatus,
    ReducedPoint,
    SearchResult,
  } from '../../../lib/embedding/types';
  import EmbeddingScene from './EmbeddingScene.svelte';
  import SearchPanel from './SearchPanel.svelte';
  import ChunkingPanel from './ChunkingPanel.svelte';
  import RerankPanel from './RerankPanel.svelte';
  import LanguagesPanel from './LanguagesPanel.svelte';
  import AnalogiesPanel from './AnalogiesPanel.svelte';
  import EmbeddingTabs from './EmbeddingTabs.svelte';
  import type { TabId } from './embeddingTabs';

  let { lang = 'en' }: { lang?: Lang } = $props();

  let activeTab = $state<TabId>('explore');

  /** Extra, UI-only tier alongside `EmbedBackend` — vectors reused from `corpus.ts`'s Dexie cache were never run through a backend THIS session, so we report that honestly instead of guessing webgpu/wasm. */
  type BackendDisplay = EmbedBackend | 'cached';

  const corpusLabels = DEMO_CORPUS.map((p) => p.label);
  const corpusIds = DEMO_CORPUS.map((p) => p.id);

  let selectedModelId = $state<string>(DEFAULT_EMBEDDING_MODEL_ID);
  let status = $state<EmbedStatus>('idle');
  let statusDetail = $state<string | undefined>(undefined);
  let activeModelId = $state<string | null>(null);
  let activeBackend = $state<BackendDisplay | null>(null);
  let downgraded = $state(false);

  let vectors = $state<EmbeddingVector[]>([]);
  let points = $state<ReducedPoint[]>([]);
  let layoutMethod = $state<'pca' | 'umap'>('pca');
  let refiningLayout = $state(false);

  let highlighted = $state<number[]>([]);
  let scores = $state<number[] | null>(null);
  // Last completed search — kept only for the Lab Copilot bus's `detail`
  // (see the publish effect below); SearchPanel itself owns `query`/`results`
  // for its own rendering and only reports the score/highlight arrays back
  // up via `onResults` (see handleSearchResults's header comment).
  let lastSearchQuery = $state('');
  let lastSearchResults = $state<SearchResult[]>([]);

  /**
   * Emergent clustering — see `cluster.ts`. `clusterK` is the only knob the
   * user controls (a slider); everything else here is DERIVED from it plus
   * `vectors`, so this effect reads `vectors`/`clusterK` and writes only the
   * disjoint `clusterAssignments`/`clusterNames`/`silhouette` state — never
   * reads and writes the same `$state` (the Svelte 5 infinite-loop trap).
   */
  let clusterK = $state(4);
  let clusterAssignments = $state<number[]>([]);
  let clusterNames = $state<string[]>([]);
  let silhouette = $state(0);
  /** Off by default: the map is a calm cloud + the honest cosine gradient on search.
   *  Clustering is opt-in because on real embeddings it's genuinely weak (low
   *  silhouette) — that fuzziness is itself the lesson, not a headline feature. */
  let showClusters = $state(false);

  $effect(() => {
    const vecs = vectors;
    const k = clusterK;
    if (vecs.length === 0) {
      clusterAssignments = [];
      clusterNames = [];
      silhouette = 0;
      return;
    }
    const result = kmeans(vecs, k);
    clusterAssignments = result.assignments;
    clusterNames = nameClusters(vecs, corpusLabels, result);
    silhouette = result.silhouette;
  });

  /** One legend entry per cluster the model actually found — palette colour + its auto-derived name. */
  let clusterLegend = $derived(
    clusterNames.map((name, c) => ({ name, color: CLUSTER_PALETTE[c % CLUSTER_PALETTE.length]! }))
  );

  // Race-condition guard, plain (non-`$state`) bookkeeping — mutating it
  // inside async callbacks is fine, it's not reactive UI state.
  let latestRequestId = 0;
  let worker: Worker | null = null;

  /**
   * Gate for the network call: embedding the whole corpus means a real
   * round trip to the inference backend, which must NOT fire on page load
   * (a visitor who never touches the tool shouldn't silently wake a GPU
   * workstation on the other end). Nothing in `loadAndReduce` runs until
   * this flips to `false` — either because the user clicks the explicit
   * CTA button (`startLoading`), or because `onMount`'s cache probe below
   * finds a previous run already in Dexie, in which case there's nothing
   * new to fetch and we resume silently (repeat visits stay fast, no extra
   * click).
   */
  let awaitingConsent = $state(true);
  /** True only during the initial (cheap, local, no network) Dexie cache probe. */
  let checkingCache = $state(true);

  /**
   * A search only ever HIGHLIGHTS the true nearest points by exact cosine
   * score — there is no fabricated query marker/position in the scene
   * anymore (see EmbeddingScene.svelte's header comment). `results`/`query`
   * are otherwise handled entirely inside SearchPanel itself for its own
   * rendering; the score/highlight arrays reach the scene, and `query` +
   * the top hit are additionally kept here (item 2) purely for the Lab
   * Copilot bus's `detail` — see the publish effect below.
   */
  function handleSearchResults(payload: {
    scores: number[] | null;
    highlighted: number[];
    results: SearchResult[];
    query: string;
  }): void {
    scores = payload.scores;
    highlighted = payload.highlighted;
    lastSearchQuery = payload.query;
    lastSearchResults = payload.results;
  }

  // Publish a short "on screen now" summary for the Lab Copilot panel, plus a
  // structured `detail` of the same honest facts already on screen — see
  // lab-copilot-bus.ts. `searchQuery`/`topHit`/`topScore` only appear once a
  // search has actually run; `clustersOn`/`k`/`silhouette` only while the
  // opt-in cluster view is on — never fabricated defaults.
  $effect(() => {
    const dims = activeModelId ? getEmbeddingModelInfo(activeModelId).dims : 0;
    const topHit = lastSearchResults[0];
    publishLabState(
      'embeddings',
      points.length
        ? `${points.length} points · ${layoutMethod.toUpperCase()} layout`
        : t(lang, 'embeddings.title'),
      {
        activeTab,
        corpusSize: corpusLabels.length,
        layoutMethod,
        dims,
        ...(lastSearchQuery
          ? {
              searchQuery: lastSearchQuery,
              ...(topHit ? { topHit: topHit.text, topScore: Number(topHit.score.toFixed(3)) } : {}),
            }
          : {}),
        ...(showClusters
          ? { clustersOn: true, k: clusterK, silhouette: Number(silhouette.toFixed(2)) }
          : {}),
      }
    );
  });

  async function loadAndReduce(modelId: string): Promise<void> {
    const myRequestId = ++latestRequestId;
    status = 'loading-model';
    statusDetail = undefined;
    downgraded = false;
    activeModelId = null;
    activeBackend = null;
    refiningLayout = false;
    highlighted = [];
    scores = null;

    try {
      const cached = await getCachedEmbeddings(modelId, CORPUS_VERSION);
      if (myRequestId !== latestRequestId) return;

      let outcomeVectors: EmbeddingVector[];
      let usedModelId: string;
      let backendDisplay: BackendDisplay;

      if (cached && cached.vectors.length === corpusLabels.length) {
        // Cache hit — skip re-embedding entirely. We genuinely don't know
        // which backend served this cached run (it may be from a previous
        // session/device), so report 'cached' rather than guessing.
        outcomeVectors = cached.vectors;
        usedModelId = modelId;
        backendDisplay = 'cached';
        status = 'ready';
      } else {
        const outcome = await embedDetailed(
          corpusLabels,
          (s, detail) => {
            if (myRequestId !== latestRequestId) return; // a newer load superseded this one
            status = s;
            statusDetail = detail;
          },
          modelId
        );
        if (myRequestId !== latestRequestId) return;

        outcomeVectors = outcome.vectors;
        usedModelId = outcome.modelId;
        backendDisplay = outcome.backend;
        status = 'ready';
        void setCachedEmbeddings(usedModelId, corpusIds, outcomeVectors, CORPUS_VERSION);
      }

      if (myRequestId !== latestRequestId) return;

      downgraded = usedModelId !== modelId; // engine.ts silently retries on the default model — surface that here instead of pretending the requested model loaded
      vectors = outcomeVectors;
      activeModelId = usedModelId;
      activeBackend = backendDisplay;

      // ── Instant first paint: synchronous PCA, right on the main thread ──
      points = pca(outcomeVectors, 3);
      layoutMethod = 'pca';

      // ── Then refine: a cached UMAP layout wins immediately; otherwise
      // compute it off-thread and swap it in when it resolves. ──────────
      const cachedLayout = await getCachedLayout(usedModelId, 'umap', CORPUS_VERSION);
      if (myRequestId !== latestRequestId) return;

      if (cachedLayout && cachedLayout.length === outcomeVectors.length) {
        points = cachedLayout;
        layoutMethod = 'umap';
        return;
      }

      refiningLayout = true;
      // Terminate any previous computation outright rather than trying to
      // correlate stale worker messages — reduce.worker.ts's protocol has no
      // request id to check, so a live-but-superseded worker could otherwise
      // post a 'done' for the WRONG vectors into whatever handler is current.
      worker?.terminate();
      const activeWorker = new ReduceWorkerCtor();
      worker = activeWorker;
      activeWorker.onmessage = (event: MessageEvent<ReduceWorkerMessage>) => {
        if (myRequestId !== latestRequestId) return;
        const msg = event.data;
        if (msg.type === 'done') {
          points = msg.points;
          layoutMethod = 'umap';
          refiningLayout = false;
          void setCachedLayout(usedModelId, 'umap', msg.points, CORPUS_VERSION);
        } else if (msg.type === 'error') {
          refiningLayout = false;
          // The PCA layout already on screen is still an honest, valid
          // layout — a failed refinement isn't a fatal error for the page.
          console.warn('[embeddings] UMAP refinement failed, keeping the PCA layout:', msg.message);
        }
        // 'progress' (epoch/totalEpochs) is available but unused here — this
        // corpus is small enough that UMAP finishes in well under a second,
        // so the `refiningLayout` badge alone communicates the in-progress state.
      };
      const request: ReduceWorkerRequest = {
        vectors: outcomeVectors,
        dims: 3,
        opts: { seed: 1337 },
      };
      activeWorker.postMessage(request);
    } catch (err) {
      if (myRequestId !== latestRequestId) return;
      status = 'error';
      // A bare TypeError out of fetch means the request never reached the
      // server at all (DNS, connection refused, CORS preflight) — the raw
      // "Failed to fetch" tells a visitor nothing. The inference backend is
      // self-hosted, so being offline is an ordinary state worth naming.
      // Anything else (rate limit, 5xx) carries a real message; keep it.
      statusDetail =
        err instanceof TypeError
          ? t(lang, 'embeddings.statusOffline')
          : err instanceof Error
            ? err.message
            : undefined;
    }
  }

  // Single entry point: (re)runs whenever the selected model changes — but
  // gated on `awaitingConsent` so the very first load never fires on its
  // own. Once consent is given (button click, or a silent cache resume)
  // this behaves exactly as before, including for subsequent model swaps.
  $effect(() => {
    const modelId = selectedModelId;
    if (awaitingConsent) return;
    void loadAndReduce(modelId);
  });

  // Cheap, local, no-network check: if a previous visit already embedded
  // this corpus with the default model, resume instantly instead of
  // showing the button — Dexie reads aren't the heavy part, the model
  // download is.
  onMount(() => {
    void (async () => {
      try {
        const cached = await getCachedEmbeddings(DEFAULT_EMBEDDING_MODEL_ID, CORPUS_VERSION);
        if (cached && cached.vectors.length === corpusLabels.length) {
          awaitingConsent = false;
        }
      } finally {
        checkingCache = false;
      }
    })();
  });

  /** User-initiated: the only path (besides a cache hit) that's allowed to trigger the corpus-embedding call to the inference server. */
  function startLoading(): void {
    awaitingConsent = false;
  }

  function retry(): void {
    void loadAndReduce(selectedModelId);
  }

  onDestroy(() => {
    worker?.terminate();
    worker = null;
  });

  let activeModelInfo = $derived(activeModelId ? getEmbeddingModelInfo(activeModelId) : null);

  function getBackendInfo(
    backend: BackendDisplay | null
  ): { label: string; tooltip: string; tone: 'green' | 'blue' | 'muted' } | null {
    if (!backend) return null;
    switch (backend) {
      case 'server':
        return {
          label: t(lang, 'embeddings.backendServer'),
          tooltip: t(lang, 'embeddings.backendServerTooltip'),
          tone: 'green',
        };
      case 'cached':
        return {
          label: t(lang, 'embeddings.backendCached'),
          tooltip: t(lang, 'embeddings.backendCachedTooltip'),
          tone: 'muted',
        };
    }
  }
  let backendInfo = $derived(getBackendInfo(activeBackend));
</script>

<div class="embeddings glass-panel">
  <div class="embeddings__header">
    <div class="embeddings__header-row">
      <select
        bind:value={selectedModelId}
        class="embeddings__model-select"
        aria-label={t(lang, 'embeddings.modelLabel')}
      >
        {#each EMBEDDING_MODEL_LIST as mid (mid)}
          <option value={mid}>{getEmbeddingModelInfo(mid).name}</option>
        {/each}
      </select>

      {#if backendInfo}
        <span
          class="embeddings__badge embeddings__badge--{backendInfo.tone}"
          title={backendInfo.tooltip}
        >
          {backendInfo.label}
        </span>
      {/if}

      {#if downgraded}
        <span
          class="embeddings__badge embeddings__badge--amber"
          title={t(lang, 'embeddings.downgradeNotice')}
        >
          ⚠ {t(lang, 'embeddings.downgradeNotice')}
        </span>
      {/if}
    </div>

    {#if status === 'loading-model' || status === 'embedding'}
      <div class="embeddings__status-banner embeddings__status-banner--loading">
        <span class="embeddings__status-left">
          <span class="embeddings__micro-spinner" aria-hidden="true"></span>
          {statusDetail ||
            (status === 'loading-model'
              ? t(lang, 'embeddings.statusLoadingModel')
              : t(lang, 'embeddings.statusEmbedding'))}
        </span>
      </div>
    {:else if status === 'error'}
      <div class="embeddings__status-banner embeddings__status-banner--error" role="alert">
        <span>⚠️ {statusDetail || t(lang, 'embeddings.statusError')}</span>
        <button type="button" class="embeddings__retry-btn" onclick={retry}
          >{t(lang, 'embeddings.retry')}</button
        >
      </div>
    {/if}

    <div class="embeddings__stats">
      <div class="embeddings__stat-card">
        <span class="embeddings__stat-label">{t(lang, 'embeddings.corpusSize')}</span>
        <span class="embeddings__stat-value">{corpusLabels.length}</span>
      </div>
      <div class="embeddings__stat-card">
        <span class="embeddings__stat-label">{t(lang, 'embeddings.dimensions')}</span>
        <span class="embeddings__stat-value">{activeModelInfo?.dims ?? '—'}</span>
      </div>
      <div class="embeddings__stat-card">
        <span class="embeddings__stat-label">{t(lang, 'embeddings.computeLabel')}</span>
        <span class="embeddings__stat-value">{t(lang, 'embeddings.computeServer')}</span>
      </div>
    </div>
  </div>

  {#if checkingCache}
    <!-- Cheap local Dexie read only — never visible long enough to matter,
         but avoids a flash of "click to load" for a visitor who's already
         embedded this corpus before. -->
    <div class="embeddings__gate embeddings__gate--checking" aria-hidden="true">
      <span class="embeddings__micro-spinner"></span>
    </div>
  {:else if awaitingConsent}
    <div class="embeddings__gate">
      <p class="embeddings__gate-text">{t(lang, 'embeddings.gateDescription')}</p>
      <button type="button" class="embeddings__gate-btn" onclick={startLoading}>
        {t(lang, 'embeddings.gateButton')}
      </button>
    </div>
  {:else}
    <EmbeddingTabs {activeTab} {lang} onchange={(id) => (activeTab = id)} />

    {#if activeTab === 'explore'}
      <div
        class="embeddings__body"
        id="embeddings-panel-explore"
        role="tabpanel"
        aria-labelledby="embeddings-tab-explore"
      >
        <div class="embeddings__scene-panel">
          <EmbeddingScene
            {points}
            labels={corpusLabels}
            {clusterAssignments}
            {clusterNames}
            {showClusters}
            {highlighted}
            {scores}
            {lang}
          />

          {#if points.length > 0}
            <div class="embedding-scene__badges">
              <span
                class="embeddings__badge embedding-scene__layout-badge embeddings__badge--{layoutMethod ===
                'umap'
                  ? 'green'
                  : 'blue'}"
                title={layoutMethod === 'umap'
                  ? t(lang, 'embeddings.layoutUmapTooltip')
                  : t(lang, 'embeddings.layoutPcaTooltip')}
              >
                {layoutMethod === 'umap'
                  ? t(lang, 'embeddings.layoutUmap')
                  : t(lang, 'embeddings.layoutPca')}
              </span>

              {#if refiningLayout}
                <span
                  class="embedding-scene__refining"
                  title={t(lang, 'embeddings.refiningLayoutTooltip')}
                >
                  <span class="embeddings__micro-spinner" aria-hidden="true"></span>
                  {t(lang, 'embeddings.refiningLayout')}
                </span>
              {/if}
            </div>
          {/if}
        </div>

        <div class="embeddings__explore-side">
          {#if points.length > 0}
            <label class="embedding-cluster-toggle">
              <input type="checkbox" bind:checked={showClusters} />
              <span>{t(lang, 'embeddings.showClustersLabel')}</span>
            </label>

            {#if showClusters}
              <div class="embedding-cluster-controls">
                <label class="embedding-cluster-controls__row" for="embedding-cluster-k">
                  <span class="embeddings__field-label">
                    {t(lang, 'embeddings.clusterKLabel').replace('{k}', String(clusterK))}
                  </span>
                  <span
                    class="embedding-cluster-controls__silhouette"
                    title={t(lang, 'embeddings.clusterSilhouetteTooltip')}
                  >
                    {t(lang, 'embeddings.clusterSilhouetteLabel').replace(
                      '{score}',
                      silhouette.toFixed(2)
                    )}
                  </span>
                </label>
                <input
                  id="embedding-cluster-k"
                  type="range"
                  class="embeddings__range"
                  min="2"
                  max="8"
                  step="1"
                  bind:value={clusterK}
                />
                <p class="embedding-cluster-controls__note">
                  {t(lang, 'embeddings.clusterHonestNote')}
                </p>
              </div>

              <ul
                class="embedding-scene__legend"
                aria-label={t(lang, 'embeddings.clusterLegendLabel')}
              >
                {#each clusterLegend as entry (entry.name)}
                  <li class="embedding-scene__legend-item">
                    <span
                      class="embedding-scene__legend-swatch"
                      style="background-color: {entry.color}"
                      aria-hidden="true"
                    ></span>
                    <span class="embedding-scene__legend-name">{entry.name}</span>
                  </li>
                {/each}
              </ul>
            {/if}
          {/if}

          <SearchPanel
            corpusVectors={vectors}
            {corpusLabels}
            modelId={activeModelId}
            {lang}
            onResults={handleSearchResults}
          />
        </div>
      </div>
    {:else if activeTab === 'languages'}
      <div id="embeddings-panel-languages" role="tabpanel" aria-labelledby="embeddings-tab-languages">
        <LanguagesPanel {lang} modelId={activeModelId} />
      </div>
    {:else if activeTab === 'analogies'}
      <div id="embeddings-panel-analogies" role="tabpanel" aria-labelledby="embeddings-tab-analogies">
        <AnalogiesPanel {lang} modelId={activeModelId} />
      </div>
    {:else if activeTab === 'chunking'}
      <div id="embeddings-panel-chunking" role="tabpanel" aria-labelledby="embeddings-tab-chunking">
        <ChunkingPanel {lang} modelId={activeModelId} />
      </div>
    {:else if activeTab === 'retrieval'}
      <div
        id="embeddings-panel-retrieval"
        role="tabpanel"
        aria-labelledby="embeddings-tab-retrieval"
      >
        <RerankPanel corpusVectors={vectors} {corpusLabels} modelId={activeModelId} {lang} />
      </div>
    {/if}
  {/if}
</div>
