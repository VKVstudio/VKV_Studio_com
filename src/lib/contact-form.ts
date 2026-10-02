/** Pure written intake: validate locally and prepare a user-controlled email draft. */
import { z } from 'zod';
import { CONTACT_EMAIL } from './site-config';
import { contactContextLines, type ContactContext } from './contact-context';

// Avoid Zod's eval capability probe before constructing any object schema.
z.config({ jitless: true });

export interface ContactFormData {
  company: string;
  task: string;
  budget: BudgetRange | '';
  timeline: Timeline | '';
}

export type BudgetRange =
  | 'audit-900'
  | 'under-5k'
  | '5k-10k'
  | '10k-plus'
  | 'monthly-retainer'
  | 'not-sure';

export type Timeline = 'asap' | 'this-quarter' | 'exploring';

export interface BudgetOption {
  value: BudgetRange;
  en: string;
  ru: string;
}

export interface TimelineOption {
  value: Timeline;
  en: string;
  ru: string;
}

/**
 * Mirrors the real EUR ladder in src/data/services.ts (audit €900, retainers
 * from €1,500–3,000/mo) so a visitor picking a budget bucket here is never
 * shown a number the rest of the site would contradict. No dollar signs, no
 * payment-method names — see services-data.test.ts for why "Stripe" is a
 * site-wide content rule, enforced here too.
 */
export const BUDGET_OPTIONS: BudgetOption[] = [
  { value: 'audit-900', en: 'The €900 audit', ru: 'Аудит за €900' },
  { value: 'under-5k', en: 'Under €5,000', ru: 'До €5 000' },
  { value: '5k-10k', en: '€5,000–10,000', ru: '€5 000–10 000' },
  { value: '10k-plus', en: '€10,000+', ru: '€10 000+' },
  { value: 'monthly-retainer', en: 'A monthly retainer', ru: 'Ежемесячный ретейнер' },
  // No gender-parenthesis constructions in copy (bureaucratic-sounding, house rule).
  { value: 'not-sure', en: 'Not sure yet', ru: 'Пока не знаю' },
];

export const TIMELINE_OPTIONS: TimelineOption[] = [
  { value: 'asap', en: 'As soon as possible', ru: 'Как можно скорее' },
  { value: 'this-quarter', en: 'This quarter', ru: 'В этом квартале' },
  { value: 'exploring', en: 'Just exploring options', ru: 'Пока изучаю варианты' },
];

export interface FieldErrors {
  company?: 'required' | 'too-long';
  task?: 'required' | 'too-short' | 'too-long';
  budget?: 'required';
  timeline?: 'required';
}

const COMPANY_MAX_LEN = 200;
// 20 chars is short enough to type in one breath but long enough to exclude
// "hi" / "test" — the floor exists so the first written reply isn't spent
// asking what the enquiry is actually about.
const TASK_MIN_LEN = 20;
const TASK_MAX_LEN = 2000;

/**
 * Real mail clients start failing (silently truncating or refusing to open)
 * `mailto:` links somewhere around 2000 total characters, and percent-encoded
 * Cyrillic runs several times its source length — a 2000-char RU task can
 * blow past that on its own. This bounds only the `subject=...&body=...`
 * query portion; buildMailtoUrl shortens the task and, only if needed, the
 * company. The full draft remains available for copying and selection.
 */
export const MAILTO_QUERY_MAX = 1800;

// How many characters buildMailtoUrl shaves off the task per shrink pass.
// Small enough for a stable cut, large enough that even a maximally
// expensive (all-Cyrillic, near MAX_LEN) task converges in well under a
// hundred iterations.
const TASK_SHRINK_STEP = 40;
const TRUNCATION_MARKER = '…';

/**
 * Anti-bot gate (owner decision, worklist M4 / P2 fix). MIN_FILL_MS is a
 * three-second floor a human filling the form by hand will comfortably
 * clear — but a fast fill alone is not proof of a bot (autofill, paste, a
 * screen-reader user tabbing straight through can all be quick), so it is
 * captured only as a future signal for a server-side /api/lead check and
 * never blocks a submit by itself. See isGateTripped.
 */
export const MIN_FILL_MS = 3000;

const formSchema = z.object({
  company: z.string().trim().min(1).max(COMPANY_MAX_LEN),
  task: z.string().trim().min(TASK_MIN_LEN).max(TASK_MAX_LEN),
  budget: z.enum(['audit-900', 'under-5k', '5k-10k', '10k-plus', 'monthly-retainer', 'not-sure']),
  timeline: z.enum(['asap', 'this-quarter', 'exploring']),
});

export function validate(data: ContactFormData): FieldErrors {
  const result = formSchema.safeParse(data);
  if (result.success) return {};
  const errors: FieldErrors = {};
  for (const issue of result.error.issues) {
    const field = issue.path[0];
    if (field === 'company')
      errors.company = data.company.trim().length === 0 ? 'required' : 'too-long';
    if (field === 'task')
      errors.task =
        data.task.trim().length === 0
          ? 'required'
          : data.task.trim().length < TASK_MIN_LEN
            ? 'too-short'
            : 'too-long';
    if (field === 'budget') errors.budget = 'required';
    if (field === 'timeline') errors.timeline = 'required';
  }
  return errors;
}

export function isValid(errors: FieldErrors): boolean {
  return Object.keys(errors).length === 0;
}

/**
 * The only thing that should ever silently swallow a submit: a filled
 * honeypot, a field no human sees (clipped off-screen, `tabindex="-1"`,
 * `aria-hidden`) but a form-filling script happily populates. `elapsedMs`
 * (time since the form mounted) is accepted here so the call site can carry
 * it forward to a future /api/lead server-side signal, but it intentionally
 * plays no part in the boolean below — a real visitor can legitimately fill
 * four short fields in under MIN_FILL_MS, and gating on speed alone would
 * silently eat a valid human submit with no error shown.
 */
