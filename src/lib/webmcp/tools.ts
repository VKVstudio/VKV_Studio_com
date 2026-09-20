/**
 * WebMCP tool definitions — what an AI agent visiting this site can ask it.
 *
 * Every tool here is DETERMINISTIC and read-only: it answers from the same
 * arrays the pages render (SERVICES, FAQ, ENGAGEMENT_TERMS), never from the
 * model. That is the owner's cost rule made structural — the paid GPU behind
 * Synapse is gated to signed-in humans at 5 generations per 5 hours, and an
 * anonymous agent must never be able to spend it. An agent asking "what does
 * the audit cost" gets the same €900 the page shows, for free, forever.
 *
 * This module is pure and browser-free on purpose: it is imported by the
 * registration script AND by the unit tests, so the Chrome budgets below are
 * provable without a browser.
 *
 * CHROME'S BUDGETS (developer.chrome.com/docs/ai/webmcp, verified 2026-09-20)
 * are hard limits, not style advice — Chrome truncates past them:
 *   tool name        ≤  30 characters
 *   tool description ≤ 500 characters
 *   param description≤ 150 characters
 *   single output    ≤ 1500 characters
 *   4–6 tools per page
 * tests/unit/webmcp-tools.test.ts asserts all five against REAL output, with
 * no clamping anywhere: if a new deliverable pushes get_service past the
 * budget, the suite fails and a human shortens the copy. Silently truncating
 * would hand an agent a half-sentence about what a client does not get.
 */

import { SERVICES, ENGAGEMENT_TERMS, serviceUrl, type ServiceRung } from '@/data/services';
import { FAQ } from '@/data/faq';

export type Lang = 'en' | 'ru';

/** Chrome's documented ceilings. Exported so the tests read the same numbers. */
export const BUDGET = {
  name: 30,
  description: 500,
  paramDescription: 150,
  output: 1500,
  minTools: 4,
  maxTools: 6,
} as const;

/**
 * The subset of WebMCP's ToolAnnotations we actually assert. `readOnlyHint`
 * tells the agent client nothing changes, so it need not interrupt the human
 * for approval; `untrustedContentHint` tells it to treat the returned text as
 * DATA, not as instructions — the standard's own defence against a page that
 * tries to talk its way into the agent's reasoning. Everything here returns
 * our own prose, so everything here carries it.
 */
export interface ToolAnnotations {
  readOnlyHint: true;
  untrustedContentHint: true;
}

export interface WebMcpToolDef {
  name: string;
  description: string;
  inputSchema?: {
    type: 'object';
    properties: Record<string, { type: string; description: string; enum?: string[] }>;
    required?: string[];
  };
  annotations: ToolAnnotations;
  execute: (input: Record<string, unknown>) => string;
}

const ANNOTATIONS: ToolAnnotations = { readOnlyHint: true, untrustedContentHint: true };

/** The four rung ids, in ladder order — also the enum an agent may pass. */
export const SERVICE_IDS = SERVICES.map((s) => s.id);

/** Exported for the test that proves the truncation valve is still dormant. */
export const LIST_LIMIT = 8;

function rungSummary(rung: ServiceRung, lang: Lang): string {
  return `${rung.title[lang]} — ${rung.priceLine[lang]} — ${rung.timeframe[lang]}`;
}

/** Resolves the `tier` argument, or null when an agent passes something the
 *  ladder does not publish — the caller then answers with the ladder itself,
 *  which is more useful to an agent than an error it cannot act on. */
function findRung(input: Record<string, unknown>): ServiceRung | null {
  const tier = String(input['tier'] ?? '');
  return SERVICES.find((r) => r.id === tier) ?? null;
}

/**
 * Safety valve on itemized lists — high enough that nothing truncates today
 * (the longest list is on-prem-ai's seven deliverables), low enough to stop a
 * runaway array from silently blowing the output budget. Whatever it does cut
 * is announced in the reader's own language beside the rung's URL, so the cut
 * is visible to the agent rather than silent. It is the ONE clamp in this
 * module, and it is not a quiet one — the doc comment at the top of the file
 * says nothing clamps, which is true of the budget itself: no output is
 * trimmed to fit 1500 characters. `webmcp-tools.test.ts` asserts the valve is
 * dormant, so the day it engages the suite says so.
 *
 * WHY EXCLUSIONS BECAME THEIR OWN TOOL: printing deliverables and exclusions
 * in one answer came to 1815 characters for rag-pilot in Russian — 315 over
 * Chrome's ceiling, caught by the budget test on its first run. Trimming both
 * lists would have meant handing a buyer's agent a partial list of what is
 * NOT included, on the one part of the page that exists to be honest. So the
 * question was split instead, the way Chrome's own guidance recommends: two
 * complete answers rather than one truncated one. Five tools, still inside
 * the four-to-six budget.
 */
/** The overflow notice, in the reader's language. It was hardcoded English
 *  until an audit pointed out that a Russian answer would end with an English
 *  sentence the day the valve ever engages. */
const MORE_ON_PAGE: Record<Lang, (n: number) => string> = {
  en: (n) => `- (+${n} more on the page)`,
  ru: (n) => `- (ещё ${n} на странице)`,
};

function itemize(items: readonly { en: string; ru: string }[], lang: Lang): string {
  const shown = items.slice(0, LIST_LIMIT).map((i) => `- ${i[lang]}`);
  const hidden = items.length - shown.length;
  if (hidden > 0) shown.push(MORE_ON_PAGE[lang](hidden));
  return shown.join('\n');
}

