/**
 * Trusted Types default policy — the source of the one inline script the site
 * ships on purpose.
 *
 * WHY THIS EXISTS. `Content-Security-Policy: require-trusted-types-for 'script'`
 * makes every string→DOM sink (innerHTML, DOMParser, Worker(url), script.src,
 * eval…) refuse a plain string unless a Trusted Types policy has vouched for it.
 * A page opts in to the check by shipping a policy named `default`: the browser
 * calls that policy on every unwrapped sink write, and a `null` return is a
 * violation (a thrown TypeError under enforcement, a console report under
 * Report-Only). Without a default policy the whole Svelte/GSAP/onnxruntime stack
 * below would stop at its first innerHTML, so this file IS the feature.
 *
 * WHY THE POLICY IS NOT A PASS-THROUGH. `createHTML: (s) => s` satisfies the
 * Lighthouse `trusted-types-xss` audit and protects nothing. This policy is a
 * second, generic layer behind the site's content-specific sanitizers, written
 * from what actually reaches each sink (audited 2026-09-21; the inventory lives
 * in tests/unit/csp-headers.test.ts and tests/unit/trusted-types-policy.test.ts):
 *
 *   createHTML — three code paths hand strings to innerHTML: the Synapse
 *     terminal ({@html renderInline(...)}, src/lib/synapse-render.ts), the
 *     Prompt Architect block ({@html highlightVariables(...)},
 *     PromptBlock.svelte) and the hero's mobile poster (HeroCanvas.astro).
 *     Svelte's `{@html}` assigns the raw string to a <template>'s innerHTML
 *     WITHOUT wrapping it first (svelte/src/internal/client/dom/blocks/html.js),
 *     so those two really do pass through here. Between them the three emit a
 *     CLOSED tag vocabulary: span, br, strong, em, b, i, code, mark, p,
 *     picture, source, img — and the only attributes they emit are `class`
 *     (msg-heading, msg-bullet, inline-code, var-highlight, pb-placeholder,
 *     hero__poster-img), plus `alt`, `src` and `srcset` on the poster's
 *     <picture>/<source>/<img>, whose URLs are all same-origin ROOT-RELATIVE
 *     paths (/hero-poster.avif|webp|jpg). No writer emits a data: URL, so
 *     data: is refused for src/srcset here even though img-src in
 *     public/_headers still allows it for ordinary, non-sink markup.
 *
 *     `sanitizeHtml` below is that allowlist, and it is a SANITIZER, not a
 *     matcher: it parses the string in an inert document, walks it, and
 *     rebuilds the output from the nodes that survive. The regex
 *     version this replaced (a tag-name test plus `/<[a-zA-Z][^>]*\son[a-z]+=/`)
 *     was executed against a payload corpus on 2026-09-21 and let three
 *     bypasses through: `<img/onerror=alert(1) src=x>` and
 *     `<img/src=x/onerror=alert(1)>` (a `/` separates attributes; the regex
 *     only looked for whitespace) and `<img src="a>b" onerror=alert(1)>`
 *     (`[^>]*` cannot cross a `>` inside a quoted value). Parsing removes that
 *     whole class of error: the browser's own tokenizer decides what an
 *     attribute is, and `on*` is simply not on the keep list.
 *
 *     IT PARSES IN FRAGMENT CONTEXT, NOT DOCUMENT CONTEXT (changed 2026-09-21,
 *     second refutation pass). `{@html}` assigns to a <template>'s innerHTML,
 *     which runs the fragment-parsing algorithm; `DOMParser.parseFromString`
 *     runs the document algorithm, and the two disagree about leading
 *     whitespace — "before html"/"before head" drop it, "in body" keeps it, so
 *     `'   indented'` came back `'indented'` and a tab-only string came back
 *     `''`. Measured: that rewrote ~8% of the real `renderInline` outputs, i.e.
 *     the sanitizer was silently reindenting the Synapse terminal. So `parse`
 *     now builds a <template> inside an inert DOMParser document and assigns
 *     the input to ITS innerHTML: the same algorithm, in the same context, as
 *     the sink it is guarding. The fixpoint re-parse uses that same path.
 *
 *     KEPT ELEMENTS ARE REBUILT, NOT PRUNED (changed 2026-09-21, same pass).
 *     Pruning attributes off the parsed node is not enough for the `is`
 *     attribute: `removeAttribute('is')` clears the content attribute, but the
 *     element's `is` VALUE is set at creation and is not an attribute, and the
 *     serializer re-emits it — `<p is="evil-el">x</p>` and
 *     `<img is="x-img" src="/a.png">` round-tripped through the old sanitizer
 *     unchanged, handing the sink a customized built-in. So every kept element
 *     is recreated with `createElement(tag)` (no `is` option, therefore no `is`
 *     value), only allowlisted attributes are copied onto the fresh node, and
 *     the sanitized children are moved across. Nothing the parser attached to
 *     the original node can ride along.
 *
 *     Anything outside the vocabulary is dropped, not refused: unknown
 *     elements are UNWRAPPED (their sanitized children and text survive —
 *     `<div>`, `<a>`, `<h1>`, `<table>`…), while the elements that execute or
 *     whose content model differs between a parse and a re-parse are REMOVED
 *     WITH THEIR SUBTREE: script, style, iframe, object, embed, svg, math,
 *     template, link, meta, base, noscript, noembed, noframes, title,
 *     textarea, xmp, plaintext, frame, frameset, applet. That second list is
 *     what closes mutation-XSS: `<noscript><p title="</noscript><img src=x
 *     onerror=alert(1)>">` and `<math><mtext><table><mglyph><style><img src=x
 *     onerror=alert(1)>` are dangerous precisely because a DOMParser document
 *     has scripting disabled and MathML/SVG are foreign content, so the tree
 *     the sanitizer sees is not the tree the sink would build. Those subtrees
 *     are never handed back, and on top of that `sanitizeHtml` iterates to a
 *     FIXPOINT: the output is re-parsed and re-sanitized until two passes
 *     agree, and a string that never settles (one that means something
 *     different the second time a parser sees it) returns "" instead.
 *
 *   createScriptURL — Worker(url) and script.src. Legitimate callers: Vite's
 *     `?worker` bundles and the tiktoken counter (same-origin /_astro/*.js),
 *     onnxruntime-web's thread-pool workers (same-origin blob: URLs — a blob:
 *     URL's origin IS the origin that minted it, so the same-origin test covers
 *     them without a special case), and the GIS loader in src/lib/auth.ts
 *     (https://accounts.google.com/gsi/client). Anything else is refused. This
 *     mirrors script-src in public/_headers on purpose: the two lists must move
 *     together, and csp-headers.test.ts fails if they drift. Turnstile's explicit
 *     loader is allowed by its exact URL; other challenge-host URLs are refused.
 *
 *   createScript — eval / new Function / script.text. Nothing on the site uses
 *     them (script-src has no 'unsafe-eval', so they have been blocked by CSP
 *     since the header first shipped and every page still works). Refused
 *     unconditionally. UNCHANGED.
 *
 * WHY A SECOND POLICY (`tt-parse`). `DOMParser.parseFromString` is itself a
 * Trusted Types sink, and so is the `template.innerHTML` assignment the
 * fragment parse needs, so a default policy that parses would re-enter itself.
 * The sanitizer therefore feeds BOTH writes through a tiny pass-through policy
 * whose object never leaves this closure. That grants an attacker nothing:
 * with no `trusted-types <names>` directive in the CSP (and there must not be
 * one — Svelte registers `svelte-trusted-html`, GIS registers Closure
 * policies), anyone already running script could mint the same pass-through
 * for themselves. If creating it ever fails, `createHTML` returns "" rather
 * than risking infinite recursion: fail closed, never fail open.
 *
 * WHY AN INLINE SCRIPT, NOT A HOISTED MODULE. The policy must exist before the
 * first sink write, and a `type="module"` script is deferred: it runs after
 * parsing finishes, while `client:only` islands (Embedding Explorer) start
 * importing the moment their <astro-island> connects, mid-parse, and a
 * `client:visible` IntersectionObserver can fire during a long parse too. A
 * classic inline script in <head> runs synchronously at its position, before
 * any of that, with no request on the critical path. Its bytes are static, so
 * it is allowed by a sha256 hash in script-src rather than by 'unsafe-inline'.
 *
 * WHY THE SANITIZER IS A REAL FUNCTION AS WELL AS A STRING. `sanitizeHtml`
 * below is ordinary TypeScript: it type-checks, it is readable, and the tests
 * call it directly against a DOM. `SANITIZER_SOURCE` is the same code as the
 * literal that actually ships (see the note on that constant for why a
 * `toString()`-derived constant cannot be used: two transpilers in this repo
 * print it differently, so the hash would be right in vitest and wrong in
 * dist). The tests hold the two together — string equality plus the full
 * bypass corpus run through both. The body is deliberately plain ES5 (`var`,
 * `function`, no arrows, no template literals, no optional chaining) and free
 * of `\u` escapes, so the two printings stay as close as they can, and it
 * carries no comments and no imports — the module-load guard below throws if
 * that changes.
 *
 * THE BYTES MATTER. BaseLayout.astro injects `TRUSTED_TYPES_POLICY_SCRIPT` via
 * `set:html`, verbatim, and tests/unit/csp-headers.test.ts hashes the same
 * constant and asserts the hash is in public/_headers. Change the script and the
 * test tells you the new hash; change the hash without the script and it tells
 * you too. Keep it free of `</script` (it would close the tag early) and of
 * newlines and comments (this doc block does not ship; anything inside the
 * shipped string does, 34 times — once per page).
 *
 * Browsers without `window.trustedTypes` (Firefox < 138, older Safari) skip the
 * whole block; they also ignore the CSP directive, so nothing changes for them.
 */

