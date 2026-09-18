/**
 * GUARDS ON THE FACT BASE — src/data/facts.ts and src/lib/format-fact.ts.
 *
 * The base does not yet feed the site: services.ts still carries hand-typed
 * price lines, and rewriting it to read from the base touches every page, so
 * it happens with the owner present. Until then this file is what makes the
 * base worth having. It is a CHARACTERIZATION test: today's shipped copy and
 * the base's formatted output must be the same bytes. While they agree the
 * suite is silent; the moment somebody edits a price in one file and forgets
 * the other, it fails and names BOTH sides, so the message says where to fix.
 *
 * Four things are checked, in this order of importance:
 *
 * 1. PARITY WITH THE LADDER. Every price and every duration in the base is
 *    compared against services.ts — the machine-readable priceJsonLd fields
 *    AND the human strings a buyer reads. Plus the reverse direction: a euro
 *    figure or a duration that appears in the ladder and is NOT in the base
 *    fails, because that is how a number gets invented. (Scoped to the
 *    SERVICES data in memory. The whole-site scan is a separate file — see
 *    the note at the bottom of this header.)
 * 2. FORMATTERS. The thousands separator is asserted BY CODE POINT: U+00A0 in
 *    Russian, U+002C in English. Reading it by eye is exactly how a plain
 *    space gets in, and a plain space is what content-laws.test.ts fails the
 *    build for.
 * 3. BASE INTEGRITY. Every fact carries evidence (`sourceRef`) and a
 *    verification date; measurements go stale and are checked against a
 *    stated shelf life; the facts that are easiest to read too generously
 *    must say in `notClaim` what they do not assert.
 * 4. PROVISIONALITY. Every euro figure is `provisional` while the owner's
 *    pricing freeze (2026-08-24, pending bank paperwork) holds. Pinning the
 *    status here is what stops it from being quietly upgraded to
 *    `confirmed` by an agent tidying up.
 *
 * DELIBERATELY NOT HERE: the "unknown number" scan over src/** and
 * public/llms.txt (registry §6). It needs the scanner in
 * content-laws.test.ts (stripComments, joinStringConcatenation, decodeCopy)
 * lifted into a shared helper first — two scanners with two copies of the
 * normalisation drift apart, which is the failure that produced
 * helpers/content-law-patterns.ts in the first place. Separate step.
 *
 * NO LITERAL PRICE IS USED AS AN EXPECTED VALUE FOR SHIPPED COPY. A test that
 * repeats "€4,500" while checking a page string would be a third place for the
 * number to live, which is the disease the base is the cure for: every such
 * expectation below is produced by a formatter from a fact.
 *
 * The formatter's OWN unit tests are the exception, and they have to be. A test
 * that asserts money() puts no separator under a thousand must name the output
 * it expects; deriving it from the same formatter would assert nothing. Those
 * literals describe formatting behaviour, not prices — if the audit fee ever
 * changes, they stay correct, because what they pin is the shape of the string.
 * (An earlier version of this comment claimed no literals at all, which was
 * simply false — flagged by the review in .system/facts/23-facts-review.md.)
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FACTS,
  FactNotFoundError,
  allFacts,
  getFact,
  type AnyFact,
  type FixedFact,
  type RangeFact,
} from '@/data/facts';
import {
  ENGAGEMENT_TERMS,
  PROOF_STRIP,
  SERVICES,
  getRung,
  type Bilingual,
  type ServiceRetainer,
  type ServiceRung,
} from '@/data/services';
import {
  FactFormatError,
  count,
  date,
  duration,
  durationProse,
  megabytes,
  money,
  moneyFrom,
  moneyFromPerMonth,
  moneyPerMonth,
  moneyRange,
  moneyRangeProse,
  moneyRangePerMonth,
  monthYear,
  monthYearSince,
  percentSplit,
  ratio,
  responsePromise,
  score,
  utcOffset,
} from '@/lib/format-fact';

/* ------------------------------------------------------------------ tools */

/** Indexed access under `noUncheckedIndexedAccess`, with a locatable throw. */
function at<T>(list: readonly T[], index: number, what: string): T {
  const item = list[index];
  if (item === undefined) throw new Error(`facts.test.ts: ${what} has no item ${index}`);
  return item;
}

function retainerOf(id: ServiceRung['id']): ServiceRetainer {
  const retainer = getRung(id).retainer;
  if (!retainer) throw new Error(`facts.test.ts: rung "${id}" has no retainer`);
  return retainer;
}

function requiredCopy(value: Bilingual | undefined, what: string): Bilingual {
  if (!value) throw new Error(`facts.test.ts: ${what} is missing from services.ts`);
  return value;
}

const LANGS = ['en', 'ru'] as const;
type Lang = (typeof LANGS)[number];

/**
 * Both sides are named in every failure message on purpose: "expected €900 to
 * be €1,400" tells you nothing about which of the two files to edit.
 */
function expectOpensWith(actual: string, expected: string, where: string): void {
  expect(
    actual.slice(0, expected.length),
    `${where}\n  services.ts: "${actual}"\n  fact base:   "${expected}" (expected at the start)`
  ).toBe(expected);
}

function expectCarries(actual: string, expected: string, where: string): void {
  expect(
    actual,
    `${where}\n  services.ts: "${actual}"\n  fact base:   "${expected}" (expected somewhere inside)`
  ).toContain(expected);
}

/** For prose positions where the copy capitalises the formatter's output. */
function expectCarriesAnyCase(actual: string, expected: string, where: string): void {
  expect(
    actual.toLowerCase(),
    `${where}\n  services.ts: "${actual}"\n  fact base:   "${expected}" (any capitalisation)`
  ).toContain(expected.toLowerCase());
}

function expectPairCarries(actual: Bilingual, expected: Bilingual, where: string): void {
  for (const lang of LANGS) expectCarries(actual[lang], expected[lang], `${where} / ${lang}`);
}

/* --------------------------------------------------- 1. parity with the ladder */

