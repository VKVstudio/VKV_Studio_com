/**
 * JSON-LD builders for the services pages — kept out of the page files so the
 * four rung pages stay thin wrappers and the graph rules live in one place.
 *
 * House rules (see the tokenizer page's inline history for why):
 * - provider/author are `@id` references into BaseLayout's graph, never a
 *   fresh inline Person — inlining once created two "Valerii" entities.
 * - No aggregateRating/review, ever: inventing ratings is spam markup.
 */
import type { Lang } from '@i18n/utils';
import { t } from '@i18n/utils';
import type { FaqItem } from '@/data/faq';
import { SITE_ORIGIN, serviceUrl, type ServiceRung } from '@/data/services';

const PERSON_ID = `${SITE_ORIGIN}/#person`;
const ORGANIZATION_ID = `${SITE_ORIGIN}/#organization`;

type JsonLd = Record<string, unknown>;

export function faqPageNode(lang: Lang, items: FaqItem[]): JsonLd {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: items.map((item) => ({
      '@type': 'Question',
      name: item.q[lang],
      acceptedAnswer: { '@type': 'Answer', text: item.a[lang] },
    })),
  };
}

export function breadcrumbNode(lang: Lang, trail: Array<{ name: string; item: string }>): JsonLd {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: trail.map((step, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: step.name,
      item: step.item,
    })),
  };
}

/** BreadcrumbList for a page under /services/. */
export function servicesBreadcrumb(lang: Lang, pageName: string, pageUrl: string): JsonLd {
  return breadcrumbNode(lang, [
    { name: t(lang, 'nav.home'), item: `${SITE_ORIGIN}/${lang}/` },
    { name: t(lang, 'nav.services'), item: `${SITE_ORIGIN}/${lang}/services/` },
    { name: pageName, item: pageUrl },
  ]);
}

/** The Service node for one rung, with a fixed price or a from-price. */
export function serviceNode(lang: Lang, rung: ServiceRung, opts?: { embedded?: boolean }): JsonLd {
  const url = serviceUrl(lang, rung.id);
  const priceJsonLd = rung.priceJsonLd;
  const offer: JsonLd =
    'price' in priceJsonLd
      ? {
          '@type': 'Offer',
          price: priceJsonLd.price,
          priceCurrency: priceJsonLd.currency,
          url,
          availability: 'https://schema.org/InStock',
        }
      : {
          // AggregateOffer, not a bare PriceSpecification: the range form is
          // what search engines actually read, so the two ranged rungs stopped
          // showing a price their cards state in plain text.
          '@type': 'AggregateOffer',
          url,
          availability: 'https://schema.org/InStock',
          lowPrice: priceJsonLd.minPrice,
          ...(priceJsonLd.maxPrice ? { highPrice: priceJsonLd.maxPrice } : {}),
          priceCurrency: priceJsonLd.currency,
        };

  // The retainer gets its own Offer when it carries a machine-readable
  // price — a monthly UnitPriceSpecification alongside the rung's own
  // fixed/from-price Offer, so a search engine can see both the entry
  // package and the recurring engine behind it.
  const retainerPrice = rung.retainer?.priceJsonLd;
  const offers: JsonLd | JsonLd[] = retainerPrice
    ? [
        offer,
        {
          '@type': 'Offer',
          name: rung.retainer?.title[lang],
          url,
          availability: 'https://schema.org/InStock',
          priceSpecification: {
            '@type': 'UnitPriceSpecification',
            minPrice: retainerPrice.minPrice,
            ...(retainerPrice.maxPrice ? { maxPrice: retainerPrice.maxPrice } : {}),
            priceCurrency: 'EUR',
            unitCode: 'MON',
          },
        },
      ]
    : offer;

  return {
    // A node nested inside another block inherits its @context; repeating it
    // there signals a second root document.
    ...(opts?.embedded ? {} : { '@context': 'https://schema.org' }),
    '@type': 'Service',
    name: rung.title[lang],
    serviceType: rung.title.en,
    description: rung.seo.description[lang],
    url,
    provider: { '@id': PERSON_ID },
    areaServed: ['Europe', 'United Kingdom'],
    offers,
  };
}

/**
 * TechArticle node for a standalone explainer page (currently only
 * /services/geo-methodology/) — distinct from serviceNode()/rungJsonLd()
 * because a methodology page sells no offer of its own. author/publisher are
 * the same @id-reference pattern as every other node here, never an inlined
 * Person/Organization — mirrors the Article node shape on the case pages
 * (src/pages/[lang]/cases/synapse/index.astro) so every article-like node on
 * the site carries the same fields.
 *
 * `lang` and `image` are optional so existing call sites keep compiling; pass
 * both from any new caller — omitting them ships a TechArticle ineligible for
 * Article rich results (no image) and indistinguishable from its other-locale
 * twin except by URL (no inLanguage).
 */
export function techArticleNode(opts: {
  headline: string;
  description: string;
  url: string;
  datePublished: string;
  dateModified?: string;
  lang?: Lang;
  image?: string;
}): JsonLd {
  return {
    '@context': 'https://schema.org',
    '@type': 'TechArticle',
    headline: opts.headline,
    description: opts.description,
    url: opts.url,
    mainEntityOfPage: opts.url,
    author: { '@id': PERSON_ID },
    publisher: { '@id': ORGANIZATION_ID },
    datePublished: opts.datePublished,
    ...(opts.dateModified ? { dateModified: opts.dateModified } : {}),
    ...(opts.image ? { image: opts.image } : {}),
    ...(opts.lang ? { inLanguage: opts.lang } : {}),
  };
}

/** The standard node set for a rung page. */
export function rungJsonLd(lang: Lang, rung: ServiceRung, faqItems?: FaqItem[]): JsonLd[] {
  const nodes: JsonLd[] = [
    serviceNode(lang, rung),
    servicesBreadcrumb(lang, rung.title[lang], serviceUrl(lang, rung.id)),
  ];
  if (faqItems) nodes.push(faqPageNode(lang, faqItems));
  return nodes;
}