/**
 * The allowlist sanitizer that runs inside the inline policy script.
 *
 * `parse` is injected rather than reached for as a global so the identical
 * source can run in the browser (DOMParser + `template.innerHTML` behind the
 * `tt-parse` policy) and in vitest (jsdom). It must return a <template> element
 * that LIVES IN A PARSED DOCUMENT — the walk happens over `tpl.content`, so the
 * input is parsed in fragment context exactly like `{@html}` parses it, while
 * `tpl.baseURI` still reports the real page URL (a template's *content* belongs
 * to the template-contents owner document, whose baseURI is `about:blank`;
 * measured in jsdom 30.1.0 and matching the spec's "appropriate template
 * contents owner document"). The returned string is what the sink receives.
 *
 * `safeUrl` strips every character at or below U+0020 first, because the URL
 * parser does the same with tabs and newlines — that is what makes
 * `src="java&#10;script:alert(1)"` a javascript: URL. Dropping interior spaces
 * too is stricter than the URL parser, never looser. It then RESOLVES the value
 * against the page's base instead of pattern-matching the scheme, and accepts
 * only a same-origin URL or an https URL with a host. The string check it
 * replaced tested for a literal leading `//`, which a backslash spells around:
 * `/\evil.example/p.png`, `\/evil.example/p.png` and `\\evil.example/p.png` all
 * carry an authority for a special scheme (the URL parser treats `\` as `/`),
 * and the old check passed them through as if they were same-origin paths.
 * Resolving makes the decision the same one the browser will act on: whatever
 * scheme and origin the fetch would really use. Note the consequence — a
 * protocol-relative URL on an https page resolves to https and is now accepted,
 * exactly like the explicit `https://…` image URLs that were always allowed;
 * on an http origin (the local `wrangler pages dev` preview) the same four
 * spellings resolve to http and are dropped.
 *
 * Everything from here down ships. Keep it ES5, escape-free, comment-free and
 * import-free.
 */
