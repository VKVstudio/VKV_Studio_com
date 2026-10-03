import { z } from 'zod';

z.config({ jitless: true });

export const CONTACT_RELAY_URL = 'https://api.vkvstudio.com/_internal/vkv-contact';
const PROTOCOL = 'VKV-CONTACT-RELAY/1';
const MAX_BYTES = 16_384;

export interface ContactRelayEnvironment {
  CONTACT_DELIVERY_TRANSPORT?: string;
  CONTACT_RELAY_URL?: string;
  CONTACT_RELAY_HMAC_KEY?: string;
  CONTACT_RELAY_KEY_ID?: string;
  CONTACT_RELAY_READY?: string;
}

interface RelayConfiguration {
  keyId: string;
  key: Uint8Array<ArrayBuffer>;
}

interface ReadinessCache {
  config: RelayConfiguration;
  pending: boolean;
  expires: number;
  result: Promise<boolean>;
}

// One bounded entry per isolate; bind both key ID and actual credential bytes.
// A positive result is fresh for five seconds. Failures never remain cached.
let readinessCache: ReadinessCache | undefined;

export interface RelayMail {
  requestId: string;
  replyEmail: string;
  text: string;
}

export type RelayResult = 'queued' | 'unknown' | 'unavailable' | 'rate-limit' | 'conflict';

type ReadinessErrorType =
  | 'TypeError'
  | 'RangeError'
  | 'SyntaxError'
  | 'AbortError'
  | 'TimeoutError'
  | 'OperationError'
  | 'DataError'
  | 'NotSupportedError'
  | 'InvalidAccessError'
  | 'SecurityError'
  | 'Error'
  | 'UnknownError';

export type ContactReadinessDiagnostic =
  | { code: 'config-invalid' | 'receipt-invalid' | 'service-not-ready' }
  | { code: 'relay-signing-failed' | 'fetch-failed'; errorType: ReadinessErrorType }
  | { code: 'relay-http-status'; status: number };

// Never forward an exception message, cause or arbitrary exception name.
function readinessErrorType(error: unknown): ReadinessErrorType {
  if (error instanceof TypeError) return 'TypeError';
  if (error instanceof RangeError) return 'RangeError';
  if (error instanceof SyntaxError) return 'SyntaxError';
  if (error instanceof DOMException) {
    switch (error.name) {
      case 'AbortError':
      case 'TimeoutError':
      case 'OperationError':
      case 'DataError':
      case 'NotSupportedError':
      case 'InvalidAccessError':
      case 'SecurityError':
        return error.name;
    }
  }
  return error instanceof Error ? 'Error' : 'UnknownError';
}

function diagnoseReadiness(
  diagnostic: ((event: ContactReadinessDiagnostic) => void) | undefined,
  event: ContactReadinessDiagnostic
): void {
  try {
    diagnostic?.(event);
  } catch {
    // Diagnostics must not alter the fail-closed public result or cache.
  }
}

const mailSchema = z
  .object({
    version: z.literal(1),
    requestId: z.uuid().regex(/^[a-f\d-]+$/),
    replyEmail: z
      .email()
      .max(254)
      .regex(/^[\x21-\x7e]+$/),
    text: z
      .string()
      .min(20)
      .max(8192)
      .regex(/^[^\x00-\x08\x0b\x0c\x0e-\x1f\x7f\ud800-\udfff]+$/u),
  })
  .strict();

const readySchema = z.object({ ok: z.boolean(), transport: z.literal('workspace-smtp') }).strict();
const receiptSchema = z
  .object({ ok: z.literal(true), status: z.literal('queued'), requestId: z.uuid() })
  .strict();

function configuration(env: ContactRelayEnvironment): RelayConfiguration | null {
  if (
    env.CONTACT_DELIVERY_TRANSPORT !== 'workspace-relay' ||
    env.CONTACT_RELAY_READY !== 'true' ||
    env.CONTACT_RELAY_URL !== CONTACT_RELAY_URL ||
    !/^[a-f\d]{64}$/.test(env.CONTACT_RELAY_HMAC_KEY ?? '') ||
    !/^[a-z\d][a-z\d-]{0,31}$/.test(env.CONTACT_RELAY_KEY_ID ?? '')
  ) {
    return null;
  }
  const key = Uint8Array.from((env.CONTACT_RELAY_HMAC_KEY ?? '').match(/../g) ?? [], (pair) =>
    Number.parseInt(pair, 16)
  );
  return { keyId: env.CONTACT_RELAY_KEY_ID ?? '', key };
}

