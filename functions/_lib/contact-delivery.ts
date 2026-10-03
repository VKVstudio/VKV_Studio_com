import { z } from 'zod';
import {
  contactRelayConfigured,
  contactRelayReady,
  deliverContactRelay,
  type ContactRelayEnvironment,
  type ContactReadinessDiagnostic,
} from './contact-relay';

z.config({ jitless: true });

const MAX_BODY_BYTES = 16_384;
const ALLOWED_HOSTS = new Set(['vkvstudio.com', 'www.vkvstudio.com']);
const RECIPIENT = 'valerii@vkvstudio.com';
const SENDER = 'enquiries@vkvstudio.com';
const CHALLENGE_ACTION = 'project_enquiry';
const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

// One failure event per minute per isolate, independent of public request volume.
let lastReadinessDiagnostic: number | undefined;

function logReadinessDiagnostic(event: ContactReadinessDiagnostic): void {
  const now = Date.now();
  if (lastReadinessDiagnostic !== undefined && now - lastReadinessDiagnostic < 60_000) return;
  lastReadinessDiagnostic = now;
  // Only constant codes, allowlisted error types and numeric HTTP status reach logs.
  console.warn(
    '[contact-readiness]',
    event.code,
    'status' in event ? event.status : 'errorType' in event ? event.errorType : ''
  );
}

export interface ContactRateLimit {
  limit(input: { key: string }): Promise<{ success: boolean }>;
}

/** Secrets are runtime bindings, never browser configuration or build inputs. */
export interface ContactEnvironment extends ContactRelayEnvironment {
  CONTACT_EMAIL_ACCOUNT_ID?: string;
  CONTACT_EMAIL_API_TOKEN?: string;
  CONTACT_EMAIL_SENDING_READY?: string;
  CONTACT_TURNSTILE_SITE_KEY?: string;
  CONTACT_TURNSTILE_SECRET?: string;
  CONTACT_EDGE_RATE_LIMIT_READY?: string;
  CONTACT_RATE_LIMIT?: ContactRateLimit;
}

const contextSchema = z
  .object({
    service: z
      .enum(['geo-audit', 'rag-pilot', 'on-prem-ai', 'websites', 'for-agencies'])
      .optional(),
    source: z.literal('pro').optional(),
    briefing: z
      .enum([
        'the-hundred-and-the-cache',
        'the-phone-saw-a-different-site',
        'ai-search-no-magic-file',
        'google-ai-search-controls-and-insights',
        'agents-api-still-needs-a-boundary',
        'sponsored-agents-are-still-ads',
        'shieldstral-is-a-guardrail-candidate',
        'nemotron-active-parameters-are-not-memory',
      ])
      .optional(),
  })
  .strict()
  .refine((context) => !context.briefing || context.source === 'pro');

// This is independent of the browser schema. No user input controls an email
// recipient, sender, URL, subject, header name, attachment or HTML template.
const enquirySchema = z
  .object({
    replyEmail: z
      .email()
      .max(254)
      .regex(/^[\x21-\x7e]+$/),
    company: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .regex(/^[^\x00-\x1f\x7f]+$/),
    task: z
      .string()
      .transform((value) => value.replace(/\r\n?/g, '\n').trim())
      .pipe(
        z
          .string()
          .min(20)
          .max(2000)
          .regex(/^[^\x00-\x08\x0b\x0c\x0e-\x1f\x7f]+$/)
      ),
    budget: z.enum(['audit-900', 'under-5k', '5k-10k', '10k-plus', 'monthly-retainer', 'not-sure']),
    timeline: z.enum(['asap', 'this-quarter', 'exploring']),
    lang: z.enum(['en', 'ru']),
    context: contextSchema,
    website: z.string().max(200),
    turnstileToken: z.string().min(1).max(2048),
    requestId: z.uuid(),
  })
  .strict();

const challengeSchema = z.object({
  success: z.boolean(),
  hostname: z.string().optional(),
  action: z.string().optional(),
});

const deliverySchema = z.object({
  success: z.boolean(),
  errors: z.array(z.unknown()).optional(),
  result: z
    .object({
      delivered: z.array(z.string()).max(10),
      queued: z.array(z.string()).max(10),
      permanent_bounces: z.array(z.string()).max(10),
      suppressed_recipients: z.array(z.string()).max(10).optional(),
    })
    .nullable(),
});

type Enquiry = z.infer<typeof enquirySchema>;

