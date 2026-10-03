import { handleContactRequest, type ContactEnvironment } from './contact-delivery';
import { transformHomeResponse } from './home-response';

export type HomePath = '/en/' | '/ru/';
export type HomeSecurityHeaders = Readonly<Record<HomePath, Readonly<Record<string, string>>>>;

export interface SiteEnvironment extends ContactEnvironment {
  ASSETS: { fetch(request: Request): Promise<Response> };
}

export interface SiteWorker {
  fetch(request: Request, env: SiteEnvironment): Promise<Response>;
}

const HOME_PATHS: HomePath[] = ['/en/', '/ru/'];
const restrictive =
  "default-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

function errorResponse(request: Request, status: number, sourceHeaders?: Headers): Response {
  const headers = new Headers(sourceHeaders);
  headers.set('Content-Type', 'text/plain; charset=utf-8');
  headers.set('Content-Security-Policy', restrictive);
  headers.set('Cache-Control', 'no-store');
  headers.set('X-Content-Type-Options', 'nosniff');
  if (status === 405) headers.set('Allow', 'GET, HEAD');
  return new Response(
    request.method === 'HEAD'
      ? null
      : status === 405
        ? 'Method not allowed.'
        : 'Page temporarily unavailable.',
    { status, headers }
  );
}

/** Route policies are built into this module, never taken from user input. */
export function createSiteWorker(exactHomeHeaders: HomeSecurityHeaders): SiteWorker {
  if (Object.keys(exactHomeHeaders).sort().join(',') !== HOME_PATHS.join(',')) {
    throw new Error('Invalid home header manifest');
  }
  const policies = new Map<HomePath, Headers>();
  for (const path of HOME_PATHS) {
    const source = exactHomeHeaders[path];
    if (!source || typeof source !== 'object' || Array.isArray(source))
      throw new Error('Invalid home header manifest');
    const headers = new Headers();
    for (const [name, value] of Object.entries(source)) {
      if (
        typeof value !== 'string' ||
        !/^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(name) ||
        /[\x00-\x1f\x7f]/.test(value) ||
        new TextEncoder().encode('  ' + name + ': ' + value).byteLength > 2000
      ) {
        throw new Error('Invalid home header manifest');
      }
      headers.set(name, value);
    }
    if (!headers.has('Content-Security-Policy')) throw new Error('Missing home policy');
    policies.set(path, headers);
  }

  return {
    async fetch(request: Request, env: SiteEnvironment): Promise<Response> {
      const url = new URL(request.url);
      if (url.pathname === '/api/contact') return handleContactRequest(request, env);
      const home = url.pathname === '/en' ? '/en/' : url.pathname === '/ru' ? '/ru/' : url.pathname;
      const baseHeaders = policies.get(home as HomePath);
      if (!baseHeaders) {
        try {
          return await env.ASSETS.fetch(request);
        } catch {
          return errorResponse(request, 503);
        }
      }
      if (request.method !== 'GET' && request.method !== 'HEAD')
        return errorResponse(request, 405, baseHeaders);
      if (url.pathname !== home) {
        const headers = new Headers(baseHeaders);
        headers.set('Location', home + url.search);
        headers.set('Cache-Control', 'no-store');
        return new Response(null, { status: 308, headers });
      }
      try {
        // Only the fixed public document is needed. Do not forward cookies,
        // authorization, Range or conditional headers into the asset binding.
        const assetRequest = new Request(url.href, {
          method: 'GET',
          headers: { 'Accept-Encoding': 'identity' },
        });
        const asset = await env.ASSETS.fetch(assetRequest);
        const headers = new Headers(asset.headers);
        for (const [name, value] of baseHeaders) headers.set(name, value);
        const securedAsset = new Response(asset.body, {
          status: asset.status,
          statusText: asset.statusText,
          headers,
        });
        return await transformHomeResponse(
          request,
          securedAsset,
          baseHeaders.get('Content-Security-Policy') ?? ''
        );
      } catch {
        return errorResponse(request, 503, baseHeaders);
      }
    },
  };
}
