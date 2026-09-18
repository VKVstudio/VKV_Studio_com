import en from './en.json';
import ru from './ru.json';

/** Supported languages */
export type Lang = 'en' | 'ru';

/** All translations keyed by language */
const translations: Record<Lang, typeof en> = { en, ru };

/** Default language */
export const defaultLang: Lang = 'en';

/** Supported language codes */
export const supportedLangs: Lang[] = ['en', 'ru'];

/**
 * Get translation string by dot-path key.
 * Usage: t('en', 'hero.tagline') → "From pixels to pipelines"
 */
export function t(lang: Lang, key: string): string {
  const keys = key.split('.');
  let result: unknown = translations[lang];

  for (const k of keys) {
    if (result && typeof result === 'object' && k in result) {
      result = (result as Record<string, unknown>)[k];
    } else {
      // Fallback to English if key not found
      let fallback: unknown = translations.en;
      for (const fk of keys) {
        if (fallback && typeof fallback === 'object' && fk in fallback) {
          fallback = (fallback as Record<string, unknown>)[fk];
        } else {
          return key; // Return key itself as last resort
        }
      }
      return typeof fallback === 'string' ? fallback : key;
    }
  }

  return typeof result === 'string' ? result : key;
}

/**
 * Detect language from URL path.
 * '/en/lab/tokenizer' → 'en'
 * '/ru/' → 'ru'
 * '/' → defaultLang
 */
export function getLangFromPath(path: string): Lang {
  const segments = path.split('/').filter(Boolean);
  const first = segments[0] as Lang;
  return supportedLangs.includes(first) ? first : defaultLang;
}

/**
 * Get the alternate language (for language switcher).
 */
export function getAltLang(lang: Lang): Lang {
  return lang === 'en' ? 'ru' : 'en';
}

/**
 * Build localized path.
 * localizedPath('ru', '/lab/tokenizer') → '/ru/lab/tokenizer'
 */
export function localizedPath(lang: Lang, path: string): string {
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  return `/${lang}${cleanPath}`;
}
