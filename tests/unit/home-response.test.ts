import { describe, expect, it, vi } from 'vitest';
import { transformHomeResponse } from '../../functions/_lib/home-response';

const policy =
  "default-src 'self'; script-src 'self' https://accounts.google.com/gsi/client 'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='; style-src 'self' https://accounts.google.com; style-src-elem 'self' 'sha256-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB='; style-src-attr 'unsafe-hashes' 'sha256-CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC='; object-src 'none'; base-uri 'self'; require-trusted-types-for 'script'";
const html =
  '<!doctype html><html><head><title>VKVstudio</title></head><body>Public home.</body></html>';

function request(path = '/en/', method = 'GET'): Request {
  return new Request('https://vkvstudio.com' + path, { method });
}

function asset(body: BodyInit | null = html, changes: ResponseInit = {}): Response {
  return new Response(body, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
      ETag: '"raw-asset"',
      'Last-Modified': 'Fri, 02 Oct 2026 00:00:00 GMT',
      'Content-Length': String(new TextEncoder().encode(html).byteLength),
      'CDN-Cache-Control': 'public, max-age=3600',
      'Cloudflare-CDN-Cache-Control': 'public, max-age=3600',
      'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload',
      'Origin-Trial': 'public-token-placeholder',
    },
    ...changes,
  });
}

function nonceFrom(csp: string): string {
  const matches = Array.from(csp.matchAll(/'nonce-([A-Za-z0-9+/]{32})'/g));
  expect(matches).toHaveLength(1);
  return matches[0]?.[1] ?? '';
}

