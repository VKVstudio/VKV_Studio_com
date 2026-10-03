/**
 * The Trusted Types default policy, EXECUTED.
 * ===========================================
 * The policy in src/lib/trusted-types-policy.ts is sold as "not a pass-through".
 * Until 2026-09-21 nothing ever called it: csp-headers.test.ts hashed its bytes
 * and asserted its shape, and a refutation pass then ran the real thing in a
 * browser and walked three payloads straight past `createHTML` —
 * `<img/onerror=alert(1) src=x>`, `<img/src=x/onerror=alert(1)>` (a `/`
 * separates attributes, the old regex only looked for whitespace) and
 * `<img src="a>b" onerror=alert(1)>` (`[^>]*` cannot cross a `>` inside a
 * quoted value). A test that cannot fail on a bypass is not a test.
 *
 * A SECOND refutation pass (48 payloads in headless Chrome, ~75 in jsdom) then
 * confirmed the rewritten core — zero handlers, zero banned elements, zero
 * javascript:/data: URLs survive — and measured three properties this file had
 * claimed and never checked:
 *   1. `is=` survived. `removeAttribute('is')` clears the content attribute but
 *      not the element's `is` value, and the serializer re-emits it, so
 *      `<p is="evil-el">x</p>` round-tripped unchanged.
 *   2. `safeUrl`'s protocol-relative check tested for a literal `//`, which
 *      `/\`, `\/` and `\\` all spell around — in srcset candidates too.
 *   3. "passes the writers' output through UNCHANGED" was false for ~8% of
 *      `renderInline` output: the sanitizer parsed in DOCUMENT context, which
 *      drops the leading whitespace the `<template>` sink keeps.
 * All three are fixed in the policy, not papered over here, and each has a
 * dedicated test below plus a 2000-case fuzz against a <template>-parsed
 * reference.
 *
 * So this file EXECUTES the shipped string. It boots a jsdom window, installs a
 * minimal `window.trustedTypes` that records what the script registers, evals
 * `TRUSTED_TYPES_POLICY_SCRIPT` verbatim (the same bytes BaseLayout injects and
 * public/_headers hashes), and drives the captured `default` policy's
 * createHTML / createScriptURL / createScript. Nothing here re-implements the
 * policy; the only thing under test is what ships.
 *
 * WHY jsdom. The parsing rules the payloads below abuse — `noscript` children
 * being markup in a scripting-disabled document, MathML/SVG foreign content,
 * foster parenting out of `<table>`, `/` as an attribute separator — are the
 * HTML5 tree-construction algorithm, not something a regex-based stand-in
 * reproduces. jsdom parses with parse5, i.e. the same algorithm Chrome runs, so
 * a payload that mutates here mutates there. It is a devDependency added for
 * this file (the repo had no DOM environment; the rest of the suite stays on
 * `environment: 'node'` and imports nothing from here).
 *
 * WHAT A GREEN RUN PROVES, AND WHAT IT DOES NOT. It proves the policy
 * neutralises the corpus and preserves the vocabulary the site's three
 * innerHTML writers emit. It does not prove Chrome agrees byte-for-byte about
 * serialization; that was checked separately by loading the built site under
 * `wrangler pages dev` with a headless Chrome listening for
 * securitypolicyviolation (see the task log for the numbers).
 *
 * MUTATION-PROVED 2026-09-21 (4/4 caught; each mutation was applied to the real
 * src/lib/trusted-types-policy.ts — to the function AND the shipped literal
 * together, so it was a behaviour regression and not mere drift — the suite was
 * run, and the file restored byte-identically, md5 re-checked):
 *   `is` added to every attribute allowlist                 → 4 tests failed
 *   the rebuild reverted to removeAttribute pruning         → 4 tests failed
 *   safeUrl reverted to the `//` + scheme-regex string check → 1 test failed
 *   the shipped `parse` reverted to document context        → 3 tests failed
 * Note what the third line means: the backslash payloads in BYPASS_CORPUS do
 * NOT catch that regression on their own (assertNeutralised is about execution,
 * and a cross-origin image URL is not execution) — the dedicated two-origin
 * test below is what catches it. That is why it exists.
 *
 * TWO ORIGINS. Since `safeUrl` resolves rather than pattern-matches, its
 * verdicts depend on the page. The script is therefore booted twice: once at
 * https://vkvstudio.com/en/ (production) and once at http://localhost:8794/en/
 * (the `wrangler pages dev` preview the same payloads were measured against).
 * The backslash-authority payloads are dropped on the http origin and resolve
 * to ordinary cross-origin https images on the https one; both are asserted.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  sanitizeHtml,
  SANITIZER_SOURCE,
  TRUSTED_TYPES_POLICY_SCRIPT,
} from '@/lib/trusted-types-policy';
import { renderInline } from '@/lib/synapse-render';

const ROOT = join(__dirname, '..', '..');

interface PolicyRules {
  createHTML: (s: string) => string;
  createScriptURL: (s: string) => string | null;
  createScript: (s: string) => string | null;
}

/**
 * jsdom ships no type declarations and the repo has no @types/jsdom (nor
 * @types/node), so the constructor is imported through an explicit shape
 * instead of an implicit `any`.
 */
