/**
 * Guards on the service-ladder data — the commercial copy has two rules that
 * must never regress silently, plus basic shape checks so a rung can't ship
 * half-filled.
 *
 * 1. "Stripe" appears nowhere: Armenian sole proprietorships cannot open
 *    Stripe merchant accounts, and advertising a payment method we then can't
 *    use is a trust hit at the exact moment a buyer decides. (The brief
 *    originally said "Stripe/Wise" — that was researched and corrected.)
 * 2. No business registry numbers: standing owner rule after a registry-number
 *    mixup once published a personal identifier. The site says "registered
 *    sole proprietor, Armenia, since Feb 2026" and nothing more specific.
 * 3. No 24/7 promises: every response commitment on these pages must be one
 *    a single engineer can keep — next business day, EU hours.
 * 4. RU price typography: Russian uses a space as the thousands separator
 *    (€7 500), never a comma (€7,500 reads as a decimal to an RU reader).
 *    EN keeps the comma. See services.ts's header comment for the notation
 *    law this test enforces.
 */
import { describe, expect, it } from 'vitest';
import { ENGAGEMENT_TERMS, PROOF_STRIP, SERVICES, serviceUrl } from '@/data/services';
import type { Bilingual } from '@/data/services';
import { CLOCK } from './helpers/content-law-patterns';

/**
 * Every human-readable string in the data, flattened for content-rule scans.
 * `promises` excludes the notIncluded lists: those are where the copy is
 * allowed to NAME things we refuse to offer (e.g. "no 24/7 SLA") — everywhere
 * else, naming them reads as offering them.
 */
function collectStrings(scope: 'all' | 'promises'): string[] {
  const out: string[] = [];
  const push = (b: Bilingual) => {
    out.push(b.en, b.ru);
  };
  for (const rung of SERVICES) {
    push(rung.title);
    push(rung.outcome);
    push(rung.priceLine);
    push(rung.timeframe);
    push(rung.teaser);
    rung.deliverables.forEach(push);
    if (scope === 'all') rung.notIncluded.forEach(push);
    if (rung.riskReversal) push(rung.riskReversal);
    if (rung.retainer) {
      push(rung.retainer.title);
      push(rung.retainer.price);
      rung.retainer.includes.forEach(push);
      push(rung.retainer.terms);
      if (rung.retainer.lite) push(rung.retainer.lite);
    }
    if (rung.caseLabel) push(rung.caseLabel);
    push(rung.seo.title);
    push(rung.seo.description);
    out.push(rung.monoLabel);
  }
  for (const item of PROOF_STRIP) {
    push(item.value);
    push(item.label);
    push(item.qualifier);
  }
  ENGAGEMENT_TERMS.forEach(push);
  return out;
}

const allStrings = () => collectStrings('all');

describe('services data — content rules', () => {
  it('never mentions Stripe (unavailable to Armenian sole proprietors)', () => {
    for (const s of allStrings()) {
      expect(s.toLowerCase()).not.toContain('stripe');
    }
  });

  it('never contains registry-number-looking strings', () => {
    // Armenian registry / tax identifiers are long digit runs. Prices and
    // years are short; anything 6+ digits in a row has no business here.
    for (const s of allStrings()) {
      expect(s).not.toMatch(/\d{6,}/);
    }
  });

  it('never promises 24/7, in any wording (naming it under "not included" is allowed)', () => {
    // CLOCK is imported from ./helpers/content-law-patterns, the single
    // shared source for this law — content-laws.test.ts imports the exact
    // same constant, so the two files cannot carry two different-strength
    // versions of "no 24/7" again (2026-08-22 audit finding: before this,
    // each file hand-copied its own slightly different pattern).
    for (const s of collectStrings('promises')) {
      expect(s).not.toMatch(CLOCK);
    }
  });

  it('RU strings use a space thousands separator, never a comma (typography law)', () => {
    const looksRussian = /[а-яё]/i;
    for (const s of allStrings()) {
      if (!looksRussian.test(s)) continue;
      expect(s).not.toMatch(/\d,\d{3}/);
    }
  });
});