describe('fact base ↔ service ladder — machine-readable prices', () => {
  it('every rung price node is exactly what the base holds', () => {
    const expected: Record<ServiceRung['id'], ServiceRung['priceJsonLd']> = {
      'geo-audit': { price: String(FACTS.money.geoAudit.value), currency: 'EUR' },
      'rag-pilot': { price: String(FACTS.money.ragPilot.value), currency: 'EUR' },
      'on-prem-ai': { minPrice: String(FACTS.money.onPremStarter.from), currency: 'EUR' },
      websites: {
        minPrice: String(FACTS.money.website.min),
        maxPrice: String(FACTS.money.website.max),
        currency: 'EUR',
      },
    };
    for (const rung of SERVICES) {
      expect(rung.priceJsonLd, `${rung.id}: priceJsonLd disagrees with the fact base`).toEqual(
        expected[rung.id]
      );
    }
  });

  it('every retainer price node is exactly what the base holds', () => {
    expect(retainerOf('geo-audit').priceJsonLd).toEqual({
      minPrice: String(FACTS.money.geoRetainer.from),
    });
    expect(retainerOf('rag-pilot').priceJsonLd).toEqual({
      minPrice: String(FACTS.money.ragCare.from),
    });
    expect(retainerOf('on-prem-ai').priceJsonLd).toEqual({
      minPrice: String(FACTS.money.sovereignCare.min),
      maxPrice: String(FACTS.money.sovereignCare.max),
    });
  });
});

describe('fact base ↔ service ladder — the prices a buyer reads', () => {
  it('each priceLine opens with the base figure, in both languages', () => {
    const expected: Record<ServiceRung['id'], Bilingual> = {
      'geo-audit': money(FACTS.money.geoAudit),
      'rag-pilot': money(FACTS.money.ragPilot),
      'on-prem-ai': moneyFrom(FACTS.money.onPremStarter),
      websites: moneyRange(FACTS.money.website),
    };
    for (const rung of SERVICES) {
      for (const lang of LANGS) {
        expectOpensWith(
          rung.priceLine[lang],
          expected[rung.id][lang],
          `${rung.id} / ${lang}: priceLine`
        );
      }
    }
  });

  it('the parity check is live — a one-euro, one-day drift would break it', () => {
    // A characterization test that quietly compares two empty strings passes
    // forever and protects nothing. Nudging the base by the smallest possible
    // amount must stop it matching the shipped copy; that is the proof the
    // assertions above are really reading services.ts and not agreeing with
    // themselves.
    const audit = FACTS.money.geoAudit;
    const nudgedPrice: FixedFact = { ...audit, value: audit.value + 1 };
    expect(getRung('geo-audit').priceLine.en.startsWith(money(nudgedPrice).en)).toBe(false);
    expect(getRung('geo-audit').priceLine.ru.startsWith(money(nudgedPrice).ru)).toBe(false);

    const window = FACTS.time.auditDelivery;
    const nudgedWindow: RangeFact = { ...window, max: window.max + 1 };
    expect(getRung('geo-audit').timeframe).not.toEqual(duration(nudgedWindow));
  });

  it('each retainer price line IS the formatted fact, character for character', () => {
    // These three strings contain nothing but the price, so equality is
    // available here and equality is stronger than containment: it also pins
    // the "/month" — "/месяц" suffix and the single-currency-symbol range.
    expect(retainerOf('geo-audit').price, 'geo-audit: retainer.price').toEqual(
      moneyFromPerMonth(FACTS.money.geoRetainer)
    );
    expect(retainerOf('rag-pilot').price, 'rag-pilot: retainer.price').toEqual(
      moneyFromPerMonth(FACTS.money.ragCare)
    );
    expect(retainerOf('on-prem-ai').price, 'on-prem-ai: retainer.price').toEqual(
      moneyRangePerMonth(FACTS.money.sovereignCare)
    );
  });

  it('the monitoring-only tier quotes the base figure', () => {
    expectPairCarries(
      requiredCopy(retainerOf('geo-audit').lite, 'geo-audit retainer.lite'),
      moneyPerMonth(FACTS.money.geoMonitoring),
      'geo-audit: retainer.lite'
    );
  });

  it('the audit-credit sentence quotes the audit price and the credit window', () => {
    // One sentence carrying two facts: the fee that gets credited and the
    // window it stays creditable in. Both have to move together or the offer
    // stops being the offer.
    const creditLine = at(retainerOf('geo-audit').includes, 3, 'geo-audit retainer.includes');
    expectPairCarries(creditLine, money(FACTS.money.geoAudit), 'geo-audit: audit credit');
    expectPairCarries(
      creditLine,
      duration(FACTS.time.auditCreditWindow),
      'geo-audit: audit credit window'
    );
  });

  it('the readiness-assessment saving is arithmetic on the base, not a typed-in number', () => {
    // €6,100 is not a fact — it is onPremStarter floor minus the assessment
    // fee. Typed as a literal it survives a price change and starts lying, in
    // two languages at once. Formatting the DERIVED value through the same
    // formatter is what proves the copy still adds up.
    const assessment = FACTS.money.readinessAssessment;
    const saving: FixedFact = {
      ...assessment,
      value: FACTS.money.onPremStarter.from - assessment.value,
    };
    const riskReversal = requiredCopy(
      getRung('on-prem-ai').riskReversal,
      'on-prem-ai riskReversal'
    );
    expectPairCarries(riskReversal, money(assessment), 'on-prem-ai: assessment fee');
    expectPairCarries(riskReversal, money(saving), 'on-prem-ai: saving (floor − fee)');
  });

  it('k-notation in prose resolves to the same quantity as the base range', () => {
    // The prose ranges are where the site already writes one quantity two
    // ways: "€15–25k" here, "€15 000–25 000" on the rung page. Same numbers
    // today; two literals means they will not stay that way.
    expectPairCarries(
      at(getRung('rag-pilot').deliverables, 5, 'rag-pilot deliverables'),
      moneyRangeProse(FACTS.money.ragProduction),
      'rag-pilot: production rollout range'
    );
    expectPairCarries(
      getRung('on-prem-ai').teaser,
      moneyRangeProse(FACTS.money.onPremTypical),
      'on-prem-ai: typical deployment range'
    );
  });

  it('the websites rung quotes the audit price when it references the audit', () => {
    expectPairCarries(
      at(getRung('websites').deliverables, 2, 'websites deliverables'),
      money(FACTS.money.geoAudit),
      'websites: audit checklist reference'
    );
  });

  it('SEO titles and descriptions carry the same figures as the offer', () => {
    // Sixteen hand-typed strings (4 rungs × title+description × 2 locales)
    // are the least-watched copy on the site and the first to go stale.
    const seoMoney: Record<ServiceRung['id'], Bilingual> = {
      'geo-audit': money(FACTS.money.geoAudit),
      'rag-pilot': money(FACTS.money.ragPilot),
      'on-prem-ai': moneyFrom(FACTS.money.onPremStarter),
      websites: moneyRange(FACTS.money.website),
    };
    for (const rung of SERVICES) {
      for (const lang of LANGS) {
        expectCarriesAnyCase(
          rung.seo.description[lang],
          seoMoney[rung.id][lang],
          `${rung.id} / ${lang}: seo.description`
        );
      }
    }
    // Titles quote a price only where the offer is a single figure; the
    // ranged rungs put theirs in the description alone.
    for (const id of ['geo-audit', 'rag-pilot'] as const) {
      for (const lang of LANGS) {
        expectCarriesAnyCase(
          getRung(id).seo.title[lang],
          seoMoney[id][lang],
          `${id} / ${lang}: seo.title`
        );
      }
    }
  });
});

