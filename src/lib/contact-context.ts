import { z } from 'zod';
import { t, type Lang } from '@/i18n/utils';

// Use interpreted schemas under the site's enforced CSP and Trusted Types.
z.config({ jitless: true });

const serviceSchema = z.enum(['geo-audit', 'rag-pilot', 'on-prem-ai', 'websites', 'for-agencies']);
const briefingSchema = z.enum([
  'the-hundred-and-the-cache',
  'the-phone-saw-a-different-site',
  'ai-search-no-magic-file',
  'google-ai-search-controls-and-insights',
  'agents-api-still-needs-a-boundary',
  'sponsored-agents-are-still-ads',
  'shieldstral-is-a-guardrail-candidate',
  'nemotron-active-parameters-are-not-memory',
]);
const contextSchema = z.object({
  service: serviceSchema.optional(),
  source: z.literal('pro').optional(),
  briefing: briefingSchema.optional(),
});

export type ContactService = z.infer<typeof serviceSchema>;
export type ContactContext = z.infer<typeof contextSchema>;

/** Only public, fixed service/article identifiers may travel between the sites. */
export function readContactContext(search: string): ContactContext {
  if (search.length > 2048) return {};
  const params = new URLSearchParams(search);
  for (const key of ['service', 'source', 'briefing']) {
    if (params.getAll(key).length > 1) return {};
  }
  const parsed = contextSchema.safeParse({
    service: params.get('service') ?? undefined,
    source: params.get('source') ?? undefined,
    briefing: params.get('briefing') ?? undefined,
  });
  if (!parsed.success) return {};
  const context = parsed.data;
  if (context.source !== 'pro') {
    return context.service ? { service: context.service } : {};
  }
  return context;
}

export function buildContactHref(lang: Lang, context: ContactContext): string {
  const validated = contextSchema.safeParse(context);
  const params = new URLSearchParams();
  if (validated.success) {
    const { service, source, briefing } = validated.data;
    if (service) params.set('service', service);
    if (source === 'pro') {
      params.set('source', source);
      if (briefing) params.set('briefing', briefing);
    }
  }
  const query = params.toString();
  return `/${lang}/contact/${query ? `?${query}` : ''}`;
}

export function contactBriefingHref(context: ContactContext): string | null {
  const validated = contextSchema.safeParse(context);
  if (!validated.success || validated.data.source !== 'pro' || !validated.data.briefing)
    return null;
  return `https://vkvstudio.pro/briefings/${validated.data.briefing}/`;
}

export function contactContextLines(context: ContactContext, lang: Lang): string[] {
  const validated = contextSchema.safeParse(context);
  if (!validated.success) return [];
  const lines: string[] = [];
  if (validated.data.service) {
    lines.push(
      `${t(lang, 'contact.contextService')}: ${t(lang, `contact.contextServices.${validated.data.service}`)}`
    );
  }
  const briefing = contactBriefingHref(validated.data);
  if (briefing) lines.push(`${t(lang, 'contact.contextBriefing')}: ${briefing}`);
  return lines;
}
