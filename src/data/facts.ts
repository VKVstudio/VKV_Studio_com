/**
 * THE FACT BASE — one place where every number the site states about itself
 * is written down once, with the evidence that makes it a fact.
 *
 * Why this file exists: prices, delivery windows and measured scores live
 * today as hand-typed literals scattered across ~12 files and two locales.
 * A number typed twice is a number that will one day disagree with itself —
 * two of them already do (`€15–25k` vs `€15 000–25 000`, `€10–20k` vs
 * `€10 000–20 000`). Copy stays free to rephrase; the quantity underneath
 * stops being a guess an agent can improvise.
 *
 * SCOPE OF THIS FILE, deliberately narrow (2026-08-24):
 *   - It imports nothing at runtime and is imported by nothing yet. It sits
 *     UNDER services.ts: services.ts may one day read numbers from here, and
 *     the reverse import must never exist, or Vite silently resolves a cycle
 *     and hands `undefined` to one side. The one import below is `import
 *     type`, erased at build time, so no runtime edge is created.
 *   - Every value here was read out of the source it cites, not copied from a
 *     report. `sourceRef` is the proof; a fact without one is an opinion.
 *
 * WHAT IS NOT HERE, and why (each of these was considered and rejected):
 *   - Recommended prices from market research. They live in `recommended`,
 *     purely for the reader, and no formatter ever reads that field. The
 *     owner froze pricing decisions on 2026-08-24 pending bank paperwork;
 *     promoting a recommendation to `value` would decide for him.
 *   - Anything whose answer is still open: the retainer slot count
 *     ("Limited slots", no number), the readiness-assessment credit window.
 *     (VAT wording was unified site-wide 2026-09-06 — no VAT charged, the
 *     buyer self-accounts under the reverse charge; accountant sign-off
 *     still pending.) A fact with an unknown value is a question, not a fact.
 *   - Other vendors' model prices (src/lib/prompt/builder.ts). Real, correct,
 *     in dollars, and not the studio's. The base owns only what the studio
 *     charges.
 *   - "Last updated" dates for pages. Those are facts about a file, and are
 *     derived at build time from git the way astro.config.mjs already derives
 *     sitemap `lastmod`. Only dates that are facts about the world live here.
 *   - Registration/tax numbers and bank details. Standing owner rule after a
 *     past incident; enforced by tests/unit/content-laws.test.ts.
 *
 * Currency is NOT a field. `unit: 'EUR'` already carries it. A separate
 * `currency` property would be a second place for the currency to drift —
 * exactly the failure this file exists to remove.
 */

import type { Bilingual } from '@/data/services';

/**
 * Units are a closed set so a formatter can refuse to print a duration as
 * money. 'EUR' and 'EURPerMonth' are separate units rather than one unit
 * plus a "recurring" flag, because the two render differently in both
 * locales and the difference must survive into the type.
 */
export type FactUnit =
  | 'EUR'
  | 'EURPerMonth'
  | 'businessDays'
  | 'days'
  | 'weeks'
  | 'months'
  | 'minutes'
  | 'seconds'
  | 'milliseconds'
  | 'percent'
  | 'score'
  | 'count'
  | 'megabytes'
  | 'utcOffsetHours'
  /** Dimensionless — Cumulative Layout Shift is a ratio, not a score. */
  | 'ratio';

/** Where the fact is known from — how it would be re-verified, not who said it. */
export type FactSource = 'contract' | 'registry' | 'measurement' | 'code' | 'ownerStatement';

/**
 * Provisional is marked in the type rather than in a comment: a price waiting
 * on the bank and on a market review (owner, 2026-08-24) must not look in code
 * exactly like a registration date taken from a state register.
 */
export type FactStatus = 'confirmed' | 'provisional';

export type IsoDay = `${number}-${number}-${number}`;
export type IsoMonth = `${number}-${number}`;

interface FactMetaBase {
  readonly label: Bilingual;
  readonly source: FactSource;
  /** Path to the evidence: `src/...:NN` or `.system/...`. Read, not assumed. */
  readonly sourceRef: string;
  readonly verifiedAt: IsoDay;
  /**
   * What the fact does NOT assert. The most load-bearing field here: it is
   * what stops "99 on desktop, local build" being rewritten as "100 on the
   * live site" by the next hand that touches the copy.
   */
  readonly notClaim: Bilingual;
  readonly status: FactStatus;
  /**
   * Market-research recommendation, FOR READING ONLY. No formatter reads it,
   * and nothing renders it. Present only where research actually issued one.
   */
  readonly recommended?: { readonly note: Bilingual; readonly ref: string };
}

interface QuantityMeta extends FactMetaBase {
  readonly unit: FactUnit;
  /** Denominator for scores and ratios: 100 for Lighthouse, 3 for "3 of 3". */
  readonly outOf?: number;
}

/**
 * Four value shapes, told apart by STRUCTURE rather than by a string tag —
 * the same discrimination `priceJsonLd` already uses in services.ts, so a
 * formatter branches on `'value' in f` with no runtime fallback. A single
 * interface with four optional fields would compile for an object carrying
 * no number at all; this will not.
 */
export type FixedFact = QuantityMeta & { readonly value: number };
export type FromFact = QuantityMeta & { readonly from: number };
export type RangeFact = QuantityMeta & { readonly min: number; readonly max: number };
export type SplitFact = QuantityMeta & { readonly parts: readonly number[] };
export type Fact = FixedFact | FromFact | RangeFact | SplitFact;

/**
 * A date that is a fact about the world (a state register entry), never a
 * fact about a file. `precision` exists because the site states the same
 * registration two ways — a full date on /privacy/, a month elsewhere — and
 * a formatter must not invent a day the source never gave.
 */
export type DateFact = FactMetaBase & {
  readonly iso: IsoDay | IsoMonth;
  readonly precision: 'day' | 'month';
};

