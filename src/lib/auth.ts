/**
 * auth.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Google Identity Services (GIS) sign-in for Synapse conversation ownership.
 *
 * IDENTITY MODEL — "your IP is not you":
 *   • Anonymous visitors get NO server-side history. Their chats live only in
 *     this browser's IndexedDB (see synapse-db.ts). The server is never touched.
 *   • Signing in with Google mints an ID token (JWT). We send it as
 *     `Authorization: Bearer <jwt>`; the BACKEND verifies it (signature, issuer,
 *     expiry, and — critically — `audience`) and derives an opaque owner key
 *     "sub:<google-sub>". Ownership is the verified account, never the shared IP.
 *
 * WHERE THE TOKEN LIVES (sessionStorage, NOT memory and NOT localStorage):
 *   A JWT in localStorage is exfiltratable by any XSS and outlives the visit,
 *   so it is out. Memory-only was the original choice and it did not work on a
 *   static Astro site: every internal link is a full document load, so signing
 *   in and clicking through to the Lab made you a guest again. sessionStorage
 *   survives navigation within the tab and dies with the tab. The full
 *   reasoning, and how to revert, is on the block above `_STORAGE_KEY`.
 *   We intentionally do NOT use One Tap / `auto_select` to silently restore —
 *   it made GIS flash an unsolicited prompt in the corner on every page.
 *
 * The client-side JWT decode here is for DISPLAY ONLY (name/email/avatar). It is
 * never trusted for authorization — the backend does the real verification.
 */

export interface SynapseProfile {
  sub: string;
  name: string;
  email: string;
  picture: string;
}

// ─── Config ─────────────────────────────────────────────────────────────────
// Public (not a secret): a Google OAuth *Web* client id. Baked in at build time.
// Empty → auth is disabled and every sign-in entry point is a graceful no-op, so
// the site works offline / before the owner provisions a client id.
export const GOOGLE_OAUTH_CLIENT_ID: string = (
  (import.meta.env.PUBLIC_GOOGLE_OAUTH_CLIENT_ID as string | undefined) ?? ''
).trim();

export function authConfigured(): boolean {
  return GOOGLE_OAUTH_CLIENT_ID.length > 0;
}

// ─── Session (sessionStorage — see the trade-off below) ───────────────────────
//
// This used to be memory-only, on the reasoning that a JWT in storage is
// exfiltratable by any XSS. That reasoning is sound but the conclusion no
// longer fits this site: it is STATIC Astro with no client-side router, so
// every internal link is a full document load. Memory-only therefore signed
// the user out on literally any navigation — sign in, click the Lab, you are a
// guest again. The feature did not work.
//
// sessionStorage is the deliberate middle ground: it survives navigation
// within the tab and dies with the tab (unlike localStorage, which would
// persist across sessions and on a shared machine). The exposure it adds is
// bounded — a Google ID token expires in ~1h, and the XSS boundary here was
// independently red-teamed without a bypass being found.
//
// To revert to memory-only: delete _persist/_restore and their call sites.
const _STORAGE_KEY = 'synapse.idToken';

let _idToken: string | null = null;
let _profile: SynapseProfile | null = null;

/** Seconds since epoch at which this JWT expires, or null if unreadable. */
function tokenExpiry(jwt: string): number | null {
  try {
    const payload = jwt.split('.')[1];
    if (!payload) return null;
    const claims = JSON.parse(b64urlToUtf8(payload)) as Record<string, unknown>;
    return typeof claims.exp === 'number' ? claims.exp : null;
  } catch {
    return null;
  }
}

function _persist(token: string | null): void {
  if (typeof sessionStorage === 'undefined') return;
  try {
    if (token) sessionStorage.setItem(_STORAGE_KEY, token);
    else sessionStorage.removeItem(_STORAGE_KEY);
  } catch {
    /* private mode / quota — the in-memory copy still works for this page */
  }
}

/** Rehydrate at module load so a navigation doesn't look like a sign-out. */
function _restore(): void {
  if (typeof sessionStorage === 'undefined') return;
  let stored: string | null = null;
  try {
    stored = sessionStorage.getItem(_STORAGE_KEY);
  } catch {
    return;
  }
  if (!stored) return;

  // Never restore an expired token: it would leave the UI claiming "signed in"
  // while every backend call 401s — worse than an honest signed-out state.
  // 30s of slack absorbs clock drift between browser and Google.
  const exp = tokenExpiry(stored);
  if (exp === null || exp * 1000 <= Date.now() + 30_000) {
    _persist(null);
    return;
  }

  const profile = decodeProfile(stored);
  if (!profile) {
    _persist(null);
    return;
  }
  _idToken = stored;
  _profile = profile;
}

/**
 * Drop the session if the token has expired since we took it.
 *
 * Expiry was checked once, in `_restore()`, at module load. A Google ID token
 * lives about an hour — comfortably shorter than a session spent reading a
 * build log — so it expired *during* use and nothing noticed. The UI went on
 * showing the account, the avatar and "signed in as", while every request
 * carrying that token came back 401 and every sync silently did nothing. The
 * honest state is signed out, and it is better reached a minute early than an
 * hour late: the same 30 s of slack `_restore` uses, for the same reason.
 *
 * Returns true when the session is still good.
 */
