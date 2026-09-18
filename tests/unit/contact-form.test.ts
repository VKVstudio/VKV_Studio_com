/**
 * /contact/ funnel logic — no server exists to catch a mistake here (CSP is
 * `form-action 'none'`), so validate() and the two link builders are the
 * entire safety net between a typo and a lost enquiry.
 */
import { describe, it, expect } from 'vitest';
import {
  validate,
  isValid,
  isGateTripped,
  MIN_FILL_MS,
  buildMailtoUrl,
  buildEmailText,
  buildCalUrl,
  MAILTO_QUERY_MAX,
  BUDGET_OPTIONS,
  TIMELINE_OPTIONS,
  type ContactFormData,
} from '@/lib/contact-form';
import { CAL_BOOKING_URL, CONTACT_EMAIL } from '@/lib/site-config';

const validTask = 'We need a RAG assistant over our internal policy docs.'; // > 20 chars

function baseData(overrides: Partial<ContactFormData> = {}): ContactFormData {
  return {
    company: 'Acme Ltd',
    task: validTask,
    budget: '5k-10k',
    timeline: 'this-quarter',
    ...overrides,
  };
}

describe('validate', () => {
  it('returns {} for fully valid data', () => {
    expect(validate(baseData())).toEqual({});
  });

  it('flags an empty company as required', () => {
    expect(validate(baseData({ company: '' })).company).toBe('required');
  });

  it('flags a whitespace-only company as required, not too-long', () => {
    expect(validate(baseData({ company: '   ' })).company).toBe('required');
  });

  it('flags a company over 200 chars as too-long', () => {
    const company = 'a'.repeat(201);
    expect(validate(baseData({ company })).company).toBe('too-long');
  });

  it('accepts a company at exactly 200 chars', () => {
    const company = 'a'.repeat(200);
    expect(validate(baseData({ company })).company).toBeUndefined();
  });

  it('flags an empty task as required', () => {
    expect(validate(baseData({ task: '' })).task).toBe('required');
  });

  it('flags a whitespace-only task as required, not too-short', () => {
    expect(validate(baseData({ task: '                    ' })).task).toBe('required');
  });

  it('flags a 19-char task as too-short', () => {
    const task = 'a'.repeat(19);
    expect(validate(baseData({ task })).task).toBe('too-short');
  });

  it('accepts a 20-char task', () => {
    const task = 'a'.repeat(20);
    expect(validate(baseData({ task })).task).toBeUndefined();
  });

  it('flags a task over 2000 chars as too-long', () => {
    const task = 'a'.repeat(2001);
    expect(validate(baseData({ task })).task).toBe('too-long');
  });

  it('accepts a task at exactly 2000 chars', () => {
    const task = 'a'.repeat(2000);
    expect(validate(baseData({ task })).task).toBeUndefined();
  });

  it('flags an unchosen budget as required', () => {
    expect(validate(baseData({ budget: '' })).budget).toBe('required');
  });

  it('flags an unchosen timeline as required', () => {
    expect(validate(baseData({ timeline: '' })).timeline).toBe('required');
  });

  it('trims leading/trailing whitespace before measuring length', () => {
    const company = `  ${'a'.repeat(200)}  `;
    expect(validate(baseData({ company })).company).toBeUndefined();
  });
});

describe('isValid', () => {
  it('is true for an empty error object', () => {
    expect(isValid({})).toBe(true);
  });

  it('is false when any field carries an error', () => {
    expect(isValid({ company: 'required' })).toBe(false);
    expect(isValid({ budget: 'required' })).toBe(false);
  });
});

describe('isGateTripped', () => {
  it('is false for an empty honeypot regardless of elapsed time', () => {
    expect(isGateTripped('', 5000)).toBe(false);
    expect(isGateTripped('', 50)).toBe(false);
  });

  it('is false for a whitespace-only honeypot (mirrors company/task trimming)', () => {
    expect(isGateTripped('   ', 5000)).toBe(false);
  });

  it('is true for a filled honeypot regardless of elapsed time', () => {
    expect(isGateTripped('http://spam.example', 5000)).toBe(true);
    expect(isGateTripped('x', 50)).toBe(true);
  });

  it('never gates on a fast fill alone — a valid human submit must never be silently blocked', () => {
    // A quick but legitimate fill (autofill, paste, a keyboard user tabbing
    // straight through) must not be treated as a bot on speed alone.
    expect(isGateTripped('', 1)).toBe(false);
  });

  it('MIN_FILL_MS is the documented three-second floor', () => {
    expect(MIN_FILL_MS).toBe(3000);
  });
});

