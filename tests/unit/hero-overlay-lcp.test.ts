/**
 * HeroOverlay LCP + cascade lock.
 * ===============================
 * The homepage's LCP element is hero TEXT — `p.hero-overlay__subtitle` on
 * mobile, and on desktop either that line or the clipped-texture headline
 * (.system/metrics/p1-lcp.md, p6-lcp-chain.md: no resource, only an "element
 * render delay"). Chrome refuses to record text at opacity 0 and, once a
 * fade-from-0 is running, waits for the animation to END before it takes
 * the paint time. Measured on an isolated replica of the hero, mobile
 * profile, 2026-09-20: opacity 0 -> 1 with a 0.7 s delay + 0.8 s ease gave a
 * 1553 ms render delay; the same fade from a 0.45 floor gave 196 ms.
 *
 * Wave 1 then put the subtitle on screen BEFORE the headline (its floor was
 * the only painted text for the first 0.4 s), left the H1 at a 0-floor, and
 * hung a halo behind background-clip text that in fact painted over it.
 * This file locks what the 2026-09-21 rewrite settled on:
 *
 *  - both LCP candidates (H1 and subtitle) start their entrance ABOVE 0, the
 *    subtitle never above the headline, and the label never below the H1;
 *  - the cascade order is label → headline → line → CTA → ghost: each starts
 *    no later and ends no later than the next, with one easing curve, which
 *    together with the ordered floors keeps the painted opacity ordered at
 *    every instant;
 *  - no @keyframes animates a paint property (the full list, not three of
 *    them — wave 1's shimmer animated background-position and passed);
 *  - the label's breathing lives on two transparent text twins that
 *    cross-fade opacity only, with the exact old text-shadow values, and the
 *    subtitle has no pseudo halo at all;
 *  - every animation and transition in the sheet is switched off inside the
 *    prefers-reduced-motion: reduce block — found by walking balanced braces,
 *    not by a regex that runs across @media boundaries;
 *  - the `@supports not (background-clip: text)` fallback is the LAST rule;
 *  - the page head preloads exactly the texture files the H1 uses: the mobile
 *    one under the component's own mobile media query, the desktop one under
 *    a pointer/hover query (see that test for why not the complement).
 *
 * Every assertion here parses the CSS with a brace-aware walker and compares
 * exact declaration values. Each one was mutation-proved against the real
 * file (see the wave-3 report): the listed mutations make this file fail.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const svelte = readFileSync(resolve(root, 'src/components/ui/HeroOverlay.svelte'), 'utf8');
const astro = readFileSync(resolve(root, 'src/pages/[lang]/index.astro'), 'utf8');

/* ── A small, brace-aware CSS reader ─────────────────────────────────── */

interface Block {
  /** Selector list or at-rule prelude, whitespace collapsed. */
  prelude: string;
  /** Raw text between the braces (declarations, or nested blocks). */
  body: string;
  /** Nested blocks (for @media / @supports / @keyframes). */
  children: Block[];
}

/** Strip /* *\/ comments, then walk balanced braces into a block tree. */
function parseBlocks(src: string): Block[] {
  const out: Block[] = [];
  let i = 0;
  let preludeStart = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '{') {
      const prelude = src.slice(preludeStart, i).replace(/\s+/g, ' ').trim();
      let depth = 1;
      let j = i + 1;
      while (j < src.length && depth > 0) {
        if (src[j] === '{') depth++;
        else if (src[j] === '}') depth--;
        j++;
      }
      const body = src.slice(i + 1, j - 1);
      out.push({ prelude, body, children: body.includes('{') ? parseBlocks(body) : [] });
      i = j;
      preludeStart = j;
    } else if (ch === ';') {
      preludeStart = i + 1;
      i++;
    } else {
      i++;
    }
  }
  return out;
}