export function isGateTripped(honeypot: string, elapsedMs: number): boolean {
  void elapsedMs; // reserved for a future server-side signal — see doc comment
  return honeypot.trim() !== '';
}

function budgetLabel(value: BudgetRange | '', lang: 'en' | 'ru'): string {
  if (value === '') return '';
  const option = BUDGET_OPTIONS.find((o) => o.value === value);
  return option ? option[lang] : '';
}

function timelineLabel(value: Timeline | '', lang: 'en' | 'ru'): string {
  if (value === '') return '';
  const option = TIMELINE_OPTIONS.find((o) => o.value === value);
  return option ? option[lang] : '';
}

const FIELD_LABELS = {
  company: { en: 'Company', ru: 'Компания' },
  task: { en: 'Task', ru: 'Задача' },
  budget: { en: 'Budget', ru: 'Бюджет' },
  timeline: { en: 'Timeline', ru: 'Сроки' },
} as const;

/**
 * Collapses embedded CR/LF runs to a single space and trims. Applied to
 * values that flow into single-line contexts (the email subject) so a company name or task excerpt carrying an embedded
 * newline can never smuggle extra lines into an email subject. Newlines a visitor intentionally typed inside the task story are
 * left alone in the actual letter BODY (letterBody below) — this only
 * guards values meant to render as one line.
 */
function singleLine(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

function wellFormed(value: string): string {
  return value.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    '\uFFFD'
  );
}

/**
 * Slices to at most `maxLength` characters without ever landing mid UTF-16
 * surrogate pair (an emoji in the task, say) — handing encodeURIComponent a
 * lone surrogate throws a URIError, which would break the mailto link
 * builders on otherwise perfectly valid input. Trims trailing whitespace
 * the cut leaves behind.
 */
function safeSlice(value: string, maxLength: number): string {
  let end = Math.max(0, Math.min(maxLength, value.length));
  if (end > 0 && end < value.length) {
    const code = value.charCodeAt(end - 1);
    if (code >= 0xd8_00 && code <= 0xdb_ff) end -= 1;
  }
  return value.slice(0, end).trimEnd();
}

function letterSubject(company: string, lang: 'en' | 'ru'): string {
  return lang === 'ru' ? `Запрос по проекту — ${company}` : `Project inquiry — ${company}`;
}

// The task is last so a shortened mailto body ends with its truncation marker.
function letterBody(
  company: string,
  task: string,
  data: ContactFormData,
  lang: 'en' | 'ru',
  context: ContactContext
): string {
  return [
    ...contactContextLines(context, lang),
    `${FIELD_LABELS.company[lang]}: ${company}`,
    `${FIELD_LABELS.budget[lang]}: ${budgetLabel(data.budget, lang)}`,
    `${FIELD_LABELS.timeline[lang]}: ${timelineLabel(data.timeline, lang)}`,
    `${FIELD_LABELS.task[lang]}: ${task}`,
  ].join('\n');
}

/**
 * Builds the PRIMARY conversion link. Subject and body are encoded together
 * as one query string — mail clients disagree on how they decode a raw `\n`
 * dropped straight into an href, so the body is joined with real newlines
 * first and the whole string is run through `encodeURIComponent` once,
 * which every client can parse back correctly.
 *
 * The task is shortened first. A long encoded company may also need a cut
 * after that; fixed service/briefing context is retained. Every cut has a
 * visible marker, and buildEmailText keeps the full draft available.
 */
export function buildMailtoUrl(
  data: ContactFormData,
  lang: 'en' | 'ru',
  context: ContactContext = {}
): string {
  let company = wellFormed(singleLine(data.company.trim()));
  const queryFor = (task: string): string =>
    `subject=${encodeURIComponent(letterSubject(company, lang))}&body=${encodeURIComponent(letterBody(company, task, data, lang, context))}`;

  let task = wellFormed(data.task.trim());
  if (queryFor(task).length > MAILTO_QUERY_MAX) {
    while (task.length > 0 && queryFor(`${task}${TRUNCATION_MARKER}`).length > MAILTO_QUERY_MAX) {
      task = safeSlice(task, task.length - TASK_SHRINK_STEP);
    }
    task = `${task}${TRUNCATION_MARKER}`;
  }
  if (queryFor(task).length > MAILTO_QUERY_MAX) {
    const originalCompany = company;
    while (company.length > 0 && queryFor(task).length > MAILTO_QUERY_MAX) {
      company = safeSlice(company.replace(/…$/, ''), company.length - TASK_SHRINK_STEP);
      company = company ? `${company}${TRUNCATION_MARKER}` : '';
    }
    if (company === '' && originalCompany) company = TRUNCATION_MARKER;
  }

  return `mailto:${CONTACT_EMAIL}?${queryFor(task)}`;
}

/**
 * The full, untruncated plain-text letter — same shape and field order as
 * buildMailtoUrl's body, but the task is never shortened. buildMailtoUrl
 * may have to cut it to keep the mailto: link alive in real clients (see
 * MAILTO_QUERY_MAX); this is what the success panel's "copy the full text"
 * button hands to the clipboard so nothing a visitor wrote is ever lost.
 */
export function buildEmailText(
  data: ContactFormData,
  lang: 'en' | 'ru',
  context: ContactContext = {}
): string {
  const company = singleLine(data.company.trim());
  const task = data.task.trim();
  const subject = letterSubject(company, lang);
  const body = letterBody(company, task, data, lang, context);
  return `${subject}\n\n${body}`;
}
