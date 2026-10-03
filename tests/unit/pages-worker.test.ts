import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createSiteWorker,
  type HomeSecurityHeaders,
  type SiteEnvironment,
} from '../../functions/_lib/site-worker';
import {
  homeHeaderManifest,
  parsePageHeaders,
  resolvePageHeaders,
  WORKER_ROUTES,
} from '../../src/build/pages-worker.mjs';

const policy =
  "default-src 'self'; script-src 'self' https://accounts.google.com/gsi/client; style-src 'self'; style-src-elem 'self'; style-src-attr 'none'; object-src 'none'; base-uri 'self'; require-trusted-types-for 'script'";
const home = '<html><head><title>Studio</title></head><body>Public home</body></html>';
const globalHeaders = {
  'content-security-policy': policy,
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'camera=(), microphone=()',
  'origin-trial': 'public-test-token',
};
const manifest: HomeSecurityHeaders = {
  '/en/': { ...globalHeaders, 'content-language': 'en' },
  '/ru/': { ...globalHeaders, 'content-language': 'ru' },
};
function request(path = '/en/', method = 'GET', headers?: HeadersInit): Request {
  return new Request('https://vkvstudio.com' + path, { method, headers });
}
function assets(
  response: () => Response = () =>
    new Response(home, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'public, max-age=3600',
        ETag: '"raw"',
      },
    })
): {
  env: SiteEnvironment;
  binding: ReturnType<typeof vi.fn<(req: Request) => Promise<Response>>>;
} {
  const binding = vi.fn(async (_req: Request): Promise<Response> => response());
  return { env: { ASSETS: { fetch: binding } }, binding };
}
beforeEach(() =>
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('No test upstream permitted');
    })
  )
);
afterEach(() => vi.unstubAllGlobals());

