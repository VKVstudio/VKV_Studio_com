import { afterEach, describe, expect, it, vi } from 'vitest';

async function client(markers: string[]): Promise<{
  auth: typeof import('@/lib/auth');
  scripts: HTMLScriptElement[];
  initialize: ReturnType<typeof vi.fn>;
}> {
  vi.resetModules();
  vi.stubEnv('PUBLIC_GOOGLE_OAUTH_CLIENT_ID', 'unit-test-public-client.apps.googleusercontent.com');
  vi.stubGlobal('google', undefined);
  vi.stubGlobal('sessionStorage', { getItem: (): null => null });
  const scripts: HTMLScriptElement[] = [];
  const initialize = vi.fn();
  vi.stubGlobal('document', {
    querySelectorAll: () => markers.map((content) => ({ content })),
    createElement: () => ({ nonce: '', src: '', async: false, defer: false }) as HTMLScriptElement,
    head: {
      appendChild: (script: HTMLScriptElement): HTMLScriptElement => {
        scripts.push(script);
        vi.stubGlobal('google', { accounts: { id: { initialize } } });
        queueMicrotask(() => script.onload?.(new Event('load')));
        return script;
      },
    },
  });
  return { auth: await import('@/lib/auth'), scripts, initialize };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('GIS client style nonce bridge', () => {
  it('sets the unique response permission before appending the single lazy public SDK', async () => {
    const nonce = btoa('a'.repeat(24));
    const { auth, scripts, initialize } = await client([nonce]);
    expect(await Promise.all([auth.initAuth(), auth.initAuth()])).toEqual([true, true]);
    expect(scripts).toHaveLength(1);
    expect(scripts[0]?.nonce).toBe(nonce);
    expect(scripts[0]?.src).toBe('https://accounts.google.com/gsi/client');
    expect(scripts[0]?.async).toBe(true);
    expect(initialize).toHaveBeenCalledOnce();
    expect(auth.isSignedIn()).toBe(false);
  });

  it.each([
    { markers: [] },
    { markers: ['bad"nonce'] },
    { markers: ['a'.repeat(31)] },
    { markers: ['a'.repeat(33)] },
    { markers: ['a'.repeat(32), 'b'.repeat(32)] },
    { markers: [' a'.repeat(16)] },
  ])(
    'refuses a missing, malformed or ambiguous marker before any SDK request',
    async ({ markers }) => {
      const { auth, scripts, initialize } = await client(markers);
      expect(await auth.initAuth()).toBe(false);
      expect(scripts).toEqual([]);
      expect(initialize).not.toHaveBeenCalled();
      expect(auth.isSignedIn()).toBe(false);
    }
  );
});
