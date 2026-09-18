/**
 * FORMATTERS FOR THE FACT BASE — the one place a number from src/data/facts.ts
 * is turned into a string a human reads.
 *
 * Two rules shape everything below.
 *
 * 1. A formatter returns `Bilingual`, never `string`. This continues a
 *    decision services.ts already paid for: ProofItem.value became Bilingual
 *    because "1.3M" is English notation and Russian writes the same quantity
 *    "1,3 млн" — a different decimal mark AND a different magnitude word.
 *    One shared string once put "1.3M" in the proof strip while the Russian
 *    timeline two screens below said "1,3 млн" on the same page. Take a
 *    single locale out at the call site with inLang() where the locale is
 *    already known; the bilingual pair stays primary.
 *
 * 2. Notation variants are SEPARATE FUNCTIONS, never flags. `money(f,
 *    { compact: true })` is a flag that will one day be passed where a full
 *    figure belongs — services.ts:26–31 sets the law that k-notation is for
 *    flowing prose only and never for a headline price. `moneyRangeProse()`
 *    makes a breach of that law visible at the call site instead of hiding
 *    it in an argument. The same reasoning splits `duration()` (numerals, as
 *    every `timeframe` field is written today) from `durationProse()` (small
 *    numbers spelled out, as every SEO description is written today).
 *
 * The thousands separator lives here and nowhere else: U+00A0 in Russian,
 * a comma in English. tests/unit/content-laws.test.ts fails the build for any
 * other space-family character between digit groups, and this file is the
 * only place that character should ever be typed.
 */

import type { Bilingual } from '@/data/services';
import type { DateFact, FixedFact, FromFact, RangeFact, SplitFact, StatedFact } from '@/data/facts';

export type Lang = 'en' | 'ru';

/**
 * Thrown when a fact is handed to the wrong formatter — a duration to
 * money(), a range to a fixed-price formatter, a non-integer price. Same
 * stance as FactNotFoundError and ServiceRungNotFoundError: a mismatch is a
 * data bug that must be loud, not a value quietly rendered wrong.
 */
export class FactFormatError extends Error {
  constructor(message: string) {
    super(`format-fact.ts: ${message}`);
    this.name = 'FactFormatError';
  }
}

/**
 * The Russian thousands separator, typed once, here, on purpose.
 *
 * Its scope is deliberately narrow, and the narrowness was measured rather
 * than assumed (2026-08-24, byte-level read of the shipped strings): the
 * site uses U+00A0 between DIGIT GROUPS, and before the magnitude word in
 * the "1,3 mln" proof-strip figure -- and a plain ASCII space everywhere
 * else, including between a number and its unit noun ("5-10 business days",
 * "since February 2026" in their Russian forms). Widening NBSP to those
 * positions would be better typography AND would make every formatter
 * output differ from the copy it is meant to reproduce, which is exactly
 * what the migration's characterization step cannot tolerate.
 */
const NBSP = '\u00A0';
/** Range dash: U+2013, as all 17 existing range strings on the site use. */
const DASH = '–';
const EURO = '€';

/** Takes one locale out of a bilingual pair, for pages that know their lang. */
export function inLang(pair: Bilingual, lang: Lang): string {
  return lang === 'ru' ? pair.ru : pair.en;
}

function bilingual(en: string, ru: string): Bilingual {
  return { en, ru };
}

/**
 * Digit grouping. Values below 1000 get no separator in either locale —
 * "€900", never "€0 900" and never "€900" with anything in front of it.
 */
function groupDigits(n: number, lang: Lang): string {
  const sep = lang === 'ru' ? NBSP : ',';
  const [whole = '0', fraction] = Math.abs(n).toString().split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, sep);
  const sign = n < 0 ? '-' : '';
  if (fraction === undefined) return `${sign}${grouped}`;
  // Decimal mark differs: "25.7 MB" in English, "25,7 МБ" in Russian.
  return `${sign}${grouped}${lang === 'ru' ? ',' : '.'}${fraction}`;
}

function requireUnit(unit: string, allowed: readonly string[], fn: string): void {
  if (!allowed.includes(unit)) {
    throw new FactFormatError(`${fn}() got a fact in "${unit}", expected ${allowed.join(' or ')}`);
  }
}

/**
 * Prices are whole euros. The base's only fractional number is
 * site.heroVideoBytes, and it goes through megabytes() — a price that
 * arrives here with a decimal is a data error, not something to round away.
 */