describe('fact base ↔ service ladder — the durations a buyer reads', () => {
  it('each timeframe IS the formatted duration fact, character for character', () => {
    const expected: Record<ServiceRung['id'], Bilingual> = {
      'geo-audit': duration(FACTS.time.auditDelivery),
      'rag-pilot': duration(FACTS.time.ragPilot),
      'on-prem-ai': duration(FACTS.time.onPrem),
      websites: duration(FACTS.time.website),
    };
    for (const rung of SERVICES) {
      expect(rung.timeframe, `${rung.id}: timeframe disagrees with the fact base`).toEqual(
        expected[rung.id]
      );
    }
  });

  it('SEO descriptions carry the same delivery windows', () => {
    expectPairCarries(
      getRung('geo-audit').seo.description,
      duration(FACTS.time.auditDelivery),
      'geo-audit: seo.description window'
    );
    expectPairCarries(
      getRung('websites').seo.description,
      duration(FACTS.time.website),
      'websites: seo.description window'
    );
    // The pilot spells its number out ("Three weeks" / "Три недели"), which
    // is why durationProse exists as its own function rather than a flag.
    for (const lang of LANGS) {
      expectCarriesAnyCase(
        getRung('rag-pilot').seo.description[lang],
        durationProse(FACTS.time.ragPilot)[lang],
        `rag-pilot / ${lang}: seo.description window`
      );
    }
  });

  it('the post-launch warranty length comes from the base', () => {
    const warrantyLine = at(getRung('on-prem-ai').deliverables, 5, 'on-prem-ai deliverables');
    for (const lang of LANGS) {
      expectCarries(
        warrantyLine[lang],
        String(FACTS.time.warranty.value),
        `on-prem-ai / ${lang}: warranty length`
      );
    }
  });

  it('every response commitment uses the one sanctioned wording', () => {
    // The Russian half is not a translation choice: «в течение рабочего дня»
    // promises the same day, which one engineer cannot keep, and law 4 in
    // content-laws.test.ts fails the build for it. Checking every place the
    // promise appears keeps the base and that law pointing at one string.
    const promise = responsePromise();
    const places: readonly (readonly [string, Bilingual])[] = [
      ['geo-audit retainer.terms', retainerOf('geo-audit').terms],
      ['rag-pilot retainer.includes[2]', at(retainerOf('rag-pilot').includes, 2, 'includes')],
      ['on-prem-ai retainer.includes[2]', at(retainerOf('on-prem-ai').includes, 2, 'includes')],
      ['on-prem-ai notIncluded[1]', at(getRung('on-prem-ai').notIncluded, 1, 'notIncluded')],
      ['geo-audit deliverables[5]', at(getRung('geo-audit').deliverables, 5, 'deliverables')],
    ];
    for (const [where, copy] of places) expectPairCarries(copy, promise, where);
  });
});

describe('fact base ↔ service ladder — the rest of the shared copy', () => {
  it('the proof strip is the base, formatted', () => {
    expect(at(PROOF_STRIP, 0, 'PROOF_STRIP').value, 'proof strip: Lighthouse score').toEqual(
      score(FACTS.site.lighthouseDesktopHome)
    );
    expect(at(PROOF_STRIP, 1, 'PROOF_STRIP').value, 'proof strip: agentic checks').toEqual(
      ratio(FACTS.site.agenticChecks)
    );
    expect(at(PROOF_STRIP, 2, 'PROOF_STRIP').value, 'proof strip: units sold').toEqual(
      count(FACTS.proof.marketplaceUnits, { plus: true })
    );
  });

  it('the "without the video — 100" qualifier is the inner-page measurement', () => {
    // Two measured scores in one sentence, and the difference between them is
    // the whole point of the sentence. Either number moving alone makes it
    // false in both locales at once.
    const strip = at(PROOF_STRIP, 0, 'PROOF_STRIP');
    for (const lang of LANGS) {
      expectCarries(
        strip.qualifier[lang],
        String(FACTS.site.lighthouseDesktopInner.value),
        `proof strip / ${lang}: "without the video" score`
      );
    }
  });

  it('the engagement terms carry the split, the trading date and the offset', () => {
    expectPairCarries(
      at(ENGAGEMENT_TERMS, 0, 'ENGAGEMENT_TERMS'),
      percentSplit(FACTS.money.milestoneSplit),
      'engagement terms: milestone split'
    );
    const identity = at(ENGAGEMENT_TERMS, 3, 'ENGAGEMENT_TERMS');
    expectPairCarries(
      identity,
      monthYearSince(FACTS.legal.tradingSince),
      'engagement terms: since'
    );
    expectPairCarries(
      identity,
      utcOffset(FACTS.availability.timezoneOffset),
      'engagement terms: time zone'
    );
  });

  it('the ladder quotes the audit scope numbers from the base', () => {
    const scopeLine = at(getRung('geo-audit').deliverables, 0, 'geo-audit deliverables');
    for (const lang of LANGS) {
      expectCarries(
        scopeLine[lang],
        String(FACTS.synapse.auditPrompts.value),
        `geo-audit / ${lang}: prompt count`
      );
    }
    const pilotScope = at(getRung('rag-pilot').deliverables, 0, 'rag-pilot deliverables');
    for (const lang of LANGS) {
      expectCarries(
        pilotScope[lang],
        String(FACTS.synapse.docSourceLimit.value),
        `rag-pilot / ${lang}: document source limit`
      );
    }
    for (const id of ['rag-pilot', 'on-prem-ai'] as const) {
      const caseLabel = requiredCopy(getRung(id).caseLabel, `${id} caseLabel`);
      for (const lang of LANGS) {
        expectCarries(
          caseLabel[lang],
          String(FACTS.synapse.cores.value),
          `${id} / ${lang}: inference server cores`
        );
      }
    }
  });
});

