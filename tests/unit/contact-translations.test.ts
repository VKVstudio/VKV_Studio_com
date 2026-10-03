import { describe, expect, it } from 'vitest';
import en from '@/i18n/en.json';
import { t, type Lang } from '@/i18n/utils';
import { contactText } from '@/lib/contact-labels';

function leafKeys(value: object, prefix: string): string[] {
  return Object.entries(value).flatMap(([key, child]) => {
    const path = `${prefix}.${key}`;
    return typeof child === 'string' ? [path] : leafKeys(child, path);
  });
}

describe('contact client translations', () => {
  it.each<Lang>(['en', 'ru'])('preserves all form, agent and service copy in %s', (lang) => {
    for (const key of [...leafKeys(en.contact, 'contact'), 'footer.privacyLink']) {
      expect(contactText(lang, key), key).toBe(t(lang, key));
    }
    expect(contactText(lang, 'contact.missing')).toBe('contact.missing');
  });
});