/**
 * A fact that is definite but not a quantity: the liability cap, the
 * governing-law option, the entity form. These are exactly the claims an
 * assistant invents detail for when nobody wrote them down. Vague praise
 * ("fast", "world-class") is still not admissible here — only statements
 * with a checkable source.
 */
export type StatedFact = FactMetaBase & { readonly text: Bilingual };

/** A fact whose whole content is that something does or does not exist. */
export type FlagFact = FactMetaBase & { readonly flag: boolean };

export type AnyFact = Fact | DateFact | StatedFact | FlagFact;

/** Thrown by getFact() — a missing key is a data bug, not a runtime maybe. */
export class FactNotFoundError extends Error {
  constructor(key: string) {
    super(`facts.ts: no fact at "${key}"`);
    this.name = 'FactNotFoundError';
  }
}

interface FactBook {
  readonly money: {
    readonly geoAudit: FixedFact;
    readonly geoRetainer: FromFact;
    readonly geoMonitoring: FixedFact;
    readonly ragPilot: FixedFact;
    readonly ragProduction: RangeFact;
    readonly ragCare: FromFact;
    readonly onPremStarter: FromFact;
    readonly onPremTypical: RangeFact;
    readonly readinessAssessment: FixedFact;
    readonly sovereignCare: RangeFact;
    readonly website: RangeFact;
    readonly milestoneSplit: SplitFact;
    readonly auditCreditShare: FixedFact;
  };
  readonly time: {
    readonly auditDelivery: RangeFact;
    readonly orderConfirmation: FixedFact;
    readonly ragPilot: FixedFact;
    readonly onPrem: RangeFact;
    readonly website: RangeFact;
    readonly responsePromise: FixedFact;
    readonly warranty: FixedFact;
    readonly auditCreditWindow: FixedFact;
    readonly introCall: FixedFact;
    readonly chatRetention: FixedFact;
  };
  readonly legal: {
    readonly registeredOn: DateFact;
    readonly tradingSince: DateFact;
    readonly entityForm: StatedFact;
    readonly liabilityCap: StatedFact;
    readonly professionalIndemnity: FlagFact;
    readonly contractLaw: StatedFact;
    readonly ndaScope: StatedFact;
  };
  readonly availability: {
    readonly timezoneOffset: FixedFact;
    readonly cancellation: StatedFact;
    readonly headcount: FixedFact;
  };
  readonly site: {
    readonly lighthouseDesktopHome: FixedFact;
    readonly lighthouseDesktopInner: FixedFact;
    readonly a11yScore: FixedFact;
    readonly cls: FixedFact;
    readonly tbt: FixedFact;
    readonly agenticChecks: FixedFact;
    readonly lighthouseMobileEn: FixedFact;
    readonly lighthouseMobileRu: FixedFact;
    readonly locales: FixedFact;
    readonly heroVideoBytes: FixedFact;
  };
  readonly proof: {
    readonly marketplaceUnits: FixedFact;
  };
  readonly synapse: {
    readonly cores: FixedFact;
    readonly firstTokenSeconds: FixedFact;
    readonly fullAnswerSeconds: RangeFact;
    readonly embeddingDims: FixedFact;
    readonly docSourceLimit: FixedFact;
    readonly auditPrompts: FixedFact;
    readonly auditEngines: FixedFact;
    readonly retainerFixes: RangeFact;
    readonly namedCompetitors: RangeFact;
  };
}

/** Shared ref for every research recommendation quoted in `recommended`. */
const S6 = '.system/research/s6-correlated.md:58–73';

/**
 * Grouped by DOMAIN, not by page and not by ladder rung. By page fails on the
 * first fact: €900 appears in eleven files, so a key named after one page
 * lies about the other ten. By rung fails too — the response promise, the
 * milestone split and the registration date belong to no rung, and the
 * "shared" bucket they would need is where everything eventually gets
 * dumped. Domain is the only split where each fact has exactly one home, and
 * it matches how facts are re-verified: money by the bank and the contract,
 * time by the contract, legal by the register, site by a Lighthouse run.
 */