/* ------------- 1b. the reverse direction: no figure the base does not know */

/**
 * Every human string the ladder ships, flattened. Kept local rather than
 * imported from services-data.test.ts: that file's collector deliberately
 * offers a "promises" scope that DROPS notIncluded, and dropping copy is the
 * wrong default for a scan whose whole job is to see every number.
 */
function ladderStrings(): readonly (readonly [string, string])[] {
  const out: (readonly [string, string])[] = [];
  const push = (where: string, b: Bilingual): void => {
    out.push([`${where}/en`, b.en], [`${where}/ru`, b.ru]);
  };
  for (const rung of SERVICES) {
    const at_ = (field: string) => `${rung.id}.${field}`;
    push(at_('title'), rung.title);
    push(at_('outcome'), rung.outcome);
    push(at_('priceLine'), rung.priceLine);
    push(at_('timeframe'), rung.timeframe);
    push(at_('teaser'), rung.teaser);
    rung.deliverables.forEach((d, i) => push(at_(`deliverables[${i}]`), d));
    rung.notIncluded.forEach((d, i) => push(at_(`notIncluded[${i}]`), d));
    if (rung.riskReversal) push(at_('riskReversal'), rung.riskReversal);
    if (rung.retainer) {
      push(at_('retainer.title'), rung.retainer.title);
      push(at_('retainer.price'), rung.retainer.price);
      rung.retainer.includes.forEach((d, i) => push(at_(`retainer.includes[${i}]`), d));
      push(at_('retainer.terms'), rung.retainer.terms);
      if (rung.retainer.lite) push(at_('retainer.lite'), rung.retainer.lite);
    }
    if (rung.caseLabel) push(at_('caseLabel'), rung.caseLabel);
    push(at_('seo.title'), rung.seo.title);
    push(at_('seo.description'), rung.seo.description);
  }
  PROOF_STRIP.forEach((item, i) => {
    push(`PROOF_STRIP[${i}].value`, item.value);
    push(`PROOF_STRIP[${i}].label`, item.label);
    push(`PROOF_STRIP[${i}].qualifier`, item.qualifier);
  });
  ENGAGEMENT_TERMS.forEach((term, i) => push(`ENGAGEMENT_TERMS[${i}]`, term));
  return out;
}

/** Every number a fact holds, whatever shape the fact uses to hold it. */
function quantitiesOf(fact: AnyFact): readonly number[] {
  if ('value' in fact) return [fact.value];
  if ('from' in fact) return [fact.from];
  if ('min' in fact) return [fact.min, fact.max];
  if ('parts' in fact) return [...fact.parts];
  return [];
}

function quantitiesIn(domain: keyof typeof FACTS, units: readonly string[]): Set<number> {
  const out = new Set<number>();
  for (const [key, fact] of allFacts()) {
    if (!key.startsWith(`${domain}.`)) continue;
    if (!('unit' in fact) || !units.includes(fact.unit)) continue;
    for (const n of quantitiesOf(fact)) out.add(n);
  }
  return out;
}

/**
 * A digit-group separator is only a separator when exactly three digits
 * follow it — that is what keeps "€900, 5–10 business days" from reading as
 * nine hundred thousand and five. A plain ASCII space is accepted here on
 * purpose even though Russian must use U+00A0: the scan has to SEE a
 * wrongly-typed price in order to check it against the base, and whether the
 * character is the right one is the separate job of the code-point test.
 */
const EURO_NUMBER = String.raw`(?:\d{1,3}(?:[,\u00A0 ]\d{3})+|\d+)`;

/**
 * `k` binds to BOTH ends of a range: "€15–25k" is fifteen to twenty-five
 * thousand, not fifteen euros to twenty-five thousand.
 */
function euroAmountsIn(text: string): readonly number[] {
  const pattern = new RegExp(`€\\s?(${EURO_NUMBER})(k?)(?:–(${EURO_NUMBER})(k?))?`, 'g');
  const out: number[] = [];
  const scale = (raw: string, thousands: boolean): number =>
    Number(raw.replace(/[,\s\u00A0]/g, '')) * (thousands ? 1000 : 1);
  for (const m of text.matchAll(pattern)) {
    const [, low, kLow, high, kHigh] = m;
    if (low === undefined) continue;
    const thousands = kLow === 'k' || kHigh === 'k';
    out.push(scale(low, thousands));
    if (high !== undefined) out.push(scale(high, thousands));
  }
  return out;
}

/**
 * A number is only read as a duration when a UNIT WORD from a closed list
 * follows it. That closed list is the entire defence against false positives:
 * years ("2026 года"), versions ("Astro 6"), counts ("20 prompts", "500
 * pages") and the "24/7" the site names to refuse it all carry digits and
 * none of them carry one of these words.
 */
