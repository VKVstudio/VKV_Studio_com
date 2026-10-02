import { PRO_PROMO_LAUNCHED, resolveLocalProPreview } from './pro-promo';
// Public readiness is per destination; the homepage switch alone enables none.
export const PRO_INSIGHTS = {
  home: {
    path: '/',
    publicReady: false,
    label: { en: 'AI Insights (.pro)', ru: 'AI Insights (.pro, EN)' },
  },
  geoGuide: {
    path: '/briefings/ai-search-no-magic-file/',
    publicReady: false,
    label: {
      en: 'What Google AI search needs from your website',
      ru: 'Что требуется сайту для AI-поиска Google (EN)',
    },
  },
  ragComparison: {
    path: null,
    publicReady: false,
    label: {
      en: 'When a document pilot is worth testing',
      ru: 'Когда стоит проверять документный пилот (EN)',
    },
  },
  localModel: {
    path: '/briefings/nemotron-active-parameters-are-not-memory/',
    publicReady: false,
    label: {
      en: 'What to measure before choosing a local model',
      ru: 'Что измерить перед выбором локальной модели (EN)',
    },
  },
} as const;
export type ProReadingId = keyof typeof PRO_INSIGHTS;
export function resolveProReading(
  id: ProReadingId,
  options: { isDev: boolean; previewBuild: boolean; launched?: boolean; localPreviewUrl?: string }
): { visible: boolean; href: string | null; label: { en: string; ru: string } } {
  const entry = PRO_INSIGHTS[id];
  const localBase =
    options.isDev || options.previewBuild ? resolveLocalProPreview(options.localPreviewUrl) : null;
  const href =
    (options.launched ?? PRO_PROMO_LAUNCHED) && entry.publicReady && entry.path
      ? 'https://vkvstudio.pro' + entry.path
      : localBase && entry.path
        ? localBase.slice(0, -1) + entry.path
        : null;
  return { visible: !!href || options.isDev || options.previewBuild, href, label: entry.label };
}