function requireWholeEuros(n: number, fn: string): void {
  if (!Number.isInteger(n)) {
    throw new FactFormatError(`${fn}() got a non-integer amount (${n}); prices are whole euros`);
  }
}

function amount(n: number, lang: Lang): string {
  return `${EURO}${groupDigits(n, lang)}`;
}

/**
 * A range prints the currency ONCE — "€3 500–5 500", not "€3 500–€5 500".
 * That is how all 17 existing range strings on the site are written.
 */
function amountRange(min: number, max: number, lang: Lang): string {
  return `${EURO}${groupDigits(min, lang)}${DASH}${groupDigits(max, lang)}`;
}

const PER_MONTH: Bilingual = { en: '/month', ru: '/месяц' };
const FROM_PREFIX: Bilingual = { en: 'from ', ru: 'от ' };

/* ------------------------------------------------------------------ money */

/** Exact one-off price: `€900` · `€4,500` / `€4 500`. */
export function money(f: FixedFact): Bilingual {
  requireUnit(f.unit, ['EUR'], 'money');
  requireWholeEuros(f.value, 'money');
  return bilingual(amount(f.value, 'en'), amount(f.value, 'ru'));
}

/** Floor price: `from €7,500` / `от €7 500`. */
export function moneyFrom(f: FromFact): Bilingual {
  requireUnit(f.unit, ['EUR'], 'moneyFrom');
  requireWholeEuros(f.from, 'moneyFrom');
  return bilingual(
    `${FROM_PREFIX.en}${amount(f.from, 'en')}`,
    `${FROM_PREFIX.ru}${amount(f.from, 'ru')}`
  );
}

/** Range: `€3,500–5,500` / `€3 500–5 500`. */
export function moneyRange(f: RangeFact): Bilingual {
  requireUnit(f.unit, ['EUR'], 'moneyRange');
  requireWholeEuros(f.min, 'moneyRange');
  requireWholeEuros(f.max, 'moneyRange');
  return bilingual(amountRange(f.min, f.max, 'en'), amountRange(f.min, f.max, 'ru'));
}

/** Monthly price: `€600/month` / `€600/месяц`. */
export function moneyPerMonth(f: FixedFact): Bilingual {
  requireUnit(f.unit, ['EURPerMonth'], 'moneyPerMonth');
  requireWholeEuros(f.value, 'moneyPerMonth');
  return bilingual(
    `${amount(f.value, 'en')}${PER_MONTH.en}`,
    `${amount(f.value, 'ru')}${PER_MONTH.ru}`
  );
}

/** Monthly floor: `from €2,000/month` / `от €2 000/месяц`. */
export function moneyFromPerMonth(f: FromFact): Bilingual {
  requireUnit(f.unit, ['EURPerMonth'], 'moneyFromPerMonth');
  requireWholeEuros(f.from, 'moneyFromPerMonth');
  return bilingual(
    `${FROM_PREFIX.en}${amount(f.from, 'en')}${PER_MONTH.en}`,
    `${FROM_PREFIX.ru}${amount(f.from, 'ru')}${PER_MONTH.ru}`
  );
}

/** Monthly range: `€1,500–3,000/month` / `€1 500–3 000/месяц`. */
export function moneyRangePerMonth(f: RangeFact): Bilingual {
  requireUnit(f.unit, ['EURPerMonth'], 'moneyRangePerMonth');
  requireWholeEuros(f.min, 'moneyRangePerMonth');
  requireWholeEuros(f.max, 'moneyRangePerMonth');
  return bilingual(
    `${amountRange(f.min, f.max, 'en')}${PER_MONTH.en}`,
    `${amountRange(f.min, f.max, 'ru')}${PER_MONTH.ru}`
  );
}

/**
 * PROSE ONLY — k-notation: `€15–25k`, identical in both locales because the
 * thousands separator never appears. Never use this in a price-label
 * position (priceLine, retainer.price, an SEO title): services.ts:26–31 is
 * explicit that full figures belong there. It is a separate function so that
 * misuse is visible where it happens.
 */