function reply(
  status: number,
  payload: object,
  extraHeaders: Record<string, string> = {}
): Response {
  return Response.json(payload, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      'X-Frame-Options': 'DENY',
      'Cross-Origin-Resource-Policy': 'same-origin',
      ...extraHeaders,
    },
  });
}

function unavailable(): Response {
  return reply(503, { ok: false, code: 'unavailable' });
}

function configured(env: ContactEnvironment): boolean {
  return (
    (env.CONTACT_DELIVERY_TRANSPORT === 'workspace-relay'
      ? contactRelayConfigured(env)
      : (env.CONTACT_DELIVERY_TRANSPORT === undefined ||
          env.CONTACT_DELIVERY_TRANSPORT === 'cloudflare-email') &&
        env.CONTACT_EMAIL_SENDING_READY === 'true' &&
        /^[a-f\d]{32}$/i.test(env.CONTACT_EMAIL_ACCOUNT_ID ?? '') &&
        !!env.CONTACT_EMAIL_API_TOKEN?.trim()) &&
    /^[a-z\d_-]{10,100}$/i.test(env.CONTACT_TURNSTILE_SITE_KEY ?? '') &&
    !!env.CONTACT_TURNSTILE_SECRET?.trim() &&
    (typeof env.CONTACT_RATE_LIMIT?.limit === 'function' ||
      env.CONTACT_EDGE_RATE_LIMIT_READY === 'true')
  );
}

/** Bound bytes and wall time even when Content-Length is absent or dishonest. */
async function boundedJson(response: Request | Response, maxBytes: number): Promise<unknown> {
  const length = response.headers.get('Content-Length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes)) {
    throw new RangeError('body-limit');
  }
  if (!response.body) throw new SyntaxError('empty-body');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('body-timeout')), 3000);
  });
  try {
    while (true) {
      const part = await Promise.race([reader.read(), timeout]);
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > maxBytes) throw new RangeError('body-limit');
      chunks.push(part.value);
    }
    const buffer = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      buffer.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer)) as unknown;
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
}

function emailBody(enquiry: Enquiry): string {
  const context = [
    enquiry.context.service ? `Service: ${enquiry.context.service}` : '',
    enquiry.context.source === 'pro' ? 'Source: VKVstudio.pro' : '',
    enquiry.context.briefing
      ? `Briefing: https://vkvstudio.pro/briefings/${enquiry.context.briefing}/`
      : '',
  ].filter(Boolean);
  return [
    `Enquiry ID: ${enquiry.requestId}`,
    `Reply address: ${enquiry.replyEmail}`,
    `Language: ${enquiry.lang}`,
    `Company: ${enquiry.company}`,
    `Budget: ${enquiry.budget}`,
    `Timeline: ${enquiry.timeline}`,
    ...context,
    '',
    enquiry.task,
  ].join('\n');
}