describe('buildMailtoUrl', () => {
  it('starts with mailto: to the configured contact address', () => {
    const url = buildMailtoUrl(baseData(), 'en');
    expect(url.startsWith(`mailto:${CONTACT_EMAIL}?`)).toBe(true);
    expect(url.startsWith('mailto:hello@')).toBe(true);
  });

  it('encodes an EN subject line with the company name', () => {
    const url = buildMailtoUrl(baseData({ company: 'Acme Ltd' }), 'en');
    expect(url).toContain(`subject=${encodeURIComponent('Project inquiry — Acme Ltd')}`);
  });

  it('encodes a RU subject line with the company name', () => {
    const url = buildMailtoUrl(baseData({ company: 'ООО Ромашка' }), 'ru');
    expect(url).toContain(`subject=${encodeURIComponent('Запрос по проекту — ООО Ромашка')}`);
  });

  it('joins the body with real newlines before encoding, producing %0A', () => {
    const url = buildMailtoUrl(baseData(), 'en');
    const bodyParam = url.split('body=')[1];
    expect(bodyParam).toBeDefined();
    expect(bodyParam).toContain('%0A');
  });

  it('encodes Cyrillic body content for lang=ru', () => {
    const url = buildMailtoUrl(baseData(), 'ru');
    // The RU field label "Бюджет" must appear percent-encoded in the body.
    expect(url).toContain(encodeURIComponent('Бюджет'));
  });

  it('renders the budget as its human label, not the raw enum value', () => {
    const url = buildMailtoUrl(baseData({ budget: 'monthly-retainer' }), 'en');
    const label = BUDGET_OPTIONS.find((o) => o.value === 'monthly-retainer')!.en;
    expect(url).toContain(encodeURIComponent(label));
    expect(url).not.toContain(encodeURIComponent('monthly-retainer'));
  });

  it('renders the timeline as its human label, not the raw enum value', () => {
    const url = buildMailtoUrl(baseData({ timeline: 'exploring' }), 'en');
    const label = TIMELINE_OPTIONS.find((o) => o.value === 'exploring')!.en;
    expect(url).toContain(encodeURIComponent(label));
  });

  it('does not truncate a short task and appends no marker', () => {
    const url = buildMailtoUrl(baseData(), 'en');
    const bodyParam = decodeURIComponent(url.split('body=')[1] ?? '');
    expect(bodyParam).toContain(validTask);
    expect(bodyParam).not.toContain('…');
  });

  it('shrinks a 2000-char Cyrillic task so the encoded query stays under MAILTO_QUERY_MAX, and the URL stays well under real mail clients’ ~2000-char cliff', () => {
    const task = 'Обеспечьте пожалуйста подробное техническое задание для '
      .repeat(50)
      .slice(0, 2000);
    const url = buildMailtoUrl(baseData({ task }), 'ru');
    const query = url.split('mailto:')[1]?.split('?').slice(1).join('?') ?? '';

    expect(query.length).toBeLessThanOrEqual(MAILTO_QUERY_MAX);
    expect(url.length).toBeLessThan(2100);

    const bodyParam = decodeURIComponent(url.split('body=')[1] ?? '');
    expect(bodyParam.endsWith('…')).toBe(true);
  });

  it('buildEmailText carries the full, untruncated task the mailto link had to shrink', () => {
    const task = 'Обеспечьте пожалуйста подробное техническое задание для '
      .repeat(50)
      .slice(0, 2000);
    const url = buildMailtoUrl(baseData({ task }), 'ru');
    const bodyParam = decodeURIComponent(url.split('body=')[1] ?? '');
    expect(bodyParam).not.toContain(task); // the mailto body was shortened

    const fullText = buildEmailText(baseData({ task }), 'ru');
    expect(fullText).toContain(task);
  });

  it('never smuggles CR/LF from the company field into the encoded subject/body', () => {
    const url = buildMailtoUrl(baseData({ company: 'Acme\r\nBcc: evil@example.com' }), 'en');
    expect(url).not.toContain('%0D%0A');
    // The company value is flattened onto one line rather than removed —
    // it still reads, just never as a second "line" a mail client renders.
    expect(decodeURIComponent(url.split('body=')[1] ?? '')).toContain(
      'Company: Acme Bcc: evil@example.com'
    );
  });
});

