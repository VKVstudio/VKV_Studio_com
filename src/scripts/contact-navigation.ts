import { buildContactHref, readContactContext } from '@/lib/contact-context';

/** Keep only validated public context when a service opens the written intake. */
export function initServiceContactLinks(): void {
  const incoming = readContactContext(window.location.search);
  const pageService = readContactContext(
    `?service=${encodeURIComponent(window.location.pathname.split('/').filter(Boolean).at(-1) ?? '')}`
  ).service;
  const currentRoute = /^\/(en|ru)(\/.*)$/.exec(window.location.pathname);
  for (const link of document.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    const destination = new URL(link.href, window.location.origin);
    if (destination.origin !== window.location.origin) continue;
    const contact = /^\/(en|ru)\/contact\/$/.exec(destination.pathname);
    if (contact) {
      const explicit = readContactContext(destination.search).service;
      const service = explicit ?? pageService ?? incoming.service;
      const lang = contact[1] === 'ru' ? 'ru' : 'en';
      link.href = buildContactHref(lang, { ...incoming, service }) + destination.hash;
      continue;
    }
    const locale = /^\/(en|ru)(\/.*)$/.exec(destination.pathname);
    if (currentRoute && locale && currentRoute[1] !== locale[1] && currentRoute[2] === locale[2]) {
      const lang = locale[1] === 'ru' ? 'ru' : 'en';
      const query = new URL(
        buildContactHref(lang, { ...incoming, service: pageService ?? incoming.service }),
        window.location.origin
      ).search;
      link.href = destination.pathname + query + destination.hash;
    }
  }
}
