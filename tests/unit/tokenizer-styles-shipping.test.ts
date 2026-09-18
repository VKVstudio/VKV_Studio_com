/**
 * Regression guard for the SSR-gated CSS drop (fixed 2026-08-16).
 * ==============================================================
 * TokenCompare and TokenHeatmap render only behind an {#if} (compare mode /
 * heatmap view) that is false on load, so they are absent from the tokenizer
 * page's static SSR HTML. Astro only collects the scoped CSS of components that
 * appear in that static output, so an inline <style> block in either component
 * gets pruned from the build and the panel ships UNSTYLED — with passing tests
 * and a clean build, invisibly.
 *
 * The fix keeps their styles in src/styles/lab/tokenizer.css, which TokenizerApp
 * imports and which therefore always ships. This test locks that in: it fails if
 * anyone re-adds an inline <style> to either component (reintroducing the bug) or
 * removes the relocated rules from tokenizer.css.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p: string) => readFileSync(resolve(root, p), 'utf8');

describe('tokenizer sub-panel styles must ship (SSR-gated CSS drop guard)', () => {
  const tokenizerCss = read('src/styles/lab/tokenizer.css');

  it('TokenCompare has no inline <style> — its CSS would be pruned from the build', () => {
    expect(read('src/components/lab/tokenizer/TokenCompare.svelte')).not.toMatch(/<style/);
  });

  it('TokenHeatmap has no inline <style> — its CSS would be pruned from the build', () => {
    expect(read('src/components/lab/tokenizer/TokenHeatmap.svelte')).not.toMatch(/<style/);
  });

  it('tokenizer.css carries the Compare panel rules (which always ships)', () => {
    for (const sel of ['.compare__panel', '.compare__empty', '.compare__empty--error']) {
      expect(tokenizerCss).toContain(sel);
    }
  });

  it('tokenizer.css carries the Heatmap rules', () => {
    expect(tokenizerCss).toContain('.heatmap__token');
  });

  it('the relocated keyframes were renamed to avoid a global name collision', () => {
    expect(tokenizerCss).toContain('@keyframes compare-pulse');
    // The generic global name must not reappear (another component scopes its own `pulse`).
    expect(tokenizerCss).not.toMatch(/@keyframes pulse\b/);
  });
});
