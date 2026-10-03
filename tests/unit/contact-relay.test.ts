import { createHash, createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CONTACT_RELAY_URL,
  contactRelayConfigured,
  contactRelayReady,
  deliverContactRelay,
  type ContactRelayEnvironment,
} from '../../functions/_lib/contact-relay';
import {
  handleContactRequest,
  type ContactEnvironment,
} from '../../functions/_lib/contact-delivery';

const key = Array.from({ length: 32 }, (_, index) => index.toString(16).padStart(2, '0')).join('');
const requestId = '43b2b2aa-a13b-4c4e-8a6d-9a5b9187de13';
const mail = {
  requestId,
  replyEmail: 'visitor@example.com',
  text: 'Synthetic enquiry only. Проверка 🧪.',
};
const accepted = { ok: true, status: 'queued', requestId };
let sequence = 0;
let env: ContactEnvironment;

beforeEach(() => {
  env = {
    CONTACT_DELIVERY_TRANSPORT: 'workspace-relay',
    CONTACT_RELAY_READY: 'true',
    CONTACT_RELAY_URL,
    CONTACT_RELAY_HMAC_KEY: key,
    CONTACT_RELAY_KEY_ID: `unit-test-${++sequence}`,
    CONTACT_TURNSTILE_SITE_KEY: 'unit-test-public-sitekey',
    CONTACT_TURNSTILE_SECRET: 'synthetic-only',
    CONTACT_EDGE_RATE_LIMIT_READY: 'true',
  };
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function queued(): Response {
  return Response.json(accepted, { status: 202 });
}

function checkSignature(init: RequestInit | undefined, method: string, path: string): void {
  const headers = new Headers(init?.headers);
  const body = init?.body instanceof Uint8Array ? init.body : new Uint8Array();
  const hash = createHash('sha256').update(body).digest('hex');
  const material = [
    'VKV-CONTACT-RELAY/1',
    env.CONTACT_RELAY_KEY_ID,
    method,
    path,
    headers.get('X-VKV-Relay-Time'),
    headers.get('X-VKV-Relay-Nonce'),
    hash,
  ].join('\n');
  expect(headers.get('X-VKV-Relay-Signature')).toBe(
    createHmac('sha256', Buffer.from(key, 'hex')).update(material).digest('hex')
  );
  expect(headers.get('X-VKV-Relay-Nonce')).toMatch(/^[A-Za-z\d_-]{32}$/);
  expect(headers.get('X-VKV-Relay-Time')).toMatch(/^[1-9]\d{9}$/);
  expect(headers.has('Authorization')).toBe(false);
  expect(init?.redirect).toBe('error');
  expect(init?.signal).toBeInstanceOf(AbortSignal);
}

function enquiry(): Request {
  return new Request('https://vkvstudio.com/api/contact', {
    method: 'POST',
    headers: {
      Origin: 'https://vkvstudio.com',
      'Content-Type': 'application/json',
      'CF-Connecting-IP': '192.0.2.1',
      'Sec-Fetch-Site': 'same-origin',
    },
    body: JSON.stringify({
      replyEmail: mail.replyEmail,
      company: 'Synthetic company',
      task: mail.text,
      budget: 'under-5k',
      timeline: 'this-quarter',
      lang: 'en',
      context: { source: 'pro', briefing: 'the-hundred-and-the-cache' },
      website: '',
      turnstileToken: 'synthetic-token',
      requestId,
    }),
  });
}

function gateway(status = 202): ReturnType<typeof vi.fn<typeof fetch>> {
  return vi.fn<typeof fetch>(async (url) => {
    if (String(url) === CONTACT_RELAY_URL + '/readiness') {
      return Response.json({ ok: true, transport: 'workspace-smtp' });
    }
    if (String(url).endsWith('/siteverify')) {
      return Response.json({ success: true, hostname: 'vkvstudio.com', action: 'project_enquiry' });
    }
    return Response.json(status === 202 ? accepted : { ok: false }, { status });
  });
}

describe('fixed Workspace relay transport', () => {
  it.each([
    ['transport', { CONTACT_DELIVERY_TRANSPORT: 'other' }],
    ['ready flag', { CONTACT_RELAY_READY: undefined }],
    ['alternate URL', { CONTACT_RELAY_URL: 'https://attacker.example/' }],
    ['URL suffix', { CONTACT_RELAY_URL: CONTACT_RELAY_URL + '/' }],
    ['missing key', { CONTACT_RELAY_HMAC_KEY: undefined }],
    ['short key', { CONTACT_RELAY_HMAC_KEY: 'a'.repeat(63) }],
    ['noncanonical key', { CONTACT_RELAY_HMAC_KEY: 'A'.repeat(64) }],
    ['bad key ID', { CONTACT_RELAY_KEY_ID: 'bad\nheader' }],
  ])('fails closed for %s', async (_, change: ContactRelayEnvironment) => {
    const mock = vi.fn<typeof fetch>();
    expect(contactRelayConfigured({ ...env, ...change })).toBe(false);
    expect(await contactRelayReady({ ...env, ...change }, mock)).toBe(false);
    expect(await deliverContactRelay({ ...env, ...change }, mail, mock)).toBe('unavailable');
    expect(mock).not.toHaveBeenCalled();
  });

  it('signs exact UTF-8 bytes and distinct nonces without address routing fields', async () => {
    const mock = vi.fn<typeof fetch>(async () => queued());
    expect(await deliverContactRelay(env, mail, mock)).toBe('queued');
    expect(await deliverContactRelay(env, mail, mock)).toBe('queued');
    const [url, init] = mock.mock.calls[0] ?? [];
    expect(url).toBe(CONTACT_RELAY_URL);
    checkSignature(init, 'POST', '/_internal/vkv-contact');
    if (!(init?.body instanceof Uint8Array)) throw new Error('Expected raw bytes');
    expect(JSON.parse(new TextDecoder().decode(init.body))).toEqual({ version: 1, ...mail });
    expect(new Headers(init.headers).get('Content-Length')).toBe(String(init.body.byteLength));
    expect(new Headers(init.headers).get('X-VKV-Relay-Nonce')).not.toBe(
      new Headers(mock.mock.calls[1]?.[1]?.headers).get('X-VKV-Relay-Nonce')
    );
  });

  it.each([
    { replyEmail: 'a@example.com\r\nBcc: b@example.com' },
    { replyEmail: 'a@example.com,b@example.com' },
    { requestId: 'invalid' },
    { requestId: requestId.toUpperCase() },
    { text: 'x' },
    { text: 'x'.repeat(8193) },
    { text: 'x'.repeat(30) + '\ud800' },
    { text: 'x'.repeat(30) + '\u0000' },
    { text: '界'.repeat(6000) },
    { to: 'other@example.com' },
    { html: '<h1>other</h1>' },
  ])('independently rejects unsafe envelope %o', async (change) => {
    const mock = vi.fn<typeof fetch>();
    expect(await deliverContactRelay(env, { ...mail, ...change }, mock)).toBe('unavailable');
    expect(mock).not.toHaveBeenCalled();
  });

  it.each([
    [429, 'rate-limit'],
    [409, 'conflict'],
    [400, 'unavailable'],
    [401, 'unavailable'],
    [403, 'unavailable'],
    [413, 'unavailable'],
    [415, 'unavailable'],
    [422, 'unavailable'],
    [503, 'unavailable'],
    [502, 'unknown'],
    [500, 'unknown'],
    [201, 'unknown'],
    [200, 'unknown'],
  ])('maps status %i without retry or fallback', async (status, expected) => {
    const mock = vi.fn<typeof fetch>(async () => Response.json({ ok: false }, { status }));
    expect(await deliverContactRelay(env, mail, mock)).toBe(expected);
    expect(mock).toHaveBeenCalledTimes(1);
    expect(mock.mock.calls[0]?.[0]).toBe(CONTACT_RELAY_URL);
  });

  it.each([
    { ok: true, status: 'delivered', requestId },
    { ok: true, status: 'queued', requestId: '00000000-0000-0000-0000-000000000000' },
    { ...accepted, unexpected: true },
    {},
  ])('requires exact queued receipt and matching request ID', async (value) => {
    const mock = vi.fn<typeof fetch>(async () => Response.json(value, { status: 202 }));
    expect(await deliverContactRelay(env, mail, mock)).toBe('unknown');
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it('bounds provider bytes and checks response media type/UTF-8', async () => {
    for (const response of [
      new Response('x'.repeat(8193), {
        status: 202,
        headers: { 'Content-Type': 'application/json' },
      }),
      new Response('{}', {
        status: 202,
        headers: { 'Content-Type': 'application/json', 'Content-Length': '8193' },
      }),
      new Response('{}', { status: 202, headers: { 'Content-Type': 'text/html' } }),
      new Response(new Uint8Array([255]), {
        status: 202,
        headers: { 'Content-Type': 'application/json' },
      }),
    ]) {
      expect(await deliverContactRelay(env, mail, async () => response)).toBe('unknown');
    }
  });

  it('network ambiguity never triggers another request', async () => {
    const mock = vi.fn<typeof fetch>(async () => {
      throw new Error('synthetic timeout');
    });
    expect(await deliverContactRelay(env, mail, mock)).toBe('unknown');
    expect(mock).toHaveBeenCalledTimes(1);
  });
});

describe('authenticated readiness', () => {
  it('signs GET with empty body and caches a positive result for five seconds', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_791_000_000_000);
    const mock = vi.fn<typeof fetch>(async () =>
      Response.json({ ok: true, transport: 'workspace-smtp' })
    );
    expect(await contactRelayReady(env, mock)).toBe(true);
    checkSignature(mock.mock.calls[0]?.[1], 'GET', '/_internal/vkv-contact/readiness');
    expect(mock.mock.calls[0]?.[1]?.body).toBeUndefined();
    vi.setSystemTime(1_791_000_004_999);
    expect(await contactRelayReady(env, mock)).toBe(true);
    expect(mock).toHaveBeenCalledTimes(1);
    vi.setSystemTime(1_791_000_005_000);
    expect(await contactRelayReady(env, mock)).toBe(true);
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it('shares concurrent readiness and invalidates on key or key ID changes', async () => {
    const mock = vi.fn<typeof fetch>(async () =>
      Response.json({ ok: true, transport: 'workspace-smtp' })
    );
    expect(
      await Promise.all(Array.from({ length: 10 }, () => contactRelayReady(env, mock)))
    ).toEqual(Array(10).fill(true));
    expect(mock).toHaveBeenCalledTimes(1);
    expect(await contactRelayReady({ ...env, CONTACT_RELAY_HMAC_KEY: '1'.repeat(64) }, mock)).toBe(
      true
    );
    expect(await contactRelayReady({ ...env, CONTACT_RELAY_KEY_ID: 'other-key' }, mock)).toBe(true);
    expect(mock).toHaveBeenCalledTimes(3);
  });

  it('does not cache failures or accept SMTP-delivered claims', async () => {
    const mock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ ok: false }, { status: 503 }))
      .mockResolvedValueOnce(
        Response.json({ ok: true, transport: 'workspace-smtp', delivered: true })
      )
      .mockResolvedValueOnce(Response.json({ ok: true, transport: 'workspace-smtp' }));
    expect(await contactRelayReady(env, mock)).toBe(false);
    expect(await contactRelayReady(env, mock)).toBe(false);
    expect(await contactRelayReady(env, mock)).toBe(true);
    expect(mock).toHaveBeenCalledTimes(3);
  });
});

describe('relay integration retains the Pages boundary', () => {
  it('uses readiness, Turnstile and one signed relay submission in order', async () => {
    const mock = gateway();
    const response = await handleContactRequest(enquiry(), env, mock);
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual(accepted);
    expect(mock.mock.calls.map(([url]) => String(url))).toEqual([
      CONTACT_RELAY_URL + '/readiness',
      'https://challenges.cloudflare.com/turnstile/v0/siteverify',
      CONTACT_RELAY_URL,
    ]);
    const init = mock.mock.calls[2]?.[1];
    if (!(init?.body instanceof Uint8Array)) throw new Error('Expected relay payload');
    const payload = JSON.parse(new TextDecoder().decode(init.body)) as Record<string, unknown>;
    expect(Object.keys(payload)).toEqual(['version', 'requestId', 'replyEmail', 'text']);
    expect(payload.text).toContain(
      'Briefing: https://vkvstudio.pro/briefings/the-hundred-and-the-cache/'
    );
    expect(payload.text).not.toContain('synthetic-token');
    expect(payload).not.toHaveProperty('turnstileToken');
  });

  it('fails before consuming Turnstile if the daemon is not ready', async () => {
    const mock = vi.fn<typeof fetch>(async () => Response.json({ ok: false }, { status: 503 }));
    expect((await handleContactRequest(enquiry(), env, mock)).status).toBe(503);
    expect(mock).toHaveBeenCalledTimes(1);
    expect(mock.mock.calls[0]?.[0]).toBe(CONTACT_RELAY_URL + '/readiness');
  });

  it('public GET requires real authenticated readiness and exposes only site key', async () => {
    const mock = gateway();
    const response = await handleContactRequest(
      new Request('https://vkvstudio.com/api/contact'),
      env,
      mock
    );
    expect(await response.json()).toEqual({ siteKey: env.CONTACT_TURNSTILE_SITE_KEY });
    expect(mock).toHaveBeenCalledTimes(1);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it.each([
    [429, 429],
    [409, 409],
    [502, 502],
    [503, 503],
  ])('maps %i and never falls back to paid email', async (relayStatus, expected) => {
    const mock = gateway(relayStatus);
    const response = await handleContactRequest(
      enquiry(),
      {
        ...env,
        CONTACT_EMAIL_ACCOUNT_ID: 'a'.repeat(32),
        CONTACT_EMAIL_API_TOKEN: 'synthetic-only',
        CONTACT_EMAIL_SENDING_READY: 'true',
      },
      mock
    );
    expect(response.status).toBe(expected);
    expect(mock).toHaveBeenCalledTimes(3);
    expect(mock.mock.calls.every(([url]) => !String(url).includes('/email/sending/'))).toBe(true);
  });

  it('rejects untrusted origin and applies rate limit before upstream work', async () => {
    const mock = gateway();
    const bad = enquiry();
    bad.headers.set('Origin', 'https://attacker.example');
    expect((await handleContactRequest(bad, env, mock)).status).toBe(403);
    const limited = {
      ...env,
      CONTACT_RATE_LIMIT: { limit: vi.fn(async () => ({ success: false })) },
    };
    expect((await handleContactRequest(enquiry(), limited, mock)).status).toBe(429);
    expect(mock).not.toHaveBeenCalled();
  });
});
