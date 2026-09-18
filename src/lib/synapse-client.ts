/**
 * synapse-client.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Production API client for SynapseTerminal → FastAPI inference server.
 *
 * Features:
 *  • POST /api/chat — text chat with 120s timeout + AbortController
 *  • GET  /api/health — availability check, cached 60 s
 *  • Automatic mock fallback when backend is unreachable
 *  • allowlist-based XSS sanitizer (no external deps)
 *  • source indicator: 'live' | 'mock'
 *
 * Phase: 3.4.5 — Backend Integration (text, non-streaming)
 * Streaming (SSE) is Phase 3.4.6.
 */

import { mockSynapseResponse } from '@/lib/synapse-mock';
import { SYNAPSE_API_BASE } from './api-config';
import { getIdToken } from './auth';

/**
 * Attach the Google ID token to a generation request, when there is one.
 *
 * Every route that spends the owner's hardware or his Google quota —
 * /api/chat, /api/chat/stream, /api/voice, /api/voice/stream, /api/tts — is
 * metered per identity by the backend. Until this existed, the client sent no
 * credential at all on any of them: the backend's per-account allowance could
 * therefore never be attributed to an account, and the sign-in requirement was
 * unsatisfiable — turning it on would have locked out signed-in users too.
 * Conversation sync (synapse-db-server.ts) had carried the header all along;
 * only the generation half was missing it.
 *
 * Anonymous visitors still get a request, without the header. The backend
 * decides what an anonymous caller is allowed — that is not the client's call
 * to make, and a client-side gate would be worth nothing anyway.
 */
function withAuth(headers: Record<string, string> = {}): Record<string, string> {
  const token = getIdToken();
  return token ? { ...headers, Authorization: `Bearer ${token}` } : headers;
}

// ─── Public types ─────────────────────────────────────────────────────────────

export interface SynapseClientConfig {
  /** Base URL of the inference server (no trailing slash) */
  baseUrl: string;
  /** Timeout in ms for health check (default: 3000) */
  healthTimeout?: number;
  /** Use mock fallback when backend is unreachable (default: true) */
  useMockFallback?: boolean;
}

export interface ChatRequest {
  message: string;
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
}

export interface ChatResponse {
  content: string;
  /** Whether this response came from the live backend or mock */
  source: 'live' | 'mock';
  /**
   * Which model produced this response — the router's pick ('e2b' | 'e4b') from
   * the live backend, or 'mock' when the mock fallback answered. Drives the
   * per-message model badge in the UI. `undefined` if the backend didn't report one.
   */
  model?: 'e2b' | 'e4b' | 'mock' | string;
}

/**
 * A reply the backend actually sent, with a status we should not flatten.
 *
 * Every failure used to become `new Error("HTTP 503: Service Unavailable")` —
 * a string — so callers could not tell "nothing is listening on that host" from
 * "the server answered, and what it said was: I am busy, come back in 5s".
 * The backend distinguishes them deliberately (main.py sheds load with 503 +
 * `Retry-After`, and rate-limits with 429), and throwing that away is what made
 * the UI badge a live-but-busy backend as unavailable.
 */
export class SynapseHttpError extends Error {
  readonly status: number;
  /** Seconds, from the `Retry-After` header, when the server supplied one. */
  readonly retryAfter?: number;

