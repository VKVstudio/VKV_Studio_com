/**
 * public/_headers — the CSP and HSTS contract, re-derived from source.
 *
 * script-src carries no 'unsafe-inline'. Every inline script the site ships is
 * allowed by a sha256 hash instead, and a hash is only as good as the bytes it
 * was taken from. Those bytes come from exactly two places:
 *
 *   1. Astro's own island runtime and client-directive loaders. Astro inlines
 *      them verbatim from node_modules/astro/dist/runtime/server/astro-island
 *      .prebuilt.js and node_modules/astro/dist/runtime/client/<directive>
 *      .prebuilt.js — each module's default export IS the string that lands
 *      between <script> and </script>. So an Astro upgrade that touches those
 *      files silently changes the bytes, and a header still listing the old
 *      hashes would refuse the runtime on every page: no island hydrates, the
 *      assistant never opens, the labs are dead, and nothing fails at build.
 *
 *   2. The Trusted Types default policy (src/lib/trusted-types-policy.ts),
 *      injected by BaseLayout.astro through set:html, so its bytes are the
 *      exported constant, unchanged.
 *
 * This suite hashes both sources on every run and compares the SET of hashes
 * to the header: a hash for something that no longer ships is as much a bug as
 * a missing one (it means someone edited the header by hand and stopped
 * reading). The directive loaders are matched against the directives the
 * source actually uses — add `client:load` somewhere and the test tells you
 * the hash to add; drop the last `client:visible` and it tells you which hash
 * is now dead.
 *
 * Regeneration is therefore: run the suite, read the failure. It prints the
 * expected `'sha256-…'` tokens. Optionally, point CSP_DIST at a fresh build
 * (`pnpm exec astro build --outDir <dir>` then `CSP_DIST=<dir> pnpm exec vitest
 * run tests/unit/csp-headers.test.ts`) and the last test scans every HTML file
 * in it and asserts the inline scripts on disk are exactly the hashed set —
 * the end-to-end check, skipped when no build is offered because a build is
 * too heavy for the unit suite.
 *
 * Mutation-proved 2026-09-21 (11/11 caught, each applied to the real file and
 * restored byte-identically): 'unsafe-inline' re-added; 'preload' removed; one
 * character of a hash changed; one hash removed; a bogus extra hash added;
 * 'wasm-unsafe-eval' removed; require-trusted-types-for removed; one byte added
 * to the policy constant; a policy HOSTS entry no longer mirroring script-src;
 * the BaseLayout tag altered; a second is:inline script added to a layout.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { TRUSTED_TYPES_POLICY_SCRIPT } from '@/lib/trusted-types-policy';

const ROOT = join(__dirname, '..', '..');
const HEADERS_FILE = join(ROOT, 'public', '_headers');

const sha256 = (s: string): string =>
  `'sha256-${createHash('sha256').update(s, 'utf8').digest('base64')}'`;

/** Header values from the `/*` block of public/_headers (the only block with security headers). */
function siteWideHeaders(): Record<string, string> {
  const lines = readFileSync(HEADERS_FILE, 'utf8').split(/\r?\n/);
  const out: Record<string, string> = {};
  let inGlobal = false;
  for (const line of lines) {
    if (!line.startsWith(' ') && line.trim() !== '') {
      inGlobal = line.trim() === '/*';
      continue;
    }
    if (!inGlobal) continue;
    const t = line.trim();
    if (t === '' || t.startsWith('#')) continue;
    const idx = t.indexOf(':');
    if (idx === -1) continue;
    out[t.slice(0, idx).toLowerCase()] = t.slice(idx + 1).trim();
  }
  return out;
}

function directive(csp: string, name: string): string[] {
  const d = csp
    .split(';')
    .map((s) => s.trim())
    .find((s) => s === name || s.startsWith(name + ' '));
  if (!d) throw new Error(`CSP has no ${name} directive`);
  return d.slice(name.length).trim().split(/\s+/).filter(Boolean);
}

/** The exact inline strings Astro emits: island runtime + one loader per client directive. */
async function astroInlineScripts(): Promise<Record<string, string>> {
  const require = createRequire(import.meta.url);
  const astroDir = dirname(require.resolve('astro/package.json'));
  const load = async (rel: string): Promise<string> => {
    const mod = (await import(pathToFileURL(join(astroDir, rel)).href)) as { default: string };
    return mod.default;
  };
  return {
    island: await load('dist/runtime/server/astro-island.prebuilt.js'),
    load: await load('dist/runtime/client/load.prebuilt.js'),
    idle: await load('dist/runtime/client/idle.prebuilt.js'),
    visible: await load('dist/runtime/client/visible.prebuilt.js'),
    media: await load('dist/runtime/client/media.prebuilt.js'),
    only: await load('dist/runtime/client/only.prebuilt.js'),
  };
}

