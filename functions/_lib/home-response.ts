const HOME_PATHS = new Set(['/en/', '/ru/']);
const MAX_HTML_BYTES = 1_048_576;
const MAX_CSP_HEADER_BYTES = 2_000;
const NONCE_META_NAME = 'vkv-gis-style-nonce';
const FAILURE_CSP =
  "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'";

function responseHeaders(asset: Response): Headers {
  const headers = new Headers(asset.headers);
  for (const name of [
    'Content-Length',
    'Content-Encoding',
    'ETag',
    'Last-Modified',
    'Content-MD5',
    'Digest',
    'Age',
    'Expires',
    'CDN-Cache-Control',
    'Cloudflare-CDN-Cache-Control',
    'Surrogate-Control',
  ]) {
    headers.delete(name);
  }
  headers.set('Cache-Control', 'no-store');
  headers.set('X-Content-Type-Options', 'nosniff');
  return headers;
}

function unavailable(request: Request, asset: Response): Response {
  const headers = responseHeaders(asset);
  headers.set('Content-Type', 'text/plain; charset=utf-8');
  headers.set('Content-Security-Policy', FAILURE_CSP);
  headers.set('Referrer-Policy', 'no-referrer');
  return new Response(request.method === 'HEAD' ? null : 'Page temporarily unavailable.', {
    status: 503,
    headers,
  });
}

function withStyleNonce(csp: string, nonce: string): string {
  // The caller supplies the build's exact route policy, never a request header.
  // Refuse merged/ambiguous policies instead of accidentally relaxing one.
  if (
    !csp ||
    /[^\x20-\x7e]|,/.test(csp) ||
    csp.includes("'unsafe-inline'") ||
    /'nonce-/.test(csp)
  ) {
    throw new Error('Invalid route policy');
  }
  const segments = csp.split(';');
  const directives = new Set<string>();
  let styleIndex = -1;
  for (const [index, segment] of segments.entries()) {
    const trimmed = segment.trim();
    if (!trimmed) continue;
    const [name, ...sources] = trimmed.split(/ +/);
    if (!name || !/^[a-z][a-z0-9-]*$/.test(name) || directives.has(name)) {
      throw new Error('Invalid route policy');
    }
    directives.add(name);
    if (name === 'script-src' && sources.includes("'unsafe-eval'")) {
      throw new Error('Invalid route policy');
    }
    if (name === 'style-src-elem') {
      if (!sources.length || sources.includes("'none'")) throw new Error('Invalid style policy');
      styleIndex = index;
    }
  }
  if (styleIndex < 0 || !directives.has('script-src')) throw new Error('Missing route policy');
  const segment = segments[styleIndex];
  if (segment === undefined) throw new Error('Missing style policy');
  segments[styleIndex] = segment.trimEnd() + ` 'nonce-${nonce}'`;
  const policy = segments.join(';');
  if (
    new TextEncoder().encode('  Content-Security-Policy: ' + policy).byteLength >
    MAX_CSP_HEADER_BYTES
  ) {
    throw new Error('Route policy exceeds limit');
  }
  return policy;
}

async function readHtml(asset: Response): Promise<string> {
  if (!asset.body) throw new Error('Missing HTML body');
  const declaredLength = asset.headers.get('Content-Length');
  if (
    declaredLength !== null &&
    (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_HTML_BYTES)
  ) {
    throw new Error('HTML exceeds limit');
  }
  const reader = asset.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_HTML_BYTES) {
        await reader.cancel();
        throw new Error('HTML exceeds limit');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

/**
 * The Worker must fetch a trusted canonical home ASSET with GET/identity and
 * supply that path's generated security policy. Other assets remain static.
 */
export async function transformHomeResponse(
  request: Request,
  trustedAssetResponse: Response,
  exactRouteCsp: string
): Promise<Response> {
  const pathname = new URL(request.url).pathname;
  if (!HOME_PATHS.has(pathname) || !['GET', 'HEAD'].includes(request.method)) {
    return trustedAssetResponse;
  }
  const mediaType = trustedAssetResponse.headers.get('Content-Type') ?? '';
  if (trustedAssetResponse.status !== 200 || !/^text\/html(?:\s*;|$)/i.test(mediaType)) {
    return request.method === 'HEAD'
      ? new Response(null, {
          status: trustedAssetResponse.status,
          statusText: trustedAssetResponse.statusText,
          headers: trustedAssetResponse.headers,
        })
      : trustedAssetResponse;
  }
  try {
    const encoding = trustedAssetResponse.headers.get('Content-Encoding');
    if (encoding && encoding.toLowerCase() !== 'identity') throw new Error('Encoded asset');
    const charset = /;\s*charset\s*=\s*([^;\s]+)/i.exec(mediaType)?.[1];
    if (charset && !/^"?utf-8"?$/i.test(charset)) throw new Error('Unsupported charset');
    const html = await readHtml(trustedAssetResponse);
    const openings = Array.from(html.matchAll(/<head(?:\s[^<>]*)?>/gi));
    const closings = Array.from(html.matchAll(/<\/head\s*>/gi));
    const opening = openings[0];
    const closing = closings[0];
    if (
      openings.length !== 1 ||
      closings.length !== 1 ||
      !opening ||
      !closing ||
      opening.index >= closing.index ||
      html.toLowerCase().includes(NONCE_META_NAME)
    ) {
      throw new Error('Ambiguous HTML head');
    }
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    const nonce = btoa(String.fromCharCode(...bytes));
    const policy = withStyleNonce(exactRouteCsp, nonce);
    const marker = `<meta name="${NONCE_META_NAME}" content="${nonce}">`;
    const body = html.slice(0, closing.index) + marker + html.slice(closing.index);
    const headers = responseHeaders(trustedAssetResponse);
    headers.set('Content-Security-Policy', policy);
    return new Response(request.method === 'HEAD' ? null : body, { status: 200, headers });
  } catch {
    return unavailable(request, trustedAssetResponse);
  }
}