export function contactRelayConfigured(env: ContactRelayEnvironment): boolean {
  return configuration(env) !== null;
}

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function signedRequest(
  config: RelayConfiguration,
  method: 'GET' | 'POST',
  path: string,
  body: Uint8Array<ArrayBuffer>
): Promise<RequestInit> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonceBytes = crypto.getRandomValues(new Uint8Array(24));
  const nonce = btoa(String.fromCharCode(...nonceBytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_');
  const bodyHash = hex(await crypto.subtle.digest('SHA-256', body));
  const material = [PROTOCOL, config.keyId, method, path, timestamp, nonce, bodyHash].join('\n');
  const key = await crypto.subtle.importKey(
    'raw',
    config.key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(material)));
  const headers = new Headers({
    'X-VKV-Relay-Key-Id': config.keyId,
    'X-VKV-Relay-Time': timestamp,
    'X-VKV-Relay-Nonce': nonce,
    'X-VKV-Relay-Signature': signature,
    Accept: 'application/json',
  });
  if (method === 'POST') {
    headers.set('Content-Type', 'application/json; charset=utf-8');
    headers.set('Content-Length', String(body.byteLength));
  }
  return {
    method,
    headers,
    ...(method === 'POST' ? { body } : {}),
    redirect: 'error',
    signal: AbortSignal.timeout(method === 'GET' ? 3000 : 10_000),
  };
}

async function receipt(response: Response): Promise<unknown> {
  const contentType = response.headers.get('Content-Type') ?? '';
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType)) {
    throw new TypeError('relay-response');
  }
  const length = response.headers.get('Content-Length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > 8192)) {
    throw new RangeError('relay-response');
  }
  if (!response.body) throw new TypeError('relay-response');
  const reader = response.body.getReader();
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('relay-response')), 3000);
  });
  try {
    while (true) {
      const part = await Promise.race([reader.read(), deadline]);
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 8192) throw new RangeError('relay-response');
      chunks.push(part.value);
    }
    const result = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(result)) as unknown;
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    reader.releaseLock();
  }
}

/** Authenticated local configuration/database readiness; no SMTP or provider probe. */
export async function contactRelayReady(
  env: ContactRelayEnvironment,
  requestFetch: typeof fetch = fetch,
  diagnostic?: (event: ContactReadinessDiagnostic) => void
): Promise<boolean> {
  const config = configuration(env);
  if (!config) {
    diagnoseReadiness(diagnostic, { code: 'config-invalid' });
    return false;
  }
  if (
    readinessCache &&
    readinessCache.config.keyId === config.keyId &&
    readinessCache.config.key.every((byte, index) => byte === config.key[index]) &&
    (readinessCache.pending || readinessCache.expires > Date.now())
  )
    return readinessCache.result;

  const entry: ReadinessCache = {
    config,
    pending: true,
    expires: 0,
    result: Promise.resolve(false),
  };
  readinessCache = entry;
  entry.result = (async (): Promise<boolean> => {
    let ready = false;
    try {
      const path = new URL(CONTACT_RELAY_URL).pathname + '/readiness';
      let init: RequestInit;
      try {
        init = await signedRequest(config, 'GET', path, new Uint8Array());
      } catch (error) {
        diagnoseReadiness(diagnostic, {
          code: 'relay-signing-failed',
          errorType: readinessErrorType(error),
        });
        return false;
      }
      let response: Response;
      try {
        response = await requestFetch(CONTACT_RELAY_URL + '/readiness', init);
      } catch (error) {
        diagnoseReadiness(diagnostic, {
          code: 'fetch-failed',
          errorType: readinessErrorType(error),
        });
        return false;
      }
      if (response.status !== 200) {
        diagnoseReadiness(diagnostic, { code: 'relay-http-status', status: response.status });
        return false;
      }
      let parsed: ReturnType<typeof readySchema.safeParse>;
      try {
        parsed = readySchema.safeParse(await receipt(response));
      } catch {
        diagnoseReadiness(diagnostic, { code: 'receipt-invalid' });
        return false;
      }
      if (!parsed.success) {
        diagnoseReadiness(diagnostic, { code: 'receipt-invalid' });
        return false;
      }
      ready = parsed.data.ok;
      if (!ready) diagnoseReadiness(diagnostic, { code: 'service-not-ready' });
      return ready;
    } catch {
      return false;
    } finally {
      entry.pending = false;
      entry.expires = ready ? Date.now() + 5000 : 0;
      if (!ready && readinessCache === entry) readinessCache = undefined;
    }
  })();
  return entry.result;
}

/** One signed request. SMTP acceptance is queued; ambiguous outcomes never retry. */
export async function deliverContactRelay(
  env: ContactRelayEnvironment,
  mail: RelayMail,
  requestFetch: typeof fetch = fetch
): Promise<RelayResult> {
  const config = configuration(env);
  const parsed = mailSchema.safeParse({ version: 1, ...mail });
  if (!config || !parsed.success) return 'unavailable';
  const body = new TextEncoder().encode(JSON.stringify(parsed.data));
  if (body.byteLength > MAX_BYTES) return 'unavailable';
  try {
    const response = await requestFetch(
      CONTACT_RELAY_URL,
      await signedRequest(config, 'POST', new URL(CONTACT_RELAY_URL).pathname, body)
    );
    if (response.status === 429) return 'rate-limit';
    if (response.status === 409) return 'conflict';
    if ([400, 401, 403, 413, 415, 422, 503].includes(response.status)) return 'unavailable';
    if (response.status !== 202) return 'unknown';
    const result = receiptSchema.safeParse(await receipt(response));
    return result.success && result.data.requestId === mail.requestId ? 'queued' : 'unknown';
  } catch {
    return 'unknown';
  }
}