interface JsdomWindow {
  eval: (code: string) => unknown;
  DOMParser: new () => { parseFromString: (s: string, type: string) => Document };
  trustedTypes?: unknown;
}
interface JsdomCtor {
  new (html: string, options: { url: string; runScripts: 'outside-only' }): { window: JsdomWindow };
}

/** Everything one booted page gives us: the registered policy plus test-side parsers. */
interface Booted {
  policy: PolicyRules;
  registered: string[];
  /** A `parse` for calling the exported function directly — mirrors the shipped one. */
  parse: (html: string) => HTMLTemplateElement | null;
  /** What the `{@html}` sink itself would build and re-serialize: template.innerHTML. */
  fragmentReference: (html: string) => string;
  /** What a DOMParser *document* parse would have produced — the old, wrong context. */
  documentReference: (html: string) => string;
}

/**
 * Boot the shipped script in a jsdom page at `url` and capture its policies.
 *
 * `url` is a parameter because `safeUrl` now RESOLVES attribute values instead
 * of pattern-matching them, so its verdicts depend on the page's origin and
 * scheme — the https production origin and the http `wrangler pages dev`
 * preview disagree about the backslash payloads below, and both are real.
 */
async function boot(url: string): Promise<Booted> {
  const { JSDOM } = (await import('jsdom')) as unknown as { JSDOM: JsdomCtor };
  const dom = new JSDOM('<!DOCTYPE html><html><head></head><body></body></html>', {
    url,
    runScripts: 'outside-only',
  });
  const win = dom.window;
  const registered: string[] = [];
  const captured: Record<string, PolicyRules> = {};
  win.trustedTypes = {
    createPolicy(name: string, rules: PolicyRules): PolicyRules {
      registered.push(name);
      captured[name] = rules;
      return rules;
    },
  };
  win.eval(TRUSTED_TYPES_POLICY_SCRIPT);
  const def = captured['default'];
  if (!def) throw new Error('the shipped script registered no `default` policy');
  const parser = new win.DOMParser();
  // The same two steps the shipped `parse` performs, so the exported function
  // under test and the shipped string see byte-identical input trees.
  const template = (html: string): HTMLTemplateElement | null => {
    const doc = parser.parseFromString('<template></template>', 'text/html');
    const t = doc.getElementsByTagName('template')[0] ?? null;
    if (!t) return null;
    t.innerHTML = html;
    return t;
  };
  return {
    policy: def,
    registered,
    parse: template,
    fragmentReference: (html: string): string => template(html)?.innerHTML ?? '',
    documentReference: (html: string): string =>
      parser.parseFromString(html, 'text/html').body.innerHTML,
  };
}

let policy: PolicyRules;
let registered: string[];
let parse: (html: string) => HTMLTemplateElement | null;
let fragmentReference: (html: string) => string;
let documentReference: (html: string) => string;
/** The same script booted on the http preview origin (wrangler pages dev). */
let devPolicy: PolicyRules;

beforeAll(async () => {
  const prod = await boot('https://vkvstudio.com/en/');
  policy = prod.policy;
  registered = prod.registered;
  parse = prod.parse;
  fragmentReference = prod.fragmentReference;
  documentReference = prod.documentReference;
  devPolicy = (await boot('http://localhost:8794/en/')).policy;
});