function durationsIn(text: string): readonly number[] {
  const en =
    /(\d+)(?:–(\d+))?[\s -](?:business|working)?[\s -]?(?:days?|weeks?|months?|minutes?|seconds?)\b/gi;
  const ru =
    /(\d+)(?:–(\d+))?[\s -](?:рабочих[\s ]+)?(?:дн[а-яё]+|недел[а-яё]+|месяц[а-яё]*|минут[а-яё]*|секунд[а-яё]*)/gi;
  const out: number[] = [];
  for (const pattern of [en, ru]) {
    for (const m of text.matchAll(pattern)) {
      const [, low, high] = m;
      if (low !== undefined) out.push(Number(low));
      if (high !== undefined) out.push(Number(high));
    }
  }
  return out;
}

describe('the ladder states no figure the fact base does not hold', () => {
  it('every euro amount in the ladder is a base amount (or arithmetic on two of them)', () => {
    const known = quantitiesIn('money', ['EUR', 'EURPerMonth']);
    // The one derived amount the copy states: what a buyer saves by taking
    // the readiness assessment instead of the deployment. Registry §3 item 1.
    known.add(FACTS.money.onPremStarter.from - FACTS.money.readinessAssessment.value);
    const strays = ladderStrings().flatMap(([where, text]) =>
      euroAmountsIn(text)
        .filter((n) => !known.has(n))
        .map((n) => `${where}: €${n} — "${text}"`)
    );
    expect(
      strays,
      'euro amounts in services.ts with no fact behind them — add the fact, or fix the copy'
    ).toEqual([]);
  });

  it('every duration in the ladder is a base duration', () => {
    const known = quantitiesIn('time', [
      'businessDays',
      'days',
      'weeks',
      'months',
      'minutes',
      'seconds',
    ]);
    const strays = ladderStrings().flatMap(([where, text]) =>
      durationsIn(text)
        .filter((n) => !known.has(n))
        .map((n) => `${where}: ${n} — "${text}"`)
    );
    expect(
      strays,
      'durations in services.ts with no fact behind them — add the fact, or fix the copy'
    ).toEqual([]);
  });

  it('the scanners actually see the figures they are meant to police', () => {
    // A scan that silently matches nothing passes forever. These pin the
    // scanners against the notations the site really uses, so a regex edit
    // that quietly stops matching fails here instead of going unnoticed.
    expect(euroAmountsIn('€900 · fixed')).toEqual([900]);
    expect(euroAmountsIn('от €7 500 · старт')).toEqual([7500]);
    expect(euroAmountsIn('€3,500–5,500 · fixed scope')).toEqual([3500, 5500]);
    expect(euroAmountsIn('€3 500–5 500 · скоуп')).toEqual([3500, 5500]);
    expect(euroAmountsIn('run €15–25k as node count')).toEqual([15000, 25000]);
    expect(euroAmountsIn('€900, 5–10 business days, no call')).toEqual([900]);
    expect(euroAmountsIn('a GPT-4 price and 24/7 cover')).toEqual([]);
    expect(durationsIn('5–10 business days')).toEqual([5, 10]);
    expect(durationsIn('5–10 рабочих дней')).toEqual([5, 10]);
    expect(durationsIn('a 30-day post-launch warranty')).toEqual([30]);
    expect(durationsIn('30-дневная гарантия после запуска')).toEqual([30]);
    expect(durationsIn('в течение 30 дней после аудита')).toEqual([30]);
    // The three shapes that must NOT read as durations.
    expect(durationsIn('€1 500–3 000/месяц')).toEqual([]);
    expect(durationsIn('€600/month, no lock-in')).toEqual([]);
    expect(durationsIn('в Армении с февраля 2026 года')).toEqual([]);
    expect(durationsIn('20 buyer-intent prompts, up to 500 pages')).toEqual([]);
  });
});

/* ------------------------------------------------------------ 2. formatters */

/** The separator between two digit groups, as a code point, not as a glyph. */
function separatorCodePoint(formatted: string): number {
  const match = formatted.match(/\d(\D)\d{3}/);
  if (!match?.[1]) throw new Error(`facts.test.ts: no digit group separator in "${formatted}"`);
  return match[1].codePointAt(0) ?? -1;
}

const NBSP_CODE = 0x00a0;
const COMMA_CODE = 0x002c;
const SPACE_CODE = 0x0020;
const EN_DASH_CODE = 0x2013;

describe('formatters — the thousands separator, by code point', () => {
  it('Russian groups digits with U+00A0 and English with a comma', () => {
    // Checked as code points because this is precisely the difference no
    // reviewer can see: U+00A0 and U+0020 render identically, and the plain
    // space is what content-laws.test.ts fails the build for.
    const cases: readonly Bilingual[] = [
      money(FACTS.money.ragPilot),
      moneyFrom(FACTS.money.onPremStarter),
      moneyRange(FACTS.money.website),
      moneyFromPerMonth(FACTS.money.geoRetainer),
      moneyRangePerMonth(FACTS.money.sovereignCare),
    ];
    for (const pair of cases) {
      expect(separatorCodePoint(pair.ru), `RU separator in "${pair.ru}"`).toBe(NBSP_CODE);
      expect(separatorCodePoint(pair.en), `EN separator in "${pair.en}"`).toBe(COMMA_CODE);
    }
  });

  it('a Russian price never contains a plain space between digit groups', () => {
    for (const [key, fact] of allFacts()) {
      if (!('unit' in fact)) continue;
      if (fact.unit !== 'EUR' && fact.unit !== 'EURPerMonth') continue;
      for (const n of quantitiesOf(fact)) {
        if (n < 1000) continue;
        const grouped = money({ ...FACTS.money.geoAudit, value: n, unit: 'EUR' }).ru;
        expect(grouped.codePointAt(grouped.indexOf(' ')), `${key}: "${grouped}"`).not.toBe(
          SPACE_CODE
        );
      }
    }
  });

  it('amounts under a thousand get no separator at all', () => {
    expect(money(FACTS.money.geoAudit)).toEqual({ en: '€900', ru: '€900' });
    expect(moneyPerMonth(FACTS.money.geoMonitoring).ru).not.toMatch(/\s/);
  });

  it('the large-count suffix carries its own separator rules', () => {
    // The pair that made ProofItem.value bilingual: decimal mark AND
    // magnitude word differ, and Russian sets the word off with U+00A0.
    const units = count(FACTS.proof.marketplaceUnits, { plus: true });
    expect(units.en).toMatch(/^\d+\.\d+M\+$/);
    expect(units.ru).toMatch(/^\d+,\d+ млн\+$/);
    expect(units.ru.codePointAt(units.ru.indexOf('млн') - 1)).toBe(NBSP_CODE);
    expect(count(FACTS.proof.marketplaceUnits).en).not.toContain('+');
  });

  it('a fractional measurement swaps the decimal mark, not the separator', () => {
    const size = megabytes(FACTS.site.heroVideoBytes);
    expect(size.en).toMatch(/^\d+\.\d+ MB$/);
    expect(size.ru).toMatch(/^\d+,\d+ МБ$/);
  });
});

