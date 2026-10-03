// @ts-check
import { execFileSync } from 'node:child_process';
import { defineConfig } from 'astro/config';
import svelte from '@astrojs/svelte';
import sitemap from '@astrojs/sitemap';
import contentSecurityPolicy from './src/build/content-security-policy.mjs';
import subresourceIntegrity from './src/build/subresource-integrity.mjs';
import pagesWorker from './src/build/pages-worker.mjs';

/**
 * `lastmod` per URL, taken from the last commit that touched the page's source.
 *
 * Google only uses lastmod when a site is "consistently accurate" about it, so
 * stamping every page with the build time — the tempting one-liner — is worse
 * than omitting it: each deploy would claim all 14 pages changed, and the
 * signal gets discounted. Git already knows which page actually changed and
 * when, so that is what ships.
 *
 * The map is keyed by the path *after* the locale segment, because both
 * locales are generated from one `[lang]` source file and therefore share a
 * modification date.
 */
const PAGE_SOURCES = {
  '/': 'src/pages/[lang]/index.astro',
  '/lab/': 'src/pages/[lang]/lab/index.astro',
  '/lab/tokenizer/': 'src/pages/[lang]/lab/tokenizer/index.astro',
  '/lab/prompt/': 'src/pages/[lang]/lab/prompt/index.astro',
  '/lab/embeddings/': 'src/pages/[lang]/lab/embeddings/index.astro',
  '/log/': 'src/pages/[lang]/log/index.astro',
  '/privacy/': 'src/pages/[lang]/privacy/index.astro',
  '/services/': 'src/pages/[lang]/services/index.astro',
  '/services/geo-audit/': 'src/pages/[lang]/services/geo-audit/index.astro',
  '/services/rag-pilot/': 'src/pages/[lang]/services/rag-pilot/index.astro',
  '/services/on-prem-ai/': 'src/pages/[lang]/services/on-prem-ai/index.astro',
  '/services/websites/': 'src/pages/[lang]/services/websites/index.astro',
  '/services/for-agencies/': 'src/pages/[lang]/services/for-agencies/index.astro',
  '/services/geo-methodology/': 'src/pages/[lang]/services/geo-methodology/index.astro',
  '/trust/': 'src/pages/[lang]/trust/index.astro',
  '/contact/': 'src/pages/[lang]/contact/index.astro',
  '/cases/vkvstudio-site/': 'src/pages/[lang]/cases/vkvstudio-site/index.astro',
  '/cases/synapse/': 'src/pages/[lang]/cases/synapse/index.astro',
};

/**
 * ISO commit date of the newest commit touching `file`, or null.
 * @param {string} file
 * @returns {string | null}
 */