export function moneyRangeProse(f: RangeFact): Bilingual {
  requireUnit(f.unit, ['EUR'], 'moneyRangeProse');
  if (f.min % 1000 !== 0 || f.max % 1000 !== 0) {
    throw new FactFormatError(
      `moneyRangeProse() needs both ends in whole thousands, got ${f.min}${DASH}${f.max}`
    );
  }
  const compact = `${EURO}${f.min / 1000}${DASH}${f.max / 1000}k`;
  return bilingual(compact, compact);
}

/* -------------------------------------------------------------- durations */

type DurationUnit = 'businessDays' | 'days' | 'weeks' | 'months' | 'minutes' | 'seconds';

const DURATION_UNITS: readonly DurationUnit[] = [
  'businessDays',
  'days',
  'weeks',
  'months',
  'minutes',
  'seconds',
];

interface UnitWords {
  /** English: singular, plural. */
  readonly en: readonly [string, string];
  /** Russian: one, few (2–4), many (5+ and everything in 11–14). */
  readonly ru: readonly [string, string, string];
  /** Grammatical gender of the Russian noun — «один день» but «одна неделя». */
  readonly gender: 'm' | 'f';
}

const DURATION_WORDS: Readonly<Record<DurationUnit, UnitWords>> = {
  businessDays: {
    en: ['business day', 'business days'],
    ru: ['рабочий день', 'рабочих дня', 'рабочих дней'],
    gender: 'm',
  },
  days: { en: ['day', 'days'], ru: ['день', 'дня', 'дней'], gender: 'm' },
  weeks: { en: ['week', 'weeks'], ru: ['неделя', 'недели', 'недель'], gender: 'f' },
  months: { en: ['month', 'months'], ru: ['месяц', 'месяца', 'месяцев'], gender: 'm' },
  minutes: { en: ['minute', 'minutes'], ru: ['минута', 'минуты', 'минут'], gender: 'f' },
  seconds: { en: ['second', 'seconds'], ru: ['секунда', 'секунды', 'секунд'], gender: 'f' },
};

/** Small numbers spelled out — 1 to 3 only, as the shipped SEO copy does. */
const WORD_NUMERALS: {
  readonly en: readonly string[];
  readonly ru: Readonly<Record<'m' | 'f', readonly string[]>>;
} = {
  en: ['one', 'two', 'three'],
  ru: { m: ['один', 'два', 'три'], f: ['одна', 'две', 'три'] },
};

/** Russian plural bucket. Without this you get «5–10 рабочих день». */
function ruPluralIndex(n: number): 0 | 1 | 2 {
  const mod100 = Math.abs(n) % 100;
  const mod10 = Math.abs(n) % 10;
  if (mod100 >= 11 && mod100 <= 14) return 2;
  if (mod10 === 1) return 0;
  if (mod10 >= 2 && mod10 <= 4) return 1;
  return 2;
}

function durationUnitOf(unit: string, fn: string): DurationUnit {
  const found = DURATION_UNITS.find((u) => u === unit);
  if (!found) {
    throw new FactFormatError(`${fn}() got a fact in "${unit}", which is not a duration`);
  }
  return found;
}

function enWord(words: UnitWords, plural: boolean): string {
  return plural ? words.en[1] : words.en[0];
}

function ruWord(words: UnitWords, n: number): string {
  return words.ru[ruPluralIndex(n)];
}

/**
 * Numerals, the form every `timeframe` field on the site uses today:
 * `5–10 business days` / `5–10 рабочих дней`, `3 weeks` / `3 недели`.
 *
 * For a range, the Russian noun agrees with the UPPER bound — «5–10 рабочих
 * дней», not «5–10 рабочих дня» — and English is always plural.
 */
export function duration(f: FixedFact | RangeFact): Bilingual {
  const words = DURATION_WORDS[durationUnitOf(f.unit, 'duration')];
  if ('value' in f) {
    return bilingual(
      `${f.value} ${enWord(words, f.value !== 1)}`,
      `${f.value} ${ruWord(words, f.value)}`
    );
  }
  return bilingual(
    `${f.min}${DASH}${f.max} ${enWord(words, true)}`,
    `${f.min}${DASH}${f.max} ${ruWord(words, f.max)}`
  );
}

/**
 * Prose form: 1–3 spelled out, 4 and above left as digits, in both locales —
 * exactly the split the shipped copy already makes (`Three weeks` / `Три
 * недели` for the pilot, `4–6 weeks` / `4–6 недель` for on-prem). Ranges are
 * always digits. Capitalisation is the caller's business.
 */
