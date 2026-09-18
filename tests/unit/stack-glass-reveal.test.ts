/**
 * Stack frosted-fade lock (this block silently regressed TWICE — never again).
 * ===========================================================================
 * History: the beloved pre-deploy interaction was the MASK-FREE one — a fully
 * frosted pane hiding the logo, hover melting the glass so the logo emerges.
 * It only existed because `circle N%` was invalid grammar and the browser
 * dropped the whole gradient. Every later attempt to "fix" the mask brought
 * harsh cutout edges, per-logo inconsistency, resolution-dependent circles and
 * two silent geometry regressions. The final design therefore has NO mask at
 * all — and this test makes reintroducing one (or any of the old failure
 * modes) a loud build failure instead of a quiet visual rot.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const astro = readFileSync(resolve(root, 'src/components/sections/StackSection.astro'), 'utf8');
const js = readFileSync(resolve(root, 'src/scripts/section-animations.ts'), 'utf8');
const globalCss = readFileSync(resolve(root, 'src/styles/global.css'), 'utf8');

describe('stack frosted-fade reveal stays mask-free, label-safe and hover-safe', () => {
  it('the glass carries NO mask — the reveal is the opacity melt, not a cutout', () => {
    expect(astro).not.toMatch(/mask-image/);
    expect(js).not.toMatch(/mask-image|maskImage|stack-iris/);
    expect(globalCss).not.toMatch(/stack-iris/);
  });

  it('never a percentage radius with `circle` (the invalid grammar that started it all)', () => {
    expect(astro).not.toMatch(/circle\s+\d+(\.\d+)?%/);
    expect(js).not.toMatch(/circle\s+\d+(\.\d+)?%/);
  });

  it('the melt target exists and stays in the readable band', () => {
    const m = js.match(/GLASS_OPEN_OPACITY\s*=\s*(0?\.\d+)/);
    expect(m).not.toBeNull();
    const v = parseFloat(m![1]!);
    // low enough that the logo genuinely appears, high enough to stay frosted
    expect(v).toBeGreaterThanOrEqual(0.15);
    expect(v).toBeLessThanOrEqual(0.7);
  });

  it('the label is a SIBLING of the glass, never its child', () => {
    expect(astro).toMatch(/<div class="stack__card-glass js-stack-glass"[^>]*\/>/);
    const glassToInfo = astro.match(/<div class="stack__card-glass[^]*?stack__card-info/);
    expect(glassToInfo![0]).toMatch(/\/>/);
    expect(astro).toContain('class="stack__card-info"');
  });

  it('state is the JS-toggled .is-open class, not raw :hover (touch-sticky bug)', () => {
    expect(astro).not.toMatch(/\.stack__card:hover/);
    expect(astro).toMatch(/\.stack__card\.is-open/);
    expect(js).toMatch(/classList\.add\('is-open'\)/);
    expect(js).toMatch(/classList\.remove\('is-open'\)/);
  });
});
