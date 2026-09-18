/**
 * chunking.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Text-splitting strategies for RAG ingestion. Every function returns
 * `Chunk[]` with `start`/`end` offsets into the ORIGINAL input text (not the
 * chunk's own local text), so a UI can highlight the source span a chunk
 * came from.
 */

import { cosineSimilarity } from './search';
import type { Chunk, EmbeddingVector } from './types';

function makeChunk(text: string, start: number, end: number, index: number): Chunk {
  return { id: `chunk-${index}-${start}`, text: text.slice(start, end), start, end };
}

/**
 * Fixed-size sliding-window chunking — the simplest, most common RAG
 * chunking strategy: cut `text` into `size`-character windows, stepping
 * forward by `size - overlap` each time so consecutive chunks share
 * `overlap` characters of context. The overlap exists so a sentence that
 * straddles a chunk boundary is still fully present in at least one chunk,
 * at the cost of some duplicated content in the index.
 */
export function chunkFixed(text: string, size: number, overlap: number = 0): Chunk[] {
  if (size <= 0) {
    throw new Error('[chunking] chunkFixed: size must be > 0');
  }
  if (text.length === 0) return [];

  const safeOverlap = Math.max(0, Math.min(overlap, size - 1));
  const step = size - safeOverlap;

  const chunks: Chunk[] = [];
  let start = 0;
  let index = 0;
  while (start < text.length) {
    const end = Math.min(start + size, text.length);
    chunks.push(makeChunk(text, start, end, index));
    index++;
    if (end >= text.length) break;
    start += step;
  }
  return chunks;
}

/**
 * Sentence-boundary chunking — one chunk per sentence. Splits on `.`, `!`,
 * `?` (runs of these, e.g. "?!" or "...", count as a single boundary) as
 * well as newlines, and trims surrounding whitespace from each resulting
 * chunk. A cheap, model-free alternative to fixed windows that keeps each
 * chunk a complete-ish thought instead of an arbitrary character cutoff.
 */
export function chunkBySentence(text: string): Chunk[] {
  const chunks: Chunk[] = [];
  const n = text.length;
  let index = 0;
  let segStart = 0;

  const pushSegment = (rawStart: number, rawEnd: number): void => {
    const raw = text.slice(rawStart, rawEnd);
    const trimmed = raw.trim();
    if (trimmed.length === 0) return;
    const leading = raw.length - raw.trimStart().length;
    const start = rawStart + leading;
    const end = start + trimmed.length;
    chunks.push(makeChunk(text, start, end, index));
    index++;
  };

  let i = 0;
  while (i < n) {
    const ch = text[i];
    if (ch === '.' || ch === '!' || ch === '?') {
      // Consume a run of terminators together (e.g. "?!", "...") as one boundary.
      let j = i + 1;
      while (j < n && (text[j] === '.' || text[j] === '!' || text[j] === '?')) j++;
      pushSegment(segStart, j);
      segStart = j;
      i = j;
      continue;
    }
    if (ch === '\n') {
      pushSegment(segStart, i);
      segStart = i + 1;
      i++;
      continue;
    }
    i++;
  }
  pushSegment(segStart, n);

  return chunks;
}

/** A minimal embedding function shape — matches `engine.ts`'s `embed()`. */
export type EmbedFn = (texts: string[]) => Promise<EmbeddingVector[]>;

/**
 * Semantic chunking — splits `text` into sentences (via `chunkBySentence`),
 * embeds each one with `embedFn`, and starts a new chunk whenever the cosine
 * similarity between two ADJACENT sentences drops below `threshold` (a topic
 * shift). Consecutive sentences that stay "on topic" get merged into one
 * chunk. This tracks actual topic boundaries in the source text rather than
 * cutting at arbitrary character counts or sentence counts, at the cost of
 * one embedding call per sentence.
 */
export async function chunkBySemantic(
  text: string,
  embedFn: EmbedFn,
  threshold: number = 0.5,
): Promise<Chunk[]> {
  const sentences = chunkBySentence(text);
  const first = sentences[0];
  if (sentences.length <= 1 || !first) return sentences;

  const vectors = await embedFn(sentences.map((s) => s.text));

  const groups: Chunk[][] = [[first]];
  for (let i = 1; i < sentences.length; i++) {
    const sentence = sentences[i];
    if (!sentence) continue;

    const prevVec = vectors[i - 1];
    const currVec = vectors[i];
    const sim = prevVec && currVec ? cosineSimilarity(prevVec, currVec) : 1;

    const lastGroup = groups[groups.length - 1];
    if (sim < threshold || !lastGroup) {
      groups.push([sentence]);
    } else {
      lastGroup.push(sentence);
    }
  }

  return groups.map((group, index) => mergeGroup(group, text, index));
}

/** Merges a run of adjacent sentence-Chunks into one Chunk spanning them all. */
function mergeGroup(group: Chunk[], text: string, index: number): Chunk {
  const first = group[0];
  const last = group[group.length - 1];
  const start = first ? first.start : 0;
  const end = last ? last.end : start;
  return makeChunk(text, start, end, index);
}
