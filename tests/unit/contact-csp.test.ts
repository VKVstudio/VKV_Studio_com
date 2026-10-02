import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

it('constructs and uses contact schemas without probing runtime code generation', async () => {
  vi.resetModules();
  const { z } = await import('zod');
  // A previous module's global configuration must not make this test pass.
  z.config({ jitless: false });
  let attempts = 0;
  const blocked = () => {
    attempts += 1;
    throw new Error('Runtime code generation blocked by strict CSP');
  };
  vi.stubGlobal('Function', new Proxy(globalThis.Function, {
    apply: blocked,
    construct: blocked,
  }));
  try {
    const context = await import('@/lib/contact-context');
    const form = await import('@/lib/contact-form');
    expect(context.readContactContext('?service=geo-audit')).toEqual({ service: 'geo-audit' });
    expect(context.readContactContext('?source=pro&briefing=unknown')).toEqual({});
    expect(context.readContactContext('?service=websites&service=geo-audit')).toEqual({});
    expect(context.buildContactHref('en', { service: 'geo-audit' })).toBe('/en/contact/?service=geo-audit');
    expect(form.isValid(form.validate({ company: '', task: '', budget: '', timeline: '' }))).toBe(false);
    expect(form.isValid(form.validate({ company: 'Example Ltd', task: 'Review our AI search visibility and agree a written scope.', budget: 'audit-900', timeline: 'exploring' }))).toBe(true);
    expect(attempts).toBe(0);
  } finally {
    z.config({ jitless: true });
  }
});
