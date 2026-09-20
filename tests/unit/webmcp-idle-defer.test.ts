/**
 * The WebMCP registration script's load-time scheduling.
 *
 * PageSpeed + a local Lighthouse run (2026-09-20) showed the dynamic import
 * of `@/lib/webmcp/register` firing at High priority DURING page load on
 * WebMCP-capable Chrome, competing with the LCP request. This suite reads the
 * inline <script> straight out of BaseLayout.astro (there is no component-
 * rendering harness in this project — see webmcp-contact-form.test.ts for the
 * same house pattern) and guards the fix.
 *
 * Why this file is a scanner and not a pile of `toMatch` calls: the previous
 * version of this suite was five substring searches over the whole <script>
 * block, and an audit (2026-09-21) showed it staying green on three separate
 * mutations that each reintroduce or destroy the thing it claims to guard —
 * a bare `registerTools();` added at the gate's top level (the measured
 * defect, restored verbatim), the dynamic import deleted outright, and the
 * Safari fallback removed. A substring search cannot tell a scheduled call
 * from an unscheduled one, because both spell the same characters. So the
 * checks below locate the gate, walk it with a brace/paren-aware scanner that
 * skips string literals, and assert on WHERE each call sits, not on whether a
 * token appears somewhere.
 *
 * Mutation-proved on 2026-09-21 against a copy of BaseLayout.astro in a
 * scratch tree (the repo file was never modified; each copy was restored
 * byte-identically, sha256-checked, after every run). Unmutated: 7/7 green.
 * Mutated, one test red each and the named test is the one that fails:
 *   bare `registerTools();` at the gate's top level → "calls the registering
 *     function only from inside requestIdleCallback or setTimeout";
 *   the same bare call next to a comment that spells
 *     `requestIdleCallback(registerTools);` → same test (comments are blanked
 *     before matching, so the comment cannot pay for the code);
 *   `import('@/lib/webmcp/register')` deleted → 4 red, starting with "still
 *     imports @/lib/webmcp/register";
 *   the Safari `setTimeout` fallback deleted, and deleted-but-described-in-a-
 *     comment → "keeps a setTimeout fallback ... at least 500ms";
 *   that fallback's delay lowered to 100 → same test;
 *   the readyState/`load` gate replaced by a bare `scheduleIdle();` → "never
 *     schedules before the load event has fired";
 *   the feature check swapped to `navigator.modelContext` → "keeps the feature
 *     check a property check, not a navigator getter".
 * A control mutation (an unrelated `registerToolsNow()` called bare) stays
 * green: the identifier scan anchors, so a longer name is not a match.
 *
 * Comments are stripped before matching, same reasoning as
 * webmcp-contact-form.test.ts: a sentence describing the fix must not be able
 * to satisfy an assertion about the fix.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const RAW = readFileSync(resolve(process.cwd(), 'src/layouts/BaseLayout.astro'), 'utf-8');

/** Blank out a comment in place: same length, newlines kept, so every index
 *  below still lines up with the file the reader is looking at. */
function blank(match: string): string {
  return match.replace(/[^\n]/g, ' ');
}

function stripComments(source: string): string {
  return source
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, lead: string) => lead + blank(m.slice(lead.length)));
}

const CODE = stripComments(RAW);

/** Positions covered by a string/template literal (quotes included). Used so
 *  identifier searches never match inside `'requestIdleCallback' in window`
 *  or inside the import specifier. */
function maskStrings(src: string): boolean[] {
  const mask: boolean[] = new Array<boolean>(src.length).fill(false);
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "'" || c === '"' || c === '`') {
      mask[i] = true;
      i += 1;
      while (i < src.length) {
        if (src[i] === '\\') {
          mask[i] = true;
          if (i + 1 < src.length) mask[i + 1] = true;
          i += 2;
          continue;
        }
        mask[i] = true;
        const done = src[i] === c;
        i += 1;
        if (done) break;
      }
      continue;
    }
    i += 1;
  }
  return mask;
}

