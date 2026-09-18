# `src/components/blocks/`

Page-level blocks shared across `src/pages/[lang]/`. One file per block; the
recipe lives there, not in sixteen copies.

---

## `PageHero.astro`

The inner-page hero: art layer, glass plate under the copy, mono eyebrow,
split `h1`, scroll hint. Built from the measurement in
`.system/canon/92-hero-diff.md` (what is common vs. what is genuinely
per-page) with `.system/canon/01-hero.md` as the value reference.

**Not for the homepage.** `/` runs the scrub hero (`HeroCanvas.astro`, 800vh,
a 25.7 MB frame-seek video). One of those per site.

### Connecting it

```astro
---
import PageHero from '@components/blocks/PageHero.astro';
import heroArt from '@/assets/services/geo-audit-hero.png';
---

<PageHero
  lang={lang}
  eyebrow={rung.monoLabel}
  title={copy.h1}
  lede={copy.lede}
  image={heroArt}
  scrim="left"
  video={{ webm: '/geo-hero-loop.webm', mp4: '/geo-hero-loop.mp4' }}
  plexus={{ originX: 0.74, originY: 0.475 }}
  scrollTarget="#geo-mock"
>
  <div slot="under-lede">…CTA, links, whatever this page needs…</div>
</PageHero>
```

### Props

| Prop            | Type                             | Required | Notes                                                                                        |
| --------------- | -------------------------------- | :------: | -------------------------------------------------------------------------------------------- |
| `lang`          | `Lang`                           |   yes    | Locale for `hero.scroll`. Infrastructure, not a design knob.                                 |
| `eyebrow`       | `string`                         |   yes    | A leading `// ` is stripped and redrawn as `aria-hidden` — pass `services.ts` strings as-is. |
| `title`         | `string`                         |   yes    | Plain sentence. Split into words/letters here; the real text goes to `aria-label`.           |
| `lede`          | `string`                         |   yes    |                                                                                              |
| `scrollTarget`  | `string`                         |   yes    | `#id` or any CSS selector for the next section.                                              |
| `image`         | `ImageMetadata`                  |    no    | Import the master; widths are derived, never passed.                                         |
| `imagePosition` | `string`                         |    no    | `object-position`, e.g. `center 42%`, when a band of the frame must sit under the copy.      |
| `scrim`         | `'left' \| 'center' \| 'bottom'` |    no    | Default `bottom`. Direction only — the stops are fixed.                                      |
| `video`         | `{ webm: string; mp4: string }`  |    no    | Seamless loop over the still. Needs `image`.                                                 |
| `plexus`        | `{ originX; originY; anchor? }`  |    no    | Birth point of the network, in container fractions; `anchor` is `{ x, y, width, height }`.   |
| `align`         | `'center' \| 'top'`              |    no    | Default `center`. `top` seats the copy in the upper third.                                   |

Named slot `under-lede` — one optional block beneath the copy (CTA, links).
There is no prop for it and no prop for the plate.

### Deliberately not props

Title scale and measure, lede measure, art opacity, breathing parameters,
entrance timings, keyframe names, plate on/off, lede parallax. Each of these
varies across the current pages and none of the variations answers a question
about its page — seven title scales and four lede measures are exactly how the
sprawl happened. The plate is derived: art present → the copy gets a surface.

### Without an image

The art layer is not rendered, the plate is not applied (a plate over flat
obsidian is an empty frame), and the hero paints `--gradient-hero` instead —
the same substitute the two case pages already use. Everything else works.
`video` is ignored without `image`; the loop lives inside the art layer.

Note the owner's standing verdict all the same: a hero without art reads as
empty. Degrading gracefully is not permission to ship an artless hero.

Without `plexus` nothing is rendered and the copy is not lifted (there is
nothing on the negative layer to sit above). Without a findable `scrollTarget`
the button hides itself instead of staying visible and dead.

### What it does NOT do

- **No head preload.** Astro slots do not travel from a nested component up to
  `BaseLayout`'s `head` slot, so the hero's LCP preload stays on the page:

  ```text
  // page frontmatter
  const heroPreloads = await Promise.all(
    [768, 1280].map((width) => getImage({ src: heroArt, format: 'avif', width }))
  );
  const heroImagesrcset = heroPreloads.map((img, i) => `${img.src} ${[768, 1280][i]}w`).join(', ');
  …
  <link slot="head" rel="preload" as="image" imagesrcset={heroImagesrcset} imagesizes="100vw" />
  ```

  Keep the widths identical to the ones the component requests (`[768, 1280]`
  clamped to the master's own width) or the preload is a second download.

- **No page frame.** `.X-page`'s `padding-top`, `min-height` and background stay
  on the page. The hero's height reserve is computed from those same tokens, so
  changing the page padding without changing the reserve will desync them.

- **No CTA, no mailto block, no lede parallax, no magnetic button.** Anything
  under the lede is the caller's markup in the `under-lede` slot.

- **No styling of slotted content.** Astro scopes this component's CSS to its
  own markup; slotted markup carries the caller's scope. The component owns the
  slot's wrapper (and therefore the gap above it) and nothing inside it.

- **No i18n keys.** It reads exactly one existing key, `hero.scroll`.

### Traps this component already handles (do not "simplify" them away)

- `isolation: isolate` — the art sits on `z-index: -1` and paints behind the
  page's opaque background without a stacking context of its own.
- `min-height` declared twice, `vh` then `svh` — mobile URL-bar honesty.
- The mobile block is LAST in the stylesheet. Its rules override equal-
  specificity rules above them, so source order is the only thing deciding.
  The scroll hint's mobile position was lost twice on this project this way.
- `backdrop-filter` on the eyebrow is restated inside
  `@supports (backdrop-filter: blur(1px))` — without it a minifier ships only
  the `-webkit-` alias and Chromium renders no blur.
- The letter spans carry `text-shadow` and `-webkit-text-stroke-color` and
  nothing else. Any property creating a new rendering surface (transform,
  filter, opacity < 1, mask, will-change, position + z-index) breaks the
  clipped background and produces the "doubled first letter" bug.
- All motion is declared inside `@media (prefers-reduced-motion: no-preference)`
  — outside it elements are simply finished, never suppressed.

Regressions in the above are covered by `tests/unit/page-hero.test.ts`.