/** Every property the layer claims: no handler, no executing element, no js: URL. */
function assertNeutralised(out: string, label: string): void {
  expect(out, `${label}: an on*= handler attribute survived`).not.toMatch(/\son[a-z]+\s*=/i);
  expect(out, `${label}: an executing or content-model-shifting element survived`).not.toMatch(
    /<\s*\/?\s*(script|iframe|svg|math|base|meta|link|object|embed|template|noscript|style|frame|frameset|applet|noembed)\b/i
  );
  expect(out, `${label}: a javascript: URL survived`).not.toMatch(/javascript\s*:/i);
  expect(out, `${label}: a banned attribute survived`).not.toMatch(
    /\s(href|srcdoc|formaction|style|action|xlink:href|http-equiv)\s*=/i
  );
  expect(out, `${label}: a data: URL survived`).not.toMatch(/data\s*:/i);
  // `is=` upgrades a plain tag to a customized built-in, so it is a code path,
  // not decoration. It gets its own clause because it is not an ordinary
  // attribute: the parser stores it as the element's `is` value at creation
  // time and the serializer re-emits it even after removeAttribute('is').
  expect(out, `${label}: an is= (customized built-in) survived`).not.toMatch(/\sis\s*=/i);
  // Everything that reaches a fetch must be same-origin or https after
  // resolution. Nothing in the corpus legitimately names another scheme.
  expect(out, `${label}: a non-https absolute URL survived`).not.toMatch(
    /="(?!https:)[a-zA-Z][a-zA-Z0-9+.-]*:/
  );
}

/**
 * The corpus. Each entry is a payload the policy MUST neutralise. The first
 * three are the measured bypasses of the regex version — they are the reason
 * this file exists.
 */
const BYPASS_CORPUS: Array<[string, string]> = [
  ['regex bypass 1 — "/" before the handler', '<img/onerror=alert(1) src=x>'],
  ['regex bypass 2 — "/" between attributes', '<img/src=x/onerror=alert(1)>'],
  ['regex bypass 3 — ">" inside a quoted value', '<img src="a>b" onerror=alert(1)>'],
  ['plain handler', '<img src=x onerror=alert(1)>'],
  ['svg handler', '<svg onload=alert(1)>'],
  ['svg wrapping a script', '<svg><script>alert(1)</script></svg>'],
  ['iframe srcdoc', '<iframe srcdoc="&lt;img src=x onerror=alert(1)&gt;"></iframe>'],
  ['javascript: href', '<a href="javascript:alert(1)">x</a>'],
  ['javascript: img src', '<img src="javascript:alert(1)">'],
  ['entity-encoded javascript: href', '<a href="javascript&colon;alert(1)">x</a>'],
  ['entity-encoded javascript: img src', '<img src="javascript&colon;alert(1)">'],
  ['newline-split scheme', '<img src="java\nscript:alert(1)">'],
  ['base tag', '<base href="https://evil.example/">'],
  ['meta refresh', '<meta http-equiv="refresh" content="0;url=https://evil.example/">'],
  ['template smuggling', '<template><img src=x onerror=alert(1)></template>'],
  ['mXSS — noscript', '<noscript><p title="</noscript><img src=x onerror=alert(1)>"></noscript>'],
  [
    'mXSS — mglyph/style inside math',
    '<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>',
  ],
  ['unclosed nested tags', '<div><p><span><img src=x onerror=alert(1)'],
  ['uppercase tags', '<IMG SRC=x ONERROR=alert(1)>'],
  ['mixed-case tags', '<ImG sRc=x OnErRoR=alert(1)><ScRiPt>alert(1)</ScRiPt>'],
  [
    'script with a jsDelivr src (the CSP-allowlist bypass)',
    '<script src="https://cdn.jsdelivr.net/npm/x.js"></script>',
  ],
  ['object/embed', '<object data="x.swf"></object><embed src="x.swf">'],
  [
    'form hijack',
    '<form action="https://evil.example/"><button formaction="https://evil.example/">go</button></form>',
  ],
  ['style attribute', '<p style="background:url(javascript:alert(1))">x</p>'],
  ['data: image src', '<img src="data:text/html,<script>alert(1)</script>">'],
  ['protocol-relative src', '<img src="//evil.example/x.png">'],
  ['comment smuggling', '<!--<img src=x onerror=alert(1)>-->'],
  // Added 2026-09-21 after the second refutation pass measured them surviving.
  ['is= on a kept element', '<p is="evil-el">x</p>'],
  ['is= on an img with a legitimate src', '<img is="x-img" src="/a.png">'],
  [
    'is= smuggled through an unknown wrapper',
    '<div is="evil-el"><span is="evil-el">x</span></div>',
  ],
  ['backslash authority — /\\', '<img src="/\\evil.example/p.png">'],
  ['backslash authority — \\/', '<img src="\\/evil.example/p.png">'],
  ['backslash authority — \\\\', '<img src="\\\\evil.example/p.png">'],
  [
    'backslash authority in srcset',
    '<img srcset="/\\evil.example/p.png 1x, \\\\evil.example/q.png 2x">',
  ],
  ['backslash authority in <source srcset>', '<source srcset="\\/evil.example/p.png 2x">'],
];