export const FACTS = {
  money: {
    geoAudit: {
      label: {
        en: 'AI-visibility audit, fixed price',
        ru: 'Цена аудита ИИ-видимости, фикс',
      },
      value: 900,
      unit: 'EUR',
      source: 'code',
      sourceRef: 'src/data/services.ts:108–111 (priceLine), :207 (priceJsonLd)',
      verifiedAt: '2026-08-24',
      notClaim: {
        en: 'Excludes implementation and content writing (services.ts:146–155); guarantees no position in any AI answer.',
        ru: 'Не включает внедрение и написание контента (services.ts:146–155); не гарантирует позиций в ИИ-ответах.',
      },
      status: 'provisional',
      recommended: {
        note: {
          en: '€1,400 fixed, as a SECOND step once a sample report is published; payment split 50/50.',
          ru: '€1 400 фикс, но вторым шагом — после публикации образца отчёта; оплата 50/50.',
        },
        ref: S6,
      },
    },
    geoRetainer: {
      label: {
        en: 'AI-visibility retainer, floor',
        ru: 'Ретейнер ИИ-видимости, пол',
      },
      from: 2000,
      unit: 'EURPerMonth',
      source: 'code',
      sourceRef: 'src/data/services.ts:165–168 (price), :195 (priceJsonLd.minPrice)',
      verifiedAt: '2026-08-24',
      notClaim: {
        en: 'A floor, not a ceiling. Not an SLA, and not continuous cover.',
        ru: '«От» — не потолок. Это не SLA и не непрерывное дежурство.',
      },
      status: 'provisional',
      recommended: {
        note: {
          en: 'From €2,500 now, €2,800 once the first client case study exists.',
          ru: 'От €2 500 сейчас, €2 800 — после первого клиентского кейса.',
        },
        ref: S6,
      },
    },
    geoMonitoring: {
      label: {
        en: 'Monitoring-only tier, no implementation',
        ru: 'Мониторинг без внедрения (lite)',
      },
      value: 600,
      unit: 'EURPerMonth',
      source: 'code',
      sourceRef: 'src/data/services.ts:191–194 (retainer.lite)',
      verifiedAt: '2026-08-24',
      notClaim: {
        en: 'The audit credit does not apply to this tier (services.ts:192–193).',
        ru: 'Зачёт аудита на этот тариф не распространяется (services.ts:192–193).',
      },
      status: 'provisional',
      recommended: {
        note: {
          en: 'Keep the price, change the product: interpretation rather than collection, and drop the one-business-day promise from this tier.',
          ru: 'Цену оставить, но сменить состав на интерпретацию цифр и снять с этого тарифа обещание ответа за один рабочий день.',
        },
        ref: S6,
      },
    },
    ragPilot: {
      label: { en: 'RAG pilot, fixed price', ru: 'RAG-пилот, фикс' },
      value: 4500,
      unit: 'EUR',
      source: 'code',
      sourceRef: 'src/data/services.ts:220–223 (priceLine), :320 (priceJsonLd)',
      verifiedAt: '2026-08-24',
      notClaim: {
        en: 'Excludes multi-source connectors, SSO and role-based access (services.ts:258–262).',
        ru: 'Не включает коннекторы к нескольким источникам, SSO и разграничение доступа (services.ts:258–262).',
      },
      status: 'provisional',
      recommended: {
        note: { en: '€6,500 fixed.', ru: '€6 500 фикс.' },
        ref: S6,
      },
    },
    ragProduction: {
      label: {
        en: 'Typical production rollout after the pilot',
        ru: 'Типичный продакшн после пилота',
      },
      min: 10000,
      max: 20000,
      unit: 'EUR',
      source: 'code',
      sourceRef:
        'src/data/services-faq.ts:83–84 (full figures); src/data/services.ts:254–255 (same range in prose k-notation)',
      verifiedAt: '2026-08-24',
      notClaim: {
        en: 'A range of observed rollouts, not an offer: the actual figure is quoted only after the pilot.',
        ru: 'Диапазон наблюдений, а не оффер: точная цифра называется только после пилота.',
      },
      status: 'provisional',
    },
    ragCare: {
      label: { en: 'Pilot care plan, floor', ru: 'Сопровождение пилота, пол' },
      from: 1500,
      unit: 'EURPerMonth',
      source: 'code',
      sourceRef: 'src/data/services.ts:281–284 (price), :303 (priceJsonLd.minPrice)',
      verifiedAt: '2026-08-24',
      notClaim: {
        en: 'Optional — nothing after the pilot is required (services-faq.ts:83).',
        ru: 'Необязателен: после пилота ничего не обязательно (services-faq.ts:83).',
      },
      status: 'provisional',
      recommended: {
        note: {
          en: 'Leave unchanged — the one rung the review panel raised no objection to.',
          ru: 'Оставить — единственная ступень без возражений панели.',
        },
        ref: S6,
      },
    },
    onPremStarter: {
      label: {
        en: 'Self-hosted starter deployment, floor',
        ru: 'Self-hosted, стартовое развёртывание, пол',
      },
      from: 7500,
      unit: 'EUR',
      source: 'code',
      sourceRef: 'src/data/services.ts:333–336 (priceLine), :437 (priceJsonLd.minPrice)',
      verifiedAt: '2026-08-24',
      notClaim: {
        en: 'Not a GPU cluster and not enterprise scale (services.ts:375–379); no continuous-cover SLA (services.ts:380–383).',
        ru: 'Не GPU-кластер и не enterprise-масштаб (services.ts:375–379); без SLA с непрерывным дежурством (services.ts:380–383).',
      },
      status: 'provisional',
      recommended: {
        note: {
          en: '€9,500 fixed (drop the "from"), with fine-tuning pulled out into a separate option from €5,000.',
          ru: '€9 500 фикс («от» убрать), дообучение вынести в отдельную опцию от €5 000.',
        },
        ref: S6,
      },
    },
    onPremTypical: {
      label: {
        en: 'Typical full self-hosted deployment',
        ru: 'Типичное полное развёртывание',
      },
      min: 15000,
      max: 25000,
      unit: 'EUR',
      source: 'code',
      sourceRef:
        'src/pages/[lang]/services/on-prem-ai/index.astro:53 (en), :81 (ru); src/data/services.ts:342–343 (same range in prose k-notation)',
      verifiedAt: '2026-08-24',
      notClaim: {
        en: 'A range of observed deployments, not a price list.',
        ru: 'Диапазон наблюдений, а не прайс.',
      },
      status: 'provisional',
      recommended: {
        note: {
          en: 'Leave unchanged — the price is right; what blocks the deal is procurement clearance, not the figure.',
          ru: 'Оставить — цена верна; заблокирован допуск к сделке, а не цена.',
        },
        ref: S6,
      },
    },
    readinessAssessment: {
      label: {
        en: 'Self-hosting readiness assessment',
        ru: 'Оценка готовности к self-hosting',
      },
      value: 1400,
      unit: 'EUR',
      source: 'code',
      sourceRef: 'src/data/services.ts:390–391 (inside the on-prem rung riskReversal)',
      verifiedAt: '2026-08-24',
      notClaim: {
        en: 'There is no such service on the site: it exists as one sentence inside another rung, with no itemised scope, no exclusions and no stated credit window.',
        ru: 'Услуги как таковой на сайте нет: она существует одной строкой внутри чужой ступени — без состава, без исключений и без названного срока зачёта.',
      },
      status: 'provisional',
      recommended: {
        note: {
          en: '€2,000, plus a page of its own and a 90-day credit window.',
          ru: '€2 000, плюс собственная страница и окно зачёта 90 дней.',
        },
        ref: S6,
      },
    },
    sovereignCare: {
      label: { en: 'Sovereign care plan', ru: 'Сопровождение Sovereign' },
      min: 1500,
      max: 3000,
      unit: 'EURPerMonth',
      source: 'code',
      sourceRef: 'src/data/services.ts:398–401 (price), :420 (priceJsonLd)',
      verifiedAt: '2026-08-24',
      notClaim: {
        en: 'Monitoring in EU business hours, not continuous cover.',
        ru: 'Мониторинг в рабочие часы ЕС, а не непрерывное дежурство.',
      },
      status: 'provisional',
      recommended: {
        note: { en: 'Leave unchanged.', ru: 'Оставить.' },
        ref: S6,
      },
    },
    website: {
      label: { en: 'Astro website, fixed scope', ru: 'Сайт на Astro, фиксированный скоуп' },
      min: 3500,
      max: 5500,
      unit: 'EUR',
      source: 'code',
      sourceRef: 'src/data/services.ts:450–453 (priceLine), :521 (priceJsonLd)',
      verifiedAt: '2026-08-24',
      notClaim: {
        en: 'Not a web application and not SaaS (services.ts:488–500); brand identity from scratch is not included.',
        ru: 'Не веб-приложение и не SaaS (services.ts:488–500); айдентика с нуля не входит.',
      },
      status: 'provisional',
      recommended: {
        note: {
          en: '€6,000–7,500 for the base build, with a bilingual build priced as a separate €1,500 line.',
          ru: '€6 000–7 500 базово, двуязычность — отдельной строкой +€1 500.',
        },
        ref: S6,
      },
    },
    milestoneSplit: {
      label: { en: 'Milestone payment split', ru: 'Разбивка оплаты по этапам' },
      parts: [30, 40, 30],
      unit: 'percent',
      source: 'contract',
      sourceRef:
        'src/data/services.ts:612–613; src/data/faq.ts:38–39; src/pages/[lang]/trust/index.astro:103, :197',
      verifiedAt: '2026-08-24',
      notClaim: {
        en: 'Not escrow and not insurance; the trust page says "typically", so this is the usual split, not an invariant.',
        ru: 'Не эскроу и не страховка; страница доверия пишет «обычно» — это типовая разбивка, а не всегда.',
      },
      status: 'confirmed',
    },
    auditCreditShare: {
      label: {
        en: 'Share of the audit fee credited against the first retainer invoice',
        ru: 'Доля зачёта аудита в первом счёте ретейнера',
      },
      value: 100,
      unit: 'percent',
      source: 'contract',
      sourceRef: 'src/data/services.ts:183–184; public/llms.txt:14',
      verifiedAt: '2026-08-24',
      notClaim: {
        en: 'The credit applies to the FULL retainer only, never to the monitoring-only tier.',
        ru: 'Зачёт действует только на полном ретейнере, не на тарифе мониторинга.',
      },
      status: 'provisional',
      recommended: {
        note: {
          en: 'Keep the full credit even if prices rise.',
          ru: 'Сохранить полный зачёт и при подъёме цен.',
        },
        ref: S6,
      },
    },
  },
  time: {
    auditDelivery: {
      label: { en: 'Audit delivery window', ru: 'Срок сдачи аудита' },
      min: 5,
      max: 10,
      unit: 'businessDays',
      source: 'contract',
      sourceRef: 'src/data/services.ts:112–115',
      verifiedAt: '2026-08-24',
      notClaim: {
        en: 'Counted from order confirmation, not from the first email — the copy does not currently say so anywhere.',
        ru: 'Отсчёт от подтверждения заказа, а не от письма; сегодня в копии это нигде не сказано.',
      },
      status: 'confirmed',
    },
    orderConfirmation: {
      label: { en: 'Order confirmation', ru: 'Подтверждение заказа' },
      value: 1,
      unit: 'businessDays',
      source: 'code',
      sourceRef: 'src/i18n/en.json:158; src/i18n/ru.json:158',
      verifiedAt: '2026-08-24',
      notClaim: {
        en: 'Confirmation is not the start of the work.',
        ru: 'Подтверждение — не начало работ.',
      },
      status: 'confirmed',
    },
    ragPilot: {
      label: { en: 'RAG pilot duration', ru: 'Длительность RAG-пилота' },
      value: 3,
      unit: 'weeks',
      source: 'contract',
      sourceRef: 'src/data/services.ts:224–227',
      verifiedAt: '2026-08-24',
      notClaim: {
        en: 'The FAQ says the clock starts at server access; the offer itself does not say it.',
        ru: 'В FAQ сказано, что часы идут с момента доступа к серверу, — в самом оффере этого нет.',
      },
      status: 'confirmed',
    },
    onPrem: {
      label: {
        en: 'Starter self-hosted deployment duration',
        ru: 'Длительность стартового развёртывания',
      },
      min: 4,
      max: 6,
      unit: 'weeks',
      source: 'contract',
      sourceRef: 'src/data/services.ts:337–340',
      verifiedAt: '2026-08-24',
      notClaim: {
        en: 'The studio’s own case study describes months of iteration for a comparable fine-tune (cases/synapse/index.astro), which is why this window is provisional rather than confirmed.',
        ru: 'Собственный кейс студии описывает месяцы итераций для сопоставимого дообучения (cases/synapse/index.astro) — поэтому срок помечен предварительным, а не подтверждённым.',
      },
      status: 'provisional',
      recommended: {
        note: {
          en: 'Five to seven weeks for a base package with fine-tuning removed from it.',
          ru: 'Пять-семь недель для базового пакета, из которого вынесено дообучение.',
        },
        ref: S6,
      },
    },
    website: {
      label: { en: 'Website build duration', ru: 'Длительность сборки сайта' },
      min: 3,
      max: 5,
      unit: 'weeks',
      source: 'contract',
      sourceRef: 'src/data/services.ts:454–457',
      verifiedAt: '2026-08-24',
      notClaim: {
        en: 'Excludes revision rounds — their number is stated nowhere, although faq.ts:58 promises it is.',
        ru: 'Не включает раунды правок: их число нигде не названо, хотя faq.ts:58 обещает, что названо.',
      },
      status: 'confirmed',
    },
    responsePromise: {
      label: { en: 'Written reply', ru: 'Письменный ответ' },
      value: 1,
      unit: 'businessDays',
      source: 'contract',
      sourceRef: 'src/data/services.ts:188–189, :295–296, :381–382; public/llms.txt:11',
      verifiedAt: '2026-08-24',
      notClaim: {
        en: 'In EU business hours. Not same-day, and not continuous cover. The Russian wording must always name ONE business day — the shorter phrase reads as a same-day promise and is banned by law 4 in tests/unit/content-laws.test.ts.',
        ru: 'В часы ЕС. Не «сегодня же» и не непрерывное дежурство. Русская формулировка обязана называть один рабочий день: короткий вариант читается как обещание того же дня и запрещён законом 4 в tests/unit/content-laws.test.ts.',
      },
      status: 'confirmed',
    },
    warranty: {
      label: { en: 'Post-launch warranty', ru: 'Гарантия после запуска' },
      value: 30,
      unit: 'days',
      source: 'contract',
      sourceRef: 'src/data/services.ts:367–368; src/pages/[lang]/trust/index.astro:121',
      verifiedAt: '2026-08-24',
      notClaim: {
        en: 'A defect is behaviour differing from the accepted specification. New requests and content edits are not covered.',
        ru: 'Дефект — отличие от согласованной спецификации. Новые запросы и правки контента не покрыты.',
      },
      status: 'confirmed',
    },
    auditCreditWindow: {
      label: { en: 'Audit credit window', ru: 'Окно зачёта аудита' },
      value: 30,
      unit: 'days',
      source: 'contract',
      sourceRef: 'src/data/services.ts:183–184; public/llms.txt:14',
      verifiedAt: '2026-08-24',
      notClaim: {
        en: 'Only the audit has a window; the readiness assessment has none stated.',
        ru: 'Окно есть только у аудита; у оценки готовности оно не названо.',
      },
      status: 'confirmed',
    },
    introCall: {
      label: { en: 'Intro call length', ru: 'Длительность вводного созвона' },
      value: 30,
      unit: 'minutes',
      source: 'code',
      sourceRef:
        'src/pages/[lang]/contact/index.astro:96, :122; src/lib/site-config.ts:40 (Cal.com event spec), :47 (booking URL)',
      verifiedAt: '2026-08-24',
      notClaim: {
        en: 'Optional, after the form — not a required step of the funnel.',
        ru: 'Опция после формы, а не обязательный шаг воронки.',
      },
      status: 'confirmed',
    },
    chatRetention: {
      label: {
        en: 'Server-side Synapse history retention',
        ru: 'Хранение серверной истории Synapse',
      },
      value: 30,
      unit: 'days',
      source: 'code',
      sourceRef: 'src/pages/[lang]/privacy/index.astro:105 (en), :242 (ru)',
      verifiedAt: '2026-08-24',
      notClaim: {
        en: 'Applies only when signed in with Google; browser-local history lives until the user deletes it.',
        ru: 'Только при входе через Google; локальная история в браузере живёт до удаления пользователем.',
      },
      status: 'confirmed',
    },
  },
  legal: {
    registeredOn: {
      label: { en: 'State registration date', ru: 'Дата государственной регистрации' },
      iso: '2026-02-12',
      precision: 'day',
      source: 'registry',
      sourceRef: 'src/pages/[lang]/privacy/index.astro:160 (en), :297 (ru); public/llms.txt:64',
      verifiedAt: '2026-08-24',
      notClaim: {
        en: 'State Register of Legal Entities, Ministry of Justice of the Republic of Armenia. Registration NUMBERS are never published — standing owner rule, enforced by law 2 in content-laws.test.ts.',
        ru: 'Государственный регистр юридических лиц Минюста РА. Номера регистрации не публикуются никогда — стоячее правило владельца, закон 2 в content-laws.test.ts.',
      },
      status: 'confirmed',
    },
    tradingSince: {
      label: { en: 'Registered sole proprietor since', ru: 'Зарегистрированный ИП с' },
      iso: '2026-02',
      precision: 'month',
      source: 'registry',
      sourceRef:
        'src/data/services.ts:624–625; src/data/faq.ts:108–109; src/pages/[lang]/trust/index.astro:166 (en), :236 (ru)',
      verifiedAt: '2026-08-24',
      notClaim: {
        en: 'The registration date, NOT years in the profession: before February 2026 the same work ran under ordinary contracts (.system/facts/22-owner-answers.md:15).',
        ru: 'Дата регистрации ИП, а не стаж в профессии: до февраля 2026 та же работа шла по обычным договорам (.system/facts/22-owner-answers.md:15).',
      },
      status: 'confirmed',
    },
    entityForm: {
      label: { en: 'Legal form', ru: 'Форма' },
      text: {
        en: 'sole proprietorship, Armenia',
        ru: 'индивидуальный предприниматель, Армения',
      },
      source: 'registry',
      sourceRef: 'src/data/services.ts:624; src/data/faq.ts:108–109',
      verifiedAt: '2026-08-24',
      notClaim: {
        en: 'Not an agency and not a limited company; nothing is subcontracted (faq.ts:108).',
        ru: 'Не агентство и не ООО; субподряда нет (faq.ts:108).',
      },
      status: 'confirmed',
    },
    liabilityCap: {
      label: { en: 'Liability cap', ru: 'Предел ответственности' },
      text: { en: 'capped at fees paid', ru: 'ограничена суммой уплаченных вознаграждений' },
      source: 'contract',
      sourceRef: 'src/pages/[lang]/trust/index.astro:82 (en), :176 (ru); public/llms.txt:18',
      verifiedAt: '2026-08-24',
      notClaim: {
        en: 'There is no figure here and there must not be — the cap depends on the contract.',
        ru: 'Числа здесь нет и быть не должно: предел зависит от договора.',
      },
      status: 'confirmed',
    },
    professionalIndemnity: {
      label: {
        en: 'Professional indemnity policy held',
        ru: 'Полис профессиональной ответственности',
      },
      flag: false,
      source: 'ownerStatement',
      sourceRef: '.system/facts/22-owner-answers.md:15 (answer to question 11)',
      verifiedAt: '2026-08-24',
      notClaim: {
        en: 'Not claimed anywhere on the site. The trust page’s "we agree it before signing" wording promises nothing and stays honest.',
        ru: 'На сайте не заявлен. Формулировка страницы доверия «решим до подписания» ничего не обещает и остаётся честной.',
      },
      status: 'confirmed',
    },
    contractLaw: {
      label: { en: 'Governing-law option', ru: 'Опция права договора' },
      text: { en: 'English law available', ru: 'доступна опция английского права' },
      source: 'contract',
      sourceRef: 'src/data/services.ts:620–621; public/llms.txt:18',
      verifiedAt: '2026-08-24',
      notClaim: {
        en: 'An option, not the default.',
        ru: 'Опция, а не умолчание.',
      },
      status: 'confirmed',
    },
    ndaScope: {
      label: { en: 'When an NDA is required', ru: 'Когда нужен NDA' },
      text: {
        en: 'before any work beyond the audit',
        ru: 'до любых работ, кроме аудита',
      },
      source: 'contract',
      sourceRef:
        'public/llms.txt:11; src/pages/[lang]/services/geo-audit/index.astro:105 (en), :170 (ru)',
      verifiedAt: '2026-08-24',
      notClaim: {
        en: 'The audit needs none because it reads only public sources — that is not "we do not sign NDAs".',
        ru: 'Аудиту NDA не нужен, потому что он читает только публичные источники, — это не «мы не подписываем NDA».',
      },
      status: 'confirmed',
    },
  },
  availability: {
    timezoneOffset: {
      label: { en: 'Time zone', ru: 'Часовой пояс' },
      value: 4,
      unit: 'utcOffsetHours',
      source: 'code',
      sourceRef: 'src/data/services.ts:624–625; src/data/faq.ts:98–99; public/llms.txt:11',
      verifiedAt: '2026-08-24',
      notClaim: {
        en: 'GMT+4 gives an OVERLAP with EU and UK business hours, not a full working day inside them — llms.txt:11 words this correctly; other places are weaker.',
        ru: 'GMT+4 даёт пересечение с часами ЕС и Великобритании, а не полный рабочий день в них: llms.txt:11 формулирует это верно, остальные места слабее.',
      },
      status: 'confirmed',
    },
    cancellation: {
      label: { en: 'Retainer cancellation', ru: 'Отмена ретейнера' },
      text: { en: 'cancel any month, no lock-in', ru: 'отмена в любой месяц, без лока' },
      source: 'contract',
      sourceRef: 'src/data/services.ts:187–190, :299–302, :416–418',
      verifiedAt: '2026-08-24',
      notClaim: {
        en: 'No notice period appears anywhere in the copy — the site does not state one.',
        ru: 'Предупредительный срок в копии не назван нигде — сайт его не устанавливает.',
      },
      status: 'confirmed',
    },
    headcount: {
      label: { en: 'Studio size', ru: 'Размер студии' },
      value: 1,
      unit: 'count',
      source: 'ownerStatement',
      sourceRef: 'src/data/services.ts:9–10 (header); src/data/faq.ts:88–89, :108–109',
      verifiedAt: '2026-08-24',
      notClaim: {
        en: 'One engineer is a constraint stated out loud, not modesty — every refusal of a wider availability promise rests on it.',
        ru: 'Один инженер — названное вслух ограничение, а не скромность: на нём держится каждый отказ от более широких обещаний доступности.',
      },
      status: 'confirmed',
    },
  },
  site: {
    lighthouseDesktopHome: {
      label: {
        en: 'Lighthouse performance, homepage, desktop',
        ru: 'Производительность Lighthouse, главная, десктоп',
      },
      value: 99,
      outOf: 100,
      unit: 'score',
      source: 'measurement',
      sourceRef: '.system/fixes/lighthouse-2026-08-24.md:17',
      verifiedAt: '2026-08-24',
      notClaim: {
        en: 'A production build served locally, NOT the live site; measured with the video hero running.',
        ru: 'Продакшн-сборка, поданная локально, а не живой сайт; замер с работающим видео в hero.',
      },
      status: 'confirmed',
    },
    lighthouseDesktopInner: {
      label: {
        en: 'Lighthouse performance, pages without the video hero, desktop',
        ru: 'Производительность Lighthouse, страницы без видео, десктоп',
      },
      value: 100,
      outOf: 100,
      unit: 'score',
      source: 'measurement',
      sourceRef: '.system/fixes/lighthouse-2026-08-24.md:18–19',
      verifiedAt: '2026-08-24',
      notClaim: {
        en: 'Measured on /en/services/ and /en/services/geo-audit/ only — not on every page of the site.',
        ru: 'Измерено на /en/services/ и /en/services/geo-audit/, а не на всех страницах сайта.',
      },
      status: 'confirmed',
    },
    a11yScore: {
      label: { en: 'Lighthouse accessibility, desktop', ru: 'Доступность Lighthouse, десктоп' },
      value: 100,
      outOf: 100,
      unit: 'score',
      source: 'measurement',
      sourceRef: '.system/fixes/lighthouse-2026-08-24.md:17–19',
      verifiedAt: '2026-08-24',
      notClaim: {
        en: 'A Lighthouse score is not an EN 301 549 conformance audit and not a WCAG accessibility statement.',
        ru: 'Балл Lighthouse — не аудит соответствия EN 301 549 и не декларация по WCAG.',
      },
      status: 'confirmed',
    },
    cls: {
      label: { en: 'Cumulative Layout Shift, desktop', ru: 'Совокупный сдвиг макета, десктоп' },
      value: 0,
      unit: 'ratio',
      source: 'measurement',
      sourceRef: '.system/fixes/lighthouse-2026-08-24.md:17–19',
      verifiedAt: '2026-08-24',
      notClaim: {
        en: 'Desktop only — the mobile runs in the same series measured a small non-zero shift on both locales (see the measurement report).',
        ru: 'Только десктоп: мобильные прогоны той же серии дали небольшой ненулевой сдвиг в обеих локалях (см. отчёт замера).',
      },
      status: 'confirmed',
    },
    tbt: {
      label: { en: 'Total Blocking Time, desktop', ru: 'Общее время блокировки, десктоп' },
      value: 0,
      unit: 'milliseconds',
      source: 'measurement',
      sourceRef: '.system/fixes/lighthouse-2026-08-24.md:17–19',
      verifiedAt: '2026-08-24',
      notClaim: {
        en: 'Desktop only — the same run measured 96 ms on mobile /en/ and 18 ms on mobile /ru/.',
        ru: 'Только десктоп: в том же прогоне мобильный дал 96 мс на /en/ и 18 мс на /ru/.',
      },
      status: 'confirmed',
    },
    agenticChecks: {
      label: {
        en: 'Lighthouse agentic-browsing checks passed',
        ru: 'Пройдено проверок агентного просмотра Lighthouse',
      },
      value: 3,
      outOf: 3,
      unit: 'count',
      source: 'measurement',
      sourceRef:
        'src/data/services.ts:574–582; src/pages/[lang]/cases/vkvstudio-site/index.astro:54, :102',
      verifiedAt: '2026-08-24',
      notClaim: {
        en: 'Google’s experimental audit, not a standard. The three checks are a well-formed accessibility tree, zero layout shift, and a valid llms.txt.',
        ru: 'Экспериментальный аудит Google, а не стандарт. Три проверки — дерево доступности, нулевой сдвиг макета и валидный llms.txt.',
      },
      status: 'confirmed',
    },
    lighthouseMobileEn: {
      label: {
        en: 'Lighthouse performance, /en/, mobile',
        ru: 'Производительность Lighthouse, /en/, мобильный',
      },
      value: 84,
      outOf: 100,
      unit: 'score',
      source: 'measurement',
      sourceRef: '.system/fixes/lighthouse-2026-08-24.md:25',
      verifiedAt: '2026-08-24',
      notClaim: {
        en: 'A single run, not a median of three. LCP in that run was 4230 ms — well past the 2500 ms "good" threshold.',
        ru: 'Один прогон, а не медиана из трёх. LCP в нём — 4230 мс, что заметно хуже порога «хорошо» в 2500 мс.',
      },
      status: 'provisional',
    },
    lighthouseMobileRu: {
      label: {
        en: 'Lighthouse performance, /ru/, mobile',
        ru: 'Производительность Lighthouse, /ru/, мобильный',
      },
      value: 81,
      outOf: 100,
      unit: 'score',
      source: 'measurement',
      sourceRef: '.system/fixes/lighthouse-2026-08-24.md:26',
      verifiedAt: '2026-08-24',
      notClaim: {
        en: 'A single run. RU sits consistently three points below EN and the cause has not been established.',
        ru: 'Один прогон. RU стабильно на три балла ниже EN, причина не установлена.',
      },
      status: 'provisional',
    },
    locales: {
      label: { en: 'Locales shipped', ru: 'Число локалей' },
      value: 2,
      unit: 'count',
      source: 'code',
      sourceRef: 'astro.config.mjs:72–73; src/pages/[lang]/',
      verifiedAt: '2026-08-24',
      notClaim: {
        en: 'Two full builds with hreflang, not machine translation of one.',
        ru: 'Две полные сборки с hreflang, а не машинный перевод одной.',
      },
      status: 'confirmed',
    },
    heroVideoBytes: {
      label: { en: 'Hero video weight', ru: 'Вес видео в hero' },
      value: 25.7,
      unit: 'megabytes',
      source: 'measurement',
      sourceRef: '.system/fixes/lighthouse-2026-08-24.md:58',
      verifiedAt: '2026-08-24',
      notClaim: {
        en: 'This is what the one desktop point costs, and the main reason the mobile score sits where it does.',
        ru: 'Это цена одного десктопного балла и главная причина мобильного результата.',
      },
      status: 'confirmed',
    },
  },
  proof: {
    marketplaceUnits: {
      label: {
        en: 'Units sold by a client’s marketplace shop',
        ru: 'Товаров продал магазин клиента',
      },
      value: 1_300_000,
      unit: 'count',
      source: 'ownerStatement',
      sourceRef:
        '.system/facts/22-owner-answers.md:104–108 (answer to question 10); src/data/services.ts:585–594; src/i18n/en.json:60, src/i18n/ru.json:60',
      verifiedAt: '2026-08-24',
      notClaim: {
        en: 'Units of goods, NOT turnover and not the owner’s revenue. The shop belongs to a client; the owner’s contribution was its product-photography system. Not "20 years of my own e-commerce".',
        ru: 'Штуки товара, а не оборот и не деньги владельца. Магазин чужой; вклад владельца — система предметной съёмки. Не «20 лет собственного e-commerce».',
      },
      status: 'confirmed',
    },
  },
  synapse: {
    cores: {
      label: { en: 'Cores on the inference server', ru: 'Ядер на сервере инференса' },
      value: 4,
      unit: 'count',
      source: 'code',
      sourceRef:
        'src/pages/[lang]/cases/synapse/index.astro:53, :102; src/data/services.ts:307–308, :424–425',
      verifiedAt: '2026-08-24',
      notClaim: {
        en: 'ARM, no GPU. Evidence of how modest the hardware is — not a configuration recommended to a client.',
        ru: 'ARM, без GPU. Доказательство скромности железа, а не рекомендуемая клиенту конфигурация.',
      },
      status: 'confirmed',
    },
    firstTokenSeconds: {
      label: { en: 'Time to first words of an answer', ru: 'До первых слов ответа' },
      value: 20,
      unit: 'seconds',
      source: 'measurement',
      sourceRef: 'src/pages/[lang]/cases/synapse/index.astro:54, :75 (en), :103, :124 (ru)',
      verifiedAt: '2026-08-24',
      notClaim: {
        en: 'Approximate, and only for the first turn of a conversation; later turns are faster.',
        ru: 'Приблизительно и только для первой реплики диалога; следующие быстрее.',
      },
      status: 'provisional',
    },
    fullAnswerSeconds: {
      label: { en: 'Full first answer', ru: 'Полный первый ответ' },
      min: 30,
      max: 45,
      unit: 'seconds',
      source: 'measurement',
      sourceRef: 'src/pages/[lang]/cases/synapse/index.astro:54, :75 (en), :103, :124 (ru)',
      verifiedAt: '2026-08-24',
      notClaim: {
        en: 'The price of CPU-only sovereignty at the smallest possible budget; the same architecture on a modest GPU answers in seconds. The measurement method is not recorded.',
        ru: 'Цена CPU-суверенитета на минимальном бюджете; та же архитектура на скромной GPU отвечает за секунды. Метод замера не записан.',
      },
      status: 'provisional',
    },
    embeddingDims: {
      label: { en: 'EmbeddingGemma vector width', ru: 'Размерность вектора EmbeddingGemma' },
      value: 768,
      unit: 'count',
      source: 'code',
      sourceRef: 'src/data/lab-faq.ts:136–137; src/lib/embedding/engine.ts:41 (NATIVE_DIMS)',
      verifiedAt: '2026-08-24',
      notClaim: {
        en: 'Matryoshka truncation to 512/256/128 is a property of the model, not a setting of ours.',
        ru: 'Матрёшечная обрезка до 512/256/128 — свойство модели, а не наша настройка.',
      },
      status: 'confirmed',
    },
    docSourceLimit: {
      label: { en: 'Document source size in the pilot', ru: 'Объём источника в пилоте' },
      value: 500,
      unit: 'count',
      source: 'contract',
      sourceRef: 'src/data/services.ts:234–235; public/llms.txt:15',
      verifiedAt: '2026-08-24',
      notClaim: {
        en: 'Pages, and "roughly". No limit on document FORMAT is stated anywhere — an open risk under a fixed price.',
        ru: 'Страниц, и «примерно». Ограничения по формату документов нет нигде — открытый риск фиксированной цены.',
      },
      status: 'confirmed',
    },
    auditPrompts: {
      label: { en: 'Prompts tested in the audit', ru: 'Запросов в аудите' },
      value: 20,
      unit: 'count',
      source: 'contract',
      sourceRef: 'src/data/services.ts:122–123; public/llms.txt:13',
      verifiedAt: '2026-08-24',
      notClaim: {
        en: 'Buyer-intent prompts chosen for the buyer, not full coverage of a topic.',
        ru: 'Коммерческие запросы, отобранные под покупателя, а не полный охват тематики.',
      },
      status: 'confirmed',
    },
    auditEngines: {
      label: { en: 'Engines covered by the audit', ru: 'Движков в аудите' },
      value: 5,
      unit: 'count',
      source: 'contract',
      sourceRef: 'src/data/services.ts:122–123, :171–172; public/llms.txt:13',
      verifiedAt: '2026-08-24',
      notClaim: {
        en: 'ChatGPT, Perplexity, Google AI Overviews & AI Mode, Copilot, Gemini — Overviews and AI Mode count as ONE engine, and that is worth saying out loud.',
        ru: 'ChatGPT, Perplexity, Google AI Overviews и AI Mode, Copilot, Gemini — Overviews и AI Mode считаются одним движком, и это стоит называть вслух.',
      },
      status: 'confirmed',
    },
    retainerFixes: {
      label: { en: 'Fixes implemented per month', ru: 'Внедряемых исправлений в месяц' },
      min: 2,
      max: 3,
      unit: 'count',
      source: 'contract',
      sourceRef: 'src/data/services.ts:179–180; public/llms.txt:14',
      verifiedAt: '2026-08-24',
      notClaim: {
        en: 'Implemented, not recommended.',
        ru: 'Внедряются, а не рекомендуются.',
      },
      status: 'confirmed',
    },
    namedCompetitors: {
      label: { en: 'Competitors compared against', ru: 'Конкурентов в сравнении' },
      min: 2,
      max: 3,
      unit: 'count',
      source: 'contract',
      sourceRef: 'src/data/services.ts:126–129; src/pages/[lang]/services/geo-audit/index.astro:79',
      verifiedAt: '2026-08-24',
      notClaim: {
        en: 'Named by the client, not picked by us.',
        ru: 'Названные клиентом, а не выбранные нами.',
      },
      status: 'confirmed',
    },
  },
} as const satisfies FactBook;