const cssSource = (() => {
  const m = svelte.match(/<style>([\s\S]*?)<\/style>/);
  if (!m || !m[1]) throw new Error('HeroOverlay.svelte has no <style> block');
  return m[1].replace(/\/\*[\s\S]*?\*\//g, '');
})();
const sheet = parseBlocks(cssSource);

/** Declarations of a body in source order; the last one for a property wins. */
function decls(body: string): { prop: string; value: string }[] {
  return body
    .split(';')
    .map((d) => d.trim())
    .filter((d) => d.includes(':'))
    .map((d) => {
      const at = d.indexOf(':');
      return {
        prop: d.slice(0, at).trim(),
        value: d
          .slice(at + 1)
          .replace(/\s+/g, ' ')
          .trim(),
      };
    });
}

function decl(body: string, prop: string): string | undefined {
  const all = decls(body).filter((d) => d.prop === prop);
  return all.length ? all[all.length - 1]!.value : undefined;
}

const selectorsOf = (prelude: string) => prelude.split(',').map((s) => s.trim());

/** Every block (in `within`, default: top level) whose selector list contains `selector` exactly. */
function rulesFor(selector: string, within: Block[] = sheet): Block[] {
  return within.filter(
    (b) => !b.prelude.startsWith('@') && selectorsOf(b.prelude).includes(selector)
  );
}

/** All declarations that apply to `selector`, in cascade (source) order. */
function styleOf(selector: string, within: Block[] = sheet): string {
  const rules = rulesFor(selector, within);
  if (rules.length === 0) throw new Error(`no rule for ${selector}`);
  return rules.map((r) => r.body).join(';');
}

function atRules(name: string): Block[] {
  return sheet.filter((b) => b.prelude.startsWith(name));
}

function keyframes(name: string): Block {
  const kf = sheet.find((b) => b.prelude === `@keyframes ${name}`);
  if (!kf) throw new Error(`no @keyframes ${name}`);
  return kf;
}

/** The `from` / `0%` stop of a keyframes block (a stop list like "0%, 60%" counts). */
function fromStop(kf: Block): Block {
  const stop = kf.children.find((c) =>
    selectorsOf(c.prelude).some((s) => s === 'from' || s === '0%')
  );
  if (!stop) throw new Error(`${kf.prelude} has no from/0% stop`);
  return stop;
}

interface Anim {
  name: string;
  duration: number;
  delay: number;
  easing: string;
  infinite: boolean;
}

const KEYWORDS = new Set([
  'infinite',
  'backwards',
  'forwards',
  'both',
  'none',
  'normal',
  'reverse',
  'alternate',
  'alternate-reverse',
  'running',
  'paused',
]);
const EASINGS =
  /^(ease|ease-in|ease-out|ease-in-out|linear|step-start|step-end|cubic-bezier\(.*\)|steps\(.*\))$/;
const seconds = (tok: string) => (tok.endsWith('ms') ? parseFloat(tok) / 1000 : parseFloat(tok));

/** Parse an `animation:` shorthand into its comma groups. */
function animations(body: string): Anim[] {
  const value = decl(body, 'animation');
  if (!value || value === 'none') return [];
  // Split on commas outside parentheses (cubic-bezier has its own commas).
  const groups: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of value) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      groups.push(cur);
      cur = '';
    } else cur += ch;
  }
  groups.push(cur);
  return groups.map((g) => {
    const toks = g.trim().split(/\s+/);
    const times = toks.filter((t) => /^-?\d*\.?\d+m?s$/.test(t));
    const name =
      toks.find((t) => /^[a-z][\w-]*$/i.test(t) && !KEYWORDS.has(t) && !EASINGS.test(t)) ?? '';
    return {
      name,
      duration: times[0] ? seconds(times[0]) : 0,
      delay: times[1] ? seconds(times[1]) : 0,
      easing: toks.find((t) => EASINGS.test(t)) ?? 'ease',
      infinite: toks.includes('infinite'),
    };
  });
}