describe('buildEmailText', () => {
  it('contains the subject line and all four field labels with their values', () => {
    const text = buildEmailText(baseData({ company: 'Acme Ltd' }), 'en');
    expect(text).toContain('Project inquiry — Acme Ltd');
    expect(text).toContain('Company: Acme Ltd');
    expect(text).toContain(`Task: ${validTask}`);
    expect(text).toContain('Budget:');
    expect(text).toContain('Timeline:');
  });

  it('never truncates the task regardless of length', () => {
    const task = 'x'.repeat(2000);
    const text = buildEmailText(baseData({ task }), 'en');
    expect(text).toContain(task);
    expect(text).not.toContain('…');
  });

  it('collapses CR/LF in the company field, same as buildMailtoUrl', () => {
    const text = buildEmailText(baseData({ company: 'Acme\r\nBcc: evil@example.com' }), 'en');
    expect(text).not.toMatch(/Acme\r\n/);
    expect(text).toContain('Company: Acme Bcc: evil@example.com');
  });
});

describe('buildCalUrl', () => {
  it('starts with the configured Cal.com booking URL', () => {
    const url = buildCalUrl(baseData(), 'en');
    expect(url.startsWith(CAL_BOOKING_URL)).toBe(true);
    expect(url.startsWith(`${CAL_BOOKING_URL}?notes=`)).toBe(true);
  });

  it('encodes the notes summary', () => {
    const url = buildCalUrl(baseData({ company: 'Acme & Sons' }), 'en');
    expect(url).toContain(encodeURIComponent('Acme & Sons'));
    expect(url).not.toContain('Acme & Sons');
  });

  it('truncates the task to the first 200 chars in the notes summary', () => {
    const task = `${'x'.repeat(250)} rest of the sentence that should be cut off`;
    const url = buildCalUrl(baseData({ task }), 'en');
    const decoded = decodeURIComponent(url.split('notes=')[1] ?? '');
    expect(decoded).toContain('x'.repeat(200));
    expect(decoded).not.toContain('x'.repeat(201));
  });

  it('includes company, budget label, and timeline label in the summary', () => {
    const url = buildCalUrl(
      baseData({ company: 'Acme Ltd', budget: 'audit-900', timeline: 'asap' }),
      'en'
    );
    const decoded = decodeURIComponent(url.split('notes=')[1] ?? '');
    expect(decoded).toContain('Acme Ltd');
    expect(decoded).toContain(BUDGET_OPTIONS.find((o) => o.value === 'audit-900')!.en);
    expect(decoded).toContain(TIMELINE_OPTIONS.find((o) => o.value === 'asap')!.en);
  });

  it('never smuggles CR/LF from the company field into the encoded notes param', () => {
    const url = buildCalUrl(baseData({ company: 'Acme\r\nBcc: evil@example.com' }), 'en');
    expect(url).not.toContain('%0D%0A');
  });

  it('collapses CR/LF from the task excerpt too', () => {
    const url = buildCalUrl(
      baseData({ task: 'Line one\r\nLine two, still part of the same task.' }),
      'en'
    );
    expect(url).not.toContain('%0D%0A');
    const decoded = decodeURIComponent(url.split('notes=')[1] ?? '');
    expect(decoded).toContain('Line one Line two');
  });
});

describe('content rules', () => {
  it('never uses a dollar sign in budget or timeline labels', () => {
    const dump = JSON.stringify([...BUDGET_OPTIONS, ...TIMELINE_OPTIONS]);
    expect(dump).not.toContain('$');
  });

  it('never mentions Stripe (unavailable to Armenian sole proprietors)', () => {
    const dump = JSON.stringify([...BUDGET_OPTIONS, ...TIMELINE_OPTIONS]);
    expect(dump).not.toMatch(/stripe/i);
  });

  it('uses gender-neutral RU wording for the "not sure" budget option (no bureaucratic parenthesis)', () => {
    const option = BUDGET_OPTIONS.find((o) => o.value === 'not-sure');
    expect(option?.ru).toBe('Пока не знаю');
    expect(option?.ru).not.toMatch(/\(а\)/);
  });
});