/**
 * A seeded LCG (Numerical Recipes constants) so the fuzz below is the SAME
 * 2000 cases on every machine and every run: a failure is reproducible from the
 * case index printed with it, and a green run means the same thing tomorrow.
 */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return (): number => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * Fragments a Synapse paragraph is actually made of, weighted towards the thing
 * the document-vs-fragment divergence needs: leading whitespace. `renderInline`
 * trims newlines at the ends but not spaces or tabs, so a case that starts with
 * one produces output that a document parse would have eaten.
 */
const FUZZ_TOKENS: string[] = [
  ' ',
  '  ',
  '\t',
  '\t ',
  '\n',
  'word',
  'слово',
  '**bold**',
  '*italic*',
  '`code`',
  '## Heading',
  '- bullet',
  '5 > 3 && 2 < 4',
  '"quoted" & escaped',
  '<strong>raw</strong>',
  '<em>raw</em>',
  '<br>',
  '<li>item</li>',
  '<h2>h</h2>',
  '<p>para</p>',
  '<script>alert(1)</script>',
  '<img src=x onerror=alert(1)>',
  '<p is="evil-el">x</p>',
  '<img src="/\\evil.example/p.png">',
  '&amp;&lt;&#10;',
  '— em dash',
  '{{placeholder}}',
  '',
];

function fuzzInput(rnd: () => number): string {
  const n = 1 + Math.floor(rnd() * 6);
  let out = '';
  for (let i = 0; i < n; i++) {
    const tok = FUZZ_TOKENS[Math.floor(rnd() * FUZZ_TOKENS.length)];
    out += tok ?? '';
  }
  return out;
}