function walk(dir: string, ext: RegExp, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, ext, out);
    else if (ext.test(name)) out.push(p);
  }
  return out;
}

/**
 * Which client:* directives the source uses — each one makes Astro inline its
 * loader. Matched as an ATTRIBUTE on a component tag (`<Name … client:idle`),
 * not as bare text: HeroCanvas.astro mentions "client:load" in a comment
 * explaining why it is not used, and that must not count.
 */
function usedDirectives(): Set<string> {
  const used = new Set<string>();
  for (const f of walk(join(ROOT, 'src'), /\.(astro|mdx)$/)) {
    for (const m of readFileSync(f, 'utf8').matchAll(
      /<[A-Z][\w.]*\b[^>]*?\sclient:(load|idle|visible|media|only)(?=[\s=/>])/g
    )) {
      used.add(m[1] as string);
    }
  }
  return used;
}

describe('public/_headers — Content-Security-Policy', () => {
  const headers = siteWideHeaders();
  const csp = headers['content-security-policy'] ?? '';
  const scriptSrc = directive(csp, 'script-src');

  it('script-src has no unsafe-inline (hashes carry the inline scripts instead)', () => {
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    expect(scriptSrc).not.toContain("'unsafe-eval'");
  });

  it('keeps the load-bearing script-src sources documented in the header comments', () => {
    // Each of these has a paragraph in public/_headers explaining what breaks without it.
    for (const src of [
      "'self'",
      "'wasm-unsafe-eval'",
      'blob:',
      'https://cdn.jsdelivr.net',
      'https://accounts.google.com',
    ]) {
      expect(scriptSrc, `script-src lost ${src}`).toContain(src);
    }
    // Measured 2026-09-21 in wrangler pages dev: 'strict-dynamic' makes the
    // browser ignore 'self' and refuse every hoisted /_astro/*.js module
    // (30 CSP errors on /en/, 15 on /en/lab/embeddings/, zero islands hydrated).
    expect(scriptSrc).not.toContain("'strict-dynamic'");
  });

  it('style-src keeps unsafe-inline and lists no hashes (a single hash would switch it off)', () => {
    const styleSrc = directive(csp, 'style-src');
    expect(styleSrc).toContain("'unsafe-inline'");
    expect(styleSrc.some((s) => /^'sha(256|384|512)-/.test(s))).toBe(false);
  });

  it('requires Trusted Types for script sinks and does not restrict policy names', () => {
    expect(directive(csp, 'require-trusted-types-for')).toEqual(["'script'"]);
    // Svelte 5 registers `svelte-trusted-html`, GIS registers Closure policies;
    // a `trusted-types <names>` allowlist would break both. Since 2026-09-21 it
    // would also disarm the default policy itself: its createHTML sanitizes by
    // parsing, and it parses through a second, closure-private pass-through
    // policy (`tt-parse`) because DOMParser.parseFromString is a sink too. A
    // name allowlist that omitted `tt-parse` would make every innerHTML write
    // on the site return "" — fail closed, but blank.
    expect(csp).not.toMatch(/(^|;)\s*trusted-types\s/);
  });

  it('hashes exactly the inline scripts the build emits: Astro runtime + used directive loaders + TT policy', async () => {
    const astro = await astroInlineScripts();
    const used = usedDirectives();
    expect(used.size, 'no client:* directive found in src — the scan is broken').toBeGreaterThan(0);

    const expected = new Map<string, string>();
    expected.set(
      sha256(TRUSTED_TYPES_POLICY_SCRIPT),
      'Trusted Types default policy (src/lib/trusted-types-policy.ts)'
    );
    expected.set(
      sha256(astro.island),
      'Astro <astro-island> runtime (astro/dist/runtime/server/astro-island.prebuilt.js)'
    );
    for (const d of ['load', 'idle', 'visible', 'media', 'only'] as const) {
      if (used.has(d))
        expected.set(
          sha256(astro[d]),
          `Astro client:${d} loader (astro/dist/runtime/client/${d}.prebuilt.js)`
        );
    }

    const listed = scriptSrc.filter((s) => /^'sha(256|384|512)-/.test(s));
    const missing = [...expected].filter(([h]) => !listed.includes(h));
    const stale = listed.filter((h) => !expected.has(h));

    expect(
      missing,
      'script-src is missing hashes for inline scripts the build emits (Astro upgrade? new client:* directive? policy edited?). Add:\n' +
        missing.map(([h, what]) => `  ${h}   ← ${what}`).join('\n')
    ).toEqual([]);
    expect(
      stale,
      'script-src lists hashes that match no inline script the build emits — remove them:\n' +
        stale.map((h) => `  ${h}`).join('\n')
    ).toEqual([]);
    expect(new Set(listed).size, 'duplicate hash in script-src').toBe(listed.length);
  });

  it('the Trusted Types policy source is safe to inline verbatim', () => {
    // A literal "</script" would close the tag early. One line, no newlines:
    // a `//` comment anywhere would swallow the rest of the script.
    expect(TRUSTED_TYPES_POLICY_SCRIPT).not.toMatch(/<\/script/i);
    expect(TRUSTED_TYPES_POLICY_SCRIPT).not.toMatch(/[\r\n]/);
    // The default policy must be named `default` — any other name is just a policy.
    expect(TRUSTED_TYPES_POLICY_SCRIPT).toContain('createPolicy("default"');
    // The script-URL allowlist inside the policy mirrors the external script-src hosts.
    for (const host of scriptSrc.filter((s) => s.startsWith('https://'))) {
      expect(TRUSTED_TYPES_POLICY_SCRIPT, `policy HOSTS lacks ${host}`).toContain(`"${host}/"`);
    }
  });

  it('BaseLayout injects the policy constant verbatim as the first inline script', () => {
    const layout = readFileSync(join(ROOT, 'src', 'layouts', 'BaseLayout.astro'), 'utf8');
    expect(layout).toMatch(/<script is:inline set:html=\{TRUSTED_TYPES_POLICY_SCRIPT\} \/>/);
    // No other inline/define:vars script may sneak in ahead of it or anywhere else in src.
    for (const f of walk(join(ROOT, 'src'), /\.astro$/)) {
      const src = readFileSync(f, 'utf8');
      expect(
        src,
        `${f}: define:vars forces a page-varying inline script that cannot be hashed`
      ).not.toMatch(/<script[^>]*\bdefine:vars/);
      const inlineTags = src.match(/<script[^>]*\bis:inline\b[^>]*>/g) ?? [];
      for (const tag of inlineTags) {
        expect(
          tag,
          `${f}: an is:inline script that is not the TT policy needs its own sha256 in public/_headers`
        ).toMatch(/set:html=\{TRUSTED_TYPES_POLICY_SCRIPT\}|type="application\/ld\+json"/);
      }
    }
  });

  it('(when CSP_DIST points at a build) every inline script on disk is hashed, and nothing else', () => {
    const dist = process.env.CSP_DIST;
    if (!dist || !existsSync(dist)) return; // opt-in: a build is too heavy for the unit suite
    const onDisk = new Map<string, string[]>();
    for (const f of walk(dist, /\.html$/)) {
      const html = readFileSync(f, 'utf8');
      for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
        const attrs = m[1] ?? '';
        if (/\bsrc\s*=/.test(attrs) || /application\/ld\+json/i.test(attrs)) continue;
        const h = sha256(m[2] ?? '');
        onDisk.set(h, [...(onDisk.get(h) ?? []), f.slice(dist.length)]);
      }
    }
    const listed = new Set(scriptSrc.filter((s) => /^'sha(256|384|512)-/.test(s)));
    const unhashed = [...onDisk].filter(([h]) => !listed.has(h));
    expect(
      unhashed,
      'inline scripts in the build with no hash in script-src:\n' +
        unhashed.map(([h, pages]) => `  ${h}  (${pages.length} pages, e.g. ${pages[0]})`).join('\n')
    ).toEqual([]);
    const unused = [...listed].filter((h) => !onDisk.has(h));
    expect(unused, 'hashes in script-src that no page in the build uses').toEqual([]);
  });
});

describe('public/_headers — Strict-Transport-Security', () => {
  const hsts = siteWideHeaders()['strict-transport-security'] ?? '';
  const tokens = hsts.split(';').map((s) => s.trim().toLowerCase());

  it('meets the hstspreload.org submission bar: 1y max-age, includeSubDomains, preload', () => {
    const maxAge = Number((tokens.find((t) => t.startsWith('max-age=')) ?? 'max-age=0').slice(8));
    expect(maxAge).toBeGreaterThanOrEqual(31536000);
    expect(tokens).toContain('includesubdomains');
    expect(tokens).toContain('preload');
  });
});
