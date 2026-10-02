import { describe, expect, it } from 'vitest';
import { buildContactHref, contactBriefingHref, readContactContext } from '@/lib/contact-context';

describe('public service/article intake context', () => {
  it('carries a known service and briefing to either locale without carrying personal parameters', () => {
    const context = readContactContext(
      '?service=websites&source=pro&briefing=the-phone-saw-a-different-site&email=private@example.com'
    );
    expect(buildContactHref('ru', context)).toBe(
      '/ru/contact/?service=websites&source=pro&briefing=the-phone-saw-a-different-site'
    );
    expect(contactBriefingHref(context)).toBe(
      'https://vkvstudio.pro/briefings/the-phone-saw-a-different-site/'
    );
  });

  it.each([
    '?service=other',
    '?service=websites&briefing=../../private&source=pro',
    '?service=websites&source=javascript:alert(1)',
    '?service=websites&service=rag-pilot',
    '?source=pro&source=pro&briefing=ai-search-no-magic-file',
    '?briefing=%3Cscript%3Ealert(1)%3C/script%3E&source=pro',
    `?service=websites&x=${'x'.repeat(2048)}`,
  ])('does not publish unsafe or ambiguous context: %s', (search) => {
    const context = readContactContext(search);
    expect(buildContactHref('en', context)).toBe('/en/contact/');
    expect(contactBriefingHref(context)).toBeNull();
  });

  it('keeps ordinary service enquiries independent of editorial context', () => {
    const context = readContactContext(
      '?service=on-prem-ai&briefing=nemotron-active-parameters-are-not-memory'
    );
    expect(buildContactHref('en', context)).toBe('/en/contact/?service=on-prem-ai');
    expect(contactBriefingHref(context)).toBeNull();
  });
});
