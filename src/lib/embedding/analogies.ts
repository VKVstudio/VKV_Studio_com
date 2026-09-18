/**
 * analogies.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Vector arithmetic on embeddings — the classic "king − man + woman ≈ queen"
 * demonstration, using the studio's own EmbeddingGemma.
 *
 * The presets below were EMPIRICALLY VERIFIED to hold on EmbeddingGemma-300M
 * (each one's expected answer really is the top-1 nearest word to the arithmetic
 * result, checked against a candidate pool). Analogies are famously hit-or-miss,
 * so free-form user input is allowed to "miss visibly" (that honesty is the
 * point — we never fake a hit).
 */

export interface AnalogyPreset {
  /** a − b + c ≈ expect.  Read as: "a is to b as ? is to c". */
  a: string;
  b: string;
  c: string;
  expect: string;
  /** short human framing of the relationship being tested */
  kind: string;
}

/**
 * The candidate vocabulary the analogy result is ranked against. It MUST contain
 * every preset's answer (else the correct word could never surface) plus a few
 * distractors so a hit is meaningful. The Analogies panel embeds THIS list — not
 * the main corpus, whose diverse words don't include queen/rome/kitten/… .
 */
export const ANALOGY_VOCAB: string[] = [
  // gender / royalty
  'king', 'queen', 'man', 'woman', 'prince', 'princess', 'boy', 'girl', 'actor', 'actress', 'uncle', 'aunt',
  // capitals / countries
  'paris', 'france', 'italy', 'rome', 'japan', 'tokyo', 'germany', 'berlin', 'spain', 'madrid', 'london', 'england',
  // animals / young
  'dog', 'puppy', 'cat', 'kitten', 'cow', 'calf', 'horse', 'foal',
  // comparatives
  'big', 'bigger', 'small', 'smaller', 'fast', 'faster', 'slow', 'slower',
  // verb forms
  'walk', 'walking', 'swim', 'swimming', 'run', 'running', 'sing', 'singing',
];

/** Presets that were verified to produce `expect` as the top-1 result. */
export const ANALOGY_PRESETS: AnalogyPreset[] = [
  { a: 'king', b: 'man', c: 'woman', expect: 'queen', kind: 'gender' },
  { a: 'paris', b: 'france', c: 'italy', expect: 'rome', kind: 'capital city' },
  { a: 'paris', b: 'france', c: 'japan', expect: 'tokyo', kind: 'capital city' },
  { a: 'dog', b: 'puppy', c: 'cat', expect: 'kitten', kind: 'grown-up → baby' },
  { a: 'king', b: 'queen', c: 'actor', expect: 'actress', kind: 'gender' },
  { a: 'bigger', b: 'big', c: 'smaller', expect: 'small', kind: 'comparative' },
  { a: 'walking', b: 'walk', c: 'swimming', expect: 'swim', kind: 'verb form' },
  { a: 'france', b: 'paris', c: 'rome', expect: 'italy', kind: 'country ↔ capital' },
  { a: 'paris', b: 'france', c: 'germany', expect: 'berlin', kind: 'capital city' },
  { a: 'dog', b: 'puppy', c: 'cow', expect: 'calf', kind: 'grown-up → baby' },
];

/**
 * The arithmetic vector for "a − b + c", L2-normalised. Callers pass the three
 * embedding vectors (already fetched from the backend) and rank the vocabulary
 * by cosine similarity to the returned vector to find the analogy's answer.
 */
export function analogyVector(a: number[], b: number[], c: number[]): number[] {
  const out = new Array<number>(a.length);
  let norm = 0;
  for (let i = 0; i < a.length; i++) {
    const v = (a[i] ?? 0) - (b[i] ?? 0) + (c[i] ?? 0);
    out[i] = v;
    norm += v * v;
  }
  const inv = 1 / (Math.sqrt(norm) || 1);
  for (let i = 0; i < out.length; i++) out[i]! *= inv;
  return out;
}