describe('formatters — ranges, floors and the prose form', () => {
  it('a range prints one currency symbol and an en dash', () => {
    const range = moneyRange(FACTS.money.website);
    for (const lang of LANGS) {
      expect(
        [...range[lang]].filter((c) => c === '€'),
        `${lang}: "${range[lang]}"`
      ).toHaveLength(1);
      const dash = range[lang].match(/\d(\D)\d/g)?.find((s) => !/\d[, ]\d/.test(s));
      expect(dash?.codePointAt(1), `${lang}: range dash in "${range[lang]}"`).toBe(EN_DASH_CODE);
    }
  });

  it('a floor is prefixed, not suffixed, and the prefix is translated', () => {
    const floor = moneyFrom(FACTS.money.onPremStarter);
    expect(floor.en.startsWith('from ')).toBe(true);
    expect(floor.ru.startsWith('от ')).toBe(true);
    const monthly = moneyFromPerMonth(FACTS.money.geoRetainer);
    expect(monthly.en.startsWith('from ')).toBe(true);
    expect(monthly.en.endsWith('/month')).toBe(true);
    expect(monthly.ru.startsWith('от ')).toBe(true);
    expect(monthly.ru.endsWith('/месяц')).toBe(true);
  });

  it('k-notation is identical in both locales and stays a separate function', () => {
    // Identical because no thousands separator ever appears in it — which is
    // also why it must never be reachable through a flag on money(): the one
    // notation that looks locale-safe is the one that must not be a headline
    // price (services.ts header, price-notation law).
    const compact = moneyRangeProse(FACTS.money.onPremTypical);
    expect(compact.en).toBe(compact.ru);
    expect(compact.en).toMatch(/^€\d+–\d+k$/);
    // A range that is not in whole thousands has no honest compact form.
    expect(() => moneyRangeProse(FACTS.money.website)).toThrow(FactFormatError);
  });

  it('refuses a fact handed to the wrong formatter', () => {
    // A monthly fee rendered as a one-off price is a wrong number that looks
    // right. The unit guard is what turns that into a loud failure.
    expect(() => money(FACTS.money.geoMonitoring)).toThrow(FactFormatError);
    expect(() => moneyPerMonth(FACTS.money.geoAudit)).toThrow(FactFormatError);
    expect(() => duration(FACTS.money.geoAudit)).toThrow(FactFormatError);
    expect(() => score(FACTS.site.agenticChecks)).toThrow(FactFormatError);
    expect(() => megabytes(FACTS.site.a11yScore)).toThrow(FactFormatError);
  });
});

describe('formatters — durations agree with Russian grammar', () => {
  it('the Russian noun agrees with the upper bound of a range', () => {
    // Without agreement by the UPPER bound you get «5–10 рабочих день».
    expect(duration(FACTS.time.auditDelivery).ru).toMatch(/рабочих дней$/);
    expect(duration(FACTS.time.onPrem).ru).toMatch(/недель$/);
    expect(duration(FACTS.time.website).ru).toMatch(/недель$/);
    expect(duration(FACTS.time.ragPilot).ru).toMatch(/недели$/);
    expect(duration(FACTS.time.warranty).ru).toMatch(/дней$/);
    expect(duration(FACTS.time.introCall).ru).toMatch(/минут$/);
  });

  it('English pluralises on the count, and a range is always plural', () => {
    expect(duration(FACTS.time.auditDelivery).en).toMatch(/business days$/);
    expect(duration(FACTS.time.orderConfirmation).en).toMatch(/^1 business day$/);
    expect(duration(FACTS.time.ragPilot).en).toMatch(/^3 weeks$/);
  });

  it('the prose form spells out one to three and leaves four and up as digits', () => {
    // Not a style preference — it is what the shipped SEO copy already does,
    // and the migration must reproduce the copy byte for byte.
    expect(durationProse(FACTS.time.ragPilot)).toEqual({ en: 'three weeks', ru: 'три недели' });
    expect(durationProse(FACTS.time.onPrem)).toEqual(duration(FACTS.time.onPrem));
    expect(durationProse(FACTS.time.warranty)).toEqual(duration(FACTS.time.warranty));
  });

  it('the response promise names ONE business day in Russian', () => {
    // «в течение рабочего дня» is a same-day promise, which is a different
    // and unkeepable commitment. The word «одного» is the whole point.
    expect(responsePromise().ru).toContain('одного');
    expect(responsePromise().en).toBe('within one business day');
  });
});

describe('formatters — scores, splits, offsets and dates', () => {
  it('a score is language-neutral and asserts its denominator', () => {
    expect(score(FACTS.site.lighthouseDesktopHome)).toEqual({ en: '99/100', ru: '99/100' });
    expect(ratio(FACTS.site.agenticChecks)).toEqual({ en: '3/3', ru: '3/3' });
    expect(() => score(FACTS.site.cls)).toThrow(FactFormatError);
  });

  it('the milestone split prints as the contract states it', () => {
    const split = percentSplit(FACTS.money.milestoneSplit);
    expect(split.en).toBe(split.ru);
    expect(split.en.split('/').map(Number)).toEqual([...FACTS.money.milestoneSplit.parts]);
  });

  it('the milestone split adds up to a whole engagement', () => {
    // Nothing anywhere checked this. A split that sums to 90 or 110 would
    // have shipped in eight files at once.
    const total = FACTS.money.milestoneSplit.parts.reduce((sum, part) => sum + part, 0);
    expect(total, 'milestone percentages must sum to 100').toBe(100);
  });

  it('the offset prints as the site names it', () => {
    expect(utcOffset(FACTS.availability.timezoneOffset)).toEqual({ en: 'GMT+4', ru: 'GMT+4' });
  });

  it('dates use the Russian case the position requires', () => {
    // Genitive after a day number and after «с»; nominative standing alone.
    // A caller cannot fix the case by gluing a preposition onto monthYear().
    expect(date(FACTS.legal.registeredOn)).toEqual({
      en: '12 February 2026',
      ru: '12 февраля 2026',
    });
    expect(monthYear(FACTS.legal.tradingSince).ru).toMatch(/^февраль /);
    expect(monthYearSince(FACTS.legal.tradingSince)).toEqual({
      en: 'since February 2026',
      ru: 'с февраля 2026',
    });
    // A month-precision source has no day to print, and must not invent one.
    expect(() => date(FACTS.legal.tradingSince)).toThrow(FactFormatError);
  });
});