/** The one animation of `selector` whose keyframes declare opacity. */
function opacityEntrance(selector: string): { anim: Anim; floor: number } {
  const withOpacity = animations(styleOf(selector)).filter((a) => {
    const from = fromStop(keyframes(a.name));
    return decl(from.body, 'opacity') !== undefined;
  });
  expect(withOpacity, `${selector}: exactly one opacity-bearing animation`).toHaveLength(1);
  const anim = withOpacity[0]!;
  const raw = decl(fromStop(keyframes(anim.name)).body, 'opacity')!;
  expect(raw, `${selector}: the from-opacity must be a plain number`).toMatch(/^\d*\.?\d+$/);
  return { anim, floor: parseFloat(raw) };
}

/* ── 1. Both LCP candidates paint from the first frame ───────────────── */

describe('HeroOverlay — the LCP candidates are recorded at first paint', () => {
  const label = opacityEntrance('.hero-overlay__label');
  const title = opacityEntrance('.hero-overlay__title');
  const subtitle = opacityEntrance('.hero-overlay__subtitle');

  it('the subtitle runs exactly one animation, and it is finite', () => {
    const all = animations(styleOf('.hero-overlay__subtitle'));
    expect(all).toHaveLength(1);
    expect(all[0]!.infinite).toBe(false);
  });

  it('the headline entrance starts above opacity 0', () => {
    expect(title.floor).toBeGreaterThan(0);
  });

  it('the subtitle entrance starts above opacity 0', () => {
    expect(subtitle.floor).toBeGreaterThan(0);
  });

  it('the floors are ordered label >= headline >= subtitle, and the line reads as absent', () => {
    expect(label.floor).toBeGreaterThanOrEqual(title.floor);
    expect(title.floor).toBeGreaterThanOrEqual(subtitle.floor);
    // 0.45 was legible on its own (wave-3 audit); the line must sit under the
    // headline until the headline has landed.
    expect(subtitle.floor).toBeLessThanOrEqual(0.15);
  });
});

/* ── 2. The cascade order ────────────────────────────────────────────── */

describe('HeroOverlay — label → headline → line → CTA → ghost, at every instant', () => {
  const order = [
    '.hero-overlay__label',
    '.hero-overlay__title',
    '.hero-overlay__subtitle',
    '.hero-overlay__cta',
    '.hero-overlay__cta-ghost',
  ];
  const beats = order.map((sel) => ({ sel, ...opacityEntrance(sel) }));

  it('the label leads: every beat starts no later, and ends no later, than the next', () => {
    for (let i = 0; i + 1 < beats.length; i++) {
      const a = beats[i]!;
      const b = beats[i + 1]!;
      expect(a.anim.delay, `${a.sel} starts after ${b.sel}`).toBeLessThanOrEqual(b.anim.delay);
      expect(a.anim.delay + a.anim.duration, `${a.sel} ends after ${b.sel}`).toBeLessThanOrEqual(
        b.anim.delay + b.anim.duration
      );
    }
    // Strictly later starts for the visible beats — a delay of 0 on two
    // neighbours would make them arrive together.
    expect(beats[0]!.anim.delay).toBeLessThan(beats[1]!.anim.delay);
    expect(beats[1]!.anim.delay).toBeLessThan(beats[2]!.anim.delay);
    expect(beats[2]!.anim.delay).toBeLessThan(beats[3]!.anim.delay);
  });

  it('the floors never increase down the cascade and every beat shares one easing', () => {
    for (let i = 0; i + 1 < beats.length; i++) {
      expect(beats[i]!.floor, `${beats[i]!.sel} floor`).toBeGreaterThanOrEqual(beats[i + 1]!.floor);
      expect(beats[i]!.anim.easing).toBe(beats[i + 1]!.anim.easing);
    }
  });

  it('every entrance holds its floor during the delay (fill-mode backwards)', () => {
    for (const b of beats) {
      expect(decl(styleOf(b.sel), 'animation'), b.sel).toMatch(
        new RegExp(`${b.anim.name}[^,]*\\bbackwards\\b`)
      );
    }
  });
});