export function sanitizeHtml(
  parse: (html: string) => HTMLTemplateElement | null,
  html: string
): string {
  var KEEP = ' span br strong em b i code mark p picture source img ';
  var DROP =
    ' script style iframe object embed svg math template link meta base noscript noembed noframes title textarea xmp plaintext frame frameset applet ';
  var base = '';
  var origin = '';
  function attrsFor(tag: string): string {
    if (tag === 'img') return ' class alt width height loading decoding src srcset ';
    if (tag === 'source') return ' class srcset type media ';
    return ' class ';
  }
  function safeUrl(value: string): boolean {
    var raw = String(value);
    var v = '';
    for (var i = 0; i < raw.length; i++) {
      if (raw.charCodeAt(i) > 32) v += raw.charAt(i);
    }
    try {
      var u = new URL(v, base);
      if (u.origin === origin) return true;
      return u.protocol === 'https:' && u.host !== '';
    } catch (e) {
      return false;
    }
  }
  function safeSrcset(value: string): boolean {
    var parts = String(value).split(',');
    for (var i = 0; i < parts.length; i++) {
      var candidate = String(parts[i]).replace(/^\s+/, '').split(/\s+/)[0];
      if (candidate && !safeUrl(candidate)) return false;
    }
    return true;
  }
  function clean(parent: Node): void {
    var kids = parent.childNodes;
    for (var i = kids.length - 1; i >= 0; i--) {
      var node = kids[i];
      if (!node) continue;
      if (node.nodeType === 3) continue;
      if (node.nodeType !== 1) {
        parent.removeChild(node);
        continue;
      }
      var el = node as Element;
      var tag = String(el.tagName).toLowerCase();
      if (DROP.indexOf(' ' + tag + ' ') >= 0) {
        parent.removeChild(el);
        continue;
      }
      clean(el);
      var doc = parent.ownerDocument;
      if (KEEP.indexOf(' ' + tag + ' ') < 0 || !doc) {
        while (el.firstChild) parent.insertBefore(el.firstChild, el);
        parent.removeChild(el);
        continue;
      }
      var fresh = doc.createElement(tag);
      var allowed = attrsFor(tag);
      var attrs = el.attributes;
      for (var j = 0; j < attrs.length; j++) {
        var at = attrs[j];
        if (!at) continue;
        var name = String(at.name).toLowerCase();
        if (allowed.indexOf(' ' + name + ' ') < 0) continue;
        if (name === 'src' && !safeUrl(at.value)) continue;
        if (name === 'srcset' && !safeSrcset(at.value)) continue;
        fresh.setAttribute(name, at.value);
      }
      while (el.firstChild) fresh.appendChild(el.firstChild);
      parent.replaceChild(fresh, el);
    }
  }
  var prev = String(html);
  for (var pass = 0; pass < 4; pass++) {
    var tpl = parse(prev);
    if (!tpl) return '';
    base = String(tpl.baseURI);
    try {
      origin = new URL(base).origin;
    } catch (e) {
      return '';
    }
    if (origin === 'null') return '';
    clean(tpl.content);
    var out = tpl.innerHTML;
    if (out === prev) return out;
    prev = out;
  }
  return '';
}