/** No CORS, enquiry logging, storage, automatic retry or fallback recipient. */
export async function handleContactRequest(
  request: Request,
  env: ContactEnvironment,
  requestFetch: typeof fetch = fetch
): Promise<Response> {
  const url = new URL(request.url);
  if (url.protocol !== 'https:' || !ALLOWED_HOSTS.has(url.hostname) || url.port !== '') {
    return reply(403, { ok: false, code: 'forbidden' });
  }
  if (request.method !== 'GET' && request.method !== 'POST') {
    return reply(405, { ok: false, code: 'method' }, { Allow: 'GET, POST' });
  }
  if (request.method === 'GET') {
    if (!configured(env)) {
      logReadinessDiagnostic({ code: 'config-invalid' });
      return unavailable();
    }
    const ready =
      env.CONTACT_DELIVERY_TRANSPORT !== 'workspace-relay' ||
      (await contactRelayReady(env, requestFetch, logReadinessDiagnostic));
    return ready ? reply(200, { siteKey: env.CONTACT_TURNSTILE_SITE_KEY }) : unavailable();
  }
  if (
    request.headers.get('Origin') !== url.origin ||
    (request.headers.has('Sec-Fetch-Site') &&
      request.headers.get('Sec-Fetch-Site') !== 'same-origin')
  ) {
    return reply(403, { ok: false, code: 'forbidden' });
  }
  if (
    !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('Content-Type') ?? '')
  ) {
    return reply(415, { ok: false, code: 'content-type' });
  }
  if (!configured(env)) return unavailable();

  // Cloudflare sets this at ingress. Do not accept a client X-Forwarded-For.
  const ip = request.headers.get('CF-Connecting-IP');
  if (!ip || ip.length > 64 || !/^[a-f\d:.]+$/i.test(ip)) return unavailable();
  if (env.CONTACT_RATE_LIMIT) {
    try {
      const allowed = await env.CONTACT_RATE_LIMIT.limit({ key: `contact:${ip}` });
      if (!allowed.success) {
        return reply(429, { ok: false, code: 'rate-limit' }, { 'Retry-After': '60' });
      }
    } catch {
      return unavailable();
    }
  }

  let input: unknown;
  try {
    input = await boundedJson(request, MAX_BODY_BYTES);
  } catch (error) {
    return reply(error instanceof RangeError ? 413 : 400, { ok: false, code: 'invalid' });
  }
  const parsed = enquirySchema.safeParse(input);
  if (!parsed.success) return reply(422, { ok: false, code: 'invalid' });
  const enquiry = parsed.data;
  if (enquiry.website.trim() !== '') return reply(422, { ok: false, code: 'verification' });
  if (
    env.CONTACT_DELIVERY_TRANSPORT === 'workspace-relay' &&
    !(await contactRelayReady(env, requestFetch))
  )
    return unavailable();

  try {
    const verification = await requestFetch(SITEVERIFY_URL, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        secret: env.CONTACT_TURNSTILE_SECRET,
        response: enquiry.turnstileToken,
        remoteip: ip,
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!verification.ok) return unavailable();
    const challenge = challengeSchema.safeParse(await boundedJson(verification, 8192));
    if (
      !challenge.success ||
      !challenge.data.success ||
      challenge.data.hostname !== url.hostname ||
      challenge.data.action !== CHALLENGE_ACTION
    ) {
      return reply(422, { ok: false, code: 'verification' });
    }
  } catch {
    return unavailable();
  }

  if (env.CONTACT_DELIVERY_TRANSPORT === 'workspace-relay') {
    const result = await deliverContactRelay(
      env,
      {
        requestId: enquiry.requestId,
        replyEmail: enquiry.replyEmail,
        text: emailBody(enquiry),
      },
      requestFetch
    );
    if (result === 'queued')
      return reply(202, { ok: true, status: 'queued', requestId: enquiry.requestId });
    if (result === 'rate-limit')
      return reply(429, { ok: false, code: 'rate-limit' }, { 'Retry-After': '60' });
    if (result === 'unavailable') return unavailable();
    return reply(result === 'conflict' ? 409 : 502, { ok: false, code: 'delivery-unknown' });
  }

  // Do not use Siteverify idempotency_key: it could accept a replayed token
  // and cause a duplicate mail without a durable mail-idempotency record.
  try {
    const delivery = await requestFetch(
      `https://api.cloudflare.com/client/v4/accounts/${env.CONTACT_EMAIL_ACCOUNT_ID}/email/sending/send`,
      {
        method: 'POST',
        redirect: 'manual',
        headers: {
          Authorization: `Bearer ${env.CONTACT_EMAIL_API_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: SENDER,
          to: RECIPIENT,
          reply_to: enquiry.replyEmail,
          subject: 'VKVstudio project enquiry',
          text: emailBody(enquiry),
        }),
        signal: AbortSignal.timeout(8000),
      }
    );
    if (delivery.status === 429) {
      return reply(429, { ok: false, code: 'rate-limit' }, { 'Retry-After': '60' });
    }
    if (!delivery.ok) {
      return delivery.status >= 500
        ? reply(502, { ok: false, code: 'delivery-unknown' })
        : unavailable();
    }
    const result = deliverySchema.safeParse(await boundedJson(delivery, 16_384));
    if (!result.success) return reply(502, { ok: false, code: 'delivery-unknown' });
    const receipt = result.data.result;
    if (!result.data.success || !receipt || result.data.errors?.length) return unavailable();
    if (
      receipt.permanent_bounces.includes(RECIPIENT) ||
      receipt.suppressed_recipients?.includes(RECIPIENT)
    ) {
      return reply(502, { ok: false, code: 'delivery-failed' });
    }
    const delivered = receipt.delivered.includes(RECIPIENT);
    const queued = receipt.queued.includes(RECIPIENT);
    if (!delivered && !queued) return reply(502, { ok: false, code: 'delivery-unknown' });
    return reply(202, {
      ok: true,
      status: delivered ? 'delivered' : 'queued',
      requestId: enquiry.requestId,
    });
  } catch {
    // A timeout may happen after acceptance. Never retry or say "not sent".
    return reply(502, { ok: false, code: 'delivery-unknown' });
  }
}
