/**
 * Guards on the Lab → paid-ladder bridge.
 *
 * The Lab is the free tier of the paid work, and its own section on the home
 * page states the law in a comment: "the free tier should never dead-end".
 * The three tool pages broke it — until this component they ended in
 * LabToolsNav, a loop between the same three free tools, with no link to a
 * paid rung anywhere in the body. Those are the site's most engaging pages,
 * so that was the most expensive gap in the funnel.
 *
 * An audit took the first version of this file apart and it deserved it:
 * every assertion was a grep over the raw source, so commenting the component
 * out on all three pages left the suite green, one test was a tautology that
 * no realistic breakage could fail, and — worst — NOTHING checked that the
 * `bridge.*` i18n keys exist. `t()` returns the key itself on a miss, so
 * deleting them would have rendered the literal "bridge.heading" on six pages
 * with the whole suite still passing. Each of those is now closed, and each
 * test below names the breakage it is supposed to catch.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SERVICES } from '@/data/services';
import en from '@/i18n/en.json';
import ru from '@/i18n/ru.json';

const BRIDGE_PATH = 'src/components/lab/LabServiceBridge.astro';
const bridgeSource = readFileSync(BRIDGE_PATH, 'utf8');

/**
 * Source with every comment removed — JS block and line comments plus Astro's
 * `{/* … *\/}` form. Searching the raw text was the flaw in the first version:
 * a commented-out `<LabServiceBridge …>` still satisfied every `toContain`.
 */