/**
 * `sanitizeHtml`'s source, flattened to one line — THE BYTES THAT SHIP.
 *
 * It is a literal and not `sanitizeHtml.toString()` for one measured reason:
 * the two are not the same string. `toString()` returns whatever the
 * transpiler that loaded THIS module printed, and the two transpilers this
 * repo runs print differently — vitest's esbuild transform keeps
 * `for (…) { if (…) x; }`, Astro's production build (esbuild with syntax
 * minification) prints `for (…) if (…) x;`. A derived constant therefore
 * hashes to one value in `vitest run` and a different one in `dist`, and
 * public/_headers can only carry one of them: the header would be correct in
 * the test and wrong on the deployed site, which is the exact failure this
 * whole hashing scheme exists to prevent (measured 2026-09-21 on the previous
 * revision of this function: 2902 B under vitest vs 2892 B in dist, different
 * sha256). A string literal is data — no transpiler rewrites its contents — so
 * the bytes below are what every toolchain ships, and that is re-confirmed
 * end-to-end: the inline script in a fresh `astro build` measures 3376 B with
 * sha256 Q27LY9eIKgxX9LhG+ONLtn7lmsZ0gwopA0midEGvJxo=, the same value
 * csp-headers.test.ts derives under vitest and the same token in
 * public/_headers.
 *
 * The cost is that this literal and the function above must be edited
 * together, and that is enforced, not trusted:
 * tests/unit/trusted-types-policy.test.ts asserts this string EQUALS
 * `sanitizeHtml.toString()` flattened the same way (and prints the
 * replacement when it does not), and separately runs the whole bypass corpus
 * through BOTH the exported function and this shipped string, asserting they
 * agree payload by payload. Edit the function, run vitest, paste the string it
 * gives you.
 */