/**
 * Widening step for the index below. Each domain object gets an implicit
 * index signature from its inferred literal type, so this needs no cast and
 * never touches `any` — every value stays checked against AnyFact.
 */
function factEntries(
  group: Readonly<Record<string, AnyFact>>
): readonly (readonly [string, AnyFact])[] {
  return Object.entries(group);
}

const FACT_INDEX: ReadonlyMap<string, AnyFact> = new Map(
  Object.entries(FACTS).flatMap(([domain, group]) =>
    factEntries(group).map(([name, fact]): readonly [string, AnyFact] => [
      `${domain}.${name}`,
      fact,
    ])
  )
);

/**
 * Dotted lookup for the callers that cannot write `FACTS.money.geoAudit`
 * directly — the llms.txt generator, the assistant, tests iterating by key.
 * A miss throws instead of returning undefined, the same move getRung() makes
 * in services.ts: under `noUncheckedIndexedAccess` that is not a style choice.
 */
export function getFact(key: string): AnyFact {
  const fact = FACT_INDEX.get(key);
  if (!fact) throw new FactNotFoundError(key);
  return fact;
}

/** Every fact with its dotted key — for whole-base checks and generators. */
export function allFacts(): readonly (readonly [string, AnyFact])[] {
  return [...FACT_INDEX.entries()];
}