const COPY = {
  en: {
    listServices: 'The service ladder, cheapest first. Ask get_service for one rung in detail.',
    detailOf:
      'Details of one service rung of VKVstudio: what it costs, how long it takes and everything delivered. For what is deliberately NOT included, call get_service_exclusions.',
    exclusionsDesc:
      'What one service rung deliberately does NOT include — the published scope limits, stated up front so a fixed price means something. Pass the rung id from list_services.',
    tierParam: 'Which rung to describe. One of: geo-audit, rag-pilot, on-prem-ai, websites.',
    queryParam: 'The buyer question to match, in plain words — e.g. "do you sign an NDA".',
    faqDesc:
      'Search the published buyer FAQ of VKVstudio and return the closest answers verbatim. Use for questions about process, contracts, data handling and guarantees.',
    termsDesc:
      'The commercial terms every engagement runs on: payment schedule, invoicing and VAT treatment, contract and NDA, and where the studio is registered.',
    delivers: 'What you get',
    excluded: 'Not included',
    price: 'Price',
    time: 'Timeframe',
    page: 'Page',
    noMatch:
      'No published FAQ entry matches that. The contact page takes written questions and answers within one business day: ',
    terms: 'Engagement terms',
  },
  ru: {
    listServices:
      'Лестница услуг, от дешёвой к дорогой. Подробности по ступени — через get_service.',
    detailOf:
      'Подробности одной ступени услуг VKVstudio: цена, сроки и всё, что входит. О том, что намеренно НЕ входит, — get_service_exclusions.',
    exclusionsDesc:
      'Что одна ступень услуг намеренно НЕ включает — опубликованные границы работ, названные заранее, чтобы фиксированная цена что-то значила. Передайте id ступени из list_services.',
    tierParam: 'Какую ступень описать. Одно из: geo-audit, rag-pilot, on-prem-ai, websites.',
    queryParam: 'Вопрос покупателя обычными словами — например, «подписываете ли вы NDA».',
    faqDesc:
      'Искать в опубликованном FAQ VKVstudio и возвращать подходящие ответы дословно. Годится для вопросов о процессе, договорах, данных и гарантиях.',
    termsDesc:
      'Коммерческие условия, на которых идёт любая работа: порядок оплаты, счета и VAT, договор и NDA, где зарегистрирована студия.',
    delivers: 'Что вы получаете',
    excluded: 'Не входит',
    price: 'Цена',
    time: 'Сроки',
    page: 'Страница',
    noMatch:
      'В опубликованном FAQ нет подходящего ответа. Письменные вопросы принимает страница контактов, ответ в течение одного рабочего дня: ',
    terms: 'Условия работы',
  },
} as const;

/**
 * Word-overlap search over the published FAQ. Deliberately not a model and
 * not an embedding: an agent asking a question must get OUR sentence back,
 * not a paraphrase of it. Returns the single best match, because two full
 * answers routinely exceed Chrome's 1500-character output budget.
 */
function searchFaq(query: string, lang: Lang): string {
  const words = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 2);

  let best: { score: number; item: (typeof FAQ)[number] } | null = null;
  for (const item of FAQ) {
    const haystack = `${item.q[lang]} ${item.a[lang]}`.toLowerCase();
    const score = words.reduce((n, w) => (haystack.includes(w) ? n + 1 : n), 0);
    if (score > 0 && (!best || score > best.score)) best = { score, item };
  }

  if (!best) return `${COPY[lang].noMatch}https://vkvstudio.com/${lang}/contact/`;
  return `${best.item.q[lang]}\n\n${best.item.a[lang]}`;
}

export function buildTools(lang: Lang): WebMcpToolDef[] {
  const c = COPY[lang];

  return [
    {
      name: 'list_services',
      description: c.listServices,
      annotations: ANNOTATIONS,
      execute: () => SERVICES.map((r) => rungSummary(r, lang)).join('\n'),
    },
    {
      name: 'get_service',
      description: c.detailOf,
      inputSchema: {
        type: 'object',
        properties: {
          tier: { type: 'string', description: c.tierParam, enum: [...SERVICE_IDS] },
        },
        required: ['tier'],
      },
      annotations: ANNOTATIONS,
      execute: (input) => {
        const rung = findRung(input);
        if (!rung) return SERVICES.map((r) => rungSummary(r, lang)).join('\n');
        return [
          rung.title[lang],
          rung.outcome[lang],
          `${c.price}: ${rung.priceLine[lang]} · ${c.time}: ${rung.timeframe[lang]}`,
          '',
          `${c.delivers}:`,
          itemize(rung.deliverables, lang),
          '',
          `${c.page}: ${serviceUrl(lang, rung.id)}`,
        ].join('\n');
      },
    },
    {
      name: 'get_service_exclusions',
      description: c.exclusionsDesc,
      inputSchema: {
        type: 'object',
        properties: {
          tier: { type: 'string', description: c.tierParam, enum: [...SERVICE_IDS] },
        },
        required: ['tier'],
      },
      annotations: ANNOTATIONS,
      execute: (input) => {
        const rung = findRung(input);
        if (!rung) return SERVICES.map((r) => rungSummary(r, lang)).join('\n');
        return [
          `${rung.title[lang]} — ${c.excluded}:`,
          itemize(rung.notIncluded, lang),
          '',
          `${c.page}: ${serviceUrl(lang, rung.id)}`,
        ].join('\n');
      },
    },
    {
      name: 'search_faq',
      description: c.faqDesc,
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string', description: c.queryParam } },
        required: ['query'],
      },
      annotations: ANNOTATIONS,
      execute: (input) => searchFaq(String(input['query'] ?? ''), lang),
    },
    {
      name: 'get_engagement_terms',
      description: c.termsDesc,
      annotations: ANNOTATIONS,
      execute: () => `${c.terms}:\n${ENGAGEMENT_TERMS.map((t) => `- ${t[lang]}`).join('\n')}`,
    },
  ];
}
