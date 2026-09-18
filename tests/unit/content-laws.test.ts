/**
 * Content-law guards for every surface that actually ships copy — not just
 * src/data/services.ts, which is all services-data.test.ts scans. GEO/AI
 * answer engines and human visitors alike read src/i18n/*.json, llms.txt,
 * synapse-mock.ts's canned replies, every [lang] page's own inline copy, AND
 * every Astro/Svelte component under src/components and src/layouts — a
 * banned word or a broken response promise living in any of those is
 * exactly as live as one in services.ts.
 *
 * SCAN_TARGETS (2026-08-22 rewrite): a hand-written 8-file list plus a page
 * glob used to be the scan surface. An adversarial review found that list
 * covered nowhere near the site's real copy footprint — ~50 files under
 * src/components and src/layouts carry Russian user-facing copy, including
 * ContactFunnel.svelte, the island actually mounted on /contact/, which no
 * test read at all. SCAN_TARGETS is now a recursive walk over every root
 * that can carry shipped copy (src/pages, src/components, src/layouts,
 * src/data, src/i18n, src/lib) plus llms.txt — a new file under any of
 * those roots is guarded by construction, not by whoever adds it also
 * remembering to update a list here.
 *
 * Every assertion below works on RAW SOURCE TEXT, not imported/parsed data
 * (services-data.test.ts already covers SERVICES structurally) — a comma
 * slipped into an .astro template or a stray "24/7" in llms.txt would never
 * touch the SERVICES array and so would sail past that file unnoticed.
 *
 * Five laws:
 * 1. No "Stripe" — Armenian sole proprietorships cannot open Stripe merchant
 *    accounts (see services.ts's header comment for the fuller history).
 * 2. No registry-number-shaped digit run — standing owner rule after a past
 *    registry-number mixup once published a personal identifier.
 * 3. No 24/7 promise, except naming it inside a services.ts `notIncluded`
 *    entry (the one place the site is allowed to say what it does NOT do).
 * 4. RU/EN response-promise parity: «в течение рабочего дня» reads to a
 *    Russian speaker as "by end of today" — a stronger commitment than the
 *    English "within one business day" it is supposed to translate. Only
 *    «в течение одного рабочего дня» ("within ONE business day") makes the
 *    same promise EN makes; the shorter phrase is a mistranslation, not a
 *    stylistic variant. Same law for the synonym «в рабочий день».
 * 5. RU price typography — space-family characters other than U+00A0 (and
 *    the comma) must never sit between digit groups; services-data.test.ts
 *    enforces this over SERVICES, this file re-enforces it site-wide.
 *
 * Cross-cutting normalisation, applied to every scanned file before any law
 * runs (2026-08-22 hardening — see the two functions' own doc comments):
 *  - stripComments: block/line comments blanked so a comment that legitimately
 *    NAMES a banned word to document the ban doesn't fail this file.
 *  - joinStringConcatenation: adjacent same-quote string literals joined by
 *    `+` are merged into one string, so a banned phrase split across a
 *    `'...' +\n  '...'` seam (which src/lib/synapse-mock.ts's same-day-promise
 *    string genuinely did, until it was fixed in the same window as this
 *    audit) can't hide in the gap from a literal/line-based scanner.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SERVICES } from '@/data/services';
import { CLOCK } from './helpers/content-law-patterns';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/**
 * Every copy-bearing root, walked recursively. `.d.ts` (type-only, no
 * runtime strings) and `.test.ts`/`.spec.ts` (test code, not shipped copy)
 * are excluded; everything else with one of these four extensions under one
 * of these roots is in scope, discovered rather than hand-listed — a
 * hand-list is exactly the class of "guarded by memory, not by
 * construction" bug this rewrite exists to close (2026-08-22 audit finding).
 */