describe('Trusted Types default policy — createHTML (the shipped script, executed)', () => {
  it('registers a `default` policy and the `tt-parse` helper it parses through', () => {
    expect(registered).toContain('default');
    expect(registered).toContain('tt-parse');
    expect(registered.indexOf('tt-parse')).toBeLessThan(registered.indexOf('default'));
  });

  for (const [label, payload] of BYPASS_CORPUS) {
    it(`neutralises: ${label}`, () => {
      assertNeutralised(policy.createHTML(payload), label);
    });
  }

  it('the three measured bypasses lose the handler but keep the harmless <img>', () => {
    // Proof the sanitizer is stripping, not just returning "" for anything scary.
    expect(policy.createHTML('<img/onerror=alert(1) src=x>')).toBe('<img src="x">');
    // The `>` stays raw: HTML attribute-value serialization escapes only `&`,
    // U+00A0 and `"`, and a `>` inside quotes re-parses as itself — which is
    // why the fixpoint check below still settles on this string.
    expect(policy.createHTML('<img src="a>b" onerror=alert(1)>')).toBe('<img src="a>b">');
    // Measured, and worth recording because it corrects the refutation note: in
    // `<img/src=x/onerror=alert(1)>` only the FIRST `/` separates — inside an
    // unquoted attribute value a `/` is an ordinary character, so the tokenizer
    // produces one attribute, src="x/onerror=alert(1)", and no handler ever
    // existed. The old regex still failed to see it; the parser makes the
    // question moot, and the value survives as the dead relative URL it is.
    expect(policy.createHTML('<img/src=x/onerror=alert(1)>')).toBe(
      '<img src="x/onerror=alert(1)">'
    );
  });

  it('unwraps unknown elements to their (escaped) text instead of dropping the content', () => {
    expect(policy.createHTML('<a href="javascript:alert(1)">click</a>')).toBe('click');
    expect(
      policy.createHTML('<div><h1>Title</h1><table><tr><td>cell</td></tr></table></div>')
    ).toBe('Titlecell');
  });

  it('removes executing / content-model-shifting elements WITH their subtree', () => {
    expect(policy.createHTML('<script>alert(1)</script>')).toBe('');
    expect(policy.createHTML('<style>body{background:url(x)}</style>')).toBe('');
    expect(policy.createHTML('<template><img src=x onerror=alert(1)></template>')).toBe('');
    expect(policy.createHTML('<svg><script>alert(1)</script></svg>')).toBe('');
    expect(policy.createHTML('keep<noscript><img src=x onerror=alert(1)></noscript>this')).toBe(
      'keepthis'
    );
  });

  it('keeps the allowed vocabulary with its safe attributes', () => {
    const poster =
      '<picture><source srcset="/hero-poster.avif" type="image/avif" /><source srcset="/hero-poster.webp" type="image/webp" /><img src="/hero-poster.jpg" alt="" class="hero__poster-img" /></picture>';
    const out = policy.createHTML(poster);
    expect(out).toContain('<picture>');
    expect(out).toContain('srcset="/hero-poster.avif"');
    expect(out).toContain('type="image/avif"');
    expect(out).toContain('src="/hero-poster.jpg"');
    expect(out).toContain('class="hero__poster-img"');
    expect(out).toContain('alt=""');

    expect(policy.createHTML('<strong>bold</strong>')).toBe('<strong>bold</strong>');
    expect(policy.createHTML('<code class="inline-code">x</code>')).toBe(
      '<code class="inline-code">x</code>'
    );
    expect(policy.createHTML('<mark class="var-highlight">{{name}}</mark>')).toBe(
      '<mark class="var-highlight">{{name}}</mark>'
    );
    expect(policy.createHTML('a<br>b')).toBe('a<br>b');
    expect(policy.createHTML('<em>i</em><b>b</b><i>i</i><p>p</p><span>s</span>')).toBe(
      '<em>i</em><b>b</b><i>i</i><p>p</p><span>s</span>'
    );
  });

  it('keeps https and root-relative image URLs, drops everything else', () => {
    expect(policy.createHTML('<img src="/hero-poster.jpg">')).toBe('<img src="/hero-poster.jpg">');
    expect(policy.createHTML('<img src="hero.png">')).toBe('<img src="hero.png">');
    expect(policy.createHTML('<img src="https://example.com/a.png">')).toBe(
      '<img src="https://example.com/a.png">'
    );
    expect(policy.createHTML('<img src="http://example.com/a.png">')).toBe('<img>');
    expect(policy.createHTML('<img src="data:image/gif;base64,R0lGOD">')).toBe('<img>');
    expect(policy.createHTML('<source srcset="/a.avif 1x, javascript:alert(1) 2x">')).toBe(
      '<source>'
    );
    expect(policy.createHTML('<source srcset="/a.avif 1x, /b.avif 2x">')).toBe(
      '<source srcset="/a.avif 1x, /b.avif 2x">'
    );
  });

  it('strips is= by REBUILDING kept elements, not by removing the attribute', () => {
    // The measured failure this replaced: `removeAttribute('is')` clears the
    // content attribute but not the element's `is` VALUE (set at creation from
    // the token the parser saw), and the serializer re-emits it — so both of
    // these round-tripped byte-identical through the old sanitizer and reached
    // the sink as customized built-ins. Rebuilding with createElement(tag) and
    // copying only allowlisted attributes makes that impossible: `is` is not on
    // any allowlist, and a freshly created element has no `is` value to emit.
    expect(policy.createHTML('<p is="evil-el">x</p>')).toBe('<p>x</p>');
    expect(policy.createHTML('<img is="x-img" src="/a.png">')).toBe('<img src="/a.png">');
    expect(policy.createHTML('<span is="evil-el" class="msg-bullet">b</span>')).toBe(
      '<span class="msg-bullet">b</span>'
    );
    // Proof the old approach really did fail here, run against the same parser:
    // remove the attribute and the serializer still prints it.
    const tpl = parse('<p is="evil-el">x</p>');
    const el = tpl?.content.firstElementChild;
    el?.removeAttribute('is');
    expect(tpl?.innerHTML, 'removeAttribute("is") is expected to be insufficient').toBe(
      '<p is="evil-el">x</p>'
    );
  });

  it('judges URLs by RESOLVING them, so backslash spellings of an authority cannot pose as paths', () => {
    // Measured bypass: the old check rejected a literal leading `//` only, and
    // the URL parser treats `\` as `/` for special schemes, so all three
    // spellings below carried an authority past a check that thought they were
    // same-origin paths. Resolution makes the verdict the one the browser will
    // act on. On the http preview origin they resolve to http://evil.example/
    // and are dropped:
    for (const value of [
      '/\\evil.example/p.png',
      '\\/evil.example/p.png',
      '\\\\evil.example/p.png',
      '//evil.example/p.png',
    ]) {
      expect(devPolicy.createHTML(`<img src="${value}">`), `http origin kept ${value}`).toBe(
        '<img>'
      );
      expect(devPolicy.createHTML(`<img srcset="${value} 1x">`), `http origin kept ${value}`).toBe(
        '<img>'
      );
      expect(
        devPolicy.createHTML(`<source srcset="${value} 2x">`),
        `http origin kept ${value}`
      ).toBe('<source>');
    }
    // On the https production origin the same four resolve to
    // https://evil.example/p.png — a cross-origin HTTPS IMAGE, which is exactly
    // what an explicit `https://example.com/a.png` has always been allowed to
    // be (see the test above) and which img-src in public/_headers governs.
    // Recorded rather than asserted-away: the rule is "same-origin or https
    // with a host", and these now get the honest answer instead of being
    // mistaken for local paths.
    expect(policy.createHTML('<img src="/\\evil.example/p.png">')).toBe(
      '<img src="/\\evil.example/p.png">'
    );
    // Non-https schemes stay refused on both origins.
    expect(policy.createHTML('<img src="http://evil.example/p.png">')).toBe('<img>');
    expect(policy.createHTML('<img src="file://evil.example/p.png">')).toBe('<img>');
    expect(policy.createHTML('<img src="ftp://evil.example/p.png">')).toBe('<img>');
    expect(policy.createHTML('<img srcset="/a.avif 1x, http://evil.example/b.png 2x">')).toBe(
      '<img>'
    );
  });

  it('parses in FRAGMENT context, so leading whitespace survives exactly as the sink keeps it', () => {
    // `{@html}` assigns to a <template>'s innerHTML (fragment parsing, "in
    // body"); DOMParser.parseFromString runs the document algorithm, whose
    // "before html"/"before head" modes DROP leading whitespace. The sanitizer
    // used the document algorithm and therefore silently reindented output.
    for (const s of ['   indented', '\t', '\t\tdeep', '  <strong>a</strong>', '\n  x', ' ']) {
      expect(policy.createHTML(s), `fragment round-trip changed ${JSON.stringify(s)}`).toBe(s);
      expect(fragmentReference(s), 'the sink itself must agree').toBe(s);
    }
    // The teeth: the old context really did rewrite these.
    expect(documentReference('   indented')).toBe('indented');
    expect(documentReference('\t')).toBe('');
    expect(documentReference('\t\tdeep')).toBe('deep');
  });

  it("passes the real output of the site's three innerHTML writers through UNCHANGED", () => {
    // If the policy mangled these, the Synapse terminal, the Prompt Architect
    // and the hero poster would each render differently under the CSP than in
    // dev — exactly the failure mode a layer like this must not introduce.
    const samples = [
      renderInline('Hello **world**, `code` and *italics*'),
      renderInline('## Heading\n- bullet one\n- bullet two'),
      renderInline('<script>alert(1)</script> and <img src=x onerror=alert(1)>'),
      renderInline('5 > 3 && 2 < 4 — "quoted" & escaped'),
      // highlightVariables (PromptBlock.svelte) output shape:
      'You are a <mark class="var-highlight">{{role}}</mark>.<br>Next line',
      '<span class="pb-placeholder">...</span>',
    ];
    for (const s of samples) {
      expect(policy.createHTML(s), `writer output was rewritten: ${s}`).toBe(s);
      // …and the sink's own round-trip agrees, so "unchanged" is measured
      // against what the browser would build, not just against the input.
      expect(fragmentReference(s), `the sink itself rewrites: ${s}`).toBe(s);
    }
  });

  it('fuzz: 2000 renderInline outputs survive byte-for-byte, and the old context did not', () => {
    // The hand-written samples above were the reason the "UNCHANGED" claim was
    // believed for a day while being false for ~8% of real output: none of them
    // happened to start with whitespace. This generates inputs that do.
    //
    // Two references, both from the same jsdom parser:
    //   fragmentReference — what the `{@html}` sink itself builds and
    //     re-serializes. THE POLICY MUST EQUAL IT, on every case. That is the
    //     whole correctness claim, and it is the right claim rather than
    //     `=== s`: `renderInline` can emit misnested markup (`*` and `**` are
    //     matched independently of the raw `<em>`/`<strong>` it rewrites, so
    //     `<em>raw<strong></em>raw</strong>` is reachable), and the sink's own
    //     adoption-agency repair changes those bytes with or without a policy.
    //     Measured on the seed below: 15/2000 cases (0.75%) are misnested that
    //     way, and the policy reproduces the sink's repair exactly in all of
    //     them. For the other 1985 the policy is the identity.
    //   documentReference — what DOMParser's document algorithm produces, i.e.
    //     the context the sanitizer used until 2026-09-21. Counting how often
    //     it differs is what gives this fuzz teeth: if it were never different,
    //     the generator would not be exercising the bug that was fixed.
    //     Measured: 283/2000 (14.2%) of these generated outputs would have been
    //     rewritten by the old context. (The refutation pass reported ~8% on
    //     its own corpus; this generator leans harder on leading whitespace, so
    //     the rate is its own, not a reproduction of that number.)
    const rnd = lcg(20260921);
    let divergent = 0;
    let misnested = 0;
    let identity = 0;
    for (let i = 0; i < 2000; i++) {
      const input = fuzzInput(rnd);
      const s = renderInline(input);
      const sink = fragmentReference(s);
      expect(
        policy.createHTML(s),
        `case ${i} (input ${JSON.stringify(input)}): policy output != what the sink would build`
      ).toBe(sink);
      if (sink === s) identity++;
      else misnested++;
      if (documentReference(s) !== s) divergent++;
    }
    expect(identity + misnested).toBe(2000);
    expect(
      identity,
      'far fewer renderInline outputs are parser-stable than measured — renderInline changed?'
    ).toBeGreaterThan(1800);
    expect(
      divergent,
      'no generated case diverged between fragment and document parsing — the fuzz is not exercising the bug it exists for'
    ).toBeGreaterThan(50);
    // 2000 cases × (1 policy call + 2 reference parses) in jsdom measured
    // ~10 s on the dev machine, so the 5 s default would flake.
  }, 60_000);

  it('is a fixpoint: sanitizing twice changes nothing', () => {
    for (const [label, payload] of BYPASS_CORPUS) {
      const once = policy.createHTML(payload);
      expect(policy.createHTML(once), `${label}: not stable under a second pass`).toBe(once);
    }
  });

  it('handles junk input without throwing (fails closed, never open)', () => {
    expect(policy.createHTML('')).toBe('');
    expect(policy.createHTML('plain text')).toBe('plain text');
    expect(policy.createHTML('<'.repeat(200))).not.toMatch(/\son[a-z]+\s*=/i);
    expect(policy.createHTML('<p>'.repeat(60) + 'deep')).toContain('deep');
  });

  it('the exported function and the stringified one that ships agree on every payload', () => {
    for (const [label, payload] of BYPASS_CORPUS) {
      expect(
        sanitizeHtml(parse, payload),
        `${label}: exported function drifted from the shipped source`
      ).toBe(policy.createHTML(payload));
    }
  });
});

