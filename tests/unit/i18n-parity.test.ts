import { describe, expect, it } from 'vitest';
import en from '../../src/i18n/en.json';
import ru from '../../src/i18n/ru.json';

/**
 * Every user-facing page on this site exists in both locales, and `t()` resolves
 * a missing key to something the visitor can see. That makes a forgotten
 * translation an absence-shaped defect: nothing throws, no functional test
 * fails, and it is invisible to whoever is working in the other language. This
 * file is the guard.
 *
 * The one asymmetry that is CORRECT is plural categories. English distinguishes
 * singular from plural; Russian needs one/few/many. `pluralLabelFor` in
 * ChunkingPanel.svelte builds `${base}_one` or bare `${base}` for English, and
 * additionally `${base}_few` for Russian — so a `_few` key is Russian-only by
 * design, and an English one is dead weight that will never be read. (There was
 * exactly one, `embeddings.chunkingCount_few`; it is gone.)
 */

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

function leafKeys(value: Json, prefix = ''): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((v, i) => leafKeys(v, `${prefix}[${i}]`));
  }
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) =>
      leafKeys(v, prefix ? `${prefix}.${k}` : k)
    );
  }
  return [prefix];
}

function leafEntries(value: Json, prefix = ''): Array<[string, Json]> {
  if (Array.isArray(value)) {
    return value.flatMap((v, i) => leafEntries(v, `${prefix}[${i}]`));
  }
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) =>
      leafEntries(v, prefix ? `${prefix}.${k}` : k)
    );
  }
  return [[prefix, value]];
}

const enKeys = leafKeys(en as Json);
const ruKeys = leafKeys(ru as Json);
const enSet = new Set(enKeys);
const ruSet = new Set(ruKeys);

/** Russian-only plural category — see the file comment. */
const RU_ONLY_SUFFIX = '_few';

describe('i18n parity', () => {
  it('translates every English key into Russian', () => {
    expect(enKeys.filter((k) => !ruSet.has(k))).toEqual([]);
  });

  it('has no Russian key without an English counterpart, plurals aside', () => {
    const orphans = ruKeys.filter((k) => {
      if (enSet.has(k)) return false;
      if (!k.endsWith(RU_ONLY_SUFFIX)) return true;
      // A `_few` form is legitimate only if the base key it varies exists in EN.
      return !enSet.has(k.slice(0, -RU_ONLY_SUFFIX.length));
    });
    expect(orphans).toEqual([]);
  });

  it('carries no English `_few` key — English has no such plural category', () => {
    expect(enKeys.filter((k) => k.endsWith(RU_ONLY_SUFFIX))).toEqual([]);
  });

  it('has no blank string in either locale', () => {
    const blank = (entries: Array<[string, Json]>): string[] =>
      entries.filter(([, v]) => typeof v === 'string' && v.trim() === '').map(([k]) => k);
    expect(blank(leafEntries(en as Json))).toEqual([]);
    expect(blank(leafEntries(ru as Json))).toEqual([]);
  });

  it('keeps `{n}` placeholders on both sides of every plural pair', () => {
    // A translation that drops the placeholder renders "чанков" with no number.
    const withPlaceholder = leafEntries(en as Json)
      .filter(([, v]) => typeof v === 'string' && v.includes('{n}'))
      .map(([k]) => k);
    const ruMap = new Map(leafEntries(ru as Json));
    const dropped = withPlaceholder.filter((k) => {
      const v = ruMap.get(k);
      return typeof v === 'string' && !v.includes('{n}');
    });
    expect(dropped).toEqual([]);
  });

  /**
   * The asymmetry test above (line 59) correctly ALLOWS a `_few` key to
   * exist without an English counterpart — but "allowed" is not "required".
   * Deleting a `_few` key was exactly the regression that shipped once
   * already (`embeddings.chunkingCount_few`, see the file comment): every
   * test above still passes with it gone, because `t()` resolves a missing
   * RU key by falling back to the English string at runtime — no crash, no
   * red test, just a Russian visitor silently reading English.
   *
   * `pluralLabelFor` in ChunkingPanel.svelte is the one place in the
   * codebase that resolves a pluralized key, and it needs, per keyBase:
   * EN — bare key (english "many/other") + `_one` (n === 1).
   * RU — bare key (Slavic "many") + `_one` (n%10===1, n%100!==11) +
   *      `_few` (n%10 in 2..4, n%100 not in 12..14).
   * Deriving the required bases from every EN key ending in `_one` — rather
   * than hardcoding "chunkingCount" — means a future third pluralized
   * string is caught by this test the day it is added, not the day someone
   * notices Russian silently reads English.
   */
  it('has a complete RU plural family (base + `_one` + `_few`) for every English plural base', () => {
    const ONE_SUFFIX = '_one';
    const bases = enKeys
      .filter((k) => k.endsWith(ONE_SUFFIX))
      .map((k) => k.slice(0, -ONE_SUFFIX.length));
    // Guards the guard: if this ever hits 0, the derivation broke — it did
    // not mean the site stopped needing Russian plurals.
    expect(bases.length).toBeGreaterThan(0);
    for (const base of bases) {
      expect(ruSet.has(base), `${base}: RU missing the bare (many) form`).toBe(true);
      expect(ruSet.has(`${base}_one`), `${base}_one: RU missing`).toBe(true);
      expect(
        ruSet.has(`${base}${RU_ONLY_SUFFIX}`),
        `${base}${RU_ONLY_SUFFIX}: RU missing — English has no "few" category, so nothing ` +
          'else in this file would ever require it, and t() would silently fall back to the ' +
          'English string at runtime instead of throwing'
      ).toBe(true);
    }
  });
});
