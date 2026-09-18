/**
 * Guards `PAGE_SOURCES` in astro.config.mjs against the real route tree.
 *
 * Nothing enforced this before: astro.config.mjs's own LASTMOD map is built
 * with `.filter(([, date]) => date !== null)` (see its doc comment), so a
 * route with no PAGE_SOURCES entry is silently absent from the sitemap's
 * `<lastmod>` rather than a build error — a new page ships with no
 * freshness signal and nothing fails to tell anyone. This file makes that
 * failure loud instead of invisible.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const LANG_PAGES_DIR = path.join(ROOT, 'src/pages/[lang]');

/** Every route page under src/pages/[lang], discovered rather than hand-listed. */
function findAstroPages(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      findAstroPages(full, out);
    } else if (entry === 'index.astro') {
      out.push(full);
    }
  }
  return out;
}

/**
 * Mirrors astro.config.mjs's own routing convention: every page lives at
 * `.../src/pages/[lang]/<segments>/index.astro` and serves at `/<segments>/`
 * (the root page serves at `/`). Non-`index.astro` files and anything
 * outside `src/pages/[lang]` (the `api/` routes, the bare locale-redirect
 * shell at `src/pages/index.astro`) are out of scope on purpose —
 * PAGE_SOURCES only ever points at `[lang]` pages, which are the only ones
 * the sitemap integration's i18n grouping covers.
 */
function routeFor(absPath: string): string {
  const rel = path.relative(LANG_PAGES_DIR, absPath).split(path.sep).join('/');
  const dir = rel.slice(0, -'index.astro'.length);
  return dir === '' ? '/' : `/${dir}`;
}

/** The repo-relative path astro.config.mjs itself writes as a PAGE_SOURCES value. */
function sourcePathFor(absPath: string): string {
  return path.relative(ROOT, absPath).split(path.sep).join('/');
}

const PAGE_FILES = findAstroPages(LANG_PAGES_DIR);
const ROUTES = PAGE_FILES.map(routeFor).sort();

/**
 * astro.config.mjs is read as TEXT, not imported: importing it would run
 * `lastCommitISO()` — a synchronous `git log` spawn — once per PAGE_SOURCES
 * entry just to check a key exists, and would fail outright if `astro`/
 * `@astrojs/*` aren't resolvable from the vitest environment (they are not
 * a dependency of this test config — see vitest.config.ts). A flat object
 * literal of quoted-string routes to quoted-string paths is exactly as
 * reliable to parse with a regex as it is fragile to hand-maintain, which
 * is the whole reason this file exists.
 */