describe('bounded Pages worker routes', () => {
  it.each(['/en/', '/ru/'])(
    'applies every exact route header and a fresh style-only nonce to %s',
    async (path) => {
      const { env, binding } = assets();
      const worker = createSiteWorker(manifest);
      const first = await worker.fetch(request(path), env);
      const second = await worker.fetch(request(path), env);
      const firstCsp = first.headers.get('Content-Security-Policy') ?? '';
      const secondCsp = second.headers.get('Content-Security-Policy') ?? '';
      expect(first.status).toBe(200);
      expect(firstCsp).not.toBe(secondCsp);
      expect(firstCsp.replace(/ 'nonce-[A-Za-z0-9+/]{32}'/, '')).toBe(policy);
      expect(firstCsp.split(';').find((s) => s.trim().startsWith('script-src '))).toBe(
        policy.split(';').find((s) => s.trim().startsWith('script-src '))
      );
      for (const [name, value] of Object.entries(manifest[path as '/en/' | '/ru/'])) {
        if (name !== 'content-security-policy') expect(first.headers.get(name)).toBe(value);
      }
      expect(first.headers.get('Cache-Control')).toBe('no-store');
      expect(first.headers.has('ETag')).toBe(false);
      expect(await first.text()).toContain('name="vkv-gis-style-nonce"');
      expect(binding).toHaveBeenCalledTimes(2);
      expect(fetch).not.toHaveBeenCalled();
    }
  );

  it('obtains an unconditional identity GET for HEAD and returns no body', async () => {
    const { env, binding } = assets();
    const response = await createSiteWorker(manifest).fetch(
      request('/en/', 'HEAD', {
        Range: 'bytes=0-4',
        'If-Range': 'old',
        'If-Match': 'old',
        'If-None-Match': '*',
        'If-Modified-Since': 'Fri, 02 Oct 2026 00:00:00 GMT',
        'If-Unmodified-Since': 'Fri, 02 Oct 2026 00:00:00 GMT',
        'Accept-Encoding': 'gzip',
        Cookie: 'private-test-only',
        Authorization: 'test-only',
      }),
      env
    );
    const received = binding.mock.calls[0]?.[0];
    expect(received?.method).toBe('GET');
    expect(received?.url).toBe('https://vkvstudio.com/en/');
    expect(Array.from(received?.headers ?? [])).toEqual([['accept-encoding', 'identity']]);
    expect(response.status).toBe(200);
    expect(response.body).toBeNull();
    expect(await response.text()).toBe('');
    expect(response.headers.has('Content-Length')).toBe(false);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.has('Authorization')).toBe(false);
    expect(response.headers.has('Cookie')).toBe(false);
  });

  it.each(['/en', '/ru'])(
    'redirects %s locally without an asset fetch or an open redirect',
    async (path) => {
      const { env, binding } = assets();
      const response = await createSiteWorker(manifest).fetch(
        request(path + '?source=public'),
        env
      );
      expect(response.status).toBe(308);
      expect(response.headers.get('Location')).toBe(path + '/?source=public');
      expect(new URL(response.headers.get('Location') ?? '', 'https://vkvstudio.com').origin).toBe(
        'https://vkvstudio.com'
      );
      expect(binding).not.toHaveBeenCalled();
    }
  );

  it.each(['/en/', '/en', '/ru/', '/ru'])(
    'rejects unsupported home methods at %s',
    async (path) => {
      const { env, binding } = assets();
      const response = await createSiteWorker(manifest).fetch(request(path, 'POST'), env);
      expect(response.status).toBe(405);
      expect(response.headers.get('Allow')).toBe('GET, HEAD');
      expect(response.headers.get('Content-Security-Policy')).toContain("default-src 'none'");
      expect(binding).not.toHaveBeenCalled();
    }
  );

  it.each([
    '/',
    '/api/contact/',
    '/en/contact/',
    '/en/lab/tokenizer/',
    '/_astro/public.js',
    '/%2fattacker.invalid/index.html',
  ])('delegates unrelated assets unchanged: %s', async (path) => {
    const original = new Response('static', {
      headers: { 'Content-Type': 'text/plain', ETag: '"public"' },
    });
    const { env, binding } = assets(() => original);
    const req = request(path);
    expect(await createSiteWorker(manifest).fetch(req, env)).toBe(original);
    expect(binding).toHaveBeenCalledWith(req);
  });

  it('delegates the real contact handler with readiness and method gates, without contacting providers', async () => {
    const { env, binding } = assets();
    const worker = createSiteWorker(manifest);
    const unavailable = await worker.fetch(request('/api/contact'), env);
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({ ok: false, code: 'unavailable' });
    const unsupported = await worker.fetch(request('/api/contact', 'DELETE'), env);
    expect(unsupported.status).toBe(405);
    expect(unsupported.headers.get('Allow')).toBe('GET, POST');
    const forbidden = await worker.fetch(
      request('/api/contact', 'POST', { Origin: 'https://attacker.invalid' }),
      env
    );
    expect(forbidden.status).toBe(403);
    expect(binding).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('preserves a failed or non-HTML asset without adding any nonce', async () => {
    const { env } = assets(
      () => new Response('Missing', { status: 404, headers: { 'Content-Type': 'text/plain' } })
    );
    const response = await createSiteWorker(manifest).fetch(request(), env);
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('Missing');
    expect(response.headers.get('Content-Security-Policy')).toBe(policy);
    expect(response.headers.has('Strict-Transport-Security')).toBe(true);
  });

  it('fails closed for an unavailable asset binding and never reflects errors', async () => {
    const env: SiteEnvironment = {
      ASSETS: {
        fetch: async (): Promise<Response> => {
          throw new Error('Private service detail');
        },
      },
    };
    const response = await createSiteWorker(manifest).fetch(request(), env);
    expect(response.status).toBe(503);
    expect(await response.text()).toBe('Page temporarily unavailable.');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Content-Security-Policy')).toContain("default-src 'none'");
  });

  it('rejects a missing policy, foreign route or response-header injection in its trusted manifest', () => {
    for (const candidate of [
      { '/en/': {}, '/ru/': {} },
      { ...manifest, '/foreign/': globalHeaders },
      { ...manifest, '/en/': { ...globalHeaders, 'x-extra': 'bad\r\nInjected: true' } },
    ]) {
      expect(() => createSiteWorker(candidate as HomeSecurityHeaders)).toThrow();
    }
  });
});

describe('public build header manifest', () => {
  const input =
    "/*\n  Content-Security-Policy: default-src 'none'\n  X-Public: first\n  Referrer-Policy: no-referrer\n/en/\n  ! Content-Security-Policy\n  Content-Security-Policy: " +
    policy +
    '\n  X-Public: second\n/ru/\n  ! Content-Security-Policy\n  Content-Security-Policy: ' +
    policy +
    '\n';
  it('matches Cloudflare unset-then-append semantics and retains every header', () => {
    const rules = parsePageHeaders(input);
    expect(resolvePageHeaders(rules, '/en/')['content-security-policy']).toBe(policy);
    expect(resolvePageHeaders(rules, '/en/')['x-public']).toBe('first, second');
    expect(homeHeaderManifest(input)).toEqual({
      '/en/': {
        'content-security-policy': policy,
        'x-public': 'first, second',
        'referrer-policy': 'no-referrer',
      },
      '/ru/': {
        'content-security-policy': policy,
        'x-public': 'first',
        'referrer-policy': 'no-referrer',
      },
    });
  });
  it('does not accept an AND-merged policy or a global-only fallback as a home policy', () => {
    expect(() => homeHeaderManifest(input.replaceAll('  ! Content-Security-Policy\n', ''))).toThrow(
      'Ambiguous'
    );
    expect(() => homeHeaderManifest("/*\n  Content-Security-Policy: default-src 'none'\n")).toThrow(
      'Missing exact'
    );
  });
  it.each([
    '/*\n  X-Test: ' + 'a'.repeat(2000),
    '/*\n  X-Test: value\0suffix',
    '/*\n  X-Test: public\n/*\n  X-Test: duplicate',
    '/bad?query\n  X-Test: public',
  ])('rejects oversized/ambiguous header syntax', (candidate) => {
    expect(() => parsePageHeaders(candidate)).toThrow();
  });
  it('keeps the Worker invocation list to the exact API and home routes', () => {
    expect(WORKER_ROUTES).toEqual({
      version: 1,
      include: ['/api/contact', '/en', '/en/', '/ru', '/ru/'],
      exclude: [],
    });
  });
});