const COPY_ROOTS = [
  'src/pages',
  'src/components',
  'src/layouts',
  'src/data',
  'src/i18n',
  'src/lib',
];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
    } else if (/\.(astro|svelte|ts|json)$/.test(entry) && !/\.(d|test|spec)\.ts$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

const SCAN_TARGETS = [
  ...COPY_ROOTS.flatMap((d) => walk(path.join(ROOT, d))).map((f) =>
    path.relative(ROOT, f).split(path.sep).join('/')
  ),
  'public/llms.txt',
];

describe('content laws — scan-surface self-check', () => {
  it('scans the whole copy surface (if this count crashes toward zero, the walk broke and every law below is silently scanning nothing)', () => {
    expect(SCAN_TARGETS.length).toBeGreaterThanOrEqual(100);
    // The exact files an adversarial review found unguarded before this
    // rewrite — pinned by name so a future refactor that narrows the walk
    // back down gets caught immediately, not by someone noticing months
    // later that a component's copy was never checked.
    expect(SCAN_TARGETS).toContain('src/components/contact/ContactFunnel.svelte');
    expect(SCAN_TARGETS).toContain('src/components/layout/Footer.astro');
    expect(SCAN_TARGETS).toContain('src/components/layout/Header.astro');
    expect(SCAN_TARGETS).toContain('src/pages/404.astro');
    expect(SCAN_TARGETS).toContain('src/pages/index.astro');
    expect(SCAN_TARGETS).toContain('src/data/lab-faq.ts');
    expect(SCAN_TARGETS).toContain('src/lib/lab-copilot-content.ts');
    expect(SCAN_TARGETS).toContain('public/llms.txt');
  });

  it('every src/data copy module is scanned (regression: lab-faq.ts was omitted from the old hand-list)', () => {
    const dataFiles = readdirSync(path.join(ROOT, 'src/data'))
      .filter((f) => f.endsWith('.ts'))
      .map((f) => `src/data/${f}`);
    expect(dataFiles.filter((f) => !SCAN_TARGETS.includes(f))).toEqual([]);
  });
});

/**
 * Strips `/* block *␀/` and `// line` comments before any assertion runs.
 * This is LOAD-BEARING, not cosmetic: services.ts, faq.ts and
 * contact-form.ts each NAME "Stripe" inside a doc comment that explains WHY
 * it is banned (see their header comments) — scanning raw, unstripped text
 * would make this very file fail on the sentence that documents the rule.
 * Verified by inspection (2026-08-22): every current "Stripe"/"24/7"
 * mention inside a comment sits inside a `/** ... *␀/` block, so
 * block-comment stripping alone clears today's cases; `//` stripping is
 * kept too, for future line comments, but ONLY when `//` OPENS the
 * (whitespace-trimmed) line — never mid-line. That restriction matters:
 * several strings legitimately contain a literal "//" that is NOT a
 * comment — the site's own mono-label idiom (`monoLabel: '// 01 · audit'`)
 * and every `https://` URL in llms.txt and the page copy. A naive "strip
 * from // to end of line" stripper would silently truncate those URLs and
 * eat the real content that follows them on the same line — a false
 * negative that would hide, not surface, a violation. Comments are blanked
 * to same-length whitespace (newlines kept) rather than deleted outright,
 * so the line numbers this file reports in failure messages stay accurate.
 *
 * Re-verified 2026-08-22 against the widened scan surface: the site's `//`
 * mono-eyebrow idiom (`eyebrow: '// for agencies'`,
 * `<span aria-hidden="true">// </span>{...}`) never opens its own raw
 * source line in the current codebase — it always follows a key or a tag on
 * the same line — so this restriction does not blank any of it today. A
 * regression test below pins that invariant so a future Prettier-wrap or
 * refactor that pushes one of these onto its own line gets caught before it
 * silently starts hiding banned words, rather than after.
 */
function stripComments(text: string): string {
  const blank = (m: string): string => m.replace(/[^\n]/g, ' ');
  return text
    .replace(/\/\*[\s\S]*?\*\//g, blank) // block comments, anywhere
    .replace(/^[ \t]*\/\/.*$/gm, blank); // line comments that OPEN their line
}

/**
 * Merges `'AAA' +\n  'BBB'`-shaped adjacent string-literal concatenation
 * into a single literal (`'AAABBB'`), so a banned phrase split across the
 * `+` seam cannot hide from a scanner that only ever sees one literal at a
 * time. This is not hypothetical: src/lib/synapse-mock.ts's RU same-day-
 * promise string was written as
 * `'...письменный ответ в ' + 'течение рабочего дня\n\n' + ...` — the
 * banned phrase «в течение рабочего дня» (missing «одного», see law 4
 * above) existed in the SOURCE the moment those two literals were
 * concatenated at runtime, but no line-based or single-literal-based
 * scanner could ever see it, because neither half contains the full banned
 * string on its own. (Fixed in this same 2026-08-22 window, independently
 * of this test file — the regression test below pins the bug SHAPE with an
 * inline fixture so it can be caught again regardless of the live file's
 * current state.)
 *
 * Only same-quote-character pairs separated by nothing but whitespace and a
 * single `+` are merged — deliberately narrow, so this never touches
 * `a + b` where `a`/`b` are variables, or a template literal's `${expr}`
 * interpolation. Runs to a fixed point so a chain of N concatenated
 * literals (synapse-mock.ts's replies are built from long `+`-joined
 * chains) is fully collapsed, not just merged pairwise. The seam's own
 * whitespace is preserved as whitespace (newlines kept as newlines) so
 * `lineAt()` below still reports a sane line number for the merged string.
 */
function joinStringConcatenation(text: string): string {
  const pairPattern = /(['"`])((?:\\.|(?!\1)[^\\])*)\1(\s*\+\s*)\1((?:\\.|(?!\1)[^\\])*)\1/g;
  let prev: string;
  let result = text;
  let guard = 0;
  do {
    prev = result;
    result = result.replace(
      pairPattern,
      (_m, q: string, a: string, ws: string, b: string) =>
        `${q}${a}${b}${q}${ws.replace(/[^\n]/g, ' ')}`
    );
    guard += 1;
  } while (result !== prev && guard < 50);
  return result;
}

interface ScannedFile {
  rel: string;
  /** Comment-stripped, concatenation-joined source text — original line numbering preserved. */
  raw: string;
}

const FILES: ScannedFile[] = SCAN_TARGETS.map((rel) => ({
  rel,
  raw: joinStringConcatenation(stripComments(readFileSync(path.join(ROOT, rel), 'utf8'))),
}));

function lineAt(text: string, index: number): number {
  return text.slice(0, index).split('\n').length;
}

/**
 * Every match of `pattern` (must carry the `g` flag) across every scanned
 * file, rendered as "file:line: matched text" — so a failing `expect(...)
 * .toEqual([])` names the exact offending source instead of just a boolean.
 */
function findAll(pattern: RegExp, files: ScannedFile[] = FILES): string[] {
  const hits: string[] = [];
  for (const { rel, raw } of files) {
    for (const m of raw.matchAll(pattern)) {
      hits.push(`${rel}:${lineAt(raw, m.index ?? 0)}: ${JSON.stringify(m[0])}`);
    }
  }
  return hits;
}

/**
 * Every quoted string-literal BODY in a file (single/double/backtick),
 * matched non-greedily with escape-awareness. Used to scope the
 * registry-number laws below: once SCAN_TARGETS widened to whole
 * copy-bearing directories (2026-08-22), it started walking real
 * engineering code alongside real copy — src/lib/embedding/cluster.ts and
 * reduce.ts carry bare numeric constants (`4294967296` — 2**32, a PRNG
 * normalisation constant; `20260708` — a seed) that are 8+ digits long and
 * would trip a whole-file-text digit-run scan despite never being copy, let
 * alone a registry number, because they are not inside a string at all.
 * A registry number that actually SHIPS is, in this codebase's real
 * conventions, always inside a quoted literal (a `Bilingual` field or a
 * plain string) — never a bare numeric literal in application logic — so
 * scoping to string bodies removes that whole false-positive class without
 * narrowing which FILES get scanned.
 */
function extractStringLiterals(text: string): Array<{ text: string; offset: number }> {
  const zones: Array<{ text: string; offset: number }> = [];
  const pattern = /(['"`])((?:\\.|(?!\1)[\s\S])*)\1/g;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(text))) {
    zones.push({ text: m[2] ?? '', offset: m.index + 1 });
  }
  return zones;
}

function findInStringLiterals(pattern: RegExp, files: ScannedFile[] = FILES): string[] {
  const hits: string[] = [];
  for (const { rel, raw } of files) {
    for (const zone of extractStringLiterals(raw)) {
      for (const m of zone.text.matchAll(pattern)) {
        const idx = zone.offset + (m.index ?? 0);
        hits.push(`${rel}:${lineAt(raw, idx)}: ${JSON.stringify(m[0])}`);
      }
    }
  }
  return hits;
}

/**
 * Decodes the encodings an adversarial review demonstrated bypass a naive
 * `/stripe/gi` substring match while still rendering as the literal word to
 * a reader/browser: `\uXXXX` JS escapes, numeric/hex HTML entities
 * (`&#83;tripe`), and zero-width/soft-hyphen splitter characters a
 * copy-paste can silently introduce (a soft hyphen inside "Stripe" reads as
 * "Stripe" to every reader and search engine, but not to a literal
 * scanner). String-concatenation splitting (`'Stri' + 'pe'`) is already
 * closed by `joinStringConcatenation` above, before this function ever
 * runs.
 */
// Soft hyphen, ZW space/non-joiner/joiner, BOM — built from explicit char
// codes rather than embedded as literal characters, so this SOURCE FILE
// never itself contains an invisible character a reviewer or an editor's
// autoformatter can silently mangle.
const INVISIBLE_SPLITTER_CODES = [0x00ad, 0x200b, 0x200c, 0x200d, 0xfeff];
const INVISIBLE_SPLITTERS = new RegExp(
  `[${INVISIBLE_SPLITTER_CODES.map((c) => String.fromCharCode(c)).join('')}]`,
  'g'
);

function decodeCopy(s: string): string {
  return s
    .replace(/\\u([0-9a-f]{4})/gi, (_m, h: string) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#x?([0-9a-f]+);/gi, (_m, d: string) =>
      String.fromCharCode(parseInt(d, /^x/i.test(d) ? 16 : 10))
    )
    .replace(INVISIBLE_SPLITTERS, '');
}

describe('content laws — shipped copy, site-wide', () => {
  it('never mentions Stripe (unavailable to Armenian sole proprietors), including obfuscated encodings', () => {
    const decoded = FILES.map(({ rel, raw }) => ({ rel, raw: decodeCopy(raw) }));
    expect(findAll(/stripe/gi, decoded)).toEqual([]);
  });

  it('never contains a registry-number-looking unbroken digit run (8+ digits straight) inside a string literal', () => {
    // 8, not services-data.test.ts's 6, per this audit's brief — the wider
    // surface here includes things a 6-digit floor would false-positive on
    // (OG image dimensions like "1200x630", version-ish strings). Scoped to
    // string-literal bodies (see extractStringLiterals's doc comment) —
    // required once the scan surface grew to include real engineering code
    // that legitimately carries large bare numeric constants.
    expect(findInStringLiterals(/\d{8,}/g)).toEqual([]);
  });

  it('never contains a registry-number-looking digit run GROUPED by a separator (space/NBSP/comma family), inside a string literal', () => {
    // The unbroken-run law above is trivially defeated by writing the same
    // number the way identifiers are actually printed: "123 456 789",
    // "1,234,567,890". Grouping characters are deliberately restricted to
    // the space/comma/apostrophe family (see SEPARATOR_FAMILY below) — NOT
    // "." or "-" — because this codebase's string literals legitimately
    // contain both (SVG path data, decimal literals, ISO dates) and a wider
    // separator set produced false positives across the real scan surface
    // when checked (2026-08-22). A registry number formatted with dots or
    // dashes is not caught by this law; the unbroken-run law above still
    // catches the common case.
    const grouped = new RegExp(`\\d(?:${SEPARATOR_FAMILY_SOURCE}\\d){7,}`, 'g');
    expect(findInStringLiterals(grouped)).toEqual([]);
  });

  it('never promises 24/7, in any wording, except naming it inside a services.ts `notIncluded` entry', () => {
    // notIncluded is the one shape on the site allowed to NAME what it does
    // NOT offer (see services-data.test.ts's `collectStrings('promises')`,
    // which excludes it from the same law for the same reason). It is
    // `Bilingual[]` on each SERVICES rung — imported here and used to mask
    // out its own literal text before scanning, rather than regex-guessing
    // where a `notIncluded: [ ... ]` block's brackets close in raw text, so
    // the exemption tracks the real data shape instead of approximating it.
    // Verified (2026-08-22): only services.ts's on-prem-ai rung currently
    // names "24/7", and only inside notIncluded — masking it is therefore
    // exactly as narrow as the law requires, nothing more. CLOCK itself is
    // imported from ./helpers/content-law-patterns so this file and
    // services-data.test.ts can never carry two different versions of the
    // same law again (2026-08-22 audit finding).
    const exempt: string[] = [];
    for (const rung of SERVICES) {
      for (const b of rung.notIncluded) {
        exempt.push(b.en, b.ru);
      }
    }
    const maskedFiles: ScannedFile[] = FILES.map(({ rel, raw }) => {
      if (rel !== 'src/data/services.ts') return { rel, raw };
      let masked = raw;
      for (const s of exempt) {
        masked = masked.split(s).join(s.replace(/[^\n]/g, '#'));
      }
      return { rel, raw: masked };
    });
    expect(findAll(CLOCK, maskedFiles)).toEqual([]);
  });
});

describe('content laws — CLOCK pattern regression table (2026-08-22 widening)', () => {
  // Pins the widened phrasings so a future "simplify this regex" pass can't
  // quietly narrow it back to the four literal spellings an adversarial
  // review found insufficient.
  it.each([
    'Round-the-clock monitoring included.',
    'We watch it round the clock.',
    '24×7 coverage',
    '24⁄7 coverage',
    '24-7 support',
    'Twenty-four hours a day, seven days a week.',
    'Always-on monitoring, any hour you need it.',
    'Поддержка 24 часа в сутки, без выходных.',
    'Отвечаю в любое время суток.',
    'Работаем круглые сутки.',
  ])('CLOCK catches %j', (s) => {
    expect(s).toMatch(CLOCK);
  });

  it('CLOCK does not fire on unrelated "24" or "7" mentions', () => {
    expect(
      '€900, 5–10 business days, response within 24 hours of the call being booked'
    ).not.toMatch(CLOCK);
    expect('7 prompts tested across 24 categories').not.toMatch(CLOCK);
  });
});

describe('content laws — RU/EN response-promise parity', () => {
  it('never promises «в течение рабочего дня» — only «в течение одного рабочего дня» matches the English "within one business day"', () => {
    // Without "одного" ("one"), the phrase reads to a Russian speaker as
    // "by end of today" — a same-day commitment nobody on a one-engineer
    // studio can actually keep, and a stronger promise than the English
    // original makes.
    //
    // Widened 2026-08-22: the old pattern had no `i` flag (so a
    // sentence-initial «В течение рабочего дня…» — the most common position
    // for the phrase — bypassed it) and no whitespace tolerance (so a
    // Prettier line-wrap or an RU-typographic NBSP after «в» / «течение»
    // also bypassed it). `\s` in a JS RegExp already matches U+00A0 and
    // every other Unicode space separator, so `\s+` between each word
    // closes both gaps at once, with no separate NBSP-normalisation pass
    // needed. joinStringConcatenation (above) additionally ensures the
    // phrase can't hide split across a `'...' + '...'` seam, which is
    // exactly how this string was once written in
    // src/lib/synapse-mock.ts — see that function's doc comment.
    const pattern = /(?<!одного\s+)в\s+течение\s+рабочего\s+дня/gi;
    expect(findAll(pattern)).toEqual([]);
  });

  it('never promises the synonym «в рабочий день» ("on a/the business day", same same-day reading)', () => {
    const pattern = /в\s+рабочий\s+день/gi;
    expect(findAll(pattern)).toEqual([]);
  });

  it.each([
    'В течение рабочего дня отвечу.',
    'в течение\nрабочего дня',
    'в течение рабочего дня',
    'В ТЕЧЕНИЕ РАБОЧЕГО ДНЯ',
    'Ответ в рабочий день.',
  ])('REPLY_PROMISE / SYNONYM regression: %j is caught', (s) => {
    const dayPromise = /(?<!одного\s+)в\s+течение\s+рабочего\s+дня/i;
    const synonym = /в\s+рабочий\s+день/i;
    expect(dayPromise.test(s) || synonym.test(s)).toBe(true);
  });

  it('the correctly-scoped promise «в течение одного рабочего дня» is NOT caught', () => {
    const dayPromise = /(?<!одного\s+)в\s+течение\s+рабочего\s+дня/i;
    expect('в течение одного рабочего дня').not.toMatch(dayPromise);
  });
});

describe('content laws — a banned phrase cannot hide across a string-concatenation seam', () => {
  // The class of bypass the 2026-08-22 audit singled out as CRITICAL:
  // src/lib/synapse-mock.ts's RU same-day-promise string was genuinely
  // written as two `+`-joined literals, with the banned phrase split across
  // the seam — invisible to a scanner that inspects one literal at a time.
  // Pinned here as an inline fixture (independent of the live file's
  // current content, which was fixed in the same window as this audit) so
  // the bypass class itself, not just today's instance of it, stays closed.
  it('reconstructs a banned RU phrase split across a `+` seam (regression: the historical synapse-mock.ts shape)', () => {
    const bypassShape =
      "'— Договор и скоуп под вашу задачу — к человеку: /ru/contact/, письменный ответ в ' +\n      'течение рабочего дня\\n\\n' +\n      'С чем разбираемся?'";
    const joined = joinStringConcatenation(bypassShape);
    expect(joined).toMatch(/в\s+течение\s+рабочего\s+дня/i);
  });

  it('does not false-positive once the seam is on the correct ("одного") side of the law', () => {
    const fixedShape = "'ответ в ' +\n      'течение одного рабочего дня'";
    const joined = joinStringConcatenation(fixedShape);
    expect(joined).not.toMatch(/(?<!одного\s+)в\s+течение\s+рабочего\s+дня/i);
  });

  it('reconstructs "Stripe" split across a `+` seam', () => {
    const joined = joinStringConcatenation("'Stri' + 'pe'");
    expect(joined.toLowerCase()).toContain('stripe');
  });

  it('collapses a chain of more than two concatenated literals, not just a single pair', () => {
    // Trailing whitespace is expected: consumed seams are blanked to
    // same-length spaces (not deleted) so line numbers stay accurate — see
    // joinStringConcatenation's own doc comment.
    const chain = "'a' + 'b' + 'c' + 'd' + 'e'";
    expect(joinStringConcatenation(chain).trim()).toBe("'abcde'");
  });
});

describe('content laws — the "//" mono-label idiom survives comment-stripping (regression)', () => {
  // stripComments only blanks a `//` line comment when it OPENS the
  // (trimmed) source line — deliberately, because the site's own visible
  // eyebrow idiom uses a literal "// " as COPY, not code. Verified
  // (2026-08-22) that today's instances never open their own line — they
  // always follow a key (`eyebrow: '// for agencies'`) or a tag
  // (`<span aria-hidden="true">// </span>`) on the same source line. This
  // pins that invariant against the two live files an adversarial review
  // pointed at, so a future Prettier-wrap or refactor that pushes one onto
  // its own line — which WOULD blank it under the current stripper — is
  // caught here first, rather than by a banned word silently surviving
  // inside a blanked mono-label.
  it('the for-agencies eyebrow label survives', () => {
    const file = FILES.find((f) => f.rel === 'src/pages/[lang]/services/for-agencies/index.astro');
    expect(file?.raw).toContain("eyebrow: '// for agencies'");
  });

  it('the geo-audit mono-label span survives', () => {
    const file = FILES.find((f) => f.rel === 'src/pages/[lang]/services/geo-audit/index.astro');
    expect(file?.raw).toContain('aria-hidden="true">// </span>');
  });
});

/**
 * Extracts the RU-language value text following every `ru:` key in a file,
 * for the price-typography laws below, which must never fire on a
 * legitimate EN comma ("€2,000" is correct English; "€2 000" is the RU
 * rule) — so unlike every other law in this file, this one cannot just scan
 * raw whole-file text.
 *
 * Two shapes exist in this codebase for RU value text (verified by
 * inspection, 2026-08-22):
 *  1. `ru: '...'` / `ru: "..."` — a single Bilingual field's RU string.
 *     This is NOT reliably "the line that begins with `ru:`": in most files
 *     (services.ts, faq.ts, services-faq.ts) Prettier puts `en:`/`ru:` each
 *     on its own line, but src/lib/contact-form.ts's BUDGET_OPTIONS /
 *     TIMELINE_OPTIONS pack `en:` and `ru:` onto ONE line per entry — a
 *     line-start check would silently skip that file's RU text entirely.
 *     Taking whatever follows the LAST `ru:` marker on the text (not the
 *     line) correctly covers both shapes.
 *  2. `ru: { ... }` — a whole block of RU strings keyed by field name, with
 *     no per-field `ru:` marker at all (contact/index.astro's and
 *     geo-audit/index.astro's page-copy objects: `{ en: {...}, ru: {...} }`).
 *     Found by matching the opening brace and walking forward to its
 *     depth-balanced closing brace, so arbitrary nesting inside (e.g.
 *     contact/index.astro's `ru.labels.errors`) is captured correctly.
 * The marker also accepts a QUOTED key (`'ru':` / `"ru":`) — widened
 * 2026-08-22 after an adversarial review found the unquoted-only marker
 * silently produced zero RU zones (and therefore a no-op price law) for any
 * file written with quoted object keys.
 * A `ru:` marker followed by neither (e.g. the `Bilingual` interface's own
 * `ru: string;` type declaration in services.ts) contributes nothing — it
 * is a type, not a value.
 *
 * ru.json has no `ru:` markers at all — the whole FILE is Russian, one
 * language per file — so it is a special case: every line counts. en.json
 * and llms.txt carry no RU content and contribute nothing.
 */
function extractRuZones(rel: string, text: string): Array<{ text: string; offset: number }> {
  if (rel === 'src/i18n/ru.json') return [{ text, offset: 0 }];
  if (rel === 'src/i18n/en.json' || rel === 'public/llms.txt') return [];
  const zones: Array<{ text: string; offset: number }> = [];
  const marker = /(?:\bru|['"]ru['"])\s*:\s*/g;
  let m: RegExpExecArray | null;
  while ((m = marker.exec(text))) {
    const after = m.index + m[0].length;
    const ch = text[after];
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      let end = after + 1;
      while (end < text.length && text[end] !== quote) {
        if (text[end] === '\\') end += 1; // skip escaped char (e.g. \')
        end += 1;
      }
      zones.push({ text: text.slice(after, end + 1), offset: after });
      marker.lastIndex = end + 1;
    } else if (ch === '{' || ch === '[') {
      const open = ch;
      const close = ch === '{' ? '}' : ']';
      let depth = 0;
      let end = after;
      for (; end < text.length; end++) {
        if (text[end] === open) depth++;
        else if (text[end] === close) {
          depth--;
          if (depth === 0) break;
        }
      }
      zones.push({ text: text.slice(after, end + 1), offset: after });
      marker.lastIndex = end + 1;
    }
    // else: `ru:` matched a type annotation or similar non-value position —
    // contributes no zone, and exec()'s own lastIndex already moved past
    // the marker, so the loop still makes forward progress.
  }
  return zones;
}

function findInRuZones(pattern: RegExp, files: ScannedFile[] = FILES): string[] {
  const hits: string[] = [];
  for (const { rel, raw } of files) {
    for (const zone of extractRuZones(rel, raw)) {
      for (const m of zone.text.matchAll(pattern)) {
        const idx = zone.offset + (m.index ?? 0);
        hits.push(`${rel}:${lineAt(raw, idx)}: ${JSON.stringify(m[0])}`);
      }
    }
  }
  return hits;
}

/**
 * The family of characters a thousands-grouping mistake could plausibly
 * use: the plain ASCII space, comma, apostrophe, and every Unicode "space
 * separator" from the General Punctuation block that isn't U+00A0 itself
 * (EN QUAD..HAIR SPACE covers U+2000-U+200A, which includes the figure
 * space U+2007 and thin space U+2009 an adversarial review specifically
 * demonstrated bypassing the old comma/plain-space-only laws), plus the
 * narrow no-break space (U+202F — what ICU emits for several locales and
 * what design tools paste), medium mathematical space (U+205F) and
 * ideographic space (U+3000). Deliberately excludes "." and "-": this
 * codebase's real string literals legitimately contain both (SVG path
 * data, decimal token-price literals, ISO date strings), and including them
 * produced false positives across the real scan surface when checked
 * (2026-08-22) — see the two call sites' own comments. All members are
 * written as explicit `\u` escapes, never as literal characters in source,
 * so this file never carries an invisible character a reviewer (or an
 * editor's autoformatter) can't see.
 */
const SEPARATOR_FAMILY_SOURCE = "[\\u0020,'\\u2000-\\u200A\\u202F\\u205F\\u3000]";

/**
 * Returns a FRESH RegExp instance each call, deliberately — a `g`-flagged
 * RegExp is stateful (`lastIndex`), and this pattern is asserted against
 * from several independent `it()` blocks below; sharing one instance would
 * make later assertions silently depend on the iteration state left behind
 * by earlier ones.
 */
function ruPriceSeparatorPattern(): RegExp {
  return new RegExp(`\\d${SEPARATOR_FAMILY_SOURCE}(?=\\d{3}\\b)`, 'g');
}

describe('content laws — GMT+4 is not a synonym for EU business hours', () => {
  /**
   * The site's honest formulation is that the engineer's working AFTERNOON
   * overlaps EU and UK business hours — llms.txt states it exactly that way,
   * and the contact page and FAQ follow it. Two strings on the on-prem rung
   * instead glossed the timezone AS those hours: "in EU hours (GMT+4)" and
   * «в европейские рабочие часы (GMT+4)». Armenia is UTC+4 and the EU runs
   * UTC+1/+2, so that parenthesis turned a careful distinction into a
   * checkable factual error — on the page a procurement reader opens.
   *
   * Found by a contradiction sweep, 2026-08-25. Nothing caught it before:
   * every price, duration and promise in the suite was green while this
   * shipped in both locales.
   */
  const GLOSS = /\(\s*(?:GMT|UTC)\s*\+\s*4\s*\)/i;
  const EU_HOURS_NEARBY =
    /(EU|European|Europe|ЕС|европейск\w*)[^.!?]{0,40}\(\s*(?:GMT|UTC)\s*\+\s*4\s*\)/i;

  it('never writes the timezone as a parenthetical gloss on "EU hours"', () => {
    const offenders = FILES.filter((f) => EU_HOURS_NEARBY.test(f.raw)).map((f) => f.rel);
    expect(
      offenders,
      `"EU hours (GMT+4)" equates two different things in: ${offenders.join(', ')}`
    ).toEqual([]);
  });

  it('still allows naming the timezone when it is not dressed as EU hours', () => {
    // The permitted shape, as used on the contact page: the offset is stated
    // as where the engineer sits, not as what the hours are.
    const allowed = 'in EU hours (the engineer works from GMT+4)';
    expect(EU_HOURS_NEARBY.test(allowed)).toBe(false);
    // and the bare parenthetical on its own is not what this law bans
    expect(GLOSS.test('(GMT+4)')).toBe(true);
  });
});

describe('content laws — RU price typography', () => {
  it('RU price groups never use a comma as the thousands separator (EN keeps the comma; RU never does)', () => {
    expect(findInRuZones(/\d,\d{3}/g)).toEqual([]);
  });

  it('RU price groups use a non-breaking space (U+00A0), never a breakable plain space', () => {
    // Kept as its own it() (separate from the comma law above) on purpose:
    // this is the STRICTER, newer rule — a plain space is "not wrong"
    // typographically the way a comma is, it just risks a price breaking
    // across two lines (€3 / 500). A regression here should be visible on
    // its own, not bundled into the comma assertion's pass/fail.
    expect(findInRuZones(/\d \d{3}\b/g)).toEqual([]);
  });

  it('RU price digit groups use U+00A0 and NOTHING else (positive law, not an enumerated blocklist)', () => {
    // The two laws above are negatives — "not a comma", "not a plain
    // space" — which an adversarial review pointed out leaves every OTHER
    // space-family character open: thin space (U+2009), narrow no-break
    // space (U+202F, what ICU emits for several locales and what design
    // tools paste), figure space (U+2007), an apostrophe. This asserts the
    // POSITIVE law instead: the character immediately before a 3-digit
    // group must be U+00A0 or nothing (i.e. a genuine word boundary), full
    // stop — see SEPARATOR_FAMILY_SOURCE's doc comment for exactly which
    // characters count as a separator here and why "/" and ":" don't
    // (checked against the real scan surface: an unscoped version flagged
    // "100/100", the Lighthouse-score ratio in PROOF_STRIP and the
    // vkvstudio-site case study, as if "/" were a broken thousands
    // separator).
    expect(findInRuZones(ruPriceSeparatorPattern())).toEqual([]);
  });

  it('the same law holds for ANY Cyrillic string literal, independent of a `ru:` marker existing at all', () => {
    // extractRuZones (above) needs a `ru:`/`'ru':` key to find its zones —
    // an adversarial review found that a RU value written without one
    // (`const price = lang === 'ru' ? 'от €7,500' : ...`, `const RU = {
    // price: 'от €7,500' }`) makes the marker-based laws a silent no-op for
    // that whole expression. This fallback needs no marker: every quoted
    // string literal in a scanned file that CONTAINS Cyrillic text is
    // checked directly, so a price living in an RU string with no `ru:` key
    // nearby is still caught. Checked against the real scan surface
    // (2026-08-22): zero matches — every current Cyrillic literal already
    // uses U+00A0.
    const hits: string[] = [];
    for (const { rel, raw } of FILES) {
      for (const zone of extractStringLiterals(raw)) {
        if (!/[а-яё]/i.test(zone.text)) continue;
        for (const m of zone.text.matchAll(ruPriceSeparatorPattern())) {
          const idx = zone.offset + (m.index ?? 0);
          hits.push(`${rel}:${lineAt(raw, idx)}: ${JSON.stringify(m[0])}`);
        }
      }
    }
    expect(hits).toEqual([]);
  });

  it.each([
    ['comma', '7,500'],
    ['plain space (U+0020)', '7 500'],
    ['thin space (U+2009)', '7 500'],
    ['narrow no-break space (U+202F)', '7 500'],
    ['figure space (U+2007)', '7 500'],
    ['apostrophe', "7'500"],
  ])('positive-law regression: %s separator (%j) is caught', (_label, s) => {
    expect(s).toMatch(ruPriceSeparatorPattern());
  });

  it('the correct U+00A0 separator is never flagged, and unrelated digit-punctuation (ratios, times) is never flagged', () => {
    expect('7 500').not.toMatch(ruPriceSeparatorPattern());
    expect('100/100').not.toMatch(ruPriceSeparatorPattern());
    expect('10:300').not.toMatch(ruPriceSeparatorPattern());
  });
});

describe('content laws — settled contradiction verdicts stay settled (2026-08-30)', () => {
  /**
   * П-3: the contract-and-NDA promise must always carry its own exception —
   * "before any work beyond the audit". The naked absolute contradicted the
   * geo-audit page's "No NDA needed" selling point in six places at once
   * (trustLine, services.ts, contact, trust ×3, llms.txt:18 vs its own :11);
   * fixed 2026-08-30 (commits 2724aea/7bc715e), and this law keeps any new
   * surface honest by construction. Context-gated on NDA within ±160 chars so
   * an unrelated "before any work" (safety copy, a checklist) never trips it.
   */
  function nakedNdaPromises(phrase: RegExp, carveOut: RegExp): string[] {
    const hits: string[] = [];
    for (const { rel, raw } of FILES) {
      for (const m of raw.matchAll(phrase)) {
        const i = m.index ?? 0;
        const ctx = raw.slice(Math.max(0, i - 160), i + m[0].length + 160);
        if (!/NDA/i.test(ctx)) continue; // not the contract promise
        const tail = raw.slice(i + m[0].length, i + m[0].length + 60);
        if (!carveOut.test(tail)) {
          hits.push(`${rel}:${lineAt(raw, i)}: ${JSON.stringify(m[0] + tail.slice(0, 24))}`);
        }
      }
    }
    return hits;
  }

  it('every EN contract-and-NDA promise carries the audit exception (П-3)', () => {
    // The exception may be worded as the canonical "beyond the audit" or as
    // the homepage FAQ's fuller "the audit needs neither" — what the law
    // demands is that the audit is excepted in the same breath, not one
    // particular phrasing. A trailing "?" is a question heading, not a
    // promise (its answer right below is what carries the exception).
    expect(nakedNdaPromises(/\b(?:before|precedes?) any work\b/gi, /^\s*\?|\baudit\b/i)).toEqual(
      []
    );
  });

  it('every RU contract-and-NDA promise carries the audit exception (П-3)', () => {
    expect(nakedNdaPromises(/до начала (?:любых )?работ/g, /^\s*\?|аудит/i)).toEqual([]);
  });

  /**
   * П-5 / Р-2 / terminology №2: the agencies page once made the client-contact
   * promise at five different strengths, up to an absolute its own FAQ #3
   * disproved two paragraphs later. The settled ceiling is "written
   * go-ahead" / "not on my own initiative"; these exact absolutes — and the
   * "explicit go-ahead" wording a spoken yes would satisfy — are banned
   * site-wide (commit 45430a7).
   */
  it('never promises "no contact with your client, ever" in any locale (П-5)', () => {
    expect(findAll(/no contact with your client, ever\b/gi)).toEqual([]);
    expect(findAll(/вообще не выхожу на связь/g)).toEqual([]);
  });

  it('the client-contact permission is written, never merely "explicit" (terminology №2)', () => {
    expect(findAll(/explicit go-ahead/gi)).toEqual([]);
    expect(findAll(/явного разрешения/g)).toEqual([]);
  });

  /**
   * П-7: "no fine print" was itself disproved two lines below where it stood —
   * the guarantee's qualifiers ARE fine print, they are honest and they stay;
   * the claim that they don't exist is what goes (commit 2724aea). Comments
   * are already stripped from `raw`, so documentation like geo-audit's
   * skeptic-finding note keeps its right to name the banned phrase.
   */
  it('never claims the guarantee has no fine print, in either locale (П-7)', () => {
    expect(findAll(/\bno fine print\b/gi)).toEqual([]);
    expect(findAll(/нет мелкого шрифта/g)).toEqual([]);
  });
});

describe('content laws — financial verdicts stay settled (2026-09-06, banking facts confirmed)', () => {
  /**
   * П-1: an Armenian sole proprietor is a non-EU supplier — invoices carry NO
   * VAT; EU/UK buyers self-account for it under the reverse charge. The
   * banned form below asserts the opposite (that the invoice carries VAT) and
   * once lived in six places. Canon wording: trust page, "What do invoices
   * look like". Accountant sign-off on the wording is still pending — this
   * law freezes internal consistency, not tax advice.
   */
  it('never claims invoices CARRY reverse-charge VAT, in either locale (П-1)', () => {
    expect(findAll(/carr(?:y|ies) EU reverse-charge VAT/gi)).toEqual([]);
    expect(findAll(/с EU reverse-charge VAT/g)).toEqual([]);
    expect(findAll(/with EU reverse-charge VAT on/gi)).toEqual([]);
  });

  /**
   * П-10: the 30/40/30 split is the typical project schedule, not a universal
   * law — the audit is a single invoice after delivery, retainers are
   * monthly. Every mention of the exact ratio must carry its qualifier, or
   * the trust line contradicts the audit page again.
   */
  it('every 30/40/30 mention is qualified with typically/обычно (П-10)', () => {
    const hits: string[] = [];
    for (const { rel, raw } of FILES) {
      for (const m of raw.matchAll(/30\/40\/30/g)) {
        const i = m.index ?? 0;
        const back = raw.slice(Math.max(0, i - 60), i);
        if (!/typically|обычно/i.test(back)) {
          hits.push(`${rel}:${lineAt(raw, i)}: ${JSON.stringify(back.slice(-40) + m[0])}`);
        }
      }
    }
    expect(hits).toEqual([]);
  });

  /**
   * П-17: prepayment risk (at most one milestone paid ahead) and the
   * liability cap (fees paid) are different mechanisms; the old wording
   * fused them into one "exposure" claim in four places. Prepayment language
   * is the settled form everywhere except the liability section of /trust/.
   */
  it('never conflates prepayment with exposure/risk on milestones (П-17)', () => {
    expect(findAll(/exposure never exceeds/gi)).toEqual([]);
    expect(findAll(/exposed beyond one/gi)).toEqual([]);
    expect(findAll(/риск никогда не превышает стоимость одного этапа/g)).toEqual([]);
  });
});