/* -------------------------------------------------------- 3. base integrity */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How long a measured number may stand before it must be measured again. A
 * Lighthouse score is the fact most likely to be true when written and false
 * six months later; the price of the rule is a test that eventually asks for
 * a re-run, which is the intended cost, not a bug.
 */
const MEASUREMENT_SHELF_LIFE_DAYS = 180;

function ageInDays(verifiedAt: string): number {
  return (Date.now() - Date.parse(verifiedAt)) / DAY_MS;
}

describe('fact base — every fact carries its evidence', () => {
  it('is not empty and every key is reachable through the index', () => {
    const declared = Object.values(FACTS).reduce((n, group) => n + Object.keys(group).length, 0);
    expect(allFacts()).toHaveLength(declared);
    expect(declared).toBeGreaterThan(40);
    expect(new Set(allFacts().map(([key]) => key)).size, 'duplicate dotted key').toBe(declared);
  });

  it('a missing key throws instead of returning undefined', () => {
    // Same stance as getRung(): under noUncheckedIndexedAccess a silent
    // undefined becomes "€undefined" in shipped copy.
    expect(() => getFact('money.thereIsNoSuchFact')).toThrow(FactNotFoundError);
    expect(getFact('money.geoAudit')).toBe(FACTS.money.geoAudit);
  });

  it('states a source, a path to the evidence and a verification date', () => {
    for (const [key, fact] of allFacts()) {
      expect(fact.label.en.trim(), `${key}: empty EN label`).not.toBe('');
      expect(fact.label.ru.trim(), `${key}: empty RU label`).not.toBe('');
      expect(fact.sourceRef, `${key}: sourceRef must point at a file`).toMatch(
        /(src\/|public\/|\.system\/|astro\.config)/
      );
      expect(fact.verifiedAt, `${key}: verifiedAt must be an ISO day`).toMatch(
        /^\d{4}-\d{2}-\d{2}$/
      );
      expect(
        ageInDays(fact.verifiedAt),
        `${key}: verifiedAt is in the future`
      ).toBeGreaterThanOrEqual(0);
    }
  });

  it('keeps measured numbers inside their shelf life', () => {
    const stale = allFacts()
      .filter(([, fact]) => fact.source === 'measurement')
      .filter(([, fact]) => ageInDays(fact.verifiedAt) > MEASUREMENT_SHELF_LIFE_DAYS)
      .map(([key, fact]) => `${key} (verified ${fact.verifiedAt}, ${fact.sourceRef})`);
    expect(
      stale,
      `measurements older than ${MEASUREMENT_SHELF_LIFE_DAYS} days — re-run the measurement and ` +
        'update verifiedAt, or drop the fact. A stale measurement published as a current one is ' +
        'the exact failure this base exists to prevent'
    ).toEqual([]);
  });

  it('says what it does NOT assert, and does not merely restate the label', () => {
    for (const [key, fact] of allFacts()) {
      for (const lang of LANGS) {
        expect(fact.notClaim[lang].trim(), `${key} / ${lang}: empty notClaim`).not.toBe('');
        expect(
          fact.notClaim[lang].trim().length,
          `${key} / ${lang}: notClaim is too short to limit anything`
        ).toBeGreaterThan(20);
        expect(
          fact.notClaim[lang].trim(),
          `${key} / ${lang}: notClaim just repeats the label`
        ).not.toBe(fact.label[lang].trim());
      }
    }
  });

  it('names the specific over-reading each easily-stretched fact invites', () => {
    // A generic "not a guarantee" would satisfy the previous test while
    // leaving the actual trap open. These are the facts an agent or a
    // marketer will read too generously; the guard names the reading.
    const guards: readonly (readonly [string, RegExp])[] = [
      // "99 on a local production build" must never become "99 live".
      ['site.lighthouseDesktopHome', /not the live site/i],
      // Two pages measured, not the whole site.
      ['site.lighthouseDesktopInner', /only|not on every page/i],
      // A Lighthouse number is not a conformance statement for an EU buyer.
      ['site.a11yScore', /wcag|301 549/i],
      // One run, not a median — the number moves between runs.
      ['site.lighthouseMobileEn', /single run/i],
      ['site.lighthouseMobileRu', /single run/i],
      // Units of goods in someone else's shop, not turnover, not ours.
      ['proof.marketplaceUnits', /not turnover/i],
      // The state register entry, not years of experience.
      ['legal.tradingSince', /not years in the profession/i],
      // Registry numbers stay unpublished — the standing owner rule.
      ['legal.registeredOn', /numbers are never published/i],
      // A service that exists as one sentence inside another rung's copy.
      ['money.readinessAssessment', /no such service/i],
      // The floor is not the price.
      ['money.geoRetainer', /floor, not a ceiling/i],
    ];
    for (const [key, guard] of guards) {
      expect(getFact(key).notClaim.en, `${key}: notClaim must name the over-reading`).toMatch(
        guard
      );
    }
  });
});