describe('Trusted Types default policy — createScriptURL / createScript', () => {
  it('allows same-origin, blob: and the two script-src hosts', () => {
    expect(policy.createScriptURL('/_astro/tokenizer.js')).toBe('/_astro/tokenizer.js');
    expect(policy.createScriptURL('https://vkvstudio.com/_astro/x.js')).toBe(
      'https://vkvstudio.com/_astro/x.js'
    );
    expect(policy.createScriptURL('blob:https://vkvstudio.com/6f0a-uuid')).toBe(
      'blob:https://vkvstudio.com/6f0a-uuid'
    );
    expect(policy.createScriptURL('https://cdn.jsdelivr.net/npm/onnxruntime-web/ort.mjs')).toBe(
      'https://cdn.jsdelivr.net/npm/onnxruntime-web/ort.mjs'
    );
    expect(policy.createScriptURL('https://accounts.google.com/gsi/client')).toBe(
      'https://accounts.google.com/gsi/client'
    );
  });

  it('allows only the exact explicit Turnstile loader on the challenge host', () => {
    const loader = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    expect(policy.createScriptURL(loader)).toBe(loader);
    for (const url of [
      'https://challenges.cloudflare.com/turnstile/v0/api.js',
      loader + '&callback=other',
      loader + '#other',
      'https://challenges.cloudflare.com/other.js',
      'https://challenges.cloudflare.com.evil.example/turnstile/v0/api.js?render=explicit',
      'http://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit',
    ]) expect(policy.createScriptURL(url), url).toBeNull();
  });

  it('refuses every other script URL, and refuses createScript outright', () => {
    expect(policy.createScriptURL('https://evil.example/x.js')).toBeNull();
    expect(policy.createScriptURL('https://cdn.jsdelivr.net.evil.example/x.js')).toBeNull();
    expect(policy.createScriptURL('javascript:alert(1)')).toBeNull();
    expect(policy.createScript('alert(1)')).toBeNull();
    expect(policy.createScript('')).toBeNull();
  });
});