/* ── 3. Nothing animates a paint property ────────────────────────────── */

describe('HeroOverlay — the breathing is composited', () => {
  const PAINT =
    /^(text-shadow|box-shadow|filter|backdrop-filter|background(-[a-z]+)?|color|[a-z-]+-color|clip-path|outline(-[a-z]+)?)$/;

  it('no @keyframes stop declares a paint property', () => {
    const all = atRules('@keyframes');
    expect(all.length).toBeGreaterThan(0);
    for (const kf of all) {
      for (const stop of kf.children) {
        for (const d of decls(stop.body)) {
          expect(d.prop, `${kf.prelude} ${stop.prelude} animates ${d.prop}`).not.toMatch(PAINT);
        }
      }
    }
  });

  it('the CTA shimmer moves on transform, not background-position', () => {
    const kf = keyframes('shimmer-pass');
    const props = new Set(kf.children.flatMap((s) => decls(s.body).map((d) => d.prop)));
    expect([...props]).toEqual(['transform']);
    expect(decl(styleOf('.hero-overlay__cta::before'), 'width')).toBe('250%');
  });
});

/* ── 4. The label glow twins ─────────────────────────────────────────── */

describe('HeroOverlay — the label breathes on two transparent text twins', () => {
  const before = styleOf('.hero-overlay__label::before');
  const after = styleOf('.hero-overlay__label::after');

  it('the markup hands the label text to the twins via data-label', () => {
    const markup = svelte.replace(/<!--[\s\S]*?-->/g, '');
    expect(markup).toMatch(/<p\s[^>]*class="hero-overlay__label"[^>]*\sdata-label=\{label\}/);
  });

  it('both twins are copies of the text, behind it, untouchable, transparent', () => {
    for (const [sel, body] of [
      ['::before', before],
      ['::after', after],
    ] as const) {
      expect(decl(body, 'content'), sel).toBe("attr(data-label) / ''");
      expect(
        decls(body).some((d) => d.prop === 'content' && d.value === 'attr(data-label)'),
        `${sel} plain fallback`
      ).toBe(true);
      expect(decl(body, 'position'), sel).toBe('absolute');
      expect(decl(body, 'z-index'), sel).toBe('-1');
      expect(decl(body, 'pointer-events'), sel).toBe('none');
      expect(decl(body, 'color'), sel).toBe('transparent');
      expect(decl(body, 'padding'), sel).toBe('inherit');
    }
  });

  it('the rest twin carries the old resting glow at opacity 1, the peak twin the old peak at 0', () => {
    expect(decl(before, 'text-shadow')).toBe('0 0 12px var(--accent-glow)');
    expect(decl(before, 'opacity')).toBe('1');
    expect(decl(after, 'text-shadow')).toBe(
      '0 0 20px var(--accent-glow-strong), 0 0 40px var(--accent-glow)'
    );
    expect(decl(after, 'opacity')).toBe('0');
  });

  it('the real label text carries no shadow of its own (the twins own the glow)', () => {
    expect(decl(styleOf('.hero-overlay__label'), 'text-shadow')).toBeUndefined();
    expect(decl(styleOf('.hero-overlay__label:hover'), 'text-shadow')).toBeUndefined();
  });

  it('the twins cross-fade on opacity only, in antiphase, forever', () => {
    const rest = animations(before);
    const peak = animations(after);
    expect(rest.map((a) => a.name)).toEqual(['hero-halo-rest']);
    expect(peak.map((a) => a.name)).toEqual(['hero-halo-breathe']);
    expect(rest[0]!.infinite && peak[0]!.infinite).toBe(true);
    expect(rest[0]!.duration).toBe(peak[0]!.duration);
    expect(rest[0]!.delay).toBe(peak[0]!.delay);
    const stopMap = (name: string) =>
      Object.fromEntries(
        keyframes(name).children.flatMap((s) =>
          selectorsOf(s.prelude).map((p) => [p, decls(s.body)])
        )
      );
    const breathe = stopMap('hero-halo-breathe');
    const restKf = stopMap('hero-halo-rest');
    for (const kf of [breathe, restKf]) {
      for (const ds of Object.values(kf)) expect(ds.map((d) => d.prop)).toEqual(['opacity']);
    }
    expect(breathe['0%']![0]!.value).toBe('0');
    expect(breathe['100%']![0]!.value).toBe('0');
    expect(breathe['50%']![0]!.value).toBe('1');
    expect(restKf['0%']![0]!.value).toBe('1');
    expect(restKf['100%']![0]!.value).toBe('1');
    expect(restKf['50%']![0]!.value).toBe('0');
  });

  it('the subtitle has no pseudo halo: its glyphs are its background and would paint under one', () => {
    expect(rulesFor('.hero-overlay__subtitle::after')).toHaveLength(0);
    expect(rulesFor('.hero-overlay__subtitle::before')).toHaveLength(0);
    expect(decl(styleOf('.hero-overlay__subtitle'), 'background-clip')).toBe('text');
  });
});