describe('services data — shape', () => {
  it('has the four ladder rungs in buyer-risk order', () => {
    expect(SERVICES.map((r) => r.id)).toEqual(['geo-audit', 'rag-pilot', 'on-prem-ai', 'websites']);
  });

  it('every rung is fully filled in both languages', () => {
    for (const rung of SERVICES) {
      for (const b of [rung.title, rung.outcome, rung.priceLine, rung.timeframe, rung.teaser]) {
        expect(b.en.trim(), `${rung.id}: empty EN`).not.toBe('');
        expect(b.ru.trim(), `${rung.id}: empty RU`).not.toBe('');
      }
      expect(rung.deliverables.length, `${rung.id}: deliverables`).toBeGreaterThanOrEqual(4);
      expect(rung.notIncluded.length, `${rung.id}: notIncluded`).toBeGreaterThanOrEqual(1);
      expect(rung.seo.title.en).toContain('VKVstudio');
      expect(rung.monoLabel).toMatch(/^\/\/ /);
    }
  });

  it('every rung carries a machine-readable price for JSON-LD', () => {
    for (const rung of SERVICES) {
      const p = rung.priceJsonLd;
      expect(p.currency).toBe('EUR');
      const value = 'price' in p ? p.price : p.minPrice;
      expect(value, `${rung.id}: price or minPrice`).toBeTruthy();
      expect(Number(value)).toBeGreaterThan(0);
    }
  });

  it('a credited diagnostic never exceeds one month of its retainer (pricing law, 2026-08-21)', () => {
    // The broken offer this guards against: audit $900 credited "in full"
    // against a €600 month — 1.5 free months nobody intended. Market ratio
    // (see .system/pricing_research_2026-08-21.md): diagnostic ≈ 0.3–0.6×
    // of one recurring month. If a retainer's copy mentions crediting the
    // audit, the retainer's monthly floor must be >= the rung's price.
    //
    // Widened 2026-08-22: the pre-audit version searched ONLY
    // `retainer.includes` and silently `continue`d past the whole rung when
    // it found nothing there — so a credit sentence living in
    // `retainer.terms` or `retainer.lite` (the geo-audit rung's actual
    // shape: the credit is repeated, differently worded, in BOTH
    // `retainer.includes` AND `retainer.lite`) escaped the law entirely for
    // whichever field wasn't `includes`. Now every retainer-scoped field is
    // searched, and every credit line found — not just the first — must
    // pass the arithmetic and the "names the full retainer" check.
    //
    // Deliberately EXCLUDES `riskReversal`: on-prem-ai's riskReversal names
    // a DIFFERENT credit relationship (the one-time €1,400 readiness
    // assessment credited against the one-time deployment floor, not a
    // diagnostic credited against a MONTHLY retainer) — that relationship
    // already has its own dedicated test below with its own correct
    // arithmetic. Folding riskReversal into this law's candidate list would
    // wrongly compare on-prem-ai's retainer month (from €1,500) against its
    // €7,500 deployment floor and fail a rung that is not broken.
    const creditRe = /credit|засчит|comes straight off|вычита|в счёт/i;
    // «полный ретейнер» inflects across Russian's six noun/adjective cases
    // (полный/полного/полному/полным/полном ретейнер/ретейнера/...); the
    // stem match below accepts any of them rather than the two forms
    // (nominative, genitive) the pre-audit law happened to hand-pick, which
    // rejected the grammatically-correct prepositional-case phrasing
    // geo-audit's own retainer.lite already ships («на полном ретейнере»).
    const fullRetainerRu = /полн[а-яё]*\s+ретейнер[а-яё]*/i;
    for (const rung of SERVICES) {
      if (!rung.retainer) continue;
      const candidates: Bilingual[] = [
        rung.retainer.title,
        rung.retainer.price,
        ...rung.retainer.includes,
        rung.retainer.terms,
        ...(rung.retainer.lite ? [rung.retainer.lite] : []),
      ];
      const creditLines = candidates.filter((line) => creditRe.test(`${line.en} ${line.ru}`));
      if (creditLines.length === 0) continue;
      const rungPrice = Number(
        'price' in rung.priceJsonLd ? rung.priceJsonLd.price : rung.priceJsonLd.minPrice
      );
      // 2026-08-22 fix: the old parser took the FIRST number anywhere in
      // `retainer.price.en`, which would silently grab a leading unrelated
      // number (e.g. a "2026 rate: ..." prefix) instead of the actual
      // monthly figure. Anchoring to the digits immediately after the
      // currency symbol is required for the arithmetic to mean anything.
      const monthMatch = rung.retainer.price.en.replace(/[,\s]/g, '').match(/[€$](\d+)/);
      const monthly = Number(monthMatch?.[1]);
      expect(
        monthly,
        `${rung.id}: retainer price must carry a currency-tagged number`
      ).toBeGreaterThan(0);
      expect(
        monthly,
        `${rung.id}: credited audit (${rungPrice}) exceeds one retainer month (${monthly})`
      ).toBeGreaterThanOrEqual(rungPrice);
      // The ratio, not just the ceiling. The line above only asserted
      // "a credit never exceeds one monthly invoice", so the 0.3–0.6x market
      // band the file header documents as the pricing law was never actually
      // checked: an audit at €1,400 against a €2,000 retainer gives 0.70 and
      // would have passed green (found while building the fact registry,
      // 2026-08-24). Both bounds now hold. The upper one is what stops the
      // entry diagnostic from reading as a cheap first month; the lower one
      // stops it from reading as a giveaway that buys an unserious buyer.
      const ratio = rungPrice / monthly;
      expect(
        ratio,
        `${rung.id}: entry diagnostic is ${ratio.toFixed(2)}x the retainer month — ` +
          `the documented law is 0.3–0.6x (audit ${rungPrice}, retainer ${monthly})`
      ).toBeLessThanOrEqual(0.6);
      expect(
        ratio,
        `${rung.id}: entry diagnostic is only ${ratio.toFixed(2)}x the retainer month — ` +
          `below the documented 0.3x floor it stops paying for the work it costs`
      ).toBeGreaterThanOrEqual(0.3);
      // A credit is ambiguous unless it names the FULL retainer explicitly
      // — a thin/lite tier must never look creditable.
      for (const line of creditLines) {
        expect(
          line.en,
          `${rung.id}: credit line must name the full retainer (EN): "${line.en}"`
        ).toMatch(/full retainer/i);
        expect(
          line.ru,
          `${rung.id}: credit line must name the full retainer (RU): "${line.ru}"`
        ).toMatch(fullRetainerRu);
      }
    }
  });

  it('on-prem readiness-assessment credit never outgrows the deployment floor (risk-reversal law, 2026-08-22)', () => {
    // The assessment (€1,400) must stay below one starter deployment
    // (priceJsonLd.minPrice), and the "you just saved €X" figure the copy
    // states must equal deployment-floor minus assessment fee — pinned so a
    // future price change can't leave the arithmetic silently wrong.
    const onPrem = SERVICES.find((r) => r.id === 'on-prem-ai');
    expect(onPrem?.riskReversal, 'on-prem-ai: riskReversal missing').toBeDefined();
    const text = onPrem?.riskReversal?.en ?? '';
    const feeMatch = text.match(/€([\d,]+) readiness assessment/);
    const savedMatch = text.match(/saved €([\d,]+)/);
    const fee = Number(feeMatch?.[1]?.replace(/,/g, ''));
    const saved = Number(savedMatch?.[1]?.replace(/,/g, ''));
    expect(fee, 'on-prem-ai: could not find the assessment fee in riskReversal.en').toBeGreaterThan(
      0
    );
    expect(
      saved,
      'on-prem-ai: could not find the "saved" figure in riskReversal.en'
    ).toBeGreaterThan(0);

    const priceJsonLd = onPrem?.priceJsonLd;
    const minPrice = priceJsonLd && 'minPrice' in priceJsonLd ? Number(priceJsonLd.minPrice) : NaN;
    expect(
      fee,
      'on-prem-ai: €1,400 assessment must not exceed the deployment floor'
    ).toBeLessThanOrEqual(minPrice);
    expect(
      minPrice - fee,
      'on-prem-ai: deployment floor minus fee must match the stated saving'
    ).toBe(saved);
    expect(saved).toBe(6100);
  });

  it('AI rungs carry a retainer — the recurring engine is not optional copy', () => {
    for (const id of ['geo-audit', 'rag-pilot', 'on-prem-ai'] as const) {
      const rung = SERVICES.find((r) => r.id === id);
      expect(rung?.retainer, `${id}: retainer missing`).toBeDefined();
      // Every retainer states its safety valve: monthly cancellation.
      expect(rung?.retainer?.terms.en.toLowerCase()).toContain('cancel any month');
    }
  });

  it('the displayed priceLine and the machine-readable priceJsonLd agree on the same number, in both languages (2026-08-22)', () => {
    // The credited-diagnostic law above (and the Offer/PriceSpecification
    // JSON-LD) both trust `priceJsonLd`, not the number a buyer actually
    // reads in `priceLine`. Nothing previously asserted those two agree —
    // priceJsonLd could drift from priceLine (or one language's priceLine
    // could drift from the other's) with every existing test staying green,
    // shipping a structured-data Offer that silently contradicts the
    // visible price.
    for (const rung of SERVICES) {
      const jsonLd = Number(
        'price' in rung.priceJsonLd ? rung.priceJsonLd.price : rung.priceJsonLd.minPrice
      );
      for (const lang of ['en', 'ru'] as const) {
        const shown = rung.priceLine[lang].replace(/[,\s]/g, '').match(/[€$](\d+)/)?.[1];
        expect(
          shown,
          `${rung.id}/${lang}: priceLine must show a currency-tagged number ("${rung.priceLine[lang]}")`
        ).toBeDefined();
        expect(
          Number(shown),
          `${rung.id}/${lang}: priceLine "${rung.priceLine[lang]}" != priceJsonLd ${jsonLd}`
        ).toBe(jsonLd);
      }
    }
  });

  it("a retainer's machine-readable floor (priceJsonLd.minPrice) agrees with its own displayed price", () => {
    // Same drift risk as above, one level down: the RETAINER's own
    // priceJsonLd.minPrice (used by serviceNode() for the retainer's Offer
    // node) must match the currency-tagged number in retainer.price.en —
    // otherwise the retainer's structured data and its visible price line
    // can silently disagree the same way the rung-level ones could.
    for (const rung of SERVICES) {
      if (!rung.retainer?.priceJsonLd) continue;
      const fromJsonLd = Number(rung.retainer.priceJsonLd.minPrice);
      const fromCopy = rung.retainer.price.en.replace(/[,\s]/g, '').match(/[€$](\d+)/)?.[1];
      expect(
        fromCopy,
        `${rung.id}: retainer.price.en must carry a currency-tagged number ("${rung.retainer.price.en}")`
      ).toBeDefined();
      expect(
        fromJsonLd,
        `${rung.id}: retainer priceJsonLd.minPrice (${fromJsonLd}) disagrees with retainer.price.en (${fromCopy})`
      ).toBe(Number(fromCopy));
    }
  });

  // PROOF_STRIP.value became Bilingual on 2026-08-24 because "1.3M" is English
  // notation — Russian writes the same quantity "1,3 млн" — and one shared
  // string put both spellings of one number on the same RU page, the strip
  // saying "1.3M" and the timeline "1,3 млн" two screens below. Converting the
  // type surfaced a second leftover: the fourth item read "self-hosted" in both
  // locales. A Bilingual field only helps if somebody fills the RU half in.
  it('never leaves an English proof value untranslated in RU', () => {
    const hasLatinWord = (s: string) => /[A-Za-z]{2,}/.test(s);
    for (const item of PROOF_STRIP) {
      if (!hasLatinWord(item.value.en)) continue; // 99/100, 3/3 — language-neutral
      expect(
        item.value.ru,
        `PROOF_STRIP "${item.label.en}": value.ru repeats the English "${item.value.en}" verbatim`
      ).not.toBe(item.value.en);
    }
  });

  it('builds correct service URLs', () => {
    expect(serviceUrl('en', 'geo-audit')).toBe('https://vkvstudio.com/en/services/geo-audit/');
    expect(serviceUrl('ru', 'websites')).toBe('https://vkvstudio.com/ru/services/websites/');
  });
});
