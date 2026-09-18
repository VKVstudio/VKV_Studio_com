/**
 * auth.ts — a session must not outlive its token.
 *
 * Expiry was checked exactly once, in `_restore()`, at module load. A Google ID
 * token lives about an hour, which is shorter than a session spent reading the
 * build log, so it expired *during* use and nothing noticed: the UI kept
 * showing the account and the avatar while every request carrying that token
 * came back 401 and every sync silently did nothing. Signed-out is the honest
 * state, and the accessors are the only place that can notice.
 *
 * The session is seeded through a stub `sessionStorage`, which is what auth.ts
 * really reads at load — no test-only export was added to the module for this.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/** A syntactically valid unsigned JWT with the given `exp` (seconds since epoch). */
function jwtExpiringAt(expSeconds: number): string {
  const b64 = (o: unknown) =>
    Buffer.from(JSON.stringify(o), 'utf8')
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  const payload = {
    sub: '1234567890',
    name: 'Test Person',
    email: 'test@example.com',
    picture: 'https://example.com/a.png',
    exp: expSeconds,
  };
  return `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(payload)}.signature`;
}

const NOW = 1_800_000_000_000; // fixed wall clock, ms
const nowSec = () => NOW / 1000;

function stubSessionStorage(seed: string | null): void {
  const store = new Map<string, string>();
  if (seed !== null) store.set('synapse.idToken', seed);
  (globalThis as Record<string, unknown>).sessionStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
}

/** Fresh module per test — auth.ts keeps the session in module-level state. */
async function loadAuth(seed: string | null) {
  stubSessionStorage(seed);
  vi.resetModules();
  return import('@/lib/auth');
}

describe('auth session expiry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
    delete (globalThis as Record<string, unknown>).sessionStorage;
  });

  it('reports a live token as signed in', async () => {
    const auth = await loadAuth(jwtExpiringAt(nowSec() + 3600));
    expect(auth.isSignedIn()).toBe(true);
    expect(auth.getIdToken()).not.toBeNull();
    expect(auth.getProfile()?.email).toBe('test@example.com');
  });

  it('stops handing out a token once it expires mid-session', async () => {
    // The regression: valid at load, dead an hour later, and every accessor
    // went on insisting otherwise.
    const auth = await loadAuth(jwtExpiringAt(nowSec() + 3600));
    expect(auth.getIdToken()).not.toBeNull();

    vi.setSystemTime(NOW + 3_660_000); // an hour and a minute of reading later

    expect(auth.getIdToken()).toBeNull();
    expect(auth.isSignedIn()).toBe(false);
    expect(auth.getProfile()).toBeNull();
  });

  it('treats a token inside the 30s skew window as already gone', async () => {
    // Better a minute early than an hour late: a token that dies while the
    // request is in flight is a 401 the visitor cannot act on.
    const auth = await loadAuth(jwtExpiringAt(nowSec() + 60));
    expect(auth.getIdToken()).not.toBeNull();
    vi.setSystemTime(NOW + 40_000); // 20s of life left, inside the window
    expect(auth.getIdToken()).toBeNull();
  });

  it('clears the stored copy too, so a reload does not resurrect it', async () => {
    const auth = await loadAuth(jwtExpiringAt(nowSec() + 60));
    vi.setSystemTime(NOW + 40_000);
    auth.getIdToken();
    const ss = (globalThis as { sessionStorage: Storage }).sessionStorage;
    expect(ss.getItem('synapse.idToken')).toBeNull();
  });

  it('refuses a stored token that is already expired at load', async () => {
    const auth = await loadAuth(jwtExpiringAt(nowSec() - 1));
    expect(auth.isSignedIn()).toBe(false);
    expect(auth.getIdToken()).toBeNull();
  });

  it('refuses a stored token whose expiry cannot be read', async () => {
    const auth = await loadAuth('not.a.jwt');
    expect(auth.isSignedIn()).toBe(false);
    expect(auth.getIdToken()).toBeNull();
  });

  it('reports signed out when there was never a session', async () => {
    const auth = await loadAuth(null);
    expect(auth.isSignedIn()).toBe(false);
    expect(auth.getIdToken()).toBeNull();
    expect(auth.getProfile()).toBeNull();
  });

  it('terminates when the expiry check notifies listeners', async () => {
    // The clear-down fires a change event, and a listener asking isSignedIn()
    // re-enters the same check. It must not recurse.
    const auth = await loadAuth(jwtExpiringAt(nowSec() + 60));
    vi.setSystemTime(NOW + 40_000);
    expect(() => auth.isSignedIn()).not.toThrow();
    expect(auth.isSignedIn()).toBe(false);
  });
});
