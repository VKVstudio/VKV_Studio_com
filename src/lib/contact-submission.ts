import { z } from 'zod';
import { validate, type ContactFormData, type FieldErrors } from './contact-form';
import type { ContactContext } from './contact-context';

z.config({ jitless: true });

export type ReplyEmailError = 'required' | 'invalid-email';
export type ContactSubmissionErrors = FieldErrors & { replyEmail?: ReplyEmailError };
export type ContactDeliveryCode =
  | 'invalid'
  | 'verification'
  | 'rate-limit'
  | 'unavailable'
  | 'delivery-failed'
  | 'delivery-unknown';

export interface ContactSubmission extends ContactFormData {
  replyEmail: string;
  lang: 'en' | 'ru';
  context: ContactContext;
  website: string;
  turnstileToken: string;
  requestId: string;
}

export type ContactDeliveryResult =
  | { ok: true; status: 'delivered' | 'queued'; requestId: string }
  | { ok: false; code: ContactDeliveryCode };

const emailSchema = z
  .email()
  .max(254)
  .regex(/^[\x21-\x7e]+$/);
const resultSchema = z.discriminatedUnion('ok', [
  z
    .object({ ok: z.literal(true), status: z.enum(['delivered', 'queued']), requestId: z.uuid() })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      code: z.enum([
        'invalid',
        'verification',
        'rate-limit',
        'unavailable',
        'delivery-failed',
        'delivery-unknown',
      ]),
    })
    .strict(),
]);

export function validateSubmission(
  data: ContactFormData,
  replyEmail: string
): ContactSubmissionErrors {
  const errors: ContactSubmissionErrors = { ...validate(data) };
  if (!replyEmail.trim()) errors.replyEmail = 'required';
  else if (!emailSchema.safeParse(replyEmail.trim()).success) errors.replyEmail = 'invalid-email';
  return errors;
}

/** Exactly one POST. An unknown receipt must never be treated as success. */
export async function submitContactEnquiry(
  input: ContactSubmission,
  requestFetch: typeof fetch = fetch
): Promise<ContactDeliveryResult> {
  if (
    Object.keys(validateSubmission(input, input.replyEmail)).length !== 0 ||
    !z.uuid().safeParse(input.requestId).success
  ) {
    return { ok: false, code: 'invalid' };
  }
  if (!input.turnstileToken || input.website.trim()) return { ok: false, code: 'verification' };
  try {
    const response = await requestFetch('/api/contact', {
      method: 'POST',
      credentials: 'same-origin',
      redirect: 'error',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...input, replyEmail: input.replyEmail.trim() }),
      signal: AbortSignal.timeout(22_000),
    });
    if (response.status === 404 || response.status === 405) {
      return { ok: false, code: 'unavailable' };
    }
    const result = resultSchema.safeParse((await response.json()) as unknown);
    if (!result.success) return { ok: false, code: 'delivery-unknown' };
    if (result.data.ok && (!response.ok || result.data.requestId !== input.requestId)) {
      return { ok: false, code: 'delivery-unknown' };
    }
    return result.data;
  } catch {
    // The server may already have sent the message. Do not retry this POST.
    return { ok: false, code: 'delivery-unknown' };
  }
}

export async function loadContactSiteKey(
  requestFetch: typeof fetch = fetch
): Promise<string | null> {
  try {
    const response = await requestFetch('/api/contact', {
      credentials: 'same-origin',
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return null;
    const parsed = z
      .object({ siteKey: z.string().regex(/^[a-z\d_-]{10,100}$/i) })
      .strict()
      .safeParse((await response.json()) as unknown);
    return parsed.success ? parsed.data.siteKey : null;
  } catch {
    return null;
  }
}

/** A failed GET can recover on the next interaction; only success is cached. */
export function createContactSiteKeyLoader(
  requestFetch: typeof fetch = fetch
): () => Promise<string | null> {
  let siteKey: string | null = null;
  let pending: Promise<string | null> | null = null;
  return (): Promise<string | null> => {
    if (siteKey) return Promise.resolve(siteKey);
    if (pending) return pending;
    const loading = loadContactSiteKey(requestFetch);
    pending = loading;
    void loading.then((value) => {
      if (value) siteKey = value;
      if (pending === loading) pending = null;
    });
    return loading;
  };
}

interface TurnstileOptions {
  sitekey: string;
  action: 'project_enquiry';
  theme: 'dark';
  size: 'compact';
  language: 'en' | 'ru';
  'response-field': false;
  callback: (token: string) => void;
  'expired-callback': () => void;
  'error-callback': () => void;
}

interface TurnstileApi {
  render(container: HTMLElement, options: TurnstileOptions): string | undefined;
  reset(widget: string): void;
  remove(widget: string): void;
}

export interface ContactChallenge {
  reset(): void;
  destroy(): void;
}

let turnstilePromise: Promise<TurnstileApi> | null = null;

function turnstileApi(): TurnstileApi | undefined {
  return (window as unknown as { turnstile?: TurnstileApi }).turnstile;
}

function loadTurnstile(): Promise<TurnstileApi> {
  const api = turnstileApi();
  if (api) return Promise.resolve(api);
  if (turnstilePromise) return turnstilePromise;
  const pending = new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement('script');
    let timer: ReturnType<typeof setTimeout>;
    let settled = false;
    const cleanup = (): void => {
      clearTimeout(timer);
      script.onload = null;
      script.onerror = null;
    };
    const fail = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('challenge-unavailable'));
    };
    script.async = true;
    script.onload = (): void => {
      if (settled) return;
      const loaded = turnstileApi();
      if (loaded) {
        settled = true;
        cleanup();
        resolve(loaded);
      } else fail();
    };
    script.onerror = fail;
    timer = setTimeout(fail, 10_000);
    try {
      // The existing enforced default Trusted Types policy must allow this
      // exact URL. No new policy, unsafe-inline or unsafe-eval is introduced.
      script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      document.head.append(script);
    } catch {
      fail();
    }
  });
  turnstilePromise = pending;
  void pending.catch(() => {
    if (turnstilePromise === pending) turnstilePromise = null;
  });
  return pending;
}

/** Load only after form interaction, not during the homepage's first paint. */
export async function mountContactChallenge(
  container: HTMLElement,
  siteKey: string,
  lang: 'en' | 'ru',
  onToken: (token: string) => void,
  onError: () => void
): Promise<ContactChallenge> {
  const api = await loadTurnstile();
  if (!container.isConnected) throw new Error('challenge-unmounted');
  const widget = api.render(container, {
    sitekey: siteKey,
    action: 'project_enquiry',
    theme: 'dark',
    size: 'compact',
    language: lang,
    'response-field': false,
    callback: onToken,
    'expired-callback': () => onToken(''),
    'error-callback': () => {
      onToken('');
      onError();
    },
  });
  if (!widget) throw new Error('challenge-unavailable');
  return {
    reset: () => {
      try {
        api.reset(widget);
      } catch {
        onToken('');
      }
    },
    destroy: () => {
      try {
        api.remove(widget);
      } catch {
        /* The widget may already be unmounted. */
      }
    },
  };
}