/* ── 5. Reduced motion: a static resting state ───────────────────────── */

describe('HeroOverlay — every animation and transition is switched off under reduced motion', () => {
  const reduce = sheet.filter((b) => b.prelude === '@media (prefers-reduced-motion: reduce)');
  const offSelectors = (prop: 'animation' | 'transition') =>
    new Set(
      reduce
        .flatMap((m) => m.children)
        .filter((r) => /^none( !important)?$/.test(decl(r.body, prop) ?? ''))
        .flatMap((r) => selectorsOf(r.prelude))
    );

  /** Every rule outside the reduce blocks, including those nested in other at-rules. */
  const liveRules = (blocks: Block[] = sheet): Block[] =>
    blocks.flatMap((b) => {
      if (b.prelude === '@media (prefers-reduced-motion: reduce)') return [];
      if (b.prelude.startsWith('@keyframes')) return [];
      if (b.prelude.startsWith('@')) return liveRules(b.children);
      return [b];
    });

  it('there is a reduce block, and the canvas is hidden in it', () => {
    expect(reduce.length).toBeGreaterThan(0);
    expect(
      decl(
        styleOf(
          '.hero-overlay__neural',
          reduce.flatMap((m) => m.children)
        ),
        'display'
      )
    ).toBe('none');
  });

  it('every selector that declares an animation is listed with animation: none inside the reduce block', () => {
    const off = offSelectors('animation');
    const animated = liveRules().filter((r) => animations(r.body).length > 0);
    expect(animated.length).toBeGreaterThan(0);
    for (const r of animated) {
      for (const sel of selectorsOf(r.prelude)) {
        expect(off.has(sel), `${sel} animates but is not switched off under reduced motion`).toBe(
          true
        );
      }
    }
  });

  it('every selector that declares a transition is listed with transition: none inside the reduce block, or hidden there', () => {
    const off = offSelectors('transition');
    const hidden = new Set(
      reduce
        .flatMap((m) => m.children)
        .filter((r) => decl(r.body, 'display') === 'none')
        .flatMap((r) => selectorsOf(r.prelude))
    );
    const moving = liveRules().filter((r) => (decl(r.body, 'transition') ?? 'none') !== 'none');
    expect(moving.length).toBeGreaterThan(0);
    for (const r of moving) {
      for (const sel of selectorsOf(r.prelude)) {
        expect(
          off.has(sel) || hidden.has(sel),
          `${sel} transitions but is not switched off under reduced motion`
        ).toBe(true);
      }
    }
  });

  it('the twins hold the resting glow there: rest at 1, peak at 0, no motion', () => {
    const inReduce = reduce.flatMap((m) => m.children);
    for (const sel of [
      '.hero-overlay__label::before',
      '.hero-overlay__label::after',
      '.hero-overlay__cta::before',
    ]) {
      expect(decl(styleOf(sel, inReduce), 'animation'), sel).toBe('none');
    }
  });
});