function parsePageSources(text: string): Record<string, string> {
  const bodyMatch = text.match(/const PAGE_SOURCES = \{([\s\S]*?)\n\};/);
  if (!bodyMatch) {
    throw new Error(
      'astro.config.mjs: could not locate the PAGE_SOURCES object literal — its shape ' +
        "changed and this test file's parser needs updating to match."
    );
  }
  const body = bodyMatch[1] ?? '';
  const entries: Record<string, string> = {};
  const entryPattern = /'([^']+)':\s*'([^']+)'/g;
  for (const m of body.matchAll(entryPattern)) {
    const route = m[1];
    const file = m[2];
    if (route !== undefined && file !== undefined) entries[route] = file;
  }
  return entries;
}

const configText = readFileSync(path.join(ROOT, 'astro.config.mjs'), 'utf8');
const PAGE_SOURCES = parsePageSources(configText);

describe('sitemap lastmod — PAGE_SOURCES vs. the real route tree', () => {
  it('derivation reproduces the known route count (self-check, 17 pages as of 2026-08-22)', () => {
    // If this ever needs bumping, a real page was added or removed — that
    // is expected drift, and the assertions below are what actually matter.
    // If it fails while nobody touched src/pages, findAstroPages()/
    // routeFor() broke instead of the site, and everything below this
    // point is scanning the wrong route list.
    expect(PAGE_FILES.length).toBeGreaterThanOrEqual(17);
    expect(new Set(ROUTES).size, 'two different source files derived the same route').toBe(
      ROUTES.length
    );
  });

  it('parser found at least the known PAGE_SOURCES entry count (parser self-check)', () => {
    expect(Object.keys(PAGE_SOURCES).length).toBeGreaterThanOrEqual(17);
  });

  it('every real route has a PAGE_SOURCES entry pointing at its actual source file', () => {
    const missing: string[] = [];
    const wrong: string[] = [];
    for (const file of PAGE_FILES) {
      const route = routeFor(file);
      const expectedSource = sourcePathFor(file);
      const actualSource = PAGE_SOURCES[route];
      if (actualSource === undefined) {
        missing.push(route);
      } else if (actualSource !== expectedSource) {
        wrong.push(`${route}: PAGE_SOURCES has "${actualSource}", expected "${expectedSource}"`);
      }
    }
    expect(missing, 'routes with no PAGE_SOURCES entry — ships with no <lastmod>').toEqual([]);
    expect(wrong, 'routes whose PAGE_SOURCES entry points at the wrong file').toEqual([]);
  });

  it('every PAGE_SOURCES entry points at a route that still exists', () => {
    // Guards the opposite drift: a page removed or renamed leaves a stale
    // PAGE_SOURCES entry that quietly does nothing (LASTMOD is keyed by
    // route, so an orphaned entry never crashes a build — it just rots).
    const routeSet = new Set(ROUTES);
    const stale = Object.keys(PAGE_SOURCES).filter((route) => !routeSet.has(route));
    expect(stale, 'PAGE_SOURCES entries with no matching page under src/pages/[lang]').toEqual([]);
  });

  it('no route (real or PAGE_SOURCES-listed) contains a dynamic segment — a per-path lastmod scheme can never key on it', () => {
    // A hand-maintained PAGE_SOURCES map only works for STATIC routes: a
    // dynamic folder like a hypothetical src/pages/[lang]/cases/[slug]/
    // would derive the literal route key '/cases/[slug]/', which no real
    // generated URL (e.g. '/cases/synapse/') can ever equal — silently
    // stripping lastmod from every URL that route produces while every
    // other assertion in this file stays green, since routeFor() and
    // parsePageSources() both operate on the literal folder/key text, not
    // on what a real visitor's URL looks like. There is no dynamic segment
    // under src/pages/[lang] today (cases/synapse and
    // cases/vkvstudio-site are static folders) — this pins that invariant
    // so a future [slug]-style route gets its own per-path lastmod
    // treatment instead of silently losing freshness signal.
    expect(ROUTES.filter((r) => /[[\]]/.test(r))).toEqual([]);
    expect(Object.keys(PAGE_SOURCES).filter((r) => /[[\]]/.test(r))).toEqual([]);
  });

  it('every URL in the built sitemap carries a <lastmod> (dist-dependent — skipped if dist/ has not been built)', () => {
    // Everything above only proves PAGE_SOURCES is internally consistent
    // with the source tree; it never checks that those keys actually match
    // what astro.config.mjs's serialize() looks up at build time
    // (`new URL(item.url).pathname.replace(/^\/(en|ru)/, '') || '/'`, then
    // `.filter(([, date]) => date !== null)` drops anything unmatched). A
    // trailingSlash change or a route-key typo could silently strip
    // <lastmod> from every URL while every assertion above stays green.
    // Gated on dist/ existing (this suite must not trigger a build) so a
    // fresh checkout without a prior `pnpm run build` doesn't fail here.
    const sitemapPath = path.join(ROOT, 'dist/sitemap-0.xml');
    let xml: string;
    try {
      xml = readFileSync(sitemapPath, 'utf8');
    } catch {
      return; // no dist/ yet — nothing to assert against
    }
    const blocks = [...xml.matchAll(/<url>[\s\S]*?<\/url>/g)].map((m) => m[0]);
    expect(blocks.length).toBeGreaterThanOrEqual(17);
    const naked = blocks
      .filter((b) => !b.includes('<lastmod>'))
      .map((b) => b.match(/<loc>([^<]+)<\/loc>/)?.[1]);
    expect(naked, 'sitemap URLs shipped with no <lastmod>').toEqual([]);
  });
});