describe('Trusted Types default policy — the shipped bytes', () => {
  it('the shipped literal IS the exported function, flattened', () => {
    // SANITIZER_SOURCE is a literal on purpose (a toString()-derived constant
    // hashes differently under vitest's esbuild and Astro's minifying one — see
    // the note on the constant). This is the assertion that keeps the two in
    // step: edit the function, run this, paste what it prints.
    const derived = sanitizeHtml.toString().replace(/\s*\n\s*/g, ' ');
    expect(
      SANITIZER_SOURCE,
      'src/lib/trusted-types-policy.ts: SANITIZER_SOURCE no longer matches sanitizeHtml. Replace the literal with:\n\n' +
        JSON.stringify(derived) +
        '\n'
    ).toBe(derived);
    expect(SANITIZER_SOURCE.startsWith('function sanitizeHtml(')).toBe(true);
    expect(TRUSTED_TYPES_POLICY_SCRIPT).toContain(SANITIZER_SOURCE);
    expect(TRUSTED_TYPES_POLICY_SCRIPT).toContain('sanitizeHtml(parse,String(s))');
  });

  it('carries no import, no require and no comment into the page', () => {
    expect(SANITIZER_SOURCE).not.toMatch(/\bimport\b/);
    expect(SANITIZER_SOURCE).not.toMatch(/\brequire\b/);
    expect(SANITIZER_SOURCE).not.toMatch(/\/\//); // a `//` comment would kill the one-line script
    expect(SANITIZER_SOURCE).not.toMatch(/\/\*/);
    expect(TRUSTED_TYPES_POLICY_SCRIPT).not.toMatch(/[\r\n]/);
    expect(TRUSTED_TYPES_POLICY_SCRIPT).not.toMatch(/<\/script/i);
  });

  it('BaseLayout injects the constant verbatim', () => {
    const layout = readFileSync(join(ROOT, 'src', 'layouts', 'BaseLayout.astro'), 'utf8');
    expect(layout).toContain(
      "import { TRUSTED_TYPES_POLICY_SCRIPT } from '@/lib/trusted-types-policy'"
    );
    expect(layout).toMatch(/<script is:inline set:html=\{TRUSTED_TYPES_POLICY_SCRIPT\} \/>/);
  });

  it('stays a reasonable size for a script inlined on every page', () => {
    // 34 pages × this. Recorded so a careless edit that doubles it is visible.
    // 2026-09-21: 2902 B → 3376 B (+474 B, +16%; ~16 KB across the 34 pages)
    // for the three fixes — fragment parsing via a <template>, rebuilding kept
    // elements instead of pruning them, and URL resolution in place of the
    // scheme regex. The bound is snug on purpose: it is a tripwire, not a
    // budget.
    // 2026-10-03: the exact Turnstile loader adds 88 bytes (3464 B total).
    expect(Buffer.byteLength(TRUSTED_TYPES_POLICY_SCRIPT, 'utf8')).toBeLessThan(3552);
  });
});