/* ── 6. Clipped text has a solid fallback, last in the sheet ─────────── */

describe('HeroOverlay — clipped text has a solid fallback', () => {
  const SUPPORTS = '@supports not ((-webkit-background-clip: text) or (background-clip: text))';

  it('title and subtitle each declare a colour token under the transparent fill', () => {
    expect(decl(styleOf('.hero-overlay__title'), 'color')).toBe('var(--text-primary)');
    expect(decl(styleOf('.hero-overlay__subtitle'), 'color')).toBe('var(--text-secondary)');
  });

  it('the @supports not (background-clip: text) block undoes the clip for both', () => {
    const block = sheet.find((b) => b.prelude === SUPPORTS);
    expect(block).toBeDefined();
    const title = styleOf('.hero-overlay__title', block!.children);
    const subtitle = styleOf('.hero-overlay__subtitle', block!.children);
    expect(decl(title, 'background-image')).toBe('none');
    expect(decl(title, '-webkit-text-fill-color')).toBe('var(--text-primary)');
    expect(decl(subtitle, 'background')).toBe('none');
    expect(decl(subtitle, '-webkit-text-fill-color')).toBe('var(--text-secondary)');
  });

  it('…and that block is the LAST rule in the sheet — it wins by source order only', () => {
    expect(sheet[sheet.length - 1]!.prelude).toBe(SUPPORTS);
  });
});

/* ── 7. The H1 texture is preloaded under the component's own media split ── */

describe('index.astro — the headline texture is preloaded for the viewport that will paint it', () => {
  const head = astro.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '');
  const links = [...head.matchAll(/<link\s[^>]*rel="preload"[^>]*>/g)].map((m) => m[0]);
  const attr = (tag: string, name: string) => tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];
  const preloads = Object.fromEntries(links.map((l) => [attr(l, 'href'), l]));

  // The mobile texture override lives in one @media block of the component;
  // that block's prelude IS the mobile query.
  const mobileBlock = sheet.find(
    (b) =>
      b.prelude.startsWith('@media') &&
      b.children.some((r) => r.body.includes('neural-texture-mobile'))
  );
  const mobileQuery = mobileBlock!.prelude.replace(/^@media\s*/, '');

  it('the component switches textures on one mobile query', () => {
    expect(mobileQuery).toBe('(max-width: 767px), ((max-height: 767px) and (pointer: coarse))');
    expect(cssSource).toContain("url('/neural-texture-mobile.avif') type('image/avif')");
    expect(cssSource).toContain("url('/neural-texture.avif') type('image/avif')");
  });

  it('the mobile file is preloaded under exactly that query', () => {
    const l = preloads['/neural-texture-mobile.avif'];
    expect(l, 'no preload for /neural-texture-mobile.avif').toBeDefined();
    expect(attr(l!, 'as')).toBe('image');
    expect(attr(l!, 'type')).toBe('image/avif');
    expect(attr(l!, 'media')).toBe(mobileQuery);
  });

  it('the desktop file is preloaded on wide fine-pointer devices only (the scanner runs before the viewport meta)', () => {
    // NOT the mobile query's complement: this slot renders before the
    // viewport meta, and Chrome's speculative preload scanner evaluates
    // width queries against a 980 px default there, so any width-based
    // complement fetched the 70 KB desktop file on phones (measured,
    // 2026-09-21). pointer/hover are known before any viewport.
    const l = preloads['/neural-texture.avif'];
    expect(l, 'no preload for /neural-texture.avif').toBeDefined();
    expect(attr(l!, 'as')).toBe('image');
    expect(attr(l!, 'type')).toBe('image/avif');
    expect(attr(l!, 'media')).toBe('(min-width: 768px) and (hover: hover) and (pointer: fine)');
  });
});
