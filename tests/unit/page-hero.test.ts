/**
 * PageHero lock.
 * ==============
 * This file does not restate the component; it guards the things that have
 * ALREADY broken on this project, each of them measured in
 * `.system/canon/92-hero-diff.md`:
 *
 *  - an equal-specificity mobile override placed BEFORE its base rule, which
 *    silently loses (the scroll hint's mobile position was lost twice, and six
 *    of the sixteen hand-written heroes still ship without the fix);
 *  - `backdrop-filter` declared once and pruned to the -webkit- alias by the
 *    minifier, so the glass ships with no blur;
 *  - the `7.5rem` chrome reserve: a literal standing in for a sum of three
 *    tokens, all three of which change at 767px;
 *  - a property on a letter span that creates a new rendering surface and
 *    breaks the clipped background ("doubled first letter", reported 3×);
 *  - motion declared unconditionally and then suppressed, instead of declared
 *    inside no-preference;
 *  - the prop surface growing until seven title scales exist again;
 *  - an EN i18n key with no RU twin.
 *
 * Allowed on purpose and therefore NOT flagged: viewport units (vh/svh), px
 * glow radii and hairline borders, and gradient stop percentages. None of
 * those has a token in global.css, and none of them is what drifted.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const src = readFileSync(resolve(root, 'src/components/blocks/PageHero.astro'), 'utf8');
const en = JSON.parse(readFileSync(resolve(root, 'src/i18n/en.json'), 'utf8')) as Record<
  string,
  Record<string, string>
>;
const ru = JSON.parse(readFileSync(resolve(root, 'src/i18n/ru.json'), 'utf8')) as Record<
  string,
  Record<string, string>
>;

/** The component's <style> block, comments removed. */
const css = (() => {
  const m = src.match(/<style>([\s\S]*?)<\/style>/);
  if (!m || !m[1]) throw new Error('PageHero.astro has no <style> block');
  return m[1].replace(/\/\*[\s\S]*?\*\//g, '');
})();

/** Everything above the closing `---` of the frontmatter. */
const frontmatter = src.slice(0, src.indexOf('\n---', 3));
/** …with its prose stripped, for assertions that must not match a comment. */
const frontmatterCode = frontmatter.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/**
 * CSS declarations, split so that a custom-property definition can be told
 * apart from a normal one even when it wraps across lines.
 */
function declarations(sheet: string): string[] {
  return sheet
    .split(';')
    .map((chunk) => {
      const cut = Math.max(chunk.lastIndexOf('{'), chunk.lastIndexOf('}'));
      return (cut >= 0 ? chunk.slice(cut + 1) : chunk).trim();
    })
    .filter(Boolean);
}

const nonTokenDecls = declarations(css).filter((d) => !d.startsWith('--'));

describe('PageHero — cascade order', () => {
  it('the mobile block is the LAST @media in the sheet', () => {
    const medias = [...css.matchAll(/@media[^{]*\{/g)].map((m) => ({
      at: m.index ?? -1,
      head: m[0],
    }));
    expect(medias.length).toBeGreaterThan(0);
    expect(medias[medias.length - 1]!.head).toMatch(/max-width:\s*767px/);
  });

  it('there is exactly one max-width: 767px block — the fix cannot be half-applied', () => {
    expect(css.match(/@media\s*\(max-width:\s*767px\)/g)).toHaveLength(1);
  });

  it('the scroll hint is un-pinned on mobile, AFTER its own absolute base rule', () => {
    const base = css.indexOf('.page-hero__scroll {');
    const mobile = css.search(/@media\s*\(max-width:\s*767px\)/);
    expect(base).toBeGreaterThan(-1);
    expect(mobile).toBeGreaterThan(base);

    const mobileBlock = css.slice(mobile);
    expect(mobileBlock).toMatch(/\.page-hero__scroll\s*\{[^}]*position:\s*static/);
    expect(mobileBlock).toMatch(/\.page-hero__scroll\s*\{[^}]*transform:\s*none/);
    expect(css.slice(base, mobile)).toMatch(/position:\s*absolute/);
  });
});

describe('PageHero — the traps that cost time before', () => {
  it('the header makes its own stacking context for the negative-z art', () => {
    expect(css).toMatch(/\.page-hero\s*\{[\s\S]*?isolation:\s*isolate/);
    expect(css).toMatch(/\.page-hero__art\s*\{[\s\S]*?z-index:\s*-1/);
  });

  it('min-height is declared twice, vh first then svh', () => {
    const vh = css.indexOf('min-height: calc(100vh');
    const svh = css.indexOf('min-height: calc(100svh');
    expect(vh).toBeGreaterThan(-1);
    expect(svh).toBeGreaterThan(vh);
    // dvh re-resolves as the mobile URL bar shows/hides and twitches the scene.
    expect(css).not.toMatch(/100dvh/);
  });

  it('the chrome reserve is computed from tokens, never the 7.5rem literal', () => {
    expect(css).not.toMatch(/7\.5rem/);
    expect(css).toMatch(/--hero-chrome:\s*calc\([^;]*var\(--space-10\)[^;]*var\(--space-6\)/);
    // …and it is recomputed on the mobile side, where all three inputs change.
    const mobile = css.slice(css.search(/@media\s*\(max-width:\s*767px\)/));
    expect(mobile).toMatch(/--hero-chrome:\s*calc\([^;]*var\(--space-4\)/);
    expect(mobile).toMatch(/--hero-nav-row:/);
  });

  it('backdrop-filter is restated inside @supports so a minifier cannot prune it', () => {
    expect(css).toMatch(/-webkit-backdrop-filter/);
    const supports = css.match(
      /@supports\s*\(backdrop-filter:\s*blur\(1px\)\)\s*\{[\s\S]*?\n {2}\}/
    );
    expect(supports).not.toBeNull();
    expect(supports![0]).toMatch(/backdrop-filter:\s*blur\(/);
  });

  it('the JPEG title fallback is its own @supports rule, not a second declaration', () => {
    const titleRule = css.match(/\.page-hero__title\s*\{[^}]*\}/);
    expect(titleRule).not.toBeNull();
    expect(titleRule![0].match(/background-image:/g)).toHaveLength(1);
    expect(css).toMatch(/@supports not \(background-image: image-set\([\s\S]*?neural-texture\.jpg/);
  });

  it('the law of the letter holds: no property that makes a new painting surface', () => {
    const letterRules = [...css.matchAll(/\.page-hero__(letter|word)[^{]*\{([^}]*)\}/g)].map(
      (m) => m[2] ?? ''
    );
    expect(letterRules.length).toBeGreaterThan(0);
    for (const body of letterRules) {
      expect(body).not.toMatch(
        /(^|[\s;])(transform|filter|opacity|mask|will-change|perspective|isolation|z-index|backdrop-filter)\s*:/
      );
    }
  });
});

describe('PageHero — motion is gated, never suppressed', () => {
  it('every animation shorthand is declared inside a no-preference block', () => {
    const gated = [...css.matchAll(/@media\s*\(prefers-reduced-motion:\s*no-preference\)/g)].map(
      (m) => m.index ?? 0
    );
    expect(gated.length).toBeGreaterThan(0);

    for (const m of css.matchAll(/(^|[\s;{])animation:\s*(?!none)/gm)) {
      const at = m.index ?? 0;
      const opensBefore = gated.filter((g) => g < at);
      expect(
        opensBefore.length,
        `an "animation:" at index ${at} sits outside prefers-reduced-motion: no-preference`
      ).toBeGreaterThan(0);
    }
  });

  it('reduced motion is never faked with !important', () => {
    expect(css).not.toMatch(/!important/);
  });

  it('the letter hover transition is switched off under reduce', () => {
    expect(css).toMatch(
      /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{\s*\.page-hero__letter\s*\{\s*transition:\s*none/
    );
  });
});

describe('PageHero — values come from tokens', () => {
  it('no colour literal outside the local scale block', () => {
    const offenders = nonTokenDecls.filter((d) => /hsla?\(|#[0-9a-fA-F]{3,8}\b/.test(d));
    expect(offenders).toEqual([]);
  });

  it('no clamp() and no bare rem/ch/em length outside the local scale block', () => {
    const offenders = nonTokenDecls.filter(
      (d) => /\bclamp\(/.test(d) || /(^|[^-\w(])\d*\.?\d+(rem|ch|em)\b/.test(d)
    );
    expect(offenders).toEqual([]);
  });

  it('the safe-area inset the etalons both forgot is under the scroll hint', () => {
    expect(css).toMatch(/bottom:\s*calc\([^;]*env\(safe-area-inset-bottom/);
  });
});

describe('PageHero — accessibility', () => {
  it('the h1 carries the real sentence and every split span is hidden', () => {
    expect(src).toMatch(/<h1[^>]*class="page-hero__title"[^>]*aria-label=\{title\}/);
    expect(src).toMatch(/<span class="page-hero__word" aria-hidden="true">/);
  });

  it('decorative layers are hidden from assistive tech', () => {
    expect(src).toMatch(/<div class="page-hero__art" aria-hidden="true">/);
    expect(src).toMatch(/<span aria-hidden="true">\/\/ <\/span>/);
    expect(src).toMatch(/<svg[\s\S]*?aria-hidden="true"[\s\S]*?>/);
  });

  it('the scroll hint is a real button with its own visible focus ring', () => {
    expect(src).toMatch(/<button\s+type="button"\s+class="page-hero__scroll/);
    expect(css).toMatch(/\.page-hero__scroll:focus-visible\s*\{[^}]*outline:\s*2px solid/);
    expect(css).not.toMatch(/outline:\s*none/);
  });

  it('the hint keeps a 44px pointer target floor', () => {
    expect(css).toMatch(/--hero-tap-min:\s*44px/);
    const rule = css.match(/\.page-hero__scroll\s*\{[^}]*\}/);
    expect(rule![0]).toMatch(/min-width:\s*var\(--hero-tap-min\)/);
    expect(rule![0]).toMatch(/min-height:\s*var\(--hero-tap-min\)/);
  });
});

describe('PageHero — degrades instead of breaking', () => {
  it('art, video and plexus are each rendered behind a guard', () => {
    expect(src).toMatch(/\{\s*image && \(/);
    expect(src).toMatch(/\{video && \(/);
    expect(src).toMatch(/\{\s*plexus && \(/);
  });

  it('an artless hero still has a ground to stand on', () => {
    expect(src).toMatch(/!hasArt && 'page-hero--artless'/);
    expect(css).toMatch(/\.page-hero--artless\s*\{[^}]*background:\s*var\(--gradient-hero\)/);
  });

  it('the plate is derived from the art, not a prop', () => {
    expect(frontmatter).toMatch(/const hasArt = Boolean\(image\)/);
    expect(src).toMatch(/hasArt && 'hero-plate'/);
    expect(frontmatter).not.toMatch(/\bplate\??:/);
  });

  it('the copy is lifted only when something sits on the negative layer', () => {
    expect(frontmatter).toMatch(/const hasUnderLayer = hasArt \|\| Boolean\(plexus\)/);
    expect(css).toMatch(/\.page-hero--layered \.container\s*\{[^}]*z-index:\s*1/);
  });

  it('a missing scroll target hides the button instead of leaving it dead', () => {
    expect(src).toMatch(/if \(!target\) \{\s*hint\.hidden = true;/);
  });

  it('requested widths can never exceed the master (the duplicate-URL bug)', () => {
    expect(frontmatterCode).toMatch(/const HERO_WIDTHS = \[768, 1280\] as const/);
    expect(frontmatterCode).toMatch(/HERO_WIDTHS\.filter\(\(w\) => w < image\.width\)/);
    // A width above the master clamps and emits a duplicate URL — the exact
    // bug already shipped at geo-audit/index.astro:574.
    expect(frontmatterCode).not.toMatch(/1920/);
  });
});

describe('PageHero — the prop surface stays closed', () => {
  it('exposes exactly the knobs the measurement justified', () => {
    const body = frontmatter.match(/interface Props \{([\s\S]*?)\n\}/);
    expect(body).not.toBeNull();
    const keys = [...body![1]!.matchAll(/^\s{2}([a-zA-Z]+)\??:/gm)].map((m) => m[1]);
    expect(keys.sort()).toEqual(
      [
        'align',
        'eyebrow',
        'image',
        'imagePosition',
        'lang',
        'lede',
        'plexus',
        'scrim',
        'scrollTarget',
        'title',
        'video',
      ].sort()
    );
  });

  it('the copy and the scroll target are required, the rest optional', () => {
    const body = frontmatter.match(/interface Props \{([\s\S]*?)\n\}/)![1]!;
    for (const required of ['lang', 'eyebrow', 'title', 'lede', 'scrollTarget']) {
      expect(body).toMatch(new RegExp(`^\\s{2}${required}:`, 'm'));
    }
    for (const optional of ['image', 'imagePosition', 'scrim', 'video', 'plexus', 'align']) {
      expect(body).toMatch(new RegExp(`^\\s{2}${optional}\\?:`, 'm'));
    }
  });

  it('the image is typed as ImageMetadata and nothing is typed as any', () => {
    expect(frontmatter).toMatch(/import type \{ ImageMetadata \} from 'astro'/);
    expect(frontmatter).toMatch(/image\?: ImageMetadata/);
    expect(src).not.toMatch(/(:|<)\s*any\b/);
  });

  it('the scrim is a closed set, not a free background string', () => {
    expect(frontmatter).toMatch(/scrim\?: 'left' \| 'center' \| 'bottom'/);
    for (const dir of ['left', 'center', 'bottom']) {
      expect(css).toMatch(new RegExp(`\\.page-hero--scrim-${dir} \\.page-hero__art::after`));
    }
  });

  it('the island is idle-hydrated, never client:load', () => {
    expect(src).toMatch(/client:idle/);
    expect(src).not.toMatch(/client:load/);
  });
});

describe('PageHero — i18n', () => {
  it('reads only hero.scroll, and that key exists in both locales', () => {
    const keys = [...src.matchAll(/t\(lang,\s*'([^']+)'\)/g)].map((m) => m[1]);
    expect(keys).toEqual(['hero.scroll']);
    expect(en['hero']?.['scroll']).toBeTruthy();
    expect(ru['hero']?.['scroll']).toBeTruthy();
  });
});