describe('per-response home GIS style permission', () => {
  it.each(['/en/', '/ru/'])(
    'adds only a style-element permission to %s and preserves the trusted body',
    async (path) => {
      const response = await transformHomeResponse(request(path), asset(), policy);
      expect(response.status).toBe(200);
      const csp = response.headers.get('Content-Security-Policy') ?? '';
      const nonce = nonceFrom(csp);
      const marker = `<meta name="vkv-gis-style-nonce" content="${nonce}">`;
      expect(await response.text()).toBe(html.replace('</head>', marker + '</head>'));
      expect(csp.replace(` 'nonce-${nonce}'`, '')).toBe(policy);
      expect(csp.split(';').find((part) => part.trim().startsWith('script-src '))).not.toContain(
        nonce
      );
      expect(
        csp.split(';').find((part) => part.trim().startsWith('style-src-attr '))
      ).not.toContain(nonce);
      expect(response.headers.get('Strict-Transport-Security')).toContain('includeSubDomains');
      expect(response.headers.get('Origin-Trial')).toBe('public-token-placeholder');
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
      for (const header of [
        'ETag',
        'Last-Modified',
        'Content-Length',
        'CDN-Cache-Control',
        'Cloudflare-CDN-Cache-Control',
      ]) {
        expect(response.headers.has(header)).toBe(false);
      }
      expect(
        new TextEncoder().encode('  Content-Security-Policy: ' + csp).byteLength
      ).toBeLessThanOrEqual(2000);
    }
  );

  it('generates a distinct nonce for every response instead of reusing asset/cache state', async () => {
    const responses = await Promise.all(
      Array.from({ length: 8 }, () => transformHomeResponse(request(), asset(), policy))
    );
    const nonces = responses.map((response) =>
      nonceFrom(response.headers.get('Content-Security-Policy') ?? '')
    );
    expect(new Set(nonces).size).toBe(8);
    expect(nonces.every((nonce) => atob(nonce).length === 24)).toBe(true);
  });

  it('returns HEAD without a body while retaining GET security and cache semantics', async () => {
    const get = await transformHomeResponse(request(), asset(), policy);
    const head = await transformHomeResponse(request('/en/', 'HEAD'), asset(), policy);
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    expect(head.body).toBeNull();
    const withoutNonce = (response: Response): [string, string][] =>
      Array.from(response.headers.entries()).map(([key, value]) => [
        key,
        value.replace(/ 'nonce-[A-Za-z0-9+/]{32}'/, ''),
      ]);
    expect(withoutNonce(head)).toEqual(withoutNonce(get));
  });

  it.each(['/', '/en', '/en/contact/', '/ru/lab/tokenizer/', '/%65n/', '//attacker.invalid/'])(
    'does not rewrite outside the exact home paths: %s',
    async (path) => {
      const original = asset();
      expect(await transformHomeResponse(request(path), original, policy)).toBe(original);
    }
  );

  it.each(['POST', 'OPTIONS'])('does not transform a %s request', async (method) => {
    const original = asset();
    expect(await transformHomeResponse(request('/en/', method), original, policy)).toBe(original);
  });

  it('does not rewrite an error asset or a non-HTML resource', async () => {
    const missing = asset('Not found', { status: 404 });
    expect(await transformHomeResponse(request(), missing, policy)).toBe(missing);
    const json = asset('{}', { headers: { 'Content-Type': 'application/json' } });
    expect(await transformHomeResponse(request(), json, policy)).toBe(json);
    const headMissing = await transformHomeResponse(
      request('/en/', 'HEAD'),
      asset('Not found', { status: 404 }),
      policy
    );
    expect(headMissing.status).toBe(404);
    expect(await headMissing.text()).toBe('');
  });

  it.each([
    '',
    policy + '; style-src-elem *',
    policy + ', default-src *',
    policy.replace("style-src-elem 'self'", "style-src-elem 'none'"),
    policy.replace("style-src-elem 'self'", "style-src-elem 'unsafe-inline'"),
    policy.replace("script-src 'self'", "script-src 'unsafe-eval'"),
    policy + "; style-src-elem 'nonce-fixed'",
    "default-src 'none'",
    policy + '\r\nX-Injection: true',
    policy + '; img-src ' + 'a'.repeat(2000),
  ])('fails closed for an ambiguous, weak or oversized route policy', async (candidate) => {
    const response = await transformHomeResponse(request(), asset(), candidate);
    expect(response.status).toBe(503);
    expect(response.headers.get('Content-Security-Policy')).toContain("default-src 'none'");
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.text()).toBe('Page temporarily unavailable.');
  });

  it.each([
    '<html><body>No head</body></html>',
    '<head></head><head></head>',
    '<head><title>No closing head</title>',
    '<head><meta name="vkv-gis-style-nonce" content="old"></head>',
    '<head><meta name="VKV-GIS-STYLE-NONCE" content="old"><meta name="vkv-gis-style-nonce" content="other"></head>',
    '</head><head>',
  ])('rejects missing or ambiguous HTML without reflecting it in an error', async (body) => {
    const response = await transformHomeResponse(request(), asset(body), policy);
    expect(response.status).toBe(503);
    expect(await response.text()).toBe('Page temporarily unavailable.');
  });

  it('enforces actual stream bytes even when the declared length is false and cancels excess data', async () => {
    const cancelled = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      pull(controller): void {
        controller.enqueue(new Uint8Array(1_048_577));
      },
      cancel: cancelled,
    });
    const response = await transformHomeResponse(
      request(),
      asset(stream, { headers: { 'Content-Type': 'text/html', 'Content-Length': '1' } }),
      policy
    );
    expect(response.status).toBe(503);
    expect(cancelled).toHaveBeenCalledOnce();
    expect(await response.text()).toBe('Page temporarily unavailable.');
  });

  it.each([
    new Headers({ 'Content-Type': 'text/html', 'Content-Encoding': 'gzip' }),
    new Headers({ 'Content-Type': 'text/html; charset=iso-8859-1' }),
    new Headers({ 'Content-Type': 'text/html', 'Content-Length': '999999999999999999999' }),
  ])('does not reinterpret encoded, unsupported or oversized assets', async (headers) => {
    const response = await transformHomeResponse(request(), asset(html, { headers }), policy);
    expect(response.status).toBe(503);
  });

  it('does not return decoder/stream/private details or a body for failed HEAD', async () => {
    const broken = new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.error(new Error('Private upstream detail'));
      },
    });
    const response = await transformHomeResponse(request(), asset(broken), policy);
    expect(await response.text()).toBe('Page temporarily unavailable.');
    const head = await transformHomeResponse(
      request('/en/', 'HEAD'),
      asset('<body>No head</body>'),
      policy
    );
    expect(head.status).toBe(503);
    expect(await head.text()).toBe('');
  });
});