function lastCommitISO(file) {
  try {
    const out = execFileSync('git', ['log', '-1', '--format=%cI', '--', file], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out || null;
  } catch {
    // No git (a tarball build, a CI checkout without history) — omit lastmod
    // rather than invent one. An absent date is honest; a wrong one is not.
    return null;
  }
}

const LASTMOD = Object.fromEntries(
  Object.entries(PAGE_SOURCES)
    .map(([route, file]) => [route, lastCommitISO(file)])
    .filter(([, date]) => date !== null)
);

// https://astro.build/config
export default defineConfig({
  site: 'https://vkvstudio.com',
  integrations: [
    svelte(),
    contentSecurityPolicy(),
    subresourceIntegrity(),
    pagesWorker(),
    sitemap({
      i18n: {
        defaultLocale: 'en',
        locales: { en: 'en', ru: 'ru' },
      },
      // Exclude the bare "/" redirect shell (src/pages/index.astro — no
      // content of its own, just forwards to /en/ or /ru/ by detected
      // locale). @astrojs/sitemap's i18n grouping parses a URL with no
      // locale prefix as { locale: defaultLocale, path: '/' } — identical to
      // "/en/"'s { locale: 'en', path: '/' } — so without this filter "/"
      // and "/en/" land in the same alternates group and both claim
      // hreflang="en", which is invalid (one hreflang value must resolve to
      // exactly one URL). Excluding "/" here (before the i18n grouping runs)
      // leaves "/en/" and "/ru/" as the only real, indexable locale pages.
      // Capture viewers are noindex utilities, not additional marketing pages.
      filter: (page) => {
        const pathname = new URL(page).pathname;
        return pathname !== '/' && !/^\/(en|ru)\/audit-proofs\//.test(pathname);
      },
      serialize(item) {
        const route = new URL(item.url).pathname.replace(/^\/(en|ru)/, '') || '/';
        const lastmod = LASTMOD[route];
        // @astrojs/sitemap emits only en+ru <xhtml:link> alternates, never x-default,
        // which disagrees with every page's <head> (en+ru+x-default). Conflicting
        // hreflang channels are a documented error, so mirror the head here: add an
        // x-default pointing at the en alternate (== BaseLayout's xDefaultUrl).
        if (item.links) {
          const enLink = item.links.find((l) => l.lang === 'en');
          if (enLink && !item.links.some((l) => l.lang === 'x-default')) {
            item.links = [...item.links, { lang: 'x-default', url: enLink.url }];
          }
        }
        return lastmod ? { ...item, lastmod } : item;
      },
    }),
  ],
  output: 'static',
  // The build-only integration derives per-page CSP from final HTML and lazy
  // module bytes, preserving inline CSS, exact SSR style values and hydration.
  // CSSOM updates stay available without unsafe-inline; static attributes use
  // finite unsafe-hashes permissions. No strict-dynamic or markup rewrites.
  compressHTML: true,
  build: {
    // Every page's CSS ships inside the HTML instead of as <link rel="stylesheet">.
    //
    // WHY, measured 2026-09-20 on /en/: the home page shipped FIVE render-blocking
    // stylesheets (index 74.6 KB raw / 15.3 KiB over the wire, BaseLayout 14.3/5.5,
    // PricingCard 3.7/2.6, FaqSection 2.0/2.4, MagneticCard 0.36/1.9) and Lighthouse
    // charged 130-170 ms mobile / 10-70 ms desktop for them — a sixth
    // (SynapseTerminal) appeared the same day, which is the point: every new
    // component with scoped CSS silently adds another blocking round trip. They must
    // ALL land before the first paint, and most are under 4 KB — per-request
    // overhead with almost no payload under it.
    //
    // Astro's default here is already 'auto', so this looks redundant. It is not:
    // 'auto' delegates the decision to `shouldInlineAsset(source, file,
    // vite.build.assetsInlineLimit)` (node_modules/astro/dist/core/build/plugins/
    // plugin-css.js:270), and this config pins assetsInlineLimit to 0 below — which
    // means 'auto' inlines NOTHING. That is why a 360-byte MagneticCard.css was
    // still costing a request. 'auto' + a raised threshold was the other candidate
    // and was rejected: assetsInlineLimit is global, so raising it to ~4 KB would
    // also start base64-ing images and fonts into the CSS, which is a different
    // (and unwanted) trade. There is no CSS-only threshold knob.
    //
    // Measured on /en/ (brotli q11, what Cloudflare serves): a COLD visit gets
    // SMALLER, not bigger — 13.7 KB HTML + 17.1 KB CSS = 30.8 KB before, 28.2 KB as
    // one document after, because a single compression window over HTML+CSS beats
    // six separate streams. The round trips go away for free.
    //
    // The cost lands on the two other axes. (1) A repeat visitor used to get the
    // CSS from the `/_astro/* immutable` bucket in public/_headers for nothing and
    // now re-downloads it with every HTML revalidation: +14.5 KB per pageview.
    // (2) The same CSS is duplicated into all 36 pages, so a full crawl of the site
    // goes 487 KB -> 671 KB compressed. Both are accepted: traffic here is
    // overwhelmingly single-page arrivals from search and AI answers, so the
    // cross-page cache was being paid for on every first visit and collected on
    // almost none.
    //
    // Measured 2026-09-21 on a Cloudflare Pages preview of this tree vs the live
    // site, Lighthouse 13.5 mobile: render-blocking-insight went from failing (5
    // stylesheets, est. 130-170 ms) to passing with no items, and stylesheet
    // requests dropped 5 -> 0. The document itself went from 17.6 KB to ~35.7 KB
    // over the wire (brotli) while the separate 17.1 KB of CSS disappeared —
    // roughly byte-neutral per cold visit, not a net win. FCP and LCP moved
    // within run-to-run noise (no reproducible gain either way), and Speed Index
    // did NOT improve. The LCP element is hero text held back ~2.2s by the intro
    // animation, which is a separate fix — this change was never expected to move
    // LCP.
    //
    // Does not disturb the -webkit-backdrop-filter situation documented under
    // vite.build.cssTarget: inlining moves the emitted CSS text, it does not
    // re-generate it. The CSS text itself is unchanged — every one of the 30
    // pre-inlining .css files appears verbatim inside the post-inlining HTML, and
    // per-page inlined CSS equals the concatenation of the previously-external
    // sheets for all 36 pages. (A raw -webkit-backdrop-filter/backdrop-filter grep
    // count across the whole dist will NOT match before vs after — inlining
    // duplicates each shared stylesheet into every page that uses it, so counts
    // multiply roughly 4x; that's expected and not a regression.)
    inlineStylesheets: 'always',
  },
  server: {
    port: 4173,
    host: 'localhost',
  },
  vite: {
    build: {
      assetsInlineLimit: 0,
      // Without an explicit CSS target esbuild assumes an ancient baseline and
      // REPLACES standard properties with their -webkit- aliases. Measured in
      // dist: every glass surface on the site shipped only
      // -webkit-backdrop-filter, which this Chromium does not implement — so
      // the blur silently did nothing anywhere. These targets are the oldest
      // browsers the site actually supports.
      //
      // IT ONLY FIXES GLOBAL CSS. Measured 2026-08-24 on the built site: 13
      // stylesheets still ship 62 -webkit-backdrop-filter declarations against
      // 11 standard ones, and all 11 standard ones come from @supports blocks
      // written by hand in global.css — i.e. from source, not from the
      // minifier. So every page-scoped glass surface (pricing cards, geo
      // tiles, the terminal window, the cookie banner) renders as flat tint in
      // Firefox, which reads only the unprefixed property.
      //
      // `vite.css.target` was tried as well and changed nothing: same 62/11.
      // Do not spend a third session on a build flag. The one thing that
      // survives the minifier is duplicating the declaration inside
      // `@supports (backdrop-filter: blur(1px))`, because esbuild will not
      // collapse across that boundary — see src/styles/global.css:449.
      cssTarget: ['chrome108', 'edge108', 'firefox110', 'safari15.4'],
    },
  },
});