  constructor(status: number, statusText: string, retryAfter?: number) {
    super(`HTTP ${status}: ${statusText}`);
    this.name = 'SynapseHttpError';
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

/** Builds a SynapseHttpError from a failed Response, reading Retry-After. */
export function httpError(res: Response): SynapseHttpError {
  const raw = res.headers.get('Retry-After');
  const seconds = raw === null ? Number.NaN : Number(raw);
  return new SynapseHttpError(
    res.status,
    res.statusText,
    Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined
  );
}

/**
 * Why the mock is answering instead of the backend. `unreachable` means the
 * request never got a reply; `busy` means it did, and the reply was a refusal
 * we are meant to retry; `error` is any other status the server returned.
 */
export interface FallbackInfo {
  kind: 'unreachable' | 'busy' | 'error' | 'auth' | 'quota';
  status?: number;
  retryAfter?: number;
}

/**
 * A Retry-After this long means a policy, not congestion.
 *
 * The backend uses 429 for two unrelated things: shedding load (retry in ~5s)
 * and a spent per-account allowance (retry in hours). Telling a visitor the
 * server is "busy" when they have actually used up their five messages would be
 * a small lie, and the wait is long enough that they would notice it was one.
 */
const QUOTA_RETRY_THRESHOLD_SEC = 120;

/** Classifies a thrown error for the UI, without inventing detail it lacks. */
export function describeFailure(err: unknown): FallbackInfo {
  if (err instanceof SynapseHttpError) {
    if (err.status === 401 || err.status === 403) {
      return { kind: 'auth', status: err.status };
    }
    if (err.status === 429 || err.status === 503) {
      const quota = (err.retryAfter ?? 0) >= QUOTA_RETRY_THRESHOLD_SEC;
      return { kind: quota ? 'quota' : 'busy', status: err.status, retryAfter: err.retryAfter };
    }
    return { kind: 'error', status: err.status };
  }
  return { kind: 'unreachable' };
}

/**
 * What the mock says when the backend refused for a POLICY reason.
 *
 * Live generation runs on a metered GPU, so it is for signed-in visitors and
 * rationed even then. Answering those two cases with the ordinary scripted mock
 * would leave someone staring at a canned reply with no idea why, or worse,
 * assuming the assistant is broken. Say what happened and what unlocks it.
 *
 * Language is picked from the visitor's own message rather than the page locale,
 * because someone can type Russian on the English site and deserves an answer
 * they can read.
 */
function policyMessage(info: FallbackInfo, userMessage: string): string | null {
  const ru = /[а-яё]/i.test(userMessage);

  if (info.kind === 'auth') {
    return ru
      ? 'Это шаблонный ответ, а не модель. Живой Synapse — дообученная Gemma 4 на своём сервере — отвечает после входа через Google: он работает на GPU, который оплачивается из кармана, поэтому доступ именной. Кнопка входа слева.'
      : 'This is a scripted reply, not the model. The live Synapse — a fine-tuned Gemma 4 on my own server — answers once you sign in with Google: it runs on a GPU I pay for, so access is per-account. The sign-in button is on the left.';
  }

  if (info.kind === 'quota') {
    const mins = Math.round((info.retryAfter ?? 0) / 60);
    const when = mins >= 60 ? `${Math.round(mins / 60)} ч` : `${mins} мин`;
    const whenEn = mins >= 60 ? `${Math.round(mins / 60)} hours` : `${mins} minutes`;
    // "a metered GPU" was wrong here and only right in the auth branch above:
    // the quota applies on the self-hosted CPU box too, where there is no GPU
    // and nothing metered — the limit exists because one small server serves
    // everybody. Say that instead; it is true in both deployments.
    return ru
      ? `Это шаблонный ответ — ваши сообщения к живой модели на сейчас закончились. Она работает на одном своём сервере, поэтому норма небольшая. Следующее откроется примерно через ${when}.`
      : `This is a scripted reply — you have used your messages to the live model for now. It runs on a single self-hosted server, so the allowance is small. The next one opens in about ${whenEn}.`;
  }

  return null;
}

/** Callbacks for streaming chat */
export interface ChatStreamCallbacks {
  onToken?: (token: string) => void;
  onDone?: (fullText: string) => void;
  onError?: (error: string) => void;
  /** Fired once with the model that is answering ('e2b' | 'e4b' | 'mock'). */
  onModel?: (model: string) => void;
  /**
   * Fired when the backend failed and the mock is taking over, with the reason.
   * Optional, so existing callers keep compiling and simply stay unaware.
   */
  onFallback?: (info: FallbackInfo) => void;
}

/** Callbacks for streaming voice */
export interface VoiceStreamCallbacks {
  onTranscript?: (data: {
    text: string;
    lang: string;
    duration: number;
    confidence: number;
  }) => void;
  onToken?: (token: string) => void;
  onAudio?: (audioBlob: Blob) => void;
  onDone?: () => void;
  onError?: (error: string) => void;
}

export interface SynapseClient {
  /** Send a chat message and receive the full response */
  chat(request: ChatRequest): Promise<ChatResponse>;
  /** Stream chat response token by token. Optional signal aborts the stream. */
  chatStream(
    request: ChatRequest,
    callbacks: ChatStreamCallbacks,
    signal?: AbortSignal
  ): Promise<void>;
  /** Send a voice blob and receive audio + transcripts */
  sendVoice(audioBlob: Blob): Promise<{
    audioBlob: Blob;
    transcriptText: string;
    responseText: string;
    source: 'live' | 'mock';
  }>;
  /** Stream voice pipeline: transcript → tokens → audio. Optional signal aborts the stream. */
  sendVoiceStream(
    audioBlob: Blob,
    callbacks: VoiceStreamCallbacks,
    signal?: AbortSignal
  ): Promise<void>;
  /** Synthesize text to speech */
  synthesizeText(text: string): Promise<Blob>;
  /** Check if the backend is reachable */
  healthCheck(): Promise<boolean>;
  /** Whether the last request used the live backend */
  readonly isLive: boolean;
}

// ─── Sanitizer ────────────────────────────────────────────────────────────────

/**
 * Strip potentially dangerous HTML/script content from AI responses to plain text.
 *
 * NOTE ON THE ARCHITECTURE (read before trusting this):
 * The PRIMARY, load-bearing XSS boundary for LIVE (streamed) model output is
 * `renderInline()` in `@/lib/synapse-render` — it escape-then-transforms at render
 * time and is what actually feeds the terminal's only `{@html}` sink. THIS function
 * is a secondary, standalone text-sanitizer used by the non-streaming `chat()`/
 * `sendVoice()` helpers and the mock fallback; keep it robust on its own so it's
 * safe even if its output is ever placed in a raw-HTML sink directly.
 *
 * An audit (2026-08-25) took that last sentence at face value and found three
 * ways through: handler names longer than twenty letters, tags with no closing
 * `>`, and named entities. All three are closed below. Read the sentence as a
 * requirement this function has to keep earning, not as a description of a
 * guarantee already held — if you widen what it accepts, widen the tests in
 * the same commit.
 *
 * What this removes:
 *  - Any <tag> / </tag> / <tag/> constructs — stripped to a FIXED POINT so a
 *    nested/split payload like `<<script>script>` can't reconstruct a live tag.
 *  - javascript: / data: / vbscript: URI schemes (case-insensitive)
 *  - on* event attribute patterns (onclick=, onerror=, …)
 *  - HTML numeric entities that reconstruct control chars, comments, CDATA.
 */
export function sanitizeResponse(raw: string): string {
  if (!raw || typeof raw !== 'string') return '';

  let clean = raw;

  /* EVERY removal runs inside ONE fixed-point loop, and that is the fix.

     The passes used to run in stages: entities, then tags to a fixed point,
     then schemes and handlers once, then comments and CDATA once. Only the tag
     stage looped, so anything a LATER stage could reconstruct was never
     re-examined — and stripping a comment splices its neighbours together,
     which is exactly how these payloads work:

       `<<!-- -->script>`     → comment gone → `<script>`     (tag stage already ran)
       `o<!--y-->nerror=`     → comment gone → `onerror=`     (handler stage already ran)
       `java<!--y-->script:`  → comment gone → `javascript:`  (scheme stage already ran)

     Measured, not argued: twelve such payloads fed to the staged version came
     out with a live tag, handler or scheme ten times. tests/unit/sanitizer.test.ts
     keeps feeding them. Looping all the removals together means every splice is
     re-scanned until the string stops changing, so there is no "after" stage for
     a payload to reassemble in.

     The scheme pattern also loses its leading `\b`: it required a word boundary
     before `javascript:`, so `javajavascript:script:` — the very nesting the
     loop unwraps — matched nothing. Without the anchor the inner scheme is
     stripped and the loop handles what that splices.

     Deliberately blunt: `Array<T>` and `Vec<u8>` are stripped from ordinary
     prose too, because this rule cannot tell them from a tag. That is the wrong
     trade for a Markdown renderer and the right one for a sanitizer — an
     allowlist of "tags that look harmless" is how these get bypassed. Live
     terminal output does NOT pass through here; it goes through renderInline()
     in synapse-render.ts, which escapes first and never has to guess. */
  let prev: string;
  do {
    prev = clean;
    clean = clean.replace(/&#[xX]?[0-9a-fA-F]+;?/g, ''); // numeric entities
    // Named entities that can rebuild markup on a later decode. The numeric
    // forms were already handled; `&lt;script&gt;` was not, so it travelled
    // through intact and became live markup the moment anything decoded it
    // once — the classic mXSS shape.
    clean = clean.replace(/&(?:lt|gt|amp|quot|apos|sol|colon|Tab|NewLine);?/gi, '');
    clean = clean.replace(/<!--[\s\S]*?-->/g, ''); // comments (splice source)
    clean = clean.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, ''); // CDATA
    clean = clean.replace(/<\/?[a-zA-Z][^>]*\/?>/g, ''); // tags
    // A tag that never closes. The rule above needs a `>`, so
    // `<img src=x onerror=alert(1)` with no terminator kept its opener and lost
    // only the handler — and a browser parsing a raw-HTML sink closes it for you.
    clean = clean.replace(/<\/?[a-zA-Z][^>]*$/g, '');
    clean = clean.replace(/(?:javascript|vbscript)\s*:/gi, ''); // script schemes
    // `data:` only where it is actually a data URL — a MIME type, a `;base64`
    // marker or the payload comma after it. Stripping it unconditionally
    // mangled ordinary prose the model writes: "See data: structures" came out
    // as "See  structures", and "metadata: 42" as "meta 42".
    clean = clean.replace(/data\s*:(?=\s*[a-z0-9.+-]*\s*[;,/])/gi, '');
    // `{2,20}` missed every longer handler name — `onwebkitanimationiteration=`
    // is 26 characters and passed through untouched. There is no upper bound
    // worth guessing, so there is no upper bound.
    clean = clean.replace(/\bon[a-zA-Z]+\s*=/gi, ''); // event handlers
  } while (clean !== prev);

  return clean;
}

// ─── Health cache ─────────────────────────────────────────────────────────────

// A POSITIVE result (backend alive) is trusted for a full minute — it rarely
// changes. A NEGATIVE result is cached only briefly: a single slow/unlucky probe
// (backend busy loading a model, or a heavy concurrent request) must NOT strand
// the whole assistant on the mock for 60s. Fail fast to recover, not to give up.
const HEALTH_CACHE_ALIVE_TTL_MS = 60_000; // trust "alive" for 60s
const HEALTH_CACHE_DEAD_TTL_MS = 5_000; // re-probe "dead" after just 5s

interface HealthCache {
  alive: boolean;
  timestamp: number;
}

// ─── Factory ──────────────────────────────────────────────────────────────────

// ── SSE stream parser ─────────────────────────────────────────────────────────

/**
 * Read an SSE response and hand each complete `event:`/`data:` pair to a handler.
 *
 * Module-level and exported rather than closed over inside the client factory,
 * for one reason: this is the function every streamed token passes through, and
 * while it lived inside the closure it was the only path in the file that no
 * test could reach. It needs none of the factory's state, so hiding it bought
 * nothing and cost the coverage. The tests in tests/unit/sse-parser.test.ts
 * feed it deliberately hostile chunk splits.
 *
 * The whole difficulty is that a network chunk boundary falls wherever TCP
 * decides. Two things follow, and both were once wrong here:
 *
 *   • `currentEvent` must outlive a single read(). An event is two lines, and
 *     when `event: token` arrived in one chunk and its `data:` in the next, a
 *     per-iteration variable was empty by the time the data line was parsed —
 *     so the event was dropped with no token, no error and a reply quietly
 *     missing a word.
 *
 *   • The tail must be flushed. The loop keeps the last, possibly incomplete
 *     line in `buffer`; if a server closes cleanly after a final `data:` line
 *     with no trailing newline, that line is complete but was never parsed.
 */
export async function parseSSEStream(
  response: Response,
  handlers: {
    onEvent: (event: string, data: string) => void;
    onDone?: () => void;
  }
): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('No response body');

  const decoder = new TextDecoder();
  let buffer = '';
  let currentEvent = '';

  const consume = (line: string): void => {
    if (line.startsWith('event: ')) {
      currentEvent = line.slice(7).trim();
    } else if (line.startsWith('data: ')) {
      const data = line.slice(6);
      if (currentEvent) {
        handlers.onEvent(currentEvent, data);
        currentEvent = '';
      }
    } else if (line === '') {
      currentEvent = '';
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop() ?? ''; // keep the incomplete last line for the next read
    for (const line of lines) consume(line);
  }

  // Flush whatever a multi-byte character left pending, then the final line.
  buffer += decoder.decode();
  if (buffer !== '') consume(buffer);

  handlers.onDone?.();
}

export function createSynapseClient(config?: Partial<SynapseClientConfig>): SynapseClient {
  const baseUrl = config?.baseUrl?.replace(/\/$/, '') ?? SYNAPSE_API_BASE;
  // 3s was too aggressive: /api/health can lag behind a busy backend (model
  // load, a concurrent generation) even though it's alive. 8s tolerates that
  // without falsely flipping to the mock.
  const healthTimeout = config?.healthTimeout ?? 8_000;
  const useMock = config?.useMockFallback ?? true;

  let _isLive = false;
  let _healthCache: HealthCache | null = null;

  // ── Health check ────────────────────────────────────────────────────────────

  async function healthCheck(): Promise<boolean> {
    const now = Date.now();

    // Return cached result if still fresh. A "dead" verdict expires fast (5s) so
    // the assistant recovers quickly after a transient hiccup; "alive" lasts 60s.
    if (_healthCache !== null) {
      const ttl = _healthCache.alive ? HEALTH_CACHE_ALIVE_TTL_MS : HEALTH_CACHE_DEAD_TTL_MS;
      if (now - _healthCache.timestamp < ttl) {
        return _healthCache.alive;
      }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), healthTimeout);

    try {
      const res = await fetch(`${baseUrl}/api/health`, {
        method: 'GET',
        signal: controller.signal,
        // No credentials — public health endpoint
        headers: { Accept: 'application/json' },
      });

      const alive = res.ok;
      // Stamped NOW, not with the `now` captured before the request. On a
      // timeout the request takes the full healthTimeout (8 s) and the dead
      // verdict is only cached for 5 — so back-dating the entry made it born
      // expired, and the negative cache, whose entire job is to stop a slow
      // backend from stalling every message, never once took effect. Every
      // message paid a fresh 8-second wait to rediscover the same silence.
      _healthCache = { alive, timestamp: Date.now() };
      return alive;
    } catch {
      // Network error or timeout → backend unreachable
      _healthCache = { alive: false, timestamp: Date.now() };
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  // ── Mock fallback ───────────────────────────────────────────────────────────

  async function callMock(message: string): Promise<ChatResponse> {
    const { response, delay } = mockSynapseResponse(message);
    // Honour the simulated thinking delay
    await new Promise<void>((resolve) => setTimeout(resolve, delay));
    return {
      content: sanitizeResponse(response),
      source: 'mock',
      // Honest: no real model ran. The badge shows "mock", never a fake tier.
      model: 'mock',
    };
  }

  // ── Live backend ────────────────────────────────────────────────────────────

  async function callLive(request: ChatRequest, signal: AbortSignal): Promise<ChatResponse> {
    const body = JSON.stringify({
      message: request.message,
      history: request.history ?? [],
    });

    const res = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      signal,
      headers: withAuth({
        'Content-Type': 'application/json',
        Accept: 'application/json',
      }),
      body,
    });

    if (!res.ok) {
      throw httpError(res);
    }

    // FastAPI returns: { response: string, language: string }
    let data: unknown;
    try {
      data = await res.json();
    } catch {
      throw new Error('Invalid JSON response from backend');
    }

    if (
      typeof data !== 'object' ||
      data === null ||
      !('response' in data) ||
      typeof (data as Record<string, unknown>).response !== 'string'
    ) {
      throw new Error('Unexpected response shape from backend');
    }

    const rawContent = (data as { response: string }).response;
    const rawModel = (data as Record<string, unknown>).model;
    const model = typeof rawModel === 'string' ? rawModel : undefined;

    return {
      content: sanitizeResponse(rawContent),
      source: 'live',
      model,
    };
  }

  // ── chat() ──────────────────────────────────────────────────────────────────

  async function chat(request: ChatRequest): Promise<ChatResponse> {
    // 30s was too short and produced the worst possible failure: the abort was
    // caught, the mock fallback answered, and the caller saw "feature
    // unavailable" — indistinguishable from unimplemented, when the truth was
    // "the model was still thinking". Measured against the live CPU-only ARM
    // backend, an ordinary non-streaming answer takes 33-38s; the LLM-judge
    // prompt in RerankPanel is longer still. 120s matches the voice path and
    // the backend's own LLM_SERVER_REQUEST_TIMEOUT, so the client no longer
    // gives up before the server has.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120_000);

    try {
      // 1. Check backend availability (cached)
      const isAlive = await healthCheck();

      if (!isAlive) {
        if (!useMock) {
          throw new Error('Synapse backend is unreachable and mock fallback is disabled.');
        }
        console.warn('[SynapseClient] Backend unreachable — using mock fallback');
        _isLive = false;
        return await callMock(request.message);
      }

      // 2. Try live backend
      const response = await callLive(request, controller.signal);
      _isLive = true;
      return response;
    } catch (err: unknown) {
      const isAbortError = err instanceof DOMException && err.name === 'AbortError';

      if (isAbortError) {
        console.warn('[SynapseClient] Request timed out — using mock fallback');
      } else if (err instanceof SyntaxError) {
        console.error('[SynapseClient] Invalid JSON from backend — using mock fallback', err);
      } else {
        console.warn('[SynapseClient] Network error — using mock fallback', err);
      }

      // Invalidate health cache on error so next request re-probes
      _healthCache = null;
      _isLive = false;

      if (!useMock) throw err;
      return await callMock(request.message);
    } finally {
      clearTimeout(timer);
    }
  }

  // ── Public interface ────────────────────────────────────────────────────────

  async function callMockVoice(): Promise<{
    audioBlob: Blob;
    transcriptText: string;
    responseText: string;
    source: 'live' | 'mock';
  }> {
    // Generate a tiny valid empty WAV file as fallback
    const emptyWav = new Uint8Array([
      82, 73, 70, 70, 36, 0, 0, 0, 87, 65, 86, 69, 102, 109, 116, 32, 16, 0, 0, 0, 1, 0, 1, 0, 68,
      172, 0, 0, 136, 88, 1, 0, 2, 0, 16, 0, 100, 97, 116, 97, 0, 0, 0, 0,
    ]);
    const mockAudio = new Blob([emptyWav], { type: 'audio/wav' });

    await new Promise((resolve) => setTimeout(resolve, 1500));

    return {
      audioBlob: mockAudio,
      transcriptText: 'Mock voice input detected.',
      responseText: 'This is a mock voice response. Backend is offline.',
      source: 'mock',
    };
  }

  async function sendVoice(audioBlob: Blob): Promise<{
    audioBlob: Blob;
    transcriptText: string;
    responseText: string;
    source: 'live' | 'mock';
  }> {
    const isAlive = await healthCheck();

    if (!isAlive) {
      if (!useMock) {
        throw new Error('Synapse backend is unreachable and mock fallback is disabled.');
      }
      console.warn('[SynapseClient] Backend unreachable — using mock fallback for voice');
      _isLive = false;
      return callMockVoice();
    }

    const form = new FormData();
    form.append('audio', audioBlob, 'recording.webm');

    const controller = new AbortController();
    // 2-minute timeout for voice (allows time for STT model download on first run)
    const timer = setTimeout(() => controller.abort(), 120_000);

    try {
      const res = await fetch(`${baseUrl}/api/voice`, {
        method: 'POST',
        signal: controller.signal,
        headers: withAuth(),
        body: form,
      });

      if (!res.ok) {
        throw httpError(res);
      }

      const rawTranscript = res.headers.get('X-Synapse-Transcript');
      const rawResponse = res.headers.get('X-Synapse-Response');
      const transcriptText = rawTranscript ? decodeURIComponent(rawTranscript) : '🎤 Voice message';
      const responseText = sanitizeResponse(rawResponse ? decodeURIComponent(rawResponse) : '...');
      const blob = await res.blob();

      _isLive = true;
      return {
        audioBlob: blob,
        transcriptText,
        responseText,
        source: 'live',
      };
    } catch (err: unknown) {
      _healthCache = null;
      _isLive = false;

      if (!useMock) throw err;
      console.warn('[SynapseClient] Voice request failed, falling back to mock:', err);
      return callMockVoice();
    } finally {
      clearTimeout(timer);
    }
  }

  async function synthesizeText(text: string): Promise<Blob> {
    const isAlive = await healthCheck();
    if (!isAlive) {
      throw new Error('Synapse backend is unreachable. Cannot synthesize text.');
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);

    try {
      const res = await fetch(`${baseUrl}/api/tts`, {
        method: 'POST',
        signal: controller.signal,
        headers: withAuth({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ text }),
      });

      if (!res.ok) {
        throw httpError(res);
      }

      return await res.blob();
    } finally {
      clearTimeout(timer);
    }
  }

  // ── chatStream() ────────────────────────────────────────────────────────────

  async function chatStream(
    request: ChatRequest,
    callbacks: ChatStreamCallbacks,
    externalSignal?: AbortSignal
  ): Promise<void> {
    // Early exit if already aborted
    if (externalSignal?.aborted) return;

    const isAlive = await healthCheck();
    if (!isAlive) {
      // Fall back to non-streaming mock
      const mock = await callMock(request.message);
      // Simulate streaming by emitting full text at once
      callbacks.onModel?.(mock.model ?? 'mock');
      callbacks.onToken?.(mock.content);
      callbacks.onDone?.(mock.content);
      _isLive = false;
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120_000);

    // Combine internal timeout abort with external caller abort
    const combinedSignal = externalSignal
      ? AbortSignal.any([controller.signal, externalSignal])
      : controller.signal;

    // Hoisted out of the try so the catch below can tell "the backend never
    // said anything" from "the backend was mid-sentence when it stopped".
    let fullText = '';

    try {
      const res = await fetch(`${baseUrl}/api/chat/stream`, {
        method: 'POST',
        signal: combinedSignal,
        headers: withAuth({
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        }),
        body: JSON.stringify({
          message: request.message,
          history: request.history ?? [],
        }),
      });

      if (!res.ok) throw httpError(res);

      _isLive = true;

      await parseSSEStream(res, {
        onEvent(event, data) {
          switch (event) {
            case 'model':
              // Emitted before the first token — the router's pick ('e2b'|'e4b').
              callbacks.onModel?.(data.trim());
              break;
            case 'token': {
              const token = JSON.parse(data) as string;
              fullText += token;
              callbacks.onToken?.(token);
              break;
            }
            case 'done':
              callbacks.onDone?.(fullText);
              break;
            case 'error':
              callbacks.onError?.(data);
              break;
          }
        },
      });
    } catch (err: unknown) {
      _healthCache = null;
      _isLive = false;

      if (useMock) {
        // Report WHY before the mock answers, so the UI can stop calling a
        // live-but-busy backend "unavailable". Not on abort: the user cancelling
        // is not a backend failure and must not be labelled as one.
        const aborted = err instanceof DOMException && err.name === 'AbortError';
        const info = describeFailure(err);
        if (!aborted) callbacks.onFallback?.(info);

        // Only when the reply has not started. onToken APPENDS, so running
        // the scripted mock after real tokens had arrived welded the two
        // together inside one message: half a real answer, then a canned one,
        // no seam, nothing to tell the reader where the model stopped and the
        // script began. A stream that dies mid-sentence is an error — report
        // it as one and keep what did arrive. The terminal's onError handler
        // preserves partial content and only substitutes its own text when
        // there is none.
        if (fullText !== '') {
          callbacks.onError?.(err instanceof Error ? err.message : 'Stream failed');
        } else {
          // A refusal on policy grounds gets an answer that explains itself.
          // The scripted mock is the right response to a backend that is down;
          // it is the wrong response to "sign in" or "you're out of messages",
          // where the visitor would be left guessing why it went shallow.
          const policy = aborted ? null : policyMessage(info, request.message);
          const content = policy ?? (await callMock(request.message)).content;
          callbacks.onModel?.('mock');
          callbacks.onToken?.(content);
          callbacks.onDone?.(content);
        }
      } else {
        callbacks.onError?.(err instanceof Error ? err.message : 'Stream failed');
      }
    } finally {
      clearTimeout(timer);
    }
  }

  // ── sendVoiceStream() ───────────────────────────────────────────────────────

  async function sendVoiceStream(
    audioBlob: Blob,
    callbacks: VoiceStreamCallbacks,
    externalSignal?: AbortSignal
  ): Promise<void> {
    // Early exit if already aborted
    if (externalSignal?.aborted) return;

    const isAlive = await healthCheck();
    if (!isAlive) {
      _isLive = false;
      callbacks.onError?.('Backend unreachable');
      return;
    }

    const form = new FormData();
    form.append('audio', audioBlob, 'recording.webm');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120_000);

    // Combine internal timeout abort with external caller abort
    const combinedSignal = externalSignal
      ? AbortSignal.any([controller.signal, externalSignal])
      : controller.signal;

    try {
      const res = await fetch(`${baseUrl}/api/voice/stream`, {
        method: 'POST',
        signal: combinedSignal,
        headers: withAuth(),
        body: form,
      });

      if (!res.ok) throw httpError(res);

      _isLive = true;

      await parseSSEStream(res, {
        onEvent(event, data) {
          switch (event) {
            case 'transcript': {
              const parsed = JSON.parse(data);
              callbacks.onTranscript?.(parsed);
              break;
            }
            case 'token': {
              const token = JSON.parse(data) as string;
              callbacks.onToken?.(token);
              break;
            }
            case 'audio': {
              // Decode base64 → WAV Blob
              const binary = atob(data);
              const bytes = new Uint8Array(binary.length);
              for (let i = 0; i < binary.length; i++) {
                bytes[i] = binary.charCodeAt(i);
              }
              callbacks.onAudio?.(new Blob([bytes], { type: 'audio/wav' }));
              break;
            }
            case 'done':
              callbacks.onDone?.();
              break;
            case 'error':
              callbacks.onError?.(data);
              break;
          }
        },
      });
    } catch (err: unknown) {
      _healthCache = null;
      _isLive = false;
      callbacks.onError?.(err instanceof Error ? err.message : 'Voice stream failed');
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    chat,
    chatStream,
    sendVoice,
    sendVoiceStream,
    synthesizeText,
    healthCheck,
    get isLive() {
      return _isLive;
    },
  };
}
