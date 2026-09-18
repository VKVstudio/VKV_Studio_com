// @ts-check
import { execFileSync } from 'node:child_process';
import { defineConfig } from 'astro/config';
import svelte from '@astrojs/svelte';
import sitemap from '@astrojs/sitemap';

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
      filter: (page) => new URL(page).pathname !== '/',
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
  // NOT enabling Astro's hash-based CSP (`security.csp`). It looks like the
  // obvious way to drop 'unsafe-inline' from script-src, and it was tried and
  // measured on a preview deploy 2026-08-09 — it does not fit this site:
  //
  //  1. `strictDynamic: true` disables host-based allowlisting INCLUDING
  //     'self'. Astro hydrates islands through dynamic import(), which
  //     strict-dynamic does not extend trust to, so all 10 islands were
  //     blocked and the page shipped dead.
  //  2. With strictDynamic off, scripts work — but Astro also emits hashes in
  //     style-src, and per the CSP spec ANY hash there makes the browser
  //     ignore 'unsafe-inline'. That blocks the runtime inline style
  //     attributes Svelte emits for the hero parallax (`style:transform`),
  //     whose values are computed per frame and so cannot be hashed at build
  //     time. Omitting styleDirective is worse still: Astro then emits
  //     style-src with hashes and no 'unsafe-inline' at all.
  //
  // So the choice is between a working hero and a stricter script-src, and
  // 'unsafe-inline' stays for now. Revisit if Astro exposes style-src-attr,
  // or if the parallax stops using inline style attributes.
  compressHTML: true,
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
