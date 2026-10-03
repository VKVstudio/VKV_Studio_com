import type { Lang } from '@/i18n/utils';
import { contact as enContact, footer as enFooter } from '@/i18n/en.json';
import { contact as ruContact, footer as ruFooter } from '@/i18n/ru.json';

// Named JSON imports keep unrelated page dictionaries out of the contact client.
const contactMessages = {
  en: { contact: enContact, footer: { privacyLink: enFooter.privacyLink } },
  ru: { contact: ruContact, footer: { privacyLink: ruFooter.privacyLink } },
};

/** Contact-only translations, with the same English fallback as the site. */
export function contactText(lang: Lang, key: string): string {
  const keys = key.split('.');
  const read = (locale: Lang): string | undefined => {
    let value: unknown = contactMessages[locale];
    for (const part of keys) {
      if (!value || typeof value !== 'object' || !Object.hasOwn(value, part)) return;
      value = (value as Record<string, unknown>)[part];
    }
    return typeof value === 'string' ? value : undefined;
  };
  return read(lang) ?? read('en') ?? key;
}

const t = contactText;

export interface ContactLabels {
  replyEmail: string;
  replyEmailHint: string;
  company: string;
  companyHint: string;
  task: string;
  taskHint: string;
  budget: string;
  timeline: string;
  choose: string;
  submit: string;
  successHeading: string;
  successBody: string;
  openMail: string;
  editAnswers: string;
  replyPromise: string;
  errors: { required: string; 'too-short': string; 'too-long': string; 'invalid-email': string };
}

function contactLabels(lang: Lang): ContactLabels {
  return {
    replyEmail: t(lang, 'contact.form.replyEmail'),
    replyEmailHint: t(lang, 'contact.form.replyEmailHint'),
    company: t(lang, 'contact.form.company'),
    companyHint: t(lang, 'contact.form.companyHint'),
    task: t(lang, 'contact.form.task'),
    taskHint: t(lang, 'contact.form.taskHint'),
    budget: t(lang, 'contact.form.budget'),
    timeline: t(lang, 'contact.form.timeline'),
    choose: t(lang, 'contact.form.choose'),
    submit: t(lang, 'contact.form.submit'),
    successHeading: t(lang, 'contact.form.successHeading'),
    successBody: t(lang, 'contact.form.successBody'),
    openMail: t(lang, 'contact.form.openMail'),
    editAnswers: t(lang, 'contact.form.editAnswers'),
    replyPromise: t(lang, 'contact.replyPromise'),
    errors: {
      required: t(lang, 'contact.form.errors.required'),
      'too-short': t(lang, 'contact.form.errors.too-short'),
      'too-long': t(lang, 'contact.form.errors.too-long'),
      'invalid-email': t(lang, 'contact.form.errors.invalid-email'),
    },
  };
}

/** Shared wording for home and contact, from the same EN/RU dictionary. */
export const CONTACT_LABELS: Record<Lang, ContactLabels> = {
  en: contactLabels('en'),
  ru: contactLabels('ru'),
};