describe('fact base — shapes that would otherwise fail silently', () => {
  it('every range runs upward', () => {
    for (const [key, fact] of allFacts()) {
      if (!('min' in fact)) continue;
      expect(fact.min, `${key}: min ${fact.min} is not below max ${fact.max}`).toBeLessThan(
        fact.max
      );
    }
  });

  it('every quantity is a finite, non-negative number', () => {
    for (const [key, fact] of allFacts()) {
      for (const n of quantitiesOf(fact)) {
        expect(Number.isFinite(n), `${key}: ${n} is not a finite number`).toBe(true);
        expect(n, `${key}: negative quantity`).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('euro units live only in the money domain', () => {
    // A price filed under `site` or `synapse` is a price nobody reviewing
    // prices would ever look at.
    for (const [key, fact] of allFacts()) {
      if (!('unit' in fact)) continue;
      if (fact.unit !== 'EUR' && fact.unit !== 'EURPerMonth') continue;
      expect(key.startsWith('money.'), `${key}: a euro amount outside money.*`).toBe(true);
    }
  });

  it('a score never exceeds its own denominator', () => {
    for (const [key, fact] of allFacts()) {
      if (!('outOf' in fact) || fact.outOf === undefined) continue;
      if (!('value' in fact)) continue;
      expect(fact.value, `${key}: ${fact.value} out of ${fact.outOf}`).toBeLessThanOrEqual(
        fact.outOf
      );
    }
  });
});

/* ------------------------------------------------------ 4. provisionality */

describe('fact base — the pricing freeze is visible in the type', () => {
  it('every euro figure is provisional while the freeze holds', () => {
    // Owner decision 2026-08-24: all pricing waits on bank paperwork. The
    // status is the freeze made machine-readable. If the freeze is lifted,
    // this test is the deliberate place that has to be edited — which is the
    // point: a price cannot quietly become "confirmed".
    const confirmed = allFacts()
      .filter(([, fact]) => 'unit' in fact && (fact.unit === 'EUR' || fact.unit === 'EURPerMonth'))
      .filter(([, fact]) => fact.status !== 'provisional')
      .map(([key, fact]) => `${key} (${fact.status})`);
    expect(
      confirmed,
      'euro amounts marked anything other than provisional — the owner froze pricing on ' +
        '2026-08-24 pending bank paperwork, and nothing has recorded him lifting it'
    ).toEqual([]);
  });

  it('a research recommendation only ever hangs off a provisional fact', () => {
    // `recommended` is reading material, never a value. Attached to a
    // confirmed fact it would read as a pending change to something settled.
    for (const [key, fact] of allFacts()) {
      if (fact.recommended === undefined) continue;
      expect(fact.status, `${key}: recommendation on a confirmed fact`).toBe('provisional');
      expect(fact.recommended.ref.trim(), `${key}: recommendation without a source`).not.toBe('');
      for (const lang of LANGS) {
        expect(
          fact.recommended.note[lang].trim(),
          `${key} / ${lang}: empty recommendation`
        ).not.toBe('');
      }
    }
  });

  it('no recommended figure has leaked into a value', () => {
    // The specific accident this guards: an agent reading "€1,400 fixed" in
    // `recommended` and helpfully updating `value` to match. The base's
    // number must keep agreeing with services.ts, which the parity block
    // above proves; here we only assert the two fields stay distinguishable.
    const geoAudit = FACTS.money.geoAudit;
    expect(geoAudit.recommended?.note.en, 'geo-audit recommendation lost').toBeDefined();
    expect(
      geoAudit.recommended?.note.en.includes(money(geoAudit).en),
      'the geo-audit recommendation now quotes the current price — either the freeze was lifted ' +
        'without recording it, or a recommendation was promoted into the value'
    ).toBe(false);
  });

  it('a measured number that moves on the next run is not called confirmed', () => {
    // The mobile scores are single runs; the registry marks them provisional
    // for that reason. Losing the mark would let one lucky run be quoted.
    expect(FACTS.site.lighthouseMobileEn.status).toBe('provisional');
    expect(FACTS.site.lighthouseMobileRu.status).toBe('provisional');
    expect(FACTS.synapse.firstTokenSeconds.status).toBe('provisional');
    expect(FACTS.synapse.fullAnswerSeconds.status).toBe('provisional');
  });
  // The research recommendations now live in src/data/, one import away from a
  // page. Nothing stops a future edit from rendering `.recommended` next to a
  // real price — and those figures are NOT approved: the owner froze money
  // decisions on 2026-08-24 until the bank paperwork lands. A price he never
  // agreed to, shipped because it sat in the same object as one he did, is
  // exactly the failure this base exists to prevent. Flagged as D9 in
  // .system/facts/23-facts-review.md.
  //
  // Checking the NUMBERS was tried first and produced only false positives: a
  // recommendation for one rung often names a figure that is another rung's
  // current, approved price (the €2,000 retainer, the €7,500 on-prem floor).
  // What actually matters is not the digits — it is whether any shipped file
  // reaches for the field at all. So the guard reads the source tree.
  it('no shipped file reads the .recommended field', () => {
    const roots = ['src', 'public'];
    const offenders: string[] = [];

    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules') continue;
          walk(full);
          continue;
        }
        // facts.ts declares the field; format-fact.ts is asserted below never
        // to touch it. Everything else has no business knowing it exists.
        const rel = full.replace(/\\/g, '/');
        if (rel.endsWith('src/data/facts.ts')) continue;
        if (!/\.(ts|tsx|astro|svelte|js|mjs|txt|json)$/.test(rel)) continue;
        const text = readFileSync(full, 'utf8');
        if (/\.recommended\b/.test(text) || /\brecommended\s*\?\./.test(text)) {
          offenders.push(rel);
        }
      }
    };
    for (const root of roots) walk(root);

    expect(
      offenders,
      'a shipped file reads .recommended — those figures are the pricing research, ' +
        'not prices the owner approved (freeze of 2026-08-24)'
    ).toEqual([]);
  });

  it('the formatters cannot be handed a recommendation', () => {
    // The other half of the same guard: even if a page got hold of the object,
    // the formatter must not turn it into a price string.
    const formatter = readFileSync('src/lib/format-fact.ts', 'utf8');
    expect(
      /\brecommended\b/.test(formatter),
      'format-fact.ts mentions `recommended` — the formatters must only ever ' +
        'read approved values'
    ).toBe(false);
  });
});
