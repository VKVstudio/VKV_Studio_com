/**
 * corpus.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Bundled demo corpus for the Embedding Explorer — short, factual passages
 * about AI/RAG/vector search/web engineering/on-device ML that become the
 * searchable, visualized points. Raw vectors are intentionally NOT bundled
 * or precomputed here; they're computed lazily in-browser by `engine.ts` and
 * cached via the Dexie helpers below (reusing the `dexie` dependency already
 * used by `src/lib/synapse-db.ts`) so repeat visits skip recomputation.
 */

import Dexie, { type EntityTable } from 'dexie';
import type { EmbeddingVector, ReducedPoint } from './types';

/**
 * One demo item. `text` is what gets embedded (a single everyday word); `label`
 * is what's shown for it (identical here). There is DELIBERATELY no `category`
 * field: the redesigned Explorer never colours by a human taxonomy — structure
 * is DISCOVERED (see `cluster.ts`, k-means over the raw vectors) and clusters are
 * named only after the fact. The corpus is a broad, un-curated spread of common
 * words across many domains so any grouping that appears is the model's, not the
 * author's.
 */
export interface CorpusPassage {
  id: string;
  text: string;
  label: string;
}

/**
 * Bump this when `DEMO_CORPUS` below changes content — it's part of the Dexie
 * cache key, so a version bump invalidates previously-cached embeddings/layouts
 * computed against the old corpus.
 */
export const CORPUS_VERSION = 3;

/**
 * ~110 common English WORDS spanning many domains (living things, food, nature,
 * machines, the body, emotions, abstract ideas, jobs, tech, places, time, …),
 * intentionally NOT pre-sorted into tidy families. The Explorer embeds these
 * with EmbeddingGemma, and any structure you see (living vs man-made, concrete
 * vs abstract, …) is what the MODEL organised — discovered by unsupervised
 * clustering, never assigned here.
 */
export const DEMO_CORPUS: CorpusPassage[] = (
  [
    // living things
    'cat',
    'dog',
    'horse',
    'elephant',
    'lion',
    'dolphin',
    'eagle',
    'shark',
    'bee',
    'snake',
    'tree',
    'flower',
    'grass',
    'mushroom',
    // food & drink
    'apple',
    'banana',
    'bread',
    'cheese',
    'pizza',
    'coffee',
    'rice',
    'egg',
    'soup',
    'chocolate',
    'wine',
    // the body
    'hand',
    'eye',
    'heart',
    'brain',
    'bone',
    'blood',
    'skin',
    'tooth',
    // nature & weather
    'mountain',
    'river',
    'ocean',
    'forest',
    'desert',
    'rain',
    'snow',
    'thunder',
    'cloud',
    'fire',
    'ice',
    'wind',
    'star',
    // machines & vehicles
    'car',
    'truck',
    'airplane',
    'bicycle',
    'train',
    'boat',
    'rocket',
    'engine',
    // home & objects
    'chair',
    'table',
    'bed',
    'lamp',
    'door',
    'window',
    'mirror',
    'clock',
    'knife',
    'key',
    // music
    'guitar',
    'piano',
    'violin',
    'drum',
    'song',
    'melody',
    // emotions
    'joy',
    'fear',
    'anger',
    'love',
    'sadness',
    'hope',
    'pride',
    'shame',
    // colours
    'red',
    'blue',
    'green',
    'black',
    'white',
    // clothing
    'shirt',
    'shoe',
    'hat',
    'dress',
    'coat',
    // people & jobs
    'doctor',
    'teacher',
    'artist',
    'soldier',
    'farmer',
    'scientist',
    'mother',
    'father',
    'child',
    'friend',
    // technology
    'computer',
    'robot',
    'internet',
    'algorithm',
    'data',
    'code',
    'network',
    // abstract ideas
    'time',
    'money',
    'power',
    'freedom',
    'justice',
    'truth',
    'death',
    'war',
    'peace',
    'religion',
    'language',
    // places
    'city',
    'village',
    'school',
    'hospital',
    'church',
    'market',
    // actions
    'run',
    'jump',
    'sleep',
    'eat',
    'think',
    'sing',
    'write',
    'dance',
  ] as const
).map((word, i) => ({ id: `w${String(i + 1).padStart(3, '0')}`, text: word, label: word }));