export const SANITIZER_SOURCE: string =
  'function sanitizeHtml(parse, html) { var KEEP = " span br strong em b i code mark p picture source img "; var DROP = " script style iframe object embed svg math template link meta base noscript noembed noframes title textarea xmp plaintext frame frameset applet "; var base = ""; var origin = ""; function attrsFor(tag) { if (tag === "img") return " class alt width height loading decoding src srcset "; if (tag === "source") return " class srcset type media "; return " class "; } function safeUrl(value) { var raw = String(value); var v = ""; for (var i = 0; i < raw.length; i++) { if (raw.charCodeAt(i) > 32) v += raw.charAt(i); }; try { var u = new URL(v, base); if (u.origin === origin) return true; return u.protocol === "https:" && u.host !== ""; } catch (e) { return false; } } function safeSrcset(value) { var parts = String(value).split(","); for (var i = 0; i < parts.length; i++) { var candidate = String(parts[i]).replace(/^\\s+/, "").split(/\\s+/)[0]; if (candidate && !safeUrl(candidate)) return false; }; return true; } function clean(parent) { var kids = parent.childNodes; for (var i = kids.length - 1; i >= 0; i--) { var node = kids[i]; if (!node) continue; if (node.nodeType === 3) continue; if (node.nodeType !== 1) { parent.removeChild(node); continue; }; var el = node; var tag = String(el.tagName).toLowerCase(); if (DROP.indexOf(" " + tag + " ") >= 0) { parent.removeChild(el); continue; }; clean(el); var doc = parent.ownerDocument; if (KEEP.indexOf(" " + tag + " ") < 0 || !doc) { while (el.firstChild) parent.insertBefore(el.firstChild, el); parent.removeChild(el); continue; }; var fresh = doc.createElement(tag); var allowed = attrsFor(tag); var attrs = el.attributes; for (var j = 0; j < attrs.length; j++) { var at = attrs[j]; if (!at) continue; var name = String(at.name).toLowerCase(); if (allowed.indexOf(" " + name + " ") < 0) continue; if (name === "src" && !safeUrl(at.value)) continue; if (name === "srcset" && !safeSrcset(at.value)) continue; fresh.setAttribute(name, at.value); }; while (el.firstChild) fresh.appendChild(el.firstChild); parent.replaceChild(fresh, el); } } var prev = String(html); for (var pass = 0; pass < 4; pass++) { var tpl = parse(prev); if (!tpl) return ""; base = String(tpl.baseURI); try { origin = new URL(base).origin; } catch (e) { return ""; }; if (origin === "null") return ""; clean(tpl.content); var out = tpl.innerHTML; if (out === prev) return out; prev = out; }; return ""; }';

/* The function ships as text: an `import`/`require` inside it would reference a
   module that does not exist at runtime, and a comment would either leak into
   34 pages or (`//`) kill the rest of the one-line script. Fail the build,
   loudly, rather than ship either. */
if (/\bimport\b|\brequire\b|\/\*|\/\//.test(SANITIZER_SOURCE)) {
  throw new Error(
    'sanitizeHtml must stay import-free and comment-free: it is stringified into the inline Trusted Types policy script.'
  );
}

export const TRUSTED_TYPES_POLICY_SCRIPT: string =
  '(function(){' +
  'var tt=window.trustedTypes;if(!tt||typeof tt.createPolicy!=="function")return;' +
  'var pass=null;try{pass=tt.createPolicy("tt-parse",{createHTML:function(s){return s;}});}catch(e){}' +
  'function parse(h){if(!pass)return null;' +
  'var d=new DOMParser().parseFromString(pass.createHTML("<template></template>"),"text/html");' +
  'var t=d.getElementsByTagName("template")[0];if(!t)return null;' +
  't.innerHTML=pass.createHTML(h);return t;}' +
  SANITIZER_SOURCE +
  'function html(s){if(!pass)return "";try{return sanitizeHtml(parse,String(s));}catch(e){return "";}}' +
  'var HOSTS=["https://cdn.jsdelivr.net/","https://accounts.google.com/"];' +
  'function url(u){u=String(u);var a;try{a=new URL(u,document.baseURI);}catch(e){return null;}' +
  'if(a.origin===location.origin)return u;' +
  'if(u==="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit")return u;' +
  'for(var i=0;i<HOSTS.length;i++){if(u.indexOf(HOSTS[i])===0)return u;}return null;}' +
  'try{tt.createPolicy("default",{createHTML:html,createScriptURL:url,createScript:function(){return null;}});}catch(e){}' +
  '})();';
