/**
 * Lab Quest Phase C — pure-function regression tests for lib/embedding/chunking.ts.
 * =============================================================================
 * Covers the three chunking strategies behind the Chunking tab: fixed-size
 * sliding window (offsets + overlap), sentence-boundary splitting, and
 * semantic (embedding-similarity-driven) merging. `chunkFixed`/
 * `chunkBySentence` are pure and synchronous; `chunkBySemantic` takes an
 * injected `embedFn`, so it's tested here with a deterministic stub — no
 * network, no real model.
 */
import { describe, it, expect } from 'vitest';
import { chunkFixed, chunkBySentence, chunkBySemantic } from '@/lib/embedding/chunking';
import type { EmbeddingVector } from '@/lib/embedding/types';

// ─── chunkFixed ──────────────────────────────────────────────────────────────

describe('chunkFixed', () => {
  it('cuts text into size-length windows with correct start/end offsets', () => {
    const text = '0123456789'; // 10 chars
    const chunks = chunkFixed(text, 4, 0);
    expect(chunks.map((c) => [c.start, c.end])).toEqual([
      [0, 4],
      [4, 8],
      [8, 10],
    ]);
    expect(chunks.map((c) => c.text)).toEqual(['0123', '4567', '89']);
  });

  it('steps forward by size-overlap, so consecutive chunks share `overlap` characters', () => {
    const text = '0123456789';
    const chunks = chunkFixed(text, 4, 2); // step = 4-2 = 2
    expect(chunks.map((c) => [c.start, c.end])).toEqual([
      [0, 4],
      [2, 6],
      [4, 8],
      [6, 10],
    ]);
    // The overlap region between consecutive chunks is literally shared text.
    expect(chunks[0]?.text.slice(-2)).toBe(chunks[1]?.text.slice(0, 2));
  });

  it('clamps overlap to size-1 so step never reaches 0 (no infinite loop)', () => {
    const text = '0'.repeat(20);
    const chunks = chunkFixed(text, 5, 100); // overlap way larger than size
    // step = size - clamp(overlap, 0, size-1) = 5 - 4 = 1
    expect(chunks[1]?.start).toBe(1);
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('throws for a non-positive size', () => {
    expect(() => chunkFixed('hello', 0)).toThrow();
    expect(() => chunkFixed('hello', -5)).toThrow();
  });

  it('returns an empty array for empty input', () => {
    expect(chunkFixed('', 10)).toEqual([]);
  });

  it('defaults overlap to 0 when omitted', () => {
    const text = '01234567';
    expect(chunkFixed(text, 4)).toEqual(chunkFixed(text, 4, 0));
  });
});

// ─── chunkBySentence ─────────────────────────────────────────────────────────

describe('chunkBySentence', () => {
  it('splits on ./!/? boundaries and trims surrounding whitespace', () => {
    const text = 'First sentence. Second sentence! Third sentence?';
    const chunks = chunkBySentence(text);
    expect(chunks.map((c) => c.text)).toEqual([
      'First sentence.',
      'Second sentence!',
      'Third sentence?',
    ]);
  });

  it('treats a run of terminators (e.g. "?!" or "...") as ONE boundary, not several near-empty ones', () => {
    const text = 'Wait, really?! Yes... absolutely.';
    const chunks = chunkBySentence(text);
    // "?!" doesn't split into "?" + "!" chunks, and "..." doesn't split into
    // three "." chunks — each run collapses to a single cut point.
    expect(chunks.map((c) => c.text)).toEqual(['Wait, really?!', 'Yes...', 'absolutely.']);
  });

  it('splits on newlines even without terminal punctuation', () => {
    const text = 'Line one\nLine two\nLine three.';
    const chunks = chunkBySentence(text);
    expect(chunks.map((c) => c.text)).toEqual(['Line one', 'Line two', 'Line three.']);
  });

  it('drops empty segments (e.g. consecutive blank lines) instead of emitting blank chunks', () => {
    const text = 'First.\n\n\nSecond.';
    const chunks = chunkBySentence(text);
    expect(chunks.every((c) => c.text.length > 0)).toBe(true);
    expect(chunks.map((c) => c.text)).toEqual(['First.', 'Second.']);
  });

  it('offsets point back into the ORIGINAL text, not the trimmed chunk', () => {
    const text = 'A. B.';
    const chunks = chunkBySentence(text);
    const second = chunks[1];
    expect(second?.text).toBe('B.');
    // "B." starts at index 3 in "A. B." (after "A. ")
    expect(second?.start).toBe(3);
    expect(text.slice(second?.start ?? 0, second?.end ?? 0)).toBe('B.');
  });

  it('returns an empty array for empty/whitespace-only input', () => {
    expect(chunkBySentence('')).toEqual([]);
    expect(chunkBySentence('   \n  ')).toEqual([]);
  });
});

// ─── chunkBySemantic ─────────────────────────────────────────────────────────

describe('chunkBySemantic', () => {
  const text =
    'Cats are pets. Dogs are pets too. The stock market fell today. Bonds rallied instead.';

  it('merges adjacent sentences above the similarity threshold and splits below it', async () => {
    // Deterministic stub embedder: sentence 0/1 ("pets") get an identical
    // vector (similarity 1, well above threshold → merge); sentence 2/3
    // ("markets") get a different identical vector. The 1↔2 boundary drops
    // to similarity 0 (well below threshold → split).
    const vectors: EmbeddingVector[] = [
      [1, 0],
      [1, 0],
      [0, 1],
      [0, 1],
    ];
    const stubEmbed = async (texts: string[]): Promise<EmbeddingVector[]> =>
      texts.map((_, i) => vectors[i] ?? [0, 0]);

    const sentences = chunkBySentence(text);
    expect(sentences).toHaveLength(4); // sanity: the fixture text really has 4 sentences

    const chunks = await chunkBySemantic(text, stubEmbed, 0.5);

    expect(chunks).toHaveLength(2);
    // First merged chunk spans sentence 0 through sentence 1.
    expect(chunks[0]?.start).toBe(sentences[0]?.start);
    expect(chunks[0]?.end).toBe(sentences[1]?.end);
    // Second merged chunk spans sentence 2 through sentence 3.
    expect(chunks[1]?.start).toBe(sentences[2]?.start);
    expect(chunks[1]?.end).toBe(sentences[3]?.end);
  });

  it('never merges anything when every adjacent pair falls below threshold (one chunk per sentence)', async () => {
    const orthogonalVectors: EmbeddingVector[] = [
      [1, 0],
      [0, 1],
      [1, 0],
      [0, 1],
    ];
    const stubEmbed = async (texts: string[]): Promise<EmbeddingVector[]> =>
      texts.map((_, i) => orthogonalVectors[i] ?? [0, 0]);

    const sentences = chunkBySentence(text);
    const chunks = await chunkBySemantic(text, stubEmbed, 0.5);
    expect(chunks).toHaveLength(sentences.length);
  });

  it('merges everything into one chunk when every adjacent pair is above threshold', async () => {
    const identicalVectors: EmbeddingVector[] = [
      [1, 0],
      [1, 0],
      [1, 0],
      [1, 0],
    ];
    const stubEmbed = async (texts: string[]): Promise<EmbeddingVector[]> =>
      texts.map((_, i) => identicalVectors[i] ?? [0, 0]);

    const chunks = await chunkBySemantic(text, stubEmbed, 0.5);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.text).toBe(text);
  });

  it('returns the single sentence unchanged (no embed call) when there is only one sentence', async () => {
    let called = false;
    const stubEmbed = async (texts: string[]): Promise<EmbeddingVector[]> => {
      called = true;
      return texts.map(() => [1, 0]);
    };
    const chunks = await chunkBySemantic('Only one sentence here.', stubEmbed, 0.5);
    expect(chunks).toHaveLength(1);
    expect(called).toBe(false);
  });
});