function stripComments(src: string): string {
  return src
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

/** The three tool pages, and the rung each one is supposed to point at. */
const TOOL_PAGES = [
  { tool: 'tokenizer', rung: 'geo-audit', path: 'src/pages/[lang]/lab/tokenizer/index.astro' },
  { tool: 'prompt', rung: 'rag-pilot', path: 'src/pages/[lang]/lab/prompt/index.astro' },
  { tool: 'embeddings', rung: 'on-prem-ai', path: 'src/pages/[lang]/lab/embeddings/index.astro' },
] as const;

/** Every key the component asks `t()` for, minus the per-tool ledes. */
const SHARED_KEYS = ['eyebrow', 'heading', 'all'] as const;

describe('LabServiceBridge — the free tier does not dead-end', () => {
  it.each(TOOL_PAGES)('$tool page renders the bridge, not just imports it', ({ path, tool }) => {
    const src = stripComments(readFileSync(path, 'utf8'));
    // Catches: commenting the element out, which the first version missed.
    expect(src).toMatch(new RegExp(`<LabServiceBridge[^>]*tool="${tool}"`));
  });

  it.each(TOOL_PAGES)('$tool page places the bridge before LabToolsNav', ({ path }) => {
    const src = stripComments(readFileSync(path, 'utf8'));
    const bridgeAt = src.indexOf('<LabServiceBridge');
    const navAt = src.indexOf('<LabToolsNav');
    expect(bridgeAt).toBeGreaterThan(-1);
    expect(navAt).toBeGreaterThan(-1);
    // The visitor meets the paid step before being offered the free loop.
    expect(bridgeAt).toBeLessThan(navAt);
  });

  it.each(TOOL_PAGES)('$tool maps to a rung that exists in SERVICES', ({ tool, rung }) => {
    const code = stripComments(bridgeSource);
    const mapBlock = code.slice(
      code.indexOf('const RUNG_FOR_TOOL'),
      code.indexOf('const { lang, tool }')
    );
    // `\\s` and not `\s`: inside a template literal `\s` is not a valid escape
    // and collapses to a bare "s", which silently matched nothing.
    expect(mapBlock).toMatch(new RegExp(`${tool}:\\s*'${rung}'`));
    expect(SERVICES.some((s) => s.id === rung)).toBe(true);
  });

  it('maps every member of the LabTool union — a new tool cannot ship unmapped', () => {
    // The first version regexed the three names it already knew, which no
    // realistic change could fail. This reads the union type and the map as
    // two independent lists and compares them, so adding a fourth tool
    // without a rung fails here rather than throwing at build time.
    const code = stripComments(bridgeSource);
    const union = code.match(/export type LabTool\s*=\s*([^;]+);/);
    expect(union, 'LabTool union not found — was it renamed?').not.toBeNull();
    const declared = [...(union?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(declared.length).toBeGreaterThan(0);

    const mapBlock = code.slice(
      code.indexOf('const RUNG_FOR_TOOL'),
      code.indexOf('const { lang, tool }')
    );
    const mapped = [...mapBlock.matchAll(/(\w+):\s*'([^']+)'/g)].map((m) => m[1]);

    expect(new Set(mapped)).toEqual(new Set(declared));
    // And every page in this file's own list is one of them.
    for (const { tool } of TOOL_PAGES) expect(declared).toContain(tool);
  });

  it('every i18n key it renders exists in BOTH locales', () => {
    // The hole the audit found: `t()` (src/i18n/utils.ts) returns the KEY on a
    // miss, so a deleted string renders the literal "bridge.heading" on six
    // pages and no test notices. i18n-parity compares EN against RU; it does
    // not know this component asks for these keys at all.
    const locales: Array<['en' | 'ru', Record<string, unknown>]> = [
      ['en', en as unknown as Record<string, unknown>],
      ['ru', ru as unknown as Record<string, unknown>],
    ];
    for (const [name, dict] of locales) {
      const bridge = dict.bridge as Record<string, unknown> | undefined;
      expect(bridge, `${name}.json has no "bridge" group`).toBeTypeOf('object');
      for (const key of [...SHARED_KEYS, ...TOOL_PAGES.map((p) => p.tool)]) {
        const value = bridge?.[key];
        expect(typeof value, `${name}.json: bridge.${key} is missing`).toBe('string');
        expect(
          (value as string).trim().length,
          `${name}.json: bridge.${key} is empty`
        ).toBeGreaterThan(0);
      }
    }
  });

  it('keeps the decorative slashes out of the translated strings', () => {
    // The component renders `<span aria-hidden="true">// </span>` itself. When
    // the `// ` lived in the i18n value instead, a screen reader read "slash
    // slash next step" on six pages — the very defect being fixed elsewhere
    // the same night — and decoration became a translator's problem.
    for (const [name, dict] of [
      ['en', en as unknown as Record<string, unknown>],
      ['ru', ru as unknown as Record<string, unknown>],
    ] as const) {
      const bridge = dict.bridge as Record<string, unknown>;
      for (const key of SHARED_KEYS) {
        expect((bridge[key] as string).trim(), `${name}.json: bridge.${key}`).not.toMatch(/^\/\//);
      }
    }
    expect(bridgeSource).toContain('<span aria-hidden="true">// </span>');
  });

  it('states no price and no duration of its own — every figure comes from SERVICES', () => {
    const code = stripComments(bridgeSource);
    // Currency in any notation, not just the symbol: the first version caught
    // `€900` but would have passed `900 EUR`, `от 4500` or «три недели».
    expect(code).not.toMatch(/[€£]|\$\d/);
    expect(code).not.toMatch(/\d[\s ]*(EUR|USD|GBP|евро|eur\b)/i);
    expect(code).not.toMatch(/\d+[\s ]*(weeks?|days?|недел|дн[еяй])/i);
    expect(code).not.toMatch(/(три|две|четыре|пять)[\s ]+недел/i);
    // It must read the real source instead.
    expect(code).toContain('rung.priceLine[lang]');
    expect(code).toContain('rung.timeframe[lang]');
  });

  it('reads its copy through t(), with the per-tool lede keyed by the prop', () => {
    const code = stripComments(bridgeSource);
    for (const key of SHARED_KEYS) expect(code).toContain(`bridge.${key}`);
    expect(code).toContain('bridge.${tool}');
  });
});