function _dropIfExpired(): boolean {
  if (_idToken === null) return false;
  const exp = tokenExpiry(_idToken);
  if (exp !== null && exp * 1000 > Date.now() + 30_000) return true;
  _idToken = null;
  _profile = null;
  _persist(null);
  emitAuthChange(); // so the islands repaint as signed out instead of pretending
  return false;
}

export function getIdToken(): string | null {
  return _dropIfExpired() ? _idToken : null;
}
export function getProfile(): SynapseProfile | null {
  return _dropIfExpired() ? _profile : null;
}
export function isSignedIn(): boolean {
  return _dropIfExpired();
}

// ─── Change notification (so Svelte islands can react) ────────────────────────
const AUTH_EVENT = 'synapse-auth-change';

function emitAuthChange(): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(AUTH_EVENT));
  }
}

/** Subscribe to sign-in / sign-out. Returns an unsubscribe fn. */
export function onAuthChange(cb: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener(AUTH_EVENT, cb);
  return () => window.removeEventListener(AUTH_EVENT, cb);
}

// ─── JWT payload decode (display only, never trusted) ─────────────────────────
function b64urlToUtf8(segment: string): string {
  const b64 = segment.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function decodeProfile(jwt: string): SynapseProfile | null {
  try {
    const payload = jwt.split('.')[1];
    if (!payload) return null;
    const claims = JSON.parse(b64urlToUtf8(payload)) as Record<string, unknown>;
    const sub = typeof claims.sub === 'string' ? claims.sub : '';
    if (!sub) return null;
    return {
      sub,
      name: typeof claims.name === 'string' ? claims.name : '',
      email: typeof claims.email === 'string' ? claims.email : '',
      picture: typeof claims.picture === 'string' ? claims.picture : '',
    };
  } catch {
    return null;
  }
}

// ─── GIS script loading (lazy, once) ──────────────────────────────────────────
type GisId = {
  initialize: (cfg: Record<string, unknown>) => void;
  renderButton: (el: HTMLElement, cfg: Record<string, unknown>) => void;
  prompt: () => void;
  disableAutoSelect: () => void;
};
function gis(): GisId | null {
  const g = (globalThis as { google?: { accounts?: { id?: GisId } } }).google;
  return g?.accounts?.id ?? null;
}

let _gisLoading: Promise<void> | null = null;
function loadGis(): Promise<void> {
  if (_gisLoading) return _gisLoading;
  _gisLoading = new Promise<void>((resolve, reject) => {
    if (typeof document === 'undefined') return reject(new Error('no dom'));
    if (gis()) return resolve();
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.defer = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('GIS script failed to load'));
    document.head.appendChild(s);
  });
  return _gisLoading;
}

function handleCredential(resp: { credential?: string }): void {
  const token = resp?.credential;
  if (!token) return;
  const profile = decodeProfile(token);
  if (!profile) return;
  _idToken = token;
  _profile = profile;
  _persist(token);
  emitAuthChange();
}

// Runs once, at module evaluation — i.e. on every page load, which is exactly
// when a static site would otherwise have dropped the session.
_restore();

let _initialized = false;

/**
 * Load GIS and initialize the client. Idempotent. Resolves `false` (no-op) when
 * auth is unconfigured or GIS can't load — callers must handle that gracefully.
 */
export async function initAuth(): Promise<boolean> {
  if (!authConfigured()) return false;
  try {
    await loadGis();
  } catch {
    return false;
  }
  const id = gis();
  if (!id) return false;
  if (!_initialized) {
    // Button-only sign-in — deliberately NO auto_select / One Tap / FedCM
    // auto-prompt. Those made GIS periodically flash a One Tap card in the
    // corner while trying to silently re-auth a signed-in user (and, on a page
    // reload, re-prompt). We only want the explicit "Sign in with Google"
    // button rendered in the sidebar. Sign-in lasts for the tab: the token is
    // held in sessionStorage (see `_STORAGE_KEY`), so it survives navigation
    // and dies when the tab closes — an acceptable trade for not showing a
    // recurring, unsolicited popup on every page.
    id.initialize({
      client_id: GOOGLE_OAUTH_CLIENT_ID,
      callback: handleCredential,
    });
    _initialized = true;
  }
  return true;
}

/**
 * Render Google's official sign-in button into `el`. No-op when unconfigured.
 * `locale` localizes the button copy (pass the site's UI language).
 */
export async function renderSignInButton(el: HTMLElement, locale: string): Promise<void> {
  if (!(await initAuth())) return;
  const id = gis();
  if (!id) return;
  el.replaceChildren();
  id.renderButton(el, {
    type: 'standard',
    theme: 'filled_black',
    size: 'medium',
    shape: 'pill',
    text: 'signin',
    locale,
  });
}

/** Sign out locally. GIS holds no server session for ID-token flows — clearing
 *  the in-memory token and disabling auto-select is a full sign-out for us. */
export function signOut(): void {
  try {
    gis()?.disableAutoSelect();
  } catch {
    /* ignore */
  }
  _idToken = null;
  _profile = null;
  _persist(null); // must clear storage too, or the next page load signs them back in
  emitAuthChange();
}