/** Index of the bracket closing the one at `openIdx`, or -1. */
function matchBracket(src: string, openIdx: number, mask: boolean[]): number {
  const open = src[openIdx];
  if (open !== '(' && open !== '{' && open !== '[') return -1;
  const close = open === '(' ? ')' : open === '{' ? '}' : ']';
  let depth = 0;
  for (let i = openIdx; i < src.length; i += 1) {
    if (mask[i]) continue;
    const c = src[i];
    if (c === open) depth += 1;
    else if (c === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** The <script> block that mentions WebMCP's feature surface. Deliberately
 *  keyed on `modelContext` alone rather than on the correct `'modelContext' in
 *  document` spelling, so that swapping the check to `navigator.modelContext`
 *  fails the assertion about the spelling instead of silently losing the
 *  block and turning every other assertion into a search over ''. */
function extractScript(code: string, marker: string): string {
  const markerIdx = code.indexOf(marker);
  if (markerIdx === -1) return '';
  const opens = [...code.slice(0, markerIdx).matchAll(/<script[^>]*>/g)];
  const last = opens[opens.length - 1];
  if (!last || last.index === undefined) return '';
  const start = last.index + last[0].length;
  const end = code.indexOf('</script>', start);
  return end === -1 ? '' : code.slice(start, end);
}

const SCRIPT = extractScript(CODE, 'modelContext');
const MASK = maskStrings(SCRIPT);

interface Gate {
  condition: string;
  bodyOpen: number;
  bodyClose: number;
  body: string;
}

/** The `if (...) { ... }` whose condition mentions modelContext. */
function findGate(): Gate | null {
  const markerIdx = SCRIPT.indexOf('modelContext');
  if (markerIdx === -1) return null;
  const ifs = [...SCRIPT.slice(0, markerIdx).matchAll(/\bif\s*\(/g)];
  const last = ifs[ifs.length - 1];
  if (!last || last.index === undefined) return null;
  const parenOpen = last.index + last[0].length - 1;
  const parenClose = matchBracket(SCRIPT, parenOpen, MASK);
  if (parenClose === -1) return null;
  const bodyOpen = SCRIPT.indexOf('{', parenClose);
  if (bodyOpen === -1) return null;
  const bodyClose = matchBracket(SCRIPT, bodyOpen, MASK);
  if (bodyClose === -1) return null;
  return {
    condition: SCRIPT.slice(parenOpen, parenClose + 1),
    bodyOpen,
    bodyClose,
    body: SCRIPT.slice(bodyOpen + 1, bodyClose),
  };
}

const GATE = findGate();

interface FnDecl {
  name: string;
  bodyOpen: number;
  bodyClose: number;
}

/** Named function declarations (`const f = (…) => {`, `const f = x => {`,
 *  `function f(…) {`) with their body spans. */
function findFunctions(): FnDecl[] {
  const patterns = [
    /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?\([^()]*\)\s*=>\s*\{/g,
    /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?[A-Za-z_$][\w$]*\s*=>\s*\{/g,
    /\bfunction\s+([A-Za-z_$][\w$]*)\s*\([^()]*\)\s*\{/g,
  ];
  const decls: FnDecl[] = [];
  for (const re of patterns) {
    for (const m of SCRIPT.matchAll(re)) {
      const name = m[1];
      if (m.index === undefined || name === undefined || MASK[m.index]) continue;
      const bodyOpen = m.index + m[0].length - 1;
      const bodyClose = matchBracket(SCRIPT, bodyOpen, MASK);
      if (bodyClose === -1) continue;
      decls.push({ name, bodyOpen, bodyClose });
    }
  }
  return decls;
}

const FUNCTIONS = findFunctions();

/** Innermost declared function whose body contains `idx`. */
function enclosingFunction(idx: number): FnDecl | null {
  let best: FnDecl | null = null;
  for (const fn of FUNCTIONS) {
    if (idx > fn.bodyOpen && idx < fn.bodyClose) {
      if (best === null || fn.bodyOpen > best.bodyOpen) best = fn;
    }
  }
  return best;
}

/** Every unmasked occurrence of `name` as a standalone identifier, excluding
 *  the position where it is declared. */
function identifierUses(name: string, declared: FnDecl[]): number[] {
  const re = new RegExp(`(?<![\\w$.])${name}(?![\\w$])`, 'g');
  const declIdx = new Set<number>();
  for (const fn of declared) {
    if (fn.name !== name) continue;
    const head = SCRIPT.lastIndexOf(name, fn.bodyOpen);
    if (head !== -1) declIdx.add(head);
  }
  const out: number[] = [];
  for (const m of SCRIPT.matchAll(re)) {
    if (m.index === undefined || MASK[m.index] || declIdx.has(m.index)) continue;
    out.push(m.index);
  }
  return out;
}

interface CallSpan {
  callee: string;
  nameIdx: number;
  argsOpen: number;
  argsClose: number;
  args: string;
}

/** Call expressions for a set of callee names, with their argument spans. */
function callSpans(names: string[]): CallSpan[] {
  const re = new RegExp(`(?<![\\w$.])(?:window\\s*\\.\\s*)?(${names.join('|')})\\s*\\(`, 'g');
  const out: CallSpan[] = [];
  for (const m of SCRIPT.matchAll(re)) {
    const callee = m[1];
    if (m.index === undefined || callee === undefined || MASK[m.index]) continue;
    const argsOpen = m.index + m[0].length - 1;
    const argsClose = matchBracket(SCRIPT, argsOpen, MASK);
    if (argsClose === -1) continue;
    out.push({
      callee,
      nameIdx: m.index,
      argsOpen,
      argsClose,
      args: SCRIPT.slice(argsOpen + 1, argsClose),
    });
  }
  return out;
}

/** Split an argument list on commas that sit at depth 0. */
function topLevelArgs(span: CallSpan): string[] {
  const args: string[] = [];
  let depth = 0;
  let start = span.argsOpen + 1;
  for (let i = span.argsOpen + 1; i < span.argsClose; i += 1) {
    if (MASK[i]) continue;
    const c = SCRIPT[i];
    if (c === '(' || c === '{' || c === '[') depth += 1;
    else if (c === ')' || c === '}' || c === ']') depth -= 1;
    else if (c === ',' && depth === 0) {
      args.push(SCRIPT.slice(start, i).trim());
      start = i + 1;
    }
  }
  args.push(SCRIPT.slice(start, span.argsClose).trim());
  return args.filter((a) => a.length > 0);
}

function lineOf(idx: number): number {
  return CODE.slice(0, CODE.indexOf(SCRIPT) + idx).split('\n').length;
}

function snippet(idx: number): string {
  const from = SCRIPT.lastIndexOf('\n', idx) + 1;
  const to = SCRIPT.indexOf('\n', idx);
  return `line ${lineOf(idx)}: ${SCRIPT.slice(from, to === -1 ? SCRIPT.length : to).trim()}`;
}

const SCHEDULERS = ['requestIdleCallback', 'setTimeout'];
const IMPORT_RE = /\bimport\(\s*['"]@\/lib\/webmcp\/register['"]\s*\)/;

describe('BaseLayout — WebMCP registration is deferred to idle', () => {
  it('finds the gated script block to assert against', () => {
    // Guard on the guard: if the block cannot be located, every assertion
    // below would run against an empty string.
    expect(SCRIPT, 'no <script> block mentioning modelContext in BaseLayout.astro').not.toBe('');
    expect(GATE, 'no `if (...modelContext...)` gate found in that block').not.toBeNull();
    expect(GATE?.body.trim().length ?? 0).toBeGreaterThan(0);
  });

  it('keeps the feature check a property check, not a navigator getter', () => {
    // `navigator.modelContext` is the deprecated spelling: touching it logs a
    // deprecation warning, which Lighthouse charges Best Practices points for.
    expect(GATE?.condition ?? '').toMatch(/['"]modelContext['"]\s+in\s+document/);
    expect(CODE, 'the deprecated navigator.modelContext spelling is back').not.toMatch(
      /navigator\s*\.\s*modelContext/
    );
  });

  it('still imports @/lib/webmcp/register — the feature is not silently gone', () => {
    // Positive assertion. Without it the whole suite stays green on a site
    // where WebMCP registration has been deleted and no tool is ever handed
    // to an agent (audit finding, 2026-09-21).
    expect(GATE?.body ?? '', 'the dynamic import of the WebMCP tools is missing').toMatch(
      IMPORT_RE
    );
  });

  it('keeps the dynamic import inside a function, never at the gate top level', () => {
    const body = GATE?.body ?? '';
    const rel = body.search(IMPORT_RE);
    expect(rel, 'no import to locate').toBeGreaterThan(-1);
    const abs = (GATE?.bodyOpen ?? 0) + 1 + rel;
    const fn = enclosingFunction(abs);
    expect(
      fn,
      'the import is not inside any named function — it runs as the gate executes'
    ).not.toBeNull();
  });

  it('calls the registering function only from inside requestIdleCallback or setTimeout', () => {
    // The measured defect, and the one the old suite could not see: a bare
    // `registerTools();` sitting at the gate's top level fetches the 18.7 KiB
    // register chunk at High priority during load. Checking for the string
    // `requestIdleCallback` somewhere in the block proves nothing about that
    // call — so every call site is located and its position checked instead.
    const body = GATE?.body ?? '';
    const abs = (GATE?.bodyOpen ?? 0) + 1 + body.search(IMPORT_RE);
    const registerFn = enclosingFunction(abs);
    expect(registerFn, 'no function wraps the import').not.toBeNull();
    const name = registerFn?.name ?? '';

    const allowed = callSpans(SCHEDULERS);
    expect(allowed.length, 'no requestIdleCallback/setTimeout call in the block').toBeGreaterThan(
      0
    );

    const offenders = identifierUses(name, FUNCTIONS)
      .filter((idx) => !allowed.some((s) => idx > s.argsOpen && idx < s.argsClose))
      .map(snippet);

    expect(
      offenders,
      `${name} is reached outside requestIdleCallback/setTimeout — that call runs during load`
    ).toEqual([]);
  });

  it('never schedules before the load event has fired', () => {
    // On a fresh navigation `document.readyState` is not yet 'complete', so
    // the scheduling call must be reached through the 'load' event. Checked
    // structurally: whatever wraps the requestIdleCallback/setTimeout calls is
    // itself only reachable from a readyState==='complete' branch or from a
    // 'load' listener.
    const spans = callSpans(SCHEDULERS).filter(
      (s) => GATE !== null && s.nameIdx > GATE.bodyOpen && s.nameIdx < GATE.bodyClose
    );
    expect(spans.length, 'no scheduling call inside the gate').toBeGreaterThan(0);

    // Spans that are reachable only after load: the body of an
    // `if (document.readyState === 'complete')`, and the argument list of an
    // `addEventListener('load', ...)`.
    const gatedSpans: Array<[number, number]> = [];
    for (const m of SCRIPT.matchAll(/\bif\s*\(/g)) {
      if (m.index === undefined || MASK[m.index]) continue;
      const parenOpen = m.index + m[0].length - 1;
      const parenClose = matchBracket(SCRIPT, parenOpen, MASK);
      if (parenClose === -1) continue;
      const cond = SCRIPT.slice(parenOpen, parenClose + 1);
      if (!/readyState\s*===?\s*['"]complete['"]/.test(cond)) continue;
      const braceOpen = SCRIPT.indexOf('{', parenClose);
      const braceClose = braceOpen === -1 ? -1 : matchBracket(SCRIPT, braceOpen, MASK);
      if (braceOpen !== -1 && braceClose !== -1) gatedSpans.push([braceOpen, braceClose]);
      else {
        const semi = SCRIPT.indexOf(';', parenClose);
        gatedSpans.push([parenClose, semi === -1 ? SCRIPT.length : semi]);
      }
    }
    for (const span of callSpans(['addEventListener'])) {
      const args = topLevelArgs(span);
      if ((args[0] ?? '').replace(/['"]/g, '') !== 'load') continue;
      gatedSpans.push([span.argsOpen, span.argsClose]);
    }
    expect(
      gatedSpans.length,
      "no readyState==='complete' branch and no 'load' listener — scheduling runs during load"
    ).toBeGreaterThan(0);

    // Each scheduling call sits inside a function; that function's own call
    // sites are what must be load-gated.
    const offenders: string[] = [];
    for (const span of spans) {
      const owner = enclosingFunction(span.nameIdx);
      if (owner === null) {
        // Scheduling written inline at the gate's top level: the call itself
        // must be load-gated.
        if (!gatedSpans.some(([a, b]) => span.nameIdx > a && span.nameIdx < b)) {
          offenders.push(snippet(span.nameIdx));
        }
        continue;
      }
      for (const use of identifierUses(owner.name, FUNCTIONS)) {
        if (use > owner.bodyOpen && use < owner.bodyClose) continue;
        if (!gatedSpans.some(([a, b]) => use > a && use < b)) offenders.push(snippet(use));
      }
    }
    expect([...new Set(offenders)], 'scheduling is reached without waiting for load').toEqual([]);
  });

  it('keeps a setTimeout fallback for Safari with a delay of at least 500ms', () => {
    // Safari has never shipped requestIdleCallback (Baseline: Limited), so the
    // fallback is the only deferral those visitors get. A delay short enough to
    // land inside the load window would defeat it.
    const body = GATE?.body ?? '';
    const abs = (GATE?.bodyOpen ?? 0) + 1 + body.search(IMPORT_RE);
    const name = enclosingFunction(abs)?.name ?? '';
    const fallbacks = callSpans(['setTimeout']).filter(
      (s) => name !== '' && new RegExp(`(?<![\\w$.])${name}(?![\\w$])`).test(s.args)
    );
    expect(
      fallbacks.length,
      'no setTimeout fallback schedules the WebMCP registration'
    ).toBeGreaterThan(0);

    const delays = fallbacks.map((s) => Number(topLevelArgs(s)[1] ?? NaN));
    for (const delay of delays) {
      expect(delay, 'setTimeout fallback delay is missing or not a literal number').not.toBeNaN();
      expect(
        delay,
        'setTimeout fallback fires too early to clear the load window'
      ).toBeGreaterThanOrEqual(500);
    }
  });
});
