import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  assertSafeStyleAttribute,
  cspHash,
  generateHeaders,
  inspectHtml,
  inspectModule,
} from '../../src/build/content-security-policy.mjs';

const template = readFileSync(join(__dirname, '../../public/_headers'), 'utf8');
const fallback = { route: '/404.html', styles: ['body{color:inherit}'], attributes: [] };

describe('build CSP permissions', () => {
  it('isolates CSS and exact attributes by page while retaining a styled 404 fallback', () => {
    const style = '.home{opacity:1}';
    const attribute = 'opacity: 0;';
    const result = generateHeaders(
      template,
      ['window.ready=true'],
      [
        fallback,
        { route: '/en/', styles: [style], attributes: [attribute] },
        { route: '/en/contact/', styles: ['.contact{display:block}'], attributes: [] },
      ]
    );
    const home = result.policies.find((row) => row.route === '/en/')?.policy ?? '';
    const contact = result.policies.find((row) => row.route === '/en/contact/')?.policy ?? '';
    expect(home).toContain(cspHash(style));
    expect(home).toContain("style-src-attr 'unsafe-hashes' " + cspHash(attribute));
    expect(contact).not.toContain(cspHash(attribute));
    expect(contact).toContain("style-src-attr 'none'");
    expect(result.policies[0]?.policy).toContain(cspHash(fallback.styles[0] ?? ''));
    expect(result.headers).toContain(
      '/en/\n  ! Content-Security-Policy\n  Content-Security-Policy:'
    );
    expect(result.policies.find((row) => row.route === '/en')?.policy).toBe(home);
    expect(result.longestLineBytes).toBeLessThanOrEqual(2000);
    expect(result.headers).not.toMatch(/Content-Security-Policy:.*'unsafe-inline'/);
  });

  it('deduplicates exact permissions and hashes the final bytes, including whitespace', () => {
    const result = generateHeaders(
      template,
      ['one', 'one'],
      [
        fallback,
        { route: '/en/', styles: ['two', 'two'], attributes: ['opacity: 0;', 'opacity: 0;'] },
      ]
    );
    const policy = result.policies.find((row) => row.route === '/en/')?.policy ?? '';
    expect(policy.split(cspHash('one')).length - 1).toBe(1);
    expect(policy.split(cspHash('two')).length - 1).toBe(1);
    expect(policy.split(cspHash('opacity: 0;')).length - 1).toBe(1);
    expect(cspHash('opacity: 0;')).not.toBe(cspHash('opacity:0;'));
  });

  it('refuses dangerous or unreviewed style permissions', () => {
    for (const attribute of [
      'background:url(https://attacker.invalid/a)',
      'color:expression(alert(1))',
      'width: 2px !important;',
      'opacity:0;\nposition:relative',
      'constructor: 1',
      'content: "secret"',
      'width: calc(100% - 1px)',
      'opacity:' + '0'.repeat(401),
    ])
      expect(() => assertSafeStyleAttribute(attribute), attribute).toThrow();
    expect(() =>
      assertSafeStyleAttribute('opacity: 0; transform: translateY(60px);')
    ).not.toThrow();
    expect(() =>
      assertSafeStyleAttribute(
        'font-family:var(--font-mono);font-size:var(--text-sm);text-transform:uppercase;'
      )
    ).not.toThrow();
  });

  it('refuses missing fallbacks, ambiguous paths, duplicate paths and Cloudflare limits', () => {
    expect(() => generateHeaders(template, [], [])).toThrow();
    expect(() =>
      generateHeaders(template, [], [{ route: '/en/', styles: [], attributes: [] }])
    ).toThrow('404');
    for (const route of [
      '/en/*',
      '/en/:slug',
      '/en/\nX-Evil: yes',
      '//foreign.invalid/a',
      '/en/?q=x',
    ]) {
      expect(
        () => generateHeaders(template, [], [fallback, { route, styles: [], attributes: [] }]),
        route
      ).toThrow();
    }
    expect(() =>
      generateHeaders(
        template,
        [],
        [fallback, fallback, { route: '/en/', styles: [], attributes: [] }]
      )
    ).toThrow();
    expect(() =>
      generateHeaders(
        template,
        [],
        [
          fallback,
          {
            route: '/en/',
            styles: Array.from({ length: 40 }, (_, index) => '.x{width:' + index + 'px}'),
            attributes: [],
          },
        ]
      )
    ).toThrow('2000');
    expect(() =>
      generateHeaders(
        template,
        [],
        [
          fallback,
          ...Array.from({ length: 60 }, (_, index) => ({
            route: '/page-' + index + '/',
            styles: [],
            attributes: [],
          })),
        ]
      )
    ).toThrow('100');
  });

  it('fails closed when a template adds unsafe inline permissions', () => {
    expect(() =>
      generateHeaders(
        template.replace("style-src 'self'", "style-src 'self' 'unsafe-inline'"),
        [],
        [fallback]
      )
    ).toThrow('Unsafe');
  });

  it('reads SSR values as browsers do and excludes inert JSON from executable scripts', () => {
    const html = inspectHtml(
      '<script>window.x=1</script><script type="application/ld+json">{"x":1}</script>' +
        '<script type="module" src="/_astro/main.js"></script><style>div{display:block}</style>' +
        '<astro-island component-url="/_astro/island.js" renderer-url="/_astro/svelte.js"></astro-island>' +
        '<div style="width:&#48;%;"></div>'
    );
    expect(html.inlineScripts).toEqual(['window.x=1']);
    expect(html.inlineStyles).toEqual(['div{display:block}']);
    expect(html.styleAttributes).toEqual(['width:0%;']);
    expect(html.modules).toEqual(['/_astro/main.js', '/_astro/island.js', '/_astro/svelte.js']);
  });

  it('discovers lazy CSS and static Svelte template attributes without executing module code', () => {
    const module = inspectModule(
      'import { x } from "./base.js"; export { y } from "./shared.js";' +
        'const lazy=()=>import("./lazy.js");const lazyBacktick=()=>import(`./lazy-backtick.js`);' +
        'const css={hash:"svelte-abc",code:"div{opacity:1}"};' +
        'const template="<div style=\\"opacity: 0;\\"></div>";throw new Error("must never run");'
    );
    expect(module.imports).toEqual(['./base.js', './shared.js', './lazy.js', './lazy-backtick.js']);
    expect(module.inlineStyles).toEqual(['div{opacity:1}']);
    expect(module.styleAttributes).toEqual(['opacity: 0;']);
  });
});
