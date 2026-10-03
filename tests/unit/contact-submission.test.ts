import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  loadContactSiteKey,
  createContactSiteKeyLoader,
  submitContactEnquiry,
  validateSubmission,
  type ContactSubmission,
} from '@/lib/contact-submission';

const valid: ContactSubmission = {
  replyEmail: 'visitor@example.com',
  company: 'example.com',
  task: 'We need a faster product enquiry page.',
  budget: 'under-5k',
  timeline: 'this-quarter',
  lang: 'en',
  context: {},
  website: '',
  turnstileToken: 'test-token',
  requestId: '43b2b2aa-a13b-4c4e-8a6d-9a5b9187de13',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('direct contact submission client', () => {
  it('recovers configuration after a 503 and caches only a successful public key', async () => {
    const mock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(Response.json({ siteKey: 'test-public-sitekey' }));
    const getSiteKey = createContactSiteKeyLoader(mock);
    expect(await getSiteKey()).toBeNull();
    expect(await getSiteKey()).toBe('test-public-sitekey');
    expect(await getSiteKey()).toBe('test-public-sitekey');
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it('shares an in-flight configuration GET between interactions', async () => {
    const mock = vi.fn<typeof fetch>(async () => Response.json({ siteKey: 'test-public-sitekey' }));
    const getSiteKey = createContactSiteKeyLoader(mock);
    const first = getSiteKey();
    const second = getSiteKey();
    expect(first).toBe(second);
    expect(await first).toBe('test-public-sitekey');
    expect(mock).toHaveBeenCalledTimes(1);
  });
  it.each([
    '',
    'a@example.com\r\nBcc: b@example.com',
    'a@example.com,b@example.com',
    'not-an-email',
  ])('validates the reply address %s before requesting delivery', async (replyEmail) => {
    const mock = vi.fn<typeof fetch>();
    expect(validateSubmission(valid, replyEmail)).toHaveProperty('replyEmail');
    expect(await submitContactEnquiry({ ...valid, replyEmail }, mock)).toEqual({
      ok: false,
      code: 'invalid',
    });
    expect(mock).not.toHaveBeenCalled();
  });

  it('makes exactly one same-origin POST and preserves the caller input', async () => {
    const mock = vi.fn<typeof fetch>(async () =>
      Response.json({ ok: true, status: 'queued', requestId: valid.requestId }, { status: 202 })
    );
    const before = JSON.stringify(valid);
    expect(await submitContactEnquiry(valid, mock)).toEqual({
      ok: true,
      status: 'queued',
      requestId: valid.requestId,
    });
    expect(JSON.stringify(valid)).toBe(before);
    expect(mock).toHaveBeenCalledTimes(1);
    const [url, init] = mock.mock.calls[0] ?? [];
    expect(url).toBe('/api/contact');
    expect(init?.credentials).toBe('same-origin');
    expect(init?.redirect).toBe('error');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.body).toBe(JSON.stringify(valid));
  });

  it.each(['', 'bot-content'])(
    'does not bypass bot protection for missing token or honeypot %s',
    async (website) => {
      const mock = vi.fn<typeof fetch>();
      const input = website ? { ...valid, website } : { ...valid, turnstileToken: '' };
      expect(await submitContactEnquiry(input, mock)).toEqual({ ok: false, code: 'verification' });
      expect(mock).not.toHaveBeenCalled();
    }
  );

  it('preserves unknown delivery status without retrying or clearing the data', async () => {
    const mock = vi.fn<typeof fetch>(async () => {
      throw new Error('timeout after send');
    });
    const before = JSON.stringify(valid);
    expect(await submitContactEnquiry(valid, mock)).toEqual({
      ok: false,
      code: 'delivery-unknown',
    });
    expect(mock).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(valid)).toBe(before);
  });

  it.each([
    { ok: true },
    { ok: true, status: 'delivered', requestId: 'different-id' },
    { ok: false, code: 'something-secret' },
  ])('rejects malformed receipts instead of showing success %o', async (receipt) => {
    const mock = vi.fn<typeof fetch>(async () => Response.json(receipt));
    expect(await submitContactEnquiry(valid, mock)).toEqual({
      ok: false,
      code: 'delivery-unknown',
    });
  });

  it('cannot use a fake success receipt inside an HTTP error', async () => {
    const mock = vi.fn<typeof fetch>(async () =>
      Response.json({ ok: true, status: 'delivered', requestId: valid.requestId }, { status: 503 })
    );
    expect(await submitContactEnquiry(valid, mock)).toEqual({
      ok: false,
      code: 'delivery-unknown',
    });
  });

  it('reports an undeployed endpoint as unavailable', async () => {
    const mock = vi.fn<typeof fetch>(async () => new Response('not found', { status: 404 }));
    expect(await submitContactEnquiry(valid, mock)).toEqual({ ok: false, code: 'unavailable' });
  });

  it('only accepts public challenge configuration with the exact schema', async () => {
    expect(
      await loadContactSiteKey(
        vi.fn<typeof fetch>(async () => Response.json({ siteKey: 'test-public-sitekey' }))
      )
    ).toBe('test-public-sitekey');
    expect(
      await loadContactSiteKey(
        vi.fn<typeof fetch>(async () =>
          Response.json({ siteKey: 'test-public-sitekey', secret: 'not-a-real-secret' })
        )
      )
    ).toBeNull();
    expect(
      await loadContactSiteKey(vi.fn<typeof fetch>(async () => new Response('', { status: 503 })))
    ).toBeNull();
  });

  it('recovers from a synchronous script rejection instead of caching a failed load forever', async () => {
    vi.resetModules();
    const { mountContactChallenge } = await import('@/lib/contact-submission');
    const createElement = vi.fn(() => ({
      set src(_value: string) {
        throw new TypeError('CSP blocked script');
      },
    }));
    vi.stubGlobal('window', {});
    vi.stubGlobal('document', { createElement, head: { append: vi.fn() } });
    const container = { isConnected: true } as HTMLDivElement;
    await expect(
      mountContactChallenge(container, 'test-public-sitekey', 'en', vi.fn(), vi.fn())
    ).rejects.toThrow('challenge-unavailable');
    await expect(
      mountContactChallenge(container, 'test-public-sitekey', 'en', vi.fn(), vi.fn())
    ).rejects.toThrow('challenge-unavailable');
    expect(createElement).toHaveBeenCalledTimes(2);
  });
});
