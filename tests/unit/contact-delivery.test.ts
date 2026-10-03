import { describe, it, expect, vi } from 'vitest';
import {
  handleContactRequest,
  type ContactEnvironment,
} from '../../functions/_lib/contact-delivery';

const requestId = '43b2b2aa-a13b-4c4e-8a6d-9a5b9187de13';
const valid = {
  replyEmail: 'visitor@example.com',
  company: 'example.com',
  task: 'We need a faster product enquiry page.',
  budget: 'under-5k',
  timeline: 'this-quarter',
  lang: 'en',
  context: { service: 'websites' },
  website: '',
  turnstileToken: 'test-token',
  requestId,
};
const env: ContactEnvironment = {
  CONTACT_EMAIL_ACCOUNT_ID: 'a'.repeat(32),
  CONTACT_EMAIL_API_TOKEN: 'unit-test-only-placeholder',
  CONTACT_EMAIL_SENDING_READY: 'true',
  CONTACT_TURNSTILE_SITE_KEY: 'unit-test-public-sitekey',
  CONTACT_TURNSTILE_SECRET: 'unit-test-only-placeholder',
  CONTACT_EDGE_RATE_LIMIT_READY: 'true',
};

function request(body: unknown = valid, changes: Record<string, string | undefined> = {}): Request {
  const headers = new Headers({
    Origin: 'https://vkvstudio.com',
    'Content-Type': 'application/json',
    'CF-Connecting-IP': '192.0.2.1',
    'Sec-Fetch-Site': 'same-origin',
  });
  for (const [key, value] of Object.entries(changes)) {
    if (value !== undefined) headers.set(key, value);
  }
  return new Request('https://vkvstudio.com/api/contact', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

function transport(
  options: { challenge?: object; receipt?: object; status?: number; failMail?: boolean } = {}
): ReturnType<typeof vi.fn<typeof fetch>> {
  return vi.fn<typeof fetch>(async (url) => {
    if (String(url).endsWith('/siteverify')) {
      return Response.json(
        options.challenge ?? { success: true, hostname: 'vkvstudio.com', action: 'project_enquiry' }
      );
    }
    if (options.failMail) throw new Error('unconfirmed transport timeout');
    return Response.json(
      options.receipt ?? {
        success: true,
        errors: [],
        result: { delivered: ['valerii@vkvstudio.com'], queued: [], permanent_bounces: [] },
      },
      { status: options.status ?? 200 }
    );
  });
}

describe('same-origin direct contact delivery', () => {
  it.each([302, 307])(
    'rejects Turnstile redirect %i without invoking the email provider',
    async (status) => {
      const mock = vi.fn<typeof fetch>(async (url, init) => {
        expect(String(url)).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify');
        expect(init?.redirect).toBe('manual');
        return new Response(null, {
          status,
          headers: { Location: 'https://untrusted.example/collect' },
        });
      });
      const response = await handleContactRequest(request(), env, mock);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ ok: false, code: 'unavailable' });
      expect(mock).toHaveBeenCalledTimes(1);
    }
  );

  it.each([302, 307])(
    'rejects email provider redirect %i without retry or token forwarding',
    async (status) => {
      const mock = vi.fn<typeof fetch>(async (url, init) => {
        expect(init?.redirect).toBe('manual');
        if (String(url).endsWith('/siteverify')) {
          return Response.json({
            success: true,
            hostname: 'vkvstudio.com',
            action: 'project_enquiry',
          });
        }
        expect(String(url)).toBe(
          'https://api.cloudflare.com/client/v4/accounts/' + 'a'.repeat(32) + '/email/sending/send'
        );
        return new Response(null, {
          status,
          headers: { Location: 'https://untrusted.example/collect' },
        });
      });
      const response = await handleContactRequest(request(), env, mock);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ ok: false, code: 'unavailable' });
      expect(mock).toHaveBeenCalledTimes(2);
    }
  );

  it('uses fixed destinations, first-class reply_to and plain text only', async () => {
    const mock = transport();
    const response = await handleContactRequest(request(), env, mock);
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ ok: true, status: 'delivered', requestId });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.has('Access-Control-Allow-Origin')).toBe(false);
    expect(mock).toHaveBeenCalledTimes(2);
    const [endpoint, init] = mock.mock.calls[1] ?? [];
    expect(String(endpoint)).toBe(
      'https://api.cloudflare.com/client/v4/accounts/' + 'a'.repeat(32) + '/email/sending/send'
    );
    const mail = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(mail).toEqual({
      from: 'enquiries@vkvstudio.com',
      to: 'valerii@vkvstudio.com',
      reply_to: valid.replyEmail,
      subject: 'VKVstudio project enquiry',
      text: expect.stringContaining(valid.task),
    });
    expect(mail).not.toHaveProperty('html');
    expect(mail).not.toHaveProperty('headers');
    expect(init?.redirect).toBe('manual');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const verification = JSON.parse(String(mock.mock.calls[0]?.[1]?.body)) as Record<
      string,
      unknown
    >;
    expect(verification).not.toHaveProperty('idempotency_key');
  });

  it('reports queued separately from immediate delivery', async () => {
    const mock = transport({
      receipt: {
        success: true,
        result: {
          delivered: [],
          queued: ['valerii@vkvstudio.com'],
          permanent_bounces: [],
        },
      },
    });
    const response = await handleContactRequest(request(), env, mock);
    expect(await response.json()).toEqual({ ok: true, status: 'queued', requestId });
  });

  it.each([
    ['sender injection', { from: 'attacker@example.com' }],
    ['recipient injection', { to: 'attacker@example.com' }],
    ['header injection', { replyEmail: 'visitor@example.com\r\nBcc: attacker@example.com' }],
    ['address list', { replyEmail: 'visitor@example.com,attacker@example.com' }],
    ['control in subject-adjacent company', { company: 'example\r\nBcc: attacker' }],
    ['invalid budget', { budget: 'free' }],
    ['invalid locale', { lang: 'fr' }],
    ['overlong task', { task: 'x'.repeat(2001) }],
    ['short task', { task: 'hi' }],
    ['token omitted', { turnstileToken: '' }],
    ['context SSRF', { context: { source: 'pro', briefing: 'https://attacker.example/' } }],
    ['context unknown key', { context: { source: 'pro', url: 'https://attacker.example/' } }],
    ['briefing without source', { context: { briefing: 'the-hundred-and-the-cache' } }],
    ['bad request id', { requestId: 'not-a-uuid' }],
  ])('rejects %s before contacting any upstream', async (_, change) => {
    const mock = transport();
    const response = await handleContactRequest(request({ ...valid, ...change }), env, mock);
    expect(response.status).toBe(422);
    expect(mock).not.toHaveBeenCalled();
  });

  it('rejects a filled honeypot without pretending to deliver', async () => {
    const mock = transport();
    const response = await handleContactRequest(
      request({ ...valid, website: 'bot content' }),
      env,
      mock
    );
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ ok: false, code: 'verification' });
    expect(mock).not.toHaveBeenCalled();
  });

  it.each([
    { Origin: 'https://attacker.example' },
    { Origin: '' },
    { 'Sec-Fetch-Site': 'cross-site' },
  ])('rejects foreign or absent browser provenance %o', async (headers) => {
    const mock = transport();
    const response = await handleContactRequest(request(valid, headers), env, mock);
    expect(response.status).toBe(403);
    expect(mock).not.toHaveBeenCalled();
  });

  it('rejects unsupported content type, URL, method and oversized bodies', async () => {
    const mock = transport();
    expect(
      (await handleContactRequest(request(valid, { 'Content-Type': 'text/plain' }), env, mock))
        .status
    ).toBe(415);
    expect(
      (await handleContactRequest(new Request('http://vkvstudio.com/api/contact'), env, mock))
        .status
    ).toBe(403);
    expect(
      (await handleContactRequest(new Request('https://preview.pages.dev/api/contact'), env, mock))
        .status
    ).toBe(403);
    expect(
      (
        await handleContactRequest(
          new Request('https://vkvstudio.com/api/contact', { method: 'DELETE' }),
          env,
          mock
        )
      ).status
    ).toBe(405);
    expect(
      (await handleContactRequest(request(valid, { 'Content-Length': '16385' }), env, mock)).status
    ).toBe(413);
    // A false Content-Length cannot bypass the actual stream byte limit.
    expect(
      (
        await handleContactRequest(
          request({ ...valid, task: 'x'.repeat(20_000) }, { 'Content-Length': '1' }),
          env,
          mock
        )
      ).status
    ).toBe(413);
    expect(mock).not.toHaveBeenCalled();
  });

  it.each([
    'CONTACT_EMAIL_API_TOKEN',
    'CONTACT_EMAIL_ACCOUNT_ID',
    'CONTACT_EMAIL_SENDING_READY',
    'CONTACT_TURNSTILE_SITE_KEY',
    'CONTACT_TURNSTILE_SECRET',
    'CONTACT_EDGE_RATE_LIMIT_READY',
  ] as const)('fails closed when %s is not configured', async (key) => {
    const mock = transport();
    const incomplete = { ...env, [key]: undefined };
    const response = await handleContactRequest(request(), incomplete, mock);
    expect(response.status).toBe(503);
    expect(mock).not.toHaveBeenCalled();
  });

  it('requires an edge-provided IP and never trusts X-Forwarded-For', async () => {
    const mock = transport();
    const response = await handleContactRequest(
      request(valid, { 'CF-Connecting-IP': '', 'X-Forwarded-For': '192.0.2.1' }),
      env,
      mock
    );
    expect(response.status).toBe(503);
    expect(mock).not.toHaveBeenCalled();
  });

  it('exposes only a public site key; missing configuration is 503', async () => {
    const get = new Request('https://vkvstudio.com/api/contact');
    const response = await handleContactRequest(get, env, transport());
    expect(await response.json()).toEqual({ siteKey: env.CONTACT_TURNSTILE_SITE_KEY });
    expect((await handleContactRequest(get, {}, transport())).status).toBe(503);
  });

  it('enforces the configured rate-limit binding before upstream requests', async () => {
    const mock = transport();
    const limit = vi.fn(async () => ({ success: false }));
    const response = await handleContactRequest(
      request(),
      { ...env, CONTACT_EDGE_RATE_LIMIT_READY: undefined, CONTACT_RATE_LIMIT: { limit } },
      mock
    );
    expect(response.status).toBe(429);
    expect(limit).toHaveBeenCalledWith({ key: 'contact:192.0.2.1' });
    expect(mock).not.toHaveBeenCalled();
  });

  it.each([
    { success: false },
    { success: true, hostname: 'attacker.example', action: 'project_enquiry' },
    { success: true, hostname: 'vkvstudio.com', action: 'other-form' },
  ])('checks challenge validity, hostname and action %o', async (challenge) => {
    const mock = transport({ challenge });
    expect((await handleContactRequest(request(), env, mock)).status).toBe(422);
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it('does not send a second mail when the single-use challenge is replayed', async () => {
    let verifications = 0;
    const mock = vi.fn<typeof fetch>(async (url) => {
      if (String(url).endsWith('/siteverify'))
        return Response.json({
          success: ++verifications === 1,
          hostname: 'vkvstudio.com',
          action: 'project_enquiry',
        });
      return Response.json({
        success: true,
        result: { delivered: ['valerii@vkvstudio.com'], queued: [], permanent_bounces: [] },
      });
    });
    expect((await handleContactRequest(request(), env, mock)).status).toBe(202);
    expect((await handleContactRequest(request(), env, mock)).status).toBe(422);
    expect(mock.mock.calls.filter(([url]) => String(url).endsWith('/sending/send'))).toHaveLength(
      1
    );
  });

  it.each([
    { delivered: [], queued: [], permanent_bounces: ['valerii@vkvstudio.com'] },
    {
      delivered: [],
      queued: [],
      permanent_bounces: [],
      suppressed_recipients: ['valerii@vkvstudio.com'],
    },
  ])('never reports bounces or suppressions as success', async (result) => {
    const response = await handleContactRequest(
      request(),
      env,
      transport({ receipt: { success: true, result } })
    );
    expect(await response.json()).toEqual({ ok: false, code: 'delivery-failed' });
  });

  it.each([
    { success: true },
    {
      success: true,
      result: { delivered: ['hello@vkvstudio.com'], queued: [], permanent_bounces: [] },
    },
    {
      success: true,
      result: { delivered: ['attacker@example.com'], queued: [], permanent_bounces: [] },
    },
  ])('does not accept an absent or unrelated recipient receipt', async (receipt) => {
    const response = await handleContactRequest(request(), env, transport({ receipt }));
    expect(await response.json()).toEqual({ ok: false, code: 'delivery-unknown' });
  });

  it('does not retry an ambiguous mail transport failure', async () => {
    const mock = transport({ failMail: true });
    const response = await handleContactRequest(request(), env, mock);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ ok: false, code: 'delivery-unknown' });
    expect(mock).toHaveBeenCalledTimes(2);
  });
});