export function durationProse(f: FixedFact | RangeFact): Bilingual {
  if (!('value' in f) || f.value > 3 || f.value < 1) return duration(f);
  const words = DURATION_WORDS[durationUnitOf(f.unit, 'durationProse')];
  const i = f.value - 1;
  const en = WORD_NUMERALS.en[i];
  const ru = WORD_NUMERALS.ru[words.gender][i];
  if (en === undefined || ru === undefined) return duration(f);
  return bilingual(`${en} ${enWord(words, f.value !== 1)}`, `${ru} ${ruWord(words, f.value)}`);
}

/**
 * The response promise gets its own function because the Russian half is not
 * a free translation choice. «в течение рабочего дня» reads as "by end of
 * today" — a stronger promise than the English, and a same-day commitment a
 * one-engineer studio cannot keep. Only the wording with «одного» matches
 * the English, and law 4 in tests/unit/content-laws.test.ts fails the build
 * for the short form. One function means the wrong form has nowhere to be
 * written.
 */
export function responsePromise(): Bilingual {
  return bilingual('within one business day', 'в течение одного рабочего дня');
}

/* ------------------------------------------------------------ scores etc. */

function requireOutOf(f: FixedFact, fn: string): number {
  if (f.outOf === undefined) {
    throw new FactFormatError(`${fn}() needs a fact with outOf set`);
  }
  return f.outOf;
}

/** `X/Y` — language-neutral, so both halves repeat: `3/3`. */
export function ratio(f: FixedFact): Bilingual {
  const outOf = requireOutOf(f, 'ratio');
  const text = `${f.value}/${outOf}`;
  return bilingual(text, text);
}

/**
 * A Lighthouse-style score out of a hundred: `99/100`. Asserts the
 * denominator so "3/3 checks passed" can never be printed as if it were a
 * performance score — that is what ratio() is for.
 */
export function score(f: FixedFact): Bilingual {
  const outOf = requireOutOf(f, 'score');
  if (outOf !== 100) {
    throw new FactFormatError(`score() expects outOf 100, got ${outOf}; use ratio()`);
  }
  return ratio(f);
}

/**
 * A large count with a magnitude suffix: `1.3M+` / `1,3 млн+`. This is the
 * pair that made ProofItem.value bilingual — the decimal mark AND the suffix
 * differ, and English writes the suffix tight against the digits while
 * Russian sets it off with a space. Below a million the ordinary digit
 * grouping applies, with no currency symbol.
 */
export function count(f: FixedFact, opts: { plus?: boolean } = {}): Bilingual {
  const suffix = opts.plus === true ? '+' : '';
  const MILLION = 1_000_000;
  if (Math.abs(f.value) < MILLION) {
    return bilingual(
      `${groupDigits(f.value, 'en')}${suffix}`,
      `${groupDigits(f.value, 'ru')}${suffix}`
    );
  }
  // One decimal place, and a trailing ".0" dropped: 1.3M, 2M — never "2.0M".
  const millions = Math.round((f.value / MILLION) * 10) / 10;
  const digits = millions.toString();
  return bilingual(`${digits}M${suffix}`, `${digits.replace('.', ',')}${NBSP}млн${suffix}`);
}

/** A small count, no suffix and no currency: `20`, `500`. */
export function countPlain(f: FixedFact): Bilingual {
  return bilingual(groupDigits(f.value, 'en'), groupDigits(f.value, 'ru'));
}

/** The milestone split, printed as the site writes it: `30/40/30`. */
export function percentSplit(f: SplitFact): Bilingual {
  requireUnit(f.unit, ['percent'], 'percentSplit');
  const text = f.parts.join('/');
  return bilingual(text, text);
}

/** Hero video weight and anything else measured in MB: `25.7 MB` / `25,7 МБ`. */
export function megabytes(f: FixedFact): Bilingual {
  requireUnit(f.unit, ['megabytes'], 'megabytes');
  return bilingual(`${groupDigits(f.value, 'en')} MB`, `${groupDigits(f.value, 'ru')} МБ`);
}

/** Lighthouse timing metrics: `0 ms` / `0 мс`. */
export function milliseconds(f: FixedFact): Bilingual {
  requireUnit(f.unit, ['milliseconds'], 'milliseconds');
  return bilingual(`${groupDigits(f.value, 'en')} ms`, `${groupDigits(f.value, 'ru')} мс`);
}

