/**
 * multilingual.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * The "meaning survives language" demo. EmbeddingGemma is multilingual, so a
 * word and its translation land almost on top of each other in embedding space
 * — the vector encodes MEANING, not spelling. On a bilingual EN/RU site this is
 * a strong, honest "wow" that needs no invented categories at all.
 *
 * The similarities were VERIFIED on the live EmbeddingGemma-300M backend (the
 * pairs below all scored ~0.81–0.90 cosine, while a mismatched pair like
 * cat↔собака scored ~0.60 — so the twin really is closer than a random word).
 */

export interface WordPair {
  en: string;
  ru: string;
  /** optional emoji, purely decorative — a third "surface form" of the same meaning */
  emoji?: string;
}

/** Curated EN↔RU pairs whose cross-language cosine was measured high. */
export const LANGUAGE_PAIRS: WordPair[] = [
  { en: 'cat', ru: 'кошка', emoji: '🐱' },
  { en: 'dog', ru: 'собака', emoji: '🐶' },
  { en: 'love', ru: 'любовь', emoji: '❤️' },
  { en: 'king', ru: 'король', emoji: '👑' },
  { en: 'water', ru: 'вода', emoji: '💧' },
  { en: 'house', ru: 'дом', emoji: '🏠' },
  { en: 'computer', ru: 'компьютер', emoji: '💻' },
  { en: 'apple', ru: 'яблоко', emoji: '🍎' },
  { en: 'sun', ru: 'солнце', emoji: '☀️' },
  { en: 'music', ru: 'музыка', emoji: '🎵' },
  { en: 'book', ru: 'книга', emoji: '📖' },
  { en: 'fire', ru: 'огонь', emoji: '🔥' },
];