// ─── Dexie-based embedding/layout cache ────────────────────────────────────
// Keyed by modelId + corpusVersion, so switching embedding models or bumping
// the corpus content correctly invalidates old cached vectors instead of
// silently mixing vectors from different models/corpora.

interface CachedEmbeddingsRow {
  key: string;
  modelId: string;
  corpusVersion: number;
  chunkIds: string[];
  vectors: EmbeddingVector[];
  createdAt: number;
}

type LayoutMethod = 'pca' | 'umap';

interface CachedLayoutRow {
  key: string;
  modelId: string;
  corpusVersion: number;
  method: LayoutMethod;
  points: ReducedPoint[];
  createdAt: number;
}

const cacheDb = new Dexie('EmbeddingExplorerCache') as Dexie & {
  embeddings: EntityTable<CachedEmbeddingsRow, 'key'>;
  layouts: EntityTable<CachedLayoutRow, 'key'>;
};

cacheDb.version(1).stores({
  embeddings: 'key, modelId, corpusVersion',
  layouts: 'key, modelId, corpusVersion, method',
});

function embeddingsCacheKey(modelId: string, corpusVersion: number): string {
  return `${modelId}::v${corpusVersion}`;
}

function layoutCacheKey(modelId: string, corpusVersion: number, method: LayoutMethod): string {
  return `${modelId}::v${corpusVersion}::${method}`;
}

/**
 * Looks up previously-computed embeddings for `modelId` + `corpusVersion`.
 * Returns `undefined` on a cache miss (first visit, or after a model/corpus
 * version change) — callers should compute and then call
 * `setCachedEmbeddings` to populate the cache for next time.
 */
export async function getCachedEmbeddings(
  modelId: string,
  corpusVersion: number = CORPUS_VERSION
): Promise<{ chunkIds: string[]; vectors: EmbeddingVector[] } | undefined> {
  const row = await cacheDb.embeddings.get(embeddingsCacheKey(modelId, corpusVersion));
  return row ? { chunkIds: row.chunkIds, vectors: row.vectors } : undefined;
}

/** Stores computed corpus embeddings for `modelId` + `corpusVersion`. */
export async function setCachedEmbeddings(
  modelId: string,
  chunkIds: string[],
  vectors: EmbeddingVector[],
  corpusVersion: number = CORPUS_VERSION
): Promise<void> {
  await cacheDb.embeddings.put({
    key: embeddingsCacheKey(modelId, corpusVersion),
    modelId,
    corpusVersion,
    chunkIds,
    vectors,
    createdAt: Date.now(),
  });
}

/**
 * Looks up a previously-computed dimensionality-reduction layout (`'pca'` or
 * `'umap'`) for `modelId` + `corpusVersion`. Returns `undefined` on a miss.
 */
export async function getCachedLayout(
  modelId: string,
  method: LayoutMethod,
  corpusVersion: number = CORPUS_VERSION
): Promise<ReducedPoint[] | undefined> {
  const row = await cacheDb.layouts.get(layoutCacheKey(modelId, corpusVersion, method));
  return row?.points;
}

/** Stores a computed dimensionality-reduction layout for `modelId` + `corpusVersion`. */
export async function setCachedLayout(
  modelId: string,
  method: LayoutMethod,
  points: ReducedPoint[],
  corpusVersion: number = CORPUS_VERSION
): Promise<void> {
  await cacheDb.layouts.put({
    key: layoutCacheKey(modelId, corpusVersion, method),
    modelId,
    corpusVersion,
    method,
    points,
    createdAt: Date.now(),
  });
}

/** Clears all cached embeddings and layouts (e.g. dev tooling, or a manual cache reset). */
export async function clearEmbeddingCache(): Promise<void> {
  await cacheDb.transaction('rw', [cacheDb.embeddings, cacheDb.layouts], async () => {
    await cacheDb.embeddings.clear();
    await cacheDb.layouts.clear();
  });
}