/** A bare dimensionless number, e.g. Cumulative Layout Shift: `0`. */
export function decimal(f: FixedFact): Bilingual {
  requireUnit(f.unit, ['ratio'], 'decimal');
  return bilingual(groupDigits(f.value, 'en'), groupDigits(f.value, 'ru'));
}

/** The timezone as the site names it everywhere: `GMT+4`. */
export function utcOffset(f: FixedFact): Bilingual {
  requireUnit(f.unit, ['utcOffsetHours'], 'utcOffset');
  const text = `GMT${f.value < 0 ? '-' : '+'}${Math.abs(f.value)}`;
  return bilingual(text, text);
}

/* ----------------------------------------------------------------- dates */

const MONTHS_EN: readonly string[] = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** Nominative — the form a month takes when it stands on its own. */
const MONTHS_RU_NOMINATIVE: readonly string[] = [
  'январь',
  'февраль',
  'март',
  'апрель',
  'май',
  'июнь',
  'июль',
  'август',
  'сентябрь',
  'октябрь',
  'ноябрь',
  'декабрь',
];

/** Genitive — the form required after a day number and after «с». */
const MONTHS_RU_GENITIVE: readonly string[] = [
  'января',
  'февраля',
  'марта',
  'апреля',
  'мая',
  'июня',
  'июля',
  'августа',
  'сентября',
  'октября',
  'ноября',
  'декабря',
];

interface ParsedDate {
  readonly year: string;
  readonly monthIndex: number;
  readonly day?: string;
}

function parseIso(f: DateFact, fn: string): ParsedDate {
  const [year, month, day] = f.iso.split('-');
  if (year === undefined || month === undefined) {
    throw new FactFormatError(`${fn}() got an unparseable date "${f.iso}"`);
  }
  const monthIndex = Number(month) - 1;
  if (!Number.isInteger(monthIndex) || monthIndex < 0 || monthIndex > 11) {
    throw new FactFormatError(`${fn}() got month "${month}" out of range in "${f.iso}"`);
  }
  return { year, monthIndex, day };
}

function monthName(list: readonly string[], index: number, fn: string): string {
  const name = list[index];
  if (name === undefined) throw new FactFormatError(`${fn}() has no month at index ${index}`);
  return name;
}

/** Full date: `12 February 2026` / `12 февраля 2026`. */
export function date(f: DateFact): Bilingual {
  if (f.precision !== 'day') {
    throw new FactFormatError(
      'date() needs a day-precision fact; a month-precision source has no day to print'
    );
  }
  const { year, monthIndex, day } = parseIso(f, 'date');
  if (day === undefined) throw new FactFormatError(`date() found no day in "${f.iso}"`);
  const dayNumber = Number(day);
  return bilingual(
    `${dayNumber} ${monthName(MONTHS_EN, monthIndex, 'date')} ${year}`,
    `${dayNumber} ${monthName(MONTHS_RU_GENITIVE, monthIndex, 'date')} ${year}`
  );
}

/** Month and year standing alone: `February 2026` / `февраль 2026`. */
export function monthYear(f: DateFact): Bilingual {
  const { year, monthIndex } = parseIso(f, 'monthYear');
  return bilingual(
    `${monthName(MONTHS_EN, monthIndex, 'monthYear')} ${year}`,
    `${monthName(MONTHS_RU_NOMINATIVE, monthIndex, 'monthYear')} ${year}`
  );
}

/**
 * The "trading since" phrasing the copy actually needs: `since February 2026`
 * / `с февраля 2026`. A separate function rather than a flag, because the
 * Russian month has to change case — a caller handed the nominative from
 * monthYear() cannot fix that by concatenating a preposition.
 */
export function monthYearSince(f: DateFact): Bilingual {
  const { year, monthIndex } = parseIso(f, 'monthYearSince');
  return bilingual(
    `since ${monthName(MONTHS_EN, monthIndex, 'monthYearSince')} ${year}`,
    `с ${monthName(MONTHS_RU_GENITIVE, monthIndex, 'monthYearSince')} ${year}`
  );
}

/* --------------------------------------------------------- stated facts */

/**
 * Non-quantity facts pass through unchanged. The function exists so that
 * call sites read the same as every other fact use and so that a stated fact
 * cannot be handed to a numeric formatter by accident.
 */
export function stated(f: StatedFact): Bilingual {
  return bilingual(f.text.en, f.text.ru);
}
